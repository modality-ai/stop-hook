// Tests for the pure tool_use / Counter-result text transforms.
// Everything here imports the real production functions from ../tool-use-text —
// no re-implementations.

import { describe, expect, it } from "bun:test";
import {
  extractInlineToolUse,
  isCounterMethodRegistry,
  slimCounterResult,
  tidyToolUseJsonDetailed,
} from "../tool-use-text";

// A flat all-methods registry: ≥10 keys, no non-registry marker keys, and at
// least one value carrying a Counter call stub.
const registry = {
  help: "Display all available mission protocols",
  code: "Implement features",
  bash: "Convert natural language to bash",
  debug: "Execute testing and linting",
  github: "Explore a repository",
  mindmap: "Build a mindmap",
  recall: "Restore conversation context",
  remember: "Summarize the conversation",
  exit: "Exit the persona",
  "method-manager": "_Counter__ExecuteMethod({method: '*method-manager'})",
};

// ─── isCounterMethodRegistry ─────────────────────────────────────────────────
describe("isCounterMethodRegistry", () => {
  it("accepts a large flat map carrying an ExecuteMethod call stub", () => {
    expect(isCounterMethodRegistry(registry)).toBe(true);
  });

  it("accepts a registry whose stub is nested inside an object value", () => {
    const nested = { ...registry, "method-manager": { hint: "_Counter__Deploy" } };
    expect(isCounterMethodRegistry(nested)).toBe(true);
  });

  it("rejects a map with fewer than 10 keys", () => {
    expect(isCounterMethodRegistry({ a: "_Counter__Deploy" })).toBe(false);
  });

  it("rejects a chunk carrying a non-registry marker key", () => {
    expect(isCounterMethodRegistry({ ...registry, instructions: [] })).toBe(false);
  });

  it("rejects a large flat map with no Counter call stub", () => {
    const { "method-manager": _drop, ...rest } = registry;
    expect(isCounterMethodRegistry({ ...rest, extra: "plain", another: "plain" })).toBe(false);
  });

  it("rejects arrays", () => {
    expect(isCounterMethodRegistry([1, 2, 3])).toBe(false);
  });

  it("rejects null", () => {
    expect(isCounterMethodRegistry(null)).toBe(false);
  });
});

// ─── slimCounterResult ───────────────────────────────────────────────────────
describe("slimCounterResult", () => {
  it("drops the flat registry chunk", () => {
    expect(slimCounterResult(JSON.stringify(registry))).toBe("");
  });

  it("keeps a chunk carrying an instructions key", () => {
    const keep = JSON.stringify({ instructions: [{ message: "*debug EXECUTED!" }] });
    expect(slimCounterResult(keep)).toBe(keep);
  });

  it("drops only the registry when chunks are interleaved", () => {
    const keep = JSON.stringify({ methodContent: { name: "*debug" } });
    expect(slimCounterResult(`${keep}\n\n${JSON.stringify(registry)}`)).toBe(`${keep}\n\n`);
  });

  it("preserves prose sitting between chunks", () => {
    const keep = JSON.stringify({ message: "hi" });
    expect(slimCounterResult(`before ${keep} after`)).toBe(`before ${keep} after`);
  });

  it("passes through a chunk that fails to parse", () => {
    expect(slimCounterResult('{not json}')).toBe('{not json}');
  });

  it("preserves the tail when an object never closes", () => {
    expect(slimCounterResult('lead {"a":1')).toBe('lead {"a":1');
  });

  it("returns brace-free text unchanged", () => {
    expect(slimCounterResult("just prose")).toBe("just prose");
  });

  it("returns empty string unchanged", () => {
    expect(slimCounterResult("")).toBe("");
  });
});

// ─── tidyToolUseJsonDetailed ─────────────────────────────────────────────────
describe("tidyToolUseJsonDetailed", () => {
  it("reports absent when the text has no tool_use marker", () => {
    expect(tidyToolUseJsonDetailed('{"a":1}')).toEqual({ text: '{"a":1}', outcome: "absent" });
  });

  it("reports absent for empty input", () => {
    expect(tidyToolUseJsonDetailed("").outcome).toBe("absent");
  });

  it('reports absent when "tool_use" appears but no brace does', () => {
    expect(tidyToolUseJsonDetailed('the "tool_use" rule').outcome).toBe("absent");
  });

  it("reports clean and returns the literal when it already parses", () => {
    const text = '{"tool_use":{"name":"Bash","input":{}}}';
    expect(tidyToolUseJsonDetailed(text)).toEqual({ text, outcome: "clean" });
  });

  it("strips a leading prose prefix before the literal", () => {
    const literal = '{"tool_use":{"name":"Bash","input":{}}}';
    expect(tidyToolUseJsonDetailed(`sure: ${literal}`)).toEqual({ text: literal, outcome: "clean" });
  });

  it("unwraps a ```json fenced literal", () => {
    const literal = '{"tool_use":{"name":"Read","input":{"file_path":"/a"}}}';
    expect(tidyToolUseJsonDetailed('```json\n' + literal + '\n```')).toEqual({
      text: literal,
      outcome: "clean",
    });
  });

  it("repairs a literal truncated mid-object", () => {
    const result = tidyToolUseJsonDetailed('{"tool_use":{"name":"Bash","input":{"command":"ls"');
    expect(result.outcome).toBe("repaired");
    expect(JSON.parse(result.text)).toEqual({
      tool_use: { name: "Bash", input: { command: "ls" } },
    });
  });

  it("reports unrepairable and returns input verbatim on an unterminated string", () => {
    const text = '{"tool_use":{"name":"Bash","input":{"command":"ls';
    expect(tidyToolUseJsonDetailed(text)).toEqual({ text, outcome: "unrepairable" });
  });

  it("reports unrepairable when there are more closers than openers", () => {
    const text = '{"tool_use":{"name":"Bash"}}}';
    expect(tidyToolUseJsonDetailed(text).outcome).toBe("unrepairable");
  });
});

// ─── extractInlineToolUse ────────────────────────────────────────────────────
describe("extractInlineToolUse", () => {
  it("extracts name and stringified input from a bare literal", () => {
    expect(extractInlineToolUse('{"tool_use":{"name":"Bash","input":{"command":"ls"}}}')).toEqual({
      name: "Bash",
      arguments: '{"command":"ls"}',
    });
  });

  it("drops trailing prose after the balanced literal", () => {
    const out = extractInlineToolUse('{"tool_use":{"name":"Read","input":{}}} then I will explain');
    expect(out).toEqual({ name: "Read", arguments: "{}" });
  });

  it("unwraps a fenced literal", () => {
    const out = extractInlineToolUse('```json\n{"tool_use":{"name":"Edit","input":{"a":1}}}\n```');
    expect(out).toEqual({ name: "Edit", arguments: '{"a":1}' });
  });

  it("defaults arguments to {} when input is missing", () => {
    expect(extractInlineToolUse('{"tool_use":{"name":"Bash"}}')).toEqual({
      name: "Bash",
      arguments: "{}",
    });
  });

  it("preserves an escaped quote inside an argument string", () => {
    const out = extractInlineToolUse('{"tool_use":{"name":"Bash","input":{"command":"echo \\"hi\\""}}}');
    expect(JSON.parse(out!.arguments)).toEqual({ command: 'echo "hi"' });
  });

  it("returns null when the text has no tool_use marker", () => {
    expect(extractInlineToolUse('{"name":"Bash"}')).toBeNull();
  });

  it("returns null when tool_use carries no name", () => {
    expect(extractInlineToolUse('{"tool_use":{"input":{}}}')).toBeNull();
  });

  it("returns null when the name is an empty string", () => {
    expect(extractInlineToolUse('{"tool_use":{"name":"","input":{}}}')).toBeNull();
  });

  it("returns null when the literal never closes", () => {
    expect(extractInlineToolUse('{"tool_use":{"name":"Bash","input":{"command":"ls"')).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractInlineToolUse("")).toBeNull();
  });
});
