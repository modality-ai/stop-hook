#!/bin/bash
# Agent Loop Stop Hook - Blocks exit when agent-loop is active
set -euo pipefail

STATE="${CLAUDE_PROJECT_DIR:-.}/.claude/agent-loop.local.md"

# Capture stdin FIRST, unconditionally. Claude Code hands the hook its payload on
# stdin and closes the pipe; every early exit below would otherwise discard it,
# leaving no way to see what was actually delivered. Reading once into a variable
# is also required for correctness — stdin cannot be re-read further down.
INPUT=$(cat || true)

# Raw payload capture + state debug, gated behind DEBUG_HOOKS so a long-running
# machine isn't writing full payloads to disk on every invocation. Newest last;
# bounded so it cannot grow without limit.
if [[ -n "${DEBUG_HOOKS:-}" ]]; then
  STDIN_LOG=/tmp/stop-hook-input.log
  {
    printf '=== %s pid=%s cwd=%s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "${CLAUDE_PROJECT_DIR:-<unset>}"
    printf 'bytes=%s\n' "${#INPUT}"
    printf '%s\n' "$INPUT"
    printf '\n'
  } >> "$STDIN_LOG" 2>/dev/null || true
  # Keep only the last 2000 lines.
  if [[ -f "$STDIN_LOG" ]]; then
    tail -n 2000 "$STDIN_LOG" > "$STDIN_LOG.tmp" 2>/dev/null && mv "$STDIN_LOG.tmp" "$STDIN_LOG" 2>/dev/null || true
  fi
  echo "[$(date)] stop.sh active. STATE=$STATE exists=$( [[ -f "$STATE" ]] && echo yes || echo no )" >> /tmp/hooks-debug.log
fi

[[ -f "$STATE" ]] || exit 0

# Parse state file
ITER=$(awk -F': ' '/^iteration:/{print $2}' "$STATE")
MAX=$(awk -F': ' '/^max_iterations:/{print $2}' "$STATE")
PROMISE=$(awk -F': ' '/^completion_promise:/{gsub(/"/, "", $2); print $2}' "$STATE")
PROMPT=$(awk '/^---$/{i++; next} i>=2' "$STATE")

# Validate numeric values
[[ "$ITER" =~ ^[0-9]+$ && "$MAX" =~ ^[0-9]+$ ]] || { [[ -f "$STATE" ]] && rm "$STATE"; exit 0; }

# Check max iterations
(( ITER >= MAX && MAX > 0 )) && { [[ -f "$STATE" ]] && rm "$STATE"; echo "Max iterations reached." >&2; exit 0; }

# Check completion promise in transcript.
# stdin is normally the hook's JSON payload, but a non-JSON (or empty) stdin is
# not an error: fall back to scraping the path textually, and if that yields
# nothing the promise check is simply skipped. INPUT was captured at the top.
if [[ -n "$PROMISE" && "$PROMISE" != "null" ]]; then
  TRANSCRIPT=""
  if command -v jq >/dev/null 2>&1; then
    TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)
  fi
  # jq absent, stdin not JSON, or key missing — the regex works on either shape.
  [[ -n "$TRANSCRIPT" ]] || TRANSCRIPT=$(printf '%s' "$INPUT" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  if [[ -f "$TRANSCRIPT" ]]; then
    sleep 0.5  # allow Claude Code to flush final assistant message to JSONL before reading
    FOUND=$(tail -200 "$TRANSCRIPT" 2>/dev/null | sed 's#\\/#/#g' | GREP_OPTIONS= command grep -o '<promise>.*</promise>' | tail -20 | sed 's/<promise>//g; s/<\/promise>//g' || true)
    echo "$FOUND" | GREP_OPTIONS= command grep -qF "$PROMISE" && { [[ -f "$STATE" ]] && rm "$STATE"; echo "Completed: $PROMISE" >&2; exit 0; }
  fi
fi

# Continue loop: increment and output
NEXT=$((ITER + 1))
sed -i.bak "s/^iteration: .*/iteration: $NEXT/" "$STATE" && [[ -f "$STATE.bak" ]] && rm "$STATE.bak"

AGENT_PROMPT="You're execute on PDCA (Plan-Do-Check-Act) LOOP ($NEXT/$MAX) to achieve mission. When you get perfect fit, output '<promise>$PROMISE</promise>' in your final line."
AGENT_PROMPT+=" If persona persistence was lost, redeploy the previously active Hero from the session context without extra confirm."

REASON=$(printf '%s' "$AGENT_PROMPT PROMPT - $PROMPT" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   ' | tr -d '[:cntrl:]')
OUT=$(printf '{"decision":"block","reason":"%s","systemMessage":"%s"}' "$REASON" "LOOP ($NEXT/$MAX)")

# Guarantee well-formed JSON. sed already escapes \ and ", and tr strips control
# chars, so the output is valid by construction; jq is a cheap verification when
# present. If it still fails, fall back to a fixed valid reason and STILL block —
# we never emit nothing, because a silent pass-through would let the agent-loop
# die unnoticed instead of keeping the mission alive.
if command -v jq >/dev/null 2>&1; then
  if ! printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then
    OUT=$(printf '{"decision":"block","reason":"%s","systemMessage":"%s"}' "loop ($NEXT/$MAX)" "LOOP ($NEXT/$MAX)")
  fi
fi

printf '%s\n' "$OUT"
