#!/bin/bash
# Agent Loop Stop Hook - Blocks exit when agent-loop is active
set -euo pipefail

STATE=".claude/agent-loop.local.md"
[[ -f "$STATE" ]] || exit 0

# Parse state file
ITER=$(awk -F': ' '/^iteration:/{print $2}' "$STATE")
MAX=$(awk -F': ' '/^max_iterations:/{print $2}' "$STATE")
PROMISE=$(awk -F': ' '/^completion_promise:/{gsub(/"/, "", $2); print $2}' "$STATE")
PROMPT=$(awk '/^---$/{i++; next} i>=2' "$STATE")

# Validate
[[ "$ITER" =~ ^[0-9]+$ && "$MAX" =~ ^[0-9]+$ ]] || { rm -f "$STATE"; exit 0; }

# Check max iterations
(( ITER >= MAX && MAX > 0 )) && { echo "Max iterations reached."; rm -f "$STATE"; exit 0; }

# Check completion promise in transcript
INPUT=$(cat)
if [[ $ITER -gt 2 && -n "$PROMISE" && "$PROMISE" != "null" ]]; then
  TRANSCRIPT=$(echo "$INPUT" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  if [[ -f "$TRANSCRIPT" ]]; then
    FOUND=$(tail -1 "$TRANSCRIPT" 2>/dev/null | grep -o '<promise>[^<]*</promise>' | sed 's/<[^>]*>//g' || true)
    [[ "$FOUND" == "$PROMISE" ]] && { echo "Completed: $PROMISE"; rm -f "$STATE"; exit 0; }
  fi
fi

# Continue loop: increment and output
NEXT=$((ITER + 1))
sed -i.bak "s/^iteration: .*/iteration: $NEXT/" "$STATE" && rm -f "$STATE.bak"

AGENT_PROMPT="Iteration $NEXT: Execute one PDCA (Plan-Do-Check-Act) LOOP ($NEXT/$MAX) to achieve mission. When you get perfect fit, output '<promise>$PROMISE</promise>' in your final line."
printf '{"decision":"block","reason":"%s","systemMessage":"%s"}\n' \
  "$(echo "$AGENT_PROMPT PROMPT - $PROMPT" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')" "LOOP ($NEXT/$MAX)"
