// ─────────────────────────────────────────────────────────────
// Pure text transforms for model-emitted tool_use literals and Counter tool
// results.
//
// Extracted from copilot-to-openai so these decisions are testable without
// booting the HTTP server, the Copilot SDK, or the /tmp loop directory — that
// module runs `tryMkdir` + `setClientCwd` at import time.
//
// Everything here is pure: no fs, no network, no module-level mutable state.
// The one side effect a caller may want — logging when the truncated-JSON
// repair path fires — is injected as an optional callback.
// ─────────────────────────────────────────────────────────────

import { findBalancedObjectEnd, repairTruncatedJson } from "./json-scan";

// ─── Counter registry slimming ───────────────────────────────────────────────
//
// Counter *assemble (and other method results) return multiple concatenated JSON
// objects. One of them is a flat registry of ALL heroes' methods, e.g.:
//   {
//     "help": "Display all available...",            // string description
//     "get-codesymbol": { description, parameters }, // nested object (parameterized methods)
//     "change": "_Counter__ExecuteMethod({method: '*change' })",  // call stub
//     ...
//   }
// This registry makes the Copilot model list every system method instead of only
// the current hero's. Stripping it forces the model to rely on the
// _Counter__Deploy conversation history for the active hero's method list.

// Keys that mark a chunk as NOT the flat all-methods registry: every other
// Counter chunk carries at least one of them.
const NON_REGISTRY_CHUNK_KEYS = new Set([
  "instructions", "methodContent", "methodParams", "tactical_notes",
  "methodology", "callSign", "agent_compatibility", "message", "currentTimeAtUTC",
]);

/**
 * True when `obj` is the flat Counter all-methods registry chunk.
 *
 * Three conditions, all required:
 *   1. Plain object with at least 10 keys (the registry is large).
 *   2. Negative signature: none of the known non-registry chunk keys present.
 *   3. Positive signature: some value contains a Counter call stub
 *      ("_Counter__ExecuteMethod(" / "_Counter__Deploy"), unique to the registry.
 */
export const isCounterMethodRegistry = (obj: any): boolean => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length < 10) return false;
  if (keys.some((k) => NON_REGISTRY_CHUNK_KEYS.has(k))) return false;
  return Object.values(obj).some((v) => {
    if (typeof v === "string") return v.includes("_Counter__ExecuteMethod(") || v.includes("_Counter__Deploy");
    if (v && typeof v === "object") return JSON.stringify(v).includes("_Counter__");
    return false;
  });
};

/**
 * Drop the flat all-methods registry chunk from a Counter ExecuteMethod result
 * so the model sees only the deployed hero's methods.
 *
 * The raw result is prose interleaved with several top-level JSON objects, so
 * this segments on balanced braces and re-joins everything it did not drop.
 * Unparseable chunks are passed through untouched — never guessed at.
 */
export const slimCounterResult = (raw: string): string => {
  const out: string[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const start = raw.indexOf("{", pos);
    if (start === -1) { out.push(raw.slice(pos)); break; }
    if (start > pos) out.push(raw.slice(pos, start));
    const end = findBalancedObjectEnd(raw, start);
    if (end === -1) { out.push(raw.slice(start)); break; }
    const chunk = raw.slice(start, end + 1);
    try {
      if (!isCounterMethodRegistry(JSON.parse(chunk))) out.push(chunk);
      // else: silently drop the flat registry chunk
    } catch { out.push(chunk); }
    pos = end + 1;
  }
  return out.join("");
};

// ─── tool_use literal tidying ────────────────────────────────────────────────

/** Outcome of the truncated-JSON repair path, for caller-side instrumentation. */
export type TidyOutcome = "absent" | "clean" | "repaired" | "unrepairable";

export interface TidyResult {
  text: string;
  outcome: TidyOutcome;
}

/**
 * Tidy a `{"tool_use": ...}` literal the model emitted with a truncated tail.
 *
 * Strict no-op unless ALL of:
 *   1. text contains "tool_use"
 *   2. the candidate substring fails JSON.parse as-is
 *   3. brace-balancing produces a string that DOES parse
 * Otherwise `text` comes back verbatim.
 *
 * `outcome` reports which branch ran so callers can count how often the repair
 * path is actually load-bearing:
 *   absent       — no "tool_use" marker, or no `{` at all
 *   clean        — parsed as-is, no repair needed
 *   repaired     — was truncated, brace-balancing produced valid JSON
 *   unrepairable — malformed in a way truncation-repair cannot fix
 */
export const tidyToolUseJsonDetailed = (text: string): TidyResult => {
  if (!text || !text.includes('"tool_use"')) return { text, outcome: "absent" };
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  if (start === -1) return { text, outcome: "absent" };
  const body = candidate.slice(start);
  try { JSON.parse(body); return { text: body, outcome: "clean" }; } catch {}

  const repaired = repairTruncatedJson(body);
  if (repaired !== null) return { text: repaired, outcome: "repaired" };
  return { text, outcome: "unrepairable" };
};

// ─── XML-style tool call markup ──────────────────────────────────────────────
//
// Frontier models fronted by the Copilot SDK (Claude, GPT) fall back to their
// native chat-template markup instead of the `{"tool_use": …}` literal the
// system prefix asks for:
//
//   <function_calls>
//   <invoke name="bash">
//   <parameter name="command">ls -la</parameter>
//   </invoke>
//   </function_calls>
//
// Unconverted, that text reaches the client as prose — the visible symptom is
// a turn that prints markup and executes nothing. Rewriting it into the
// canonical literal lets the existing tidy → canonicalize → extract pipeline
// handle it unchanged.

/** Opening tag of a native tool-call block, with or without the `antml:` prefix. */
const TOOL_MARKUP_START = /<(?:antml:)?(?:function_calls|invoke)\b/;

const PARAM_BLOCK = /<(?:antml:)?parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)(?=<\/(?:antml:)?parameter>|<(?:antml:)?parameter\s|<\/(?:antml:)?invoke>|<\/(?:antml:)?function_calls>|$)/gi;

/** A COMPLETE invoke block: the closing tag is mandatory, so a truncated call never runs. */
const COMPLETE_INVOKE = /<(?:antml:)?invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/(?:antml:)?invoke\s*>/gi;
const TOOL_MARKUP_START_G = new RegExp(TOOL_MARKUP_START.source, "g");

/**
 * Spans inside ``` fences or inline backticks. Markup there is a quoted example,
 * never a call — so a fence that never closes is what tells the two callers apart:
 *
 *   tailIsQuoted (default, findToolMarkupStart): an unclosed fence runs to the end
 *   of the buffer. Future bytes may still close it, so committing to tool mode
 *   inside one is unsafe, and the stream stays in text mode.
 *
 *   tailIsQuoted=false (findExecutableInvoke): the buffer is complete, so an
 *   unclosed fence holds nothing that could later be a fenced example — its body
 *   plus everything after reads as ordinary text and any real invocation there is
 *   callable. Without this, a leaked "```" swallowed every following call and the
 *   turn printed raw markup instead of executing anything.
 */
const quotedRanges = (text: string, tailIsQuoted = true): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  // Nothing to look for in the common case (most turns carry no backticks at
  // all); skipping the scan keeps the per-delta streaming check cheap.
  if (!text.includes("`")) return ranges;
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!tailIsQuoted && m[0].startsWith("```") && !m[0].endsWith("```")) {
      // Unterminated fence: quote only its opening line, so the regex resumes
      // after it and the remainder of the buffer counts as unquoted text.
      const lineEnd = text.indexOf("\n", m.index);
      if (lineEnd !== -1) ranges.push([m.index, lineEnd + 1]);
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
};

const isQuoted = (pos: number, ranges: Array<[number, number]>): boolean =>
  ranges.some(([a, b]) => pos >= a && pos < b);

/**
 * Index of the first tool-markup opening tag that is NOT inside a quoted span, or -1.
 * Streaming uses this instead of a bare search so an XML example in a code block
 * does not switch the turn into tool mode.
 */
export const findToolMarkupStart = (text: string): number => {
  if (!text || !TOOL_MARKUP_START.test(text)) return -1;
  const quoted = quotedRanges(text);
  TOOL_MARKUP_START_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_MARKUP_START_G.exec(text)) !== null) {
    if (!isQuoted(m.index, quoted)) return m.index;
  }
  return -1;
};

/**
 * First complete, unquoted invoke block as [whole, name, body], or null.
 *
 * This is the FINAL-conversion lookup (the buffer is complete), so an unclosed
 * fence is treated as ordinary text rather than swallowing the rest of the turn.
 */
const findExecutableInvoke = (text: string): RegExpExecArray | null => {
  const quoted = quotedRanges(text, false);
  COMPLETE_INVOKE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMPLETE_INVOKE.exec(text)) !== null) {
    if (!isQuoted(m.index, quoted)) return m;
  }
  return null;
};

const decodeEntities = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * Coerce a parameter's text body to a JSON value.
 *
 * Only unambiguous JSON shapes are parsed — anything else stays a string, so a
 * shell command like `test -f x && echo 1` is never mangled into a number or
 * rejected outright.
 */
const coerceParamValue = (raw: string, declaredType?: string): any => {
  const trimmed = raw.trim();
  // A field the schema declares as a string keeps its body verbatim: a Write
  // `content` of "123" or an Edit `old_string` of "true" must not change type.
  if (declaredType === "string") return raw;
  if (/^(?:true|false|null)$/.test(trimmed) || /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return JSON.parse(trimmed);
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { return raw; }
  }
  return raw;
};

/**
 * A tool as the schema map records it: its canonical name, declared property
 * types, and whether undeclared keys are allowed (`additionalProperties`).
 */
type XmlToolSchemaEntry = {
  canonical: string;
  types: Record<string, string | undefined>;
  open?: boolean;
};

/**
 * Optional tool schemas: every name a tool answers to → the tool it denotes and
 * its declared property types. When supplied, the invoke name must resolve to a
 * known tool (exact, then case-insensitive), every parameter must be a declared
 * property, and string-typed properties keep their body verbatim. Without it the
 * legacy lenient behaviour holds.
 *
 * The alias keys are derived once, by buildXmlToolSchemas, and each carries the
 * name it denotes — so precedence is decided there and only there. Re-deriving
 * the aliases here would re-decide it differently: `mcp__x___Bash` contributes a
 * `Bash` alias, and picked in the wrong order it takes the `Bash` key away from
 * a real `Bash` tool.
 */
export type XmlToolSchemas = Map<string, XmlToolSchemaEntry>;

const resolveSchemaName = (raw: string, schemas: XmlToolSchemas): string | undefined => {
  const stripped = raw.replace(/^_+/, "");
  const direct = schemas.get(raw) ?? schemas.get(stripped);
  if (direct) return direct.canonical;

  // Case-insensitive fallback — still unique-match only, so an ambiguous
  // case-collision never picks a tool at random.
  const lower = stripped.toLowerCase();
  const hits = new Set<string>();
  for (const [alias, entry] of schemas) {
    if (alias.toLowerCase() === lower) hits.add(entry.canonical);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
};

/**
 * Rewrite the FIRST XML-style invoke block in `text` as a `{"tool_use": …}`
 * literal. Text without such a block is returned verbatim.
 *
 * Only the first block is converted because the downstream OpenAI response
 * carries a single tool_call per turn; prose surrounding the block is dropped
 * along with it, matching how a tool_use literal replaces the turn's content.
 */
export const xmlToolUseToJson = (text: string, schemas?: XmlToolSchemas): string => {
  if (!text || !TOOL_MARKUP_START.test(text)) return text;
  const block = findExecutableInvoke(text);
  if (!block) return text;

  let name = block[1].trim();
  if (!name) return text;

  let types: Record<string, string | undefined> | undefined;
  let open = false;
  if (schemas?.size) {
    const resolved = resolveSchemaName(name, schemas);
    if (!resolved) return text; // unknown tool — never fabricate a call
    name = resolved;
    const entry = schemas.get(resolved);
    types = entry?.types;
    open = entry?.open === true;
  }
  const declared = types && Object.keys(types).length ? types : undefined;
  // An open schema still types its declared keys but accepts undeclared ones.
  const rejectUndeclared = declared !== undefined && !open;

  const input: Record<string, any> = {};
  PARAM_BLOCK.lastIndex = 0;
  let param: RegExpExecArray | null;
  while ((param = PARAM_BLOCK.exec(block[2])) !== null) {
    const key = param[1].trim();
    if (rejectUndeclared && !Object.prototype.hasOwnProperty.call(declared, key)) return text; // undeclared parameter
    input[key] = coerceParamValue(decodeEntities(param[2]), declared?.[key]);
  }

  return JSON.stringify({ tool_use: { name, input } });
};

// ─── tool_use literal extraction ─────────────────────────────────────────────

/** Accepts or rejects a parsed call, so the caller owns the validation policy. */
type ToolCallValidator = (name: string, input: Record<string, any>) => boolean;

// Built from char codes so the source never carries a literal fence marker.
const FENCE_MARK = String.fromCharCode(96).repeat(3);
const FENCE_BLOCK = new RegExp(FENCE_MARK + "(?:json)?\\s*([\\s\\S]+?)" + FENCE_MARK);

type ToolUseLiteral = { start: number; end: number; name: string; input: Record<string, any> };

const isPlainObject = (v: any): boolean => !!v && typeof v === "object" && !Array.isArray(v);

// Where a literal's arguments live: under `input`, or beside `name` in the
// flattened form — {"tool_use":{"name":"Bash","command":"ls"}}. Also accepts
// `arguments`/`parameters`. Only those four envelope keys are stripped: any other
// sibling is treated as an argument, since a tool may legitimately declare a
// parameter that shares a name with a transport key.
//
// Neither shape may run with {}: a populated sibling must beat an EMPTY envelope
// ({"name":"Bash","input":{},"command":"ls"} still runs `ls`, not Bash()), and a
// non-object candidate is returned UNTOUCHED rather than replaced by {} or by
// `flat`, so the caller's validator still rejects it — a double-encoded
// `arguments` string must never be laundered into an empty, accepted call.
const normalizeLiteralInput = (tu: any): Record<string, any> => {
  const { name: _n, input: _i, arguments: _a, parameters: _p, ...flat } = tu;
  const candidates = [tu.input, tu.arguments, tu.parameters];
  const nonObject = candidates.find((v) => v !== undefined && v !== null && !isPlainObject(v));
  if (nonObject !== undefined) return nonObject;
  return candidates.find((v) => isPlainObject(v) && Object.keys(v).length > 0) ?? flat;
};

/** Every complete tool_use literal in `text`, found with the string-aware scanner. */
const parseToolUseLiterals = (text: string): ToolUseLiteral[] => {
  const out: ToolUseLiteral[] = [];
  const re = /\{\s*"tool_use"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = findBalancedObjectEnd(text, m.index);
    if (end === -1) continue;
    try {
      const tu = JSON.parse(text.slice(m.index, end + 1))?.tool_use;
      if (tu && typeof tu.name === "string" && tu.name) {
        out.push({ start: m.index, end: end + 1, name: tu.name, input: normalizeLiteralInput(tu) });
        re.lastIndex = end + 1;
      }
    } catch {}
  }
  return out;
};

/** Blank out spans (same length) so offsets stay valid for later scans. */
const maskSpans = (text: string, spans: Array<{ start: number; end: number }>): string => {
  let out = text;
  for (const { start, end } of spans) out = out.slice(0, start) + " ".repeat(end - start) + out.slice(end);
  return out;
};

const fenceRanges = (text: string): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  const re = new RegExp(FENCE_MARK + "[\\s\\S]*?" + FENCE_MARK, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
};

/**
 * Parse an inline `{"tool_use":{"name":"...","input":{...}}}` literal out of
 * already-tidied text. Returns null when the content is not a usable tool_use
 * literal — the caller then falls back to plain text emission.
 *
 * `validate`, when supplied, is the same gate the XML path applies. Both shapes
 * converge here, so without it an unknown tool or undeclared parameter is
 * rejected as XML markup but accepted as a JSON literal, and the "never
 * fabricate a call" guarantee holds only by input shape.
 */
export const extractInlineToolUse = (
  content: string,
  validate?: ToolCallValidator
): { name: string; arguments: string } | null => {
  if (!content || !content.includes('"tool_use"')) return null;
  // Parse literals first with the string-aware brace scanner, so fence markers
  // INSIDE a JSON string (a Write content holding a regex or markdown) never
  // slice the payload. Fences are then located only in text OUTSIDE literals.
  const literals = parseToolUseLiterals(content);
  if (literals.length) {
    const fences = fenceRanges(maskSpans(content, literals));
    const inFence = (pos: number): boolean => fences.some(([a, b]) => pos >= a && pos < b);
    const accepted = literals.filter((l) => !validate || validate(l.name, l.input));
    // Prefer a literal outside any fence (a fenced one is usually a quoted
    // example); when every literal is fenced, take the LAST one.
    const pick = accepted.find((l) => !inFence(l.start)) ?? accepted.filter((l) => inFence(l.start)).pop();
    return pick ? { name: pick.name, arguments: JSON.stringify(pick.input) } : null;
  }

  // Fallback for a literal the scanner could not close: legacy first-fence body.
  const fenced = content.match(FENCE_BLOCK);
  const body = (fenced ? fenced[1] : content).trim();
  const start = body.indexOf("{");
  if (start === -1) return null;

  // Prefer the balanced object so trailing prose after the literal is dropped.
  // The whole tail is the fallback: it is the only candidate when the object
  // never closes, and a second chance when a malformed escape made the scanner
  // stop at the wrong brace.
  const end = findBalancedObjectEnd(body, start);
  const candidates = end !== -1 ? [body.slice(start, end + 1), body.slice(start)] : [body.slice(start)];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const tu = parsed?.tool_use;
      if (tu && typeof tu.name === "string" && tu.name) {
        const input = normalizeLiteralInput(tu);
        // A rejected call falls through to the next candidate rather than
        // returning null: when the brace scanner stopped early, the longer
        // candidate is the retry.
        if (validate && !validate(tu.name, input)) continue;
        return { name: tu.name, arguments: JSON.stringify(input) };
      }
    } catch {}
  }
  return null;
};
