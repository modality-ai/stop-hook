# copilot-loop

This directory contains a small CLI tool used to run an iterative PDCA-style agent loop backed by the GitHub Copilot SDK.

Files
- src/index.ts - Entrypoint script (#!/usr/bin/env bun). Parses CLI args, loads YAML prompt config, and starts the SweAgentInteraction loop.
- src/SweAgentInteraction.ts - Implements the interactive PDCA loop with YOLO and CONFIRM modes, console colors, and signal handling.

Usage
- Run `copilot-loop [config-file] [options]`
- Common flags supported (extracted from the entrypoint):
  - [config-file]            Load YAML config (positional) or use `--config <file>`
  - -p <prompt>              Directly input a prompt
  - -a <prompt>              Append additional prompt text
  - -s <id>                  Specify session ID for resuming sessions
  - --model <model>          Specify model (default gpt-4.1)
  - --think <level>         Set reasoning effort (low|medium|high|xhigh)
  - --max <iterations>      Set maximum iterations for the PDCA loop
  - --promise <phrase>      Set completion promise phrase (default: PDCA_LOOP_COMPLETED)
  - --timeout <seconds>     Set RPC timeout in seconds
  - --debug                 Use confirm mode instead of yolo mode
  - --persona <name>        Deploy persona at session start (the tool will send a persona prompt when provided)

Behavior notes
- The tool implements a PDCA (Plan-Do-Check-Act) loop and expects the assistant to emit a completion promise (default: `PDCA_LOOP_COMPLETED`) to terminate.
- Signal handling (SIGINT/SIGTERM) will attempt graceful session abort and client cleanup; the script also listens for stdout stream destruction and common Copilot disconnect errors.
- The interactive loop supports two modes: `yolo` (auto-iterate) and `confirm` (ask before executing commands).

Example
- copilot-loop prompt.yaml

- prompt.yaml example:
```yaml
mcpServers:
  counter:
    type: http
    url: http://localhost:65534/mcp
    tools: ["*"]
model: "gpt-5-mini" 
reasoningEffort: null
max-iterations: 1 
promise: null
persona: James
prompt: |
  Say Hi, and exit the loop.
```
