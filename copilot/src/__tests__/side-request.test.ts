import { describe, expect, test } from "bun:test";
import { isOneShotRequest, isSideRequest, sideSessionKey } from "../side-request";

describe("isOneShotRequest", () => {
  test("a lone user prompt is one-shot", () => {
    expect(isOneShotRequest([{ role: "user", content: "title?" }])).toBe(true);
  });

  test("an assistant turn makes it a continuation", () => {
    expect(isOneShotRequest([{ role: "user" }, { role: "assistant" }, { role: "user" }])).toBe(false);
  });

  test("a tool turn makes it a continuation", () => {
    expect(isOneShotRequest([{ role: "user" }, { role: "tool" }])).toBe(false);
  });

  test("missing messages count as one-shot", () => {
    expect(isOneShotRequest(undefined as any)).toBe(true);
  });
});

describe("isSideRequest", () => {
  const oneShot = [{ role: "user", content: "summarize" }];

  test("no session header is never a side request", () => {
    expect(isSideRequest(undefined, oneShot, undefined, true)).toBe(false);
  });

  test("a request that offers tools is never a side request", () => {
    expect(isSideRequest("s1", oneShot, [{ type: "function" }], true)).toBe(false);
  });

  test("no parked calls is not a side request", () => {
    expect(isSideRequest("s1", oneShot, undefined, false)).toBe(false);
  });

  test("a one-shot prompt while calls are parked is a side request", () => {
    expect(isSideRequest("s1", oneShot, undefined, true)).toBe(true);
  });

  test("a continuation with parked calls is not a side request", () => {
    const continuation = [{ role: "user" }, { role: "assistant" }, { role: "tool" }];
    expect(isSideRequest("s1", continuation, undefined, true)).toBe(false);
  });
});

describe("sideSessionKey", () => {
  test("prefixes the header id so it never collides with the live session", () => {
    expect(sideSessionKey("abc")).toBe("side-abc");
  });
});
