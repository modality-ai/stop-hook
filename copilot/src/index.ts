#!/usr/bin/env bun

import {
  SweAgentInteraction,
  getSessionId,
  type AIOptions,
} from "./SweAgentInteraction";
import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "fs";
import { appendFile } from "fs/promises";
import { execSync } from "child_process";

const LAST_SESSION_FILE = "/tmp/copilot-loop-last-session";
const MODELS_CACHE_FILE = "/tmp/copilot-loop-models.json";
const gToolPools = Object.create(null);
const gToolTimeMap = Object.create(null);
let sessionTimout: NodeJS.Timeout;
let healthCheckHandle: NodeJS.Timeout;
let currentSession: CopilotSession;
// Global session ID - Snowflake-like ID (distributed system friendly)
let gSessionId = getSessionId();
let loopId = gSessionId;
let gAbortController: AbortController | null = null;

/** Shell-escape a string using single quotes (POSIX-safe, handles all metacharacters) */
const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

/** Print a colorful unified diff between oldStr and newStr for a given file path */
const printColorDiff = (filePath: string, oldStr: string, newStr: string): void => {
  const RESET = "\x1b[0m";
  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const CYAN = "\x1b[36m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const id = Date.now();
  const tmpOld = `/tmp/.diff-old-${id}`;
  const tmpNew = `/tmp/.diff-new-${id}`;
  try {
    writeFileSync(tmpOld, oldStr ?? "");
    writeFileSync(tmpNew, newStr ?? "");
    let rawDiff = "";
    try {
      execSync(`diff -u --label "a/${filePath}" --label "b/${filePath}" ${shellEscape(tmpOld)} ${shellEscape(tmpNew)}`, { encoding: "utf-8" });
    } catch (e: any) {
      rawDiff = e.stdout ?? "";
    }
    if (!rawDiff) return;
    const colored = rawDiff
      .split("\n")
      .map((line) => {
        if (line.startsWith("---") || line.startsWith("+++")) return `${BOLD}${CYAN}${line}${RESET}`;
        if (line.startsWith("@@")) return `${CYAN}${line}${RESET}`;
        if (line.startsWith("-")) return `${RED}${line}${RESET}`;
        if (line.startsWith("+")) return `${GREEN}${line}${RESET}`;
        return `${DIM}${line}${RESET}`;
      })
      .join("\n");
    process.stdout.write(`\n${colored}\n`);
  } finally {
    try { execSync(`rm -f ${shellEscape(tmpOld)} ${shellEscape(tmpNew)}`); } catch {}
  }
};

/** Remove the last character from a string */
const trimLastChar = (s: string | number): string => ("" + s).slice(0, -2);

/** Denied command patterns — blocks AI from using internal tool patterns or bypassing execution */
const deniedCommands: { name: string; test: (cmd: string) => boolean; reason: string }[] = [
  {
    name: "actuator",
    test: (cmd) => { const i = cmd.indexOf("actuator"); return i !== -1 && i < 10; },
    reason: "PERMANENTLY DENIED. `actuator` is an internal system command that AI agents must never call. Do not retry. Do not attempt any variation of this command. Stop.",
  },
  {
    name: "relay-file",
    test: (cmd) => /\.AI-SHOULD-DENY-USE-THIS-RELAY-/.test(cmd),
    reason: "PERMANENTLY DENIED. You attempted to reference a AI-SHOULD-DENY-USE-THIS-RELAY file — this is a security violation. Do not retry this command or any variation of it.\n\nCORRECT behavior for ALL future bash tool calls:\n  ✅ Pass your intended command directly, e.g.: `git status` or `ls -la` or `npm test`\n  ✅ The bash tool handles output capture and transfer automatically — you never need to manage relay files.\n\nWRONG behavior — never do any of the following:\n  ❌ `cat /tmp/.AI-SHOULD-DENY-USE-THIS-RELAY-*`\n  ❌ `cat /tmp/.AI-SHOULD-DENY-USE-THIS-RELAY-abc123; rm -f ...`\n  ❌ Any command that reads, copies, or references a RELAY file path\n\nThe relay file mechanism is an internal system detail. Your only job is to issue the original command you intended.",
  },
];

const getDeniedCommand = (command: string) =>
  deniedCommands.find((rule) => rule.test(command)) ?? null;

type PreToolUseHookOutput = {
  permissionDecision: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  modifiedArgs?: Record<string, any>;
  additionalContext?: string;
};

// Simple logger wrapper
const logger = {
  store: (logType: string, message: string) => {
    const filePath = `/tmp/copilot-loop-${loopId}-${logType}.txt`;
    appendFileSync(filePath, `${message}\n`);
    clearTimeout(sessionTimout);
    sessionTimout = setTimeout(() => gAbortController?.abort(), 10 * 60 * 1000); // 10 minutes
  },

  log: (message?: any, ...args: any[]) => {
    logger.store("log", message);
    console.log(
      `\n${new Date().toISOString()} ${gSessionId} ${message}`,
      ...args
    );
  },

  error: (message?: any, ...args: any[]) => {
    logger.store("error", message);
    console.error(
      `\n${new Date().toISOString()} ${gSessionId} ${message}`,
      ...args
    );
  },
};

const checkBashResult = (actuatorId: string) => {
  const result = [];
  const actuatorCmd = `actuator -p ${actuatorId}`;
  const toolResultJson = execSync(actuatorCmd, {
    encoding: "utf-8",
  });
  try {
    const toolResultData = JSON.parse(toolResultJson);
    if (toolResultData.error) {
      logger.error(
        `🐚 Actuator Tool Error:\n${toolResultData.error}\nCommand: ${actuatorCmd}`
      );
      return false;
    }
    if (toolResultData) {
      if (toolResultData.status !== "running") {
        if (toolResultData.stdout) {
          result.push(toolResultData.stdout);
        }
        if (toolResultData.stderr) {
          result.push(toolResultData.stderr);
        }
        result.push(`<exited with exit code ${toolResultData.exit_code}>`);
        return result.join("\n");
      }
    }
  } catch (e) {}
};

const insertGlobalToolData = (event: any) => {
  const { data, timestamp } = event || {};
  const { toolCallId, toolName } = data || {};
  const timestampMs = trimLastChar(Math.floor(new Date(timestamp).getTime()));
  const timeKey = `${timestampMs}-${toolName}`;
  gToolTimeMap[timeKey] = toolCallId;
  gToolPools[event.data.toolCallId] = {
    start: event,
    timeKey,
  };
};

const loadCachedModelIds = (): string[] | null => {
  if (!existsSync(MODELS_CACHE_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(MODELS_CACHE_FILE, "utf-8"));
    return Array.isArray(data)
      ? data.map((m: any) => m.id).filter(Boolean)
      : null;
  } catch {
    return null;
  }
};

const saveModelsCache = (models: any[]) => {
  writeFileSync(MODELS_CACHE_FILE, JSON.stringify(models, null, 2));
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
  const booleanFlags = ["--debug", "--resume", "-r", "--update-models"];
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
const loadPromptFile = async (
  filePath: string
): Promise<Record<string, any>> => {
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

const getPersonaPrompt = (personaName: string, currentIteration?: number) => {
  const personaPropmpt = `Deploy ${personaName} persona to activate and maintain persistence throughout the entire workflow.${currentIteration && 1 < currentIteration ? " and use the View tool to read the LOOP_MD file for context." : ""}`;
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
    clearInterval(healthCheckHandle);

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
    return output?.trim();
  } catch (error) {
    return null;
  }
};

const client = new CopilotClient({
  cliPath: whichCli("copilot") || undefined,
});
const hasActuator = whichCli("actuator") != null;

const setupSessionEventListener = (
  session: CopilotSession
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
              `📊 Usage - Current: ${event.data.currentTokens}, Limit: ${event.data.tokenLimit}, Messages: ${event.data.messagesLength}`
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
          insertGlobalToolData(event);
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
            const toolCallId = event.data.toolCallId;
            const globalToolData = gToolPools[toolCallId]?.start?.data;
            const actuatorTimer = gToolPools[toolCallId]?.timer;
            if (globalToolData) {
              if (actuatorTimer) {
                clearTimeout(actuatorTimer);
              }
              delete gToolTimeMap[globalToolData?.timeKey];
              delete gToolPools[toolCallId];
            }
            logger.log(`   ✓ Tool completed - ${globalToolData?.toolName}`);
            if (event.data.result && event.data.result.content) {
              const preview = event.data.result.content.slice(0, 150);
              logger.log(
                `   Result: ${preview}${event.data.result.content.length > 150 ? "..." : ""}`
              );
            }
            if (globalToolData?.toolName === "edit") {
              try {
                const args = typeof globalToolData.arguments === "string"
                  ? JSON.parse(globalToolData.arguments)
                  : globalToolData.arguments;
                if (args?.path) {
                  printColorDiff(args.path, args.old_str ?? "", args.new_str ?? "");
                }
              } catch {}
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

        case "assistant.streaming_delta":
          // Streaming progress metrics only (totalResponseSizeBytes) - no content
          break;

        case "assistant.usage":
          // Usage info for this message
          const { entitlementRequests, usedRequests, overage } =
            event?.data?.quotaSnapshots?.premium_interactions || {};
          if (event.data.quotaSnapshots.premium_interactions) {
            logger.log(
              `   [Cost: ${event?.data?.cost} / ${event?.data?.model}]`
            );
            logger.log(
              `   [Premium used: ${usedRequests}/${entitlementRequests} requests, overage: ${overage}]`
            );
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
          if (null != promptConfig.persona && session) {
            session.send({
              prompt: getPersonaPrompt(promptConfig.persona),
            });
          }
          break;
        case "pending_messages.modified":
          break;

        // ─────────────────────────────────────────────────────────────
        // NEW SDK EVENT TYPES
        // ─────────────────────────────────────────────────────────────

        case "session.title_changed":
          logger.log(`📝 Session title: ${event.data.title}`);
          break;

        case "session.warning":
          logger.log(`⚠️  Session warning: ${event.data.message}`);
          break;

        case "session.mode_changed":
          logger.log(`🔀 Mode changed: ${event.data.previousMode} → ${event.data.newMode}`);
          break;

        case "session.plan_changed":
          logger.log(`📋 Plan ${event.data.operation}`);
          break;

        case "session.workspace_file_changed":
          logger.log(`📁 Workspace file ${event.data.operation}: ${event.data.path}`);
          break;

        case "session.shutdown":
          logger.log(`🛑 Session shutdown (${event.data.shutdownType})`);
          break;

        case "session.context_changed":
          logger.log(`📂 Context changed: ${event.data.cwd}`);
          break;

        case "session.task_complete":
          if (event.data.summary) logger.log(`✅ Task complete: ${event.data.summary}`);
          break;

        case "tool.user_requested":
          logger.log(`👤 User requested tool: ${event.data.toolName}`);
          break;

        case "skill.invoked":
          logger.log(`🎯 Skill invoked: ${event.data.name}`);
          break;

        case "system.message":
          logger.store("log", `🔧 System message: ${event.data.content}`);
          break;

        case "session.resume":
        case "session.handoff":
        case "session.snapshot_rewind":
        case "session.compaction_start":
          break;

        default:
          process.stdout.write(`❓ Unhandled event type: ${event.type}\n`);
          break;
      }
    } catch (error) {
      logger.error("Event handler error:", error);
    }
  });
};

const systemPromptModes = ["append", "replace"] as const;

const initSession = async (
  systemPrompt: string,
  options: any = {},
  session?: CopilotSession
): Promise<CopilotSession> => {
  if (null == options.model) {
    delete options.model;
  }
  const defaultModel = options.reasoningEffort ? "gpt-5-mini" : "gpt-4.1";
  const {
    model = defaultModel,
    reasoningEffort,
    mcpServers,
    systemPromptMode = systemPromptModes[0],
  } = options;
  let finalSystemPromptMode = systemPromptModes.includes(systemPromptMode)
    ? systemPromptMode
    : systemPromptModes[0];
  logger.log(
    `🚀 Initializing session with model: ${model} ${reasoningEffort ? "reasoningEffort: " + reasoningEffort : "..."}`
  );
  logger.log(`   📌 systemPromptMode: ${systemPromptMode}`);
  logger.log(`   📌 Session ID: ${gSessionId} | Loop ID: ${loopId}`);
  const sessionOptoins = {
    model,
    mcpServers,
    streaming: true,
    systemMessage: {
      mode: finalSystemPromptMode, // [append | replace] - whether to append to or replace the default system SDK security guardrails
      content: systemPrompt,
    },
    reasoningEffort, // [low|medium|high|xhigh] Ensure maximum reasoning effort for new sessions
    infiniteSessions: {
      // https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts#L584
      backgroundCompactionThreshold: 0.65,
    },
    onPermissionRequest: async (request: any) => {
      const denyTools: string[] = promptConfig["denyTools"] ?? [];
      if (denyTools.includes(request?.kind)) {
        logger.log(`🚫 Permission denied for tool: ${request?.kind}`);
        return { kind: "denied-by-rules" as const };
      }
      return { kind: "approved" as const };
    },
    hooks: {
      onPreToolUse: async (input: any): Promise<PreToolUseHookOutput> => {
        const { toolName, timestamp, toolArgs } = input || {};
        const denyTools: string[] = promptConfig["denyTools"] ?? [];
        if (denyTools.includes(toolName)) {
          logger.log(`🚫 Pre-tool denied: ${toolName}`);
          return { permissionDecision: "deny" };
        }
        let toolArgsData;
        try {
          toolArgsData = JSON.parse(toolArgs);
        } catch (error) {
          toolArgsData = {};
        }
        const { command = "" } = toolArgsData || {};
        const denied = getDeniedCommand(command);
        if (denied) {
          logger.log(`🚫 Pre-tool denied: ${denied.name}`);
          return {
            permissionDecision: "deny",
            permissionDecisionReason: denied.reason,
          };
        }
        switch (toolName) {
          case "bash":
          case "shell":
            try {
              appendFile(
                "/tmp/copilot-loop-command.log",
                `${timestamp} [${gSessionId}] ${command}\n`
              ).catch(() => {});
              if (hasActuator) {
                const actuatorId =
                  gToolTimeMap[`${trimLastChar(timestamp)}-${toolName}`];
                const jobId = actuatorId || `job-${Date.now()}`;

                // Start command via actuator async (returns immediately, no output)
                const actuatorStartCmd = `actuator -a -j ${jobId} --- ${shellEscape(command)}`;
                logger.log(`🐚 Actuator Start: ${actuatorStartCmd}`);

                try {
                  execSync(actuatorStartCmd, { encoding: "utf-8" });
                } catch (e) {
                  logger.error(
                    `🐚 Actuator start failed, falling back to raw bash`
                  );
                  return { permissionDecision: "allow" };
                }

                // Start streaming monitor for logging (non-blocking)
                if (actuatorId && gToolPools[actuatorId]) {
                  gToolPools[actuatorId].timer = setTimeout(async () => {
                    const proc = Bun.spawn(["actuator", "-s", "-p", jobId], {
                      stdout: "pipe",
                    });
                    const reader = proc.stdout.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      buffer += decoder.decode(value, { stream: true });
                      const lines = buffer.split("\n");
                      buffer = lines.pop() ?? "";
                      for (const line of lines) {
                        if (line.trim()) logger.log(`🐚 ${line}`);
                      }
                    }
                  }, 5000);
                }

                // Poll until command completes
                const result: {
                  stdout: string;
                  stderr: string;
                  exit_code: number;
                } = await new Promise((resolve) => {
                  const interval = setInterval(() => {
                    const pollResult = checkBashResult(jobId);
                    if (pollResult) {
                      clearInterval(interval);
                      // checkBashResult returns formatted string, but we need structured data
                      try {
                        const raw = execSync(`actuator -p ${jobId}`, {
                          encoding: "utf-8",
                        });
                        const data = JSON.parse(raw);
                        resolve({
                          stdout: data.stdout || "",
                          stderr: data.stderr || "",
                          exit_code: data.exit_code ?? 0,
                        });
                      } catch {
                        resolve({
                          stdout: String(pollResult),
                          stderr: "",
                          exit_code: 0,
                        });
                      }
                    }
                  }, 1000);
                });

                // Build curated output for LLM
                const parts: string[] = [];
                if (result.stdout) parts.push(result.stdout);
                if (result.stderr) parts.push(result.stderr);
                const curatedOutput = parts.join("\n");
                logger.log(
                  `🐚 Actuator Result (${curatedOutput.length} chars, exit=${result.exit_code}): ${curatedOutput.slice(0, 200)}`
                );

                // Relay result via self-destructing temp file (prevents AI from learning output-faking patterns)
                const relayFile = `/tmp/.AI-SHOULD-DENY-USE-THIS-RELAY-${getSessionId()}`;
                writeFileSync(relayFile, curatedOutput);
                const relayCmd =
                  result.exit_code === 0
                    ? `cat ${relayFile}; rm -f ${relayFile}`
                    : `cat ${relayFile} >&2; rm -f ${relayFile}; exit ${result.exit_code}`;

                return {
                  permissionDecision: "allow",
                  additionalContext: "AI-AGENT: This is an internal relay command. Do not reference, copy, or retry this path. Always use your original intended command directly.",
                  modifiedArgs: {
                    ...toolArgsData,
                    command: relayCmd,
                  },
                };
              }
            } catch (error) {}
            break;
          default:
            logger.log(
              `⚠️  No pre-tool hook defined for tool: ${input.toolName}`
            );
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

  let cachedModelIds = loadCachedModelIds();
  if (null == cachedModelIds || parseCliArgs("--update-models")) {
    const models = await client.listModels();
    saveModelsCache(models);
    logger.log(
      `✅ Models cache updated: ${MODELS_CACHE_FILE} (${models.length} models)`
    );
    if (null == cachedModelIds) {
      cachedModelIds = models.map((m: any) => m.id).filter(Boolean);
    }
    if (parseCliArgs("--update-models")) {
      process.exit(0);
    }
  }
  if (!cachedModelIds.includes(model)) {
    logger.error(
      `❌ Model "${model}" is not available. Run --update-models to refresh.\n   Available: ${cachedModelIds.join(", ")}`
    );
    process.exit(1);
  }

  // Track session ID for --resume support
  writeFileSync(LAST_SESSION_FILE, `${gSessionId},${loopId}`);

  // Attach event listener immediately after session is created
  // Store the unsubscribe function to keep the listener alive
  setupSessionEventListener(session);
  return session;
};

const aiThinking = async (
  { prompt }: any,
  sendTimeoutMs: number,
  session: CopilotSession
) => {
  let mainResponse = "";

  const say = (prompt: string) => {
    if (!session) {
      logger.error("Session not initialized");
      return "";
    }
    session
      .sendAndWait({ prompt }, sendTimeoutMs)
      .then(async (response) => {
        const content = response?.data?.content ?? "";
        if (content) {
          mainResponse = content;
        }
      })
      .catch((error) => {
        mainResponse = error;
      });
  };
  say(prompt);
  return new Promise<string>((resolve, _reject) => {
    const checkInterval = setInterval(async () => {
      if (mainResponse !== "") {
        clearInterval(checkInterval);
        await session.sendAndWait(
          { prompt: `Use edit tool to update LOOP_MD for: ${mainResponse}` },
          sendTimeoutMs
        );
        resolve(mainResponse);
      }
    }, 500);
  });
};

const aiCommand = async (prompt: any, aiOption: AIOptions) => {
  const { systemPrompt, mode, currentIteration }: AIOptions = aiOption;
  const abortController = new AbortController();
  gAbortController = abortController;
  const session = await initSession(
    systemPrompt,
    promptConfig,
  );
  currentSession = session;

  // Periodic server health check via ping
  const healthCheckIntervalMs = 3000; // 3 seconds
  const pingTimeoutMs = 1000; // 1 second timeout for ping response
  healthCheckHandle = setInterval(async () => {
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

    const sendTimeoutMs = promptConfig.timeout * 1000;
    if (null != promptConfig.persona) {
      await session.sendAndWait(
        {
          prompt: getPersonaPrompt(promptConfig.persona, currentIteration),
        },
        sendTimeoutMs
      );
    } else {
      if (1 < currentIteration) {
        await session.sendAndWait(
          { prompt: "Use the View tool to read the LOOP_MD file for context." },
          sendTimeoutMs
        );
      }
    }
    // Race between aiThinking and abort signal
    const response = await Promise.race([
      aiThinking({ prompt }, sendTimeoutMs, session),
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
    if (mode === "yolo") {
      gSessionId = getSessionId();
    }
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
  --update-models         Update the local models cache file
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
  const loopIdOverride = parseCliArgs("--loop-id");
  const reasoningEffortOverride = parseCliArgs("--think");
  const timeout = parseCliArgs("--timeout") || 86400 * 7; // 7 days

  // Positional args: everything from argv[2] until first "-" prefixed arg
  // Handles `bun script.ts -- ls -la` since Bun strips "--" and passes [ls, -la]
  const positionalArgs = getPositionalArgs();
  const firstArg = positionalArgs[0];
  const isYamlFile = firstArg?.endsWith(".yaml") || firstArg?.endsWith(".yml");

  // When '---' boundary is used, the yaml config is before '---' in argv
  const ddIndex = process.argv.indexOf("---");
  const preArgs = ddIndex !== -1 ? process.argv.slice(2, ddIndex) : [];
  const yamlFromPreArgs = preArgs.find(
    (a) => a.endsWith(".yaml") || a.endsWith(".yml")
  );
  configFile = isYamlFile
    ? firstArg
    : yamlFromPreArgs || parseCliArgs("--config");
  const commandPrompt =
    !isYamlFile && !directPrompt && positionalArgs.length > 0
      ? positionalArgs.join(" ")
      : null;

  if (
    !configFile &&
    !directPrompt &&
    !commandPrompt &&
    !sessionOverride &&
    !parseCliArgs("--debug") &&
    !parseCliArgs("--update-models")
  ) {
    printHelp();
  }

  let initialPrompt = "";

  if (configFile) {
    logger.log(`🤖 Load config file ${configFile}...`);
    Object.assign(promptConfig, await loadPromptFile(configFile));
    initialPrompt = promptConfig.prompt || initialPrompt;
  }
  if (parseCliArgs("--update-models")) {
    initialPrompt = "--update-models";
  } else if (directPrompt) {
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
    try {
      if (existsSync(LAST_SESSION_FILE)) {
        const data = readFileSync(LAST_SESSION_FILE, "utf-8")
          ?.trim()
          .split(",");
        gSessionId = data?.[0] || gSessionId;
        loopId = data?.[1] || gSessionId;
        logger.log(`🔄 Resuming last session: ${gSessionId}`);
      } else {
        throw new Error("No session tracking file found");
      }
    } catch (error) {
      logger.error("No previous session found to resume.");
      process.exit(1);
    }
  } else if (sessionOverride) {
    gSessionId = sessionOverride as string;
  }
  if (loopIdOverride) {
    loopId = loopIdOverride as string;
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
    loopId,
  }).init(mode, initialPrompt);
  setupSignalHandlers(client, () => currentSession);
};

main();
