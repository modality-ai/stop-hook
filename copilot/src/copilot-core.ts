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
import { getSessionId } from "./SweAgentInteraction";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export type PreToolUseHookOutput = {
  permissionDecision: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  modifiedArgs?: Record<string, any>;
  additionalContext?: string;
};

export interface BashResult {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}

// ─────────────────────────────────────────────────────────────
// Paths & directories
// ─────────────────────────────────────────────────────────────
export const COPILOT_LOOP_DIR = "/tmp/copilot-loop";
mkdirSync(COPILOT_LOOP_DIR, { recursive: true });

export const LAST_SESSION_FILE = `${COPILOT_LOOP_DIR}/last-session`;
const MODELS_CACHE_FILE = `${COPILOT_LOOP_DIR}/models.json`;

// ─────────────────────────────────────────────────────────────
// Mutable state shared with index.ts
// ─────────────────────────────────────────────────────────────
const initialId = getSessionId();
const state = {
  gSessionId: initialId,
  loopId: initialId,
  gNeedContinue: false,
};

let sessionTimout: NodeJS.Timeout;
const gToolPools: Record<string, any> = Object.create(null);
const gToolTimeMap: Record<string, any> = Object.create(null);
let gToolRunning = false;

// ─────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────
const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const truncateMs = (s: string | number): string => ("" + s).slice(0, -3);

export const getState = () => state;

export const whichCli = (cli: string): string | null => {
  try {
    const output = execSync(`which ${cli}`, { encoding: "utf-8" });
    return output?.trim();
  } catch {
    return null;
  }
};

export const getPersonaPrompt = (
  personaName: string,
  currentIteration?: number
) =>
  `Deploy ${personaName} persona to activate and maintain persistence throughout the entire workflow.${currentIteration && 1 < currentIteration ? " and use the View tool to read the LOOP_MD file for context." : ""}`;

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

// ─────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────
export const logger = {
  resetTimeout: () => {
    clearTimeout(sessionTimout);
    sessionTimout = setTimeout(() => (state.gNeedContinue = true), 5 * 60 * 1000);
  },
  store: (logType: string, message: string) => {
    logger.resetTimeout();
    const filePath = `${COPILOT_LOOP_DIR}/${state.loopId}-${logType}.txt`;
    appendFileSync(filePath, `${message}\n`);
  },
  log: (message?: any, ...args: any[]) => {
    logger.store("log", message);
    console.log(
      `\n${new Date().toISOString()} ${state.gSessionId} ${message}`,
      ...args
    );
  },
  error: (message?: any, ...args: any[]) => {
    logger.store("error", message);
    console.error(
      `\n${new Date().toISOString()} ${state.gSessionId} ${message}`,
      ...args
    );
  },
};

export const setupHealthCheck = (client: CopilotClient, abortController: AbortController) => {
  // Periodic server health check via ping
  const healthCheckIntervalMs = 3000; // 3 seconds
  const pingTimeoutMs = 1000; // 1 second timeout for ping response
  let healthCheckHandle = setInterval(async () => {
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
  return () => clearInterval(healthCheckHandle);
};

// ─────────────────────────────────────────────────────────────
// Copilot client
// ─────────────────────────────────────────────────────────────
export const client = new CopilotClient({  // exported for setupSignalHandlers in index.ts
  cliPath: whichCli("copilot") || undefined,
});
const hasActuator = whichCli("actuator") != null;

// ─────────────────────────────────────────────────────────────
// Session event listener
// ─────────────────────────────────────────────────────────────
const setupSessionEventListener = (session: CopilotSession, options: any) => {
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

  return session.on((event: any) => {
    try {
      switch (event.type) {
        // ─────────────────────────────────────────────────────────────
        // SESSION LIFECYCLE EVENTS
        // ─────────────────────────────────────────────────────────────

        case "session.start":
          logger.log(`📍 Session started: ${event.data.sessionId}`);
          break;

        case "session.idle":
          if (process.stdout.isTTY) process.stdout.write("\n");
          break;

        case "session.error":
          logger.log(`❌ Session error: ${event.data.message}`);
          break;

        case "session.info":
          logger.log(`ℹ️  Session info: ${event.data.message}`);
          break;

        case "session.usage_info":
          if (event.data.currentTokens || event.data.tokenLimit) {
            logger.log(
              `📊 Usage - Current: ${event.data.currentTokens}, Limit: ${event.data.tokenLimit}, Messages: ${event.data.messagesLength}`
            );
          }
          break;

        // ─────────────────────────────────────────────────────────────
        // TURN LIFECYCLE
        // ─────────────────────────────────────────────────────────────

        case "assistant.turn_start":
          logger.log(
            `─── Assistant Turn ${event.data.turnId?.slice(0, 8) || "unknown"} ───`
          );
          break;

        case "assistant.turn_end":
          logger.log(`✓ Turn ended (${event.data.turnId?.slice(0, 8)})`);
          break;

        // ─────────────────────────────────────────────────────────────
        // AGENT DECISION MAKING
        // ─────────────────────────────────────────────────────────────

        case "assistant.intent":
          logger.log(`🎯 Agent Intent: ${event.data.intent}`);
          break;

        case "assistant.reasoning":
          logger.store("log", `💭 Reasoning:\n${event.data.content}`);
          break;

        case "assistant.reasoning_delta":
          logger.resetTimeout();
          writeSync(1, event.data.deltaContent);
          break;

        // ─────────────────────────────────────────────────────────────
        // TOOL EXECUTION
        // ─────────────────────────────────────────────────────────────

        case "tool.execution_start":
          insertGlobalToolData(event);
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
          logger.log(`   ⏳ ${event.data.progressMessage}`);
          break;

        case "tool.execution_partial_result":
          logger.log(`   📦 Partial Output: ${event.data.partialOutput}`);
          break;

        case "tool.execution_complete":
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
        // SUBAGENT EXECUTION
        // ─────────────────────────────────────────────────────────────

        case "subagent.started":
          logger.log(`🤖 Subagent started: ${event.data.agentDisplayName}`);
          break;

        case "subagent.selected":
          logger.log(`   → Selected agent: ${event.data.agentName}`);
          break;

        case "subagent.completed":
          logger.log(`   ✓ Subagent completed: ${event.data.agentName}`);
          break;

        case "subagent.failed":
          logger.log(`   ✗ Subagent failed: ${event.data.error}`);
          break;

        // ─────────────────────────────────────────────────────────────
        // ASSISTANT RESPONSE
        // ─────────────────────────────────────────────────────────────

        case "assistant.message":
          logger.store("log", `💭 ASSISTANT:\n${event.data.content}`);
          break;

        case "assistant.message_delta":
          logger.resetTimeout();
          writeSync(1, event.data.deltaContent);
          break;

        case "assistant.streaming_delta":
          break;

        case "assistant.usage": {
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
        }

        // ─────────────────────────────────────────────────────────────
        // OTHER EVENTS
        // ─────────────────────────────────────────────────────────────

        case "hook.start":
          logger.log(`🪝 Hook started: ${event.data.hookType}`);
          break;

        case "hook.end":
          logger.log(`   ✓ Hook completed: ${event.data.hookType}`);
          break;

        case "abort":
          logger.log(`⛔ Operation aborted: ${event.data.reason}`);
          break;

        case "session.model_change":
          logger.log(`🔄 Model changed to: ${event.data.newModel}`);
          break;

        case "user.message":
          logger.store("log", `💭 USER:\n${event.data.content}`);
          break;

        case "session.truncation":
        case "session.compaction_complete":
          if (null != options.persona) {
            session.send({
              prompt: getPersonaPrompt(options.persona),
            });
          }
          break;

        case "pending_messages.modified":
          break;

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
        case "session.tools_updated":
        case "session.background_tasks_changed":
        case "session.mcp_servers_loaded":
        case "session.mcp_server_status_changed":
        case "permission.requested":
        case "permission.completed":
          break;

        default:
          logger.resetTimeout();
          writeSync(1, `❓ Unhandled event type: ${event.type}\n`);
          break;
      }
    } catch (error) {
      logger.error("Event handler error:", error);
    }
  });
};

// ─────────────────────────────────────────────────────────────
// Session initialisation
// ─────────────────────────────────────────────────────────────
const systemPromptModes = ["append", "replace"] as const;

export const initSession = async (
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
  logger.log(`   📌 Session ID: ${state.gSessionId} | Loop ID: ${state.loopId}`);
  const sessionOptions = {
    model,
    mcpServers,
    streaming: true,
    systemMessage: {
      mode: finalSystemPromptMode,
      content: systemPrompt,
    },
    reasoningEffort,
    infiniteSessions: {
      // https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts#L584
      backgroundCompactionThreshold: 0.65,
    },
    onPermissionRequest: async (request: any) => {
      if (options["denyAllTools"]) {
        logger.log(`🚫 Server mode: permission blocked for: ${request?.kind}`);
        return { kind: "reject" as const };
      }
      const denyTools: string[] = options["denyTools"] ?? [];
      if (denyTools.includes(request?.kind)) {
        logger.log(`🚫 Permission denied for tool: ${request?.kind}`);
        return { kind: "reject" as const };
      }
      return { kind: "approve-once" as const };
    },
    hooks: {
      onPreToolUse: async (input: any): Promise<PreToolUseHookOutput> => {
        const { toolName, timestamp, toolArgs } = input || {};
        if (options["denyAllTools"]) {
          logger.log(`🚫 Server mode: tool execution blocked for: ${toolName}`);
          return {
            permissionDecision: "deny",
            permissionDecisionReason: "Tool execution is handled by the client in server mode.",
          };
        }
        const denyTools: string[] = options["denyTools"] ?? [];
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
                `${timestamp} [${state.gSessionId}] ${command}\n`
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
                  // NOTE: Do NOT use -w (write mode) with -a (async) — write mode
                  // blocks until command completes, defeating async fire-and-forget.
                  // NOTE: Use Bun.spawnSync with array args to avoid shell overhead
                  // and injection risks.
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
                  commandArr.push("cat /dev/null");
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
        sessionId: state.gSessionId,
      });
    } else {
      session = await client.resumeSession(state.gSessionId, sessionOptions);
    }
  } catch (error) {
    session = await client.createSession({
      ...sessionOptions,
      sessionId: state.gSessionId,
    });
  }

  let cachedModelIds = loadCachedModelIds();
  if (null == cachedModelIds || options.updateModels) {
    const models = await client.listModels();
    saveModelsCache(models);
    logger.log(
      `✅ Models cache updated: ${MODELS_CACHE_FILE} (${models.length} models)`
    );
    if (null == cachedModelIds) {
      cachedModelIds = models.map((m: any) => m.id).filter(Boolean);
    }
    if (options.updateModels) {
      process.exit(0);
    }
  }
  if (!cachedModelIds.includes(model)) {
    logger.error(
      `❌ Model "${model}" is not available. Run --update-models to refresh.\n   Available: ${cachedModelIds.join(", ")}`
    );
    process.exit(1);
  }

  writeFileSync(LAST_SESSION_FILE, `${state.gSessionId},${state.loopId}`);

  setupSessionEventListener(session, options);
  return session;
};
