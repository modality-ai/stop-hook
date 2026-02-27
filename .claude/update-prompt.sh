#!/bin/bash
# Agent Loop Prompt Update Hook - Updates state file with new user prompt
set -euo pipefail

STATE=".claude/agent-loop.local.md"
[[ -f "$STATE" ]] || exit 0

# Cache grep -P capability check (avoid repeated checks in function)
HAS_GREP_P=false
if command -v grep &>/dev/null && grep --help 2>&1 | grep -q '\-P'; then
  HAS_GREP_P=true
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

HOOK_INPUT=$(cat 2> /dev/null | sed 's/\x1b\[[0-9;]*[mK]//g; s/\\"/"/g; s/\\\\/\\/g' || echo "{}")
PROMPT=$(extract_json_value "$HOOK_INPUT" "prompt" "string" "" "10000")
if [[ -z "$PROMPT" ]]; then
  exit 0
fi

# Update state file with new prompt
{
  # Extract YAML frontmatter (everything between first and second ---)
  sed -n '/^---$/,/^---$/p' "$STATE"
  # Preserve existing content after frontmatter
  tail -n +5 "$STATE"
  echo ""
  # Append new prompt
  echo "$PROMPT"
} > "$STATE.tmp" && cp "$STATE.tmp" "$STATE"

echo "✓ Prompt updated in state file"
