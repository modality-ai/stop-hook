import { listFiles, removeFile, staleDumps, tryMkdir } from "./loop-fs";
import { describeRunaway, detectRunaway } from "./runaway";
import { isTrustedSyntheticToolId } from "./synthetic-tool-id";
import { isSideRequest, sideSessionKey } from "./side-request";
import {
  ClientStrikeCounter,
  StartLatch,
  CLIENT_FAILURES_BEFORE_RESTART,
} from "./client-lifecycle";
import {
  client,
  initSession,
  logger,
  resetClient,
  setClientCwd,
  writeLoopFile,
  COPILOT_LOOP_DIR,
  type SdkLifecycle,
} from "./copilot-core";
import { DEFAULT_MODEL } from "./config";
import {
  extractInlineToolUse,
  slimCounterResult,
  tidyToolUseJsonDetailed,
  xmlToolUseToJson,
  type XmlToolSchemas,
} from "./tool-use-text";
import { aliasMapForTools, buildXmlToolSchemas } from "./tool-schemas";
import { shouldNudgeToolIntent, TOOL_NUDGE_PROMPT } from "./turn-content";
import { imageUrlToAttachment, type BlobAttachment } from "./image-attachment";
import {
  abandonPendingCalls,
  answerToolResults,
  createNativeSessionState,
  drainOrphanedCalls,
  nativeFinishReason,
  runNativeLeg,
  salvageValidator,
  toExternalTools,
  toolMessageText,
  trailingToolResults,
  PARALLEL_CALL_QUIET_MS,
  type FinishedLegResult,
  type NativeSessionState,
} from "./native-turn";
import type { CopilotSession } from "@github/copilot-sdk";
import type { Context, Hono } from "hono";

// Server mode runs the Copilot binary from an isolated cwd so it never picks
// up the project's hooks/ directory (which would otherwise fire sessionStart
// on every turn — see hooks/agent-loop.json). Must run before client.start().
const SERVER_MODE_CWD = `${COPILOT_LOOP_DIR}/server-mode-cwd`;
// Best-effort at import: initSession re-asserts this directory before every
// session.create, so a failure here is recoverable rather than fatal.
tryMkdir(SERVER_MODE_CWD);
setClientCwd(SERVER_MODE_CWD);

// ─────────────────────────────────────────────────────────────
// Session registry: x-session-id → CopilotSession
// Each session is used by one request at a time (mutex queue).
// ─────────────────────────────────────────────────────────────
function newAnonymousSessionKey(): string {
  return `__anonymous__-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

let anonymousSessionKey = newAnonymousSessionKey();

// Server mode exposes no runtime tools (see denyAllTools), so the SDK's default
// system prompt — which describes bash/edit/read — invites calls that can only
// be denied. Replaced whenever the client supplies its own tool set.
const BASE_SERVER_MODE_PROMPT =
  "You are a helpful assistant. Tool calls are executed by the client application; call tools directly rather than describing them.";

// Rules written for a client that routes `*name` method commands through a
// method-execution tool. Other OpenAI-compatible clients have no such tool, so
// the rules are opt-in: COPILOT_METHOD_RULES=1 (read per call, not at load).
const METHOD_CLIENT_RULES = [
  "Rules:",
  "- The tools in your tool list are available. Never say a tool is unavailable, blocked or removed without first calling it.",
  "- A user message that is, or starts with, `*name` (for example `*debug --init`) is a method command. Run it by calling the method-execution tool (such as ExecuteMethod) with the full text as `method`; do not describe or simulate it.",
  "- When a tool result contains instructions, carry them out in order, calling further tools as needed.",
  "- Never end a turn with empty output. After a tool result, either call the next tool or reply with a short text answer.",
];

export function serverModeSystemPrompt(): string {
  if (process.env.COPILOT_METHOD_RULES?.trim() !== "1") return BASE_SERVER_MODE_PROMPT;
  return [BASE_SERVER_MODE_PROMPT, "", ...METHOD_CLIENT_RULES].join("\n");
}

// Diagnostic dumps are for eyeballing the last few bad requests. Without a cap
// they accumulate forever, and each one holds a full request body — prompt text
// routinely carries credentials.
const MAX_DIAGNOSTIC_DUMPS = 20;

function writeDiagnosticDump(prefix: string, body: any): string {
  // The random suffix keeps two dumps in the same millisecond apart; it follows
  // the timestamp, so staleDumps' lexical sort stays chronological.
  const dumpPath = `${COPILOT_LOOP_DIR}/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  // Prompts carry credentials, and /tmp is shared: created owner-only, so the file
  // is never readable even between the write and a later chmod.
  writeLoopFile(dumpPath, JSON.stringify(body, null, 2), 0o600);
  for (const f of staleDumps(listFiles(COPILOT_LOOP_DIR), prefix, MAX_DIAGNOSTIC_DUMPS)) {
    removeFile(`${COPILOT_LOOP_DIR}/${f}`);
  }
  return dumpPath;
}

interface SessionEntry {
  session: CopilotSession;
  // Serialise concurrent requests: each request chains onto this promise
  queue: Promise<void>;
  // Fingerprint of the tool set the session currently declares. Updated when a
  // later request's tools are pushed with rpc.tools.set.
  toolFingerprint: string;
  // Copilot model the session currently runs. A different requested model is
  // applied in place with session.setModel (see syncEntry), history preserved.
  model: string;
  // The proxy session key (header x-session-id or derived hash). Carried on the
  // entry so per-turn error handlers can invalidate the right map entry without
  // a reverse lookup, enabling self-healing resume on the next request.
  sessionKey: string;
  // Native tool calls parked on us, plus ones that arrived after their batch was
  // returned. Entry-scoped so replacing the session drops them with it — a stale
  // entry can never answer, or inherit, another entry's calls.
  native: NativeSessionState;
  // Consecutive abnormal turns (empty or truncated). A single abnormal turn can
  // be a harmless blip, so the entry is only discarded once the session proves
  // it is stuck (see ABNORMAL_TURNS_BEFORE_INVALIDATE). Reset by any healthy
  // turn — a truncated turn carries text, so only "no content" is insufficient.
  consecutiveAbnormalTurns: number;
  // Set once the entry is dropped and its SDK session disposed. A request queued
  // behind the failing one still holds this entry; it must not send into the
  // disposed session (the runtime answers with a native "already disposed" error).
  disposed: boolean;
  // Legs queued or running on this session. Calls are parked only once the model
  // asks for them, so a request arriving earlier would still find nothing parked
  // and send its prompt into a turn that is busy.
  activeLegs: number;
  // Last time a request touched this entry; the idle sweep evicts on it.
  lastUsed: number;
}

interface PromptInput {
  prompt: string;
  attachments?: BlobAttachment[];
  error?: string;
}

const sessions = new Map<string, SessionEntry>();
const sessionCreating = new Map<string, Promise<SessionEntry>>();
// Tools outlive idle eviction (see releaseSession), so bound the map by count.
const MAX_REMEMBERED_TOOL_SESSIONS = 500;
const sessionTools = new Map<string, any[]>();

// Server-wide fallback: last MCP tool set seen across ALL sessions.
// Used when a session has no remembered tools (e.g. first turn of a new session
// where Claude Code omitted tools from the request body).
let globalMcpTools: any[] | undefined;

// Tool normalization and description softening live in ./tool-schemas so they
// stay testable without this module's import-time side effects.

// Drop Claude Code's router/meta tools — these dispatch internally and have no
// callable backing the model can usefully target (Copilot would pick them for
// bare-word prompts and stall). Everything else — MCP tools AND Claude Code's
// real built-ins (Bash, Read, Edit, Write, Glob, Grep, Web*, Notebook*, Task*)
// — is preserved so Copilot can emit tool_use calls the client executes.
const CLAUDE_CODE_ROUTER_TOOLS = new Set([
  "Skill",
  "Agent",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "ScheduleWakeup",
  "ShareOnboardingGuide",
  "Monitor",
  "PushNotification",
  "RemoteTrigger",
]);

function filterMcpTools(tools?: any[]): any[] | undefined {
  if (!Array.isArray(tools)) return tools;
  return tools.filter((t: any) => {
    const name = t?.name ?? t?.function?.name;
    if (typeof name !== "string" || !name) return false;
    return !CLAUDE_CODE_ROUTER_TOOLS.has(name);
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
  if (merged?.length) {
    // Re-insert so the Map's insertion order tracks recency, then cap its size.
    sessionTools.delete(sessionKey);
    sessionTools.set(sessionKey, merged);
    if (sessionTools.size > MAX_REMEMBERED_TOOL_SESSIONS) {
      sessionTools.delete(sessionTools.keys().next().value as string);
    }
    // Update server-wide fallback whenever we see a non-empty MCP tool set.
    const mcpOnly = merged.filter((t: any) => {
      const name = t?.name ?? t?.function?.name ?? "";
      return name.includes("___");
    });
    if (mcpOnly.length) globalMcpTools = merged;
  }
}

function toolsForSession(sessionKey: string, tools?: any[]): any[] | undefined {
  return mergeTools(sessionTools.get(sessionKey), tools);
}

function canonicalizeToolUseText(text: string, tools?: any[]): string {
  const aliases = aliasMapForTools(tools);
  if (!aliases.size || !text.includes('"tool_use"')) return text;
  const lowerAliases = new Map<string, string>();
  for (const [alias, canonical] of aliases) {
    const key = alias.toLowerCase();
    if (!lowerAliases.has(key)) lowerAliases.set(key, canonical);
  }
  let isToolName = true;
  return text.replace(/"name"\s*:\s*"([^"]+)"/g, (match, rawName) => {
    const first = isToolName;
    isToolName = false;
    const stripped = rawName.replace(/^_+/, "");
    // Case-insensitive matching is confined to the tool_use name itself (the
    // first "name" field): models emitting native XML markup routinely
    // lowercase it (`bash` → `Bash`). Applying it to nested input fields would
    // rewrite ordinary argument values that happen to look like tool names.
    const canonicalName =
      aliases.get(rawName) ??
      aliases.get(stripped) ??
      (first ? lowerAliases.get(stripped.toLowerCase()) : undefined);
    return canonicalName ? `"name":"${canonicalName}"` : match;
  });
}

// Hit counters for the truncated-JSON repair path. Purely diagnostic: if
// `repaired` stays 0 across real traffic, `repairTruncatedJson` is dead code
// and the tidy step can collapse to fence-stripping.
const repairStats = { repaired: 0, unrepairable: 0 };

// Thin instrumented wrapper over the pure transform in tool-use-text.ts.
// The decision logic lives there (and is unit-tested there); this only counts
// and logs which branch ran.
function tidyToolUseJson(text: string): string {
  const { text: tidied, outcome } = tidyToolUseJsonDetailed(text);
  if (outcome === "repaired") {
    repairStats.repaired++;
    logger.log(`🩺 tidyToolUseJson repaired truncated JSON (hit #${repairStats.repaired}, +${tidied.length - text.length} chars): ${text.slice(-120)}`);
  } else if (outcome === "unrepairable") {
    repairStats.unrepairable++;
    logger.log(`🩺 tidyToolUseJson could NOT repair (miss #${repairStats.unrepairable}): ${text.slice(0, 160)}`);
  }
  return tidied;
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

// Bring an existing entry in line with this request's tools and model. Also run on
// an entry that a concurrent request created: it was built for THAT request's
// tools and model, which may differ from ours.
function syncEntry(existing: SessionEntry, tools: any[] | undefined, fp: string, requestedModel: string): boolean {
  const sessionKey = existing.sessionKey;

  // A resumed or tool-less session holds only the tools it was opened with, so a
  // later request that carries more (Bash, Read, ...) would find them missing.
  // tools.set replaces the list in place, keeping the conversation. Queued like
  // setModel so it lands before the send that needs the tools.
  const toolsChanged = !!tools?.length && existing.toolFingerprint !== fp;
  if (toolsChanged) {
    existing.queue = existing.queue.then(
      async () => {
        // Rechecked when it runs: an earlier queued request may already have
        // declared this same set.
        if (existing.toolFingerprint === fp) return;
        const from = existing.toolFingerprint;
        try {
          await existing.session.rpc.tools.set({ tools: toExternalTools(tools) });
          existing.toolFingerprint = fp;
          logger.log(`🔧 Tools re-declared for ${sessionKey} (${from} → ${fp}, ${tools.length} tools)`);
        } catch (err: any) {
          // Some runtimes do not implement tools.set. Keeping the session would
          // leave the model without tools and the server-mode prompt, so drop it:
          // getOrCreateEntry recreates it with the tools declared at creation.
          logger.log(`⚠️ tools.set failed for ${sessionKey}: ${err?.message ?? err}`);
          invalidateSession(existing, "tools.set failed");
        }
      },
      (err) => logger.log(`⚠️ Prior queue error before tools.set for ${sessionKey}: ${err?.message ?? err}`)
    );
  }

  // Model switch on an existing session: the SDK supports session.setModel() —
  // takes effect for the NEXT message, conversation history preserved (mirrors
  // the official copilot CLI's /model command). Enqueue the switch onto the
  // session's serialization queue so concurrent requests with different models
  // don't race: each setModel runs atomically with the send that asked for it.
  if (existing.model !== requestedModel) {
    const targetModel = requestedModel;
    existing.queue = existing.queue.then(
      async () => {
        const prev = existing.model;
        if (prev === targetModel) return;
        try {
          await existing.session.setModel(targetModel);
          existing.model = targetModel;
          logger.log(`🔀 Model switched for ${sessionKey}: ${prev} → ${targetModel}`);
        } catch (err: any) {
          // Don't update entry.model — keep it pointing at the still-active
          // model on the SDK side. Surface the failure so callers see why
          // their /model command appears to have done nothing.
          logger.log(
            `⚠️ setModel failed for ${sessionKey} (${prev} → ${targetModel}): ${err?.message ?? err}`
          );
        }
      },
      (err) => logger.log(`⚠️ Prior queue error before setModel for ${sessionKey}: ${err?.message ?? err}`)
    );
  }
  return toolsChanged;
}

async function getOrCreateEntry(sessionKey: string, tools?: any[], model?: string): Promise<SessionEntry> {
  const fp = toolFingerprint(tools);
  const requestedModel = model ?? DEFAULT_MODEL;
  const existing = sessions.get(sessionKey);
  if (existing) {
    const toolsChanged = syncEntry(existing, tools, fp, requestedModel);
    if (!toolsChanged) return existing;
    // Wait for tools.set to land: if it failed the entry is disposed, and this
    // request must run on a recreated session that really holds its tools.
    await existing.queue;
    return existing.disposed ? getOrCreateEntry(sessionKey, tools, model) : existing;
  }

  // Deduplicate concurrent creation for the same key
  let creating = sessionCreating.get(sessionKey);
  const joined = !!creating;
  if (!creating) {
    // Tools are declared natively to the SDK, so no inline-JSON prefix is injected.
    // With tools present the system prompt is replaced by a server-mode one: the
    // default describes built-ins this session cannot expose. Without tools the
    // default is kept, so a plain conversational turn still gets normal framing.
    const toolPrefix = tools?.length ? serverModeSystemPrompt() : "";
    // Pass model through so the session uses the client-requested model, not the SDK default.
    // Pass sessionId so the SDK's create/resume logic keys on the proxy's sessionKey —
    // enabling crash recovery via client.getSessionMetadata + client.resumeSession.
    const sessionOpts: {
      denyAllTools: true;
      systemPromptMode?: "replace";
      model: string;
      sessionId: string;
      externalTools?: any[];
    } = tools?.length
      ? {
          denyAllTools: true,
          systemPromptMode: "replace",
          model: requestedModel,
          sessionId: sessionKey,
          externalTools: toExternalTools(tools),
        }
      : { denyAllTools: true, model: requestedModel, sessionId: sessionKey };
    creating = ensureClientStarted()
      .then(() => initSession(toolPrefix, sessionOpts))
      .then(({ session, resumed }) => {
        // A client restart may have cleared the registry while this create was in
        // flight (restartClient wipes sessionCreating + sessions). The session we
        // just built is bound to the OLD client — re-inserting it would poison the
        // fresh map with a dead pipe. The .finally below already guards its own
        // cleanup with the identity check; this guards the insertion the same way.
        if (sessionCreating.get(sessionKey) !== creating) {
          disposeSession(session);
          throw new Error("stale session creation after client restart");
        }
        const entry: SessionEntry = {
          session,
          queue: Promise.resolve(),
          toolFingerprint: fp,
          model: requestedModel,
          sessionKey,
          native: createNativeSessionState(),
          consecutiveAbnormalTurns: 0,
          disposed: false,
          activeLegs: 0,
          lastUsed: Date.now(),
        };
        sessions.set(sessionKey, entry);
        logger.log(
          `🆕 Session ${resumed ? "resumed" : "created"}: ${sessionKey} model=${requestedModel} fp=${fp}` +
            `${tools?.length ? ` (${tools.length} tools)` : " (no tools)"}`
        );
        // No synthetic /clear turn on fresh create: a new session is already empty, and
        // the SDK forwards "/clear" to the model as a real user message. Non-claude models
        // (gpt-5.6-terra) then anchor on it and answer later turns with "Context cleared."
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
  const entry = await creating;
  // Joined an in-flight create: it was built for the first request's tools and
  // model, so reconcile with ours.
  if (joined && syncEntry(entry, tools, fp, requestedModel)) {
    await entry.queue;
    if (entry.disposed) return getOrCreateEntry(sessionKey, tools, model);
  }
  return entry;
}

// ─────────────────────────────────────────────────────────────
// Model list cache
// ─────────────────────────────────────────────────────────────
let cachedModels: any[] | null = null;

// ─────────────────────────────────────────────────────────────
// Client lifecycle: start latch + process-level failure strikes
// ─────────────────────────────────────────────────────────────
// `clientStarted` used to be a one-way latch, which made ensureClientStarted a
// permanent no-op after the first request. When the CLI process died or wedged, no
// code path could ever respawn it: session-level recovery kept re-creating sessions
// on the same dead stdio pipe until an operator restarted the proxy. The latch is now
// cleared by restartClient, so recovery reaches the process layer too.
const clientStartLatch = new StartLatch();
const clientStrikes = new ClientStrikeCounter();

// Concurrent requests share one in-flight start: without this, N requests arriving
// before the first start resolves would each call client.start() on the same client.
async function ensureClientStarted(): Promise<void> {
  await clientStartLatch.run(() => client.start());
}

// A turn completed without a transport-level failure: the pipe is proven healthy, so
// forgive any earlier strike.
function noteClientHealthy(): void {
  clientStrikes.healthy();
}

// Tear down the CLI process and every session bound to it. Sessions are dropped here
// rather than left for invalidateSession because they are ALL dead once the underlying
// pipe is replaced — resuming them would reattach to a client that no longer exists.
// On-disk session state survives, so the next request resumes conversations normally
// via getSessionMetadata → resumeSession.
function restartClient(reason: string): void {
  clientStartLatch.reset();
  clientStrikes.reset();
  cachedModels = null;
  for (const entry of sessions.values()) {
    entry.disposed = true;
    disposeSession(entry.session);
  }
  sessions.clear();
  sessionCreating.clear();
  resetClient(reason);
}

// Record a client-level failure (a rejected send, a transport error, a turn that timed
// out). Respawns the CLI once the failures prove consecutive. Returns true when a
// restart was performed, so callers can report it.
function noteClientFailure(reason: string): boolean {
  const shouldRestart = clientStrikes.failure();
  logger.log(
    `⚠️ client-level failure (${reason}) — ` +
      `${clientStrikes.count}/${CLIENT_FAILURES_BEFORE_RESTART} consecutive`
  );
  if (!shouldRestart) return false;
  restartClient(reason);
  return true;
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

function isJsonObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function estimateInputTokens(body: any): number {
  let chars = 0;
  const sys = body.system;
  if (typeof sys === "string") chars += sys.length;
  else if (Array.isArray(sys))
    for (const b of sys) chars += b?.text?.length ?? 0;
  for (const msg of body.messages ?? []) {
    const content = msg?.content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text") chars += b.text?.length ?? 0;
        else if (b?.type === "tool_use")
          chars += JSON.stringify(b.input ?? {}).length;
        else if (b?.type === "tool_result") {
          if (typeof b.content === "string") chars += b.content.length;
          else if (Array.isArray(b.content))
            for (const c of b.content) chars += c?.text?.length ?? 0;
        }
      }
    }
  }
  for (const tool of body.tools ?? []) chars += JSON.stringify(tool).length;
  return Math.round(chars / 4);
}

// Same chars/4 heuristic as estimateInputTokens. The SDK reports no token counts
// for a native leg, so clients that read `usage` get an estimate, not zeros.
function estimateUsage(body: any, outputChars: number) {
  const promptTokens = estimateInputTokens(body);
  const completionTokens = Math.round(outputChars / 4);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function nativeResultChars(result: FinishedLegResult): number {
  if (result.kind === "text") return result.content.length;
  return result.calls.reduce((sum, call) => sum + call.name.length + call.arguments.length, 0);
}

// The OpenAI Chat Completions `image_url` content part accepts an image in
// three ways (per their vision docs): a fully-qualified HTTP(S) URL, a
// Base64-encoded data URL, or a Files API file id. See ./image-attachment.

async function extractPromptInput(message: any): Promise<PromptInput> {
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
      const attachment = await imageUrlToAttachment(url);
      if (!attachment) return { prompt: "", error: "Unsupported image_url — expected a base64 data URL or an HTTP(S) image URL" };
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

interface ToolCallRef {
  index: number;
  name: string;
  input: unknown;
}

function parseToolArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  if (!args.trim()) return {};
  try { return JSON.parse(args); } catch { return args; }
}

// Locate the assistant tool call for a tool_use_id / tool_call_id. Handles both
// Anthropic shape (assistant.content[] with type: "tool_use") and OpenAI shape
// (assistant.tool_calls[] with id + function.name/arguments).
function findToolCall(messages: any[], toolCallId: string): ToolCallRef | undefined {
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    if (msg?.role !== "assistant") continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "tool_use" && block.id === toolCallId) {
          return { index, name: block.name ?? toolCallId, input: block.input };
        }
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id === toolCallId) {
          return {
            index,
            name: tc.function?.name ?? tc.name ?? toolCallId,
            input: parseToolArguments(tc.function?.arguments),
          };
        }
      }
    }
  }
  return undefined;
}

const MAX_PROMPT_CHARS = 200;

function userMessageText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && !String(b.text ?? "").trimStart().startsWith("<system-reminder>"))
    .map((b: any) => b.text)
    .join("\n");
}

function findOriginatingUserPrompt(messages: any[], callIdx: number): string {
  // Walk back from the assistant turn holding this call to the nearest user text.
  for (let i = callIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const trimmed = userMessageText(m.content).trim();
    if (trimmed) return Array.from(trimmed).slice(0, MAX_PROMPT_CHARS).join("");
  }
  return "";
}

// Some tool results arrive without the Copilot session having seen the tool_use:
// calls synthesized by the mcp-qdrant proxy (hero deploy, MCP warmup) and native
// Claude Code CLI ToolSearch calls. Such results look unsolicited, so re-state which
// call was made and why. When SYNTHETIC_TOOL_ID_SECRET is shared with mcp-qdrant,
// synthetic IDs must carry a valid HMAC.
function syntheticCallPreamble(messages: any[], toolId: string, call: ToolCallRef | undefined): string {
  // ToolSearch is a native Claude Code CLI tool, so its calls carry non-synthetic IDs
  // and cannot pass the HMAC check. The name match is not a trust boundary (the model
  // controls it); it only exempts ToolSearch from the ID check. All other calls stay strict.
  const isCliToolSearch = call?.name === "ToolSearch";
  if (!call || (!isCliToolSearch && !isTrustedSyntheticToolId(toolId))) return "";

  const userPrompt = findOriginatingUserPrompt(messages, call.index);
  const input = call.input === undefined ? "" : JSON.stringify(call.input);
  return (
    `[Context: you called ${call.name}(${input})` +
    (userPrompt ? ` in response to the user's message: ${JSON.stringify(userPrompt)}` : "") +
    `. This result answers that call.]\n`
  );
}

function formatToolResultLine(messages: any[], toolId: string, content: any): string {
  const call = findToolCall(messages, toolId);
  const name = call?.name ?? toolId;
  let formatted = toolMessageText(content);
  // Slim Counter ExecuteMethod results: remove the all-methods registry chunk
  // so the Copilot model presents only the current hero's methods (from the
  // _Counter__Deploy conversation history) instead of the full system method list.
  if (name.includes("ExecuteMethod")) formatted = slimCounterResult(formatted);
  return `${syntheticCallPreamble(messages, toolId, call)}[Tool result for ${name}]: ${formatted}`;
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
    usage: estimateUsage(body, 0),
  };
}

async function extractLastTurn(messages: any[]): Promise<PromptInput> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg?.role === "tool") {
      return { prompt: formatOpenAIToolBlock(messages, i) };
    }

    if (msg?.role !== "user") continue;

    const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
    const toolResultBlocks = blocks.filter((b: any) => b?.type === "tool_result");
    const otherBlocks = blocks.filter((b: any) => b?.type !== "tool_result");

    if (!toolResultBlocks.length) return await extractPromptInput(msg);

    const toolResultLines = toolResultBlocks.map((block: any) =>
      formatToolResultLine(messages, block.tool_use_id, block.content)
    );

    if (!otherBlocks.length) {
      return { prompt: toolResultLines.join("\n") };
    }

    const base = await extractPromptInput({ ...msg, content: otherBlocks });
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

function sseOpenAIFinish(
  id: string,
  model: string,
  reason: "stop" | "tool_calls" | "length" = "stop"
): Uint8Array {
  return sseChunk(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
    })
  );
}

function newToolCallId(): string {
  return `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ─────────────────────────────────────────────────────────────
// Nudge turn: recover a tool call the model narrated but never emitted.
// Serialised through entry.queue so it never overlaps another turn.
// ─────────────────────────────────────────────────────────────

// Chain one leg onto the session queue and count it while it is queued or running.
// The count drops in a handler attached before the caller's await, so by the time
// the caller answers its client the leg is no longer counted: the client's next
// request must not be mistaken for one that overlaps it.
function queueLeg<T>(entry: SessionEntry, run: () => Promise<T>): Promise<T> {
  entry.activeLegs++;
  entry.lastUsed = Date.now();
  const leg = entry.queue.then(run);
  const done = () => {
    entry.activeLegs--;
    entry.lastUsed = Date.now();
  };
  leg.then(done, done);
  // Failures are surfaced by the caller awaiting `leg`; the queue itself must
  // never stay rejected or every later request on this session dies with it.
  entry.queue = leg.then(() => undefined, () => undefined);
  return leg;
}

// Run one nudge turn through the native leg machinery. The nudge must not use a
// text-only driver: every tool call in server mode arrives as
// external_tool.requested, and a driver without a handler for it leaves the
// runtime waiting for an answer nobody will send — the turn never ends, and the
// session stays busy forever, so even a later resume hangs. runNativeLeg records
// the call in `pending` and returns it to the client, which is exactly what the
// nudge is asking the model to produce.
async function nudgeLeg(
  entry: SessionEntry,
  prompt: string,
  signal?: AbortSignal
): Promise<FinishedLegResult | null> {
  const session = entry.session as any;
  const leg = queueLeg(entry, () => {
    assertLive(entry);
    return runNativeLeg(session, entry.native.pending, () => session.send({ prompt }), {
      orphans: entry.native.orphans,
      signal,
    });
  });
  try {
    const result = await leg;
    // The client gave up on the response: nothing to salvage, and the calls the
    // model asked for were refused on arrival by runNativeLeg.
    return result.kind === "aborted" ? null : result;
  } catch (err: any) {
    if (err instanceof SessionReplacedError) throw err;
    // The nudge runs inside another request's response, so it answers to the same
    // recovery rules: strike the client and drop the entry for the next resume.
    const restarted = noteClientFailure(`nudge failed: ${err?.message ?? err}`);
    if (!restarted) invalidateSession(entry, "nudge failed");
    throw err;
  }
}

// SSE keepalive: comment lines (begin with ":") are ignored by clients but
// keep intermediate proxies from closing the connection during the long quiet
// stretch of a native leg (the model digesting a huge tool result, or a turn
// that produces no delta until it has finished).
const SSE_KEEPALIVE_MS = 15_000;
const sseKeepalive = encoder.encode(": keepalive\n\n");

// Drop the in-memory entry so the next request for this sessionKey re-probes via
// getSessionMetadata → resumeSession (or creates fresh if the on-disk state is
// also gone). Shared by the session.error handlers and the abnormal-turn paths:
// an abnormal turn is NOT a session.error — turn_end fires normally — so
// without this the poisoned entry stays cached and every following turn
// degrades.
function invalidateSession(entry: SessionEntry, reason: string): void {
  if (sessions.get(entry.sessionKey) === entry) sessions.delete(entry.sessionKey);
  entry.disposed = true;
  disposeSession(entry.session);
  logger.log(`🩹 Invalidated entry for ${entry.sessionKey} on ${reason} — next turn will auto-resume`);
}

// Drop a session that is no longer needed, without the failure framing of
// invalidateSession. The SDK keeps its on-disk state, so a later request on the
// same key resumes it; side sessions use a unique key and are never resumed.
function releaseSession(entry: SessionEntry, why: string): void {
  if (sessions.get(entry.sessionKey) === entry) sessions.delete(entry.sessionKey);
  // sessionTools is deliberately kept: it is how a later title/summary one-shot
  // recognises a tool conversation whose session was only idle-evicted.
  entry.disposed = true;
  disposeSession(entry.session);
  logger.log(`🧹 Released ${entry.sessionKey} (${why})`);
}

// Sessions are otherwise dropped only on failure, so every conversation that
// ever connected stays in memory. A session with a leg queued, or calls parked
// for the client, is in use however long ago it was touched.
const SESSION_IDLE_TTL_MS = 30 * 60_000;
const SESSION_SWEEP_MS = 60_000;

export function evictIdleSessions(now: number = Date.now(), ttlMs: number = SESSION_IDLE_TTL_MS): number {
  let evicted = 0;
  for (const entry of [...sessions.values()]) {
    const inUse = entry.activeLegs > 0 || entry.native.pending.size > 0;
    if (inUse || now - entry.lastUsed < ttlMs) continue;
    releaseSession(entry, `idle ${Math.round((now - entry.lastUsed) / 1000)}s`);
    evicted++;
  }
  return evicted;
}

// unref: the sweep must never keep the process alive on its own.
setInterval(() => evictIdleSessions(), SESSION_SWEEP_MS).unref?.();

// A request that waited in the queue found its session already replaced. This is
// the earlier request's failure, not a new client fault, so it earns no strike.
export class SessionReplacedError extends Error {
  constructor(sessionKey: string) {
    super(`session ${sessionKey} was replaced while this request waited; retry it`);
  }
}

function assertLive(entry: SessionEntry): void {
  if (entry.disposed) throw new SessionReplacedError(entry.sessionKey);
}

// Release an SDK session we are dropping. abort() first: a turn left waiting on
// an answer nobody will send keeps the runtime session busy forever, and the next
// resume would reattach to that busy turn instead of restoring it — the request
// then hangs with no events until the leg timeout. disconnect() detaches the
// object; dispose() is the 0.1.x equivalent and only runs when it exists.
// Best-effort: the session is usually already broken, and a throw here must not
// mask the original failure that caused the invalidation.
function disposeSession(session: CopilotSession): void {
  const lifecycle = session as SdkLifecycle;
  void (async () => {
    try {
      await lifecycle.abort?.();
    } catch {
      // Turn already gone or transport dead — nothing to abort.
    }
    try {
      if (lifecycle.disconnect) await lifecycle.disconnect();
      else if (lifecycle.dispose) await Promise.resolve(lifecycle.dispose());
    } catch {
      // Already gone — nothing to release.
    }
  })();
}

// How many consecutive abnormal turns a session may produce before it is
// treated as stuck and discarded. One abnormal turn is often a transient blip
// and the downstream proxy retries it on the same session; a second one means
// the session itself is poisoned and only a fresh resume can recover it.
const ABNORMAL_TURNS_BEFORE_INVALIDATE = 2;

// Record the outcome of a finished turn. An ABNORMAL turn advances the strike
// count and, once the session proves it is stuck, drops the entry so the next
// request re-probes via getSessionMetadata → resumeSession. Any healthy turn
// clears the count — strikes must be CONSECUTIVE to mean anything.
//
// "Abnormal" is deliberately wider than "empty". A session that degrades into
// short, truncated turns never produced a literally empty one, so the old
// empty-only detector reset the count every turn and the poisoned entry stayed
// cached until the operator restarted the whole server. Truncation (a runaway
// trip) counts as a strike for the same reason: a healthy session does not
// repeatedly run away.
//
// Pure stream-turn decision behind recordTurnOutcome's "abnormal" input,
// exported for tests. A tool call is itself content, so only truncation makes
// it abnormal; any other turn is abnormal when it produced no text or was
// truncated.
export const isAbnormalStreamTurn = (facts: {
  hasToolCall: boolean;
  content: string;
  truncated: boolean;
}): boolean => facts.truncated || (!facts.hasToolCall && !facts.content.trim());

function recordTurnOutcome(entry: SessionEntry, abnormal: boolean, where: string): void {
  if (!abnormal) {
    entry.consecutiveAbnormalTurns = 0;
    return;
  }
  entry.consecutiveAbnormalTurns++;
  logger.log(
    `⚠️ upstream turn ended abnormally (${where}) — ` +
      `${entry.consecutiveAbnormalTurns}/${ABNORMAL_TURNS_BEFORE_INVALIDATE} consecutive`
  );
  if (entry.consecutiveAbnormalTurns >= ABNORMAL_TURNS_BEFORE_INVALIDATE) {
    invalidateSession(entry, "consecutive abnormal turns");
  }
}

/**
 * Nudge the model once for the tool_use literal it announced but never emitted,
 * then read the call back out of its reply. `run` is supplied by the caller
 * because queueing belongs to the caller's position: see nudgeLeg.
 * Returns null when the nudge yields no call — the nudge reply passes the
 * same validator gate as the turn, so a literal it rejects stays rejected.
 */
const nudgeForToolCall = async (
  label: string,
  content: string,
  schemas: XmlToolSchemas,
  tools: any[] | undefined,
  run: (prompt: string) => Promise<FinishedLegResult | null>
): Promise<{ id?: string; name: string; arguments: string } | null> => {
  logger.log(`🔔 Unfulfilled tool intent${label}, nudging once: ${content.slice(0, 120)}`);
  try {
    const nudged = await run(TOOL_NUDGE_PROMPT);
    if (!nudged) {
      logger.log(`🔔 Nudge${label} aborted by the client`);
      return null;
    }
    if (nudged.kind === "tool_calls") {
      // The nudge did its job natively: the model emitted the call itself, so
      // there is no literal to parse out of prose. Keep the SDK's toolCallId —
      // it is the key the call is parked under, and the client sends it back.
      const call = nudged.calls[0];
      logger.log(`🔔 Nudge${label} produced ${call ? call.name : "no call"} (native)`);
      return call ?? null;
    }
    const nudgedContent = canonicalizeToolUseText(tidyToolUseJson(xmlToolUseToJson(nudged.content, schemas)), tools);
    const tu = extractInlineToolUse(nudgedContent, salvageValidator(nudged.content, schemas));
    logger.log(`🔔 Nudge${label} ${tu ? "produced " + tu.name : "produced no call"}`);
    return tu;
  } catch (err: any) {
    logger.log(`⚠️ Nudge failed: ${err?.message ?? err}`);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────

export function formatTokenPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}/M`;
}

async function modelsHandler(c: Context) {
  try {
    const models = await getModels();
    return c.json({
      object: "list",
      data: models.map((m: any) => {
        const tp = m.billing?.tokenPrices;
        const pricing = tp?.inputPrice != null
          ? {
              input: formatTokenPrice(tp.inputPrice),
              output: formatTokenPrice(tp.outputPrice),
              ...(tp.cachePrice ? { cache: formatTokenPrice(tp.cachePrice) } : {}),
            }
          : undefined;
        return {
          id: m.id,
          object: "model",
          owned_by: "github-copilot",
          ...(pricing && { pricing }),
        };
      }),
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
  if (!isJsonObject(body)) return c.json({ error: { message: "Request body must be a JSON object" } }, 400);
  return c.json({ input_tokens: estimateInputTokens(body) });
}

/**
 * Recover a tool call the model wrote as text (inline JSON or XML markup) and
 * trim runaway output. Native legs usually need none of this; it stays as the
 * safety net for models that narrate a call instead of emitting one.
 */
async function salvageTextLeg(
  entry: SessionEntry,
  text: string,
  tools?: any[],
  signal?: AbortSignal
): Promise<{ result: FinishedLegResult; truncated: boolean }> {
  const schemas = buildXmlToolSchemas(tools);
  const verdict = detectRunaway(text);
  if (verdict) logger.log(`✂️ ${describeRunaway(verdict)}`);
  const truncated = !!verdict;
  const raw = verdict ? text.slice(0, verdict.keepLength) : text;
  const normalized = xmlToolUseToJson(raw, schemas);
  const content = canonicalizeToolUseText(tidyToolUseJson(normalized), tools);
  let tu: { id?: string; name: string; arguments: string } | null =
    extractInlineToolUse(content, salvageValidator(raw, schemas));
  if (shouldNudgeToolIntent({ hasCall: !!tu, truncated, tools, content })) {
    tu = await nudgeForToolCall(" (native)", content, schemas, tools, (p) => nudgeLeg(entry, p, signal));
  }
  return {
    result: tu
      ? { kind: "tool_calls", calls: [{ id: tu.id ?? newToolCallId(), name: tu.name, arguments: tu.arguments }] }
      : { kind: "text", content: canonicalizeToolUseText(normalized, tools) },
    truncated,
  };
}

// Native mode: either answer the parked calls with the request's role:"tool"
// messages or send the user prompt, then run until the model asks for tools
// again or finishes. Serialised on the session queue like any turn.
async function completeNative(
  entry: SessionEntry,
  messages: any[],
  prompt: string,
  attachments: BlobAttachment[] | undefined,
  completionId: string,
  model: string,
  body: any,
  tools?: any[],
  signal?: AbortSignal
) {
  const { pending: parked, orphans } = entry.native;
  const trailing = trailingToolResults(messages);
  const results = trailing.filter((r) => parked.has(r.toolCallId));
  // Filtered out before answerToolResults, so its own `unknown` can never fire for
  // these: report them here instead of dropping them silently.
  const unparked = trailing.filter((r) => !parked.has(r.toolCallId));
  if (unparked.length) {
    logger.log(`⚠️ native: ignoring results for unparked tool_call_ids ${unparked.map((r) => r.toolCallId).join(",")}`);
  }
  const session = entry.session as any;
  const answerOrSend = results.length
    ? async () => {
        const { unknown, abandoned } = await answerToolResults(session, parked, results);
        if (unknown.length) logger.log(`⚠️ native: unknown tool_call_ids ${unknown.join(",")}`);
        if (abandoned) logger.log(`🧹 native: refused ${abandoned} unanswered calls in a partial batch`);
      }
    : async () => {
        // A prompt while calls are still parked means the client abandoned them
        // (cancelled tool, new question). Answer them first — sending into a
        // turn that is waiting on a tool result would leave it busy forever.
        const abandoned = await abandonPendingCalls(session, parked);
        if (abandoned) logger.log(`🧹 native: abandoned ${abandoned} parked calls before new prompt`);
        await session.send(attachments?.length ? { prompt, attachments } : { prompt });
      };

  // Runs inside the leg, after its listener is attached: answering an orphan
  // resumes the model's turn, and those events must not be missed.
  const start = async () => {
    const drained = await drainOrphanedCalls(session, parked, orphans);
    if (drained) logger.log(`🧹 native: answered ${drained} late calls from the previous leg`);
    return answerOrSend();
  };

  const leg = queueLeg(entry, () => {
    assertLive(entry);
    return runNativeLeg(session, parked, start, {
      quietMs: PARALLEL_CALL_QUIET_MS,
      answering: results.length > 0,
      orphans,
      signal,
    });
  });
  let result: Awaited<typeof leg>;
  try {
    result = await leg;
  } catch (err: any) {
    if (err instanceof SessionReplacedError) throw err;
    // Same recovery as nudgeLeg: strike the client and drop the entry so the
    // next request re-probes via resume instead of reusing a broken session.
    const restarted = noteClientFailure(`native leg failed: ${err?.message ?? err}`);
    if (!restarted) invalidateSession(entry, "native leg failed");
    throw err;
  }
  if (result.kind === "aborted") {
    // Client is gone: no strike and no invalidation — the session is intact.
    logger.log("⏹ native leg aborted by the client — remaining calls refused");
    return emptyCompletion(completionId, model, body);
  }
  noteClientHealthy();

  // A model can still narrate a call as text. Reuse the existing salvage
  // pipeline so such turns surface as tool_calls instead of prose.
  let truncated = false;
  if (result.kind === "text") {
    // `tools` is the set this request resolved (including the server-wide
    // fallback). Re-deriving it from the session registry would come back
    // empty in exactly that fallback case, silently disabling the salvage.
    ({ result, truncated } = await salvageTextLeg(entry, result.content, tools, signal));
  }

  recordTurnOutcome(
    entry,
    isAbnormalStreamTurn({
      hasToolCall: result.kind === "tool_calls",
      content: result.kind === "text" ? result.content : "",
      truncated,
    }),
    "native"
  );
  logger.log(
    `🧩 native leg (${results.length ? `${results.length} results` : "prompt"}) → ` +
      (result.kind === "tool_calls" ? `${result.calls.length} tool_calls` : "text")
  );

  const message =
    result.kind === "tool_calls"
      ? {
          role: "assistant",
          content: null,
          tool_calls: result.calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : { role: "assistant", content: result.content };
  return {
    id: completionId,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message, finish_reason: nativeFinishReason(result.kind, truncated) }],
    usage: estimateUsage(body, nativeResultChars(result)),
  };
}

// Stream path: native legs resolve as a whole. Open the SSE response at once,
// send keepalive comments while the leg runs so intermediate proxies do not
// drop a long quiet turn, then replay the finished completion as frames.
// A failed leg still ends with finish_reason "length" + [DONE] so the client
// sees a terminated stream it can retry, never a bare close.
export function streamCompletion(
  pending: Promise<any>,
  id: string,
  model: string,
  onCancel?: () => void
): ReadableStream<Uint8Array> {
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
  };
  return new ReadableStream({
    start(controller) {
      const send = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk);
        } catch {
          stop(); // consumer gone
        }
      };
      keepalive = setInterval(() => send(sseKeepalive), SSE_KEEPALIVE_MS);
      pending
        .then((completion) => {
          for (const f of completionFrames(completion)) send(f);
        })
        .catch((err: any) => {
          if (err instanceof SessionReplacedError) {
            // The 200 is already sent, so the 503 the JSON path returns is not
            // available: an error frame is how a stream client learns to retry.
            logger.log(`🔁 ${err.message}`);
            send(sseChunk(JSON.stringify({ error: { message: err.message, type: "session_replaced" } })));
          } else {
            logger.error(`Server stream error: ${err?.message ?? err}`);
          }
          send(sseOpenAIFinish(id, model, "length"));
          send(encoder.encode("data: [DONE]\n\n"));
        })
        .finally(() => {
          stop();
          try {
            controller.close();
          } catch {}
        });
    },
    // A cancelled consumer means the client is gone: stop the keepalive and
    // let the leg resolve as aborted so its calls are refused, not parked.
    cancel: () => {
      onCancel?.();
      stop();
    },
  });
}

export function completionFrames(completion: any): Uint8Array[] {
  const { id, model } = completion;
  const choice = completion.choices[0];
  const frames: Uint8Array[] = [];
  const toolCalls = choice.message.tool_calls as any[] | undefined;
  if (toolCalls?.length) {
    frames.push(
      sseChunk(
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model,
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })),
            },
            finish_reason: null,
          }],
        })
      )
    );
  } else if (choice.message.content) {
    frames.push(sseOpenAIDelta(id, model, choice.message.content));
  }
  frames.push(sseOpenAIFinish(id, model, choice.finish_reason));
  frames.push(encoder.encode("data: [DONE]\n\n"));
  return frames;
}

async function completionsHandler(c: Context) {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  if (!isJsonObject(body)) return c.json({ error: { message: "Request body must be a JSON object" } }, 400);
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    return c.json({ error: { message: "messages must be an array" } }, 400);
  }

  const rawTools = Array.isArray(body.tools) ? body.tools : undefined;
  const hadRawTools = !!rawTools?.length;
  const rawToolNames = (rawTools ?? []).slice(0, 8).map((t: any) => toolName(t) || "?");
  const rawMcpToolCount = (rawTools ?? []).filter((t: any) => toolName(t).includes("___")).length;
  const rawNonMcpToolNames = (rawTools ?? [])
    .map((t: any) => toolName(t) || "?")
    .filter((name: string) => !name.includes("___"))
    .slice(0, 8);
  const droppedToolNames = (rawTools ?? [])
    .map((t: any) => toolName(t) || "?")
    .filter((name: string) => CLAUDE_CODE_ROUTER_TOOLS.has(name))
    .slice(0, 8);

  // Strip non-MCP tools at the boundary so the rest of the pipeline (system
  // prompt builder, alias map, tool_calls extractor) only ever sees real MCP
  // tools. Claude Code's router built-ins are dispatched by Claude Code itself
  // and aren't ours to expose to the Copilot model.
  if (rawTools) body.tools = filterMcpTools(rawTools);
  const filteredToolNames = (body.tools ?? []).slice(0, 8).map((t: any) => toolName(t) || "?");

  const model = body.model ?? DEFAULT_MODEL;
  const completionId = `chatcmpl-${Date.now().toString(36)}`;

  // [diag] Log what the upstream proxy actually sends — remove once the sender
  // is stable.
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
  logger.log(`🔍 completions: model=${body.model ?? "<default>"} msgs=${msgs.length} rawTools=${rawTools?.length ?? 0} rawMcp=${rawMcpToolCount} [${rawToolNames.join(",")}] filteredTools=${body.tools?.length ?? 0} [${filteredToolNames.join(",")}] | nonMcp=[${rawNonMcpToolNames.join(",")}] dropped=[${droppedToolNames.join(",")}] | sys=${sysLen} | lastUser="${lastUserPreview}"`);

  // [diag-deep] When suspicious (no tools AND no system AND short last-user),
  // dump the full request body so we can pin down the upstream sender.
  const isSuspicious = (body.tools?.length ?? 0) === 0 && sysLen === 0 && (typeof lastUser?.content === "string") && lastUser.content.length < 30;
  if (isSuspicious) {
    try {
      logger.log(`🔍 dumped suspicious body to ${writeDiagnosticDump("suspicious", body)}`);
    } catch (e: any) {
      logger.log(`🔍 dump failed: ${e?.message ?? e}`);
    }
  }

  // Extract the latest turn — resolves tool_result blocks into formatted text so
  // the stateful Copilot session can continue after client-side tool execution.
  const messages: any[] = body.messages ?? [];
  const headerSessionId = c.req.header("x-session-id");
  // See isSideRequest for why this keys off remembered tools, not live legs or
  // a live session entry (which is created later than the tools are remembered).
  const toolConversation = !!headerSessionId && !!sessionTools.get(headerSessionId)?.length;
  const sideRequest = isSideRequest(headerSessionId, messages, body.tools, toolConversation);
  // A side request gets its own throwaway session: sharing one `side-<id>` key
  // made each title/summary prompt inherit the earlier ones' history, and the
  // entry was never released. Disposed once its response completes.
  const sessionKey = sideRequest && headerSessionId
    ? `${sideSessionKey(headerSessionId)}-${Math.random().toString(36).slice(2, 10)}`
    : resolveSessionKey(headerSessionId, messages);
  logger.log(
    `🔑 session: ${sessionKey}` +
      (sideRequest ? " (side request)" : headerSessionId ? " (from header)" : " (derived)")
  );
  const { prompt, attachments, error } = await extractLastTurn(messages);

  if (error) return c.json({ error: { message: error } }, 400);
  if (!prompt && !attachments?.length) return c.json({ error: { message: "No user message found" } }, 400);

  try {
    rememberSessionTools(sessionKey, body.tools);
    const sessionEffective = toolsForSession(sessionKey, body.tools);
    // Fall back to the server-wide last-seen MCP tool set only when the client sent
    // NO tools at all (hadRawTools=false). When the client explicitly sent tools but
    // they were all non-MCP (hadRawTools=true, sessionEffective empty), respect that
    // signal — the client is actively suppressing MCP tools for this turn.
    // A side request is a bare prompt for text (title, summary): giving it the
    // conversation's tools lets it call one the caller never offered.
    const effectiveTools = sideRequest
      ? undefined
      : sessionEffective?.length
        ? sessionEffective
        : (!hadRawTools && globalMcpTools?.length ? globalMcpTools : sessionEffective);
    logger.log(
      `🔧 tools: incomingMcp=${body.tools?.length ?? 0} remembered=${sessionTools.get(sessionKey)?.length ?? 0} ` +
        `effective=${effectiveTools?.length ?? 0} globalFallback=${!sessionEffective?.length && !hadRawTools && !!globalMcpTools} promptHasToolReminder=${containsToolReminder(prompt)}`
    );
    // Bare quota probe: always return empty — it's Claude Code's connectivity check,
    // never a real message. Filter unconditionally regardless of effectiveTools;
    // the original `&& !effectiveTools?.length` guard caused probes to slip through
    // on turn 2+ after globalMcpTools was populated by a prior tool-bearing turn.
    if (isBareQuotaProbe(prompt, hadRawTools, sysLen)) {
      logger.log("🔍 filtered bare quota probe");
      return c.json(emptyCompletion(completionId, model, body));
    }

    if (!effectiveTools?.length && containsToolReminder(prompt)) {
      // No MCP tools available for this session — fall through without native
      // tool declarations. The model responds in plain text so the caller isn't
      // left hanging on an empty completion. Dump kept for diagnostics only.
      try {
        const dumpPath = writeDiagnosticDump("missing-tools", body);
        logger.log(`🔍 no MCP tools for tool-reminder request — falling through (dumped to ${dumpPath})`);
      } catch (e: any) {
        logger.log(`🔍 missing-tools dump failed: ${e?.message ?? e}`);
      }
    }

    const entry = await getOrCreateEntry(sessionKey, effectiveTools, model);
    const effectivePrompt = withSystemPrompt(prompt, body.system);

    // Shared by the leg and the stream: cancelling the response aborts the leg.
    // The request's own signal covers a non-stream client that hangs up, which has
    // no stream to cancel.
    const disconnect = new AbortController();
    const onRequestAbort = () => disconnect.abort();
    const requestSignal = c.req.raw.signal;
    requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
    const pendingCompletion = completeNative(
      entry, messages, effectivePrompt, attachments, completionId, model, body, effectiveTools, disconnect.signal
    );
    const finished = () => {
      requestSignal?.removeEventListener("abort", onRequestAbort);
      if (sideRequest) releaseSession(entry, "side request finished");
    };
    pendingCompletion.then(finished, finished);
    if (body.stream) {
      return new Response(streamCompletion(pendingCompletion, completionId, model, () => disconnect.abort()), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }
    return c.json(await pendingCompletion);
  } catch (err: any) {
    if (err instanceof SessionReplacedError) {
      // The earlier request's failure, not a server fault: tell the client to retry.
      logger.log(`🔁 ${err.message}`);
      return c.json({ error: { message: err.message } }, 503, { "Retry-After": "1" });
    }
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
