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
        model: "gpt-4.1", stream: false,
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "calculator", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] },
        ],
      }, { "x-session-id": "tool-result-test" }));

      expect(capturedPrompt).toBe("[Tool result for calculator]: 42");
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
        tools: [{ name: "search", description: "web search", input_schema: { type: "object" } }],
      }, { "x-session-id": "deny-all-tools-test" }));

      const [prompt, opts] = mockInitSession.mock.calls[0];
      expect(opts).toEqual({ denyAllTools: true, systemPromptMode: "replace" });
      expect(prompt).toContain("search");
      expect(prompt).toContain("tool_use");
      expect(prompt).toContain("You MUST call one listed tool");
      expect(prompt).toContain("instead of asking a clarification question");
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
