#!/bin/bash
# Hook wrapper: Intercepts _Counter__ExecuteMethod calls for *agent-loop
# Extracts method parameters and creates the agent-loop state file
# Reads Claude Code hook JSON from stdin

set -euo pipefail
# DEBUG_HOOKS=1

# Trap errors with better logging
trap 'echo "❌ extract-and-create-loop.sh error at line $LINENO: $BASH_COMMAND" >&2; exit 1' ERR

STATE_FILE=".claude/agent-loop.local.md"

# Read hook input from stdin: strip ANSI codes, then unescape one JSON layer
# (tool_result.text is a JSON-encoded string where keys appear as \"key\" not "key")
HOOK_INPUT=$(cat 2> /dev/null | sed 's/\x1b\[[0-9;]*[mK]//g; s/\\"/"/g; s/\\\\/\\/g' || echo "{}")

# Cache grep -P capability check (avoid repeated checks in function)
HAS_GREP_P=false
if command -v grep &>/dev/null && grep --help 2>&1 | grep -q '\-P'; then
  HAS_GREP_P=true
fi

# Log for debugging
if [[ -n "${DEBUG_HOOKS:-}" ]]; then
  echo "[$(date)] PostToolUse hook received:" >> /tmp/hooks-debug.log
  echo "$HOOK_INPUT" >> /tmp/hooks-debug.log
fi

# Unified JSON value extractor - DRY utility for nested tool_input.params structure
# Usage: extract_json_value "json" "key" "string|number" "default" [max_len]
# Fallback chain: grep -oP → awk (first match) → sed -E (last match fallback)
extract_json_value() {
  local json="$1"
  local key="$2"
  local type="${3:-string}"  # "string" or "number"
  local default="${4:-}"
  local max_len="${5:-10000}"
  local value=""

  # Build patterns based on type
  if [[ "$type" == "number" ]]; then
    local grep_pattern="\"${key}\"\\s*:\\s*\\K[0-9]+"
    local sed_pattern="s/.*\"${key}\"[ ]*:[ ]*([0-9]+).*/\\1/"
    local awk_sep="\"${key}\":"
    local awk_end='[,}]'
  else
    # Handle escaped quotes (\") inside JSON string values
    local grep_pattern="\"${key}\"\\s*:\\s*\"\\K([^\"\\\\]|\\\\.)*(?=\")"
    local sed_pattern="s/.*\"${key}\"[ ]*:[ ]*\"(([^\"\\\\]|\\\\.)*)\".*$/\\1/"
    local awk_sep="\"${key}\":\""
    local awk_end='[,}]'  # awk uses unescaped-quote-aware approach below
  fi

  # Try grep -oP (Perl regex) - gets first match via head -1
  if [[ "$HAS_GREP_P" == "true" ]]; then
    value=$(echo "$json" | grep -oP "$grep_pattern" 2>/dev/null | head -1) || true
  fi

  # Try awk - splits on FIRST occurrence of "key": (unlike sed's greedy .* which gets last)
  if [[ -z "$value" ]]; then
    if [[ "$type" == "number" ]]; then
      value=$(echo "$json" | awk -F"$awk_sep" '{print $2}' | awk -F"$awk_end" '{print $1}' | tr -d ' ' | head -1) || true
      [[ ! "$value" =~ ^[0-9]+$ ]] && value=""
    else
      # Split on key, then walk chars to find unescaped closing quote
      value=$(echo "$json" | awk -F"$awk_sep" '{print $2}' | awk '{
        s = $0
        out = ""
        for (i = 1; i <= length(s); i++) {
          c = substr(s, i, 1)
          if (c == "\\" && i < length(s)) { out = out c substr(s, i+1, 1); i++; continue }
          if (c == "\"") break
          out = out c
        }
        print out
      }' | head -1) || true
      [[ ${#value} -gt $max_len ]] && value=""
    fi
  fi

  # Fallback: sed -E (greedy .* matches last occurrence — only used if awk fails)
  if [[ -z "$value" ]]; then
    value=$(echo "$json" | sed -E "$sed_pattern" 2>/dev/null | head -1) || true
    if [[ "$type" == "number" ]]; then
      [[ ! "$value" =~ ^[0-9]+$ ]] && value=""
    else
      [[ "$value" == "$json" || ${#value} -gt $max_len ]] && value=""
    fi
  fi

  echo "${value:-$default}"
}

# Extract params from the MCP method call
# The "prompt" key lives inside tool_result.content[].text which is a JSON-encoded string,
# so all inner quotes are escaped (\"prompt\" not "prompt"). Unescape one layer first.
ITERATION=1
MAX_ITERATIONS=$(extract_json_value "$HOOK_INPUT" "max_iterations" "number" "")
[[ -z "$MAX_ITERATIONS" ]] && MAX_ITERATIONS=$(extract_json_value "$HOOK_INPUT" "iterations" "number" "50")
COMPLETION_PROMISE=$(extract_json_value "$HOOK_INPUT" "completion_promise" "string" "attempt_completion" "1000")
PROMPT=$(extract_json_value "$HOOK_INPUT" "prompt" "string" "" "10000")

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
