#!/usr/bin/env bash
# Simple regression tests for actuator refactoring:
#   - initial_status removal
#   - load_job_state consolidated error output

set -uo pipefail

ACTUATOR="$(dirname "$0")/../actuator"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; (( PASS++ )) || true; }
fail() { echo "  FAIL: $1"; (( FAIL++ )) || true; }

check() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    pass "$desc"
  else
    fail "$desc — expected: '$expected', got: '$actual'"
  fi
}

echo "=== actuator regression tests ==="
echo

# ---------------------------------------------------------------------------
echo "-- static checks --"

if ! grep -q 'initial_status' "$ACTUATOR"; then
  pass "initial_status removed from actuator"
else
  fail "initial_status still present in actuator"
fi

# ---------------------------------------------------------------------------
echo
echo "-- load_job_state: job not found errors --"

# JSON mode: poll missing job (stdout)
out=$(ACTUATOR_JOBS_DIR=/tmp/actuator-test-$$ "$ACTUATOR" --poll no_such_job 2>&1)
check "poll missing job → JSON error" '"error":"Job not found"' "$out"
check "poll missing job → job_id echoed" '"job_id":"no_such_job"' "$out"

# Plain mode: poll missing job (stderr)
err=$(ACTUATOR_JOBS_DIR=/tmp/actuator-test-$$ "$ACTUATOR" --poll no_such_job --plain 2>&1 >/dev/null)
check "poll missing job --plain → Error header" '------ Error ------' "$err"
check "poll missing job --plain → message" 'Job not found: no_such_job' "$err"

# JSON mode: poll-stream missing job
out=$(ACTUATOR_JOBS_DIR=/tmp/actuator-test-$$ "$ACTUATOR" --poll no_such_job -s 2>&1)
check "poll-stream missing job → JSON error" '"error":"Job not found"' "$out"

# JSON mode: terminate missing job
out=$(ACTUATOR_JOBS_DIR=/tmp/actuator-test-$$ "$ACTUATOR" --terminate no_such_job 2>&1)
check "terminate missing job → JSON error" '"error":"Job not found"' "$out"

# Plain mode: terminate missing job
err=$(ACTUATOR_JOBS_DIR=/tmp/actuator-test-$$ "$ACTUATOR" --terminate no_such_job --plain 2>&1 >/dev/null)
check "terminate missing job --plain → message" 'Job not found: no_such_job' "$err"

# ---------------------------------------------------------------------------
echo
echo "-- basic execution (smoke tests) --"

# Sync: completed status + stdout
out=$(ACTUATOR_JOBS_DIR=/tmp/actuator-test-$$ "$ACTUATOR" -q "echo hello_world" 2>&1)
check "sync exec → status completed" '"status":"completed"' "$out"
check "sync exec → stdout captured" 'hello_world' "$out"

# Sync: failed exit code
out=$(ACTUATOR_JOBS_DIR=/tmp/actuator-test-$$ "$ACTUATOR" -q "exit 1" 2>&1)
check "sync exec fail → status failed" '"status":"failed"' "$out"
check "sync exec fail → exit_code 1" '"exit_code":1' "$out"

# Async: running + poll to completion
JOBS_DIR=/tmp/actuator-test-async-$$
job_out=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" -a -q "echo async_ok" 2>&1)
check "async exec → status running" '"status":"running"' "$job_out"
job_id=$(echo "$job_out" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
if [[ -n "$job_id" ]]; then
  pass "async exec → job_id extracted: $job_id"
  sleep 0.5
  poll_out=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" --poll "$job_id" 2>&1)
  check "async poll → status completed" '"status":"completed"' "$poll_out"
  check "async poll → stdout async_ok" 'async_ok' "$poll_out"
else
  fail "async exec → could not extract job_id from: $job_out"
fi

# ---------------------------------------------------------------------------
echo
echo "-- ANSI color stripping in JSON output --"

# Command that emits ANSI color codes
out=$(ACTUATOR_JOBS_DIR=/tmp/actuator-test-$$ "$ACTUATOR" -q "printf '\033[31mred\033[0m \033[1;32mbold-green\033[0m plain'" 2>&1)
check "ANSI strip → no ESC in JSON stdout" 'red bold-green plain' "$out"
if echo "$out" | grep -q $'\033'; then
  fail "ANSI strip → raw ESC bytes still present in JSON"
else
  pass "ANSI strip → no raw ESC bytes in JSON"
fi

# Cleanup test dirs
rm -rf /tmp/actuator-test-$$ /tmp/actuator-test-async-$$ 2>/dev/null || true

# ---------------------------------------------------------------------------
echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
