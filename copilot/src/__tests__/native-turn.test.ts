import { describe, expect, test } from "bun:test";
import {
  abandonPendingCalls,
  answerPendingCalls,
  answerToolResults,
  drainOrphanedCalls,
  nativeFinishReason,
  runNativeLeg,
  salvageValidator,
  toExternalTools,
  toolMessageText,
  trailingToolResults,
  type OrphanedCall,
  type PendingCalls,
} from "../native-turn";
import { buildXmlToolSchemas } from "../tool-schemas";

// runNativeLeg requires an orphan recorder; tests get a fresh one unless they pass their own.
const runLeg = (
  s: any,
  pending: PendingCalls,
  start: () => Promise<unknown>,
  opts: Partial<Parameters<typeof runNativeLeg>[3]> = {}
) => runNativeLeg(s, pending, start, { orphans: [], ...opts });

function fakeSession() {
  let listener: (e: any) => void = () => {};
  const answered: { requestId: string; result?: string; error?: string }[] = [];
  return {
    answered,
    emit: (type: string, data: any = {}) => listener({ type, data }),
    on: (fn: (e: any) => void) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
    send: async () => undefined,
    rpc: {
      tools: {
        handlePendingToolCall: async (args: { requestId: string; result?: string; error?: string }) => {
          answered.push(args);
        },
      },
    },
  };
}

describe("runNativeLeg", () => {
  test("a leg aborted before it starts does not run start() unless it is answering", async () => {
    const ctl = new AbortController();
    ctl.abort();
    let prompts = 0;
    const result = await runLeg(fakeSession(), new Map(), async () => void prompts++, { signal: ctl.signal });
    expect(result).toEqual({ kind: "aborted" });
    expect(prompts).toBe(0);

    let answers = 0;
    await runLeg(fakeSession(), new Map(), async () => void answers++, { signal: ctl.signal, answering: true });
    expect(answers).toBe(1);
  });

  test("an answering leg aborted before it starts still runs start() and refuses late calls", async () => {
    const s = fakeSession();
    const ctl = new AbortController();
    ctl.abort();
    const result = await runLeg(
      s,
      new Map(),
      async () => {
        s.emit("external_tool.requested", { requestId: "r1", toolCallId: "c1", toolName: "Bash", arguments: {} });
      },
      { signal: ctl.signal, answering: true }
    );
    expect(result).toEqual({ kind: "aborted" });
    expect(s.answered).toEqual([{ requestId: "r1", error: expect.any(String) }]);
  });

  test("a start() failure after the batch was returned does not refuse the client's calls", async () => {
    const s = fakeSession();
    const pending: PendingCalls = new Map();
    let failStart: (e: Error) => void = () => {};
    const result = await runLeg(
      s,
      pending,
      () =>
        new Promise((_, reject) => {
          failStart = reject;
          s.emit("external_tool.requested", { requestId: "r1", toolCallId: "c1", toolName: "Bash", arguments: {} });
        }),
      { quietMs: 5 }
    );
    expect(result.kind).toBe("tool_calls");
    failStart(new Error("late"));
    await new Promise((r) => setTimeout(r, 10));
    expect(s.answered).toEqual([]);
    expect(pending.has("c1")).toBe(true);
  });
  test("batches parallel external calls into one tool_calls result", async () => {
    const s = fakeSession();
    const pending: PendingCalls = new Map();
    const leg = runLeg(s, pending, async () => {
      s.emit("external_tool.requested", { requestId: "r1", toolCallId: "c1", toolName: "a", arguments: { x: 1 } });
      s.emit("external_tool.requested", { requestId: "r2", toolCallId: "c2", toolName: "b", arguments: "{}" });
    }, { quietMs: 10 });
    const result = await leg;
    expect(result).toEqual({
      kind: "tool_calls",
      calls: [
        { id: "c1", name: "a", arguments: '{"x":1}' },
        { id: "c2", name: "b", arguments: "{}" },
      ],
    });
    expect([...pending.entries()]).toEqual([
      ["c1", "r1"],
      ["c2", "r2"],
    ]);
  });

  test("returns text when the turn goes idle without calls", async () => {
    const s = fakeSession();
    const result = await runLeg(s, new Map(), async () => {
      s.emit("assistant.message_delta", { deltaContent: "hi " });
      s.emit("assistant.message_delta", { deltaContent: "there" });
      s.emit("session.idle");
    });
    expect(result).toEqual({ kind: "text", content: "hi there" });
  });

  test("rejects on session.error", async () => {
    const s = fakeSession();
    await expect(runLeg(s, new Map(), async () => s.emit("session.error", { message: "boom" }))).rejects.toThrow("boom");
  });

  test("rejects instead of hanging when an event carries no data", async () => {
    // The SDK swallows listener throws; without the guard this leg would stay
    // pending until the 10-minute timeout.
    const s = fakeSession();
    await expect(runLeg(s, new Map(), async () => s.emit("external_tool.requested", null))).rejects.toThrow();
  });

  test("rejects when the start callback itself fails", async () => {
    const s = fakeSession();
    await expect(
      runLeg(s, new Map(), async () => {
        throw new Error("send failed");
      })
    ).rejects.toThrow("send failed");
  });

  test("an empty turn_end while answering parked calls does not finish the leg", async () => {
    // That turn_end can be the stale end of the turn that issued the calls;
    // resolving on it would return an empty answer and leave the model's
    // continuation unreported.
    const s = fakeSession();
    const leg = runLeg(s, new Map(), async () => {
      s.emit("assistant.turn_end");
      s.emit("assistant.message_delta", { deltaContent: "done" });
      s.emit("session.idle");
    }, { quietMs: 10, answering: true });
    expect(await leg).toEqual({ kind: "text", content: "done" });
  });

  test("a call arriving after an empty turn_end while answering is still returned", async () => {
    const s = fakeSession();
    const leg = runLeg(s, new Map(), async () => {
      s.emit("assistant.turn_end");
      s.emit("external_tool.requested", { requestId: "r1", toolCallId: "c1", toolName: "Bash", arguments: { command: "ls" } });
    }, { quietMs: 10, answering: true });
    expect(await leg).toEqual({
      kind: "tool_calls",
      calls: [{ id: "c1", name: "Bash", arguments: '{"command":"ls"}' }],
    });
  });

  test("a turn_end with no calls still finishes a non-answering leg", async () => {
    const s = fakeSession();
    const leg = runLeg(s, new Map(), async () => {
      s.emit("assistant.message_delta", { deltaContent: "answer" });
      s.emit("assistant.turn_end");
    });
    expect(await leg).toEqual({ kind: "text", content: "answer" });
  });

  test("a final assistant.message replaces the accumulated deltas", async () => {
    const s = fakeSession();
    const leg = runLeg(s, new Map(), async () => {
      s.emit("assistant.message_delta", { deltaContent: "Hel" });
      s.emit("assistant.message", { content: "Hello there" });
      s.emit("session.idle");
    });
    expect(await leg).toEqual({ kind: "text", content: "Hello there" });
  });

  test("idle flushes the batch without waiting for the quiet window", async () => {
    const s = fakeSession();
    const leg = runLeg(s, new Map(), async () => {
      s.emit("external_tool.requested", { requestId: "r1", toolCallId: "c1", toolName: "a", arguments: {} });
      s.emit("session.idle");
    }, { quietMs: 10_000 });
    expect(await leg).toEqual({ kind: "tool_calls", calls: [{ id: "c1", name: "a", arguments: "{}" }] });
  });

  test("records a call that lands after its batch was returned", async () => {
    // The grace window keeps the listener alive; a late call can no longer be
    // delivered to the client, so it is parked for the next leg instead.
    const s = fakeSession();
    const orphans: OrphanedCall[] = [];
    const leg = runLeg(s, new Map(), async () => {
      s.emit("external_tool.requested", { requestId: "r1", toolCallId: "c1", toolName: "a", arguments: {} });
    }, { quietMs: 10, orphans });
    await leg;
    s.emit("external_tool.requested", { requestId: "r2", toolCallId: "c2", toolName: "b", arguments: {} });
    expect(orphans).toEqual([{ toolCallId: "c2", requestId: "r2" }]);
  });

  test("a tool-call delta extends the quiet window so a slow sibling is delivered", async () => {
    // Without the extension the batch flushes 250ms after the first call and
    // the sibling arriving at 160ms would be orphaned instead of delivered.
    const s = fakeSession();
    const orphans: OrphanedCall[] = [];
    const leg = runLeg(s, new Map(), async () => {
      s.emit("external_tool.requested", { requestId: "r1", toolCallId: "c1", toolName: "a", arguments: {} });
      setTimeout(() => s.emit("assistant.tool_call_delta", {}), 80);
      setTimeout(
        () => s.emit("external_tool.requested", { requestId: "r2", toolCallId: "c2", toolName: "b", arguments: {} }),
        160
      );
    }, { quietMs: 250, orphans });
    const result = await leg;
    expect(result.kind).toBe("tool_calls");
    expect((result as any).calls.map((c: any) => c.id)).toEqual(["c1", "c2"]);
    expect(orphans).toEqual([]);
  });

  test("an aborted leg resolves at once and refuses calls that still arrive", async () => {
    // The client stopped reading: delivering is impossible, so the call is
    // answered with an error instead of being parked for a turn nobody will read.
    const s = fakeSession();
    const pending: PendingCalls = new Map();
    const abort = new AbortController();
    const leg = runLeg(s, pending, async () => {
      s.emit("assistant.message_delta", { deltaContent: "work" });
    }, { signal: abort.signal });
    abort.abort();
    expect(await leg).toEqual({ kind: "aborted" });

    s.emit("external_tool.requested", { requestId: "r9", toolCallId: "c9", toolName: "a", arguments: {} });
    await Promise.resolve();
    expect(s.answered).toEqual([{ requestId: "r9", error: expect.stringContaining("stopped waiting") }]);
    expect(pending.size).toBe(0);
  });

  test("an aborted leg refuses the calls it had already collected", async () => {
    // Those calls can no longer reach the client, and leaving them unanswered
    // keeps the runtime turn busy — a later resume then reattaches and hangs.
    const s = fakeSession();
    const pending: PendingCalls = new Map();
    const abort = new AbortController();
    const leg = runLeg(s, pending, async () => {
      s.emit("external_tool.requested", { requestId: "r1", toolCallId: "c1", toolName: "a", arguments: {} });
      abort.abort();
    }, { quietMs: 10_000, signal: abort.signal });

    expect(await leg).toEqual({ kind: "aborted" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.answered).toEqual([{ requestId: "r1", error: expect.stringContaining("stopped waiting") }]);
    expect(pending.size).toBe(0);
  });

  test("a failed leg refuses the calls it had already collected", async () => {
    // The turn is over either way; without the refusal the runtime keeps waiting
    // for a tool result and the session stays busy after this leg is gone. The
    // runtime is told WHY the call was dropped, so a timeout reads as one.
    const s = fakeSession();
    const pending: PendingCalls = new Map();
    const leg = runLeg(s, pending, async () => {
      s.emit("external_tool.requested", { requestId: "r1", toolCallId: "c1", toolName: "a", arguments: {} });
      s.emit("session.error", { message: "boom" });
    });

    await expect(leg).rejects.toThrow("boom");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.answered).toEqual([{ requestId: "r1", error: "boom" }]);
    expect(pending.size).toBe(0);
  });
});

describe("toExternalTools", () => {
  test("declares a client tool handler-less and pre-loaded", () => {
    const schema = { type: "object", properties: { command: { type: "string" } } };
    expect(toExternalTools([{ name: "Bash", description: "run", input_schema: schema }])).toEqual([
      { name: "Bash", description: "run", parameters: schema, skipPermission: true, overridesBuiltInTool: true, defer: "never" },
    ]);
  });

  test("flags only built-in-named tools as overriding", () => {
    const [bash, counter] = toExternalTools([
      { name: "Bash", description: "run", input_schema: { type: "object" } },
      { name: "mcp__Counter___Counter__Deploy", description: "deploy", input_schema: { type: "object" } },
    ]);
    expect(bash.overridesBuiltInTool).toBe(true);
    expect(counter.overridesBuiltInTool).toBeUndefined();
  });

  test("does not flag ToolSearch as overriding a built-in", () => {
    const [toolSearch] = toExternalTools([{ name: "ToolSearch", description: "load", input_schema: { type: "object" } }]);
    expect(toolSearch.overridesBuiltInTool).toBeUndefined();
  });

  test("drops entries with no usable name", () => {
    expect(toExternalTools([{ description: "nameless" }, null] as any)).toEqual([]);
  });

  test("declares nothing when the client sent no tools", () => {
    expect(toExternalTools()).toEqual([]);
  });
});

describe("nativeFinishReason", () => {
  test("a tool call is tool_calls even when the text was truncated", () => {
    expect(nativeFinishReason("tool_calls", true)).toBe("tool_calls");
  });

  test("truncated text reports length so the turn is retryable", () => {
    expect(nativeFinishReason("text", true)).toBe("length");
  });

  test("clean text reports stop", () => {
    expect(nativeFinishReason("text", false)).toBe("stop");
  });
});

describe("salvageValidator", () => {
  const schemas = buildXmlToolSchemas([
    { name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } },
  ]);

  test("places no gate on a turn that carried XML markup", () => {
    // The proxy may hold a partial tool list, so a converted markup call is
    // forwarded rather than re-printed as text.
    expect(salvageValidator("<invoke name=\"Bash\">", schemas)).toBeUndefined();
  });

  test("gates a bare JSON literal against an unknown tool name", () => {
    const validate = salvageValidator('{"tool_use":{"name":"Nope","input":{}}}', schemas);
    expect(validate!("Nope", {})).toBe(false);
  });

  test("gates a bare JSON literal against an undeclared parameter", () => {
    const validate = salvageValidator('{"tool_use":{"name":"Bash","input":{}}}', schemas);
    expect(validate!("Bash", { bogus: 1 })).toBe(false);
  });

  test("accepts a bare JSON literal for a declared call", () => {
    const validate = salvageValidator('{"tool_use":{"name":"Bash","input":{}}}', schemas);
    expect(validate!("Bash", { command: "ls" })).toBe(true);
  });

  test("accepts anything when the turn carried no tool list", () => {
    const validate = salvageValidator('{"tool_use":{"name":"Whatever","input":{}}}', new Map());
    expect(validate!("Whatever", { anything: 1 })).toBe(true);
  });
});

describe("answerPendingCalls", () => {
  test("answers known ids and reports unknown ones", async () => {
    const s = fakeSession();
    const pending: PendingCalls = new Map([["c1", "r1"]]);
    const unknown = await answerPendingCalls(s, pending, [
      { toolCallId: "c1", content: "ok" },
      { toolCallId: "zz", content: "?" },
    ]);
    expect(s.answered).toEqual([{ requestId: "r1", result: "ok" }]);
    expect(unknown).toEqual(["zz"]);
    expect(pending.size).toBe(0);
  });

  test("keeps an id parked when its answer fails, so it stays retryable", async () => {
    const s = fakeSession();
    s.rpc.tools.handlePendingToolCall = async () => {
      throw new Error("rpc down");
    };
    const pending: PendingCalls = new Map([["c1", "r1"]]);
    await expect(answerPendingCalls(s, pending, [{ toolCallId: "c1", content: "ok" }])).rejects.toThrow("rpc down");
    expect(pending.has("c1")).toBe(true);
  });
});

describe("abandonPendingCalls", () => {
  test("answers every parked call with an error and clears the map", async () => {
    const s = fakeSession();
    const pending: PendingCalls = new Map([["c1", "r1"], ["c2", "r2"]]);
    expect(await abandonPendingCalls(s, pending)).toBe(2);
    expect(s.answered.map((a) => a.requestId)).toEqual(["r1", "r2"]);
    expect(s.answered.every((a) => !!a.error)).toBe(true);
    expect(pending.size).toBe(0);
  });

  test("still clears the map when the answer cannot be delivered", async () => {
    // The turn that parked the call is already gone; keeping the entry would
    // wedge every later prompt on this session.
    const s = fakeSession();
    s.rpc.tools.handlePendingToolCall = async () => {
      throw new Error("turn gone");
    };
    const pending: PendingCalls = new Map([["c1", "r1"]]);
    expect(await abandonPendingCalls(s, pending)).toBe(0);
    expect(pending.size).toBe(0);
  });
});

describe("answerToolResults", () => {
  test("refuses the rest of a partially answered batch", async () => {
    const s = fakeSession();
    const pending: PendingCalls = new Map([
      ["c1", "r1"],
      ["c2", "r2"],
    ]);
    const { unknown, abandoned } = await answerToolResults(s, pending, [{ toolCallId: "c1", content: "done" }]);
    expect(unknown).toEqual([]);
    expect(abandoned).toBe(1);
    expect(s.answered).toEqual([
      { requestId: "r1", result: "done" },
      { requestId: "r2", error: expect.stringContaining("stopped waiting") },
    ]);
    expect(pending.size).toBe(0);
  });
});

describe("drainOrphanedCalls", () => {
  test("answers late calls and skips ones a live leg already owns", async () => {
    const s = fakeSession();
    const pending: PendingCalls = new Map([["owned", "r-owned"]]);
    const orphans: OrphanedCall[] = [
      { toolCallId: "late", requestId: "r-late" },
      { toolCallId: "owned", requestId: "r-owned" },
    ];
    expect(await drainOrphanedCalls(s, pending, orphans)).toBe(1);
    expect(s.answered).toEqual([{ requestId: "r-late", error: expect.any(String) }]);
    expect(orphans).toEqual([]);
  });

  test("drops an orphan the runtime no longer holds instead of retrying it", async () => {
    const s = fakeSession();
    s.rpc.tools.handlePendingToolCall = async () => {
      throw new Error("already answered");
    };
    const orphans: OrphanedCall[] = [{ toolCallId: "late", requestId: "r-late" }];
    expect(await drainOrphanedCalls(s, new Map(), orphans)).toBe(0);
    expect(orphans).toEqual([]);
  });
});

describe("trailingToolResults", () => {
  test("collects only the trailing role:tool messages in order", () => {
    const msgs = [
      { role: "tool", tool_call_id: "old", content: "x" },
      { role: "assistant", content: null },
      { role: "tool", tool_call_id: "c1", content: "one" },
      { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "two" }] },
    ];
    expect(trailingToolResults(msgs)).toEqual([
      { toolCallId: "c1", content: "one" },
      { toolCallId: "c2", content: "two" },
    ]);
  });

  test("null content becomes empty text; non-text parts are dropped, text parts kept", () => {
    const image = { type: "image_url", image_url: { url: "u" } };
    expect(
      trailingToolResults([
        { role: "tool", tool_call_id: "a", content: null },
        { role: "tool", tool_call_id: "b", content: [image] },
        { role: "tool", tool_call_id: "c", content: [{ type: "text", text: "x" }, image, { type: "text", text: "y" }] },
      ])
    ).toEqual([
      { toolCallId: "a", content: "" },
      { toolCallId: "b", content: "" },
      { toolCallId: "c", content: "x\ny" },
    ]);
  });

  test("returns [] when the request ends on anything but a tool message", () => {
    expect(trailingToolResults([])).toEqual([]);
    expect(trailingToolResults([{ role: "assistant", content: "done" }])).toEqual([]);
  });
});

describe("toolMessageText", () => {
  test("a string passes through unchanged", () => {
    expect(toolMessageText("ok")).toBe("ok");
  });

  test("null and undefined become empty text", () => {
    expect(toolMessageText(null)).toBe("");
    expect(toolMessageText(undefined)).toBe("");
  });

  test("an array keeps only text parts, joined by newline", () => {
    const image = { type: "image_url", image_url: { url: "u" } };
    expect(toolMessageText([{ type: "text", text: "a" }, image, { type: "text", text: "b" }])).toBe("a\nb");
  });

  test("a non-array object falls back to JSON", () => {
    expect(toolMessageText({ a: 1 })).toBe('{"a":1}');
  });
});

describe("empty turn_end while answering parked calls", () => {
  test("settles as empty text after the grace period instead of idling to failure", async () => {
    const handlers: ((e: any) => void)[] = [];
    const session: any = {
      on: (fn: any) => { handlers.push(fn); return () => {}; },
      send: async () => {},
      rpc: { tools: { handlePendingToolCall: async () => {} } },
    };
    const { runNativeLeg } = await import("../native-turn");
    const realSetTimeout = globalThis.setTimeout;
    // Compress the 15s grace so the test stays fast.
    (globalThis as any).setTimeout = (fn: any, ms: number, ...a: any[]) =>
      realSetTimeout(fn, ms === 15_000 ? 20 : ms, ...a);
    try {
      const leg = runNativeLeg(session, new Map(), async () => {}, { answering: true, orphans: [] });
      handlers[0]({ type: "assistant.turn_end", data: {} });
      expect(await leg).toEqual({ kind: "text", content: "" });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
