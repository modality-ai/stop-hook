import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { createHmac } from "crypto";
import { bunMockModule, clearAllMocks } from "modality-bun-kit";
import { completionFrames, formatTokenPrice, streamCompletion } from "../copilot-to-openai";
import { TOOL_NUDGE_PROMPT } from "../turn-content";

const signSyntheticToolId = (baseId: string, secret: string) =>
  `${baseId}_${createHmac("sha256", secret).update(baseId).digest("hex").slice(0, 16)}`;

// ─── Mock copilot-core before importing server ────────────────────────────────
const mockSend = mock(async (_args?: any) => {});
const mockOn = mock((_handler: any) => (() => {}) as () => void);
const mockSetModel = mock(async (_model: string, _opts?: any) => {});
const mockHandlePendingToolCall = mock(async (_args: { requestId: string; result?: string; error?: string }) => {});
// Session lifecycle: invalidating an entry must close the runtime turn (abort)
// and detach the object (disconnect) — dispose() no longer exists in SDK 1.0.x.
const mockAbort = mock(async () => {});
const mockDisconnect = mock(async () => {});
const mockListModels = mock(async () => [
  {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    billing: { tokenPrices: { inputPrice: 300, outputPrice: 1500, cachePrice: 30, batchSize: 1000000 } },
  },
  { id: "test-no-billing", name: "Test No-Billing Fixture" },
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    billing: { tokenPrices: { inputPrice: 25, outputPrice: 200, cachePrice: 0, batchSize: 1000000 } },
  },
]);
// Session shape is `any` so individual tests can override this mock with the
// minimal session their case needs.
const mockInitSession = mock(
  async (_prompt: string, _opts: any): Promise<{ session: any; resumed: boolean }> => ({
    session: {
      send: mockSend,
      on: mockOn,
      setModel: mockSetModel,
      abort: mockAbort,
      disconnect: mockDisconnect,
      // Native tool mode answers SDK tool requests through this RPC.
      rpc: { tools: { handlePendingToolCall: mockHandlePendingToolCall } },
    },
    resumed: false,
  })
);

// ─── copilot-core mock (applied per test via bunMockModule) ───────────────────
// bunMockModule stores the real module and restores it on reset, so the mock
// cannot leak into other test files and every test starts from the same stub.
const copilotCoreMock = () => ({
  client: { listModels: mockListModels, start: mock(async () => {}) },
  initSession: mockInitSession,
  logger: { log: () => {}, error: () => {} },
  getState: () => ({}),
  whichCli: () => null,
  setClientCwd: mock(() => {}),
  COPILOT_LOOP_DIR: "/tmp/copilot-loop",
});

// Resolved after the module mock is registered, then reused: the server module is
// imported once under the mock and its bindings re-resolve on each re-mock.
let fetchApp: (req: Request) => Promise<Response>;
let resetCore: (() => void) | undefined;

// Re-apply the stub before every test so `import("../server")` links against it.
beforeEach(async () => {
  resetCore = await bunMockModule("../copilot-core", copilotCoreMock, import.meta.dir);
  if (!fetchApp) {
    const mod = await import("../server");
    fetchApp = (mod.default as any).fetch as (req: Request) => Promise<Response>;
  }
});

afterEach(() => resetCore?.());
afterAll(() => clearAllMocks());

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeReq(path: string, opts: RequestInit = {}) {
  return new Request(`http://localhost${path}`, opts);
}

function post(path: string, body: any, headers: Record<string, string> = {}) {
  return makeReq(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ─── Test setup ───────────────────────────────────────────────────────────────
// The copilot-core mock and the lazy server import are file-level hooks (above),
// so every describe in this file — including the ones that only use fetchApp —
// runs against the stub regardless of execution order.
describe("server.ts", () => {
  // ─── GET /v1/models ─────────────────────────────────────────────────────────
  describe("GET /v1/models", () => {
    test("returns OpenAI-format model list", async () => {
      const res = await fetchApp(makeReq("/v1/models"));
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.object).toBe("list");
      expect(data.data).toHaveLength(3);
      const noBilling = data.data.find((m: any) => m.id === "test-no-billing");
      expect(noBilling.object).toBe("model");
      expect(noBilling.owned_by).toBe("github-copilot");
    });

    test("caches model list — only calls listModels once across requests", async () => {
      mockListModels.mockClear();
      await fetchApp(makeReq("/v1/models"));
      await fetchApp(makeReq("/v1/models"));
      // Should be 0 (already cached from earlier test) or 1 (first call in this test run)
      expect(mockListModels.mock.calls.length).toBeLessThanOrEqual(1);
    });

    test("includes pricing for model with billing.tokenPrices", async () => {
      const res = await fetchApp(makeReq("/v1/models"));
      const data = await res.json() as any;
      const sonnet = data.data.find((m: any) => m.id === "claude-sonnet-4.6");
      expect(sonnet.pricing).toEqual({ input: "$3.00/M", output: "$15.00/M", cache: "$0.30/M" });
    });

    test("omits pricing for model without billing", async () => {
      const res = await fetchApp(makeReq("/v1/models"));
      const data = await res.json() as any;
      const noBilling = data.data.find((m: any) => m.id === "test-no-billing");
      expect(noBilling.pricing).toBeUndefined();
    });

    test("omits cache from pricing when cachePrice is zero", async () => {
      const res = await fetchApp(makeReq("/v1/models"));
      const data = await res.json() as any;
      const mini = data.data.find((m: any) => m.id === "gpt-5-mini");
      expect(mini.pricing.input).toBe("$0.25/M");
      expect(mini.pricing.output).toBe("$2.00/M");
      expect(mini.pricing.cache).toBeUndefined();
    });
  });

  // ─── formatTokenPrice ───────────────────────────────────────────────────────
  describe("formatTokenPrice", () => {
    test("formats standard price (300 cents/M → $3.00/M)", () => {
      expect(formatTokenPrice(300)).toBe("$3.00/M");
    });

    test("formats output price (1500 cents/M → $15.00/M)", () => {
      expect(formatTokenPrice(1500)).toBe("$15.00/M");
    });

    test("formats cache price (30 cents/M → $0.30/M)", () => {
      expect(formatTokenPrice(30)).toBe("$0.30/M");
    });

    test("formats zero price (0 → $0.00/M)", () => {
      expect(formatTokenPrice(0)).toBe("$0.00/M");
    });

    test("formats sub-dollar price (75 cents/M → $0.75/M)", () => {
      expect(formatTokenPrice(75)).toBe("$0.75/M");
    });
  });

  // ─── POST /v1/messages/count_tokens ─────────────────────────────────────────
  describe("POST /v1/messages/count_tokens", () => {
    test("estimates tokens from string message", async () => {
      const res = await fetchApp(
        post("/v1/messages/count_tokens", {
          messages: [{ role: "user", content: "Hello world" }], // 11 chars
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.input_tokens).toBe(Math.round(11 / 4));
    });

    test("estimates tokens from array content blocks", async () => {
      const res = await fetchApp(
        post("/v1/messages/count_tokens", {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "Hello" },   // 5 chars
              { type: "text", text: " world" },  // 6 chars
            ],
          }],
        })
      );
      const data = await res.json() as any;
      expect(data.input_tokens).toBe(Math.round(11 / 4));
    });

    test("includes system prompt in estimate", async () => {
      const res = await fetchApp(
        post("/v1/messages/count_tokens", {
          system: "You are helpful.", // 16 chars
          messages: [{ role: "user", content: "Hi" }], // 2 chars → total 18
        })
      );
      const data = await res.json() as any;
      expect(data.input_tokens).toBe(Math.round(18 / 4));
    });

    test("returns 400 on invalid JSON", async () => {
      const res = await fetchApp(
        makeReq("/v1/messages/count_tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        })
      );
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /v1/chat/completions ───────────────────────────────────────────────
  describe("POST /v1/chat/completions", () => {
    beforeEach(() => {
      mockOn.mockClear();
      mockSend.mockClear();
    });

    test("returns 400 when no user message present", async () => {
      const res = await fetchApp(
        post("/v1/chat/completions", {
          model: "gpt-5-mini",
          messages: [{ role: "system", content: "You are helpful." }],
        })
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("No user message");
    });

    test("returns 400 on invalid JSON body", async () => {
      const res = await fetchApp(
        makeReq("/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{bad json",
        })
      );
      expect(res.status).toBe(400);
    });

    test("uses x-session-id header to key sessions", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "Hi" }], stream: false },
        { "x-session-id": "key-test-A" }
      ));
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "Hello" }], stream: false },
        { "x-session-id": "key-test-A" }
      ));
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "Hey" }], stream: false },
        { "x-session-id": "key-test-B" }
      ));

      // Only 2 initSession calls: one for key-test-A, one for key-test-B
      expect(mockInitSession.mock.calls.length).toBe(2);
    });

    test("rotates anonymous sessions for new conversations", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "first cli" }], stream: false }
      ));
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "second cli" }], stream: false }
      ));

      expect(mockInitSession.mock.calls.length).toBe(2);
    });

    test("keeps anonymous session for tool result continuations", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "do it" }],
      }));
      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "calculator", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] },
        ],
      }));

      expect(mockInitSession.mock.calls.length).toBe(1);
    });

    test("streams SSE with correct OpenAI chunk format", async () => {
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          handler({ type: "assistant.message_delta", data: { deltaContent: "Hello" } });
          handler({ type: "assistant.message_delta", data: { deltaContent: " world" } });
          handler({ type: "assistant.turn_end", data: {} });
        }, 0);
        return () => {};
      });

      const res = await fetchApp(
        post("/v1/chat/completions",
          { model: "gpt-5-mini", messages: [{ role: "user", content: "Say hi" }], stream: true },
          { "x-session-id": "stream-test" }
        )
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const text = await res.text();
      // Native legs resolve whole, so the reply arrives as one content frame.
      expect(text).toContain('"content":"Hello world"');
      expect(text).toContain('"finish_reason":"stop"');
      expect(text).toContain("[DONE]");
    });

    // ── tool_result round-trip ───────────────────────────────────────────────
    test("formats tool_result as [Tool result for name]: content", async () => {
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "calculator", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] },
        ],
      }, { "x-session-id": "tool-result-test" }));

      expect(capturedPrompt).toBe("[Tool result for calculator]: 42");
    });

    test("accepts correctly signed synthetic ids when trust secret is configured", async () => {
      const previousSecret = process.env.SYNTHETIC_TOOL_ID_SECRET;
      process.env.SYNTHETIC_TOOL_ID_SECRET = "integration-secret";
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

      const toolId = signSyntheticToolId("toolu_herodeploy_signed", process.env.SYNTHETIC_TOOL_ID_SECRET);
      try {
        await fetchApp(post("/v1/chat/completions", {
          model: "gpt-5-mini", stream: false,
          messages: [
            { role: "user", content: "James" },
            { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Deploy", input: { callSign: "JAMES" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "persona" }] },
          ],
        }, { "x-session-id": "synthetic-signed-deploy-test" }));
      } finally {
        if (previousSecret === undefined) delete process.env.SYNTHETIC_TOOL_ID_SECRET;
        else process.env.SYNTHETIC_TOOL_ID_SECRET = previousSecret;
      }

      expect(capturedPrompt).toContain("Deploy({\"callSign\":\"JAMES\"})");
      expect(capturedPrompt).toContain("[Tool result for Deploy]: persona");
    });

    test("rejects unsigned synthetic ids when trust secret is configured", async () => {
      const previousSecret = process.env.SYNTHETIC_TOOL_ID_SECRET;
      process.env.SYNTHETIC_TOOL_ID_SECRET = "integration-secret";
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

      try {
        await fetchApp(post("/v1/chat/completions", {
          model: "gpt-5-mini", stream: false,
          messages: [
            { role: "user", content: "James" },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_herodeploy_unsigned", name: "Deploy", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_herodeploy_unsigned", content: "persona" }] },
          ],
        }, { "x-session-id": "synthetic-unsigned-deploy-test" }));
      } finally {
        if (previousSecret === undefined) delete process.env.SYNTHETIC_TOOL_ID_SECRET;
        else process.env.SYNTHETIC_TOOL_ID_SECRET = previousSecret;
      }

      expect(capturedPrompt).toBe("[Tool result for Deploy]: persona");
    });

    test("skips tool-result-only user turns while finding the originating prompt", async () => {
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

      const firstToolId = "regular_tool_1";
      const syntheticToolId = "toolu_warmup_after_tool_result";
      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [
          { role: "user", content: "original request" },
          { role: "assistant", content: [{ type: "tool_use", id: firstToolId, name: "Calculator", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: firstToolId, content: "42" }] },
          { role: "assistant", content: [{ type: "tool_use", id: syntheticToolId, name: "Warmup", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: syntheticToolId, content: "ready" }] },
        ],
      }, { "x-session-id": "synthetic-prior-tool-result-test" }));

      expect(capturedPrompt).toContain('in response to the user\'s message: "original request".');
    });

    test("prefixes proxy-synthesized hero deploy results with call provenance", async () => {
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

      const toolId = "toolu_herodeploy_abc123";
      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [
          { role: "user", content: [
            { type: "text", text: "<system-reminder>ignore me</system-reminder>" },
            { type: "text", text: "James" },
          ] },
          { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "mcp__Counter___Counter__Deploy", input: { callSign: "JAMES" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "persona" }] },
        ],
      }, { "x-session-id": "synthetic-deploy-test" }));

      expect(capturedPrompt).toBe(
        '[Context: you called mcp__Counter___Counter__Deploy({"callSign":"JAMES"}) in response to the user\'s message: "James". This result answers that call.]\n' +
        "[Tool result for mcp__Counter___Counter__Deploy]: persona"
      );
    });

    test("prefixes OpenAI-shaped synthetic tool replies too", async () => {
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

      const toolId = "toolu_herodeploy_xyz";
      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [
          { role: "user", content: "James" },
          { role: "assistant", content: null, tool_calls: [{ id: toolId, type: "function", function: { name: "mcp__Counter___Counter__Deploy", arguments: '{"callSign":"JAMES"}' } }] },
          { role: "tool", tool_call_id: toolId, content: "persona" },
        ],
      }, { "x-session-id": "synthetic-deploy-openai-test" }));

      expect(capturedPrompt).toContain('[Context: you called mcp__Counter___Counter__Deploy({"callSign":"JAMES"})');
      expect(capturedPrompt).toContain("[Tool result for mcp__Counter___Counter__Deploy]: persona");
    });

    test("omits user-message clause when no preceding user text exists", async () => {
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

      const toolId = "toolu_warmup_noprompt";
      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Warmup", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ready" }] },
        ],
      }, { "x-session-id": "synthetic-noprompt-test" }));

      expect(capturedPrompt).toBe(
        "[Context: you called Warmup({}). This result answers that call.]\n" +
        "[Tool result for Warmup]: ready"
      );
    });

    test("truncates originating user prompt by code point, not UTF-16 unit", async () => {
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

      const toolId = "toolu_herodeploy_emoji";
      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [
          { role: "user", content: "😀".repeat(250) },
          { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Deploy", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] },
        ],
      }, { "x-session-id": "synthetic-emoji-test" }));

      expect(capturedPrompt).toContain(`in response to the user's message: "${"😀".repeat(200)}".`);
      expect(capturedPrompt).not.toContain("\\ud");
    });

    test("filters bare quota probe without starting Copilot session", async () => {
      mockInitSession.mockClear();
      mockSend.mockClear();

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "quota" }],
      }, { "x-session-id": "quota-probe-test" }));

      const data = await res.json() as any;
      expect(res.status).toBe(200);
      expect(data.choices[0].message.content).toBe("");
      expect(data.choices[0].finish_reason).toBe("stop");
      expect(mockInitSession).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    test("falls through to model when tool-reminder present but only built-in tools (no MCP tools)", async () => {
      mockInitSession.mockClear();
      mockSend.mockClear();

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{
          role: "user",
          content: [{ type: "text", text: "<system-reminder>\nThe following skills are available for this session.\n</system-reminder>\nSARAH" }],
        }],
        tools: [
          { name: "Agent", description: "Launch agent", input_schema: { type: "object" } },
          { name: "Bash", description: "Run shell command", input_schema: { type: "object" } },
        ],
      }, { "x-session-id": "missing-tools-fallthrough-test" }));

      await res.json();
      expect(res.status).toBe(200);
      // Falls through to the model — session is created and send is called (no hang)
      expect(mockInitSession).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalled();
    });

    test("passes denyAllTools and native externalTools when tools[] provided", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "use a tool" }],
        tools: [{ name: "mcp__WebSearch___search", description: "web search", input_schema: { type: "object" } }],
      }, { "x-session-id": "deny-all-tools-test" }));

      const [prompt, opts] = mockInitSession.mock.calls[0];
      expect(opts).toEqual({
        denyAllTools: true,
        // The SDK's default prompt describes built-ins this session cannot
        // expose, so server mode replaces it when tools are declared.
        systemPromptMode: "replace",
        model: "gpt-5-mini",
        sessionId: "deny-all-tools-test",
        externalTools: [
          {
            name: "mcp__WebSearch___search",
            description: "web search",
            parameters: { type: "object" },
            skipPermission: true,
            // Always pre-loaded: deferral would hide tools behind the built-in
            // tool_search_tool, which server mode suppresses.
            defer: "never",
          },
        ],
      });
      // Tools are declared natively, so no inline-JSON catalog is injected —
      // only the short server-mode framing that replaces the default prompt.
      expect(prompt).toContain("executed by the client application");
      expect(prompt).not.toContain("tool_use");
    });

    test("canonicalizes shortened MCP tool names in collected JSON", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          handler({ type: "assistant.message", data: { content: '{"tool_use":{"name":"_Counter__Deploy","input":{"callSign":"SARAH"}}}' } });
          handler({ type: "assistant.turn_end", data: {} });
        }, 0);
        return () => {};
      });

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "SARAH" }],
        tools: [{ name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } }],
      }, { "x-session-id": "canonical-tool-test" }));

      const data = await res.json() as any;
      expect(data.choices[0].message.content).toBeNull();
      expect(data.choices[0].message.tool_calls[0].function.name).toBe("mcp__Counter___Counter__Deploy");
      expect(data.choices[0].message.tool_calls[0].function.arguments).toBe('{"callSign":"SARAH"}');
      expect(data.choices[0].finish_reason).toBe("tool_calls");
    });

    test("case-insensitive canonicalization applies only to the tool name, not nested input fields", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          // The model lowercases the tool_use name ("bash") AND an argument
          // value that happens to look like a tool name ("read"). Only the
          // outer name may be canonicalized — rewriting the nested value would
          // mangle a legitimate argument.
          handler({ type: "assistant.message", data: { content: '{"tool_use":{"name":"bash","input":{"name":"read","command":"ls"}}}' } });
          handler({ type: "assistant.turn_end", data: {} });
        }, 0);
        return () => {};
      });

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "run it" }],
        tools: [
          { name: "Bash", description: "Run shell command", input_schema: { type: "object" } },
          { name: "Read", description: "Read a file", input_schema: { type: "object" } },
        ],
      }, { "x-session-id": "nested-name-guard-test" }));

      const data = await res.json() as any;
      // Outer tool name: lowercase "bash" → canonical "Bash".
      expect(data.choices[0].message.tool_calls[0].function.name).toBe("Bash");
      // Nested "name":"read" is an argument value — must NOT be rewritten to "Read".
      expect(data.choices[0].message.tool_calls[0].function.arguments).toBe('{"name":"read","command":"ls"}');
      expect(data.choices[0].finish_reason).toBe("tool_calls");
    });

    // Regression for the bash-rescue removal. This turn narrates a runnable
    // shell command in prose and emits no tool_use literal. The proxy used to
    // scrape "bun test --watch" out of that narration and return it as a Bash
    // call — executing text lifted from model prose. It must now end the turn
    // as plain content instead.
    test("never converts a narrated shell command into a Bash call", async () => {
      mockInitSession.mockClear();
      const FENCE = "```";
      const narration = "Proceeding to run the tests\n\n" + FENCE + "bash\nbun test --watch\n" + FENCE;
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          handler({ type: "assistant.message", data: { content: narration } });
          handler({ type: "assistant.turn_end", data: {} });
        }, 0);
        return () => {};
      });

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "run the tests" }],
        // Bash is offered: the removed rescue fired only when Bash was available,
        // so this is the exact condition that used to produce a call.
        tools: [{ name: "Bash", description: "Run shell command", input_schema: { type: "object" } }],
      }, { "x-session-id": "no-narration-rescue-test" }));

      const data = await res.json() as any;
      expect(res.status).toBe(200);
      expect(data.choices[0].message.tool_calls).toBeUndefined();
      expect(data.choices[0].finish_reason).toBe("stop");
    });

    // The other half of that boundary, and the reason the removal must not
    // narrow the classifier: a narration that still matches gets exactly one
    // nudge, and the literal it asks for comes back as the call. Without this
    // the positive direction is untested on the request path — only the
    // negative one above is.
    test("nudges once for a narrated tool action and returns the recovered call", async () => {
      mockInitSession.mockClear();
      mockSend.mockClear();
      const prompts: string[] = [];
      mockSend.mockImplementation(async (args: any) => { prompts.push(args?.prompt ?? ""); });

      const narration = "I'll inspect the file to verify the path.";
      const literal = '{"tool_use":{"name":"Read","input":{"file_path":"/tmp/x"}}}';
      // One turn per `session.on` registration: narrated first, literal in the
      // nudge reply.
      let turns = 0;
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          const first = turns++ === 0;
          handler({ type: "assistant.message", data: { content: first ? narration : literal } });
          handler({ type: "assistant.turn_end", data: {} });
        }, 0);
        return () => {};
      });

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "check the file" }],
        tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
      }, { "x-session-id": "nudge-recovery-test" }));

      const data = await res.json() as any;
      expect(res.status).toBe(200);
      expect(data.choices[0].finish_reason).toBe("tool_calls");
      expect(data.choices[0].message.tool_calls[0].function.name).toBe("Read");
      expect(data.choices[0].message.tool_calls[0].function.arguments).toBe('{"file_path":"/tmp/x"}');
      // Two sends: the narrated turn, then the nudge prompt.
      expect(prompts.length).toBe(2);
      expect(prompts[1]).toBe(TOOL_NUDGE_PROMPT);
    });

    // Regression: the nudge used to run on a text-only driver with no
    // external_tool.requested branch. A model that answered the nudge with a
    // real tool call left the runtime waiting for an answer forever, so the
    // response hung until the 10-minute turn timeout and the session stayed
    // busy — every later resume of it hung too.
    test("nudge answered with a native tool call returns that call", async () => {
      mockInitSession.mockClear();
      mockSend.mockClear();
      mockHandlePendingToolCall.mockClear();
      const prompts: string[] = [];
      mockSend.mockImplementation(async (args: any) => { prompts.push(args?.prompt ?? ""); });

      const narration = "I'll inspect the file to verify the path.";
      let turns = 0;
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          // First leg: prose only. Second leg (nudge): a real external call.
          if (turns++ === 0) {
            handler({ type: "assistant.message", data: { content: narration } });
            handler({ type: "assistant.turn_end", data: {} });
            return;
          }
          handler({
            type: "external_tool.requested",
            data: {
              requestId: "req-nudge",
              toolCallId: "call-nudge",
              toolName: "Read",
              arguments: { file_path: "/tmp/x" },
            },
          });
        }, 0);
        return () => {};
      });

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "check the file" }],
        tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
      }, { "x-session-id": "nudge-native-test" }));

      const data = await res.json() as any;
      expect(res.status).toBe(200);
      expect(data.choices[0].finish_reason).toBe("tool_calls");
      expect(data.choices[0].message.tool_calls[0].id).toBe("call-nudge");
      expect(data.choices[0].message.tool_calls[0].function.name).toBe("Read");
      expect(data.choices[0].message.tool_calls[0].function.arguments).toBe('{"file_path":"/tmp/x"}');
      expect(prompts.length).toBe(2);
      expect(prompts[1]).toBe(TOOL_NUDGE_PROMPT);
      // The call is parked, not answered: the client executes it and sends the
      // result on the next request.
      expect(mockHandlePendingToolCall.mock.calls.length).toBe(0);
    });

    test("invalidating a failed turn aborts and detaches the runtime session", async () => {
      mockInitSession.mockClear();
      mockAbort.mockClear();
      mockDisconnect.mockClear();
      mockSend.mockImplementation(async () => {});
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "session.error", data: { message: "transport gone" } }), 0);
        return () => {};
      });

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
      }, { "x-session-id": "invalidate-abort-test" }));

      expect(res.status).toBe(500);
      // disposeSession releases the session off the response path.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockAbort).toHaveBeenCalled();
      expect(mockDisconnect).toHaveBeenCalled();
    });

    test("canonicalizes shortened MCP tool names split across streamed deltas", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          handler({ type: "assistant.message_delta", data: { deltaContent: '{"tool_use":{"name":"_Counter' } });
          handler({ type: "assistant.message_delta", data: { deltaContent: '__Deploy","input":{"callSign":"SARAH"}}}' } });
          handler({ type: "assistant.turn_end", data: {} });
        }, 0);
        return () => {};
      });

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: true,
        messages: [{ role: "user", content: "SARAH" }],
        tools: [{ name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } }],
      }, { "x-session-id": "canonical-stream-tool-test" }));

      const text = await res.text();
      // β fix: emit OpenAI tool_calls SSE delta instead of raw text content.
      expect(text).toContain('"tool_calls":[{"index":0,"id":');
      expect(text).toContain('"function":{"name":"mcp__Counter___Counter__Deploy","arguments":"{\\"callSign\\":\\"SARAH\\"}"}');
      expect(text).toContain('"finish_reason":"tool_calls"');
      expect(text).not.toContain('"name":"_Counter__Deploy"');
    });

    test("converts native XML tool markup streamed after prose into a tool_call", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          handler({ type: "assistant.message_delta", data: { deltaContent: "TARGET: Access the file\n\n<inv" } });
          handler({ type: "assistant.message_delta", data: { deltaContent: 'oke name="bash">\n<parameter name="command">ls -la</parameter' } });
          handler({ type: "assistant.message_delta", data: { deltaContent: "></invoke>" } });
          handler({ type: "assistant.turn_end", data: {} });
        }, 0);
        return () => {};
      });

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: true,
        messages: [{ role: "user", content: "list the dir" }],
        tools: [{ name: "Bash", description: "Run shell command", input_schema: { type: "object" } }],
      }, { "x-session-id": "xml-markup-stream-test" }));

      const text = await res.text();
      expect(text).toContain('"function":{"name":"Bash","arguments":"{\\"command\\":\\"ls -la\\"}"}');
      expect(text).toContain('"finish_reason":"tool_calls"');
      // Native legs resolve whole: a salvaged call replaces the turn, and the
      // markup itself is never streamed as text.
      expect(text).not.toContain("invoke");
      expect(text).not.toContain("parameter");
    });

    test("converts native XML tool markup in a collected (non-stream) turn", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          handler({
            type: "assistant.message",
            data: {
              content:
                'Reading the file.\n\n<function_calls>\n<invoke name="Read">\n<parameter name="file_path">/tmp/a.ts</parameter>\n<parameter name="limit">100</parameter>\n</invoke>\n</function_calls>',
            },
          });
          handler({ type: "assistant.turn_end", data: {} });
        }, 0);
        return () => {};
      });

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "read the file" }],
        tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
      }, { "x-session-id": "xml-markup-collect-test" }));

      const data = await res.json() as any;
      expect(data.choices[0].message.content).toBeNull();
      expect(data.choices[0].message.tool_calls[0].function.name).toBe("Read");
      expect(JSON.parse(data.choices[0].message.tool_calls[0].function.arguments)).toEqual({
        file_path: "/tmp/a.ts",
        limit: 100,
      });
      expect(data.choices[0].finish_reason).toBe("tool_calls");
    });

    test("native round trip: answers a parked external call on the next request", async () => {
      mockInitSession.mockClear();
      mockHandlePendingToolCall.mockClear();
      let legs = 0;
      mockOn.mockImplementation((handler: any) => {
        legs++;
        setTimeout(() => {
          if (legs === 1) {
            // The model asks to call a client tool; the runtime parks the call
            // until we answer it through handlePendingToolCall.
            handler({
              type: "external_tool.requested",
              data: { requestId: "req-1", toolCallId: "call_1", toolName: "mcp__Counter___Counter__Deploy", arguments: {} },
            });
            handler({ type: "session.idle", data: {} });
          } else {
            handler({ type: "assistant.message_delta", data: { deltaContent: "deployed" } });
            handler({ type: "session.idle", data: {} });
          }
        }, 0);
        return () => {};
      });

      const tools = [
        { name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } },
      ];

      const first = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "deploy SARAH" }],
        tools,
      }, { "x-session-id": "native-round-trip-test" }));
      const firstData = await first.json() as any;
      expect(firstData.choices[0].message.tool_calls[0].id).toBe("call_1");
      expect(firstData.choices[0].finish_reason).toBe("tool_calls");

      // The client runs the tool and sends its result back as a role:"tool"
      // message — that answer is what resumes the parked turn.
      const second = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        tools,
        messages: [
          { role: "user", content: "deploy SARAH" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "mcp__Counter___Counter__Deploy", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "deployed" },
        ],
      }, { "x-session-id": "native-round-trip-test" }));

      expect(mockHandlePendingToolCall).toHaveBeenCalledWith({ requestId: "req-1", result: "deployed" });
      const secondData = await second.json() as any;
      expect(secondData.choices[0].message.content).toBe("deployed");
      expect(secondData.choices[0].finish_reason).toBe("stop");
    });

    test("native mode answers parked calls with an error before a new prompt", async () => {
      mockInitSession.mockClear();
      mockHandlePendingToolCall.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          handler({
            type: "external_tool.requested",
            data: { requestId: "req-abandon", toolCallId: "call_abandon", toolName: "Bash", arguments: {} },
          });
          handler({ type: "session.idle", data: {} });
        }, 0);
        return () => {};
      });

      const tools = [{ name: "Bash", description: "Run shell command", input_schema: { type: "object" } }];

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "run it" }],
        tools,
      }, { "x-session-id": "native-abandon-test" }));

      // A brand-new prompt (no tool result) means the client gave up on the
      // parked call; sending into a turn still waiting on it would wedge the
      // session, so it is answered with an error first.
      mockSend.mockClear();
      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "never mind" }],
        tools,
      }, { "x-session-id": "native-abandon-test" }));

      expect(mockHandlePendingToolCall).toHaveBeenCalledWith({
        requestId: "req-abandon",
        error: expect.any(String),
      });
      expect(mockSend).toHaveBeenCalled();
    });

    test("reuses remembered tools to canonicalize later turns without tools[]", async () => {
      mockInitSession.mockClear();
      let callCount = 0;
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          callCount++;
          if (callCount === 1) {
            handler({ type: "assistant.turn_end", data: {} });
          } else {
            handler({ type: "assistant.message", data: { content: '{"tool_use":{"name":"_Counter__Deploy","input":{"callSign":"SARAH"}}}' } });
            handler({ type: "assistant.turn_end", data: {} });
          }
        }, 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "prime" }],
        tools: [{ name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } }],
      }, { "x-session-id": "remembered-tools-test" }));

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "SARAH" }],
      }, { "x-session-id": "remembered-tools-test" }));

      const data = await res.json() as any;
      expect(data.choices[0].message.content).toBeNull();
      expect(data.choices[0].message.tool_calls[0].function.name).toBe("mcp__Counter___Counter__Deploy");
      expect(data.choices[0].finish_reason).toBe("tool_calls");
    });

    test("filters out Claude Code router tools that aren't MCP tools", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "quota" }],
        tools: [
          { name: "Skill", description: "Invoke a skill", input_schema: { type: "object" } },
          { name: "Agent", description: "Launch an agent", input_schema: { type: "object" } },
          { name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } },
        ],
      }, { "x-session-id": "filter-non-mcp-test" }));

      const [, opts] = mockInitSession.mock.calls[0];
      // MCP tool declared natively, router built-ins filtered out
      expect(opts.externalTools.map((t: any) => t.name)).toEqual(["mcp__Counter___Counter__Deploy"]);
    });

    test("when only non-MCP tools provided, treats as no-tools (no native declarations)", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "quota" }],
        tools: [
          { name: "Skill", description: "Invoke a skill", input_schema: { type: "object" } },
          { name: "Agent", description: "Launch an agent", input_schema: { type: "object" } },
        ],
      }, { "x-session-id": "all-non-mcp-test" }));

      const [prompt, opts] = mockInitSession.mock.calls[0];
      // All filtered → empty tools[] → no externalTools declaration, but
      // denyAllTools is still set so the SDK doesn't expose its built-ins.
      expect(opts).toEqual({ denyAllTools: true, model: "gpt-5-mini", sessionId: "all-non-mcp-test" });
      expect(prompt).toBe("");
    });

    test("reuses session across requests with different tool lists (preserves conversation context)", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "prime tools" }],
        tools: [{ name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } }],
      }, { "x-session-id": "merge-tools-test" }));

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "quota" }],
        tools: [{ name: "mcp__Billing___Usage", description: "billing quota usage", input_schema: { type: "object" } }],
      }, { "x-session-id": "merge-tools-test" }));

      // Session is reused — initSession was called ONCE total, not per-request.
      // This preserves the model's conversation memory across turns. The first
      // request's tool set is the one declared to the session; later
      // additions don't trigger a re-init (which would clobber context).
      expect(mockInitSession).toHaveBeenCalledTimes(1);
      const [, opts] = mockInitSession.mock.calls[0];
      expect(opts.externalTools.map((t: any) => t.name)).toEqual(["mcp__Counter___Counter__Deploy"]);
    });

    test("server-wide registry canonicalizes short names across different sessions", async () => {
      // Session A registers Counter MCP tool. Session B (different session-id) sends
      // a request with a different tool list — short name must still canonicalize.
      mockInitSession.mockClear();
      let callCount = 0;
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          callCount++;
          if (callCount === 1) {
            handler({ type: "assistant.turn_end", data: {} });
          } else {
            handler({ type: "assistant.message", data: { content: '{"tool_use":{"name":"_Counter__Deploy","input":{"callSign":"SARAH"}}}' } });
            handler({ type: "assistant.turn_end", data: {} });
          }
        }, 0);
        return () => {};
      });

      // Session A: register the canonical Counter name.
      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "register" }],
        tools: [{ name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } }],
      }, { "x-session-id": "global-registry-A" }));

      // Session B: completely different session, body.tools omits Counter — only built-ins.
      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [{ role: "user", content: "SARAH" }],
        tools: [{ name: "Agent", description: "Launch agent", input_schema: { type: "object" } }],
      }, { "x-session-id": "global-registry-B" }));

      const data = await res.json() as any;
      expect(data.choices[0].message.content).toBeNull();
      expect(data.choices[0].message.tool_calls[0].function.name).toBe("mcp__Counter___Counter__Deploy");
      expect(data.choices[0].finish_reason).toBe("tool_calls");
    });

    test("prepends request system text to the forwarded prompt", async () => {
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        system: "When user says quota, choose the billing usage tool instead of asking clarification.",
        messages: [{ role: "user", content: "quota" }],
        tools: [{ name: "mcp__Billing___Usage", description: "billing quota usage", input_schema: { type: "object" } }],
      }, { "x-session-id": "system-quota-test" }));

      expect(capturedPrompt).toContain("When user says quota");
      expect(capturedPrompt).toContain("quota");
    });

    test("recovers from session creation failure on next request", async () => {
      // First call to initSession throws — second call must succeed because the
      // creating-slot is freed via .finally() (not just on resolve).
      mockInitSession.mockClear();
      let firstCall = true;
      mockInitSession.mockImplementation(async (_prompt: string, _opts: any) => {
        if (firstCall) {
          firstCall = false;
          throw new Error("upstream init failed");
        }
        return { session: { send: mockSend, on: mockOn, setModel: mockSetModel }, resumed: false } as any;
      });
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      const failed = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "first" }], stream: false },
        { "x-session-id": "recover-test" }
      ));
      expect(failed.status).toBe(500);

      const recovered = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "second" }], stream: false },
        { "x-session-id": "recover-test" }
      ));
      expect(recovered.status).toBe(200);
      expect(mockInitSession.mock.calls.length).toBe(2);

      // Reset for other tests
      mockInitSession.mockImplementation(async (_prompt: string, _opts: any) => ({
        session: { send: mockSend, on: mockOn, setModel: mockSetModel },
        resumed: false,
      }));
    });

    test("unsubscribes listener when send fails so next request runs cleanly", async () => {
      // If the send-error path leaks the listener, the next request's event
      // stream would be polluted by the stale handler. Verify next turn works.
      mockSend.mockClear();
      let sendCount = 0;
      mockSend.mockImplementation(async (_args?: any) => {
        sendCount++;
        if (sendCount === 1) throw new Error("send blew up"); // no synthetic /clear turn on session init
      });
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      const failed = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "boom" }], stream: false },
        { "x-session-id": "send-fail-test" }
      ));
      expect(failed.status).toBe(500);

      const ok = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "again" }], stream: false },
        { "x-session-id": "send-fail-test" }
      ));
      expect(ok.status).toBe(200);

      // Reset for other tests
      mockSend.mockImplementation(async (_args?: any) => {});
    });

    test("extracts last user message from messages array", async () => {
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => {
        capturedPrompt = args?.prompt ?? "";
      });

      await fetchApp(
        post("/v1/chat/completions", {
          model: "gpt-5-mini",
          stream: false,
          messages: [
            { role: "user", content: "first message" },
            { role: "assistant", content: "response" },
            { role: "user", content: "last message" },
          ],
        }, { "x-session-id": "prompt-test" })
      );

      expect(capturedPrompt).toBe("last message");
    });

    test("model switch: second request with different model calls session.setModel (preserves conversation)", async () => {
      // The Copilot SDK supports session.setModel(model) for mid-conversation
      // switches — history preserved. Matches the official copilot CLI's /model
      // command. The proxy reuses the existing session entry and enqueues a
      // setModel call so the next send goes to the new model.
      mockInitSession.mockClear();
      mockSetModel.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "first" }], stream: false },
        { "x-session-id": "model-switch-test" }
      ));
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5.5", messages: [{ role: "user", content: "second" }], stream: false },
        { "x-session-id": "model-switch-test" }
      ));

      // Only ONE initSession — the second request reused the existing entry.
      expect(mockInitSession.mock.calls.length).toBe(1);
      // setModel was called once, with the new model.
      expect(mockSetModel.mock.calls.length).toBe(1);
      expect(mockSetModel.mock.calls[0][0]).toBe("gpt-5.5");
    });

    test("model switch: setModel failure does NOT update entry.model — next attempt retries", async () => {
      // If setModel throws (e.g. SDK rejects the requested model), the proxy
      // must NOT lie to itself by marking entry.model as switched. The
      // conversation continues on the OLD model (whatever the SDK still has),
      // and the next request asking for the same target model must re-enqueue
      // a fresh setModel attempt — proving the failure didn't update state.
      mockInitSession.mockClear();
      mockSetModel.mockClear();
      mockSetModel.mockImplementation(async () => {
        throw new Error("setModel exploded");
      });
      // Each turn must carry content: three CONSECUTIVE empty turns would trip the
      // empty-turn recovery and replace the entry, which is a different code path
      // from the model-switch bookkeeping under test here.
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => {
          handler({ type: "assistant.message_delta", data: { deltaContent: "ok" } });
          handler({ type: "assistant.turn_end", data: {} });
        }, 0);
        return () => {};
      });

      // Turn 1: fresh session, model=A
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "first" }], stream: false },
        { "x-session-id": "setmodel-fail-test" }
      ));
      // Turn 2: switch to B — setModel throws, entry.model must stay A
      const r2 = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5.5", messages: [{ role: "user", content: "second" }], stream: false },
        { "x-session-id": "setmodel-fail-test" }
      ));
      // Turn 3: ask for B again — because entry.model is still A (the failed
      // attempt didn't update it), the proxy must re-enqueue setModel(B).
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5.5", messages: [{ role: "user", content: "third" }], stream: false },
        { "x-session-id": "setmodel-fail-test" }
      ));

      // Failures don't break the request — send still runs on the old model.
      expect(r2.status).toBe(200);
      // setModel called TWICE: once for turn 2, once for turn 3. If entry.model
      // had been incorrectly updated to B after the first failure, turn 3 would
      // have skipped setModel and this would be 1.
      expect(mockSetModel.mock.calls.length).toBe(2);
      expect(mockSetModel.mock.calls[0][0]).toBe("gpt-5.5");
      expect(mockSetModel.mock.calls[1][0]).toBe("gpt-5.5");

      // Reset for other tests
      mockSetModel.mockImplementation(async () => {});
    });

    test("model switch: no setModel call when both requests use the same model", async () => {
      // Sanity: setModel should ONLY fire on actual model differences. A normal
      // multi-turn conversation with a single model must never call setModel.
      mockInitSession.mockClear();
      mockSetModel.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "first" }], stream: false },
        { "x-session-id": "no-switch-test" }
      ));
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "second" }], stream: false },
        { "x-session-id": "no-switch-test" }
      ));

      expect(mockInitSession.mock.calls.length).toBe(1);
      expect(mockSetModel.mock.calls.length).toBe(0);
    });

    test("no /clear turn is enqueued on session init, on either the fresh or resumed path", async () => {
      // The proxy used to enqueue a synthetic /clear on fresh create. The SDK
      // forwards "/clear" to the model as a real user message, so non-claude
      // models anchored on it and answered later turns with "Context cleared."
      // Assert the whole invariant — neither path sends anything but the user's
      // own message — so a regression cannot hide behind a resume-only check,
      // which would pass merely because /clear never fires anywhere.
      mockInitSession.mockClear();
      mockSend.mockClear();
      const sendCalls: any[] = [];
      mockSend.mockImplementation(async (args: any) => {
        sendCalls.push(args);
      });
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      // Fresh create — the path that used to enqueue /clear.
      mockInitSession.mockImplementationOnce(async () => ({
        session: { send: mockSend, on: mockOn, setModel: mockSetModel },
        resumed: false,
      }));
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "hello" }], stream: false },
        { "x-session-id": "fresh-no-clear-test" }
      ));

      // Resume — conversation memory must survive, so /clear must not appear either.
      mockInitSession.mockImplementationOnce(async () => ({
        session: { send: mockSend, on: mockOn, setModel: mockSetModel },
        resumed: true,
      }));
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "hello again" }], stream: false },
        { "x-session-id": "resume-no-clear-test" }
      ));

      // Exactly the two user messages reached the session, in order.
      expect(sendCalls.map((c) => c?.prompt)).toEqual(["hello", "hello again"]);

      // Reset for other tests
      mockInitSession.mockImplementation(async (_prompt: string, _opts: any) => ({
        session: { send: mockSend, on: mockOn, setModel: mockSetModel },
        resumed: false,
      }));
    });

    test("session.error invalidates the in-memory entry so the next request re-initializes", async () => {
      // Self-healing: a session.error during a turn drops the in-memory entry.
      // The next request for the same sessionKey must trigger a NEW initSession
      // call (which the resume path inside initSession can then use to rehydrate
      // from on-disk state, or fall back to fresh create).
      mockInitSession.mockClear();
      mockOn.mockClear();
      // No synthetic /clear turn on session init, so the user's first request is
      // turn 1. Turn 1 = user request → session.error; Turn 2 = recovery → success.
      let turnNum = 0;
      mockOn.mockImplementation((handler: any) => {
        turnNum++;
        if (turnNum === 1) {
          setTimeout(() => handler({ type: "session.error", data: { message: "upstream died" } }), 0);
        } else {
          setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        }
        return () => {};
      });

      // First request — triggers session.error
      const failed = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "first" }], stream: false },
        { "x-session-id": "self-heal-test" }
      ));
      expect(failed.status).toBe(500);

      // Second request on the SAME sessionKey — must re-init, not reuse the
      // (now invalidated) entry.
      const recovered = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "second" }], stream: false },
        { "x-session-id": "self-heal-test" }
      ));
      expect(recovered.status).toBe(200);
      // TWO initSession calls — one for the failed turn, one for the recovery.
      expect(mockInitSession.mock.calls.length).toBe(2);
    });

    // ─── Empty turn-final assistant.message must not erase deltas ────────────
    describe("empty assistant.message frames", () => {
      // Drives one turn: deltas carry the body, then a turn-final
      // assistant.message arrives with an EMPTY content string — exactly what
      // the Copilot SDK emits once the body was fully delivered as deltas.
      const driveWithEmptyFinalMessage = (deltas: string[]) => {
        mockOn.mockImplementation((handler: any) => {
          setTimeout(() => {
            for (const d of deltas) {
              handler({ type: "assistant.message_delta", data: { deltaContent: d } });
            }
            handler({ type: "assistant.message", data: { content: "" } });
            handler({ type: "assistant.turn_end", data: {} });
          }, 0);
          return () => {};
        });
      };

      // Drives a conversation with per-turn bodies: turn N emits the deltas from
      // bodies[N] then turn_end. There is no /clear turn on a fresh session, so
      // bodies[0] is the first user request.
      const driveWithBodies = (bodies: string[][]) => {
        let turnNum = 0;
        mockOn.mockImplementation((handler: any) => {
          const deltas = bodies[turnNum++] ?? [];
          setTimeout(() => {
            for (const d of deltas) {
              handler({ type: "assistant.message_delta", data: { deltaContent: d } });
            }
            handler({ type: "assistant.turn_end", data: {} });
          }, 0);
          return () => {};
        });
      };

      test("non-stream: buffered tool_use survives an empty final message", async () => {
        driveWithEmptyFinalMessage([
          '{"tool_use":{"name":"Bash",',
          '"input":{"command":"ls -la"}}}',
        ]);

        const res = await fetchApp(post("/v1/chat/completions",
          {
            model: "gpt-5-mini",
            stream: false,
            messages: [{ role: "user", content: "list files" }],
            tools: [{ type: "function", function: { name: "Bash", parameters: {} } }],
          },
          { "x-session-id": "empty-final-tool" }
        ));

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.choices[0].finish_reason).toBe("tool_calls");
        expect(data.choices[0].message.tool_calls[0].function.name).toBe("Bash");
      });

      test("non-stream: prose survives an empty final message", async () => {
        driveWithEmptyFinalMessage(["Hello ", "there!"]);

        const res = await fetchApp(post("/v1/chat/completions",
          { model: "gpt-5-mini", stream: false, messages: [{ role: "user", content: "hi" }] },
          { "x-session-id": "empty-final-text" }
        ));

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.choices[0].message.content).toBe("Hello there!");
      });

      test("stream: a genuinely empty turn stays empty on the wire", async () => {
        // No deltas at all and no final content — the turn produced nothing.
        // Notice text must NOT be substituted in: a non-empty completion would
        // hide the fault from the downstream proxy's empty-turn retry ladder.
        driveWithEmptyFinalMessage([]);

        const res = await fetchApp(post("/v1/chat/completions",
          { model: "gpt-5-mini", stream: true, messages: [{ role: "user", content: "hi" }] },
          { "x-session-id": "empty-turn-notice" }
        ));

        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).not.toContain("without producing any content");
        expect(body).toContain("data: [DONE]");
      });

      test("non-stream: a genuinely empty turn returns empty content", async () => {
        // Same zero-content drive as the stream test — the non-stream path must
        // mirror it: content "" is what trips emptyUpstreamResponse downstream.
        driveWithEmptyFinalMessage([]);

        const res = await fetchApp(post("/v1/chat/completions",
          { model: "gpt-5-mini", stream: false, messages: [{ role: "user", content: "hi" }] },
          { "x-session-id": "empty-turn-notice-nonstream" }
        ));

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.choices[0].message.content).toBe("");
      });

      test("consecutive empty turns invalidate the session so it is re-created", async () => {
        // The poisoned-session recovery path: an empty turn is NOT a
        // session.error, so without explicit invalidation the same broken entry
        // stays cached and every following turn returns empty too. One blank turn
        // is tolerated as a blip; the second proves the session is stuck.
        driveWithEmptyFinalMessage([]);
        const before = mockInitSession.mock.calls.length;

        const send = () => fetchApp(post("/v1/chat/completions",
          { model: "gpt-5-mini", stream: false, messages: [{ role: "user", content: "hi" }] },
          { "x-session-id": "poisoned-session" }
        ));

        // Turn 1: creates the session, first strike — entry still cached.
        expect((await send()).status).toBe(200);
        expect(mockInitSession.mock.calls.length).toBe(before + 1);

        // Turn 2: reuses that entry, second strike — entry now discarded.
        expect((await send()).status).toBe(200);
        expect(mockInitSession.mock.calls.length).toBe(before + 1);

        // Turn 3: cache was cleared, so a fresh session is initialised.
        expect((await send()).status).toBe(200);
        expect(mockInitSession.mock.calls.length).toBe(before + 2);
      });

      test("a turn with content resets the empty-turn strike count", async () => {
        // Strikes must be CONSECUTIVE: an empty turn followed by a good one must
        // not leave the session one blip away from being thrown out.
        const before = mockInitSession.mock.calls.length;
        const send = () => fetchApp(post("/v1/chat/completions",
          { model: "gpt-5-mini", stream: false, messages: [{ role: "user", content: "hi" }] },
          { "x-session-id": "alternating-session" }
        ));

        // Per-turn bodies, unlike the shared fixture's replay-every-turn shape.
        driveWithBodies([[], ["hello"], []]);

        expect((await send()).status).toBe(200);      // strike 1
        expect((await send()).status).toBe(200);      // content → reset
        expect((await send()).status).toBe(200);      // strike 1 again, not 2

        // One initSession only — the entry survived all three turns.
        expect(mockInitSession.mock.calls.length).toBe(before + 1);
      });

      test("stream: a turn with content resets the empty-turn strike count", async () => {
        // Stream and non-stream share one native leg, so the reset proven
        // non-stream above must hold here too: empty → content → empty must
        // leave one strike, not two (which would discard a healthy session).
        const before = mockInitSession.mock.calls.length;
        const send = () => fetchApp(post("/v1/chat/completions",
          { model: "gpt-5-mini", stream: true, messages: [{ role: "user", content: "hi" }] },
          { "x-session-id": "stream-alternating" }
        ));

        driveWithBodies([[], ["hello"], []]);

        expect((await send()).status).toBe(200);          // strike 1
        const contentTurn = await (await send()).text();  // content → reset
        expect(contentTurn).toContain("hello");
        expect((await send()).status).toBe(200);          // strike 1 again, not 2

        // One initSession only — the entry survived all three turns.
        expect(mockInitSession.mock.calls.length).toBe(before + 1);
      });

      test("non-stream: a tool-call turn resets the empty-turn strike count", async () => {
        // A tool call carries no prose — content is "" — so the guard must be
        // `!tu && !content.trim()`, not just `!content.trim()`: an active
        // tool-using session must never be counted as empty and discarded.
        const before = mockInitSession.mock.calls.length;
        const send = () => fetchApp(post("/v1/chat/completions",
          {
            model: "gpt-5-mini",
            stream: false,
            messages: [{ role: "user", content: "list files" }],
            tools: [{ type: "function", function: { name: "Bash", parameters: {} } }],
          },
          { "x-session-id": "tool-reset-session" }
        ));

        driveWithBodies([
          [],
          ['{"tool_use":{"name":"Bash",', '"input":{"command":"ls -la"}}}'],
          [],
        ]);

        expect((await send()).status).toBe(200);   // strike 1
        const toolTurn = await (await send()).json() as any; // tool call → reset
        expect(toolTurn.choices[0].finish_reason).toBe("tool_calls");
        expect((await send()).status).toBe(200);   // strike 1 again, not 2

        // One initSession only — the entry survived all three turns.
        expect(mockInitSession.mock.calls.length).toBe(before + 1);
      });

      test("stream: a tool-call turn resets the empty-turn strike count", async () => {
        // The stream path resets strikes in its dedicated tool-call branch —
        // same guard spirit as non-stream, same aftermath required.
        const before = mockInitSession.mock.calls.length;
        const send = () => fetchApp(post("/v1/chat/completions",
          {
            model: "gpt-5-mini",
            stream: true,
            messages: [{ role: "user", content: "list files" }],
            tools: [{ type: "function", function: { name: "Bash", parameters: {} } }],
          },
          { "x-session-id": "stream-tool-reset-session" }
        ));

        driveWithBodies([
          [],
          ['{"tool_use":{"name":"Bash",', '"input":{"command":"ls -la"}}}'],
          [],
        ]);

        expect((await send()).status).toBe(200);          // strike 1
        const toolTurn = await (await send()).text();     // tool call → reset
        expect(toolTurn).toContain('"finish_reason":"tool_calls"');
        expect((await send()).status).toBe(200);          // strike 1 again, not 2

        // One initSession only — the entry survived all three turns.
        expect(mockInitSession.mock.calls.length).toBe(before + 1);
      });

      test("non-stream: whitespace-only content strikes as empty but stays on the wire", async () => {
        // The guard trims before deciding: "   " is an empty turn for strike
        // purposes, yet the raw content is still returned — no notice text is
        // substituted in, so downstream's own empty-check can still trip.
        const before = mockInitSession.mock.calls.length;
        const send = () => fetchApp(post("/v1/chat/completions",
          { model: "gpt-5-mini", stream: false, messages: [{ role: "user", content: "hi" }] },
          { "x-session-id": "whitespace-session" }
        ));

        driveWithBodies([["   "], ["   "], []]);

        const first = await (await send()).json() as any;
        // Counted as a strike, but the raw content reaches the wire untouched.
        expect(first.choices[0].message.content).toBe("   ");

        // Two whitespace-only turns are two consecutive strikes: second
        // invalidates, and the third request re-initialises fresh.
        expect((await send()).status).toBe(200);
        expect((await send()).status).toBe(200);
        expect(mockInitSession.mock.calls.length).toBe(before + 2);
      });
    });
  });
});

// ─── Native stream framing ────────────────────────────────────────────────────
// A native leg resolves as a whole, so the streaming route replays the finished
// completion as SSE frames instead of forwarding deltas. Every path — success,
// empty, or failed — must end with exactly one finish_reason frame and exactly
// one [DONE]; a stream that stops without them looks like a clean finish.
describe("native stream framing", () => {
  const asText = (frame: Uint8Array) => new TextDecoder().decode(frame);
  const framesOf = (completion: any) => completionFrames(completion).map(asText);
  const completion = (message: any, finish_reason: string) => ({
    id: "chatcmpl-test",
    model: "m",
    choices: [{ index: 0, message, finish_reason }],
  });

  test("replays a tool-call completion as one indexed delta", () => {
    const frames = framesOf(
      completion(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "Bash", arguments: "{}" } },
            { id: "call_2", type: "function", function: { name: "Read", arguments: "{}" } },
          ],
        },
        "tool_calls"
      )
    );

    const delta = JSON.parse(frames[0].replace(/^data: /, ""));
    expect(delta.choices[0].delta.tool_calls.map((c: any) => c.index)).toEqual([0, 1]);
    expect(delta.choices[0].delta.tool_calls[0].function.name).toBe("Bash");
    expect(delta.choices[0].finish_reason).toBeNull();
    expect(frames[1]).toContain('"finish_reason":"tool_calls"');
    expect(frames[2]).toBe("data: [DONE]\n\n");
    expect(frames).toHaveLength(3);
  });

  test("replays text as a single content delta", () => {
    const frames = framesOf(completion({ role: "assistant", content: "hello" }, "stop"));

    expect(frames[0]).toContain('"content":"hello"');
    expect(frames[1]).toContain('"finish_reason":"stop"');
    expect(frames[2]).toBe("data: [DONE]\n\n");
  });

  test("emits no content frame for an empty completion but still terminates", () => {
    const frames = framesOf(completion({ role: "assistant", content: "" }, "stop"));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('"finish_reason":"stop"');
    expect(frames[1]).toBe("data: [DONE]\n\n");
  });

  test("passes a length finish through so the client can retry", () => {
    const frames = framesOf(completion({ role: "assistant", content: "cut" }, "length"));

    expect(frames.some((f) => f.includes('"finish_reason":"length"'))).toBe(true);
  });

  async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
    const reader = stream.getReader();
    const out: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      out.push(asText(value));
    }
  }

  test("a failed leg still ends with finish_reason length and [DONE]", async () => {
    const frames = await drain(streamCompletion(Promise.reject(new Error("boom")), "chatcmpl-x", "m"));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('"finish_reason":"length"');
    expect(frames[1]).toBe("data: [DONE]\n\n");
  });

  test("a successful leg replays its frames and then closes", async () => {
    const frames = await drain(
      streamCompletion(Promise.resolve(completion({ role: "assistant", content: "ok" }, "stop")), "chatcmpl-x", "m")
    );

    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
    expect(frames.join("")).toContain('"content":"ok"');
  });

  test("a cancelled consumer aborts the leg", async () => {
    // The client is gone: the leg must resolve (not keep a turn open) so its
    // calls are refused instead of parked for a response nobody will read.
    let cancelled = 0;
    const stream = streamCompletion(new Promise(() => {}), "chatcmpl-x", "m", () => cancelled++);
    const reader = stream.getReader();
    void reader.read(); // pending until the leg resolves
    await reader.cancel();

    expect(cancelled).toBe(1);
  });
});

// ─── Native session state isolation ──────────────────────────────────────────
// Parked calls belong to the entry that parked them. A session recreated after
// invalidation must start empty: inheriting the dropped entry's map would let a
// stale tool_call_id be answered on a turn that never issued it.
describe("native session state isolation", () => {
  test("a recreated session does not inherit the dropped entry's parked calls", async () => {
    mockInitSession.mockClear();
    mockSend.mockClear();
    mockHandlePendingToolCall.mockClear();

    const tools = [{ name: "Bash", description: "run", input_schema: { type: "object" } }];
    let turn = 0;
    mockOn.mockImplementation((handler: any) => {
      const mine = turn++;
      setTimeout(() => {
        if (mine === 0) {
          // Park a call, then kill the session before the quiet window flushes it.
          handler({
            type: "external_tool.requested",
            data: { requestId: "req-old", toolCallId: "call_old", toolName: "Bash", arguments: {} },
          });
          handler({ type: "session.error", data: { message: "transport gone" } });
        } else {
          handler({ type: "assistant.message_delta", data: { deltaContent: "ok" } });
          handler({ type: "session.idle", data: {} });
        }
      }, 0);
      return () => {};
    });

    // Turn 1: the session dies while the call is parked → entry invalidated.
    const first = await fetchApp(post("/v1/chat/completions", {
      model: "gpt-5-mini", stream: false,
      messages: [{ role: "user", content: "run it" }],
      tools,
    }, { "x-session-id": "native-state-isolation-test" }));
    expect(first.status).toBe(500);

    mockHandlePendingToolCall.mockClear();

    // Turn 2 answers that id on a NEW entry. It was never parked there, so the
    // answer must not be forwarded to the runtime — the request is a plain prompt.
    const second = await fetchApp(post("/v1/chat/completions", {
      model: "gpt-5-mini", stream: false,
      tools,
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_old", type: "function", function: { name: "Bash", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_old", content: "done" },
      ],
    }, { "x-session-id": "native-state-isolation-test" }));

    expect(mockHandlePendingToolCall).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(2);
    const data = await second.json() as any;
    expect(data.choices[0].message.content).toBe("ok");
  });
});
