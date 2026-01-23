#!/bin/bash

# Claude Code PermissionRequest Hook
# Auto-approves MCP tools matching a provided glob pattern
# Usage: permission-counter-hook.sh <glob-pattern>
# Example: permission-counter-hook.sh "mcp__*___Counter__*"
# Receives hook input via stdin as JSON

set -euo pipefail

# Pattern must be passed as CLI argument
if [[ $# -lt 1 ]]; then
  echo "Error: Pattern argument required" >&2
  echo "Usage: $0 <pattern>" >&2
  exit 1
fi

PATTERN="$1"

# Read JSON input from stdin
HOOK_INPUT=$(cat 2>/dev/null || echo "{}")

# Extract tool_name from the hook input
# Format: {"tool_name": "mcp__mcp-qdrant___Counter__Deploy", ...}
TOOL_NAME=$(echo "$HOOK_INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)".*/\1/' || echo "")

if [[ -z "$TOOL_NAME" ]]; then
  # No tool_name found, let it prompt normally
  exit 0
fi

# Check if tool matches the provided glob pattern
case "$TOOL_NAME" in
  $PATTERN)
    # Tool matches the glob pattern - AUTO-APPROVE
    printf '{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}, "metadata": {"reason": "Auto-approved by pattern", "tool": "%s"}}}\n' "$TOOL_NAME"
    exit 0
    ;;
esac

# Tool doesn't match pattern - let Claude Code prompt normally
exit 0
