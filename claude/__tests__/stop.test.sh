#!/usr/bin/env bash
# Tests for stop.sh — completion_promise extraction and loop control
set -uo pipefail

STOP="$(cd "$(dirname "$0")/.." && pwd)/stop.sh"
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; (( PASS++ )) || true; }
fail() { echo "  FAIL: $1 — expected: '$2', got: '$3'"; (( FAIL++ )) || true; }
check_eq() { [[ "$2" == "$3" ]] && pass "$1" || fail "$1" "$2" "$3"; }
check_contains() { [[ "$3" == *"$2"* ]] && pass "$1" || fail "$1" "$2" "$3"; }

# Create state file with given promise
new_state() {
  local dir="$1" promise="$2" iter="${3:-1}" max="${4:-10}"
  mkdir -p "$dir/.claude"
  cat > "$dir/.claude/agent-loop.local.md" <<EOF
---
iteration: $iter
max_iterations: $max
completion_promise: "$promise"
---
---
test prompt
EOF
}

# Create a JSONL transcript file containing an assistant message with given text
# Returns the path to the transcript file
make_transcript() {
  local dir="$1" content="$2"
  local path="$dir/transcript.jsonl"
  local escaped
  escaped=$(printf '%s' "$content" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$escaped" > "$path"
  echo "$path"
}

# Run stop.sh with CLAUDE_PROJECT_DIR set; transcript_path in stdin JSON
run_stop() {
  local project_dir="$1" transcript="$2"
  local input="{\"transcript_path\":\"$transcript\",\"cwd\":\"$project_dir\"}"
  echo "$input" | CLAUDE_PROJECT_DIR="$project_dir" bash "$STOP" 2>&1
}

echo "=== stop.sh — completion_promise extraction tests ==="

# 1. Plain text promise matches → exits 0, state removed, Completed message
D=$(mktemp -d)
new_state "$D" "DONE"
T=$(make_transcript "$D" "work done <promise>DONE</promise>")
rc=0; out=$(run_stop "$D" "$T") || rc=$?
check_eq      "plain promise → exit 0"         "0"              "$rc"
check_contains "plain promise → Completed"     "Completed: DONE" "$out"
[[ ! -f "$D/.claude/agent-loop.local.md" ]] \
  && pass "plain promise → state file removed" \
  || fail "plain promise → state file removed" "removed" "still exists"
rm -rf "$D"

# 2. Angle-bracket promise <FIXED> matches → exits 0 (the regression case)
D=$(mktemp -d)
new_state "$D" "<FIXED>"
T=$(make_transcript "$D" "fix applied <promise><FIXED></promise>")
rc=0; out=$(run_stop "$D" "$T") || rc=$?
check_eq       "angle-bracket → exit 0"        "0"                 "$rc"
check_contains "angle-bracket → Completed"     "Completed: <FIXED>" "$out"
[[ ! -f "$D/.claude/agent-loop.local.md" ]] \
  && pass "angle-bracket → state file removed" \
  || fail "angle-bracket → state file removed" "removed" "still exists"
rm -rf "$D"

# 3. Promise NOT found in transcript → outputs block decision, state incremented
D=$(mktemp -d)
new_state "$D" "DONE"
T=$(make_transcript "$D" "still working, no promise here")
out=$(run_stop "$D" "$T")
check_contains "no match → block decision"        '"decision":"block"' "$out"
state=$(cat "$D/.claude/agent-loop.local.md" 2>/dev/null || echo "")
check_contains "no match → iteration incremented" "iteration: 2"      "$state"
rm -rf "$D"

# 4. Wrong promise value in transcript → outputs block decision
D=$(mktemp -d)
new_state "$D" "DONE"
T=$(make_transcript "$D" "output <promise>OTHER</promise>")
out=$(run_stop "$D" "$T")
check_contains "wrong promise → block decision" '"decision":"block"' "$out"
rm -rf "$D"

# 5. Max iterations reached → exits 0, state removed
D=$(mktemp -d)
new_state "$D" "DONE" 10 10
T=$(make_transcript "$D" "no promise")
rc=0; out=$(run_stop "$D" "$T") || rc=$?
check_eq       "max iter → exit 0"      "0"                    "$rc"
check_contains "max iter → message"     "Max iterations reached" "$out"
[[ ! -f "$D/.claude/agent-loop.local.md" ]] \
  && pass "max iter → state file removed" \
  || fail "max iter → state file removed" "removed" "still exists"
rm -rf "$D"

# 6. No state file → exits 0 immediately (no-op)
D=$(mktemp -d)
T=$(make_transcript "$D" "irrelevant")
rc=0; CLAUDE_PROJECT_DIR="$D" bash "$STOP" <<< "{}" > /dev/null 2>&1 || rc=$?
check_eq "no state file → exit 0" "0" "$rc"
rm -rf "$D"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
