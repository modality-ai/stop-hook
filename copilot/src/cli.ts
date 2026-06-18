#!/usr/bin/env bun

import {
  SweAgentInteraction,
  getSessionId,
  type AIOptions,
} from "./SweAgentInteraction";
import { type CopilotSession } from "@github/copilot-sdk";
import { existsSync, readFileSync, writeSync } from "fs";

import {
  getState,
  logger,
  client,
  initSession,
  getPersonaPrompt,
  LAST_SESSION_FILE,
  setupHealthCheck,
} from "./copilot-core";

let currentSession: CopilotSession;
const state = getState();

// ─────────────────────────────────────────────────────────────
// CLI argument parsing
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Signal handlers
// ─────────────────────────────────────────────────────────────

const setupSignalHandlers = (
  getSession: () => CopilotSession | undefined
): (() => void) => {
  let stopping: boolean = false;
  const handler = async (_signal: NodeJS.Signals) => {
    const activeSession = getSession();
    if (activeSession && !stopping) {
      await activeSession.abort();
      stopping = true;
    }
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), 5000)
      );
      // client.stop() returns Promise<Error[]> — empty array means all cleanup succeeded
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

// ─────────────────────────────────────────────────────────────
// Process error handlers
// ─────────────────────────────────────────────────────────────

process.stdout.on("error", (error: any) => {
  if (error.code === "ERR_STREAM_DESTROYED") {
    logger.error("❌ Connection lost. Stream was destroyed. Please try again.");
    process.exit(1);
  }
  throw error;
});

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

// ─────────────────────────────────────────────────────────────
// AI command execution
// ─────────────────────────────────────────────────────────────

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
      if (state.gNeedContinue) {
        state.gNeedContinue = false;
        writeSync(1, `\n🩹 Prepare Continue...\n`);
        session.abort();
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
  const { session } = await initSession(systemPrompt, promptConfig);
  currentSession = session;
  const stopHealthCheck = setupHealthCheck(client, abortController);

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
      state.gSessionId = getSessionId();
    }
    stopHealthCheck();
    session.disconnect();
  }
};

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

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
  const positionalArgs = getPositionalArgs();
  const firstArg = positionalArgs[0];
  const isYamlFile = firstArg?.endsWith(".yaml") || firstArg?.endsWith(".yml");

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

  if (sessionOverride === true) {
    // --resume without session ID: read last session from tracking file
    try {
      if (existsSync(LAST_SESSION_FILE)) {
        const data = readFileSync(LAST_SESSION_FILE, "utf-8")
          ?.trim()
          .split(",");
        state.gSessionId = data?.[0] || state.gSessionId;
        state.loopId = data?.[1] || state.gSessionId;
        logger.log(`🔄 Resuming last session: ${state.gSessionId}`);
      } else {
        throw new Error("No session tracking file found");
      }
    } catch (error) {
      logger.error("No previous session found to resume.");
      process.exit(1);
    }
  } else if (sessionOverride) {
    state.gSessionId = sessionOverride as string;
  }
  if (loopIdOverride) {
    state.loopId = loopIdOverride as string;
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
  promptConfig.updateModels = parseCliArgs("--update-models") === true;

  const completionPromise = promptConfig.promise;
  const maxIterations = promptConfig["max-iterations"];
  const minIterations = promptConfig["min-iterations"];

  new SweAgentInteraction({
    aiCommand,
    completionPromise,
    maxIterations,
    minIterations,
    loopId: state.loopId,
    loopMd: promptConfig.loopMd,
  }).init(mode, initialPrompt);
  setupSignalHandlers(() => currentSession);
};

main();
