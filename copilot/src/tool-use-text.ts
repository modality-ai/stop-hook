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
export const TOOL_MARKUP_START = /<(?:antml:)?(?:function_calls|invoke)\b/;

const INVOKE_BLOCK = /<(?:antml:)?invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)(?=<\/(?:antml:)?invoke>|<(?:antml:)?invoke\s|<\/(?:antml:)?function_calls>|$)/i;
const PARAM_BLOCK = /<(?:antml:)?parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)(?=<\/(?:antml:)?parameter>|<(?:antml:)?parameter\s|<\/(?:antml:)?invoke>|<\/(?:antml:)?function_calls>|$)/gi;

const decodeEntities = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * Coerce a parameter's text body to a JSON value.
 *
 * Only unambiguous JSON shapes are parsed — anything else stays a string, so a
 * shell command like `test -f x && echo 1` is never mangled into a number or
 * rejected outright.
 */
const coerceParamValue = (raw: string): any => {
  const trimmed = raw.trim();
  if (/^(?:true|false|null)$/.test(trimmed) || /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return JSON.parse(trimmed);
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { return raw; }
  }
  return raw;
};

/**
 * Rewrite the FIRST XML-style invoke block in `text` as a `{"tool_use": …}`
 * literal. Text without such a block is returned verbatim.
 *
 * Only the first block is converted because the downstream OpenAI response
 * carries a single tool_call per turn; prose surrounding the block is dropped
 * along with it, matching how a tool_use literal replaces the turn's content.
 */
export const xmlToolUseToJson = (text: string): string => {
  if (!text || !TOOL_MARKUP_START.test(text)) return text;
  const block = text.match(INVOKE_BLOCK);
  if (!block) return text;

  const name = block[1].trim();
  if (!name) return text;

  const input: Record<string, any> = {};
  PARAM_BLOCK.lastIndex = 0;
  let param: RegExpExecArray | null;
  while ((param = PARAM_BLOCK.exec(block[2])) !== null) {
    input[param[1].trim()] = coerceParamValue(decodeEntities(param[2]));
  }

  return JSON.stringify({ tool_use: { name, input } });
};

// ─── tool_use literal extraction ─────────────────────────────────────────────

/**
 * Parse an inline `{"tool_use":{"name":"...","input":{...}}}` literal out of
 * already-tidied text. Returns null when the content is not a usable tool_use
 * literal — the caller then falls back to plain text emission.
 */
export const extractInlineToolUse = (content: string): { name: string; arguments: string } | null => {
  if (!content || !content.includes('"tool_use"')) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]+?)```/);
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
        return { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) };
      }
    } catch {}
  }
  return null;
};
