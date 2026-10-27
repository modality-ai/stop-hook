import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { bunMockModule, clearAllMocks } from "modality-bun-kit";
// Loads copilot-to-openai against the real copilot-core first; without it the trimmed
// mock below lacks exports it needs (e.g. writeLoopFile) when this file runs alone.
import "../copilot-to-openai";

// ─── copilot-core mock (applied per test via bunMockModule) ───────────────────
const mockSend = mock(async (_args?: any) => {});
const mockOn = mock((_handler: any) => (() => {}) as () => void);
const mockSetModel = mock(async (_model: string, _opts?: any) => {});
const mockHandlePendingToolCall = mock(async (_args: any) => {});
const mockInitSession = mock(async (_prompt: string, _opts: any): Promise<{ session: any; resumed: boolean }> => ({
  session: {
    send: mockSend,
    on: mockOn,
    setModel: mockSetModel,
    rpc: { tools: { handlePendingToolCall: mockHandlePendingToolCall } },
  },
  resumed: false,
}));

const copilotCoreMock = () => ({
  client: { listModels: mock(async () => []), start: mock(async () => {}) },
  initSession: mockInitSession,
  logger: { log: () => {}, error: () => {} },
  getState: () => ({}),
  whichCli: () => null,
  setClientCwd: mock(() => {}),
  resetClient: mock(() => {}),
  COPILOT_LOOP_DIR: "/tmp/copilot-loop",
});

let fetchApp: (req: Request) => Promise<Response>;

function post(path: string, body: any, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// Sends one tool call/result pair (OpenAI shape) and returns the prompt forwarded to Copilot.
async function promptFor(
  toolId: string,
  sessionId: string,
  callName = "ToolSearch",
  args = '{"query":"select:SendMessage"}',
  result = "[tool_reference: SendMessage]",
) {
  let capturedPrompt = "";
  mockOn.mockImplementation((handler: any) => {
    setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
    return () => {};
  });
  mockSend.mockImplementation(async (a: any) => { capturedPrompt = a?.prompt ?? ""; });
  await fetchApp(post("/v1/chat/completions", {
    model: "gpt-5-mini", stream: false,
    messages: [
      { role: "user", content: "find tools" },
      { role: "assistant", content: null, tool_calls: [{ id: toolId, type: "function", function: { name: callName, arguments: args } }] },
      { role: "tool", tool_call_id: toolId, content: result },
    ],
  }, { "x-session-id": sessionId }));
  return capturedPrompt;
}

describe("ToolSearch", () => {
  let resetCore: (() => void) | undefined;

  beforeEach(async () => {
    resetCore = await bunMockModule("../copilot-core", copilotCoreMock, import.meta.dir);
    if (!fetchApp) {
      const mod = await import("../server");
      fetchApp = (mod.default as any).fetch as (req: Request) => Promise<Response>;
    }
  });

  afterEach(() => resetCore?.());
  afterAll(() => clearAllMocks());

  test("preserves malformed OpenAI tool arguments as a JSON string", async () => {
    const prompt = await promptFor("toolu_toolsearch_malformed", "synthetic-malformed-args-test", "ToolSearch", "{bad json", "ok");
    expect(prompt).toContain('ToolSearch("{bad json")');
  });

  for (const kind of ["toolsearch", "warmup"]) {
    test(`prefixes ${kind} synthetic tool replies`, async () => {
      const prompt = await promptFor(`toolu_${kind}_1`, `synthetic-${kind}-test`, "ToolSearch", "", "ok");
      expect(prompt).toBe(
        '[Context: you called ToolSearch({}) in response to the user\'s message: "find tools". This result answers that call.]\n' +
        "[Tool result for ToolSearch]: ok"
      );
    });
  }

  test("adds the preamble to native CLI ToolSearch calls with non-synthetic ids", async () => {
    const prompt = await promptFor("call_00_abc123", "toolsearch-native-test");
    expect(prompt).toBe(
      '[Context: you called ToolSearch({"query":"select:SendMessage"}) in response to the user\'s message: "find tools". This result answers that call.]\n' +
      "[Tool result for ToolSearch]: [tool_reference: SendMessage]"
    );
  });

  test("adds the preamble to native ToolSearch calls with chatcmpl-tool ids", async () => {
    const prompt = await promptFor("chatcmpl-tool-9c6b90e067f94594", "toolsearch-chatcmpl-test");
    expect(prompt).toContain('[Context: you called ToolSearch({"query":"select:SendMessage"})');
  });

  test("still adds the preamble to native ToolSearch calls when a trust secret is configured", async () => {
    const previousSecret = process.env.SYNTHETIC_TOOL_ID_SECRET;
    process.env.SYNTHETIC_TOOL_ID_SECRET = "integration-secret";
    try {
      const prompt = await promptFor("call_00_secret", "toolsearch-secret-test");
      expect(prompt).toContain("[Context: you called ToolSearch(");
    } finally {
      if (previousSecret === undefined) delete process.env.SYNTHETIC_TOOL_ID_SECRET;
      else process.env.SYNTHETIC_TOOL_ID_SECRET = previousSecret;
    }
  });

  test("keeps other tools with non-synthetic ids free of the preamble", async () => {
    const prompt = await promptFor("call_00_other", "toolsearch-other-tool-test", "calculator", "{}");
    expect(prompt).toBe("[Tool result for calculator]: [tool_reference: SendMessage]");
  });

  test("keeps ToolSearch so deferred built-ins like Bash stay loadable", async () => {
    mockInitSession.mockClear();
    mockOn.mockImplementation((handler: any) => {
      setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
      return () => {};
    });

    await fetchApp(post("/v1/chat/completions", {
      model: "gpt-5-mini", stream: false,
      messages: [{ role: "user", content: "quota" }],
      tools: [
        { name: "ToolSearch", description: "Load deferred tools", input_schema: { type: "object" } },
        { name: "Skill", description: "Invoke a skill", input_schema: { type: "object" } },
        { name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } },
      ],
    }, { "x-session-id": "keep-toolsearch-test" }));

    const [, opts] = mockInitSession.mock.calls[0];
    expect(opts.externalTools.map((t: any) => t.name)).toEqual(["ToolSearch", "mcp__Counter___Counter__Deploy"]);
  });

  test("adds the preamble to Anthropic-shaped native ToolSearch calls", async () => {
    let capturedPrompt = "";
    mockOn.mockImplementation((handler: any) => {
      setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
      return () => {};
    });
    mockSend.mockImplementation(async (a: any) => { capturedPrompt = a?.prompt ?? ""; });
    await fetchApp(post("/v1/chat/completions", {
      model: "gpt-5-mini", stream: false,
      messages: [
        { role: "user", content: "find tools" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_00_anthropic", name: "ToolSearch", input: { query: "select:SendMessage" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_00_anthropic", content: "[tool_reference: SendMessage]" }] },
      ],
    }, { "x-session-id": "toolsearch-anthropic-shape-test" }));
    expect(capturedPrompt).toContain('[Context: you called ToolSearch({"query":"select:SendMessage"})');
  });

  test("does not exempt prefixed ToolSearch names (exact match only)", async () => {
    const prompt = await promptFor("call_00_prefixed", "toolsearch-prefixed-test", "mcp__x__ToolSearch");
    expect(prompt).toBe("[Tool result for mcp__x__ToolSearch]: [tool_reference: SendMessage]");
  });
});
