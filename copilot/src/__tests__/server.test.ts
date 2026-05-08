import { describe, test, expect, mock, beforeEach } from "bun:test";

// ─── Mock copilot-core before importing server ────────────────────────────────
const mockSend = mock(async (_args?: any) => {});
const mockOn = mock((_handler: any) => (() => {}) as () => void);
const mockListModels = mock(async () => [
  { id: "gpt-4.1", name: "GPT-4.1" },
  { id: "gpt-4o", name: "GPT-4o" },
]);
const mockInitSession = mock(async (_prompt: string, _opts: any) => ({
  send: mockSend,
  on: mockOn,
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
      expect(data.data).toHaveLength(2);
      expect(data.data[0].id).toBe("gpt-4.1");
      expect(data.data[0].object).toBe("model");
      expect(data.data[0].owned_by).toBe("github-copilot");
    });

    test("caches model list — only calls listModels once across requests", async () => {
      mockListModels.mockClear();
      await fetchApp(makeReq("/v1/models"));
      await fetchApp(makeReq("/v1/models"));
      // Should be 0 (already cached from earlier test) or 1 (first call in this test run)
      expect(mockListModels.mock.calls.length).toBeLessThanOrEqual(1);
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
          model: "gpt-4.1",
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
        { model: "gpt-4.1", messages: [{ role: "user", content: "Hi" }], stream: false },
        { "x-session-id": "key-test-A" }
      ));
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-4.1", messages: [{ role: "user", content: "Hello" }], stream: false },
        { "x-session-id": "key-test-A" }
      ));
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-4.1", messages: [{ role: "user", content: "Hey" }], stream: false },
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
        { model: "gpt-4.1", messages: [{ role: "user", content: "first cli" }], stream: false }
      ));
      await fetchApp(post("/v1/chat/completions",
        { model: "gpt-4.1", messages: [{ role: "user", content: "second cli" }], stream: false }
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
        model: "gpt-4.1", stream: false,
        messages: [{ role: "user", content: "do it" }],
      }));
      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-4.1", stream: false,
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
          { model: "gpt-4.1", messages: [{ role: "user", content: "Say hi" }], stream: true },
          { "x-session-id": "stream-test" }
        )
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const text = await res.text();
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
        model: "gpt-4.1", stream: false,
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
        model: "gpt-4.1", stream: false,
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
        model: "gpt-4.1", stream: false,
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
        model: "gpt-4.1", stream: false,
        messages: [{ role: "user", content: "use a tool" }],
        tools: [{ name: "mcp__WebSearch___search", description: "web search", input_schema: { type: "object" } }],
      }, { "x-session-id": "deny-all-tools-test" }));

      const [prompt, opts] = mockInitSession.mock.calls[0];
      expect(opts).toEqual({ denyAllTools: true, systemPromptMode: "replace", model: "gpt-4.1" });
      expect(prompt).toContain("mcp__WebSearch___search");
      expect(prompt).toContain("tool_use");
      expect(prompt).toContain("clearly maps to one of the Available tools, call that tool");
      expect(prompt).toContain("does NOT match any available tool, answer in plain text");
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
        model: "gpt-4.1", stream: false,
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
        model: "gpt-4.1", stream: true,
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
        model: "gpt-4.1", stream: false,
        messages: [{ role: "user", content: "prime" }],
        tools: [{ name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } }],
      }, { "x-session-id": "remembered-tools-test" }));

      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-4.1", stream: false,
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
        model: "gpt-4.1", stream: false,
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
        model: "gpt-4.1", stream: false,
        messages: [{ role: "user", content: "quota" }],
        tools: [
          { name: "Skill", description: "Invoke a skill", input_schema: { type: "object" } },
          { name: "Agent", description: "Launch an agent", input_schema: { type: "object" } },
        ],
      }, { "x-session-id": "all-non-mcp-test" }));

      const [prompt, opts] = mockInitSession.mock.calls[0];
      // All filtered → empty tools[] → no tool_use system prefix, but denyAllTools
      // is still set so the SDK doesn't expose its built-in tools to the model.
      expect(opts).toEqual({ denyAllTools: true, model: "gpt-4.1" });
      expect(prompt).toBe("");
    });

    test("merges partial MCP tool lists with remembered session tools", async () => {
      mockInitSession.mockClear();
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-4.1", stream: false,
        messages: [{ role: "user", content: "prime tools" }],
        tools: [{ name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } }],
      }, { "x-session-id": "merge-tools-test" }));

      await fetchApp(post("/v1/chat/completions", {
        model: "gpt-4.1", stream: false,
        messages: [{ role: "user", content: "quota" }],
        tools: [{ name: "mcp__Billing___Usage", description: "billing quota usage", input_schema: { type: "object" } }],
      }, { "x-session-id": "merge-tools-test" }));

      const [prompt] = mockInitSession.mock.calls[1];
      expect(prompt).toContain("mcp__Counter___Counter__Deploy");
      expect(prompt).toContain("mcp__Billing___Usage");
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
        model: "gpt-4.1", stream: false,
        messages: [{ role: "user", content: "register" }],
        tools: [{ name: "mcp__Counter___Counter__Deploy", description: "Deploy hero", input_schema: { type: "object" } }],
      }, { "x-session-id": "global-registry-A" }));

      // Session B: completely different session, body.tools omits Counter — only built-ins.
      const res = await fetchApp(post("/v1/chat/completions", {
        model: "gpt-4.1", stream: false,
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
        model: "gpt-4.1", stream: false,
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
        return { send: mockSend, on: mockOn } as any;
      });
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      const failed = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-4.1", messages: [{ role: "user", content: "first" }], stream: false },
        { "x-session-id": "recover-test" }
      ));
      expect(failed.status).toBe(500);

      const recovered = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-4.1", messages: [{ role: "user", content: "second" }], stream: false },
        { "x-session-id": "recover-test" }
      ));
      expect(recovered.status).toBe(200);
      expect(mockInitSession.mock.calls.length).toBe(2);

      // Reset for other tests
      mockInitSession.mockImplementation(async (_prompt: string, _opts: any) => ({
        send: mockSend,
        on: mockOn,
      }));
    });

    test("unsubscribes listener when send fails so next request runs cleanly", async () => {
      // If the send-error path leaks the listener, the next request's event
      // stream would be polluted by the stale handler. Verify next turn works.
      mockSend.mockClear();
      let sendCount = 0;
      mockSend.mockImplementation(async (_args?: any) => {
        sendCount++;
        if (sendCount === 1) throw new Error("send blew up");
      });
      mockOn.mockImplementation((handler: any) => {
        setTimeout(() => handler({ type: "assistant.turn_end", data: {} }), 0);
        return () => {};
      });

      const failed = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-4.1", messages: [{ role: "user", content: "boom" }], stream: false },
        { "x-session-id": "send-fail-test" }
      ));
      expect(failed.status).toBe(500);

      const ok = await fetchApp(post("/v1/chat/completions",
        { model: "gpt-4.1", messages: [{ role: "user", content: "again" }], stream: false },
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
          model: "gpt-4.1",
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
  });
});
