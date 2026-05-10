#!/bin/bash
# Hook wrapper: Intercepts _Counter__ExecuteMethod calls for *agent-loop
# Extracts method parameters and creates the agent-loop state file
# Reads Claude Code hook JSON from stdin

set -euo pipefail
# DEBUG_HOOKS=1

trap 'echo "❌ extract-and-create-loop.sh error at line $LINENO: $BASH_COMMAND" >&2; exit 1' ERR

HOOK_INPUT=$(cat 2> /dev/null | sed 's/\x1b\[[0-9;]*[mK]//g' || echo "{}")

if [[ -n "${DEBUG_HOOKS:-}" ]]; then
  echo "[$(date)] PostToolUse hook received:" >> /tmp/hooks-debug.log
  echo "$HOOK_INPUT" >> /tmp/hooks-debug.log
fi

json_decoded=""
json_next=0
json_ws_pos=0
json_found=""
json_candidates=()

json_skip_ws() {
  local s="$1" i="$2" c
  while (( i < ${#s} )); do
    c="${s:i:1}"
    [[ "$c" == " " || "$c" == $'\t' || "$c" == $'\n' || "$c" == $'\r' ]] || break
    ((i++))
  done
  json_ws_pos=$i
}

json_parse_string_at() {
  local s="$1" i="$2" max_len="${3:-10000}" out="" c n hex
  (( i++ ))
  while (( i < ${#s} )); do
    c="${s:i:1}"
    if [[ "$c" == '"' ]]; then
      json_decoded="$out"
      json_next=$((i + 1))
      return 0
    fi
    if [[ "$c" == "\\" ]]; then
      ((i++))
      (( i >= ${#s} )) && break
      n="${s:i:1}"
      case "$n" in
        '"') out+='"' ;;
        '\\') out+='\' ;;
        '/') out+='/' ;;
        'n') out+=$'\n' ;;
        'r') out+=$'\r' ;;
        't') out+=$'\t' ;;
        'b') out+=$'\b' ;;
        'f') out+=$'\f' ;;
        'u')
          hex="${s:i+1:4}"
          if [[ "$hex" =~ ^[0-9a-fA-F]{4}$ ]]; then
            out+="\\u$hex"
            i=$((i + 4))
          else
            out+="\\u"
          fi
          ;;
        *) out+="$n" ;;
      esac
    else
      out+="$c"
    fi
    (( ${#out} > max_len )) && return 1
    ((i++))
  done
  return 1
}

json_extract_direct() {
  local s="$1" key="$2" type="${3:-string}" default="${4:-}" max_len="${5:-10000}"
  local i=0 c token j value
  while (( i < ${#s} )); do
    c="${s:i:1}"
    if [[ "$c" == '"' ]] && json_parse_string_at "$s" "$i" "$max_len"; then
      token="$json_decoded"
      json_skip_ws "$s" "$json_next"; j=$json_ws_pos
      if [[ "$token" == "$key" && "${s:j:1}" == ":" ]]; then
        json_skip_ws "$s" $((j + 1)); j=$json_ws_pos
        if [[ "$type" == "number" ]]; then
          value=""
          while [[ "${s:j:1}" =~ [0-9] ]]; do value+="${s:j:1}"; ((j++)); done
          [[ "$value" =~ ^[0-9]+$ ]] && { echo "$value"; return 0; }
        elif [[ "${s:j:1}" == '"' ]] && json_parse_string_at "$s" "$j" "$max_len"; then
          echo "$json_decoded"
          return 0
        fi
      fi
      i="$json_next"
    else
      ((i++))
    fi
  done
  echo "$default"
}

json_collect_string_values() {
  local s="$1" max_len="${2:-100000}" i=0 c token j
  while (( i < ${#s} )); do
    c="${s:i:1}"
    if [[ "$c" == '"' ]] && json_parse_string_at "$s" "$i" "$max_len"; then
      token="$json_decoded"
      json_skip_ws "$s" "$json_next"; j=$json_ws_pos
      if [[ "${s:j:1}" != ":" ]]; then
        if [[ "$token" == *'{'* || "$token" == *'"prompt"'* || "$token" == *'\"prompt\"'* ]]; then
          json_candidates+=("$token")
        fi
      fi
      i="$json_next"
    else
      ((i++))
    fi
  done
}

json_find_candidate() {
  local root="$1" depth="${2:-0}" candidate nested prompt
  (( depth > 5 )) && return 1
  prompt=$(json_extract_direct "$root" "prompt" "string" "" "10000")
  if [[ -n "$prompt" ]]; then
    json_found="$root"
    return 0
  fi
  local old_count=${#json_candidates[@]}
  json_collect_string_values "$root" 100000
  local idx
  for (( idx=old_count; idx<${#json_candidates[@]}; idx++ )); do
    candidate="${json_candidates[idx]}"
    if [[ "$candidate" == *'\"prompt\"'* ]]; then
      nested="$candidate"
      nested="${nested//\\\"/\"}"
      nested="${nested//\\\\/\\}"
    else
      nested="$candidate"
    fi
    [[ "$nested" == *'"prompt"'* ]] || continue
    if json_find_candidate "$nested" $((depth + 1)); then
      return 0
    fi
  done
  return 1
}

extract_json_value() {
  local json="$1" key="$2" type="${3:-string}" default="${4:-}" max_len="${5:-10000}"
  json_extract_direct "$json" "$key" "$type" "$default" "$max_len"
}

PROJECT_DIR=$(json_extract_direct "$HOOK_INPUT" "cwd" "string" "" "10000")
[[ -z "$PROJECT_DIR" ]] && PROJECT_DIR=$(json_extract_direct "$HOOK_INPUT" "workspace" "string" "" "10000")
[[ -z "$PROJECT_DIR" ]] && PROJECT_DIR=$(json_extract_direct "$HOOK_INPUT" "project_dir" "string" "" "10000")
[[ -z "$PROJECT_DIR" ]] && PROJECT_DIR=$(json_extract_direct "$HOOK_INPUT" "transcript_cwd" "string" "" "10000")
if [[ -z "$PROJECT_DIR" || ! -d "$PROJECT_DIR" ]]; then
  PROJECT_DIR="$PWD"
fi
STATE_FILE="$PROJECT_DIR/.claude/agent-loop.local.md"

ITERATION=1
SOURCE_JSON="$HOOK_INPUT"
if json_find_candidate "$HOOK_INPUT" 0; then
  SOURCE_JSON="$json_found"
fi

MAX_ITERATIONS=$(extract_json_value "$SOURCE_JSON" "max_iterations" "number" "")
[[ -z "$MAX_ITERATIONS" ]] && MAX_ITERATIONS=$(extract_json_value "$SOURCE_JSON" "iterations" "number" "50")
COMPLETION_PROMISE=$(extract_json_value "$SOURCE_JSON" "completion_promise" "string" "attempt_completion" "1000")
COMPLETION_PROMISE=$(echo "$COMPLETION_PROMISE" | sed 's/<promise>//g; s/<\/promise>//g')
PROMPT=$(extract_json_value "$SOURCE_JSON" "prompt" "string" "" "10000")

if [[ -z "$PROMPT" ]]; then
  [[ -f "$STATE_FILE" ]] && rm "$STATE_FILE"
  if [[ -n "${DEBUG_HOOKS:-}" ]]; then
    echo "[$(date)] Not an agent-loop call (no prompt extracted)" >> /tmp/hooks-debug.log
  fi
  exit 0
fi

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
