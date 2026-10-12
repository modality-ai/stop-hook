// Coverage for the narration rescue extracted out of copilot-to-openai.
// Code-span and fence markers are built from char codes so this source carries
// no literal markers next to intent phrases.

import { describe, it, expect } from "bun:test";
import {
  bashRescueToolCall,
  extractFirstNarratedCommand,
  isNarratingToolIntent,
  looksLikeShellCommand,
  resolveTurnToolCall,
} from "../bash-rescue";

const B = String.fromCharCode(96);
const F = B + B + B;
const code = (s: string) => B + s + B;
const bashTools = [{ name: "Bash" }];
const narration = "I will now run " + code("git status --short");

describe("isNarratingToolIntent", () => {
  it("detects a stated intent", () => {
    expect(isNarratingToolIntent("Let me run the tests")).toBe(true);
  });

  it("ignores plain prose", () => {
    expect(isNarratingToolIntent("The tests pass.")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isNarratingToolIntent("")).toBe(false);
  });
});

describe("looksLikeShellCommand", () => {
  it("accepts a CLI with a flag", () => {
    expect(looksLikeShellCommand("git status --short")).toBe(true);
  });

  it("rejects a single word", () => {
    expect(looksLikeShellCommand("inside")).toBe(false);
  });

  it("rejects a URL", () => {
    expect(looksLikeShellCommand("https://example.com x")).toBe(false);
  });

  it("rejects a parenthetical bullet", () => {
    expect(looksLikeShellCommand("signal (long/short/wait)")).toBe(false);
  });

  it("rejects a run of prose words", () => {
    expect(looksLikeShellCommand("plus other tactical helpers shown in output")).toBe(false);
  });
});

describe("extractFirstNarratedCommand", () => {
  it("takes a fenced command first", () => {
    expect(extractFirstNarratedCommand(F + "bash\nls -la\n" + F)).toBe("ls -la");
  });

  it("takes an inline code span", () => {
    expect(extractFirstNarratedCommand(narration)).toBe("git status --short");
  });

  it("takes a numbered list item", () => {
    expect(extractFirstNarratedCommand("Steps:\n1. bun test --watch")).toBe("bun test --watch");
  });

  it("returns null when nothing looks runnable", () => {
    expect(extractFirstNarratedCommand("nothing to run here")).toBeNull();
  });
});

describe("bashRescueToolCall", () => {
  it("rescues a narrated command when Bash is available", () => {
    expect(JSON.parse(bashRescueToolCall(narration, bashTools)!.arguments).command).toBe("git status --short");
  });

  it("does nothing without a Bash tool", () => {
    expect(bashRescueToolCall(narration, [{ name: "Read" }])).toBeNull();
  });

  it("does nothing without stated intent", () => {
    expect(bashRescueToolCall(code("git status --short"), bashTools)).toBeNull();
  });
});

describe("resolveTurnToolCall", () => {
  const inline = { name: "Read", arguments: "{}" };

  it("returns the vetted inline call", () => {
    expect(resolveTurnToolCall(narration, inline, bashTools)).toBe(inline);
  });

  it("falls back to the rescue for pure narration", () => {
    expect(resolveTurnToolCall(narration, null, bashTools)?.name).toBe("Bash");
  });

  // Regression: a rejected literal whose arguments carry intent + a code span
  // used to be rescued into Bash, executing text from a Write's file content.
  it("never rescues when a rejected tool_use literal is present", () => {
    const lit = JSON.stringify({ tool_use: { name: "Write", input: { content: narration } } });
    expect(resolveTurnToolCall(lit, null, bashTools)).toBeNull();
  });
});
