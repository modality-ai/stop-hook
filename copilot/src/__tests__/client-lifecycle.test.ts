import { describe, test, expect } from "bun:test";
import { ClientStrikeCounter, StartLatch, CLIENT_FAILURES_BEFORE_RESTART } from "../client-lifecycle";

// ─────────────────────────────────────────────────────────────
// ClientStrikeCounter — consecutive client-level failures before a restart.
//
// The recovery rule: one failure is a transient blip; a second CONSECUTIVE one
// means the transport is gone. Any healthy turn forgives all strikes.
// ─────────────────────────────────────────────────────────────
describe("ClientStrikeCounter — failure counting", () => {
  test("a single failure does not reach the restart limit", () => {
    const strikes = new ClientStrikeCounter();
    expect(strikes.failure()).toBe(false);
  });

  test("the threshold constant drives the default limit of 2", () => {
    expect(CLIENT_FAILURES_BEFORE_RESTART).toBe(2);
  });

  test("the second consecutive failure reaches the restart limit", () => {
    const strikes = new ClientStrikeCounter();
    strikes.failure();
    expect(strikes.failure()).toBe(true);
  });

  test("count reports the number of consecutive failures", () => {
    const strikes = new ClientStrikeCounter();
    strikes.failure();
    expect(strikes.count).toBe(1);
    strikes.failure();
    expect(strikes.count).toBe(2);
  });

  test("a healthy turn forgives every earlier strike", () => {
    const strikes = new ClientStrikeCounter();
    strikes.failure();
    strikes.failure();
    strikes.healthy();
    expect(strikes.count).toBe(0);
    expect(strikes.failure()).toBe(false);
  });

  test("reset begins a fresh counting window", () => {
    const strikes = new ClientStrikeCounter();
    strikes.failure();
    strikes.failure();
    strikes.reset();
    expect(strikes.count).toBe(0);
    expect(strikes.failure()).toBe(false);
  });

  test("a custom limit is honored", () => {
    const strikes = new ClientStrikeCounter(3);
    expect(strikes.failure()).toBe(false);
    expect(strikes.failure()).toBe(false);
    expect(strikes.failure()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// StartLatch — single-flight client start.
//
// Concurrent requests must share ONE in-flight start; a restart clears the
// latch so the next run() starts again.
// ─────────────────────────────────────────────────────────────
describe("StartLatch — single-flight start", () => {
  test("run() invokes the start function once", async () => {
    let starts = 0;
    const latch = new StartLatch();
    await latch.run(async () => { starts++; });
    expect(starts).toBe(1);
    expect(latch.isStarted).toBe(true);
  });

  test("concurrent run() calls share one in-flight start", async () => {
    let starts = 0;
    const latch = new StartLatch();
    const start = async () => {
      starts++;
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await Promise.all([latch.run(start), latch.run(start), latch.run(start)]);
    expect(starts).toBe(1);
  });

  test("run() after a completed start is a no-op", async () => {
    let starts = 0;
    const latch = new StartLatch();
    await latch.run(async () => { starts++; });
    await latch.run(async () => { starts++; });
    expect(starts).toBe(1);
  });

  test("reset() clears the latch so the next run() starts again", async () => {
    let starts = 0;
    const latch = new StartLatch();
    await latch.run(async () => { starts++; });
    latch.reset();
    expect(latch.isStarted).toBe(false);
    await latch.run(async () => { starts++; });
    expect(starts).toBe(2);
  });

  test("a failed start leaves the latch clear for a retry", async () => {
    let starts = 0;
    const latch = new StartLatch();
    await expect(
      latch.run(async () => {
        starts++;
        throw new Error("start exploded");
      })
    ).rejects.toThrow("start exploded");
    await latch.run(async () => { starts++; });
    expect(starts).toBe(2);
    expect(latch.isStarted).toBe(true);
  });
});
