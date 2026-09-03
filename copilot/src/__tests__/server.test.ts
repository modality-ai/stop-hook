import { describe, test, expect, mock, beforeEach } from "bun:test";
import { formatTokenPrice } from "../copilot-to-openai";

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
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
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

      test("stream: a genuinely empty turn reports itself instead of going silent", async () => {
        // No deltas at all and no final content — the turn produced nothing.
        driveWithEmptyFinalMessage([]);

        const res = await fetchApp(post("/v1/chat/completions",
          { model: "gpt-5-mini", stream: true, messages: [{ role: "user", content: "hi" }] },
          { "x-session-id": "empty-turn-notice" }
        ));

        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("without producing any content");
        expect(body).toContain("data: [DONE]");
      });

      test("non-stream: a genuinely empty turn reports itself instead of returning silent content", async () => {
        // Same zero-content drive as the stream test — the non-stream path must
        // mirror the notice in the message body, not return a silent content: "".
        driveWithEmptyFinalMessage([]);

        const res = await fetchApp(post("/v1/chat/completions",
          { model: "gpt-5-mini", stream: false, messages: [{ role: "user", content: "hi" }] },
          { "x-session-id": "empty-turn-notice-nonstream" }
        ));

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.choices[0].message.content).toBe(
          "[copilot] The upstream session ended this turn without producing any content."
        );
      });
    });
  });
});
