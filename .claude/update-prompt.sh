#!/bin/bash
# Agent Loop Prompt Update Hook - Updates state file with new user prompt
set -euo pipefail

STATE=".claude/agent-loop.local.md"
[[ -f "$STATE" ]] || exit 0

# Read new prompt from stdin
NEW_PROMPT=$(cat)

# Update state file with new prompt
{
  # Extract YAML frontmatter
  awk '/^---$/{i++; if(i==1) print; if(i==2) exit}' "$STATE"
  echo "---"
  # Add new prompt
  echo "$NEW_PROMPT"
} > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"

echo "✓ Prompt updated in state file"
