import { describe, expect, test } from "bun:test";

// The idle timeout is read once at module load, so import a fresh instance under 50ms.
async function loadWithIdle(value: string, tag: string) {
  const prev = process.env.COPILOT_LEG_IDLE_TIMEOUT_MS;
  process.env.COPILOT_LEG_IDLE_TIMEOUT_MS = value;
  try {
    return (await import(`../native-turn?${tag}` as string)) as typeof import("../native-turn");
  } finally {
    if (prev === undefined) delete process.env.COPILOT_LEG_IDLE_TIMEOUT_MS;
    else process.env.COPILOT_LEG_IDLE_TIMEOUT_MS = prev;
  }
}

function fakeSession() {
  let listener: (e: any) => void = () => {};
  return {
    emit: (type: string, data: any = {}) => listener({ type, data }),
    on: (fn: (e: any) => void) => {
      listener = fn;
      return () => {};
    },
    send: async () => undefined,
    rpc: { tools: { handlePendingToolCall: async () => {} } },
  };
}

describe("empty-answer grace is clamped below the idle window", () => {
  test("an empty turn_end while answering settles as text instead of failing idle", async () => {
    const mod = await loadWithIdle("50", "grace-clamp");
    const s = fakeSession();
    const leg = mod.runNativeLeg(
      s as any,
      new Map(),
      async () => {
        setTimeout(() => s.emit("assistant.turn_end"), 0);
      },
      { orphans: [], answering: true }
    );
    expect(await leg).toEqual({ kind: "text", content: "" });
  });
});
