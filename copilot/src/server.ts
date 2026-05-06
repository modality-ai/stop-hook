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

const sessions = new Map<string, SessionEntry>();
const sessionCreating = new Map<string, Promise<SessionEntry>>();

async function getOrCreateEntry(sessionKey: string): Promise<SessionEntry> {
  const existing = sessions.get(sessionKey);
  if (existing) return existing;

  // Deduplicate concurrent creation for the same key
  let creating = sessionCreating.get(sessionKey);
  if (!creating) {
    creating = ensureClientStarted().then(() => initSession("", {})).then((session) => {
      const entry: SessionEntry = { session, queue: Promise.resolve() };
      sessions.set(sessionKey, entry);
      sessionCreating.delete(sessionKey);
      logger.log(`🆕 Server session created: ${sessionKey}`);
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

      entry.session.send({ prompt }).catch(reject);
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
  prompt: string
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

      entry.session.send({ prompt }).catch(reject);
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

  // Extract last user message only (session owns its own context)
  const messages: any[] = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n")
        : "";

  if (!prompt) {
    return c.json({ error: { message: "No user message found" } }, 400);
  }

  try {
    const entry = await getOrCreateEntry(sessionKey);

    if (body.stream) {
      const stream = sendAndStream(entry, prompt, completionId, model);
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    const content = await sendAndCollect(entry, prompt);
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
