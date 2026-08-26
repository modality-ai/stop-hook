import { describe, test, expect } from "bun:test";

// Import the REAL implementation — these are the exact functions
// copilot-to-openai.ts calls when recovering tool_use literals from model text.
import { findBalancedObjectEnd, repairTruncatedJson } from "../json-scan";

// ─── findBalancedObjectEnd ───────────────────────────────────────────────────
describe("findBalancedObjectEnd", () => {
  test("returns the index of the closing brace of a flat object", () => {
    const text = '{"a":1}';
    expect(findBalancedObjectEnd(text, 0)).toBe(text.length - 1);
  });

  test("skips over nested objects", () => {
    const text = '{"a":{"b":2}}';
    expect(findBalancedObjectEnd(text, 0)).toBe(text.length - 1);
  });

  test("stops at the first complete object and ignores trailing text", () => {
    expect(findBalancedObjectEnd('{"a":1} then prose {"b":2}', 0)).toBe(6);
  });

  test("honours a non-zero start offset", () => {
    const text = 'noise {"a":1}';
    expect(findBalancedObjectEnd(text, 6)).toBe(text.length - 1);
  });

  test("returns -1 when start does not point at an opening brace", () => {
    expect(findBalancedObjectEnd(' {"a":1}', 0)).toBe(-1);
  });

  test("ignores braces that appear inside strings", () => {
    const text = JSON.stringify({ a: "}{" });
    expect(findBalancedObjectEnd(text, 0)).toBe(text.length - 1);
  });

  // REGRESSION: an escaped quote must NOT close the string. Treating it as a
  // terminator flips string context, so every following brace is counted and
  // the object appears to end early (or never).
  test("treats an escaped quote as string content, not a terminator", () => {
    const text = JSON.stringify({ a: 'say "}" ok', b: 1 });
    expect(findBalancedObjectEnd(text, 0)).toBe(text.length - 1);
  });

  test("returns a slice that parses when the string holds escaped quotes", () => {
    const text = JSON.stringify({ a: 'say "}" ok', b: 1 });
    const end = findBalancedObjectEnd(text, 0);
    expect(JSON.parse(text.slice(0, end + 1))).toEqual({ a: 'say "}" ok', b: 1 });
  });

  // REGRESSION: an escaped BACKSLASH consumes itself, so the quote right after
  // it really does end the string.
  test("lets the quote after an escaped backslash close the string", () => {
    const text = JSON.stringify({ a: "ends with a backslash \\" });
    expect(findBalancedObjectEnd(text + " trailing", 0)).toBe(text.length - 1);
  });

  test("returns -1 when the object never closes", () => {
    expect(findBalancedObjectEnd('{"a":{"b":1}', 0)).toBe(-1);
  });

  test("returns -1 when the text ends inside a string", () => {
    expect(findBalancedObjectEnd('{"a":"unterminated', 0)).toBe(-1);
  });
});

// ─── repairTruncatedJson ─────────────────────────────────────────────────────
describe("repairTruncatedJson", () => {
  test("returns already-balanced JSON unchanged", () => {
    expect(repairTruncatedJson('{"a":1}')).toBe('{"a":1}');
  });

  test("appends the missing closing brace", () => {
    expect(JSON.parse(repairTruncatedJson('{"a":1') as string)).toEqual({ a: 1 });
  });

  test("closes a truncated nested array and object", () => {
    expect(JSON.parse(repairTruncatedJson('{"a":[1,2') as string)).toEqual({ a: [1, 2] });
  });

  // REGRESSION: escaped quotes inside a string must not be read as string
  // boundaries, or the repair miscounts what is still open.
  test("repairs a truncation that follows an escaped quote", () => {
    const truncated = '{"a":"say \\"hi\\"","b":[1';
    expect(JSON.parse(repairTruncatedJson(truncated) as string)).toEqual({ a: 'say "hi"', b: [1] });
  });

  test("returns null when the text ends inside a string", () => {
    expect(repairTruncatedJson('{"a":"x')).toBeNull();
  });

  test("returns null when there are more closers than openers", () => {
    expect(repairTruncatedJson('{"a":1}}')).toBeNull();
  });

  test("returns null when closing the braces still does not parse", () => {
    expect(repairTruncatedJson('{"a":')).toBeNull();
  });
});
