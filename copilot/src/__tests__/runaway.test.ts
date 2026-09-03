import { describe, test, expect } from "bun:test";

// Import the REAL implementation — the detector is pure, so there is nothing
// to mock and no I/O to isolate.
import {
  detectRunaway,
  createRunawayGuard,
  describeRunaway,
  MAX_TURN_CHARS,
} from "../runaway";

// The fragment observed in the wild from `big-pickle`.
const LOOP_UNIT = "</content>\n</output>\n";

describe("detectRunaway", () => {
  test("returns null for ordinary prose", () => {
    expect(detectRunaway("The fix is a bounded guard on the delta accumulator.")).toBeNull();
  });

  test("returns null for an empty turn", () => {
    expect(detectRunaway("")).toBeNull();
  });

  test("returns null for repetition below the threshold", () => {
    expect(detectRunaway(`prefix${LOOP_UNIT.repeat(3)}`)).toBeNull();
  });

  test("catches the observed big-pickle loop and keeps the sane prefix", () => {
    const prefix = "Here is the answer.\n";
    const v = detectRunaway(prefix + LOOP_UNIT.repeat(40));

    expect(v).not.toBeNull();
    expect(v!.reason).toBe("repetition");
    expect(v!.unit).toBe(LOOP_UNIT);
    expect(v!.repeats).toBe(40);
    expect(v!.keepLength).toBe(prefix.length);
  });

  test("reports the shortest repeating unit", () => {
    const v = detectRunaway("start" + "ab".repeat(60));

    expect(v!.unit).toBe("ab");
    expect(v!.keepLength).toBe("start".length);
  });

  test("catches a single repeated character", () => {
    const v = detectRunaway("done" + "\n".repeat(50));

    expect(v!.unit).toBe("\n");
    expect(v!.keepLength).toBe("done".length);
  });

  test("trips on length when output never settles into a unit", () => {
    // Distinct fragments, so no repeating unit exists — only the ceiling fires.
    let text = "";
    for (let i = 0; text.length < MAX_TURN_CHARS; i++) text += `chunk-${i} `;

    const v = detectRunaway(text);
    expect(v!.reason).toBe("length");
    expect(v!.keepLength).toBe(MAX_TURN_CHARS);
  });

  test("long but healthy content below the ceiling passes", () => {
    let text = "";
    for (let i = 0; text.length < 50_000; i++) text += `line ${i}\n`;

    expect(detectRunaway(text)).toBeNull();
  });

  test("a repeating unit longer than the scan window is not misreported", () => {
    const unit = "x".repeat(300);
    const v = detectRunaway(unit.repeat(10));

    // The tail is also `x` repeated, so the shortest unit legitimately wins.
    expect(v!.unit).toBe("x");
  });
});

describe("createRunawayGuard", () => {
  test("stays silent while content is healthy", () => {
    const guard = createRunawayGuard();
    let text = "";
    for (let i = 0; i < 200; i++) {
      text += `delta ${i} of ordinary streamed prose\n`;
      expect(guard.check(text)).toBeNull();
    }
  });

  test("trips once a runaway run accumulates", () => {
    const guard = createRunawayGuard();
    let text = "Here is the answer.\n";
    let verdict = null;

    for (let i = 0; i < 500 && !verdict; i++) {
      text += LOOP_UNIT;
      verdict = guard.check(text);
    }

    expect(verdict).not.toBeNull();
    expect(verdict!.reason).toBe("repetition");
  });

  test("reports at most one verdict per turn", () => {
    const guard = createRunawayGuard();
    let text = "";
    let trips = 0;

    for (let i = 0; i < 800; i++) {
      text += LOOP_UNIT;
      if (guard.check(text)) trips++;
    }

    expect(trips).toBe(1);
  });
});

describe("describeRunaway", () => {
  test("summarises a repetition verdict with the fragment", () => {
    const v = detectRunaway("ok" + LOOP_UNIT.repeat(20))!;
    const line = describeRunaway(v);

    expect(line).toContain("runaway repetition");
    expect(line).toContain("20");
  });

  test("elides an overly long fragment", () => {
    const unit = `${"y".repeat(80)}Z`;
    const v = detectRunaway(unit.repeat(12))!;

    expect(describeRunaway(v).length).toBeLessThan(120);
  });

  test("summarises a length verdict without a fragment", () => {
    const line = describeRunaway({ reason: "length", keepLength: MAX_TURN_CHARS, unit: "", repeats: 0 });

    expect(line).toContain(String(MAX_TURN_CHARS));
  });
});
