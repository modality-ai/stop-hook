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
  trailingToolResults,
  type OrphanedCall,
  type PendingCalls,
} from "../native-turn";
import { buildXmlToolSchemas } from "../tool-schemas";

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
  test("batches parallel external calls into one tool_calls result", async () => {
    const s = fakeSession();
    const pending: PendingCalls = new Map();
    const leg = runNativeLeg(s, pending, async () => {
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
    const result = await runNativeLeg(s, new Map(), async () => {
      s.emit("assistant.message_delta", { deltaContent: "hi " });
      s.emit("assistant.message_delta", { deltaContent: "there" });
      s.emit("session.idle");
    });
    expect(result).toEqual({ kind: "text", content: "hi there" });
  });

  test("rejects on session.error", async () => {
    const s = fakeSession();
    await expect(runNativeLeg(s, new Map(), async () => s.emit("session.error", { message: "boom" }))).rejects.toThrow("boom");
  });

  test("rejects instead of hanging when an event carries no data", async () => {
    // The SDK swallows listener throws; without the guard this leg would stay
    // pending until the 10-minute timeout.
    const s = fakeSession();
    await expect(runNativeLeg(s, new Map(), async () => s.emit("external_tool.requested", null))).rejects.toThrow();
  });

  test("rejects when the start callback itself fails", async () => {
    const s = fakeSession();
    await expect(
      runNativeLeg(s, new Map(), async () => {
        throw new Error("send failed");
      })
    ).rejects.toThrow("send failed");
  });

  test("an empty turn_end while answering parked calls does not finish the leg", async () => {
    // That turn_end can be the stale end of the turn that issued the calls;
    // resolving on it would return an empty answer and leave the model's
    // continuation unreported.
    const s = fakeSession();
    const leg = runNativeLeg(s, new Map(), async () => {
      s.emit("assistant.turn_end");
      s.emit("assistant.message_delta", { deltaContent: "done" });
      s.emit("session.idle");
    }, { quietMs: 10, answering: true });
    expect(await leg).toEqual({ kind: "text", content: "done" });
  });

  test("a turn_end with no calls still finishes a non-answering leg", async () => {
    const s = fakeSession();
    const leg = runNativeLeg(s, new Map(), async () => {
      s.emit("assistant.message_delta", { deltaContent: "answer" });
      s.emit("assistant.turn_end");
    });
    expect(await leg).toEqual({ kind: "text", content: "answer" });
  });

  test("a final assistant.message replaces the accumulated deltas", async () => {
    const s = fakeSession();
    const leg = runNativeLeg(s, new Map(), async () => {
      s.emit("assistant.message_delta", { deltaContent: "Hel" });
      s.emit("assistant.message", { content: "Hello there" });
      s.emit("session.idle");
    });
    expect(await leg).toEqual({ kind: "text", content: "Hello there" });
  });

  test("idle flushes the batch without waiting for the quiet window", async () => {
    const s = fakeSession();
    const leg = runNativeLeg(s, new Map(), async () => {
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
    const leg = runNativeLeg(s, new Map(), async () => {
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
    const leg = runNativeLeg(s, new Map(), async () => {
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
    const leg = runNativeLeg(s, pending, async () => {
      s.emit("assistant.message_delta", { deltaContent: "work" });
    }, { signal: abort.signal });
    abort.abort();
    expect(await leg).toEqual({ kind: "aborted" });

    s.emit("external_tool.requested", { requestId: "r9", toolCallId: "c9", toolName: "a", arguments: {} });
    await Promise.resolve();
    expect(s.answered).toEqual([{ requestId: "r9", error: expect.stringContaining("stopped waiting") }]);
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
      { toolCallId: "c2", content: '[{"type":"text","text":"two"}]' },
    ]);
  });

  test("returns [] when the request ends on anything but a tool message", () => {
    expect(trailingToolResults([])).toEqual([]);
    expect(trailingToolResults([{ role: "assistant", content: "done" }])).toEqual([]);
  });
});
