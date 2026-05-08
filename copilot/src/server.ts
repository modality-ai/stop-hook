import { Hono } from "hono";
import { mkdirSync } from "fs";
import { client, initSession, logger, setClientCwd, COPILOT_LOOP_DIR } from "./copilot-core";
import type { CopilotSession } from "@github/copilot-sdk";

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
let anonymousSessionKey = `__anonymous__-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

interface SessionEntry {
  session: CopilotSession;
  // Serialise concurrent requests: each request chains onto this promise
  queue: Promise<void>;
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

function buildToolAliasMap(tools?: any[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const tool of normalizeTools(tools)) {
    aliases.set(tool.name, tool.name);
    const lastSep = tool.name.lastIndexOf("___");
    if (lastSep !== -1) {
      const suffix = tool.name.slice(lastSep + 3);
      aliases.set(suffix, tool.name);
      aliases.set(`_${suffix}`, tool.name);
    }
    const firstSep = tool.name.indexOf("__");
    if (firstSep !== -1) aliases.set(tool.name.slice(firstSep + 2), tool.name);
  }
  return aliases;
}

function rememberSessionTools(sessionKey: string, tools?: any[]): void {
  if (tools?.length) sessionTools.set(sessionKey, tools);
}

function toolsForSession(sessionKey: string, tools?: any[]): any[] | undefined {
  return tools?.length ? tools : sessionTools.get(sessionKey);
}

function canonicalizeToolUseText(text: string, tools?: any[]): string {
  const aliases = buildToolAliasMap(tools);
  if (!aliases.size || !text.includes('"tool_use"')) return text;
  return text.replace(/"name"\s*:\s*"([^"]+)"/g, (match, rawName) => {
    const canonicalName = aliases.get(rawName) ?? aliases.get(rawName.replace(/^_+/, ""));
    return canonicalName ? `"name":"${canonicalName}"` : match;
  });
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
    "2. Otherwise, scan the Available tools list and pick the tool whose description best fits the new request. You MUST call one listed tool; if the request is ambiguous, choose the closest matching tool instead of asking a clarification question.",
    "When you call a tool, output ONLY a single JSON literal in this shape and nothing else (no prose, no code fences, no extra keys):",
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
  const fullKey = `${sessionKey}::${toolFingerprint(tools)}`;
  const existing = sessions.get(fullKey);
  if (existing) return existing;

  // Deduplicate concurrent creation for the same key
  let creating = sessionCreating.get(fullKey);
  if (!creating) {
    const toolPrefix = tools?.length ? buildToolSystemPrefix(tools) : "";
    const sessionOpts = tools?.length
      ? { denyAllTools: true, systemPromptMode: "replace" as const }
      : {};
    creating = ensureClientStarted()
      .then(() => initSession(toolPrefix, sessionOpts))
      .then((session) => {
        const entry: SessionEntry = { session, queue: Promise.resolve() };
        sessions.set(fullKey, entry);
        logger.log(`🆕 Server session created: ${fullKey}${tools?.length ? ` (${tools.length} tools injected)` : ""}`);
        return entry;
      })
      .finally(() => {
        // Drop the in-flight slot whether creation resolved or rejected — a
        // sticky rejected promise would poison every later request for this key.
        sessionCreating.delete(fullKey);
      });
    sessionCreating.set(fullKey, creating);
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
  return {
    type: "blob",
    mimeType,
    data: match[2],
  };
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
      attachments.push({
        type: "blob",
        data: src.data,
        mimeType,
      });
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

function resolveSessionKey(headerSessionId: string | undefined, messages: any[]): string {
  if (headerSessionId) return headerSessionId;
  if (isNewConversation(messages)) {
    anonymousSessionKey = `__anonymous__-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return anonymousSessionKey;
}

function extractLastTurn(messages: any[]): PromptInput {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    // OpenAI tool messages: walk back through consecutive role="tool" entries
    // and emit each one as a "[Tool result for ...]: ..." line.
    if (msg?.role === "tool") {
      const toolResultLines: string[] = [];
      let j = i;
      while (j >= 0 && messages[j]?.role === "tool") {
        const m = messages[j];
        const name = resolveToolName(messages, m.tool_call_id);
        toolResultLines.unshift(`[Tool result for ${name}]: ${formatToolResultContent(m.content)}`);
        j--;
      }
      return { prompt: toolResultLines.join("\n") };
    }

    if (msg?.role !== "user") continue;

    const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
    const toolResultBlocks = blocks.filter((b: any) => b?.type === "tool_result");
    const otherBlocks = blocks.filter((b: any) => b?.type !== "tool_result");

    if (!toolResultBlocks.length) {
      return extractPromptInput(msg);
    }

    const toolResultLines = toolResultBlocks.map((block: any) => {
      const name = resolveToolName(messages, block.tool_use_id);
      return `[Tool result for ${name}]: ${formatToolResultContent(block.content)}`;
    });

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

function sseOpenAIFinish(id: string, model: string): Uint8Array {
  return sseChunk(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })
  );
}

// ─────────────────────────────────────────────────────────────
// Core: send prompt, collect events until turn end
// Returns a ReadableStream for streaming, or string for non-streaming.
// Serialised per session via entry.queue so events don't cross-contaminate.
// ─────────────────────────────────────────────────────────────
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

  // Chain onto session queue so concurrent requests are serialised
  const work = () =>
    new Promise<void>((resolve, reject) => {
      let fullContent = "";
      const unsub = entry.session.on((event: any) => {
        try {
          if (event.type === "assistant.message_delta") {
            fullContent += event.data.deltaContent ?? "";
          } else if (event.type === "assistant.message") {
            fullContent = event.data.content ?? fullContent;
          } else if (event.type === "assistant.turn_end") {
            const content = canonicalizeToolUseText(fullContent, tools);
            if (content) safeWrite(sseOpenAIDelta(completionId, model, content));
            safeWrite(sseOpenAIFinish(completionId, model));
            safeWrite(encoder.encode("data: [DONE]\n\n"));
            unsub();
            resolve();
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

  entry.queue = entry.queue
    .then(work)
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
  let fullContent = "";

  const work = () =>
    new Promise<void>((resolve, reject) => {
      const unsub = entry.session.on((event: any) => {
        if (event.type === "assistant.message_delta") {
          fullContent += event.data.deltaContent ?? "";
        } else if (event.type === "assistant.message") {
          fullContent = event.data.content ?? fullContent;
        } else if (event.type === "assistant.turn_end") {
          // Only assistant.turn_end is reliable — session.idle can fire from a
          // prior turn or while the SDK is between operations, which would
          // resolve us before the model produces output.
          unsub();
          resolve();
        } else if (event.type === "session.error") {
          unsub();
          reject(new Error(event.data.message));
        }
      });

      entry.session.send(attachments?.length ? { prompt, attachments } : { prompt }).catch((err) => {
        unsub();
        reject(err);
      });
    });

  const turn = entry.queue.then(work);
  entry.queue = turn.catch(() => {});
  await turn;
  return canonicalizeToolUseText(fullContent, tools);
}

// ─────────────────────────────────────────────────────────────
// Hono app
// ─────────────────────────────────────────────────────────────
const app = new Hono();

// GET /v1/models
app.get("/v1/models", async (c) => {
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
});

// POST /v1/messages/count_tokens
app.post("/v1/messages/count_tokens", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  return c.json({ input_tokens: estimateInputTokens(body) });
});

// POST /v1/chat/completions
app.post("/v1/chat/completions", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }

  const model = body.model ?? "gpt-4.1";
  const completionId = `chatcmpl-${Date.now().toString(36)}`;

  // Extract the latest turn — resolves tool_result blocks into formatted text so
  // the stateful Copilot session can continue after client-side tool execution.
  const messages: any[] = body.messages ?? [];
  const sessionKey = resolveSessionKey(c.req.header("x-session-id"), messages);
  const { prompt, attachments, error } = extractLastTurn(messages);

  if (error) {
    return c.json({ error: { message: error } }, 400);
  }

  if (!prompt && !attachments?.length) {
    return c.json({ error: { message: "No user message found" } }, 400);
  }

  try {
    rememberSessionTools(sessionKey, body.tools);
    const effectiveTools = toolsForSession(sessionKey, body.tools);
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
    return c.json({
      id: completionId,
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
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
});

export default {
  port: 8318,
  fetch: app.fetch,
  idleTimeout: 255
};
