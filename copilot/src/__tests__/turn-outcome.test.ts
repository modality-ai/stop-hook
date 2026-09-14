import { describe, test, expect } from "bun:test";
import { isAbnormalStreamTurn } from "../copilot-to-openai";

// ─────────────────────────────────────────────────────────────
// Regression: truncation must count as an abnormal turn.
//
// Before the "abnormal" semantics, recordTurnOutcome only struck on a literally
// empty turn. A session degrading into short, truncated turns (repeated
// runaway-guard trips) then cleared the strike count every turn and the
// poisoned entry stayed cached until the operator restarted the server.
//
// These cases pin the stream-turn decision: a truncated turn ALWAYS strikes —
// the runaway guard cut it, so the session is misbehaving — and a healthy turn
// (real text, untruncated, or an intact tool call) always clears.
// ─────────────────────────────────────────────────────────────
describe("isAbnormalStreamTurn — truncated turns always strike", () => {
  test("truncation leaves text on the wire but the turn is abnormal", () => {
    expect(
      isAbnormalStreamTurn({ hasToolCall: false, content: "partial answer", truncated: true })
    ).toBe(true);
  });

  test("a truncated tool call is abnormal", () => {
    expect(
      isAbnormalStreamTurn({ hasToolCall: true, content: "{\"cm", truncated: true })
    ).toBe(true);
  });
});

describe("isAbnormalStreamTurn — empty content still strikes", () => {
  test("no content and no tool call is abnormal", () => {
    expect(isAbnormalStreamTurn({ hasToolCall: false, content: "", truncated: false })).toBe(true);
  });

  test("whitespace-only content is abnormal", () => {
    expect(isAbnormalStreamTurn({ hasToolCall: false, content: "  \n\t ", truncated: false })).toBe(true);
  });
});

describe("isAbnormalStreamTurn — healthy turns clear the count", () => {
  test("a normal untruncated text turn is healthy", () => {
    expect(isAbnormalStreamTurn({ hasToolCall: false, content: "hello", truncated: false })).toBe(false);
  });

  test("an intact untruncated tool call is healthy", () => {
    expect(
      isAbnormalStreamTurn({ hasToolCall: true, content: "{\"cmd\":\"ls\"}", truncated: false })
    ).toBe(false);
  });
});
