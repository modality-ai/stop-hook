import { Hono } from "hono";
import { client, initSession, logger } from "./copilot-core";
import type { CopilotSession } from "@github/copilot-sdk";

// ─────────────────────────────────────────────────────────────
// Session registry: x-session-id → CopilotSession
// Each session is used by one request at a time (mutex queue).
// ─────────────────────────────────────────────────────────────
const DEFAULT_SESSION_KEY = "__default__";

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

// Build system-prompt prefix that instructs the model to emit tool calls as inline
// JSON text instead of invoking SDK tools. Matches DEFAULT_SYSTEM_PREFIX convention
// in claude/handler.ts so streamProcessor.ts can parse them unchanged.
function buildToolSystemPrefix(tools: any[]): string {
  if (!tools.length) return "";
  const schema = tools.map(({ name, description, input_schema }: any) => ({
    name,
    description,
    input_schema,
  }));
  return [
    'When calling a tool, output ONLY this JSON and stop: {"tool_use":{"name":"<name>","input":<args>}}',
    "Never add surrounding text when calling a tool.",
    `Available tools: ${JSON.stringify(schema)}`,
  ].join("\n");
}

async function getOrCreateEntry(sessionKey: string, tools?: any[]): Promise<SessionEntry> {
  const existing = sessions.get(sessionKey);
  if (existing) return existing;

  // Deduplicate concurrent creation for the same key
  let creating = sessionCreating.get(sessionKey);
  if (!creating) {
    const toolPrefix = tools?.length ? buildToolSystemPrefix(tools) : "";
    const sessionOpts = tools?.length ? { denyAllTools: true } : {};
    creating = ensureClientStarted()
      .then(() => initSession(toolPrefix, sessionOpts))
      .then((session) => {
        const entry: SessionEntry = { session, queue: Promise.resolve() };
        sessions.set(sessionKey, entry);
        sessionCreating.delete(sessionKey);
        logger.log(`🆕 Server session created: ${sessionKey}${tools?.length ? ` (${tools.length} tools injected)` : ""}`);
        return entry;
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

// Resolve the tool name for a tool_use_id by scanning prior assistant messages.
function resolveToolName(messages: any[], toolUseId: string): string {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block.type === "tool_use" && block.id === toolUseId) return block.name ?? toolUseId;
    }
  }
  return toolUseId;
}

// Extract the prompt for the Copilot session from the full message history.
// Handles the tool-use round-trip: tool_result messages are formatted as
// "[Tool result for {name}]: {content}" so the stateful session can continue.
function extractLastTurn(messages: any[]): PromptInput {
  const toolResultLines: string[] = [];

  // Walk messages in reverse, collecting consecutive tool_result turns
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
    const isPureToolResult = blocks.length > 0 && blocks.every((b: any) => b.type === "tool_result");
    if (!isPureToolResult) {
      // This is the real user message — extract it and prepend any tool results
      const base = extractPromptInput(msg);
      if (!toolResultLines.length) return base;
      const combined = [...toolResultLines, ...(base.prompt ? [base.prompt] : [])].join("\n");
      return { prompt: combined, attachments: base.attachments };
    }
    // Format tool_result blocks
    for (const block of blocks) {
      const name = resolveToolName(messages, block.tool_use_id);
      const content =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c: any) => c.text ?? "").join("\n")
            : "";
      toolResultLines.unshift(`[Tool result for ${name}]: ${content}`);
    }
  }

  // Only tool results, no prior user message
  return { prompt: toolResultLines.join("\n") };
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
  model: string
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Chain onto session queue so concurrent requests are serialised
  const work = () =>
    new Promise<void>((resolve, reject) => {
      const unsub = entry.session.on((event: any) => {
        try {
          if (event.type === "assistant.message_delta") {
            writer.write(sseOpenAIDelta(completionId, model, event.data.deltaContent ?? ""));
          } else if (event.type === "assistant.turn_end" || event.type === "session.idle") {
            writer.write(sseOpenAIFinish(completionId, model));
            writer.write(encoder.encode("data: [DONE]\n\n"));
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

      entry.session.send(attachments?.length ? { prompt, attachments } : { prompt }).catch(reject);
    });

  entry.queue = entry.queue
    .then(work)
    .catch((err: any) => {
      logger.error(`Server stream error: ${err.message}`);
    })
    .finally(() => {
      writer.close().catch(() => {});
    });

  return readable;
}

async function sendAndCollect(
  entry: SessionEntry,
  prompt: string,
  attachments?: BlobAttachment[]
): Promise<string> {
  let fullContent = "";

  const work = () =>
    new Promise<void>((resolve, reject) => {
      const unsub = entry.session.on((event: any) => {
        if (event.type === "assistant.message_delta") {
          fullContent += event.data.deltaContent ?? "";
        } else if (event.type === "assistant.message") {
          fullContent = event.data.content ?? fullContent;
        } else if (event.type === "assistant.turn_end" || event.type === "session.idle") {
          unsub();
          resolve();
        } else if (event.type === "session.error") {
          unsub();
          reject(new Error(event.data.message));
        }
      });

      entry.session.send(attachments?.length ? { prompt, attachments } : { prompt }).catch(reject);
    });

  const turn = entry.queue.then(work);
  entry.queue = turn.catch(() => {});
  await turn;
  return fullContent;
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

  const sessionKey = c.req.header("x-session-id") ?? DEFAULT_SESSION_KEY;
  const model = body.model ?? "gpt-4.1";
  const completionId = `chatcmpl-${Date.now().toString(36)}`;

  // Extract the latest turn — resolves tool_result blocks into formatted text so
  // the stateful Copilot session can continue after client-side tool execution.
  const messages: any[] = body.messages ?? [];
  const { prompt, attachments, error } = extractLastTurn(messages);

  if (error) {
    return c.json({ error: { message: error } }, 400);
  }

  if (!prompt && !attachments?.length) {
    return c.json({ error: { message: "No user message found" } }, 400);
  }

  try {
    const entry = await getOrCreateEntry(sessionKey, body.tools);

    if (body.stream) {
      const stream = sendAndStream(entry, prompt, attachments, completionId, model);
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    const content = await sendAndCollect(entry, prompt, attachments);
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
  port: 3000,
  fetch: app.fetch,
};
