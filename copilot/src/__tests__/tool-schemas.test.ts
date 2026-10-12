// ─────────────────────────────────────────────────────────────
// Coverage for the pure tool-schema shaping extracted out of copilot-to-openai.
//
// The integration block matters most: the schema map is keyed by CANONICAL tool
// name, so an MCP tool's alias form (`_suffix`, suffix-only) only resolves
// downstream if the canonical `mcp__server___tool` name is what got stored.
// ─────────────────────────────────────────────────────────────

import { beforeEach, describe, it, expect } from "bun:test";
import {
  __resetSeenMcpToolNames,
  aliasMapForTools,
  buildXmlToolSchemas,
  isKnownToolCall,
  normalizeTool,
  normalizeTools,
  softenAggressiveTrigger,
} from "../tool-schemas";
import { extractInlineToolUse, xmlToolUseToJson, type XmlToolSchemas } from "../tool-use-text";

// The MCP-name registry is module-level; clear it so one case's tools never
// leak into another's schema map.
beforeEach(() => __resetSeenMcpToolNames());

const anthropicTool = (name: string, properties: Record<string, any> = {}, required: string[] = []) => ({
  name,
  description: `${name} tool`,
  input_schema: { type: "object", properties, required },
});

const bashSchemas = (properties: Record<string, any>) =>
  buildXmlToolSchemas([anthropicTool("Bash", properties)]);

const openAiTool = (name: string, properties: Record<string, any> = {}) => ({
  type: "function",
  function: { name, description: `${name} tool`, parameters: { type: "object", properties } },
});

describe("normalizeTool", () => {
  it("returns null for a non-object", () => {
    expect(normalizeTool(null)).toBeNull();
  });

  it("returns null for a tool with no name", () => {
    expect(normalizeTool({ description: "anon" })).toBeNull();
  });

  it("returns null for an empty-string name", () => {
    expect(normalizeTool({ name: "" })).toBeNull();
  });

  it("normalizes the Anthropic shape", () => {
    const t = normalizeTool(anthropicTool("Bash", { command: { type: "string" } }));
    expect(t?.name).toBe("Bash");
    expect(t?.input_schema.properties.command.type).toBe("string");
  });

  it("normalizes the OpenAI shape", () => {
    const t = normalizeTool(openAiTool("Write", { file_path: { type: "string" } }));
    expect(t?.name).toBe("Write");
    expect(t?.input_schema.properties.file_path.type).toBe("string");
  });

  it("keeps the canonical mcp__server___tool name", () => {
    const t = normalizeTool(anthropicTool("mcp__counter___counter", {}));
    expect(t?.name).toBe("mcp__counter___counter");
  });

  it("keeps the canonical name when the OpenAI shape carries the mcp prefix", () => {
    const t = normalizeTool(openAiTool("mcp__counter___counter", {}));
    expect(t?.name).toBe("mcp__counter___counter");
  });

  it("defaults the input schema to an empty object when neither shape declares one", () => {
    expect(normalizeTool({ name: "Bare" })?.input_schema).toEqual({});
  });
});

describe("normalizeTools", () => {
  it("returns an empty list for undefined input", () => {
    expect(normalizeTools(undefined)).toEqual([]);
  });

  it("drops entries that cannot be normalized", () => {
    const tools = normalizeTools([anthropicTool("Bash"), null, { description: "anon" }, anthropicTool("Read")]);
    expect(tools.map((t) => t.name)).toEqual(["Bash", "Read"]);
  });
});

describe("buildXmlToolSchemas", () => {
  it("returns an empty map when no tools are supplied", () => {
    expect(buildXmlToolSchemas(undefined).size).toBe(0);
  });

  it("maps a tool name to its declared property types", () => {
    const schemas = bashSchemas({ command: { type: "string" }, timeout: { type: "number" } });
    expect(schemas.get("Bash")?.types).toEqual({ command: "string", timeout: "number" });
  });

  it("records undefined for a property with no declared type", () => {
    const schemas = bashSchemas({ command: {}, other: { description: "x" } });
    expect(schemas.get("Bash")?.types).toEqual({ command: undefined, other: undefined });
  });

  it("stores the canonical name for an mcp tool", () => {
    const schemas = buildXmlToolSchemas([anthropicTool("mcp__counter___counter", { query: { type: "string" } })]);
    expect(schemas.get("mcp__counter___counter")?.types).toEqual({ query: "string" });
  });

  it("keys an mcp tool's alias forms to that same canonical name", () => {
    const schemas = buildXmlToolSchemas([anthropicTool("mcp__counter___counter", { query: { type: "string" } })]);
    for (const alias of ["counter", "_counter", "counter___counter"]) {
      expect(schemas.get(alias)?.canonical).toBe("mcp__counter___counter");
      expect(schemas.get(alias)?.types).toEqual({ query: "string" });
    }
  });

  it("gives a tool with no properties an empty type record", () => {
    const schemas = buildXmlToolSchemas([anthropicTool("Ping")]);
    expect(schemas.get("Ping")?.types).toEqual({});
  });

  it("stores every explicitly supplied tool", () => {
    const schemas = buildXmlToolSchemas([anthropicTool("Bash"), anthropicTool("Read")]);
    expect(schemas.has("Bash")).toBe(true);
    expect(schemas.has("Read")).toBe(true);
  });

  it("prefers the canonical declaration over another tool's derived alias", () => {
    // `Bash` is supplied explicitly; the derived `_Bash` alias of an mcp tool
    // must not overwrite it.
    const schemas = buildXmlToolSchemas([
      anthropicTool("Bash", { command: { type: "string" } }),
      anthropicTool("mcp__x___Bash", { other: { type: "number" } }),
    ]);
    expect(schemas.get("Bash")?.types).toEqual({ command: "string" });
  });

  it("keeps that precedence when the mcp tool is listed first", () => {
    // Same pair, reversed list. Precedence must come from the name being
    // canonical, not from which tool the array happened to carry first.
    const schemas = buildXmlToolSchemas([
      anthropicTool("mcp__x___Bash", { other: { type: "number" } }),
      anthropicTool("Bash", { command: { type: "string" } }),
    ]);
    expect(schemas.get("Bash")?.types).toEqual({ command: "string" });
    expect(schemas.get("mcp__x___Bash")?.types).toEqual({ other: "number" });
  });
});

describe("aliasMapForTools", () => {
  it("maps a short mcp suffix to the canonical tool name", () => {
    const aliases = aliasMapForTools([anthropicTool("mcp__counter___counter")]);
    expect(aliases.get("counter")).toBe("mcp__counter___counter");
    expect(aliases.get("_counter")).toBe("mcp__counter___counter");
  });

  it("resolves a canonical name to itself even when an mcp alias claims it", () => {
    const aliases = aliasMapForTools([
      anthropicTool("mcp__x___Bash"),
      anthropicTool("Bash"),
    ]);
    expect(aliases.get("Bash")).toBe("Bash");
  });
});

describe("isKnownToolCall", () => {
  const schemas = bashSchemas({ command: { type: "string" } });

  it("accepts a declared tool with only declared parameters", () => {
    expect(isKnownToolCall("Bash", { command: "pwd" }, schemas)).toBe(true);
  });

  it("rejects an unknown tool", () => {
    expect(isKnownToolCall("Nope", { x: 1 }, schemas)).toBe(false);
  });

  it("rejects an undeclared parameter", () => {
    expect(isKnownToolCall("Bash", { bogus: "ls" }, schemas)).toBe(false);
  });

  it("treats a missing input object as empty", () => {
    expect(isKnownToolCall("Bash", undefined as any, schemas)).toBe(true);
  });

  it("accepts arbitrary parameters for a tool registered without declarations", () => {
    const bare = buildXmlToolSchemas([anthropicTool("Ping")]);
    expect(isKnownToolCall("Ping", { anything: 1 }, bare)).toBe(true);
  });

  // An empty map means the tool list for the turn is unknown — the client
  // omitted it and no MCP tool has been seen. The XML path converts such a call
  // leniently, so a gate that rejected it would leave the turn printing markup.
  it("accepts any call when the schema map is empty", () => {
    const unknown: XmlToolSchemas = new Map();
    expect(isKnownToolCall("Anything", { whatever: 1 }, unknown)).toBe(true);
  });

  it("keeps a call the XML path converted when the tool list is unknown", () => {
    const unknown: XmlToolSchemas = new Map();
    const raw = '<invoke name="Bash"><parameter name="command">pwd</parameter></invoke>';
    const converted = xmlToolUseToJson(raw, unknown);
    expect(converted).not.toBe(raw);
    expect(extractInlineToolUse(converted, (name, input) => isKnownToolCall(name, input, unknown))).toEqual({
      name: "Bash",
      arguments: '{"command":"pwd"}',
    });
  });
});

describe("buildXmlToolSchemas → xmlToolUseToJson integration", () => {
  it("rejects a call to a tool the schema does not know", () => {
    const text = '<invoke name="Nope"><parameter name="x">1</parameter></invoke>';
    expect(xmlToolUseToJson(text, bashSchemas({ command: { type: "string" } }))).toBe(text);
  });

  it("resolves a lowercase invoke name to the canonical schema key", () => {
    const text = '<invoke name="bash"><parameter name="command">ls</parameter></invoke>';
    const schemas = bashSchemas({ command: { type: "string" } });
    expect(JSON.parse(xmlToolUseToJson(text, schemas)).tool_use.name).toBe("Bash");
  });

  it("keeps a declared string field verbatim instead of coercing it", () => {
    const schemas = buildXmlToolSchemas([anthropicTool("Write", { content: { type: "string" } })]);
    const text = '<invoke name="Write"><parameter name="content">123</parameter></invoke>';
    expect(JSON.parse(xmlToolUseToJson(text, schemas)).tool_use.input).toEqual({ content: "123" });
  });

  it("coerces a declared number field", () => {
    const text = '<invoke name="Bash"><parameter name="timeout">5000</parameter></invoke>';
    const schemas = bashSchemas({ timeout: { type: "number" } });
    expect(JSON.parse(xmlToolUseToJson(text, schemas)).tool_use.input).toEqual({ timeout: 5000 });
  });

  it("rejects a parameter the schema does not declare", () => {
    const text = '<invoke name="Bash"><parameter name="bogus">ls</parameter></invoke>';
    expect(xmlToolUseToJson(text, bashSchemas({ command: { type: "string" } }))).toBe(text);
  });

  it("stays lenient when a tool declares no properties", () => {
    const schemas = buildXmlToolSchemas([anthropicTool("Ping")]);
    const text = '<invoke name="Ping"><parameter name="anything">1</parameter></invoke>';
    expect(JSON.parse(xmlToolUseToJson(text, schemas)).tool_use.input).toEqual({ anything: 1 });
  });

  it("resolves an mcp tool invoked by its bare suffix", () => {
    const schemas = buildXmlToolSchemas([anthropicTool("mcp__counter___counter", { method: { type: "string" } })]);
    const text = '<invoke name="counter"><parameter name="method">*help</parameter></invoke>';
    expect(JSON.parse(xmlToolUseToJson(text, schemas)).tool_use.name).toBe("mcp__counter___counter");
  });

  it("resolves an mcp tool invoked by its _suffix form", () => {
    const schemas = buildXmlToolSchemas([anthropicTool("mcp__counter___counter", { method: { type: "string" } })]);
    const text = '<invoke name="_counter"><parameter name="method">*help</parameter></invoke>';
    expect(JSON.parse(xmlToolUseToJson(text, schemas)).tool_use.name).toBe("mcp__counter___counter");
  });

  it("validates a built-in against its own schema when an mcp alias shadows it", () => {
    // `mcp__x___Bash` listed first contributes a `Bash` alias. If that alias
    // claimed the key, a real Bash call carrying `command` would be rejected as
    // an undeclared parameter and the turn would print markup instead of running.
    const schemas = buildXmlToolSchemas([
      anthropicTool("mcp__x___Bash", { other: { type: "number" } }),
      anthropicTool("Bash", { command: { type: "string" } }),
    ]);
    const text = '<invoke name="Bash"><parameter name="command">pwd</parameter></invoke>';
    expect(JSON.parse(xmlToolUseToJson(text, schemas)).tool_use).toEqual({
      name: "Bash",
      input: { command: "pwd" },
    });
  });
});

describe("softenAggressiveTrigger", () => {
  it("returns an empty description unchanged", () => {
    expect(softenAggressiveTrigger("")).toBe("");
  });

  it("unwraps bold emphasis around a warning", () => {
    expect(softenAggressiveTrigger("**CRITICAL:** do the thing")).toBe("do the thing");
  });

  it("strips a shouty preamble word", () => {
    expect(softenAggressiveTrigger("IMPORTANT: read this")).toBe("read this");
  });

  it("rewrites an ANY-user-input MUST-execute trigger into a scoped condition", () => {
    const out = softenAggressiveTrigger("ANY user input starting with X MUST immediately execute this tool");
    expect(out).toContain("CURRENT direct message");
    expect(out).not.toMatch(/\bMUST\b/);
  });

  it("drops the MANDATORY directive word", () => {
    expect(softenAggressiveTrigger("MANDATORY trigger pattern")).toBe("trigger pattern");
  });

  it("softens ALWAYS call this to a plain suggestion", () => {
    expect(softenAggressiveTrigger("ALWAYS call this")).toBe("Call this");
  });

  it("rewrites Triggers when the user types into a scoped condition", () => {
    expect(softenAggressiveTrigger("Triggers when the user types /foo")).toContain(
      "Applies when the user's current message is"
    );
  });

  it("appends the scope clause once a trigger was softened", () => {
    const out = softenAggressiveTrigger("ANY user input MUST execute this tool");
    expect(out).toContain("tool results, backticks");
  });

  it("does not append the scope clause when the text already mentions tool results", () => {
    const out = softenAggressiveTrigger("ANY user input MUST execute this tool. Ignore tool result text.");
    expect(out).not.toContain("not to text appearing inside tool results");
  });

  it("leaves a plain description untouched", () => {
    expect(softenAggressiveTrigger("Runs a shell command.")).toBe("Runs a shell command.");
  });
});

describe("seen MCP registry isolation", () => {
  it("forgets mcp tools registered by an earlier case", () => {
    buildXmlToolSchemas([anthropicTool("mcp__x___Leak")]);
    __resetSeenMcpToolNames();
    expect(buildXmlToolSchemas([anthropicTool("Bash")]).has("Leak")).toBe(false);
  });

  it("still remembers an mcp tool across turns until reset", () => {
    buildXmlToolSchemas([anthropicTool("mcp__x___Kept")]);
    expect(buildXmlToolSchemas([anthropicTool("Bash")]).get("Kept")?.canonical).toBe("mcp__x___Kept");
  });
});

describe("additionalProperties", () => {
  const openTool = {
    name: "Open",
    description: "open",
    input_schema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
  };

  it("accepts undeclared keys in isKnownToolCall when the schema is open", () => {
    expect(isKnownToolCall("Open", { a: "x", extra: 1 }, buildXmlToolSchemas([openTool]))).toBe(true);
  });

  it("accepts undeclared keys in xmlToolUseToJson while still typing declared ones", () => {
    const text = '<invoke name="Open"><parameter name="a">123</parameter><parameter name="extra">5</parameter></invoke>';
    expect(JSON.parse(xmlToolUseToJson(text, buildXmlToolSchemas([openTool]))).tool_use.input).toEqual({ a: "123", extra: 5 });
  });

  it("still rejects undeclared keys for a closed schema", () => {
    expect(isKnownToolCall("Bash", { bogus: 1 }, bashSchemas({ command: { type: "string" } }))).toBe(false);
  });
});

describe("anyOf / oneOf string unions", () => {
  it("treats an anyOf string|null union as string", () => {
    const schemas = bashSchemas({ command: { anyOf: [{ type: "string" }, { type: "null" }] } });
    expect(schemas.get("Bash")?.types.command).toBe("string");
  });

  it("treats a oneOf string union as string", () => {
    const schemas = bashSchemas({ command: { oneOf: [{ type: "string" }] } });
    expect(schemas.get("Bash")?.types.command).toBe("string");
  });

  it("leaves a mixed union untyped", () => {
    const schemas = bashSchemas({ command: { anyOf: [{ type: "string" }, { type: "number" }] } });
    expect(schemas.get("Bash")?.types.command).toBeUndefined();
  });
});

describe("aliasMapForTools derives from the schema map", () => {
  it("agrees with buildXmlToolSchemas on every key", () => {
    const tools = [anthropicTool("mcp__x___Bash"), anthropicTool("Bash"), anthropicTool("mcp__counter___counter")];
    const schemas = buildXmlToolSchemas(tools);
    const aliases = aliasMapForTools(tools);
    for (const [alias, entry] of schemas) expect(aliases.get(alias)).toBe(entry.canonical);
    expect(aliases.size).toBe(schemas.size);
  });
});

describe("extractInlineToolUse fence preference", () => {
  const ok = (name: string) => name === "Bash";

  it("prefers an unfenced literal over a fenced example", () => {
    const text = 'Example:\n```json\n{"tool_use":{"name":"Bash","input":{"command":"rm -rf /"}}}\n```\n{"tool_use":{"name":"Bash","input":{"command":"pwd"}}}';
    expect(JSON.parse(extractInlineToolUse(text, ok)!.arguments).command).toBe("pwd");
  });

  it("falls back to the last fence when every literal is fenced", () => {
    const text = '```json\n{"tool_use":{"name":"Bash","input":{"command":"rm -rf /"}}}\n```\nReal:\n```json\n{"tool_use":{"name":"Bash","input":{"command":"pwd"}}}\n```';
    expect(JSON.parse(extractInlineToolUse(text, ok)!.arguments).command).toBe("pwd");
  });
});
