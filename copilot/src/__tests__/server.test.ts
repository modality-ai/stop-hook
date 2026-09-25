import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createHmac } from "crypto";
import { formatTokenPrice } from "../copilot-to-openai";

const signSyntheticToolId = (baseId: string, secret: string) =>
  `${baseId}_${createHmac("sha256", secret).update(baseId).digest("hex").slice(0, 16)}`;

// ─── Mock copilot-core before importing server ────────────────────────────────
const mockSend = mock(async (_args?: any) => {});
const mockOn = mock((_handler: any) => (() => {}) as () => void);
const mockSetModel = mock(async (_model: string, _opts?: any) => {});
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
const mockInitSession = mock(async (_prompt: string, _opts: any) => ({
  session: {
    send: mockSend,
    on: mockOn,
    setModel: mockSetModel,
  },
  resumed: false,
}));

mock.module("../copilot-core", () => ({
  client: { listModels: mockListModels, start: mock(async () => {}) },
  initSession: mockInitSession,
  logger: { log: () => {}, error: () => {} },
  getState: () => ({}),
  whichCli: () => null,
  setClientCwd: mock(() => {}),
  COPILOT_LOOP_DIR: "/tmp/copilot-loop",
}));

// Resolved after module mock is registered
let fetchApp: (req: Request) => Promise<Response>;

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
// Import server lazily inside describe so Bun processes mock.module first
describe("server.ts", () => {
  beforeEach(async () => {
    if (!fetchApp) {
      const mod = await import("../server");
      fetchApp = (mod.default as any).fetch as (req: Request) => Promise<Response>;
    }
  });

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
      expect(text).toContain('"content":"Hello"');
      expect(text).toContain('"content":" world"');
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

    test("preserves malformed OpenAI tool arguments as a JSON string", async () => {
      let capturedPrompt = "";
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });
      mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

      const toolId = "toolu_toolsearch_malformed";
      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-5-mini", stream: false,
        messages: [
          { role: "user", content: "find tools" },
          { role: "assistant", content: null, tool_calls: [{ id: toolId, type: "function", function: { name: "ToolSearch", arguments: "{bad json" } }] },
          { role: "tool", tool_call_id: toolId, content: "ok" },
        ],
      }, { "x-session-id": "synthetic-malformed-args-test" }));

      expect(capturedPrompt).toContain('ToolSearch("{bad json")');
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

    for (const kind of ["toolsearch", "warmup"]) {
      test(`prefixes ${kind} synthetic tool replies`, async () => {
        let capturedPrompt = "";
        mockOn.mockImplementation((handler: any) => {
          setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
          return () => {};
        });
        mockSend.mockImplementation(async (args: any) => { capturedPrompt = args?.prompt ?? ""; });

        const toolId = `toolu_${kind}_1`;
        await fetchApp(post("/v1/chat/completions", {
          model: "gpt-5-mini", stream: false,
          messages: [
            { role: "user", content: "find tools" },
            { role: "assistant", content: null, tool_calls: [{ id: toolId, type: "function", function: { name: "ToolSearch", arguments: "" } }] },
            { role: "tool", tool_call_id: toolId, content: "ok" },
          ],
        }, { "x-session-id": `synthetic-${kind}-test` }));

        expect(capturedPrompt).toBe(
          '[Context: you called ToolSearch({}) in response to the user\'s message: "find tools". This result answers that call.]\n' +
          "[Tool result for ToolSearch]: ok"
        );
      });
    }

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

      const data = await res.json() as any;
      expect(res.status).toBe(200);
      // Falls through to the model — session is created and send is called (no hang)
      expect(mockInitSession).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalled();
    });

    test("passes denyAllTools and tool schema prefix when tools[] provided", async () => {
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
      expect(opts).toEqual({ denyAllTools: true, systemPromptMode: "replace", model: "gpt-5-mini", sessionId: "deny-all-tools-test" });
      expect(prompt).toContain("mcp__WebSearch___search");
      expect(prompt).toContain("tool_use");
      expect(prompt).toContain("ALWAYS emit FORM A");
      expect(prompt).toContain("no available tool matches, emit FORM B");
      expect(prompt).toContain("Never shorten MCP tool names");
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
      // Prose before the markup still streams; the markup itself never does.
      expect(text).toContain("TARGET: Access the file");
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

      const [prompt] = mockInitSession.mock.calls[0];
      // MCP tool present, router built-ins filtered out
      expect(prompt).toContain("mcp__Counter___Counter__Deploy");
      expect(prompt).not.toContain("name: Skill");
      expect(prompt).not.toContain("name: Agent");
    });

    test("when only non-MCP tools provided, treats as no-tools (no system prefix)", async () => {
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
      // All filtered → empty tools[] → no tool_use system prefix, but denyAllTools
      // is still set so the SDK doesn't expose its built-in tools to the model.
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
      // request's tool set is the one baked into the session prompt; later
      // additions don't trigger a re-init (which would clobber context).
      expect(mockInitSession).toHaveBeenCalledTimes(1);
      const [prompt] = mockInitSession.mock.calls[0];
      expect(prompt).toContain("mcp__Counter___Counter__Deploy");
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
        if (sendCount === 2) throw new Error("send blew up"); // sendCount=1 is /clear on session init
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

    test("/clear is NOT sent when initSession reports resumed: true", async () => {
      // On resume, the conversation memory must be preserved. If /clear fires
      // after a resume, the very thing we resumed is wiped — defeating the
      // entire purpose of crash recovery.
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
      // Tell the proxy this session was RESUMED — /clear must not enqueue.
      mockInitSession.mockImplementationOnce(async () => ({
        session: { send: mockSend, on: mockOn, setModel: mockSetModel },
        resumed: true,
      }));

      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-5-mini", messages: [{ role: "user", content: "hello again" }], stream: false },
        { "x-session-id": "resume-test" }
      ));

      // No /clear prompt in the send calls — only the user's actual message.
      const clearPrompts = sendCalls.filter((c) => c?.prompt === "/clear");
      expect(clearPrompts.length).toBe(0);

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
      // Each new session triggers TWO runTurn calls before the user's first
      // request runs: /clear (the cleanup turn) + the user turn. We want the
      // user turn (not /clear) to receive the session.error so that the
      // self-heal path fires on a real user-visible failure.
      // Turn 1 = /clear → success; Turn 2 = user request → session.error;
      // Turn 3 = recovery user request → success.
      let turnNum = 0;
      mockOn.mockImplementation((handler: any) => {
        turnNum++;
        if (turnNum === 2) {
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
        let turnNum = 0;
        mockOn.mockImplementation((handler: any) => {
          turnNum++;
          setTimeout(() => {
            // Turn 1 on a fresh session is the /clear cleanup turn.
            if (turnNum > 1) {
              for (const d of deltas) {
                handler({ type: "assistant.message_delta", data: { deltaContent: d } });
              }
              handler({ type: "assistant.message", data: { content: "" } });
            }
            handler({ type: "assistant.turn_end", data: {} });
          }, 0);
          return () => {};
        });
      };

      // Drives a conversation with per-turn bodies: turn N emits the deltas from
      // bodies[N] then turn_end. Index 0 is the /clear cleanup turn on a fresh
      // session, so bodies[1] feeds the first user request.
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
        driveWithBodies([[], [], ["hello"], []]);

        expect((await send()).status).toBe(200);      // strike 1
        expect((await send()).status).toBe(200);      // content → reset
        expect((await send()).status).toBe(200);      // strike 1 again, not 2

        // One initSession only — the entry survived all three turns.
        expect(mockInitSession.mock.calls.length).toBe(before + 1);
      });

      test("stream: a turn with content resets the empty-turn strike count", async () => {
        // The stream path counts strikes at its OWN call site in sendAndStream,
        // so the reset proven non-stream above must hold here too: empty →
        // content → empty must leave one strike, not two (which would discard a
        // healthy session).
        const before = mockInitSession.mock.calls.length;
        const send = () => fetchApp(post("/v1/chat/completions",
          { model: "gpt-5-mini", stream: true, messages: [{ role: "user", content: "hi" }] },
          { "x-session-id": "stream-alternating" }
        ));

        driveWithBodies([[], [], ["hello"], []]);

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

        driveWithBodies([[], ["   "], ["   "], []]);

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
