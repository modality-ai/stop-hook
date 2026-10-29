import { beforeAll, describe, expect, test } from "bun:test";

// The idle timeout is read once at module load, so set it before importing.
let runNativeLeg: typeof import("../native-turn").runNativeLeg;
let abandonPendingCalls: typeof import("../native-turn").abandonPendingCalls;

beforeAll(async () => {
  const prev = process.env.COPILOT_LEG_IDLE_TIMEOUT_MS;
  process.env.COPILOT_LEG_IDLE_TIMEOUT_MS = "50";
  // Query string gives a fresh module instance, so other test files keep the default.
  ({ runNativeLeg, abandonPendingCalls } = (await import("../native-turn?idle-watchdog" as string)) as typeof import("../native-turn"));
  if (prev === undefined) delete process.env.COPILOT_LEG_IDLE_TIMEOUT_MS;
  else process.env.COPILOT_LEG_IDLE_TIMEOUT_MS = prev;
});

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

describe("runNativeLeg idle watchdog", () => {
  test("a leg that hears no events fails as idle", async () => {
    const s = fakeSession();
    await expect(runNativeLeg(s, new Map(), async () => {}, { orphans: [] })).rejects.toThrow("native turn idle for 50ms");
  });

  test("events keep a slow leg alive past the idle window", async () => {
    const s = fakeSession();
    const result = await runNativeLeg(s, new Map(), async () => {
      for (let i = 1; i <= 4; i++) setTimeout(() => s.emit("assistant.message_delta", { deltaContent: "x" }), i * 30);
      setTimeout(() => s.emit("session.idle"), 150);
    }, { orphans: [] });
    expect(result).toEqual({ kind: "text", content: "xxxx" });
  });

  test("an idle failure tells the runtime why the parked call was dropped", async () => {
    const s = fakeSession();
    const pending = new Map<string, string>();
    pending.set("c1", "r1");
    await expect(runNativeLeg(s, pending, async () => {}, { orphans: [] })).rejects.toThrow("idle");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.answered).toEqual([{ requestId: "r1", error: "native turn idle for 50ms" }]);
  });
});

describe("abandonPendingCalls reason", () => {
  test("uses a caller-supplied reason", async () => {
    const s = fakeSession();
    await abandonPendingCalls(s, new Map([["c1", "r1"]]), "because");
    expect(s.answered).toEqual([{ requestId: "r1", error: "because" }]);
  });
});
