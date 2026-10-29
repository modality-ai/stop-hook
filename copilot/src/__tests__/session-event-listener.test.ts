import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logger, setupSessionEventListener } from "../copilot-core";

// The default branch of the listener is the only caller of logger.resetTimeout
// for an event type it does not recognise, so a call there means "unhandled".
function listen() {
  let handler: (event: any) => void = () => {};
  const session = { on: (fn: (event: any) => void) => ((handler = fn), () => {}) };
  setupSessionEventListener(session as any, {});
  return (type: string) => handler({ type, data: {} });
}

describe("setupSessionEventListener passthrough events", () => {
  const original = logger.resetTimeout;
  let unhandled: number;

  beforeEach(() => {
    unhandled = 0;
    logger.resetTimeout = () => void unhandled++;
  });
  afterEach(() => {
    logger.resetTimeout = original;
  });

  test("external_tool.completed is ignored, not reported as unhandled", () => {
    listen()("external_tool.completed");
    expect(unhandled).toBe(0);
  });

  test("an unknown event type is still reported as unhandled", () => {
    listen()("totally.unknown");
    expect(unhandled).toBe(1);
  });
});
