#!/bin/bash
# Agent Loop Prompt Update Hook - Updates state file with new user prompt
set -euo pipefail

STATE=".claude/agent-loop.local.md"
[[ -f "$STATE" ]] || exit 0

# Read new prompt from stdin

extract_json_string() {
  local json="$1"
  local key="$2"
  local default="${3:-}"
  # Try matching "key": "value" (normal JSON)
  local value=$(echo "$json" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\",}]*\)\".*/\1/p" | head -1)
  echo "${value:-$default}"
}

HOOK_INPUT=$(cat 2> /dev/null || echo "{}")
PROMPT=$(extract_json_string "$HOOK_INPUT" "prompt")
if [[ -z "$PROMPT" ]]; then
  exit 0
fi

# Update state file with new prompt
{
  # Extract YAML frontmatter (everything between first and second ---)
  sed -n '/^---$/,/^---$/p' "$STATE"
  echo ""
  # Add new prompt
  echo "$PROMPT"
} > "$STATE.tmp" && cp "$STATE.tmp" "$STATE"

echo "✓ Prompt updated in state file"
