import { SweAgentInteraction } from "./utils/SweAgentInteraction";
import { CopilotClient } from "@github/copilot-sdk";
import type { CopilotSession } from "@github/copilot-sdk";

// Parse CLI arguments for flags (--prompt with value, --debug as boolean)
const parseCliArgs = (flag: string) => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;

  // For flags with values (like --prompt)
  if (
    index + 1 < process.argv.length &&
    !process.argv[index + 1].startsWith("--")
  ) {
    return process.argv[index + 1];
  }

  // For boolean flags (like --debug)
  return flag === "--debug" ? true : null;
};

// Load and parse YAML prompt file
const loadPromptFile = async (filePath: any) => {
  if (typeof filePath !== "string") {
    console.error("Prompt file path must be a string.");
    process.exit(1);
  }
  try {
    const content = await Bun.file(filePath).text();
    const parsed = Bun.YAML.parse(content);
    return parsed;
  } catch (error) {
    console.error(`Failed to load prompt file: ${filePath}`);
    console.error(error);
    process.exit(1);
  }
};

const client = new CopilotClient();
let session: CopilotSession | undefined;

const initSession = async (systemPrompt: string, options: any = {}) => {
  const { model = "gpt-4.1", mcpServers } = options;
  console.log(`🚀 Initializing session with model: ${model}...`);
  session = await client.createSession({
    model,
    mcpServers,
    streaming: true,
    systemMessage: {
      mode: "append", // [append | replace] - whether to append to or replace the default system SDK security guardrails
      content: systemPrompt,
    },
  });

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
      console.log(`\n📍 Session started: ${event.data.sessionId}`);
    }

    if (event.type === "session.idle") {
      // Session idle - turn complete, waiting for next input
      if (process.stdout.isTTY) process.stdout.write("\n");
    }

    if (event.type === "session.error") {
      // Session encountered an error
      console.log(`\n❌ Session error: ${event.data.message}`);
    }

    if (event.type === "session.info") {
      // Session information (debugging info)
      console.log(`\nℹ️  Session info: ${event.data.message}`);
    }

    if (event.type === "session.usage_info") {
      // Token usage and cost information
      if (event.data.currentTokens || event.data.tokenLimit) {
        console.log(
          `\n📊 Usage - Current: ${event.data.currentTokens}, Limit: ${event.data.tokenLimit}`
        );
      }
    }

    // ─────────────────────────────────────────────────────────────
    // TURN LIFECYCLE - Shows agent reasoning flow
    // ─────────────────────────────────────────────────────────────

    if (event.type === "assistant.turn_start") {
      // Agent starts processing - beginning of step-by-step execution
      console.log(
        `\n─── Assistant Turn ${event.data.turnId?.slice(0, 8) || "unknown"} ───`
      );
    }

    if (event.type === "assistant.turn_end") {
      // Turn complete
      console.log(`\n✓ Turn ended (${event.data.turnId?.slice(0, 8)})`);
    }

    // ─────────────────────────────────────────────────────────────
    // AGENT DECISION MAKING (What will the agent do?)
    // ─────────────────────────────────────────────────────────────

    if (event.type === "assistant.intent") {
      // Agent deciding what action to take next
      console.log(`\n🎯 Agent Intent: ${event.data.intent}`);
    }

    if (event.type === "assistant.reasoning") {
      // Complete reasoning from agent
      console.log(`\n💭 Reasoning:\n${event.data.content}`);
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
      console.log(`\n🔧 Executing tool: ${event.data.toolName}`);
      if (event.data.arguments) {
        console.log(`   Arguments: ${JSON.stringify(event.data.arguments)}`);
      }
    }

    if (event.type === "tool.execution_progress") {
      // Progress updates during tool execution (streaming)
      console.log(`   ⏳ ${event.data.progressMessage}`);
    }

    if (event.type === "tool.execution_partial_result") {
      // Partial result from tool (before completion)
      console.log(`   📦 Partial: ${event.data.partialOutput?.slice(0, 100)}`);
    }

    if (event.type === "tool.execution_complete") {
      // Tool execution finished
      if (event.data.success) {
        console.log(`   ✓ Tool completed`);
        if (event.data.result?.content) {
          const preview = event.data.result.content.slice(0, 150);
          console.log(
            `   Result: ${preview}${event.data.result.content.length > 150 ? "..." : ""}`
          );
        }
      } else {
        console.log(`   ✗ Tool failed: ${event.data.error?.message}`);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // SUBAGENT EXECUTION - For delegated/agentic workflows
    // ─────────────────────────────────────────────────────────────

    if (event.type === "subagent.started") {
      // Subagent (delegated agent) started - recursive agentic workflows
      console.log(`\n🤖 Subagent started: ${event.data.agentDisplayName}`);
    }

    if (event.type === "subagent.selected") {
      // Subagent was selected for task
      console.log(`   → Selected agent: ${event.data.agentName}`);
    }

    if (event.type === "subagent.completed") {
      // Subagent finished successfully
      console.log(`   ✓ Subagent completed: ${event.data.agentName}`);
    }

    if (event.type === "subagent.failed") {
      // Subagent encountered error
      console.log(`   ✗ Subagent failed: ${event.data.error}`);
    }

    // ─────────────────────────────────────────────────────────────
    // ASSISTANT RESPONSE - Streaming output to user
    // ─────────────────────────────────────────────────────────────

    if (event.type === "assistant.message") {
      // Complete message from agent
      console.log(`\n${event.data.content}`);
    }

    if (event.type === "assistant.message_delta") {
      // Streaming response content (write without newline)
      process.stdout.write(event.data.deltaContent);
    }

    if (event.type === "assistant.usage") {
      // Usage info for this message
      if (event.data.outputTokens) {
        console.log(`   [Tokens used: ${event.data.outputTokens}]`);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // OTHER EVENTS - Less common but useful for debugging
    // ─────────────────────────────────────────────────────────────

    if (event.type === "hook.start") {
      // Webhook/hook started
      console.log(`\n🪝 Hook started: ${event.data.hookType}`);
    }

    if (event.type === "hook.end") {
      // Webhook/hook completed
      console.log(`   ✓ Hook completed: ${event.data.hookType}`);
    }

    if (event.type === "abort") {
      // Operation was aborted
      console.log(`\n⛔ Operation aborted: ${event.data.reason}`);
    }

    if (event.type === "session.model_change") {
      // Model was changed
      console.log(`\n🔄 Model changed to: ${event.data.newModel}`);
    }
  });
};

const aiCommand = async (prompt: any, systemPrompt: string) => {
  if (null == session) {
    let options: any = {};
    if (promptFile) {
      options = await loadPromptFile(promptFile);
    }
    await initSession(systemPrompt, options);
  }
  try {
    const response = await session!.sendAndWait({ prompt }, 300000); // 5 minute timeout
    return response?.data?.content || "";
  } catch (error) {
    console.error(
      "Error during AI command execution:",
      (error as Error).message
    );
    return "";
  }
};

// Main execution
const main = async () => {
  let initialPrompt = "say hi one time and exit loop";
  let promptConfig: any;

  if (promptFile) {
    console.log(`🤖 Load prompt file ${promptFile}...`);
    promptConfig = await loadPromptFile(promptFile);
    initialPrompt =
      promptConfig.prompt || promptConfig.message || initialPrompt;
  }
  // Use --debug flag to change mode to "confirm"
  const mode = parseCliArgs("--debug") ? "confirm" : "auto";
  new SweAgentInteraction({
    aiCommand,
    completionPromise: promptConfig.promise,
    maxIterations: promptConfig["max-iterations"],
  }).init(mode, initialPrompt);
};

const promptFile = parseCliArgs("--prompt");
main();
