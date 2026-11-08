// ─────────────────────────────────────────────────────────────
// Pure colorization of a unified diff.
//
// No I/O, no process spawning, no file access: given the raw text produced by
// `diff -u`, return the same text with ANSI color codes applied. Safe to use
// anywhere (tests, other modules) without side effects.
// ─────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/**
 * Apply ANSI colors to a unified diff string. Pure: input → output, no side
 * effects.
 */
export const printColorDiff = (rawDiff: string): string => {
  if (!rawDiff) return rawDiff ?? "";
  return rawDiff
    .split("\n")
    .map((line) => {
      if (line.startsWith("---") || line.startsWith("+++"))
        return `${BOLD}${CYAN}${line}${RESET}`;
      if (line.startsWith("@@")) return `${CYAN}${line}${RESET}`;
      if (line.startsWith("-")) return `${RED}${line}${RESET}`;
      if (line.startsWith("+")) return `${GREEN}${line}${RESET}`;
      return `${DIM}${line}${RESET}`;
    })
    .join("\n");
};
