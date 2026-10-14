// Tests for the pure tool_use / Counter-result text transforms.
// Everything here imports the real production functions from ../tool-use-text —
// no re-implementations.

import { describe, expect, it } from "bun:test";
import {
  extractInlineToolUse,
  isCounterMethodRegistry,
  slimCounterResult,
  tidyToolUseJsonDetailed,
  xmlToolUseToJson,
  findToolMarkupStart,
  type XmlToolSchemas,
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

  it("trims prose around a literal, so callers must keep the original when no call is extracted", () => {
    const literal = '{"tool_use":{"name":"Nope","input":{}}}';
    const original = `Before the call. ${literal}`;
    const tidied = tidyToolUseJsonDetailed(original);
    // Leading prose is dropped by design...
    expect(tidied.text).toBe(literal);
    expect(tidied.text).not.toBe(original);
    // ...and a validator-rejected literal yields no call, so the bridge
    // must emit the untrimmed original (fullText) for the upstream proxy.
    expect(extractInlineToolUse(tidied.text, () => false)).toBeNull();
    expect(original).toContain("Before the call.");
  });

  it("returns the full original text when trailing prose makes the literal unrepairable", () => {
    const original = 'Before. {"tool_use":{"name":"Bash","input":{}}} After.';
    expect(tidyToolUseJsonDetailed(original)).toEqual({ text: original, outcome: "unrepairable" });
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

  // Both shapes converge on this parser, so the validation the XML path applies
  // has to run here too — otherwise an unknown tool is rejected as `<invoke …>`
  // markup but accepted as a `{"tool_use": …}` literal.
  describe("with a validator", () => {
    const validate = (name: string, input: Record<string, any>): boolean =>
      name === "Bash" && Object.keys(input).every((k) => k === "command");

    it("accepts a vetted call", () => {
      const text = '{"tool_use":{"name":"Bash","input":{"command":"pwd"}}}';
      expect(extractInlineToolUse(text, validate)).toEqual({
        name: "Bash",
        arguments: '{"command":"pwd"}',
      });
    });

    it("rejects an unknown tool", () => {
      const text = '{"tool_use":{"name":"Nope","input":{"x":1}}}';
      expect(extractInlineToolUse(text, validate)).toBeNull();
    });

    it("rejects an undeclared parameter", () => {
      const text = '{"tool_use":{"name":"Bash","input":{"bogus":"ls"}}}';
      expect(extractInlineToolUse(text, validate)).toBeNull();
    });

    it("does not consult a later call once the first literal validates", () => {
      // Only the balanced first object is a candidate, so a rejected second call
      // never becomes the answer — the turn runs the first one or nothing.
      const text = '{"tool_use":{"name":"Bash","input":{"command":"pwd"}}} <invoke name="Nope">';
      expect(extractInlineToolUse(text, validate)?.name).toBe("Bash");
    });

    it("returns null rather than a partial literal when it never closes", () => {
      const text = '{"tool_use":{"name":"Bash","input":{"command":"pwd"';
      expect(extractInlineToolUse(text, validate)).toBeNull();
    });

    it("treats missing input as an empty object", () => {
      const text = '{"tool_use":{"name":"Bash"}}';
      expect(extractInlineToolUse(text, validate)).toEqual({ name: "Bash", arguments: "{}" });
    });

    it("keeps the unvetted behaviour when no validator is supplied", () => {
      const text = '{"tool_use":{"name":"Nope","input":{"x":1}}}';
      expect(extractInlineToolUse(text)?.name).toBe("Nope");
    });
  });
});

// ─── xmlToolUseToJson ────────────────────────────────────────────────────────
// The `antml:` prefix is assembled at runtime so this file never contains the
// literal tag text (it would be re-interpreted by tools that read the source).
const NS = "antml:";

describe("xmlToolUseToJson", () => {
  it("converts a fully-formed function_calls block", () => {
    const text = [
      "<function_calls>",
      '<invoke name="bash">',
      '<parameter name="command">ls -la</parameter>',
      "</invoke>",
      "</function_calls>",
    ].join("\n");
    expect(JSON.parse(xmlToolUseToJson(text))).toEqual({
      tool_use: { name: "bash", input: { command: "ls -la" } },
    });
  });

  it("converts the namespaced variant", () => {
    const text = `<${NS}invoke name="Read"><${NS}parameter name="file_path">/tmp/a.ts</${NS}parameter></${NS}invoke>`;
    expect(JSON.parse(xmlToolUseToJson(text))).toEqual({
      tool_use: { name: "Read", input: { file_path: "/tmp/a.ts" } },
    });
  });

  it("drops prose surrounding the block", () => {
    const text = 'TARGET: read the file\n\n<invoke name="Read">\n<parameter name="limit">100</parameter>\n</invoke>';
    expect(JSON.parse(xmlToolUseToJson(text))).toEqual({
      tool_use: { name: "Read", input: { limit: 100 } },
    });
  });

  // A truncated call must never run: half a command can be destructive.
  it("leaves an unterminated invoke unconverted", () => {
    const text = '<invoke name="bash">\n<parameter name="command">test -f x && echo EXISTS';
    expect(xmlToolUseToJson(text)).toBe(text);
  });

  it("ignores an invoke block inside a ``` fence", () => {
    const text = 'Example:\n```\n<invoke name="bash"><parameter name="command">rm -rf /</parameter></invoke>\n```';
    expect(xmlToolUseToJson(text)).toBe(text);
    expect(findToolMarkupStart(text)).toBe(-1);
  });

  it("ignores an invoke block inside inline backticks", () => {
    const text = 'Use `<invoke name="bash"><parameter name="command">ls</parameter></invoke>` like this';
    expect(xmlToolUseToJson(text)).toBe(text);
    expect(findToolMarkupStart(text)).toBe(-1);
  });

  describe("with tool schemas", () => {
    const schemas: XmlToolSchemas = new Map([
      ["Bash", { canonical: "Bash", types: { command: "string", timeout: "number" } }],
      ["Write", { canonical: "Write", types: { file_path: "string", content: "string" } }],
    ]);

    it("rejects an unknown tool name", () => {
      const text = '<invoke name="Nope"><parameter name="x">1</parameter></invoke>';
      expect(xmlToolUseToJson(text, schemas)).toBe(text);
    });

    it("rejects an undeclared parameter", () => {
      const text = '<invoke name="Bash"><parameter name="bogus">ls</parameter></invoke>';
      expect(xmlToolUseToJson(text, schemas)).toBe(text);
    });

    it("resolves the name case-insensitively", () => {
      const text = '<invoke name="bash"><parameter name="command">ls</parameter></invoke>';
      expect(JSON.parse(xmlToolUseToJson(text, schemas)).tool_use.name).toBe("Bash");
    });

    it("keeps string-typed fields verbatim and coerces others", () => {
      const text = '<invoke name="Write"><parameter name="file_path">/a</parameter><parameter name="content">123</parameter></invoke>';
      expect(JSON.parse(xmlToolUseToJson(text, schemas)).tool_use.input).toEqual({ file_path: "/a", content: "123" });
      const bash = '<invoke name="Bash"><parameter name="command">true</parameter><parameter name="timeout">5000</parameter></invoke>';
      expect(JSON.parse(xmlToolUseToJson(bash, schemas)).tool_use.input).toEqual({ command: "true", timeout: 5000 });
    });
  });

  it("converts a real call that follows a fenced example", () => {
    const text = '```\n<invoke name="bash"><parameter name="command">rm -rf /</parameter></invoke>\n```\n<invoke name="bash"><parameter name="command">pwd</parameter></invoke>';
    expect(JSON.parse(xmlToolUseToJson(text))).toEqual({
      tool_use: { name: "bash", input: { command: "pwd" } },
    });
    expect(findToolMarkupStart(text)).toBe(text.lastIndexOf("<invoke"));
  });

  it("keeps shell text as a string and parses JSON-shaped values", () => {
    const text = [
      '<invoke name="Edit">',
      '<parameter name="command">echo 1 | head -20</parameter>',
      '<parameter name="replace_all">true</parameter>',
      '<parameter name="edits">[{"old":"a"}]</parameter>',
      "</invoke>",
    ].join("\n");
    expect(JSON.parse(xmlToolUseToJson(text)).tool_use.input).toEqual({
      command: "echo 1 | head -20",
      replace_all: true,
      edits: [{ old: "a" }],
    });
  });

  it("decodes XML entities in parameter bodies", () => {
    const text = '<invoke name="Bash"><parameter name="command">echo &quot;a&amp;b&quot; &gt; f</parameter></invoke>';
    expect(JSON.parse(xmlToolUseToJson(text)).tool_use.input.command).toBe('echo "a&b" > f');
  });

  it("converts only the first invoke block", () => {
    const text = '<invoke name="A"><parameter name="x">1</parameter></invoke><invoke name="B"></invoke>';
    expect(JSON.parse(xmlToolUseToJson(text))).toEqual({ tool_use: { name: "A", input: { x: 1 } } });
  });

  it("returns text without tool markup verbatim", () => {
    expect(xmlToolUseToJson("the parameter is optional")).toBe("the parameter is optional");
    expect(xmlToolUseToJson("<div>hello</div>")).toBe("<div>hello</div>");
  });

  it("returns text verbatim when the invoke tag carries no name", () => {
    expect(xmlToolUseToJson("<invoke>")).toBe("<invoke>");
  });

  it("returns empty input verbatim", () => {
    expect(xmlToolUseToJson("")).toBe("");
  });

  // An unclosed fence is the one case where streaming and final conversion must
  // disagree. Mid-stream the fence may still close, so the stream stays in text
  // mode; at turn end it never will, so a call leaking out of it is real.
  describe("an unclosed fence", () => {
    const text = 'Snippet:\n```\nrm -rf /\n<invoke name="bash"><parameter name="command">pwd</parameter></invoke>';

    it("keeps the streaming check in text mode", () => {
      expect(findToolMarkupStart(text)).toBe(-1);
    });

    it("still converts the call at turn end", () => {
      expect(JSON.parse(xmlToolUseToJson(text))).toEqual({
        tool_use: { name: "bash", input: { command: "pwd" } },
      });
    });

    it("stays verbatim when no call follows the fence", () => {
      const prose = "Snippet:\n```\nrm -rf /\n";
      expect(xmlToolUseToJson(prose)).toBe(prose);
      expect(findToolMarkupStart(prose)).toBe(-1);
    });
  });
});

// Regression: fence markers inside a JSON string must never slice the payload.
// Built from char codes so this source carries no literal fence marker.
describe("extractInlineToolUse with fence markers inside string arguments", () => {
  const B = String.fromCharCode(96);
  const F = B + B + B;
  const all = () => true;
  const writeLiteral = (content: string) =>
    JSON.stringify({ tool_use: { name: "Write", input: { file_path: "/tmp/x.ts", content } } });

  it("keeps content with one fence marker intact", () => {
    const body = "const a = /" + F + "(bash)?/;\n";
    const r = extractInlineToolUse(writeLiteral(body), all);
    expect(JSON.parse(r!.arguments).content).toBe(body);
  });

  it("keeps content with two fence markers intact", () => {
    const body = "const a = /" + F + "(bash)?x" + F + "/;\n";
    const r = extractInlineToolUse(writeLiteral(body), all);
    expect(JSON.parse(r!.arguments).content).toBe(body);
  });

  it("keeps an intent phrase beside a backticked command as plain content", () => {
    const body = "// I will now run " + B + "use-stock rules --eval --json" + B + "\n";
    const r = extractInlineToolUse(writeLiteral(body), all);
    expect(r!.name).toBe("Write");
  });

  it("still prefers an unfenced literal over a fenced example", () => {
    const fenced = F + "json\n" + JSON.stringify({ tool_use: { name: "Bash", input: { command: "rm -rf /" } } }) + "\n" + F;
    const real = JSON.stringify({ tool_use: { name: "Bash", input: { command: "pwd" } } });
    const r = extractInlineToolUse(fenced + "\n" + real, all);
    expect(JSON.parse(r!.arguments).command).toBe("pwd");
  });

  it("returns null when the only literal is rejected", () => {
    expect(extractInlineToolUse(writeLiteral("x"), () => false)).toBeNull();
  });
});

// Literal selection across several tool_use literals (string-aware scanner path).
describe("extractInlineToolUse literal selection", () => {
  const B = String.fromCharCode(96);
  const F = B + B + B;
  const lit = (command: string) => JSON.stringify({ tool_use: { name: "Bash", input: { command } } });
  const fence = (s: string) => F + "json\n" + s + "\n" + F;
  const cmd = (r: { arguments: string } | null) => (r ? JSON.parse(r.arguments).command : null);

  it("takes the last literal when every literal is fenced", () => {
    expect(cmd(extractInlineToolUse(fence(lit("a")) + "\n" + fence(lit("b")), () => true))).toBe("b");
  });

  it("skips a rejected literal and takes the next accepted one", () => {
    const validate = (_n: string, input: Record<string, any>) => input.command !== "bad";
    expect(cmd(extractInlineToolUse(lit("bad") + " " + lit("good"), validate))).toBe("good");
  });

  it("takes the first of two unfenced literals", () => {
    expect(cmd(extractInlineToolUse(lit("first") + " " + lit("second"), () => true))).toBe("first");
  });

  it("drops prose surrounding an unfenced literal", () => {
    expect(cmd(extractInlineToolUse("Running it now: " + lit("pwd") + " done.", () => true))).toBe("pwd");
  });

  it("ignores a non-object tool_use mention in prose", () => {
    expect(extractInlineToolUse('the "tool_use" key is required', () => true)).toBeNull();
  });

  it("falls back to the legacy path for a literal with a trailing brace typo", () => {
    const text = '{"tool_use":{"name":"Bash","input":{"command":"pwd"}}}}';
    expect(cmd(extractInlineToolUse(text, () => true))).toBe("pwd");
  });
});

describe("extractInlineToolUse flattened literal", () => {
  it("recovers arguments placed beside name instead of under input", () => {
    const text = '{"tool_use":{"name":"Bash","command":"ls -la"}}';
    expect(extractInlineToolUse(text)).toEqual({ name: "Bash", arguments: JSON.stringify({ command: "ls -la" }) });
  });

  it("accepts arguments as an alias for input", () => {
    const text = '{"tool_use":{"name":"Read","arguments":{"file_path":"/a"}}}';
    expect(extractInlineToolUse(text)).toEqual({ name: "Read", arguments: JSON.stringify({ file_path: "/a" }) });
  });

  it("accepts parameters as an alias for input", () => {
    const text = '{"tool_use":{"name":"Read","parameters":{"file_path":"/a"}}}';
    expect(extractInlineToolUse(text)).toEqual({ name: "Read", arguments: JSON.stringify({ file_path: "/a" }) });
  });

  // The scanner path and the first-fence fallback share one normalizer, so all
  // four accepted argument shapes must resolve identically.
  it("resolves every accepted argument shape to the same call", () => {
    const expected = { name: "Bash", arguments: JSON.stringify({ command: "ls" }) };
    for (const body of [
      '{"name":"Bash","input":{"command":"ls"}}',
      '{"name":"Bash","arguments":{"command":"ls"}}',
      '{"name":"Bash","parameters":{"command":"ls"}}',
      '{"name":"Bash","command":"ls"}',
    ]) {
      expect(extractInlineToolUse(`{"tool_use":${body}}`)).toEqual(expected);
    }
  });

  // isKnownToolCall only checks DECLARED keys, so an empty envelope would let
  // Bash({}) pass the gate and silently drop the model's real command.
  it("prefers a populated sibling over an empty input envelope", () => {
    const expected = { name: "Bash", arguments: JSON.stringify({ command: "ls" }) };
    for (const body of [
      '{"name":"Bash","input":{},"command":"ls"}',
      '{"name":"Bash","input":{},"arguments":{"command":"ls"}}',
      '{"name":"Bash","input":{},"parameters":{"command":"ls"}}',
    ]) {
      expect(extractInlineToolUse(`{"tool_use":${body}}`)).toEqual(expected);
    }
  });

  // Without the validator the raw shape surfaces; with it, the call is rejected
  // rather than executed empty.
  it("never launder a non-object envelope into an empty call", () => {
    for (const body of [
      '{"name":"Bash","input":"{\\"command\\":\\"ls\\"}"}',
      '{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}',
    ]) {
      expect(extractInlineToolUse(`{"tool_use":${body}}`, () => false)).toBeNull();
      expect(extractInlineToolUse(`{"tool_use":${body}}`)?.arguments).not.toBe("{}");
    }
  });
});
