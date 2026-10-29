import { describe, expect, test } from "bun:test";
import { answerToolResults, runNativeLeg } from "../native-turn";

function fakeSession() {
  let listener: (e: any) => void = () => {};
  const answered: { requestId: string; result?: string; error?: string }[] = [];
  return {
    answered,
    emit: (type: string, data: any = {}) => listener({ type, data }),
    on: (fn: (e: any) => void) => {
      listener = fn;
      return () => {};
    },
    send: async () => undefined,
    rpc: { tools: { handlePendingToolCall: async (a: any) => void answered.push(a) } },
  };
}

describe("pre-aborted answering leg", () => {
  test("delivers the client's real result instead of refusing it first", async () => {
    const s = fakeSession();
    const pending = new Map([["c1", "r1"]]);
    const ctrl = new AbortController();
    ctrl.abort();
    const leg = runNativeLeg(
      s,
      pending,
      async () => {
        await answerToolResults(s, pending, [{ toolCallId: "c1", content: "ok" }]);
      },
      { orphans: [], answering: true, signal: ctrl.signal }
    );
    expect((await leg).kind).toBe("aborted");
    await new Promise((r) => setTimeout(r, 10));
    expect(s.answered).toEqual([{ requestId: "r1", result: "ok" }]);
  });

  test("a pre-aborted prompt leg still refuses its parked calls", async () => {
    const s = fakeSession();
    const pending = new Map([["c1", "r1"]]);
    const ctrl = new AbortController();
    ctrl.abort();
    await runNativeLeg(s, pending, async () => {}, { orphans: [], signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.answered.map((a) => a.requestId)).toEqual(["r1"]);
  });
});

describe("empty turn_end grace", () => {
  test("a tool_call_delta after an empty turn_end keeps the leg open", async () => {
    const s = fakeSession();
    let settled = false;
    const leg = runNativeLeg(
      s,
      new Map([["c0", "r0"]]),
      async () => {
        setTimeout(() => s.emit("assistant.turn_end"), 0);
        setTimeout(() => s.emit("assistant.tool_call_delta"), 10);
      },
      { orphans: [], answering: true }
    ).then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toBe(false);
    s.emit("external_tool.requested", { requestId: "r1", toolCallId: "c1", toolName: "Bash", arguments: {} });
    expect((await leg).kind).toBe("tool_calls");
  });
});
