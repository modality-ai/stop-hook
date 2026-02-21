#!/usr/bin/env bun

/**
 * Minimal test: Does onPostToolUse modifiedResult actually change what the LLM sees?
 *
 * Test 1: No hooks → LLM should see "hello from bash"
 * Test 2: onPostToolUse replaces result → LLM should see "INJECTED_BY_HOOK" (PROVEN: doesn't work)
 * Test 3: onPreToolUse modifies command + onPostToolUse replaces result (PROVEN: post doesn't work)
 * Test 5: onPreToolUse with actuator SYNC + WRITE mode (-w) → stdout passes through, no post-hook needed
 */

import { CopilotClient } from "@github/copilot-sdk";
import { execSync } from "child_process";

const whichCli = (cli: string): string | null => {
  try {
    return execSync(`which ${cli}`, { encoding: "utf-8" })?.trim();
  } catch {
    return null;
  }
};

const testMode = process.argv[2] || "1";
const log = (msg: string) =>
  console.log(`\n[TEST-HOOK ${new Date().toISOString()}] ${msg}`);

log(`=== TEST MODE ${testMode} ===`);

const client = new CopilotClient({
  cliPath: whichCli("copilot") || undefined,
});

const buildHooks = (mode: string) => {
  if (mode === "1") {
    log("No hooks - baseline test");
    return undefined;
  }

  if (mode === "2") {
    log("onPostToolUse ONLY - replace result with INJECTED_BY_HOOK");
    return {
      onPostToolUse: async (input: any) => {
        log(`--- onPostToolUse fired ---`);
        log(`  toolName: ${input.toolName}`);
        log(`  toolArgs: ${JSON.stringify(input.toolArgs)}`);
        log(
          `  original textResultForLlm: ${input.toolResult?.textResultForLlm?.slice(0, 200)}`
        );
        log(
          `  original sessionLog: ${input.toolResult?.sessionLog?.slice(0, 200)}`
        );
        log(`  original resultType: ${input.toolResult?.resultType}`);
        log(`  all keys: ${Object.keys(input.toolResult || {}).join(", ")}`);

        if (input.toolName === "bash" || input.toolName === "shell") {
          const modifiedResult = {
            ...input.toolResult,
            textResultForLlm:
              "INJECTED_BY_HOOK: The real output was replaced by the post-tool hook.",
            sessionLog:
              "INJECTED_BY_HOOK: The real output was replaced by the post-tool hook.",
          };
          log(`  returning modifiedResult ✓`);
          return { modifiedResult };
        }
        log(`  no modification (not bash/shell)`);
      },
    };
  }

  if (mode === "3") {
    log(
      "onPreToolUse (modify command) + onPostToolUse (replace result) - actuator simulation"
    );
    return {
      onPreToolUse: async (input: any) => {
        log(`--- onPreToolUse fired ---`);
        log(`  toolName: ${input.toolName}`);
        log(`  toolArgs: ${JSON.stringify(input.toolArgs)}`);

        if (input.toolName === "bash" || input.toolName === "shell") {
          let toolArgsData: any;
          try {
            toolArgsData = JSON.parse(input.toolArgs);
          } catch {
            toolArgsData = {};
          }

          // Simulate actuator: wrap command so bash output is different
          const wrappedCmd = `echo "WRAPPER_OUTPUT: command was wrapped" && ${toolArgsData.command || "true"}`;
          log(`  original command: ${toolArgsData.command}`);
          log(`  wrapped command: ${wrappedCmd}`);

          return {
            permissionDecision: "allow" as const,
            modifiedArgs: {
              ...toolArgsData,
              command: wrappedCmd,
            },
          };
        }
        return { permissionDecision: "allow" as const };
      },
      onPostToolUse: async (input: any) => {
        log(`--- onPostToolUse fired ---`);
        log(`  toolName: ${input.toolName}`);
        log(
          `  original textResultForLlm: ${input.toolResult?.textResultForLlm?.slice(0, 300)}`
        );
        log(
          `  original sessionLog: ${input.toolResult?.sessionLog?.slice(0, 300)}`
        );
        log(`  original resultType: ${input.toolResult?.resultType}`);

        if (input.toolName === "bash" || input.toolName === "shell") {
          const modifiedResult = {
            ...input.toolResult,
            textResultForLlm:
              "POST_HOOK_REPLACED: This is what the LLM should see instead of the real output.",
            sessionLog:
              "POST_HOOK_REPLACED: This is what the LLM should see instead of the real output.",
          };
          log(`  returning modifiedResult ✓`);
          return { modifiedResult };
        }
      },
    };
  }

  if (mode === "4") {
    log(
      "onPreToolUse (actuator async) + onPostToolUse (poll actuator) - BROKEN approach"
    );
    log("  SKIPPED - proven that modifiedResult doesn't feed to LLM");
    return undefined;
  }

  if (mode === "6") {
    log(
      "onPreToolUse ONLY - actuator ASYNC + poll IN pre-hook, then return curated echo command"
    );
    const hasActuator = whichCli("actuator") != null;
    log(`  actuator available: ${hasActuator}`);

    const shellEscape = (s: string): string =>
      "'" + s.replace(/'/g, "'\\''") + "'";

    const pollActuator = (jobId: string): Promise<{ stdout: string; stderr: string; exit_code: number }> => {
      return new Promise((resolve) => {
        const interval = setInterval(() => {
          try {
            const raw = execSync(`actuator -p ${jobId}`, { encoding: "utf-8" });
            const data = JSON.parse(raw);
            if (data.status !== "running") {
              clearInterval(interval);
              resolve({
                stdout: data.stdout || "",
                stderr: data.stderr || "",
                exit_code: data.exit_code ?? 0,
              });
            }
          } catch (e) {
            log(`  poll error: ${e}`);
          }
        }, 500);
      });
    };

    return {
      onPreToolUse: async (input: any) => {
        if (input.toolName !== "bash" && input.toolName !== "shell") {
          return { permissionDecision: "allow" as const };
        }

        let toolArgsData: any;
        try {
          toolArgsData = JSON.parse(input.toolArgs);
        } catch {
          toolArgsData = {};
        }
        const { command = "" } = toolArgsData || {};

        // Block AI from using actuator directly
        const commandHaveActuator = command.indexOf("actuator");
        if (-1 !== commandHaveActuator && 10 > commandHaveActuator) {
          return {
            permissionDecision: "deny" as const,
            permissionDecisionReason: "Use bash directly, not actuator.",
          };
        }

        if (!hasActuator) {
          return { permissionDecision: "allow" as const };
        }

        const jobId = `job-${Date.now()}`;
        log(`  [PRE] original command: ${command}`);
        log(`  [PRE] starting actuator async: -a -j ${jobId}`);

        // 1. Start command via actuator async (returns immediately)
        const actuatorStartCmd = `actuator -a -j ${jobId} --- ${shellEscape(command)}`;
        try {
          execSync(actuatorStartCmd, { encoding: "utf-8" });
        } catch (e) {
          log(`  [PRE] actuator start failed: ${e}`);
          return { permissionDecision: "allow" as const }; // fallback to raw
        }

        // 2. Poll until complete
        log(`  [PRE] polling for completion...`);
        const result = await pollActuator(jobId);
        log(`  [PRE] completed with exit_code=${result.exit_code}`);
        log(`  [PRE] stdout (${result.stdout.length} chars): ${result.stdout.slice(0, 200)}`);
        if (result.stderr) {
          log(`  [PRE] stderr (${result.stderr.length} chars): ${result.stderr.slice(0, 200)}`);
        }

        // 3. Build curated output for LLM
        const parts: string[] = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(result.stderr);
        const curatedOutput = parts.join("\n");

        // 4. Return a command that echoes the curated result with correct exit code
        const echoCmd = result.exit_code === 0
          ? `printf '%s' ${shellEscape(curatedOutput)}`
          : `printf '%s' ${shellEscape(curatedOutput)} >&2; exit ${result.exit_code}`;

        log(`  [PRE] curated command: ${echoCmd.slice(0, 200)}`);

        return {
          permissionDecision: "allow" as const,
          modifiedArgs: {
            ...toolArgsData,
            command: echoCmd,
          },
        };
      },
    };
  }

  if (mode === "5") {
    log(
      "onPreToolUse ONLY - actuator SYNC + WRITE mode (-w). No post-hook needed."
    );
    const hasActuator = whichCli("actuator") != null;
    log(`  actuator available: ${hasActuator}`);

    const shellEscape = (s: string): string =>
      "'" + s.replace(/'/g, "'\\''") + "'";

    return {
      onPreToolUse: async (input: any) => {
        log(`--- onPreToolUse fired ---`);
        log(`  toolName: ${input.toolName}`);

        if (
          (input.toolName === "bash" || input.toolName === "shell") &&
          hasActuator
        ) {
          let toolArgsData: any;
          try {
            toolArgsData = JSON.parse(input.toolArgs);
          } catch {
            toolArgsData = {};
          }

          const { command = "" } = toolArgsData || {};

          // Block AI from using actuator directly
          const commandHaveActuator = command.indexOf("actuator");
          if (-1 !== commandHaveActuator && 10 > commandHaveActuator) {
            log(`  🚫 Denied: actuator direct use`);
            return {
              permissionDecision: "deny" as const,
              permissionDecisionReason:
                "Use bash directly, not actuator.",
            };
          }

          const jobId = `test-${Date.now()}`;
          // -w = write mode: command stdout → actuator stdout, JSON → stderr
          // No -a = sync mode: actuator waits for command to finish
          // -j = custom job ID for tracking
          // -w: command stdout → actuator stdout (for LLM), JSON → stderr
          // 2>/dev/null: suppress actuator's JSON metadata from stderr so SDK doesn't capture it
          const actuatorCmd = `actuator -w -j ${jobId} --- ${shellEscape(command)} 2>/dev/null`;
          log(`  original command: ${command}`);
          log(`  actuator command: ${actuatorCmd}`);

          return {
            permissionDecision: "allow" as const,
            modifiedArgs: {
              ...toolArgsData,
              command: actuatorCmd,
            },
          };
        }
        return { permissionDecision: "allow" as const };
      },
      // onPostToolUse for LOGGING only - does NOT modify result
      onPostToolUse: async (input: any) => {
        if (input.toolName === "bash" || input.toolName === "shell") {
          log(`--- onPostToolUse (log only) ---`);
          log(
            `  LLM sees: ${input.toolResult?.textResultForLlm?.slice(0, 300)}`
          );
        }
      },
    };
  }
};

const hooks = buildHooks(testMode);

const run = async () => {
  const session = await client.createSession({
    model: "gpt-4.1",
    streaming: true,
    ...(hooks ? { hooks } : {}),
    onPermissionRequest: async () => ({ kind: "approved" as const }),
  });

  log("Session created");

  // Enable JSON-RPC packet tracing (private field, accessible at runtime)
  const conn = (client as any).connection;
  if (conn?.trace) {
    conn.trace(3, {
      log: (msg: string, data?: string) => {
        log(`[JSON-RPC] ${msg}${data ? "\n" + data : ""}`);
      },
    });
    log("JSON-RPC tracing enabled (Verbose)");
  } else {
    log("⚠️  Could not enable JSON-RPC tracing (connection not found)");
  }

  // Subscribe to events for visibility
  session.on((event: any) => {
    switch (event.type) {
      case "assistant.message_delta":
        process.stdout.write(event.data.deltaContent);
        break;
      case "assistant.message":
        log(`\n[ASSISTANT FULL]: ${event.data.content?.slice(0, 500)}`);
        break;
      case "tool.execution_start":
        log(
          `[TOOL START]: ${event.data.toolName} ${JSON.stringify(event.data.arguments)?.slice(0, 200)}`
        );
        break;
      case "tool.execution_complete":
        log(
          `[TOOL COMPLETE]: success=${event.data.success} result=${event.data.result?.content?.slice(0, 300)}`
        );
        break;
      case "session.error":
        log(`[ERROR]: ${event.data.message}`);
        break;
    }
  });

  const prompt = `Run this exact bash command: echo "hello from bash test"
Then tell me: what was the EXACT output of that bash command? Quote it exactly.`;

  log(`Sending prompt: ${prompt}`);

  const response = await session.sendAndWait({ prompt }, 60000);
  log(`\n=== FINAL RESPONSE ===`);
  log(response?.data?.content || "(no content)");

  log(`\n=== TEST COMPLETE ===`);
  log(`Mode ${testMode} finished.`);
  log(
    `Expected: Mode 1 → "hello from bash test", Mode 2/3 → hook-modified text, Mode 4 → real actuator result`
  );

  await client.stop();
  process.exit(0);
};

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
