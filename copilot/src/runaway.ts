// ─────────────────────────────────────────────────────────────
// Runaway-output guard.
//
// A weakly-aligned model behind the Copilot SDK can fall into degenerate token
// repetition and emit the same fragment forever (observed with `big-pickle`:
// `</content>\n</output>` repeated until the client gives up). The stream
// driver accumulates deltas until `assistant.turn_end`, which for such a turn
// never arrives — and the SSE keepalive actively holds the socket open, so the
// downstream client hangs instead of failing fast.
//
// This module is the pure, testable half of the fix: given the content
// accumulated so far, decide whether the turn has gone runaway and where the
// sane prefix ends. Deciding what to do about it (truncate, log, finish with
// `length`) stays in the transport layer.
// ─────────────────────────────────────────────────────────────

/** Longest repeating unit considered. Degenerate loops are short fragments. */
const MAX_UNIT_CHARS = 200;

/** Consecutive identical repetitions required before a turn counts as runaway. */
const MIN_REPEATS = 8;

/**
 * Minimum total span (unit length × repetitions) for a repetition verdict.
 *
 * Without this floor a 1-char unit repeated 8 times trips the guard, and that
 * is ORDINARY prose/code output — eight spaces of indentation in a TypeScript
 * or Python block, eight trailing newlines, `--------` in a markdown table,
 * `========` under a heading, eight closing braces. Each of those ended the
 * turn early with finish_reason "length" while the Copilot server kept
 * generating, which is exactly the "stops streaming early" symptom.
 *
 * A genuine degenerate loop runs for hundreds of characters, so the floor
 * still trips well inside a bounded prefix. Mirrors RUN_AWAY_GUARD_MIN_RUN_CHARS
 * in the mcp-qdrant proxy's runaway.ts, whose value this tracks.
 */
const MIN_RUN_CHARS = 32;

/**
 * Hard ceiling on a single turn's content, for runaway output that never
 * settles into a clean repeating unit (drifting counters, shuffled fragments).
 */
export const MAX_TURN_CHARS = 400_000;

/**
 * Scanning every delta would re-walk the tail thousands of times per turn.
 * The detector only runs once the accumulated length crosses a new multiple of
 * this interval — bounded work per turn, and a loop is still caught within a
 * few hundred wasted characters.
 */
const CHECK_INTERVAL_CHARS = 512;

export interface RunawayVerdict {
  /** Why the turn tripped the guard. */
  reason: "repetition" | "length";
  /** Length of the content to keep; everything past this is runaway noise. */
  keepLength: number;
  /** The repeating fragment, for logging. Empty for a `length` verdict. */
  unit: string;
  /** How many consecutive repetitions were observed. Zero for `length`. */
  repeats: number;
}

/** True when `text` ends with `unit` repeated at least `MIN_REPEATS` times. */
const tailRepeats = (text: string, unit: string): boolean => {
  const span = unit.length * MIN_REPEATS;
  if (text.length < span) return false;
  for (let i = text.length - span; i < text.length; i += unit.length) {
    if (!text.startsWith(unit, i)) return false;
  }
  return true;
};

/** Walk backwards over whole `unit` copies to find where the run began. */
const runStart = (text: string, unit: string): { start: number; repeats: number } => {
  let start = text.length;
  let repeats = 0;
  while (start >= unit.length && text.startsWith(unit, start - unit.length)) {
    start -= unit.length;
    repeats += 1;
  }
  return { start, repeats };
};

/**
 * Inspect accumulated turn content for runaway output.
 *
 * Returns `null` for healthy content — the overwhelmingly common case, and the
 * reason the caller's behaviour is byte-identical for normal turns. The
 * shortest repeating unit wins, so `abab...` reports `ab` rather than `abab`.
 */
export const detectRunaway = (text: string): RunawayVerdict | null => {
  for (let unitLen = 1; unitLen <= MAX_UNIT_CHARS; unitLen++) {
    if (text.length < unitLen * MIN_REPEATS) break;
    const unit = text.slice(text.length - unitLen);
    if (!tailRepeats(text, unit)) continue;
    const { start, repeats } = runStart(text, unit);
    // A short run (eight closing braces, an indent, a table rule) is a
    // plausible legitimate ending — only spans long enough to be a real loop
    // trip the guard. Keep scanning longer units: a short 1-char run can sit
    // inside a genuinely long multi-char loop.
    if (unit.length * repeats >= MIN_RUN_CHARS) {
      return { reason: "repetition", keepLength: start, unit, repeats };
    }
  }

  if (text.length >= MAX_TURN_CHARS) {
    return { reason: "length", keepLength: MAX_TURN_CHARS, unit: "", repeats: 0 };
  }

  return null;
};

/**
 * Stateful wrapper for the streaming path: feed it the accumulated content
 * after each delta and it runs {@link detectRunaway} on a fixed schedule
 * instead of on every event. Trips at most once — the caller unsubscribes on
 * the first verdict, and a second verdict for the same run would be noise.
 */
export const createRunawayGuard = () => {
  let nextCheckAt = CHECK_INTERVAL_CHARS;
  let tripped = false;

  return {
    check: (text: string): RunawayVerdict | null => {
      if (tripped || text.length < nextCheckAt) return null;
      nextCheckAt = text.length + CHECK_INTERVAL_CHARS;
      const verdict = detectRunaway(text);
      if (verdict) tripped = true;
      return verdict;
    },
  };
};

/** One-line summary of a verdict, safe to drop straight into a log. */
export const describeRunaway = (v: RunawayVerdict): string =>
  v.reason === "length"
    ? `turn exceeded ${MAX_TURN_CHARS} chars — truncated`
    : `runaway repetition ×${v.repeats} of ${JSON.stringify(
        v.unit.length > 60 ? `${v.unit.slice(0, 60)}…` : v.unit
      )} — truncated`;
