# copilot-loop

This directory contains a small CLI tool used to run an iterative PDCA-style agent loop backed by the GitHub Copilot SDK.

Files
- src/index.ts - Entrypoint script (#!/usr/bin/env bun). Parses CLI args, loads YAML prompt config, and starts the SweAgentInteraction loop.
- src/SweAgentInteraction.ts - Implements the interactive PDCA loop with YOLO and CONFIRM modes, console colors, and signal handling.

Usage
- Run `copilot-loop [config-file] [options]`
- CLI flags:
  - [config-file]            Load YAML config (positional) or use `--config <file>`
  - -p <prompt>              Execute a prompt in non-interactive mode
  - -a <prompt>              Append additional prompt text to config prompt
  - --resume [sessionId]     Resume from a previous session (optionally specify session ID; without ID, resumes last session from `/tmp/copilot-loop-last-session`)
  - -r                       Shorthand for `--resume` (sets confirm mode)
  - --model <model>          Specify the AI model to use
  - --think <level>          Set reasoning effort (choices: low, medium, high, xhigh)
  - --max <iterations>       Set maximum iterations for agent loop
  - --promise <phrase>       Set completion promise phrase for task completion
  - --timeout <seconds>      Set timeout in seconds (default: 604800 / 7 days)
  - --persona <name>         Deploy a specific persona to activate and maintain persistence
  - --debug                  Use confirm mode for permission prompts instead of automatic approval
  - -h, --help               Display help for command

Behavior notes
- The tool implements a PDCA (Plan-Do-Check-Act) loop and expects the assistant to emit a completion promise phrase to terminate (configurable via `--promise`, no hardcoded default).
- Signal handling (SIGINT/SIGTERM) attempts graceful session abort and client cleanup; the script also listens for stdout stream destruction and Copilot disconnect errors.
- The interactive loop supports two modes: `yolo` (auto-iterate without prompts) and `confirm` (ask before executing commands). Use `--debug` flag or `--resume` without session ID to enable confirm mode.
- Sessions are tracked via Snowflake-like IDs (generated from timestamp + random bits). Last session ID is saved to `/tmp/copilot-loop-last-session` for easy resumption.
- Execution logs are written to `/tmp/copilot-loop-[sessionId]-log.txt`, `/tmp/copilot-loop-[sessionId]-error.txt` for debugging.
- Health checks run every 3 seconds via `client.ping()` to detect server hangs; timeout per prompt is configurable (default 7 days).

Examples

Start with a config file:
```bash
$ copilot-loop config.yaml
```

Execute a prompt directly (non-interactive):
```bash
$ copilot-loop -p "Fix the bug in main.js"
```

Resume the last session in confirm mode:
```bash
$ copilot-loop --resume
```

Resume a specific session:
```bash
$ copilot-loop --resume abc123def456
```

Use specific model and reasoning with custom timeout:
```bash
$ copilot-loop --model gpt-5-mini --think high --timeout 3600 -p "Optimize this code"
```

Enable debug mode with persona deployment:
```bash
$ copilot-loop config.yaml --debug --persona "JAMES"
```

YAML configuration file example (`config.yaml`):
```yaml
mcpServers:
  counter:
    type: http
    url: http://localhost:3000/mcp
    tools: ["*"]

model: "gpt-5-mini"
reasoningEffort: "high"
max-iterations: 5
timeout: 3600
promise: "TASK_COMPLETED_SUCCESSFULLY"
persona: "JAMES"

prompt: |
  Say Hi, and exit the loop.
```

Configuration field reference:
- `mcpServers`: MCP server configuration (passed to Copilot SDK)
- `model`: AI model identifier
- `reasoningEffort`: Reasoning level (low, medium, high, xhigh)
- `max-iterations`: Maximum loop iterations before timeout
- `timeout`: RPC timeout in seconds (default: 604800)
- `promise`: Completion signal phrase for the agent
- `persona`: Persona name to deploy at session start
- `prompt`: Initial prompt for the agent loop
