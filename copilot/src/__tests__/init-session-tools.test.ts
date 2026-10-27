import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { bunMockModule, clearAllMocks } from "modality-bun-kit";
import { toExternalTools } from "../native-turn";

// Mock only the SDK so the REAL initSession builds its session options; the fake
// client records what createSession received.
let created: any[] = [];

class FakeCopilotClient {
  constructor(_opts: any) {}
  async start() {}
  async stop() {}
  async getSessionMetadata() { return undefined; }
  async listModels() { return []; }
  async createSession(opts: any) {
    created.push(opts);
    return { sessionId: opts.sessionId, on: () => () => {}, setModel: async () => {}, rpc: {} };
  }
  async resumeSession(_id: string, opts: any) { return this.createSession(opts); }
}

const sdkMock = () => ({
  CopilotClient: FakeCopilotClient,
  RuntimeConnection: { forStdio: () => ({}) },
});

// bunMockModule resolves bare specifiers via require() (CJS entry), but copilot-core
// imports the ESM entry — pass the ESM path so the mock hits the module actually loaded.
const SDK_PATH = Bun.fileURLToPath(import.meta.resolve("@github/copilot-sdk"));

// initSession process.exit()s unless the model is in /tmp/copilot-loop/models.json.
// Pin a known model there for the suite, then put the original file back.
const MODELS_CACHE = "/tmp/copilot-loop/models.json";
const model = "test-model";
let originalCache: string | null = null;

beforeAll(() => {
  originalCache = existsSync(MODELS_CACHE) ? readFileSync(MODELS_CACHE, "utf-8") : null;
  mkdirSync("/tmp/copilot-loop", { recursive: true });
  writeFileSync(MODELS_CACHE, JSON.stringify([{ id: model }]));
});

afterAll(() => {
  if (originalCache === null) rmSync(MODELS_CACHE, { force: true });
  else writeFileSync(MODELS_CACHE, originalCache);
  clearAllMocks();
});

let resetSdk: (() => void) | undefined;
let initSession: (prompt: string, options?: any) => Promise<any>;

beforeEach(async () => {
  created = [];
  resetSdk = await bunMockModule(SDK_PATH, sdkMock);
  const core = await import("../copilot-core");
  initSession = core.initSession;
  // Drop any client cached by another file so the fake SDK client is used.
  core.resetClient("test");
});

afterEach(() => resetSdk?.());

const optionsFor = async (options: any) => {
  // The fake session lacks parts of the real API, so initSession may throw after
  // createSession; only the options it sent matter, so require exactly that call.
  await initSession("sys", { model, ...options }).catch(() => {});
  expect(created).toHaveLength(1);
  return created[0];
};

describe("initSession availableTools", () => {
  test("denyAllTools allow-lists custom tools only", async () => {
    const opts = await optionsFor({ denyAllTools: true });
    expect(opts.availableTools).toEqual(["custom:*"]);
  });

  test("without denyAllTools availableTools is left unset", async () => {
    const opts = await optionsFor({});
    expect(opts).not.toHaveProperty("availableTools");
  });

  // The two halves only work together: custom tools must be allow-listed AND a
  // built-in-named one must declare the override, or it never reaches the model.
  test("a built-in-named client tool reaches the session allow-listed and overriding", async () => {
    const externalTools = toExternalTools([{ name: "Bash", description: "run", input_schema: { type: "object" } }]);
    const opts = await optionsFor({ denyAllTools: true, externalTools });
    expect({ availableTools: opts.availableTools, override: opts.tools[0].overridesBuiltInTool }).toEqual({
      availableTools: ["custom:*"],
      override: true,
    });
  });
});
