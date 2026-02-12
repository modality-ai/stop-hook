#!/usr/bin/env bun

import { SweAgentInteraction } from "./SweAgentInteraction";
import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "fs";
import { appendFile } from "fs/promises";
import { execSync } from "child_process";

const LAST_SESSION_FILE = "/tmp/copilot-loop-last-session";

type PreToolUseHookOutput = {
  permissionDecision: "allow" | "deny" | "ask";
  modifiedArgs?: Record<string, any>;
};

// Global session ID - Snowflake-like ID (distributed system friendly)
let gSessionId = `${((Date.now() << 10) | ((Math.random() * 1024) | 0)) >>> 0}`;
let gLlm = "";
let gActuatorId: string;

// Simple logger wrapper
const logger = {
  store: (logType: string, message: string) => {
    const filePath = `/tmp/copilot-loop-${gSessionId}-${logType}.txt`;
    appendFileSync(filePath, `${message}\n`);
  },

  log: (message?: any, ...args: any[]) => {
    logger.store("log", message);
    console.log(`${gSessionId} ${message}`, ...args);
  },

  error: (message?: any, ...args: any[]) => {
    logger.store("error", message);
    console.error(`${gSessionId} ${message}`, ...args);
  },
};

// Parse CLI arguments for flags (-p, -a with value, --debug as boolean)
const parseCliArgs = (flag: string) => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;

  // For flags with values (like -p, -a)
  if (
    index + 1 < process.argv.length &&
    !process.argv[index + 1]?.startsWith("--")
  ) {
    return process.argv[index + 1];
  }

  // For boolean flags (like --debug, --resume, -r)
  const booleanFlags = ["--debug", "--resume", "-r"];
  return booleanFlags.includes(flag) ? true : null;
};

// Collect positional args from argv[2..] using '---' as boundary separator
// Bun strips '--' from process.argv, so we use '---' which Bun preserves
// Usage: `bun script.ts --- exec ls -la` → argv includes '---' → positional = [exec, ls, -la]
const getPositionalArgs = (): string[] => {
  const ddIndex = process.argv.indexOf("---");
  if (ddIndex !== -1) {
    return process.argv.slice(ddIndex + 1);
  }
  const args: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("-")) break;
    args.push(process.argv[i]);
  }
  return args;
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

const getPersonaPrompt = (personaName: string) => {
  const personaPropmpt = `Deploy ${personaName} persona to activate and maintain persistence throughout the entire workflow.`;
  return personaPropmpt;
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
    logger.error("❌ Connection lost. Stream was destroyed. Please try again.");
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
    logger.error("❌ Please confirm you already install Copilot CLI.");
    process.exit(1);
  }
};
process.on("unhandledRejection", unHandle);
process.on("uncaughtException", unHandle);

const whichCli = (cli: string): string | null => {
  try {
    const output = execSync(`which ${cli}`, { encoding: "utf-8" });
    return output.trim();
  } catch (error) {
    return null;
  }
};

const client = new CopilotClient({
  cliPath: whichCli("copilot") || undefined,
});
const hasActuator = whichCli("actuator") != null;

let session: CopilotSession | undefined;
let sessionTimout: NodeJS.Timeout;
const setupSessionEventListener = (
  session: any,
  abortController: AbortController
) => {
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
  //   - user.message              → User sent a message
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

  // Keep reference to unsubscribe function to prevent listener from being garbage collected
  return session.on((event: any) => {
    clearTimeout(sessionTimout);
    sessionTimout = setTimeout(() => abortController.abort(), 10 * 60 * 1000); // 10 minutes
    try {
      switch (event.type) {
        // ─────────────────────────────────────────────────────────────
        // SESSION LIFECYCLE EVENTS
        // ─────────────────────────────────────────────────────────────

        case "session.start":
          // Session created - agent is ready
          logger.log(`📍 Session started: ${event.data.sessionId}`);
          break;

        case "session.idle":
          // Session idle - turn complete, waiting for next input
          if (process.stdout.isTTY) process.stdout.write("\n");
          break;

        case "session.error":
          // Session encountered an error
          logger.log(`❌ Session error: ${event.data.message}`);
          break;

        case "session.info":
          // Session information (debugging info)
          logger.log(`ℹ️  Session info: ${event.data.message}`);
          break;

        case "session.usage_info":
          // Token usage and cost information
          if (event.data.currentTokens || event.data.tokenLimit) {
            logger.log(
              `📊 Usage - Current: ${event.data.currentTokens}, Limit: ${event.data.tokenLimit}`
            );
          }
          break;

        // ─────────────────────────────────────────────────────────────
        // TURN LIFECYCLE - Shows agent reasoning flow
        // ─────────────────────────────────────────────────────────────

        case "assistant.turn_start":
          // Agent starts processing - beginning of step-by-step execution
          logger.log(
            `─── Assistant Turn ${event.data.turnId?.slice(0, 8) || "unknown"} ───`
          );
          break;

        case "assistant.turn_end":
          // Turn complete
          logger.log(`✓ Turn ended (${event.data.turnId?.slice(0, 8)})`);
          break;

        // ─────────────────────────────────────────────────────────────
        // AGENT DECISION MAKING (What will the agent do?)
        // ─────────────────────────────────────────────────────────────

        case "assistant.intent":
          // Agent deciding what action to take next
          logger.log(`🎯 Agent Intent: ${event.data.intent}`);
          break;

        case "assistant.reasoning":
          // Complete reasoning from agent
          logger.store("log", `💭 Reasoning:\n${event.data.content}`);
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
          logger.log(`🔧 Executing tool: ${event.data.toolName}`);
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
          logger.log(`   📦 Partial Output: ${event.data.partialOutput}`);
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
          logger.log(`🤖 Subagent started: ${event.data.agentDisplayName}`);
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
          logger.store("log", `💭 ASSISTANT:\n${event.data.content}`);
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
          logger.log(`🪝 Hook started: ${event.data.hookType}`);
          break;

        case "hook.end":
          // Webhook/hook completed
          logger.log(`   ✓ Hook completed: ${event.data.hookType}`);
          break;

        case "abort":
          // Operation was aborted
          logger.log(`⛔ Operation aborted: ${event.data.reason}`);
          break;

        case "session.model_change":
          // Model was changed
          logger.log(`🔄 Model changed to: ${event.data.newModel}`);
          break;

        case "user.message":
          logger.store("log", `💭 USER:\n${event.data.content}`);
          break;

        case "session.truncation":
        case "session.compaction_complete":
          if (null != promptConfig.persona) {
            session?.send({
              prompt: getPersonaPrompt(promptConfig.persona),
            });
          }
          break;
        case "pending_messages.modified":
          break;
        default:
          process.stdout.write(`❓ Unhandled event type: ${event.type}\n`);
          break;
      }
    } catch (error) {
      console.error("Event handler error:", error);
    }
  });
};

const initSession = async (
  systemPrompt: string,
  options: any = {},
  abortController: AbortController
) => {
  if (null == options.model) {
    delete options.model;
  }
  const defaultModel = options.reasoningEffort ? "gpt-5-mini" : "gpt-4.1";
  const { model = defaultModel, reasoningEffort, mcpServers } = options;
  logger.log(
    `🚀 Initializing session with model: ${model} ${reasoningEffort ? "reasoningEffort: " + reasoningEffort : "..."}`
  );
  logger.log(`📌 Session ID: ${gSessionId}`);
  const sessionOptoins = {
    model,
    mcpServers,
    streaming: true,
    systemMessage: {
      mode: "append" as const, // [append | replace] - whether to append to or replace the default system SDK security guardrails
      content: systemPrompt,
    },
    reasoningEffort, // [low|medium|high|xhigh] Ensure maximum reasoning effort for new sessions
    infiniteSessions: {
      // https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts#L584
      backgroundCompactionThreshold: 0.65,
    },
    hooks: {
      onPostToolUse: async (input: any) => {
        switch (input.toolName) {
          case "bash":
          case "shell":
            if (hasActuator && gActuatorId) {
              try {
                let alreadyStop = false;
                const checkResult = () => {
                  const toolResultJson = execSync(
                    `actuator -p ${gActuatorId}`,
                    {
                      encoding: "utf-8",
                    }
                  );
                  const toolResultData = JSON.parse(toolResultJson);
                  if (toolResultData) {
                    if (!alreadyStop) {
                      alreadyStop = true;
                      session?.abort?.().catch(() => {});
                    }
                    if (toolResultData.status !== "running") {
                      gLlm = `Bash Tool Execution Result: ${toolResultData.stderr || toolResultData.stdout}`;
                      return gLlm;
                    }
                  }
                };
                if (!checkResult()) {
                  const intervalId = setInterval(() => {
                    if (checkResult()) {
                      clearInterval(intervalId);
                    }
                  }, 3000);
                }
              } catch (error) {
                console.error("Failed to parse tool result for LLM:", error);
              }
            }
            break;
        }
      },
      onPreToolUse: async (input: any): Promise<PreToolUseHookOutput> => {
        switch (input.toolName) {
          case "bash":
          case "shell":
            try {
              const toolArgs = JSON.parse(input.toolArgs);
              const originalCmd = toolArgs?.command || "";
              appendFile(
                "/tmp/copilot-loop-command.log",
                `${new Date().toISOString()} [${gSessionId}] ${originalCmd}\n`
              ).catch(() => {});
              if (hasActuator) {
                const strippedCmd = originalCmd.replace(/2>\/dev\/null/g, "");
                let writeMode = "";
                if (-1 === strippedCmd.indexOf(">")) {
                  writeMode = "-w";
                }
                gActuatorId = input.timestamp;
                const command = `actuator ${writeMode} --plain -j ${gActuatorId} -a --- ${originalCmd}; actuator -s -p ${gActuatorId}`;
                return {
                  permissionDecision: "allow",
                  modifiedArgs: {
                    ...toolArgs,
                    command,
                  },
                };
              }
            } catch (error) {}
            break;
        }
        return { permissionDecision: "allow" };
      },
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

  // Track session ID for --resume support
  writeFileSync(LAST_SESSION_FILE, gSessionId);

  // Attach event listener immediately after session is created
  // Store the unsubscribe function to keep the listener alive
  setupSessionEventListener(session, abortController);
};

const aiThinking = async ({ prompt }: any, sendTimeoutMs: number) => {
  let mainResponse = "";

  const say = (prompt: string) => {
    if (!session) {
      logger.error("Session not initialized");
      return "";
    }
    session
      .sendAndWait({ prompt }, sendTimeoutMs)
      .then(async (response) => {
        mainResponse = response?.data?.content || "";
      })
      .catch((error) => {
        mainResponse = error;
      });
  };
  say(prompt);
  return new Promise<string>((resolve, _reject) => {
    const checkInterval = setInterval(() => {
      if (mainResponse !== "") {
        clearInterval(checkInterval);
        resolve(mainResponse);
      }
      if (gLlm !== "") {
        say(gLlm);
        gLlm = "";
      }
    }, 500);
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
      await Promise.race([
        client.ping("O.K."),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Ping timeout")), pingTimeoutMs)
        ),
      ]);
      process.stdout.write(".");
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
    const sendTimeoutMs = promptConfig.timeout * 1000;
    if (null != promptConfig.persona) {
      await session.sendAndWait(
        {
          prompt: getPersonaPrompt(promptConfig.persona),
        },
        sendTimeoutMs
      );
    }
    const response = await Promise.race([
      aiThinking({ prompt }, sendTimeoutMs),
      new Promise<never>((_, reject) => {
        abortController.signal.addEventListener("abort", () => {
          reject(new Error("Operation aborted due to server hang"));
        });
      }),
    ]);
    return response;
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
Usage: copilot-loop [config-file] [options]

AI-powered agent loop for Copilot CLI

Options:
  -p <text>               Execute a prompt in non-interactive mode
  -a <text>               Append a prompt to existing prompt
  --resume [sessionId]    Resume from a previous session (optionally specify
                          session ID)
  --config <file>         Load configuration from YAML file (alternative to
                          positional argument)
  --model <model>         Set the AI model to use
  --think <level>         Set reasoning effort (choices: low, medium, high,
                          xhigh)
  --max <iterations>      Set maximum iterations for agent loop
  --promise <phrase>      Set completion promise phrase for task completion
  --timeout <seconds>     Set timeout in seconds (default: 604800 / 7 days)
  --persona <name>        Deploy a specific persona to activate and maintain
                          persistence
  --debug                 Use confirm mode for permission prompts instead of
                          automatic approval
  -h, --help              display help for command

Arguments:
  [config-file]           Load configuration from YAML file (positional
                          argument; alternative to --config option)

Examples:
  # Start with a config file
  $ copilot-loop config.yaml

  # Execute a prompt in non-interactive mode
  $ copilot-loop -p "Fix the bug in main.js"

  # Append additional prompt
  $ copilot-loop config.yaml -a "Also add error handling"

  # Resume a previous session
  $ copilot-loop --resume

  # Resume with specific session ID
  $ copilot-loop --resume abc123def456

  # Use specific model and reasoning effort
  $ copilot-loop --model gpt-5-mini --think high -p "Optimize this code"

  # Set max iterations and completion promise
  $ copilot-loop config.yaml --max 10 --promise "Task completed"

  # Enable debug mode with persona
  $ copilot-loop config.yaml --debug --persona "JAMES"
  `);
  process.exit(0);
};

// Main execution
let configFile: any;
const promptConfig: any = {};
const main = async () => {
  const directPrompt: any = parseCliArgs("-p");
  const appendPrompt: any = parseCliArgs("-a");
  const sessionOverride = parseCliArgs("-r") || parseCliArgs("--resume");
  const maxIterationsOverride: any = parseCliArgs("--max");
  const promiseOverride = parseCliArgs("--promise");
  const modelOverride = parseCliArgs("--model");
  const personaOverride = parseCliArgs("--persona");
  const reasoningEffortOverride = parseCliArgs("--think");
  const timeout = parseCliArgs("--timeout") || 86400 * 7; // 7 days

  // Positional args: everything from argv[2] until first "-" prefixed arg
  // Handles `bun script.ts -- ls -la` since Bun strips "--" and passes [ls, -la]
  const positionalArgs = getPositionalArgs();
  const firstArg = positionalArgs[0];
  const isYamlFile = firstArg?.endsWith(".yaml") || firstArg?.endsWith(".yml");

  configFile = isYamlFile ? firstArg : parseCliArgs("--config");
  const commandPrompt =
    !isYamlFile && !directPrompt && positionalArgs.length > 0
      ? positionalArgs.join(" ")
      : null;

  if (
    !configFile &&
    !directPrompt &&
    !commandPrompt &&
    !sessionOverride &&
    !parseCliArgs("--debug")
  ) {
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
  } else if (commandPrompt) {
    initialPrompt = commandPrompt;
  } else if (appendPrompt) {
    initialPrompt += "\n" + appendPrompt;
  }

  // Use confirm mode for --debug or bare --resume (no session ID provided)
  const mode =
    parseCliArgs("--debug") || sessionOverride === true ? "confirm" : "yolo";

  // Apply CLI overrides to promptConfig
  if (sessionOverride === true) {
    // --resume without session ID: read last session from tracking file
    if (existsSync(LAST_SESSION_FILE)) {
      gSessionId = readFileSync(LAST_SESSION_FILE, "utf-8").trim();
      logger.log(`🔄 Resuming last session: ${gSessionId}`);
    } else {
      logger.error("No previous session found to resume.");
      process.exit(1);
    }
  } else if (sessionOverride) {
    gSessionId = sessionOverride as string;
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
  if (personaOverride) {
    promptConfig.persona = personaOverride;
  }
  if (reasoningEffortOverride) {
    promptConfig.reasoningEffort = reasoningEffortOverride;
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
