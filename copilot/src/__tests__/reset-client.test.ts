import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ─── Mock @github/copilot-sdk before importing the real copilot-core ──────────
// Only copilot-core imports the SDK at runtime, so this mock is contained.
// Everything else in copilot-core (loop-fs, /tmp dirs, whichCli) is real — the
// test exercises the ACTUAL resetClient implementation against a controllable
// client class.
let constructed = 0;
let calls: string[] = [];
let throwOnStop = false;

class FakeCopilotClient {
  constructor(_opts: any) {
    constructed++;
  }
  async start() {
    calls.push("start");
  }
  async stop() {
    calls.push("stop");
    if (throwOnStop) throw new Error("stop exploded");
  }
}

mock.module("@github/copilot-sdk", () => ({
  CopilotClient: FakeCopilotClient,
  RuntimeConnection: { forStdio: () => ({}) },
}));

import { client, resetClient } from "../copilot-core";

// resetClient is real module state shared across tests, so each test must drop
// any lingering client BEFORE resetting the local counters — otherwise a client
// constructed by the previous test survives into the next one and the expected
// construction counts skew.
beforeEach(() => {
  resetClient("test");
  constructed = 0;
  calls = [];
  throwOnStop = false;
});

afterEach(() => {
  // Leave no live client behind for other test files sharing the module.
  resetClient("test");
});

// ─────────────────────────────────────────────────────────────
// resetClient — drop the cached client so the next access respawns the CLI.
//
// The contract this pins: resetting is best-effort. The old connection is
// already presumed broken, so a throw from stop() must never block the respawn.
// ─────────────────────────────────────────────────────────────
describe("resetClient — no client yet", () => {
  test("is a no-op when no client has been constructed", () => {
    expect(() => resetClient("test")).not.toThrow();
    expect(constructed).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("resetClient — respawn on next access", () => {
  test("stop() is attempted on the dying client", async () => {
    await client.start();
    expect(constructed).toBe(1);
    resetClient("transport gone");
    expect(calls).toContain("stop");
  });

  test("the next client access constructs a fresh client", async () => {
    await client.start();
    resetClient("transport gone");
    await client.start();
    expect(constructed).toBe(2);
  });

  test("a throwing stop() does not block the respawn", async () => {
    await client.start();
    throwOnStop = true;
    expect(() => resetClient("transport gone")).not.toThrow();
    // The respawn path still works on the next access.
    await client.start();
    expect(constructed).toBe(2);
  });
});
