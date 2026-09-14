import { describe, test, expect } from "bun:test";
import { detectRunaway } from "../runaway";

// ─────────────────────────────────────────────────────────────
// Regression: the MIN_RUN_CHARS span floor.
//
// Before the floor, a 1-char unit repeated 8 times produced a verdict, so
// ORDINARY output tripped the guard — an eight-space indent, a markdown table
// rule, trailing newlines, eight closing braces. The transport then cut the
// turn short and emitted finish_reason "length" while the Copilot server kept
// generating: the "stops streaming early" bug.
//
// These cases must stay null, and genuine loops must still trip.
// ─────────────────────────────────────────────────────────────
describe("short-run tolerance (MIN_RUN_CHARS)", () => {
  test("eight spaces of indentation is not a runaway", () => {
    expect(detectRunaway("function f() {\n        return 1;\n")).toBeNull();
  });

  test("a markdown table rule is not a runaway", () => {
    expect(detectRunaway("| col |\n| --------")).toBeNull();
  });

  test("eight trailing newlines are not a runaway", () => {
    expect(detectRunaway("done." + "\n".repeat(8))).toBeNull();
  });

  test("eight closing braces are not a runaway", () => {
    expect(detectRunaway("nested code" + "}".repeat(8))).toBeNull();
  });

  test("an ASCII heading rule is not a runaway", () => {
    expect(detectRunaway("Heading\n========")).toBeNull();
  });

  test("a run just under the floor stays null", () => {
    // 31 chars: no unit length can reach a 32-char span, whatever the repeat
    // count — the gate is unit.length × repeats, not repeats alone.
    expect(detectRunaway("preamble" + "-".repeat(31))).toBeNull();
  });

  test("a run of exactly MIN_RUN_CHARS still trips", () => {
    const v = detectRunaway("-".repeat(32));
    expect(v?.reason).toBe("repetition");
    expect(v?.keepLength).toBe(0);
  });

  test("a long unit crosses the floor within MIN_REPEATS", () => {
    // 5-char unit × 8 repeats = 40 chars — comfortably over the floor despite
    // the minimal repeat count.
    const v = detectRunaway("abcde".repeat(8));
    expect(v?.reason).toBe("repetition");
    expect(v?.unit).toBe("abcde");
  });

  test("a genuinely long single-char loop still trips", () => {
    const v = detectRunaway("preamble" + "-".repeat(400));
    expect(v?.reason).toBe("repetition");
    expect(v?.unit).toBe("-");
    expect(v?.keepLength).toBe("preamble".length);
  });

  test("a short 1-char run does not mask a long multi-char loop", () => {
    // The tail's final character run is short, but the longer repeating unit
    // must still be found — the scan must not stop at the first short run.
    const v = detectRunaway("preamble " + "</output>\n".repeat(40));
    expect(v?.reason).toBe("repetition");
    expect(v?.keepLength).toBe("preamble ".length);
  });
});
