import { mkdirSync, writeFileSync } from "fs";
import { client, initSession, logger, setClientCwd, COPILOT_LOOP_DIR } from "./copilot-core";
import type { CopilotSession } from "@github/copilot-sdk";
import type { Context, Hono } from "hono";

// Server mode runs the Copilot binary from an isolated cwd so it never picks
// up the project's hooks/ directory (which would otherwise fire sessionStart
// on every turn — see hooks/agent-loop.json). Must run before client.start().
const SERVER_MODE_CWD = `${COPILOT_LOOP_DIR}/server-mode-cwd`;
mkdirSync(SERVER_MODE_CWD, { recursive: true });
setClientCwd(SERVER_MODE_CWD);

// ─────────────────────────────────────────────────────────────
// Session registry: x-session-id → CopilotSession
// Each session is used by one request at a time (mutex queue).
// ─────────────────────────────────────────────────────────────
function newAnonymousSessionKey(): string {
  return `__anonymous__-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

let anonymousSessionKey = newAnonymousSessionKey();

interface SessionEntry {
  session: CopilotSession;
  // Serialise concurrent requests: each request chains onto this promise
  queue: Promise<void>;
  // Fingerprint of the tool set this session was initialised with.
  // Used to detect when effectiveTools changed so the session can be replaced.
  toolFingerprint: string;
}

type BlobAttachment = {
  type: "blob";
  data: string;
  mimeType: string;
  displayName?: string;
};

interface PromptInput {
  prompt: string;
  attachments?: BlobAttachment[];
  error?: string;
}

const sessions = new Map<string, SessionEntry>();
const sessionCreating = new Map<string, Promise<SessionEntry>>();
const sessionTools = new Map<string, any[]>();

// Build system-prompt prefix that instructs the model to emit tool calls as inline
// JSON text instead of invoking SDK tools. Matches DEFAULT_SYSTEM_PREFIX convention
// in claude/handler.ts so streamProcessor.ts can parse them unchanged.
type NormalizedTool = {
  name: string;
  description: string;
  input_schema: any;
};

// Accept both Anthropic shape ({ name, description, input_schema }) and OpenAI
// shape ({ type: "function", function: { name, description, parameters } }).
// The upstream proxy may translate Anthropic → OpenAI before reaching us.
function normalizeTool(tool: any): NormalizedTool | null {
  if (!tool || typeof tool !== "object") return null;
  const fn = tool.function ?? {};
  const name = tool.name ?? fn.name;
  if (typeof name !== "string" || !name) return null;
  const canonicalName = typeof tool.name === "string" && tool.name.includes("___") ? tool.name : name;
  return {
    name: canonicalName,
    description: tool.description ?? fn.description ?? "",
    input_schema: tool.input_schema ?? fn.parameters ?? {},
  };
}

function formatToolEntry(tool: NormalizedTool, idx: number): string {
  const props = tool.input_schema?.properties ?? {};
  const required: string[] = tool.input_schema?.required ?? [];
  const fieldLines = Object.entries(props).map(([key, val]: [string, any]) => {
    const flag = required.includes(key) ? " (required)" : "";
    const t = val?.type ?? "any";
    const desc = val?.description ? ` — ${val.description}` : "";
    return `      - ${key}: ${t}${flag}${desc}`;
  });
  const fieldsBlock = fieldLines.length ? `\n    fields:\n${fieldLines.join("\n")}` : "";
  return `  ${idx + 1}. name: ${tool.name}\n    description: ${tool.description}${fieldsBlock}`;
}

function sampleValue(propSchema: any): any {
  const t = propSchema?.type;
  if (t === "string") return propSchema?.enum?.[0] ?? "...";
  if (t === "number" || t === "integer") return 0;
  if (t === "boolean") return true;
  if (t === "array") return [];
  if (t === "object") return {};
  return "...";
}

function buildExampleCall(tool: NormalizedTool): string {
  const props = tool.input_schema?.properties ?? {};
  const required: string[] = tool.input_schema?.required ?? [];
  const sample: Record<string, any> = {};
  for (const key of required) sample[key] = sampleValue(props[key]);
  return JSON.stringify({ tool_use: { name: tool.name, input: sample } });
}

function normalizeTools(tools?: any[]): NormalizedTool[] {
  return (tools ?? []).map(normalizeTool).filter((t): t is NormalizedTool => t !== null);
}

// Server-wide registry of full mcp__server___tool names ever seen. Lets us
// canonicalize short names even on turns where the upstream proxy didn't
// include the relevant MCP tool in body.tools — common during a session's
// first turn before all MCP servers are loaded.
const seenMcpToolNames = new Set<string>();

function addAliasesForName(aliases: Map<string, string>, name: string): void {
  if (aliases.has(name)) return;
  aliases.set(name, name);
  const lastSep = name.lastIndexOf("___");
  if (lastSep !== -1) {
    const suffix = name.slice(lastSep + 3);
    aliases.set(suffix, name);
    aliases.set(`_${suffix}`, name);
  }
  const firstSep = name.indexOf("__");
  if (firstSep !== -1) aliases.set(name.slice(firstSep + 2), name);
}

function buildToolAliasMap(tools?: any[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const tool of normalizeTools(tools)) {
    addAliasesForName(aliases, tool.name);
    if (tool.name.includes("___")) seenMcpToolNames.add(tool.name);
  }
  for (const name of seenMcpToolNames) addAliasesForName(aliases, name);
  return aliases;
}

// Drop tools that aren't MCP-style (no triple underscore in name). Claude Code's
// built-in router tools (Skill, Agent, AskUserQuestion, ...) don't have a backing
// implementation we can rely on — Copilot picks one for bare-word prompts (e.g.
// Filtering them at the boundary keeps the model's menu narrowed to real MCP
// integrations, which the user actually owns.
function filterMcpTools(tools?: any[]): any[] | undefined {
  if (!Array.isArray(tools)) return tools;
  return tools.filter((t: any) => {
    const name = t?.name ?? t?.function?.name;
    return typeof name === "string" && name.includes("___");
  });
}

function toolName(tool: any): string {
  return tool?.name ?? tool?.function?.name ?? "";
}

function mergeTools(existing?: any[], incoming?: any[]): any[] | undefined {
  const merged = new Map<string, any>();
  for (const tool of existing ?? []) {
    const name = toolName(tool);
    if (name) merged.set(name, tool);
  }
  for (const tool of incoming ?? []) {
    const name = toolName(tool);
    if (name) merged.set(name, tool);
  }
  return merged.size ? [...merged.values()] : undefined;
}

function rememberSessionTools(sessionKey: string, tools?: any[]): void {
  const merged = mergeTools(sessionTools.get(sessionKey), tools);
  if (merged?.length) sessionTools.set(sessionKey, merged);
}

function toolsForSession(sessionKey: string, tools?: any[]): any[] | undefined {
  return mergeTools(sessionTools.get(sessionKey), tools);
}

function canonicalizeToolUseText(text: string, tools?: any[]): string {
  const aliases = buildToolAliasMap(tools);
  if (!aliases.size || !text.includes('"tool_use"')) return text;
  return text.replace(/"name"\s*:\s*"([^"]+)"/g, (match, rawName) => {
    const canonicalName = aliases.get(rawName) ?? aliases.get(rawName.replace(/^_+/, ""));
    return canonicalName ? `"name":"${canonicalName}"` : match;
  });
}

// Tidy a `{"tool_use": ...}` literal that the model emitted with mismatched
// braces/brackets (truncated tail). Strict no-op unless ALL of:
//   1. text contains "tool_use"
//   2. the candidate substring fails JSON.parse as-is
//   3. brace-balancing produces a string that DOES parse
// Otherwise returns the original input verbatim.
function tidyToolUseJson(text: string): string {
  if (!text || !text.includes('"tool_use"')) return text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  if (start === -1) return text;
  const body = candidate.slice(start);
  try { JSON.parse(body); return body === text ? text : body; } catch {}

  let curly = 0, square = 0, inStr = false, esc = false;
  for (const ch of body) {
    if (esc) { esc = false; continue; }
    if (inStr) { if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
  }
  if (inStr || curly < 0 || square < 0) return text;
  let repaired = body;
  while (square-- > 0) repaired += "]";
  while (curly-- > 0) repaired += "}";
  try { JSON.parse(repaired); return repaired; } catch { return text; }
}

function buildToolSystemPrefix(tools: any[]): string {
  const normalized = normalizeTools(tools);
  if (!normalized.length) return "";
  const list = normalized.map(formatToolEntry).join("\n");
  const example = buildExampleCall(normalized[0]);
  return [
    "You are a tool-using assistant. The user's client owns tool execution.",
    "Per-turn decision flow:",
    "1. If the user's latest input is a tool result (a line starting with \"[Tool result for <NAME>]: ...\"), the previous tool call has ALREADY succeeded. Reply with a short natural-language answer that uses that result. Do NOT re-emit a tool_use for the same tool.",
    "2. If the user's request clearly maps to one of the Available tools, call that tool. Output ONLY the JSON tool_use literal below — no prose, no code fences, no extra keys.",
    "3. If the request does NOT match any available tool, answer in plain text. Do not force a tool call when none fits.",
    "When a tool call IS needed, output ONLY this JSON literal shape:",
    '{"tool_use":{"name":"<copy a name verbatim from Available tools>","input":<object whose keys match that tool\'s fields>}}',
    "Concrete shape example (this references a real entry from the list below; replace name + input with whichever tool actually matches the user's request):",
    example,
    "Critical rules:",
    "- The \"name\" value MUST be copied character-for-character from one of the Available tools entries. Do NOT write placeholder text like \"undefined\" or \"<name>\".",
    "- Include only fields listed under that tool. Required fields MUST be present.",
    "- Tool names may be long (e.g. mcp__Foo___Bar). Use the FULL exact string.",
    "- Never shorten MCP tool names. For example, if the Available tools entry is mcp__Counter___Counter__Deploy, emit that full name, not _Counter__Deploy or Counter__Deploy.",
    "- Never call the same tool more than once for a single user turn unless the user explicitly asks for it again. After a tool result arrives, finish with a text reply.",
    "Available tools:",
    list,
  ].join("\n");
}

// Fingerprint the tool set so requests with different tools key into different
// upstream sessions, even when the caller reuses the same x-session-id (or has
// none and falls into __default__). Without this, the first request seen for a
// session id wins and locks the system prompt for that session's lifetime.
function toolFingerprint(tools?: any[]): string {
  if (!tools?.length) return "none";
  const names = tools
    .map((t) => t?.name ?? t?.function?.name ?? "")
    .filter(Boolean)
    .sort()
    .join("|");
  if (!names) return "none";
  return Bun.hash(names).toString(36);
}

async function getOrCreateEntry(sessionKey: string, tools?: any[]): Promise<SessionEntry> {
  const fp = toolFingerprint(tools);
  const existing = sessions.get(sessionKey);

  // Reuse session when the tool set hasn't changed.
  if (existing && existing.toolFingerprint === fp) return existing;

  // Tools changed — drop the existing session and any in-flight creation so
  // the new creation wins. Only do this on an actual reset, not on first creation,
  // so concurrent first-time requests share one creation promise (no double init).
  if (existing) {
    logger.log(`🔄 Session reset for ${sessionKey}: tools changed (${existing.toolFingerprint} → ${fp})`);
    sessions.delete(sessionKey);
    sessionCreating.delete(sessionKey);
  }

  // Deduplicate concurrent creation for the same key
  let creating = sessionCreating.get(sessionKey);
  if (!creating) {
    const toolPrefix = tools?.length ? buildToolSystemPrefix(tools) : "";
    const sessionOpts = tools?.length
      ? { denyAllTools: true, systemPromptMode: "replace" as const }
      : {};
    creating = ensureClientStarted()
      .then(() => initSession(toolPrefix, sessionOpts))
      .then((session) => {
        const entry: SessionEntry = { session, queue: Promise.resolve(), toolFingerprint: fp };
        sessions.set(sessionKey, entry);
        logger.log(`🆕 Session created: ${sessionKey} fp=${fp}${tools?.length ? ` (${tools.length} tools)` : " (no tools)"}`);
        return entry;
      })
      .finally(() => {
        // Only clean up if OUR promise is still the active one — a reset may have
        // stored a newer creation promise that we must not delete.
        if (sessionCreating.get(sessionKey) === creating) {
          sessionCreating.delete(sessionKey);
        }
      });
    sessionCreating.set(sessionKey, creating);
  }
  return creating;
}

// ─────────────────────────────────────────────────────────────
// Model list cache
// ─────────────────────────────────────────────────────────────
let cachedModels: any[] | null = null;
let clientStarted = false;

async function ensureClientStarted(): Promise<void> {
  if (clientStarted) return;
  await client.start();
  clientStarted = true;
}

async function getModels(): Promise<any[]> {
  if (cachedModels) return cachedModels;
  await ensureClientStarted();
  cachedModels = await client.listModels();
  return cachedModels;
}

// ─────────────────────────────────────────────────────────────
// Token estimation — mirrors handler.ts estimateBodyInputTokens
// ─────────────────────────────────────────────────────────────
function extractSystemText(system: any): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((block: any) => block?.text ?? "").filter(Boolean).join("\n");
}

function withSystemPrompt(prompt: string, system: any): string {
  const systemText = extractSystemText(system).trim();
  return systemText ? `${systemText}\n\n${prompt}` : prompt;
}

function estimateInputTokens(body: any): number {
  let chars = 0;
  const sys = body.system;
  if (typeof sys === "string") chars += sys.length;
  else if (Array.isArray(sys))
    for (const b of sys) chars += b.text?.length ?? 0;
  for (const msg of body.messages ?? []) {
    const content = msg.content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text") chars += b.text?.length ?? 0;
        else if (b.type === "tool_use")
          chars += JSON.stringify(b.input ?? {}).length;
        else if (b.type === "tool_result") {
          if (typeof b.content === "string") chars += b.content.length;
          else if (Array.isArray(b.content))
            for (const c of b.content) chars += c.text?.length ?? 0;
        }
      }
    }
  }
  for (const tool of body.tools ?? []) chars += JSON.stringify(tool).length;
  return Math.round(chars / 4);
}

function parseDataImageUrl(url: string): BlobAttachment | null {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  const mimeType = match[1];
  if (!mimeType.startsWith("image/")) return null;
  return { type: "blob", mimeType, data: match[2] };
}

function extractPromptInput(message: any): PromptInput {
  const content = message?.content;
  if (typeof content === "string") return { prompt: content };
  if (!Array.isArray(content)) return { prompt: "" };

  const textParts: string[] = [];
  const attachments: BlobAttachment[] = [];

  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text ?? "");
      continue;
    }

    if (block.type === "image_url") {
      const url = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
      if (typeof url !== "string") return { prompt: "", error: "Invalid image_url content" };
      const attachment = parseDataImageUrl(url);
      if (!attachment) return { prompt: "", error: "Only base64 data image_url content is supported" };
      attachments.push(attachment);
      continue;
    }

    if (block.type === "image") {
      const src = block.source;
      if (src?.type !== "base64" || typeof src.data !== "string") {
        return { prompt: "", error: "Only base64 image content is supported" };
      }
      const mimeType = src.media_type ?? "application/octet-stream";
      if (!mimeType.startsWith("image/")) {
        return { prompt: "", error: "Only base64 image content is supported" };
      }
      attachments.push({ type: "blob", data: src.data, mimeType });
    }
  }

  return {
    prompt: textParts.join("\n"),
    ...(attachments.length && { attachments }),
  };
}

// Resolve the tool name for a tool_use_id / tool_call_id by scanning prior
// assistant messages. Handles both Anthropic shape (assistant.content[] with
// type: "tool_use") and OpenAI shape (assistant.tool_calls[] with id+function.name).
function resolveToolName(messages: any[], toolCallId: string): string {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "tool_use" && block.id === toolCallId) return block.name ?? toolCallId;
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id === toolCallId) return tc.function?.name ?? tc.name ?? toolCallId;
      }
    }
  }
  return toolCallId;
}

function formatToolResultContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("\n");
  return "";
}

function formatToolResultLine(messages: any[], toolId: string, content: any): string {
  const name = resolveToolName(messages, toolId);
  return `[Tool result for ${name}]: ${formatToolResultContent(content)}`;
}

// Walk back through consecutive role="tool" entries (OpenAI shape) ending at
// `endIdx`, formatting each as a "[Tool result for <name>]: ..." line.
function formatOpenAIToolBlock(messages: any[], endIdx: number): string {
  const lines: string[] = [];
  for (let j = endIdx; j >= 0 && messages[j]?.role === "tool"; j--) {
    const m = messages[j];
    lines.unshift(formatToolResultLine(messages, m.tool_call_id, m.content));
  }
  return lines.join("\n");
}

// Extract the latest user-side content to forward into the stateful Copilot
// session. Earlier history is already in the session — re-sending it makes the
// model treat the original request as fresh and re-call tools in a loop.
// Handles both formats arriving at this server:
//   - Anthropic-shaped: tool_result blocks live inside a user message.
//     `{ role: "user", content: [{ type: "tool_result", tool_use_id, content }] }`
//   - OpenAI-shaped: each tool_result is its own `{ role: "tool", tool_call_id, content }`.
//     The mcp-qdrant proxy converts Anthropic → OpenAI before reaching us.
function isNewConversation(messages: any[]): boolean {
  return (messages ?? []).filter((msg: any) => msg?.role !== "system").length === 1;
}

// Derive a stable session key that is unique per conversation.
// Problem: Claude Code always sends the same first user message ("quota" probe or
// the same <system-reminder> skeleton), so hashing only the first user message
// makes every conversation share the same derived key — requests queue on one
// session and cause apparent hangs.
// Solution: hash the system message CONTENT (which contains project-specific
// CLAUDE.md text injected by mcp-qdrant) + first user message. The system prompt
// varies per project and per Claude Code session, giving good uniqueness in practice.
// Returns null when no user message exists (caller falls back to anonymous key).
function deriveSessionKeyFromMessages(messages: any[]): string | null {
  const firstUser = (messages ?? []).find((m: any) => m?.role === "user");
  if (!firstUser) return null;
  const userContent = typeof firstUser.content === "string"
    ? firstUser.content
    : JSON.stringify(firstUser.content);
  const sysMsg = (messages ?? []).find((m: any) => m?.role === "system");
  // Extract system text — use up to 500 chars of actual content, not just the length.
  // The project-specific CLAUDE.md portion is what distinguishes conversations.
  const sysText = typeof sysMsg?.content === "string"
    ? sysMsg.content
    : Array.isArray(sysMsg?.content)
      ? (sysMsg.content as any[]).map((b: any) => b?.text ?? "").join("")
      : "";
  // djb2-xor over "<500 chars of system>|<200 chars of first user>"
  const sample = `${sysText.slice(0, 500)}|${userContent.slice(0, 200)}`;
  let h = 5381;
  for (let i = 0; i < sample.length; i++) h = (((h << 5) + h) ^ sample.charCodeAt(i)) | 0;
  return `conv_${(h >>> 0).toString(36)}`;
}

function resolveSessionKey(headerSessionId: string | undefined, messages: any[]): string {
  if (headerSessionId) return headerSessionId;
  const derived = deriveSessionKeyFromMessages(messages);
  if (derived) return derived;
  // No user message in request — fall back to the rotating anonymous key.
  if (isNewConversation(messages)) anonymousSessionKey = newAnonymousSessionKey();
  return anonymousSessionKey;
}

function isBareQuotaProbe(prompt: string, hadRawTools: boolean, sysLen: number): boolean {
  return prompt.trim().toLowerCase() === "quota" && !hadRawTools && sysLen === 0;
}

function containsToolReminder(prompt: string): boolean {
  return prompt.includes("The following skills are available") || prompt.includes("Available tools:");
}

function emptyCompletion(completionId: string, model: string, body: any) {
  return {
    id: completionId,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: estimateInputTokens(body), completion_tokens: 0, total_tokens: 0 },
  };
}

function extractLastTurn(messages: any[]): PromptInput {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg?.role === "tool") {
      return { prompt: formatOpenAIToolBlock(messages, i) };
    }

    if (msg?.role !== "user") continue;

    const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
    const toolResultBlocks = blocks.filter((b: any) => b?.type === "tool_result");
    const otherBlocks = blocks.filter((b: any) => b?.type !== "tool_result");

    if (!toolResultBlocks.length) return extractPromptInput(msg);

    const toolResultLines = toolResultBlocks.map((block: any) =>
      formatToolResultLine(messages, block.tool_use_id, block.content)
    );

    if (!otherBlocks.length) {
      return { prompt: toolResultLines.join("\n") };
    }

    const base = extractPromptInput({ ...msg, content: otherBlocks });
    const combined = [...toolResultLines, ...(base.prompt ? [base.prompt] : [])].join("\n");
    return { prompt: combined, attachments: base.attachments };
  }

  return { prompt: "" };
}

// ─────────────────────────────────────────────────────────────
// SSE helpers
// ─────────────────────────────────────────────────────────────
const encoder = new TextEncoder();

function sseChunk(data: string): Uint8Array {
  return encoder.encode(`data: ${data}\n\n`);
}

function sseOpenAIDelta(id: string, model: string, content: string): Uint8Array {
  return sseChunk(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })
  );
}

function sseOpenAIFinish(id: string, model: string, reason: "stop" | "tool_calls" = "stop"): Uint8Array {
  return sseChunk(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
    })
  );
}

function sseOpenAIToolCallDelta(
  id: string,
  model: string,
  callId: string,
  name: string,
  args: string
): Uint8Array {
  return sseChunk(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: args } }],
        },
        finish_reason: null,
      }],
    })
  );
}

// Parse an inline `{"tool_use":{"name":"...","input":{...}}}` literal out of
// already-tidied + canonicalized text. Returns null when content isn't a
// tool_use literal — caller falls back to plain text emission.
function extractInlineToolUse(content: string): { name: string; arguments: string } | null {
  if (!content || !content.includes('"tool_use"')) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]+?)```/);
  const body = (fenced ? fenced[1] : content).trim();
  const start = body.indexOf("{");
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(body.slice(start));
    const tu = parsed?.tool_use;
    if (tu && typeof tu.name === "string" && tu.name) {
      return { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) };
    }
  } catch {}
  return null;
}

function newToolCallId(): string {
  return `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ─────────────────────────────────────────────────────────────
// Core: send prompt, collect events until turn end
// Serialised per session via entry.queue so events don't cross-contaminate.
// ─────────────────────────────────────────────────────────────

// Drive one turn against the session: send the prompt, accumulate assistant
// content from delta/message events, and resolve with the full content when
// assistant.turn_end fires. Only assistant.turn_end is reliable — session.idle
// can fire from a prior turn and would resolve before the model produces output.
function runTurn(
  entry: SessionEntry,
  prompt: string,
  attachments?: BlobAttachment[]
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let fullContent = "";
    const unsub = entry.session.on((event: any) => {
      try {
        if (event.type === "assistant.message_delta") {
          fullContent += event.data.deltaContent ?? "";
        } else if (event.type === "assistant.message") {
          fullContent = event.data.content ?? fullContent;
        } else if (event.type === "assistant.turn_end") {
          unsub();
          resolve(fullContent);
        } else if (event.type === "session.error") {
          unsub();
          reject(new Error(event.data.message));
        }
      } catch (e) {
        unsub();
        reject(e);
      }
    });

    entry.session.send(attachments?.length ? { prompt, attachments } : { prompt }).catch((err) => {
      unsub();
      reject(err);
    });
  });
}

function sendAndStream(
  entry: SessionEntry,
  prompt: string,
  attachments: BlobAttachment[] | undefined,
  completionId: string,
  model: string,
  tools?: any[]
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  // Fire-and-forget writes that swallow rejections. Without this, an aborted
  // consumer turns every delta into an unhandled rejection ("error: undefined")
  // logged by Bun per event.
  const safeWrite = (chunk: Uint8Array) => {
    writer.write(chunk).catch(() => {});
  };

  entry.queue = entry.queue
    .then(() => runTurn(entry, prompt, attachments))
    .then((fullContent) => {
      const content = canonicalizeToolUseText(tidyToolUseJson(fullContent), tools);
      const tu = extractInlineToolUse(content);
      if (tu) {
        safeWrite(sseOpenAIToolCallDelta(completionId, model, newToolCallId(), tu.name, tu.arguments));
        safeWrite(sseOpenAIFinish(completionId, model, "tool_calls"));
      } else {
        if (content) safeWrite(sseOpenAIDelta(completionId, model, content));
        safeWrite(sseOpenAIFinish(completionId, model));
      }
      safeWrite(encoder.encode("data: [DONE]\n\n"));
    })
    .catch((err: any) => {
      logger.error(`Server stream error: ${err?.message ?? err}`);
    })
    .finally(() => {
      writer.close().catch(() => {});
    });

  return readable;
}

async function sendAndCollect(
  entry: SessionEntry,
  prompt: string,
  attachments?: BlobAttachment[],
  tools?: any[]
): Promise<string> {
  const turn = entry.queue.then(() => runTurn(entry, prompt, attachments));
  entry.queue = turn.then(() => undefined, () => undefined);
  const fullContent = await turn;
  return canonicalizeToolUseText(tidyToolUseJson(fullContent), tools);
}

// ─────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────

async function modelsHandler(c: Context) {
  try {
    const models = await getModels();
    return c.json({
      object: "list",
      data: models.map((m: any) => ({
        id: m.id,
        object: "model",
        owned_by: "github-copilot",
        ...(m.billing?.multiplier != null && { billing_multiplier: m.billing.multiplier }),
      })),
    });
  } catch (err: any) {
    return c.json({ error: { message: err.message } }, 503);
  }
}

async function countTokensHandler(c: Context) {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  return c.json({ input_tokens: estimateInputTokens(body) });
}

async function completionsHandler(c: Context) {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }

  const rawTools = Array.isArray(body.tools) ? body.tools : undefined;
  const hadRawTools = !!rawTools?.length;
  const rawToolNames = (rawTools ?? []).slice(0, 8).map((t: any) => toolName(t) || "?");

  // Strip non-MCP tools at the boundary so the rest of the pipeline (system
  // prompt builder, alias map, tool_calls extractor) only ever sees real MCP
  // tools. Claude Code's router built-ins are dispatched by Claude Code itself
  // and aren't ours to expose to the Copilot model.
  if (rawTools) body.tools = filterMcpTools(rawTools);
  const filteredToolNames = (body.tools ?? []).slice(0, 8).map((t: any) => toolName(t) || "?");

  const model = body.model ?? "gpt-4.1";
  const completionId = `chatcmpl-${Date.now().toString(36)}`;

  // [diag] Inspect what the upstream proxy is actually sending. Remove once
  const toolNames = (body.tools ?? []).slice(0, 3).map((t: any) => t?.name ?? t?.function?.name ?? "?");
  const sysLen = typeof body.system === "string"
    ? body.system.length
    : Array.isArray(body.system)
      ? body.system.reduce((n: number, b: any) => n + (b?.text?.length ?? 0), 0)
      : 0;
  const msgs = body.messages ?? [];
  const lastUser = [...msgs].reverse().find((m: any) => m?.role === "user");
  const lastUserPreview = typeof lastUser?.content === "string"
    ? lastUser.content.slice(0, 80)
    : JSON.stringify(lastUser?.content ?? "").slice(0, 80);
  logger.log(`🔍 completions: model=${body.model ?? "<default>"} msgs=${msgs.length} rawTools=${rawTools?.length ?? 0} [${rawToolNames.join(",")}] filteredTools=${body.tools?.length ?? 0} [${filteredToolNames.join(",")}] | sys=${sysLen} | lastUser="${lastUserPreview}"`);

  // [diag-deep] When suspicious (no tools AND no system AND short last-user),
  // dump the full request body so we can pin down the upstream sender.
  const isSuspicious = (body.tools?.length ?? 0) === 0 && sysLen === 0 && (typeof lastUser?.content === "string") && lastUser.content.length < 30;
  if (isSuspicious) {
    try {
      const dumpPath = `/tmp/copilot-loop/suspicious-${Date.now()}.json`;
      writeFileSync(dumpPath, JSON.stringify(body, null, 2));
      logger.log(`🔍 dumped suspicious body to ${dumpPath}`);
    } catch (e: any) {
      logger.log(`🔍 dump failed: ${e?.message ?? e}`);
    }
  }

  // Extract the latest turn — resolves tool_result blocks into formatted text so
  // the stateful Copilot session can continue after client-side tool execution.
  const messages: any[] = body.messages ?? [];
  const headerSessionId = c.req.header("x-session-id");
  const sessionKey = resolveSessionKey(headerSessionId, messages);
  logger.log(`🔑 session: ${sessionKey}${headerSessionId ? " (from header)" : " (derived)"}`);
  const { prompt, attachments, error } = extractLastTurn(messages);

  if (error) return c.json({ error: { message: error } }, 400);
  if (!prompt && !attachments?.length) return c.json({ error: { message: "No user message found" } }, 400);

  try {
    rememberSessionTools(sessionKey, body.tools);
    const effectiveTools = toolsForSession(sessionKey, body.tools);
    if (isBareQuotaProbe(prompt, hadRawTools, sysLen) && !effectiveTools?.length) {
      logger.log("🔍 filtered bare quota probe");
      return c.json(emptyCompletion(completionId, model, body));
    }

    if (!effectiveTools?.length && containsToolReminder(prompt)) {
      // No MCP tools available for this session — fall through to Copilot without
      // a tool prefix. The model responds in plain text so the caller isn't left
      // hanging on an empty completion. Dump kept for diagnostics only.
      try {
        const dumpPath = `/tmp/copilot-loop/missing-tools-${Date.now()}.json`;
        writeFileSync(dumpPath, JSON.stringify(body, null, 2));
        logger.log(`🔍 no MCP tools for tool-reminder request — falling through (dumped to ${dumpPath})`);
      } catch (e: any) {
        logger.log(`🔍 missing-tools dump failed: ${e?.message ?? e}`);
      }
    }

    const entry = await getOrCreateEntry(sessionKey, effectiveTools);
    const effectivePrompt = withSystemPrompt(prompt, body.system);

    if (body.stream) {
      const stream = sendAndStream(entry, effectivePrompt, attachments, completionId, model, effectiveTools);
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    const content = await sendAndCollect(entry, effectivePrompt, attachments, effectiveTools);
    const tu = extractInlineToolUse(content);
    const message = tu
      ? {
          role: "assistant",
          content: null,
          tool_calls: [{ id: newToolCallId(), type: "function", function: { name: tu.name, arguments: tu.arguments } }],
        }
      : { role: "assistant", content };
    return c.json({
      id: completionId,
      object: "chat.completion",
      model,
      choices: [{ index: 0, message, finish_reason: tu ? "tool_calls" : "stop" }],
      usage: {
        prompt_tokens: estimateInputTokens(body),
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  } catch (err: any) {
    logger.error(`Server error: ${err.message}`);
    return c.json({ error: { message: err.message } }, 500);
  }
}

// ─────────────────────────────────────────────────────────────
// Mount
// ─────────────────────────────────────────────────────────────

export const copilotToOpenAIHandler = (prefixPath: string, hono: Hono) => {
  const p = prefixPath.replace(/\/$/, "");
  hono.get(`${p}/v1/models`, modelsHandler);
  hono.post(`${p}/v1/messages/count_tokens`, countTokensHandler);
  hono.post(`${p}/v1/chat/completions`, completionsHandler);
};
