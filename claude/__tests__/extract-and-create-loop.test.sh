#!/usr/bin/env bash
set -uo pipefail

SCRIPT="$(dirname "$0")/../extract-and-create-loop.sh"
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; (( PASS++ )) || true; }
fail() { echo "  FAIL: $1"; (( FAIL++ )) || true; }
check() {
  if [[ "$3" == *"$2"* ]]; then pass "$1"; else fail "$1 — expected: '$2', got: '$3'"; fi
}
check_eq() {
  if [[ "$3" == "$2" ]]; then pass "$1"; else fail "$1 — expected: '$2', got: '$3'"; fi
}

run_hook() {
  local input="$1" project_dir="$2"
  echo "$input" | "$SCRIPT" 2>&1
  echo "---STATE---"
  cat "$project_dir/.claude/agent-loop.local.md" 2>/dev/null || echo "(no state file)"
}

new_dir() {
  local d="/tmp/extract-loop-test-$$-$1"
  rm -rf "$d"
  mkdir -p "$d/.claude"
  echo "$d"
}

echo "=== extract-and-create-loop.sh tests ==="

# 1. flat JSON: extracts prompt, max_iterations, completion_promise
D=$(new_dir flat)
input='{"cwd":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"hello world","max_iterations":7,"completion_promise":"<promise>DONE</promise>"}}}'
out=$(run_hook "$input" "$D")
check "flat → init message"      "Agent-loop initialized"      "$out"
check "flat → max=7"             "max=7"                        "$out"
check "flat → promise stripped"  "promise=DONE"                 "$out"
check "flat → state has prompt"  "hello world"                  "$out"
check "flat → iteration: 1"      "iteration: 1"                 "$out"
check "flat → max_iterations: 7" "max_iterations: 7"            "$out"
rm -rf "$D"

# 2. nested doubly-encoded JSON (typical MCP tool result shape)
D=$(new_dir nested)
inner='{\"methodParams\":{\"method\":\"*agent-loop\",\"prompt\":\"nested ok\",\"max_iterations\":3,\"completion_promise\":\"<promise>NESTED</promise>\"}}'
input='{"cwd":"'"$D"'","tool_response":{"content":[{"type":"text","text":"'"$inner"'"}]}}'
out=$(run_hook "$input" "$D")
check "nested → prompt found"     "nested ok"        "$out"
check "nested → max=3"            "max=3"            "$out"
check "nested → promise=NESTED"   "promise=NESTED"   "$out"
rm -rf "$D"

# 3. default max_iterations = 50 when missing entirely
D=$(new_dir default-max)
input='{"cwd":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"only prompt"}}}'
out=$(run_hook "$input" "$D")
check "default → max=50" "max=50" "$out"
rm -rf "$D"

# 4. fallback to "iterations" key when "max_iterations" missing
D=$(new_dir alt-iter-key)
input='{"cwd":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"alt key","iterations":12}}}'
out=$(run_hook "$input" "$D")
check "alt key → max=12" "max=12" "$out"
rm -rf "$D"

# 5. default completion_promise = "attempt_completion" when missing
D=$(new_dir default-promise)
input='{"cwd":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"no promise","max_iterations":2}}}'
out=$(run_hook "$input" "$D")
check "default → promise=attempt_completion" "promise=attempt_completion" "$out"
rm -rf "$D"

# 6. PROJECT_DIR fallback chain: workspace key works when cwd absent
D=$(new_dir workspace-key)
input='{"workspace":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"via workspace","max_iterations":1}}}'
out=$(run_hook "$input" "$D")
check "workspace → init"   "Agent-loop initialized" "$out"
check "workspace → state"  "via workspace"          "$out"
rm -rf "$D"

# 7. PROJECT_DIR falls back to PWD when no cwd key and no valid dir
D=$(new_dir pwd-fallback)
pushd "$D" > /dev/null
input='{"tool_input":{"method":"*agent-loop","params":{"prompt":"pwd default","max_iterations":4}}}'
echo "$input" | "$SCRIPT" > /dev/null 2>&1
if [[ -f "$D/.claude/agent-loop.local.md" ]]; then
  pass "pwd fallback → state file created in PWD"
  check "pwd fallback → state has prompt" "pwd default" "$(cat "$D/.claude/agent-loop.local.md")"
else
  fail "pwd fallback → state file not created"
fi
popd > /dev/null
rm -rf "$D"

# 8. invalid PROJECT_DIR falls back to PWD
D=$(new_dir invalid-cwd)
pushd "$D" > /dev/null
input='{"cwd":"/this/path/does/not/exist","tool_input":{"method":"*agent-loop","params":{"prompt":"bad cwd","max_iterations":1}}}'
echo "$input" | "$SCRIPT" > /dev/null 2>&1
if [[ -f "$D/.claude/agent-loop.local.md" ]]; then pass "invalid cwd → fallback to PWD"
else fail "invalid cwd → no state file in PWD"; fi
popd > /dev/null
rm -rf "$D"

# 9. no prompt → exit 0, no state file created
D=$(new_dir no-prompt)
input='{"cwd":"'"$D"'","tool_input":{"unrelated":"data"}}'
out=$(echo "$input" | "$SCRIPT" 2>&1)
rc=$?
check_eq "no prompt → exit 0" "0" "$rc"
if [[ ! -f "$D/.claude/agent-loop.local.md" ]]; then pass "no prompt → no state file"
else fail "no prompt → state file should not exist"; fi
rm -rf "$D"

# 10. stale STATE_FILE is cleaned up when input has no prompt
D=$(new_dir stale-cleanup)
echo "stale data" > "$D/.claude/agent-loop.local.md"
input='{"cwd":"'"$D"'","tool_input":{"method":"*agent-loop","unrelated":"x"}}'
echo "$input" | "$SCRIPT" > /dev/null 2>&1
if [[ ! -f "$D/.claude/agent-loop.local.md" ]]; then pass "stale cleanup → removed"
else fail "stale cleanup → still exists"; fi
rm -rf "$D"

# 11. JSON escape handling: \" inside prompt preserved as literal "
D=$(new_dir escape-quote)
input='{"cwd":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"with \"quotes\" inside","max_iterations":1}}}'
out=$(run_hook "$input" "$D")
check 'escape → \" decoded to "' 'with "quotes" inside' "$out"
rm -rf "$D"

# 12. JSON escape handling: \n decoded to actual newline
D=$(new_dir escape-newline)
input='{"cwd":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"line1\nline2","max_iterations":1}}}'
echo "$input" | "$SCRIPT" > /dev/null 2>&1
state=$(cat "$D/.claude/agent-loop.local.md")
line_count=$(echo "$state" | grep -c '^line[12]$')
check_eq "escape → \\n is newline" "2" "$line_count"
rm -rf "$D"

# 13. promise WITHOUT <promise> tags passes through unchanged
D=$(new_dir promise-raw)
input='{"cwd":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"x","max_iterations":1,"completion_promise":"RAW_DONE"}}}'
out=$(run_hook "$input" "$D")
check "raw promise → passes through" "promise=RAW_DONE" "$out"
rm -rf "$D"

# 14. ANSI escape codes stripped from input
D=$(new_dir ansi-strip)
input=$'{"cwd":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"ansi here\x1b[31m","max_iterations":1}}}'
out=$(run_hook "$input" "$D")
check "ansi → prompt extracted" "ansi here" "$out"
if [[ "$out" != *$'\x1b['* ]]; then pass "ansi → escape codes stripped from state"
else fail "ansi → escape codes leaked into state"; fi
rm -rf "$D"

# 15. project_dir key as third PROJECT_DIR fallback
D=$(new_dir project-dir-key)
input='{"project_dir":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"via project_dir","max_iterations":1}}}'
out=$(run_hook "$input" "$D")
check "project_dir key → init" "Agent-loop initialized" "$out"
check "project_dir key → state" "via project_dir"       "$out"
rm -rf "$D"

# 16. transcript_cwd key as fourth PROJECT_DIR fallback
D=$(new_dir transcript-cwd)
input='{"transcript_cwd":"'"$D"'","tool_input":{"method":"*agent-loop","params":{"prompt":"via transcript","max_iterations":1}}}'
out=$(run_hook "$input" "$D")
check "transcript_cwd → init"  "Agent-loop initialized" "$out"
check "transcript_cwd → state" "via transcript"         "$out"
rm -rf "$D"

# 17. non-agent-loop method produces no state file, exits 0
D=$(new_dir non-agent-loop)
input='{"cwd":"'"$D"'","tool_input":{"method":"*code","params":{"prompt":"not loop","max_iterations":1}}}'
out=$(echo "$input" | "$SCRIPT" 2>&1)
rc=$?
check_eq "non-agent-loop → exit 0" "0" "$rc"
if [[ ! -f "$D/.claude/agent-loop.local.md" ]]; then pass "non-agent-loop → no state file"
else fail "non-agent-loop → state file should not exist"; fi
rm -rf "$D"

# 18. empty stdin produces no state file, exits 0
out=$(echo "" | "$SCRIPT" 2>&1)
rc=$?
check_eq "empty input → exit 0" "0" "$rc"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
