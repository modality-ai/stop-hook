#!/usr/bin/env bash
set -uo pipefail

SCRIPT="$(dirname "$0")/../extract-and-create-loop.sh"
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; (( PASS++ )) || true; }
fail() { echo "  FAIL: $1"; (( FAIL++ )) || true; }
check() {
  if [[ "$3" == *"$2"* ]]; then pass "$1"; else fail "$1 — expected: '$2', got: '$3'"; fi
}

run_hook() {
  local input="$1" project_dir="$2"
  echo "$input" | "$SCRIPT" 2>&1
  echo "---STATE---"
  cat "$project_dir/.claude/agent-loop.local.md" 2>/dev/null || echo "(no state file)"
}

new_dir() {
  local d="/tmp/extract-loop-perf-test-$$-$1"
  rm -rf "$d"
  mkdir -p "$d/.claude"
  echo "$d"
}

now_ns() {
  python3 - <<'PY'
import time
print(time.monotonic_ns())
PY
}

echo "=== extract-and-create-loop.sh performance tests ==="

D=$(new_dir large-payload)
noise=$(python3 - <<'PY'
import json
print(json.dumps({f"noise_{i}": "x" * 200 for i in range(1000)})[1:-1])
PY
)
input='{"cwd":"'"$D"'",'"$noise"',"tool_input":{"method":"*agent-loop","params":{"prompt":"perf prompt","max_iterations":1}}}'
start_ns=$(now_ns)
out=$(run_hook "$input" "$D")
end_ns=$(now_ns)
elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
check "large payload → init" "Agent-loop initialized" "$out"
check "large payload → prompt" "perf prompt" "$out"
if (( elapsed_ms < 1000 )); then pass "large payload → completed under 1000ms (${elapsed_ms}ms)"
else fail "large payload → expected under 1000ms, got ${elapsed_ms}ms"; fi
rm -rf "$D"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
