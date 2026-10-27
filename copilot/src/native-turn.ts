// Native tool mode — the only path the proxy uses. A leg always resolves whole,
// so the streaming route replays the finished completion as SSE frames rather
// than forwarding deltas.
//
// Client tools are declared to the SDK without a handler, so each model call
// arrives as external_tool.requested and the turn stays open until we answer
// it with handlePendingToolCall. One OpenAI request therefore maps to one
// "leg" of a turn: it runs until the model either asks for tools (return them
// as tool_calls) or finishes (return text). The next request's role:"tool"
// messages resolve the parked calls and start the next leg. A client that stops
// reading aborts its leg; the calls the model still asks for are refused rather
// than parked, so the runtime is never left waiting on a response nobody reads.

import {
  isKnownToolCall,
  normalizeTools,
  type NormalizedTool,
} from "./tool-schemas";
import { findToolMarkupStart, type XmlToolSchemas } from "./tool-use-text";
import { mergeAssistantFrame } from "./turn-content";

export type NativeToolCall = { id: string; name: string; arguments: string };

// Client tools named like a runtime built-in must say they replace it, or the
// runtime treats the name as a clash and the tool never reaches the model.
const BUILTIN_CLASH_NAMES = new Set([
  "Bash",
  "Read",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
]);

// SDK declaration for one client tool — handler-less, per the module header.
export function toExternalTools(tools?: any[]): any[] {
  return normalizeTools(tools ?? []).map((t: NormalizedTool) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema ?? { type: "object", properties: {} },
    skipPermission: true,
    ...(BUILTIN_CLASH_NAMES.has(t.name) ? { overridesBuiltInTool: true } : {}),
    // The runtime defers external tools behind the built-in tool_search_tool
    // once the session holds more than ~30. That built-in is suppressed by
    // availableTools: ["custom:*"], so a deferred tool set would reach the model as no
    // tools at all. Keep every client tool pre-loaded.
    defer: "never" as const,
  }));
}

/** "length" marks a runaway cut short so it is never mistaken for a clean answer. */
export function nativeFinishReason(
  kind: "tool_calls" | "text",
  truncated: boolean
): "tool_calls" | "length" | "stop" {
  if (kind === "tool_calls") return "tool_calls";
  return truncated ? "length" : "stop";
}

/**
 * Validator for a salvaged call. Markup the model wrote as XML is accepted once
 * converted: the proxy may only have a partial tool list, so an unresolved name
 * or extra parameter must not turn a real call back into printable text. A
 * model-emitted JSON literal still faces the schema gate, which is what keeps a
 * quoted example out of execution.
 */
export function salvageValidator(raw: string, schemas: XmlToolSchemas) {
  return findToolMarkupStart(raw) === -1
    ? (name: string, input: Record<string, any>) =>
        isKnownToolCall(name, input, schemas)
    : undefined;
}

export type NativeLegResult =
  | { kind: "tool_calls"; calls: NativeToolCall[] }
  | { kind: "text"; content: string }
  | { kind: "aborted" };

// Parallel calls are emitted as separate events in quick succession; wait this
// long after the latest sign of call activity (a call or a tool-call delta)
// before returning the batch.
export const PARALLEL_CALL_QUIET_MS = 300;

const LEG_TIMEOUT_MS = 10 * 60_000;

// A call that lands just after the batch was returned can no longer be delivered
// to the client, and the runtime would wait on it forever. Keep listening this
// long, record whatever arrives, and answer it at the start of the next leg so
// the session never wedges.
const LATE_CALL_GRACE_MS = 2_000;

const ABANDONED_CALL_REASON = "The client stopped waiting for this tool call.";

const LATE_CALL_REASON =
  "This tool call arrived after its turn had already been returned to the client, so it was not executed. Retry it if it is still needed.";

type Session = {
  on: (fn: (event: any) => void) => () => void;
  send: (input: any) => Promise<unknown>;
  rpc: {
    tools: {
      handlePendingToolCall: (args: {
        requestId: string;
        result?: string;
        error?: string;
      }) => Promise<unknown>;
    };
  };
};

// toolCallId (returned to the client) → SDK requestId (needed to answer).
export type PendingCalls = Map<string, string>;

/** A call that arrived after its batch had been returned to the client. */
export type OrphanedCall = { toolCallId: string; requestId: string };

/** Everything one session needs to answer SDK tool requests across legs. */
export type NativeSessionState = {
  pending: PendingCalls;
  orphans: OrphanedCall[];
};

export function createNativeSessionState(): NativeSessionState {
  return { pending: new Map(), orphans: [] };
}

function stringifyArgs(args: unknown): string {
  if (typeof args === "string") return args;
  return JSON.stringify(args ?? {});
}

/** A leg that produced an outcome; an aborted leg never reaches salvage. */
export type FinishedLegResult = Exclude<NativeLegResult, { kind: "aborted" }>;

export type NativeLegOptions = {
  /** Quiet period after the latest sign of call activity before flushing. */
  quietMs?: number;
  /** True when `start` answers parked calls instead of sending a prompt. */
  answering?: boolean;
  /** Recorder for calls that arrive after the batch was returned. */
  orphans?: OrphanedCall[];
  /** The client stopped waiting: resolve at once, then drain late calls. */
  signal?: AbortSignal;
};

/**
 * Run one leg. `start` either sends a prompt or answers parked tool calls;
 * the listener is attached first so no event can be missed.
 */
export function runNativeLeg(
  session: Session,
  pending: PendingCalls,
  start: () => Promise<unknown>,
  {
    quietMs = PARALLEL_CALL_QUIET_MS,
    answering = false,
    orphans = [],
    signal,
  }: NativeLegOptions = {}
): Promise<NativeLegResult> {
  return new Promise((resolve, reject) => {
    const calls: NativeToolCall[] = [];
    let content = "";
    let settled = false;
    let aborted = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let released = false;
    let unsub: () => void = () => {};
    // Declared before `settle` can reach it — same ordering rule as runTurn.
    let legTimer: ReturnType<typeof setTimeout> | null = null;

    const release = () => {
      if (released) return;
      released = true;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
      signal?.removeEventListener("abort", abort);
      unsub();
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (legTimer) clearTimeout(legTimer);
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;
      fn();
    };
    const fail = (err: unknown) => {
      settle(() => reject(err));
      release();
    };
    const finishText = () => {
      settle(() => resolve({ kind: "text", content }));
      release();
    };
    const flushCalls = () => {
      settle(() => resolve({ kind: "tool_calls", calls }));
      // Keep listening briefly: calls of the same batch may still be in flight.
      // They can no longer be delivered, so they are recorded for the next leg.
      graceTimer = setTimeout(release, LATE_CALL_GRACE_MS);
    };
    // Restarted by every sign of call activity, so a batch is flushed only once
    // the model has gone quiet rather than at a fixed point after the first call.
    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(flushCalls, quietMs);
    };
    // The client gave up on this response. Resolve now, but keep the listener:
    // the model may still ask for tools, and an unanswered call would leave the
    // runtime busy until the next request. Those calls are refused on arrival.
    const abort = () => {
      if (settled) return;
      aborted = true;
      settle(() => resolve({ kind: "aborted" }));
      graceTimer = setTimeout(release, LATE_CALL_GRACE_MS);
    };
    signal?.addEventListener("abort", abort, { once: true });

    legTimer = setTimeout(
      () => fail(new Error(`native turn timed out after ${LEG_TIMEOUT_MS}ms`)),
      LEG_TIMEOUT_MS
    );

    unsub = session.on((event: any) => {
      // The SDK dispatches handlers inside its own try/catch, so a throw here
      // would be swallowed and this promise would stay pending until the leg
      // timeout. Convert it into an immediate rejection instead.
      try {
        if (settled) {
          // Only reachable during the grace window: the batch is already gone.
          if (event.type === "external_tool.requested" && event.data) {
            const { toolCallId, requestId } = event.data;
            if (aborted) {
              void session.rpc.tools
                .handlePendingToolCall({
                  requestId,
                  error: ABANDONED_CALL_REASON,
                })
                .catch(() => {});
            } else {
              orphans.push({ toolCallId, requestId });
            }
          }
          return;
        }
        switch (event.type) {
          case "external_tool.requested": {
            const {
              requestId,
              toolCallId,
              toolName,
              arguments: args,
            } = event.data;
            pending.set(toolCallId, requestId);
            calls.push({
              id: toolCallId,
              name: toolName,
              arguments: stringifyArgs(args),
            });
            armQuiet();
            break;
          }
          case "assistant.tool_call_delta":
            // The model is still emitting the batch: push the quiet window out
            // so a slow sibling is delivered instead of orphaned.
            if (calls.length) armQuiet();
            break;
          case "assistant.message_delta":
            content += event.data?.deltaContent ?? "";
            break;
          case "assistant.message":
            // Frames must not clobber the accumulation — see mergeAssistantFrame.
            content = mergeAssistantFrame(content, event.data?.content);
            break;
          case "assistant.turn_end":
            // A model turn that asked for nothing is final. While answering
            // parked calls, an empty turn_end can be the stale end of the turn
            // that issued them, so wait for content or idle instead.
            if (!calls.length && (content || !answering)) finishText();
            break;
          case "session.idle":
            // Idle = turn fully over; parked calls would have kept it busy.
            if (calls.length) flushCalls();
            else finishText();
            break;
          case "session.error":
            fail(new Error(event.data?.message ?? "session.error"));
            break;
        }
      } catch (err) {
        fail(err);
      }
    });

    start().catch(fail);
  });
}

/** Answer parked calls from OpenAI role:"tool" messages. Unknown ids are reported. */
export async function answerPendingCalls(
  session: Session,
  pending: PendingCalls,
  results: { toolCallId: string; content: string }[]
): Promise<string[]> {
  const unknown: string[] = [];
  for (const r of results) {
    const requestId = pending.get(r.toolCallId);
    if (!requestId) {
      unknown.push(r.toolCallId);
      continue;
    }
    await session.rpc.tools.handlePendingToolCall({
      requestId,
      result: r.content,
    });
    // Deleted only after the answer lands, so a failed call stays retryable
    // instead of being dropped from the map unanswered.
    pending.delete(r.toolCallId);
  }
  return unknown;
}

/**
 * Answer the results this request carried, then refuse whatever is left of the
 * batch. A client that answers only part of a batch would otherwise leave the
 * model waiting for the rest until the leg times out.
 */
export async function answerToolResults(
  session: Session,
  pending: PendingCalls,
  results: { toolCallId: string; content: string }[]
): Promise<{ unknown: string[]; abandoned: number }> {
  const unknown = await answerPendingCalls(session, pending, results);
  const abandoned = await abandonPendingCalls(session, pending);
  return { unknown, abandoned };
}

/**
 * Answer the given parked calls with an error and forget them. Ids that are no
 * longer parked are skipped: a live leg may already own them.
 */
export async function abandonCalls(
  session: Session,
  pending: PendingCalls,
  ids: Iterable<string>
): Promise<number> {
  let answered = 0;
  for (const toolCallId of [...ids]) {
    const requestId = pending.get(toolCallId);
    if (!requestId) continue;
    pending.delete(toolCallId);
    try {
      await session.rpc.tools.handlePendingToolCall({
        requestId,
        error: ABANDONED_CALL_REASON,
      });
      answered++;
    } catch {
      // The turn is already gone; nothing is waiting on this answer.
    }
  }
  return answered;
}

/**
 * Answer every parked call with an error. Used when a prompt arrives while
 * calls are still parked: the client abandoned them, and sending into a turn
 * that is waiting on an answer would leave the session busy forever.
 */
export async function abandonPendingCalls(
  session: Session,
  pending: PendingCalls
): Promise<number> {
  return abandonCalls(session, pending, [...pending.keys()]);
}

/** Answer calls recorded after their batch was returned. Unknown-on-arrival is fine. */
export async function drainOrphanedCalls(
  session: Session,
  pending: PendingCalls,
  orphans: OrphanedCall[]
): Promise<number> {
  let answered = 0;
  while (orphans.length) {
    const { toolCallId, requestId } = orphans.shift()!;
    if (pending.has(toolCallId)) continue; // a live leg owns it now
    try {
      await session.rpc.tools.handlePendingToolCall({
        requestId,
        error: LATE_CALL_REASON,
      });
      answered++;
    } catch {
      // Already answered, or the turn closed — nothing left to do.
    }
  }
  return answered;
}

/** Trailing role:"tool" messages of an OpenAI request, oldest first. */
export function trailingToolResults(
  messages: any[]
): { toolCallId: string; content: string }[] {
  const out: { toolCallId: string; content: string }[] = [];
  for (
    let i = messages.length - 1;
    i >= 0 && messages[i]?.role === "tool";
    i--
  ) {
    const c = messages[i].content;
    const content = typeof c === "string" ? c : JSON.stringify(c ?? "");
    out.unshift({ toolCallId: messages[i].tool_call_id, content });
  }
  return out;
}
