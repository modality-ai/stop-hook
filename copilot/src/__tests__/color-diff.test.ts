import { describe, test, expect } from "bun:test";
import { printColorDiff } from "../color-diff";

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

describe("printColorDiff", () => {
  test("returns empty string for falsy input", () => {
    expect(printColorDiff("")).toBe("");
    expect(printColorDiff(null as any)).toBe("");
    expect(printColorDiff(undefined as any)).toBe("");
  });

  test("colorizes header lines (--- and +++) in bold cyan", () => {
    const input = "--- a/foo.ts\n+++ b/foo.ts";
    expect(printColorDiff(input)).toBe(
      `${BOLD}${CYAN}--- a/foo.ts${RESET}\n${BOLD}${CYAN}+++ b/foo.ts${RESET}`
    );
  });

  test("colorizes hunk headers (@@) in cyan", () => {
    const input = "@@ -1,2 +1,2 @@";
    expect(printColorDiff(input)).toBe(`${CYAN}@@ -1,2 +1,2 @@${RESET}`);
  });

  test("colorizes removed lines (-) in red", () => {
    const input = "-old line";
    expect(printColorDiff(input)).toBe(`${RED}-old line${RESET}`);
  });

  test("colorizes added lines (+) in green", () => {
    const input = "+new line";
    expect(printColorDiff(input)).toBe(`${GREEN}+new line${RESET}`);
  });

  test("colorizes context lines in dim", () => {
    const input = " unchanged";
    expect(printColorDiff(input)).toBe(`${DIM} unchanged${RESET}`);
  });

  test("prioritizes --- / +++ over single - / +", () => {
    const input = "--- a/x\n+++ b/x\n-old\n+new\n ctx";
    const expected = [
      `${BOLD}${CYAN}--- a/x${RESET}`,
      `${BOLD}${CYAN}+++ b/x${RESET}`,
      `${RED}-old${RESET}`,
      `${GREEN}+new${RESET}`,
      `${DIM} ctx${RESET}`,
    ].join("\n");
    expect(printColorDiff(input)).toBe(expected);
  });

  test("is pure: does not mutate input and returns a string", () => {
    const input = "+x";
    const before = input;
    const out = printColorDiff(input);
    expect(typeof out).toBe("string");
    expect(input).toBe(before);
  });
});