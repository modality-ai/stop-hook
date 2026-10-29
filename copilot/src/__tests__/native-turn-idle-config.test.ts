import { describe, expect, test } from "bun:test";

// The idle timeout is read once at module load, so each case imports a fresh
// module instance (distinct query string) under its own env value.
async function loadWith(value: string, tag: string) {
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

// A silent leg ended by hand after 100ms: it only resolves if the watchdog
// did not fail it first.
async function silentLegFor100ms(mod: typeof import("../native-turn")) {
  const s = fakeSession();
  return mod.runNativeLeg(s as any, new Map(), async () => {
    setTimeout(() => s.emit("session.idle"), 100);
  }, { orphans: [] });
}


// Whether a leg armed the 30s default idle timer. A disabled watchdog and an armed
// 30s one look identical from outside for the first 100ms, so watch the timers.
async function armsDefaultWatchdog(mod: typeof import("../native-turn")) {
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => {
    delays.push(ms ?? 0);
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof setTimeout;
  try {
    const s = fakeSession();
    const leg = mod.runNativeLeg(s as any, new Map(), async () => {}, { orphans: [] });
    s.emit("session.idle");
    await leg;
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  return delays.includes(30_000);
}

describe("COPILOT_LEG_IDLE_TIMEOUT_MS parsing", () => {
  test("a non-numeric value falls back to the 30s default", async () => {
    const mod = await loadWith("abc", "idle-nan");
    expect(await silentLegFor100ms(mod)).toEqual({ kind: "text", content: "" });
  });

  test("an empty value is treated as unset, not as 0", async () => {
    expect(await armsDefaultWatchdog(await loadWith("", "idle-empty"))).toBe(true);
  });

  test("a whitespace-only value is treated as unset, not as 0", async () => {
    expect(await armsDefaultWatchdog(await loadWith("   ", "idle-blank"))).toBe(true);
  });

  test("0 arms no idle timer", async () => {
    expect(await armsDefaultWatchdog(await loadWith("0", "idle-zero-timer"))).toBe(false);
  });

  test("a value beyond the 32-bit timer limit is clamped, not fired immediately", async () => {
    const mod = await loadWith("99999999999", "idle-huge");
    expect(await silentLegFor100ms(mod)).toEqual({ kind: "text", content: "" });
  });

  test("a negative value falls back to the 30s default", async () => {
    const mod = await loadWith("-5", "idle-neg");
    expect(await silentLegFor100ms(mod)).toEqual({ kind: "text", content: "" });
  });
});
