#!/bin/bash
# Hook wrapper: Intercepts _Counter__ExecuteMethod calls for *agent-loop
# Extracts method parameters and creates the agent-loop state file
# Reads Claude Code hook JSON from stdin

set -euo pipefail
# DEBUG_HOOKS=1

trap 'echo "❌ extract-and-create-loop.sh error at line $LINENO: $BASH_COMMAND" >&2; exit 1' ERR

HOOK_INPUT=$(cat 2> /dev/null | sed 's/\x1b\[[0-9;]*[mK]//g' || echo "")

if [[ -n "${DEBUG_HOOKS:-}" ]]; then
  echo "[$(date)] PostToolUse hook received:" >> /tmp/hooks-debug.log
  echo "$HOOK_INPUT" >> /tmp/hooks-debug.log
fi

[[ -z "$HOOK_INPUT" ]] && exit 0

# Single-pass JSON scanner in awk. Scans for known keys at any depth,
# handles escape sequences and doubly-encoded string payloads
# (e.g. tool_response.content[].text containing JSON). O(N) end-to-end.
# Emits NUL-terminated KEY<SOH>VALUE records consumed by the loop below.
METHOD=""
PROJECT_DIR=""
PROMPT=""
MAX_ITERATIONS=""
COMPLETION_PROMISE=""

while IFS= read -r -d $'\3' record; do
  key="${record%%	*}"
  value="${record#*	}"
  case "$key" in
    METHOD) METHOD="$value" ;;
    PROJECT_DIR) PROJECT_DIR="$value" ;;
    PROMPT) PROMPT="$value" ;;
    MAX_ITERATIONS) MAX_ITERATIONS="$value" ;;
    COMPLETION_PROMISE) COMPLETION_PROMISE="$value" ;;
  esac
done < <(printf '%s' "$HOOK_INPUT" | awk '
BEGIN { RS = "\001" }
{ parse($0, 0) }

function parse(s, depth,    n, i, c, key, ne, val, f) {
  if (depth > 5) return
  n = length(s)
  i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") {
      ne = find_string_end(s, i)
      if (ne == 0) { i++; continue }
      key = decode(substr(s, i + 1, ne - i - 1))
      i = ne + 1
      while (i <= n && substr(s, i, 1) ~ /[ \t\n\r]/) i++
      if (substr(s, i, 1) == ":") {
        i++
        while (i <= n && substr(s, i, 1) ~ /[ \t\n\r]/) i++
        c = substr(s, i, 1)
        if (c == "\"") {
          ne = find_string_end(s, i)
          if (ne == 0) { i++; continue }
          val = decode(substr(s, i + 1, ne - i - 1))
          set_value(key, val, "string", depth)
          i = ne + 1
          if (length(val) > 0) {
            f = substr(val, 1, 1)
            if (f == "{" || f == "[") parse(val, depth + 1)
          }
        } else if (c ~ /[0-9-]/) {
          val = ""
          while (i <= n && substr(s, i, 1) ~ /[0-9.eE+\-]/) {
            val = val substr(s, i, 1)
            i++
          }
          set_value(key, val, "number", depth)
        }
      }
    } else {
      i++
    }
  }
}

function find_string_end(s, start,    i, c, n) {
  n = length(s)
  i = start + 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") { i += 2; continue }
    if (c == "\"") return i
    i++
  }
  return 0
}

function decode(raw) {
  gsub(/\\\\/, "\002", raw)
  gsub(/\\"/,  "\"",   raw)
  gsub(/\\n/,  "\n",   raw)
  gsub(/\\r/,  "\r",   raw)
  gsub(/\\t/,  "\t",   raw)
  gsub(/\\\//, "/",    raw)
  gsub(/\\b/,  "\b",   raw)
  gsub(/\\f/,  "\f",   raw)
  gsub(/\002/, "\\",   raw)
  return raw
}

function set_value(key, val, type, depth) {
  if (depth == 0 && type == "string") {
    if      (key == "cwd"            && cwd            == "") cwd            = val
    else if (key == "workspace"      && workspace      == "") workspace      = val
    else if (key == "project_dir"    && project_dir    == "") project_dir    = val
    else if (key == "transcript_cwd" && transcript_cwd == "") transcript_cwd = val
  }
  if      (key == "method"             && method   == "" && type == "string") method   = val
  else if (key == "prompt"             && prompt   == "" && type == "string") prompt   = val
  else if (key == "max_iterations"     && max_iter == "" && type == "number") max_iter = val
  else if (key == "iterations"         && max_iter == "" && type == "number") max_iter = val
  else if (key == "completion_promise" && promise  == "" && type == "string") promise  = val
}

END {
  pd = (cwd != "")         ? cwd         : \
       (workspace != "")   ? workspace   : \
       (project_dir != "") ? project_dir : \
       (transcript_cwd != "") ? transcript_cwd : ""
  printf "METHOD\t%s\003",            method
  printf "PROJECT_DIR\t%s\003",        pd
  printf "PROMPT\t%s\003",             prompt
  printf "MAX_ITERATIONS\t%s\003",     max_iter
  printf "COMPLETION_PROMISE\t%s\003", promise
}
')

if [[ "$METHOD" != "*agent-loop" ]]; then
  if [[ -n "${DEBUG_HOOKS:-}" ]]; then
    echo "[$(date)] Not an agent-loop call (method=$METHOD)" >> /tmp/hooks-debug.log
  fi
  exit 0
fi

if [[ -z "$PROJECT_DIR" || ! -d "$PROJECT_DIR" ]]; then
  PROJECT_DIR="$PWD"
fi
STATE_FILE="$PROJECT_DIR/.claude/agent-loop.local.md"

if [[ -z "$PROMPT" ]]; then
  [[ -f "$STATE_FILE" ]] && rm "$STATE_FILE"
  if [[ -n "${DEBUG_HOOKS:-}" ]]; then
    echo "[$(date)] Not an agent-loop call (no prompt extracted)" >> /tmp/hooks-debug.log
  fi
  exit 0
fi

[[ -z "$MAX_ITERATIONS" ]] && MAX_ITERATIONS="50"
[[ -z "$COMPLETION_PROMISE" ]] && COMPLETION_PROMISE="attempt_completion"
COMPLETION_PROMISE="${COMPLETION_PROMISE//<promise>/}"
COMPLETION_PROMISE="${COMPLETION_PROMISE//<\/promise>/}"

ITERATION=1
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
