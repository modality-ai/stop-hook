import { describe, expect, test } from "bun:test";
import { runNativeLeg } from "../native-turn";

function fakeSession() {
  let listener: (e: any) => void = () => {};
  return {
    emit: (type: string, data: any = {}) => listener({ type, data }),
    on: (fn: (e: any) => void) => {
      listener = fn;
      return () => {};
    },
    send: async () => undefined,
    rpc: { tools: { handlePendingToolCall: async () => undefined } },
  };
}

const pendingOne = () => new Map([["c0", "r0"]]);

describe("runNativeLeg empty turn_end while answering", () => {
  test("content arriving after an empty turn_end is the result", async () => {
    const s = fakeSession();
    const leg = runNativeLeg(
      s,
      pendingOne(),
      async () => {
        setTimeout(() => s.emit("assistant.turn_end"), 0);
        setTimeout(() => s.emit("assistant.message", { content: "answer" }), 10);
        setTimeout(() => s.emit("assistant.turn_end"), 20);
      },
      { orphans: [], answering: true }
    );
    expect(await leg).toEqual({ kind: "text", content: "answer" });
  });

  test("an empty turn_end does not settle the leg immediately", async () => {
    const s = fakeSession();
    let settled = false;
    const leg = runNativeLeg(
      s,
      pendingOne(),
      async () => {
        setTimeout(() => s.emit("assistant.turn_end"), 0);
        setTimeout(() => s.emit("session.idle"), 60);
      },
      { orphans: [], answering: true }
    ).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    await leg;
  });

  test("an empty turn_end when not answering finishes at once", async () => {
    const s = fakeSession();
    const result = await runNativeLeg(s, new Map(), async () => {
      setTimeout(() => s.emit("assistant.turn_end"), 0);
    }, { orphans: [] });
    expect(result).toEqual({ kind: "text", content: "" });
  });

  test("an empty turn_end with a tool call already seen does not finish as text", async () => {
    const s = fakeSession();
    const result = await runNativeLeg(
      s,
      pendingOne(),
      async () => {
        setTimeout(
          () =>
            s.emit("external_tool.requested", {
              requestId: "r1",
              toolCallId: "c1",
              toolName: "Bash",
              arguments: {},
            }),
          0
        );
        setTimeout(() => s.emit("assistant.turn_end"), 10);
      },
      { orphans: [], answering: true, quietMs: 30 }
    );
    expect(result.kind).toBe("tool_calls");
  });
});
