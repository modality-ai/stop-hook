#!/bin/bash
# Hook wrapper: Intercepts _Counter__ExecuteMethod calls for *agent-loop
# Extracts method parameters and creates the agent-loop state file
# Reads Claude Code hook JSON from stdin

set -euo pipefail

# Trap errors with better logging
trap 'echo "❌ extract-and-create-loop.sh error at line $LINENO: $BASH_COMMAND" >&2; exit 1' ERR

STATE_FILE=".claude/agent-loop.local.md"
[[ ! -f "$STATE_FILE" ]] || exit 0

# Read hook input from stdin
HOOK_INPUT=$(cat 2> /dev/null || echo "{}")

# Log for debugging
if [[ -n "${DEBUG_HOOKS:-}" ]]; then
  echo "[$(date)] PostToolUse hook received:" >> /tmp/hooks-debug.log
  echo "$HOOK_INPUT" >> /tmp/hooks-debug.log
fi

# Helper: Extract quoted JSON value without jq (handles escaped quotes and newlines)
extract_json_string() {
  local json="$1"
  local key="$2"
  local default="${3:-}"
  # Try matching "key": "value" (normal JSON)
  local value=$(echo "$json" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\",}]*\)\".*/\1/p" | head -1)
  # Fallback: split on comma, find key with string value
  if [[ -z "$value" ]]; then
    value=$(echo "$json" | sed 's/,/\n/g' | sed -n "/${key}.*\"[^\"]*\"/{s/\\\\\"/\"/g;s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p;}" | head -1)
  fi
  echo "${value:-$default}"
}

# Helper: Extract numeric JSON value without jq
extract_json_number() {
  local json="$1"
  local key="$2"
  local default="${3:-}"
  # Try matching "key": value (normal JSON)
  local value=$(echo "$json" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p" | head -1)
  # Fallback: split on comma, find key with numeric value
  if [[ -z "$value" ]]; then
    value=$(echo "$json" | sed 's/,/\n/g' | sed -n "/${key}.*[0-9]/{s/\\\\\"//g;s/.*${key}\"*[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p;}" | head -1)
  fi
  echo "${value:-$default}"
}

# Extract params from the MCP method call
# The hook JSON contains the tool parameters
ITERATION=1
MAX_ITERATIONS=$(extract_json_number "$HOOK_INPUT" "max_iterations" "50")
COMPLETION_PROMISE=$(extract_json_string "$HOOK_INPUT" "completion_promise" "attempt_completion")
PROMPT=$(extract_json_string "$HOOK_INPUT" "prompt")

# Only proceed if this is an agent-loop call
if [[ -z "$PROMPT" ]]; then
  # Not an agent-loop call, silently exit
  if [[ -n "${DEBUG_HOOKS:-}" ]]; then
    echo "[$(date)] Not an agent-loop call (no prompt extracted)" >> /tmp/hooks-debug.log
  fi
  exit 0
fi

# Create the agent-loop state file
mkdir -p "$(dirname "$STATE_FILE")"
cat > "$STATE_FILE" << EOF
---
iteration: $ITERATION
max_iterations: $MAX_ITERATIONS
completion_promise: "$COMPLETION_PROMISE"
---

$PROMPT
EOF

echo "✅ Agent-loop initialized: iteration=$ITERATION, max=$MAX_ITERATIONS, promise=$COMPLETION_PROMISE" >&2
if [[ -n "${DEBUG_HOOKS:-}" ]]; then
  echo "[$(date)] State file created: $STATE_FILE" >> /tmp/hooks-debug.log
fi
