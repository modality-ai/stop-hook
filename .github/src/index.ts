#!/usr/bin/env bun

import { SweAgentInteraction } from "./utils/SweAgentInteraction";
import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { appendFileSync } from "fs";

// Simple logger wrapper
const logger = {
  log: (message?: any, ...args: any[]) => {
    appendFileSync(`/tmp/copilot-loop-${gSessionId}-log.txt`, `${message}\n`);
    console.log(message, ...args);
  },

  error: (message?: any, ...args: any[]) => {
    appendFileSync(
      `/tmp/copilot-loop-${gSessionId}-error.txt`,
      `[ERROR] ${message}\n`
    );
    console.error(message, ...args);
  },
};

// Global session ID - Snowflake-like ID (distributed system friendly)
let gSessionId = `${(Date.now() << 10) | ((Math.random() * 1024) | 0)}`;

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
    return parsed;
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
      const timeout = new Promise<Error[]>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), 5000)
      );

      const errors = await Promise.race([client.stop(), timeout]);
      if (errors.length > 0) {
        logger.error("Cleanup errors:", errors);
      }
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

const initSession = async (systemPrompt: string, options: any = {}) => {
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
    // ─────────────────────────────────────────────────────────────
    // SESSION LIFECYCLE EVENTS
    // ─────────────────────────────────────────────────────────────

    if (event.type === "session.start") {
      // Session created - agent is ready
      logger.log(`\n📍 Session started: ${event.data.sessionId}`);
    }

    if (event.type === "session.idle") {
      // Session idle - turn complete, waiting for next input
      if (process.stdout.isTTY) process.stdout.write("\n");
    }

    if (event.type === "session.error") {
      // Session encountered an error
      logger.log(`\n❌ Session error: ${event.data.message}`);
    }

    if (event.type === "session.info") {
      // Session information (debugging info)
      logger.log(`\nℹ️  Session info: ${event.data.message}`);
    }

    if (event.type === "session.usage_info") {
      // Token usage and cost information
      if (event.data.currentTokens || event.data.tokenLimit) {
        logger.log(
          `\n📊 Usage - Current: ${event.data.currentTokens}, Limit: ${event.data.tokenLimit}`
        );
      }
    }

    // ─────────────────────────────────────────────────────────────
    // TURN LIFECYCLE - Shows agent reasoning flow
    // ─────────────────────────────────────────────────────────────

    if (event.type === "assistant.turn_start") {
      // Agent starts processing - beginning of step-by-step execution
      logger.log(
        `\n─── Assistant ${gSessionId} Turn ${event.data.turnId?.slice(0, 8) || "unknown"} ───`
      );
    }

    if (event.type === "assistant.turn_end") {
      // Turn complete
      logger.log(`\n✓ Turn ended (${event.data.turnId?.slice(0, 8)})`);
    }

    // ─────────────────────────────────────────────────────────────
    // AGENT DECISION MAKING (What will the agent do?)
    // ─────────────────────────────────────────────────────────────

    if (event.type === "assistant.intent") {
      // Agent deciding what action to take next
      logger.log(`\n🎯 Agent Intent: ${event.data.intent}`);
    }

    if (event.type === "assistant.reasoning") {
      // Complete reasoning from agent
      logger.log(`\n💭 Reasoning:\n${event.data.content}`);
    }

    if (event.type === "assistant.reasoning_delta") {
      // Streaming reasoning content
      process.stdout.write(event.data.deltaContent);
    }

    // ─────────────────────────────────────────────────────────────
    // TOOL EXECUTION - Shows what actions agent is taking
    // ─────────────────────────────────────────────────────────────

    if (event.type === "tool.execution_start") {
      // Tool execution starting (file edits, reads, bash commands, etc.)
      logger.log(`\n🔧 Executing tool: ${event.data.toolName}`);
      if (event.data.arguments) {
        logger.log(`   Arguments: ${JSON.stringify(event.data.arguments)}`);
      }
    }

    if (event.type === "tool.execution_progress") {
      // Progress updates during tool execution (streaming)
      logger.log(`   ⏳ ${event.data.progressMessage}`);
    }

    if (event.type === "tool.execution_partial_result") {
      // Partial result from tool (before completion)
      logger.log(
        `   📦 Partial Output: ${event.data.partialOutput?.split("\n").slice(-5).join("\n")}`
      );
    }

    if (event.type === "tool.execution_complete") {
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
    }

    // ─────────────────────────────────────────────────────────────
    // SUBAGENT EXECUTION - For delegated/agentic workflows
    // ─────────────────────────────────────────────────────────────

    if (event.type === "subagent.started") {
      // Subagent (delegated agent) started - recursive agentic workflows
      logger.log(`\n🤖 Subagent started: ${event.data.agentDisplayName}`);
    }

    if (event.type === "subagent.selected") {
      // Subagent was selected for task
      logger.log(`   → Selected agent: ${event.data.agentName}`);
    }

    if (event.type === "subagent.completed") {
      // Subagent finished successfully
      logger.log(`   ✓ Subagent completed: ${event.data.agentName}`);
    }

    if (event.type === "subagent.failed") {
      // Subagent encountered error
      logger.log(`   ✗ Subagent failed: ${event.data.error}`);
    }

    // ─────────────────────────────────────────────────────────────
    // ASSISTANT RESPONSE - Streaming output to user
    // ─────────────────────────────────────────────────────────────

    if (event.type === "assistant.message_delta") {
      // Streaming response content (write without newline)
      process.stdout.write(event.data.deltaContent);
    }

    if (event.type === "assistant.usage") {
      // Usage info for this message
      if (event.data.outputTokens) {
        logger.log(`   [Tokens used: ${event.data.outputTokens}]`);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // OTHER EVENTS - Less common but useful for debugging
    // ─────────────────────────────────────────────────────────────

    if (event.type === "hook.start") {
      // Webhook/hook started
      logger.log(`\n🪝 Hook started: ${event.data.hookType}`);
    }

    if (event.type === "hook.end") {
      // Webhook/hook completed
      logger.log(`   ✓ Hook completed: ${event.data.hookType}`);
    }

    if (event.type === "abort") {
      // Operation was aborted
      logger.log(`\n⛔ Operation aborted: ${event.data.reason}`);
    }

    if (event.type === "session.model_change") {
      // Model was changed
      logger.log(`\n🔄 Model changed to: ${event.data.newModel}`);
    }
  });
};

const aiCommand = async (prompt: any, systemPrompt: string) => {
  await initSession(systemPrompt, promptConfig);
  try {
    const response = await session!.sendAndWait(
      { prompt },
      promptConfig.timeoutMs
    );
    session?.destroy();
    const message = response?.data?.content || "";
    appendFileSync(
      `/tmp/copilot-loop-${gSessionId}-log.txt`,
      `Assistant: ${message}\n`
    );
    return message;
  } catch (error) {
    logger.error(
      "Error during AI command execution:",
      (error as Error).message
    );
    session?.destroy();
    return "";
  }
};

const printHelp = () => {
  logger.log(`
Usage: copilot-loop [options]

Options:
  --config <file>     Load configuration from YAML file
  -p <prompt>         Directly input a prompt
  -a <prompt>         Append a prompt to existing prompt
  --model <model>     Specify the AI model to use
  --max <iterations>  Set maximum iterations for agent loop
  --promise <phrase>  Set completion promise phrase
  --session-id <id>   Specify session ID for resuming sessions
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
let promptConfig: any = {};
const main = async () => {
  const directPrompt: any = parseCliArgs("-p");
  const appendPrompt: any = parseCliArgs("-a");
  const maxIterationsOverride: any = parseCliArgs("--max");
  const promiseOverride = parseCliArgs("--promise");
  const modelOverride = parseCliArgs("--model");
  const sessionOverride = parseCliArgs("--session-id");
  const timeoutMs = parseCliArgs("--timeout-ms") || 86400000 * 7; // 7 day
  configFile = parseCliArgs("--config");

  if (!configFile && !directPrompt && !parseCliArgs("--debug")) {
    printHelp();
  }

  let initialPrompt = "";

  if (configFile) {
    logger.log(`🤖 Load config file ${configFile}...`);
    logger.log();
    promptConfig = await loadPromptFile(configFile);
    initialPrompt =
      promptConfig.prompt || promptConfig.message || initialPrompt;
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
  promptConfig.timeoutMs = timeoutMs;

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
