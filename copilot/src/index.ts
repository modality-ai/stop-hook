#!/usr/bin/env bun

import {
  SweAgentInteraction,
  getSessionId,
  type AIOptions,
} from "./SweAgentInteraction";
import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  writeSync,
  existsSync,
  mkdirSync,
} from "fs";
import { appendFile } from "fs/promises";
import { execSync } from "child_process";

const COPILOT_LOOP_DIR = "/tmp/copilot-loop";
mkdirSync(COPILOT_LOOP_DIR, { recursive: true });

const LAST_SESSION_FILE = `${COPILOT_LOOP_DIR}/last-session`;
const MODELS_CACHE_FILE = `${COPILOT_LOOP_DIR}/models.json`;
// Map keyed by jobId: pre-hook sets actuator results, post-hook looks up by jobId to avoid race conditions
let sessionTimout: NodeJS.Timeout;
let healthCheckHandle: NodeJS.Timeout;
let currentSession: CopilotSession;
// Global session ID - Snowflake-like ID (distributed system friendly)
let gSessionId = getSessionId();
const gToolPools = Object.create(null);
const gToolTimeMap = Object.create(null);
let gToolRunning = false;
let gNeedContinue = false;
let loopId = gSessionId;

/** Shell-escape a string using single quotes (POSIX-safe, handles all metacharacters) */
const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

/** Print a colorful unified diff between oldStr and newStr for a given file path */
const printColorDiff = (
  filePath: string,
  oldStr: string,
  newStr: string
): void => {
  const RESET = "\x1b[0m";
  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const CYAN = "\x1b[36m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const id = Date.now();
  const tmpOld = `${COPILOT_LOOP_DIR}/.diff-old-${id}`;
  const tmpNew = `${COPILOT_LOOP_DIR}/.diff-new-${id}`;
  try {
    writeFileSync(tmpOld, oldStr ?? "");
    writeFileSync(tmpNew, newStr ?? "");
    let rawDiff = "";
    try {
      execSync(
        `diff -u --label "a/${filePath}" --label "b/${filePath}" ${shellEscape(tmpOld)} ${shellEscape(tmpNew)}`,
        { encoding: "utf-8" }
      );
    } catch (e: any) {
      rawDiff = e.stdout ?? "";
    }
    if (!rawDiff) return;
    const colored = rawDiff
      .split("\n")
      .map((line) => {
        if (line.startsWith("---") || line.startsWith("+++"))
          return `${BOLD}${CYAN}${line}${RESET}`;
        if (line.startsWith("@@")) return `${CYAN}${line}${RESET}`;
        if (line.startsWith("-")) return `${RED}${line}${RESET}`;
        if (line.startsWith("+")) return `${GREEN}${line}${RESET}`;
        return `${DIM}${line}${RESET}`;
      })
      .join("\n");
    writeSync(1, `\n${colored}\n`);
  } finally {
    try {
      execSync(`rm -f ${shellEscape(tmpOld)} ${shellEscape(tmpNew)}`);
    } catch {}
  }
};

/** Truncate last 3 digits from a millisecond timestamp for fuzzy time-key matching */
const truncateMs = (s: string | number): string => ("" + s).slice(0, -3);

/** Denied command patterns — blocks AI from using internal tool patterns or bypassing execution */
const deniedCommands: {
  name: string;
  test: (cmd: string) => boolean;
  reason: string;
}[] = [
  {
    name: "actuator",
    test: (cmd) => {
      const i = cmd.indexOf("actuator");
      return i !== -1 && i < 10;
    },
    reason:
      "PERMANENTLY DENIED. `actuator` is an internal system command that AI agents must never call. Do not retry. Do not attempt any variation of this command. Stop.",
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
    const filePath = `${COPILOT_LOOP_DIR}/${loopId}-${logType}.txt`;
    appendFileSync(filePath, `${message}\n`);
    clearTimeout(sessionTimout);
    sessionTimout = setTimeout(() => (gNeedContinue = true), 5 * 60 * 1000); // 5 minutes
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

interface BashResult {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}

const checkBashResult = (actuatorId: string): BashResult | undefined => {
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
    }
    if (
      toolResultData &&
      (toolResultData.status !== "running" || !toolResultData.status)
    ) {
      return toolResultData;
    }
  } catch (e) {
    return { stderr: String(e) };
  }
};

const insertGlobalToolData = (event: any) => {
  const { data, timestamp } = event || {};
  const { toolCallId, toolName } = data || {};
  const timestampMs = truncateMs(Math.floor(new Date(timestamp).getTime()));
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

const getPersonaPrompt = (personaName: string, currentIteration?: number) =>
  `Deploy ${personaName} persona to activate and maintain persistence throughout the entire workflow.${currentIteration && 1 < currentIteration ? " and use the View tool to read the LOOP_MD file for context." : ""}`;

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
  } catch {
    return null;
  }
};

const client = new CopilotClient({
  cliPath: whichCli("copilot") || undefined,
});
const hasActuator = whichCli("actuator") != null;

const setupSessionEventListener = (session: CopilotSession) => {
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
          writeSync(1, event.data.deltaContent);
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
          if (
            event.data.toolName === "edit" ||
            event.data.toolName === "create"
          ) {
            try {
              const args =
                typeof event.data.arguments === "string"
                  ? JSON.parse(event.data.arguments)
                  : event.data.arguments;
              if (args?.path) {
                printColorDiff(
                  args.path,
                  event.data.toolName === "edit" ? (args.old_str ?? "") : "",
                  event.data.toolName === "edit"
                    ? (args.new_str ?? "")
                    : (args.content ?? "")
                );
              }
            } catch {}
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
              clearTimeout(actuatorTimer);
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
          writeSync(1, event.data.deltaContent);
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
          if (null != promptConfig.persona) {
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
          logger.log(
            `🔀 Mode changed: ${event.data.previousMode} → ${event.data.newMode}`
          );
          break;

        case "session.plan_changed":
          logger.log(`📋 Plan ${event.data.operation}`);
          break;

        case "session.workspace_file_changed":
          logger.log(
            `📁 Workspace file ${event.data.operation}: ${event.data.path}`
          );
          break;

        case "session.shutdown":
          logger.log(`🛑 Session shutdown (${event.data.shutdownType})`);
          break;

        case "session.context_changed":
          logger.log(`📂 Context changed: ${event.data.cwd}`);
          break;

        case "session.task_complete":
          if (event.data.summary)
            logger.log(`✅ Task complete: ${event.data.summary}`);
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
        case "permission.requested":
        case "permission.completed":
          break;

        default:
          writeSync(1, `❓ Unhandled event type: ${event.type}\n`);
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
  const finalSystemPromptMode = systemPromptModes.includes(systemPromptMode)
    ? systemPromptMode
    : systemPromptModes[0];
  logger.log(
    `🚀 Initializing session with model: ${model} ${reasoningEffort ? "reasoningEffort: " + reasoningEffort : "..."}`
  );
  logger.log(`   📌 systemPromptMode: ${systemPromptMode}`);
  logger.log(`   📌 Session ID: ${gSessionId} | Loop ID: ${loopId}`);
  const sessionOptions = {
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
        return { kind: "denied-by-rules" as const, rules: [] };
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
            additionalContext: denied.reason,
          };
        }
        switch (toolName) {
          case "bash":
          case "shell":
            try {
              appendFile(
                `${COPILOT_LOOP_DIR}/command.log`,
                `${timestamp} [${gSessionId}] ${command}\n`
              ).catch(() => {});
              if (hasActuator) {
                const actuatorId =
                  gToolTimeMap[`${truncateMs(timestamp)}-${toolName}`];
                const jobId = actuatorId || `job-${Date.now()}`;
                // Two forms needed:
                //   escCommand — shell-escaped, for embedding in shell strings (modifiedCommand)
                //   rawCommand — unescaped, for Bun.spawnSync array args (no shell)
                // When command starts with ": ", it's a re-intercepted modifiedCommand
                // where the embedded command is already shell-escaped.
                let rawCommand: string;
                let escCommand: string;
                if (command.startsWith(": ")) {
                  escCommand = command.slice(2, command.lastIndexOf("; cat "));
                  // Reverse shellEscape: strip outer single quotes and unescape inner
                  rawCommand = escCommand.startsWith("'")
                    ? escCommand.slice(1, -1).replace(/'\\''/g, "'")
                    : escCommand;
                } else {
                  rawCommand = command;
                  escCommand = shellEscape(command);
                }
                if (!rawCommand.trim()) {
                  return { permissionDecision: "allow" };
                }
                try {
                  // Start command via actuator async (returns immediately, no output)
                  // NOTE: Do NOT use -w (write mode) with -a (async) — write mode
                  // blocks until command completes, defeating async fire-and-forget.
                  // The polling mechanism (checkBashResult) handles waiting for completion.
                  // NOTE: Use Bun.spawnSync with array args instead of execSync to:
                  //   - Avoid shell overhead and event loop freeze from shell spawning
                  //   - Eliminate shell injection risks (no metachar interpretation)
                  //   - Pass command directly to actuator without double-escaping
                  const actuatorArgs = ["-a", "-j", jobId, "---", rawCommand];
                  logger.log(
                    `🐚 Actuator Start: actuator ${actuatorArgs.join(" ")}`
                  );
                  const startResult = Bun.spawnSync([
                    "actuator",
                    ...actuatorArgs,
                  ]);
                  gToolRunning = true;
                  if (startResult.exitCode !== 0) {
                    throw new Error(`exit ${startResult.exitCode}`);
                  }
                } catch (e) {
                  logger.error(
                    `🐚 Actuator start failed, falling back to raw bash | jobId=${jobId} | cmd=${rawCommand} | error=${e instanceof Error ? e.message : String(e)}`
                  );
                  return { permissionDecision: "allow" };
                }

                // Start streaming monitor for logging (non-blocking)
                const streamProc = {
                  ref: null as ReturnType<typeof Bun.spawn> | null,
                };
                let actuatorTimer: NodeJS.Timeout | null = null;
                if (actuatorId) {
                  actuatorTimer = setTimeout(async () => {
                    const proc = Bun.spawn(["actuator", "-s", "-p", jobId], {
                      stdout: "pipe",
                    });
                    streamProc.ref = proc;
                    const reader = proc.stdout.getReader();
                    const decoder = new TextDecoder();
                    logger.log(`🐚 Start to monitor ${actuatorId}`);
                    let buffer = "";
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done || null == actuatorTimer) break;
                      buffer += decoder.decode(value, { stream: true });
                      const lines = buffer.split("\n");
                      buffer = lines.pop() ?? "";
                      for (const line of lines) {
                        if (line.trim()) logger.log(`🐚 ${line}`);
                      }
                    }
                  }, 5000);
                  if (gToolPools[actuatorId]) {
                    gToolPools[actuatorId].timer = actuatorTimer;
                  }
                }

                // Poll until command completes
                const result: BashResult = await new Promise((resolve) => {
                  const interval = setInterval(() => {
                    const pollResult = checkBashResult(jobId);
                    if (pollResult) {
                      clearInterval(interval);
                      resolve(pollResult);
                    }
                    logger.log(`🐚 Wait ${jobId}`);
                  }, 3000);
                });

                // Clean up streaming monitor — kill process to prevent zombie
                if (actuatorTimer) {
                  clearTimeout(actuatorTimer);
                  gToolRunning = false;
                  actuatorTimer = null;
                  try {
                    streamProc.ref?.kill();
                  } catch {}
                }
                const relayFile = `${COPILOT_LOOP_DIR}/.relay-${getSessionId()}`;
                const commandArr = [];
                if (result.stdout) {
                  const stdoutFile = `${relayFile}.stdout`;
                  writeFileSync(stdoutFile, result.stdout);
                  commandArr.push(`cat ${stdoutFile}; rm -f ${stdoutFile}`);
                }
                if (result.stderr) {
                  const stderrFile = `${relayFile}.stderr`;
                  writeFileSync(stderrFile, result.stderr);
                  commandArr.push(
                    result.stdout
                      ? `dd >&2 2>/dev/null < ${stderrFile}; rm -f ${stderrFile}`
                      : `cat ${stderrFile} >&2; rm -f ${stderrFile}`
                  );
                }
                if (!commandArr.length) {
                  commandArr.push("cat /dev/null"); // No output, but ensure have cat
                }
                commandArr.push(`(exit ${result.exit_code ?? 1})`);
                logger.log(
                  `🐚 Actuator Result: ${JSON.stringify(result, null, 2)}`
                );

                // Run no-op — post-hook replaces this dummy output with actual result
                // Use a random nonce so AI cannot learn or replicate the pattern
                const modifiedCommand = `: ${escCommand}; ${commandArr.join("; ")}`;
                logger.log(`🐚 Modified Command: ${modifiedCommand}`);

                return {
                  permissionDecision: "allow",
                  modifiedArgs: {
                    ...toolArgsData,
                    mode: "sync",
                    detach: false,
                    timeout: false,
                    command: modifiedCommand,
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
        ...sessionOptions,
        sessionId: gSessionId,
      });
    } else {
      session = await client.resumeSession(gSessionId, sessionOptions);
    }
  } catch (error) {
    session = await client.createSession({
      ...sessionOptions,
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
      .then((response) => {
        mainResponse = response?.data?.content ?? "";
      })
      .catch((error) => {
        mainResponse = String(error);
      });
  };
  say(prompt);
  return new Promise<string>((resolve) => {
    const checkInterval = setInterval(async () => {
      if (mainResponse) {
        clearInterval(checkInterval);
        await session.sendAndWait(
          { prompt: `Use edit tool to update LOOP_MD for: ${mainResponse}` },
          sendTimeoutMs
        );
        resolve(mainResponse);
      }
      if (gNeedContinue) {
        gNeedContinue = false;
        say(
          `Continue — review your progress and proceed with the next step toward completing the task.`
        );
      }
    }, 500);
  });
};

const aiCommand = async (prompt: any, aiOption: AIOptions) => {
  const { systemPrompt, mode, currentIteration }: AIOptions = aiOption;
  const abortController = new AbortController();
  const session = await initSession(systemPrompt, promptConfig);
  currentSession = session;

  // Periodic server health check via ping
  const healthCheckIntervalMs = 3000; // 3 seconds
  const pingTimeoutMs = 1000; // 1 second timeout for ping response
  healthCheckHandle = setInterval(async () => {
    let timeout = 0;
    try {
      await Promise.race([
        client.ping("O.K."),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Ping timeout")), pingTimeoutMs)
        ),
      ]);
      writeSync(1, ".");
    } catch (error) {
      logger.error(`⚠️  Server hang detected: ${(error as Error).message}`);
      if (timeout >= 3 && !gToolRunning) {
        abortController.abort();
      }
      timeout += 1;
    }
  }, healthCheckIntervalMs);

  try {
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
      new Promise((_, reject) => {
        const interval = setInterval(() => {
          if (abortController.signal.aborted) {
            clearInterval(interval);
            reject(new Error("Operation aborted due to server hang"));
          }
        }, 5000);
        abortController.signal.addEventListener("abort", () => {
          reject(new Error("Operation aborted due to server hang"));
        });
      }),
    ]);
    return response;
  } catch (error) {
    const errorMessage = (error as Error).message || "";
    if (abortController.signal.aborted) {
      logger.error(
        "Returning to readline due to server hang - next loop will handle recovery",
        errorMessage
      );
    } else {
      logger.error("Error during AI command execution:", errorMessage);
    }
    return "";
  } finally {
    if (mode === "yolo") {
      gSessionId = getSessionId();
    }
    clearInterval(healthCheckHandle);
    session.disconnect();
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
  let appendPrompt: any = parseCliArgs("-a");
  const sessionOverride = parseCliArgs("-r") || parseCliArgs("--resume");
  const maxIterationsOverride: any = parseCliArgs("--max");
  const promiseOverride = parseCliArgs("--promise");
  const modelOverride = parseCliArgs("--model");
  const personaOverride = parseCliArgs("--persona");
  const loopIdOverride = parseCliArgs("--loop-id");
  const reasoningEffortOverride =
    parseCliArgs("--think") ??
    (process.argv.includes("--think") ? "medium" : null);
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

  const positionalText = positionalArgs.join(" ");

  // Append mode: -a flag + --- boundary → treat positional args as append content
  if (
    process.argv.includes("-a") &&
    ddIndex !== -1 &&
    !appendPrompt &&
    positionalArgs.length > 0
  ) {
    appendPrompt = positionalText;
  }

  const commandPrompt =
    !isYamlFile && !directPrompt && !appendPrompt && positionalArgs.length > 0
      ? positionalText
      : null;

  if (
    !configFile &&
    !directPrompt &&
    !commandPrompt &&
    !appendPrompt &&
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
