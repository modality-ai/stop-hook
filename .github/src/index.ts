#!/usr/bin/env bun

import { SweAgentInteraction } from "./utils/SweAgentInteraction";
import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { appendFileSync } from "fs";

// Simple logger wrapper
const logger = {
  store: (logType: string, message: string) => {
    const filePath = `/tmp/copilot-loop-${gSessionId}-${logType}.txt`;
    appendFileSync(filePath, `${message}\n`);
  },

  log: (message?: any, ...args: any[]) => {
    logger.store("log", message);
    console.log(message, ...args);
  },

  error: (message?: any, ...args: any[]) => {
    logger.store("error", message);
    console.error(message, ...args);
  },
};

// Global session ID - Snowflake-like ID (distributed system friendly)
let gSessionId = `${((Date.now() << 10) | ((Math.random() * 1024) | 0)) >>> 0}`;

// Parse CLI arguments for flags (--prompt with value, --debug as boolean)
const parseCliArgs = (flag: string) => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;

  // For flags with values (like --prompt)
  if (
    index + 1 < process.argv.length &&
    !process.argv[index + 1]?.startsWith("--")
  ) {
    return process.argv[index + 1];
  }

  // For boolean flags (like --debug)
  return flag === "--debug" ? true : null;
};

// Load and parse YAML prompt file
const loadPromptFile = async (filePath: any) => {
  if (typeof filePath !== "string") {
    logger.error("Prompt file path must be a string.");
    process.exit(1);
  }
  try {
    const content = await Bun.file(filePath).text();
    const parsed = Bun.YAML.parse(content);
    return parsed || {};
  } catch (error) {
    logger.error(`Failed to load prompt file: ${filePath}`);
    logger.error(error);
    process.exit(1);
  }
};

const setupSignalHandlers = (
  client: CopilotClient,
  getSession: () => CopilotSession | undefined
): (() => void) => {
  let stopping: boolean = false;
  const handler = async (_signal: NodeJS.Signals) => {
    const activeSession = getSession();
    if (activeSession && !stopping) {
      await activeSession.abort(); // Cancel in-progress operation
      stopping = true;
    }

    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), 5000)
      );

      // client.stop() returns Promise<Error[]> - array of errors from cleanup operations
      // Empty array means all cleanup succeeded
      // https://github.com/github/copilot-sdk/blob/main/nodejs/src/client.ts#L281
      const errors = await Promise.race([client.stop(), timeout]);
      logger.error("Cleanup: ", errors);
    } catch {
      await client.forceStop();
    }
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);

  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
};

// Handle stream destruction errors gracefully
process.stdout.on("error", (error: any) => {
  if (error.code === "ERR_STREAM_DESTROYED") {
    logger.error(
      "\n❌ Connection lost. Stream was destroyed. Please try again."
    );
    process.exit(1);
  }
  throw error;
});

// Handle unhandled promise rejections and errors
const unHandle = (reason: any) => {
  if (
    reason?.message?.includes("Connection is closed") ||
    reason?.code === "ERR_STREAM_DESTROYED"
  ) {
    logger.error("\n❌ Please confirm you already install Copilot CLI.");
    process.exit(1);
  }
};
process.on("unhandledRejection", unHandle);
process.on("uncaughtException", unHandle);

const client = new CopilotClient();
let session: CopilotSession | undefined;

let sessionTimout: NodeJS.Timeout;
const initSession = async (
  systemPrompt: string,
  options: any = {},
  abortController: AbortController
) => {
  const { model = "gpt-4.1", mcpServers } = options;
  logger.log(`🚀 Initializing session with model: ${model}...`);
  logger.log(`📌 Session ID: ${gSessionId}`);
  const sessionOptoins = {
    model,
    mcpServers,
    streaming: true,
    systemMessage: {
      mode: "append" as const, // [append | replace] - whether to append to or replace the default system SDK security guardrails
      content: systemPrompt,
    },
  };

  try {
    if (null == session) {
      session = await client.createSession({
        ...sessionOptoins,
        sessionId: gSessionId,
      });
    } else {
      session = await client.resumeSession(gSessionId, sessionOptoins);
    }
  } catch (error) {
    session = await client.createSession({
      ...sessionOptoins,
      sessionId: gSessionId,
    });
  }
  // ============================================================================
  // Session Event Listener - Comprehensive Event Tracking
  // ============================================================================
  //
  // Reference: github/copilot-sdk SessionEventType
  // URL: https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts
  //
  // Complete list of 35 event types in the SDK (grouped by category):
  //
  // SESSION LIFECYCLE (session.*):
  //   - session.start        → Session initialized
  //   - session.resume       → Session resumed from checkpoint
  //   - session.error        → Session error occurred
  //   - session.idle         → Session waiting for input (turn complete)
  //   - session.info         → Session information update
  //   - session.model_change → Model was switched
  //   - session.handoff      → Handoff to different handler
  //   - session.truncation   → Context truncation occurred
  //   - session.snapshot_rewind → Snapshot rewind happened
  //   - session.usage_info   → Token/cost usage information
  //   - session.compaction_start  → Context compaction started
  //   - session.compaction_complete → Context compaction finished
  //
  // USER MESSAGES (user.*):
  //   - user.message         → User sent a message
  //   - pending_messages.modified → Pending message list changed
  //
  // ASSISTANT REASONING & OUTPUT (assistant.*):
  //   - assistant.turn_start       → Agent starts processing turn
  //   - assistant.intent           → Agent decided what to do
  //   - assistant.reasoning        → Agent's reasoning (complete)
  //   - assistant.reasoning_delta  → Agent's reasoning (streaming)
  //   - assistant.message          → Agent's response message
  //   - assistant.message_delta    → Agent's response (streaming)
  //   - assistant.turn_end         → Agent finished turn
  //   - assistant.usage            → Agent's token usage
  //
  // TOOL EXECUTION (tool.*):
  //   - tool.user_requested        → Tool requested by user
  //   - tool.execution_start       → Tool started (file edits, reads, etc.)
  //   - tool.execution_partial_result → Tool produced partial result
  //   - tool.execution_progress    → Tool execution progress update
  //   - tool.execution_complete    → Tool finished execution
  //
  // SUBAGENT WORKFLOW (subagent.*):
  //   - subagent.started           → Subagent (delegated agent) started
  //   - subagent.completed         → Subagent finished successfully
  //   - subagent.failed            → Subagent encountered error
  //   - subagent.selected          → Subagent was selected
  //
  // OTHER EVENTS:
  //   - abort                      → Operation aborted
  //   - hook.start                 → Webhook/hook started
  //   - hook.end                   → Webhook/hook completed
  //   - system.message             → System message
  //
  // ============================================================================

  session!.on((event) => {
    clearTimeout(sessionTimout);
    sessionTimout = setTimeout(() => abortController.abort(), 10 * 60 * 1000); // 10 minutes
    try {
      switch (event.type) {
        // ─────────────────────────────────────────────────────────────
        // SESSION LIFECYCLE EVENTS
        // ─────────────────────────────────────────────────────────────

        case "session.start":
          // Session created - agent is ready
          logger.log(`\n📍 Session started: ${event.data.sessionId}`);
          break;

        case "session.idle":
          // Session idle - turn complete, waiting for next input
          if (process.stdout.isTTY) process.stdout.write("\n");
          break;

        case "session.error":
          // Session encountered an error
          logger.log(`\n❌ Session error: ${event.data.message}`);
          break;

        case "session.info":
          // Session information (debugging info)
          logger.log(`\nℹ️  Session info: ${event.data.message}`);
          break;

        case "session.usage_info":
          // Token usage and cost information
          if (event.data.currentTokens || event.data.tokenLimit) {
            logger.log(
              `\n📊 Usage - Current: ${event.data.currentTokens}, Limit: ${event.data.tokenLimit}`
            );
          }
          break;

        // ─────────────────────────────────────────────────────────────
        // TURN LIFECYCLE - Shows agent reasoning flow
        // ─────────────────────────────────────────────────────────────

        case "assistant.turn_start":
          // Agent starts processing - beginning of step-by-step execution
          logger.log(
            `\n─── Assistant ${gSessionId} Turn ${event.data.turnId?.slice(0, 8) || "unknown"} ───`
          );
          break;

        case "assistant.turn_end":
          // Turn complete
          logger.log(`\n✓ Turn ended (${event.data.turnId?.slice(0, 8)})`);
          break;

        // ─────────────────────────────────────────────────────────────
        // AGENT DECISION MAKING (What will the agent do?)
        // ─────────────────────────────────────────────────────────────

        case "assistant.intent":
          // Agent deciding what action to take next
          logger.log(`\n🎯 Agent Intent: ${event.data.intent}`);
          break;

        case "assistant.reasoning":
          // Complete reasoning from agent
          logger.store("log", `\n💭 Reasoning:\n${event.data.content}`);
          break;

        case "assistant.reasoning_delta":
          // Streaming reasoning content
          process.stdout.write(event.data.deltaContent);
          break;

        // ─────────────────────────────────────────────────────────────
        // TOOL EXECUTION - Shows what actions agent is taking
        // ─────────────────────────────────────────────────────────────

        case "tool.execution_start":
          // Tool execution starting (file edits, reads, bash commands, etc.)
          logger.log(`\n🔧 Executing tool: ${event.data.toolName}`);
          if (event.data.arguments) {
            logger.log(`   Arguments: ${JSON.stringify(event.data.arguments)}`);
          }
          break;

        case "tool.execution_progress":
          // Progress updates during tool execution (streaming)
          logger.log(`   ⏳ ${event.data.progressMessage}`);
          break;

        case "tool.execution_partial_result":
          // Partial result from tool (before completion)
          logger.log(
            `   📦 Partial Output: ${event.data.partialOutput?.split("\n").slice(-5).join("\n")}`
          );
          break;

        case "tool.execution_complete":
          // Tool execution finished
          if (event.data.success) {
            logger.log(`   ✓ Tool completed`);
            if (event.data.result?.content) {
              const preview = event.data.result.content.slice(0, 150);
              logger.log(
                `   Result: ${preview}${event.data.result.content.length > 150 ? "..." : ""}`
              );
            }
          } else {
            logger.log(`   ✗ Tool failed: ${event.data.error?.message}`);
          }
          break;

        // ─────────────────────────────────────────────────────────────
        // SUBAGENT EXECUTION - For delegated/agentic workflows
        // ─────────────────────────────────────────────────────────────

        case "subagent.started":
          // Subagent (delegated agent) started - recursive agentic workflows
          logger.log(`\n🤖 Subagent started: ${event.data.agentDisplayName}`);
          break;

        case "subagent.selected":
          // Subagent was selected for task
          logger.log(`   → Selected agent: ${event.data.agentName}`);
          break;

        case "subagent.completed":
          // Subagent finished successfully
          logger.log(`   ✓ Subagent completed: ${event.data.agentName}`);
          break;

        case "subagent.failed":
          // Subagent encountered error
          logger.log(`   ✗ Subagent failed: ${event.data.error}`);
          break;

        // ─────────────────────────────────────────────────────────────
        // ASSISTANT RESPONSE - Streaming output to user
        // ─────────────────────────────────────────────────────────────

        case "assistant.message":
          logger.store("log", `\n💭 ASSISTANT:\n${event.data.content}`);
          break;

        case "assistant.message_delta":
          // Streaming response content (write without newline)
          process.stdout.write(event.data.deltaContent);
          break;

        case "assistant.usage":
          // Usage info for this message
          if (event.data.outputTokens) {
            logger.log(`   [Tokens used: ${event.data.outputTokens}]`);
          }
          break;

        // ─────────────────────────────────────────────────────────────
        // OTHER EVENTS - Less common but useful for debugging
        // ─────────────────────────────────────────────────────────────

        case "hook.start":
          // Webhook/hook started
          logger.log(`\n🪝 Hook started: ${event.data.hookType}`);
          break;

        case "hook.end":
          // Webhook/hook completed
          logger.log(`   ✓ Hook completed: ${event.data.hookType}`);
          break;

        case "abort":
          // Operation was aborted
          logger.log(`\n⛔ Operation aborted: ${event.data.reason}`);
          break;

        case "session.model_change":
          // Model was changed
          logger.log(`\n🔄 Model changed to: ${event.data.newModel}`);
          break;

        default:
          //    logger.error(`\n❓ Unhandled event type: ${event.type}`, event.data);
          break;
      }
    } catch (error) {
      console.error("Event handler error:", error);
    }
  });
};

const aiCommand = async (prompt: any, systemPrompt: string) => {
  const abortController = new AbortController();
  await initSession(systemPrompt, promptConfig, abortController);

  // Periodic server health check via ping
  const healthCheckIntervalMs = 3000; // 3 seconds
  const pingTimeoutMs = 1000; // 1 second timeout for ping response
  const healthCheckHandle = setInterval(async () => {
    if (abortController.signal.aborted || !session) return;
    try {
      const result: any = await Promise.race([
        client.ping("O.K."),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Ping timeout")), pingTimeoutMs)
        ),
      ]);
      logger.log(result.message);
    } catch (error) {
      logger.error(`⚠️  Server hang detected: ${(error as Error).message}`);
      abortController.abort();
      session?.abort?.().catch(() => {});
    }
  }, healthCheckIntervalMs);

  try {
    if (!session) {
      logger.error("Session not initialized");
      return "";
    }

    // Race between sendAndWait and abort signal
    const response = await Promise.race([
      session.sendAndWait({ prompt }, promptConfig.timeout * 1000),
      new Promise<never>((_, reject) => {
        abortController.signal.addEventListener("abort", () => {
          reject(new Error("Operation aborted due to server hang"));
        });
      }),
    ]);
    const message = response?.data?.content || "";
    return message;
  } catch (error) {
    if (abortController.signal.aborted) {
      logger.error(
        "Returning to readline due to server hang - next loop will handle recovery"
      );
    } else {
      logger.error(
        "Error during AI command execution:",
        (error as Error).message
      );
    }
    return "";
  } finally {
    clearInterval(healthCheckHandle);
    session?.destroy?.().catch(() => {});
  }
};

const printHelp = () => {
  process.stdout.write(`
Usage: copilot-loop [options]

Options:
  --config <file>     Load configuration from YAML file
  -p <prompt>         Directly input a prompt
  -a <prompt>         Append a prompt to existing prompt
  -s <id>             Specify session ID for resuming sessions
  --model <model>     Specify the AI model to use
  --max <iterations>  Set maximum iterations for agent loop
  --promise <phrase>  Set completion promise phrase
  --timeout-ms <ms>   Set timeout in milliseconds (default: 7 days)
  --debug             Use confirm mode instead of yolo mode

Examples:
  copilot-loop --config config.yaml
  copilot-loop -p "your prompt here"
  copilot-loop -a "additional prompt text"
  copilot-loop --config config.yaml --debug
  copilot-loop --model gpt-4.1 --max 10 --promise "Task completed"
  copilot-loop -p "your prompt" --model claude-3-sonnet --max 5
  `);
  process.exit(0);
};

// Main execution
let configFile: any;
const promptConfig: any = {};
const main = async () => {
  const directPrompt: any = parseCliArgs("-p");
  const appendPrompt: any = parseCliArgs("-a");
  const sessionOverride = parseCliArgs("-s");
  const maxIterationsOverride: any = parseCliArgs("--max");
  const promiseOverride = parseCliArgs("--promise");
  const modelOverride = parseCliArgs("--model");
  const timeout = parseCliArgs("--timeout") || 86400 * 7; // 7 days
  configFile = parseCliArgs("--config");

  if (!configFile && !directPrompt && !parseCliArgs("--debug")) {
    printHelp();
  }

  let initialPrompt = "";

  if (configFile) {
    logger.log(`🤖 Load config file ${configFile}...`);
    Object.assign(promptConfig, await loadPromptFile(configFile));
    initialPrompt = promptConfig.prompt || initialPrompt;
  }
  if (directPrompt) {
    initialPrompt = directPrompt;
  } else if (appendPrompt) {
    initialPrompt += "\n" + appendPrompt;
  }

  // Use --debug flag to change mode to "confirm"
  const mode = parseCliArgs("--debug") ? "confirm" : "yolo";

  // Apply CLI overrides to promptConfig
  if (sessionOverride && typeof sessionOverride === "string") {
    gSessionId = sessionOverride;
  }
  if (modelOverride) {
    promptConfig.model = modelOverride;
  }
  if (maxIterationsOverride) {
    promptConfig["max-iterations"] = parseInt(maxIterationsOverride);
  }
  if (promiseOverride) {
    promptConfig.promise = promiseOverride;
  }
  promptConfig.timeout = timeout;

  const completionPromise = promptConfig.promise;
  const maxIterations = promptConfig["max-iterations"];

  new SweAgentInteraction({
    aiCommand,
    completionPromise,
    maxIterations,
  }).init(mode, initialPrompt);
  setupSignalHandlers(client, () => session);
};

main();
