#!/usr/bin/env bash
# Tests for poll_job / poll_job_stream non-child PID handling (v1.8.1 fix)
#
# Validates:
#   - poll correctly reads final status from .job file when PID is already dead
#   - poll falls back to "failed" when PID is dead but .job still says "running"
#   - wait is NOT called on non-child PIDs (static check)
#   - poll_job_stream has identical behavior

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

check_not() {
  local desc="$1" unexpected="$2" actual="$3"
  if [[ "$actual" != *"$unexpected"* ]]; then
    pass "$desc"
  else
    fail "$desc — should NOT contain: '$unexpected', got: '$actual'"
  fi
}

JOBS_DIR="/tmp/actuator-poll-test-$$"
export ACTUATOR_POLL_INTERVAL=0.1
cleanup() { rm -rf "$JOBS_DIR" 2>/dev/null || true; }
trap cleanup EXIT

echo "=== poll non-child PID tests ==="
echo

# ---------------------------------------------------------------------------
echo "-- static checks --"

# Verify wait is NOT used inside poll_job / poll_job_stream on polled PIDs
# The old buggy pattern was: wait "$PID" inside poll_job
poll_section=$(sed -n '/^poll_job()/,/^[a-z_]*() {/p' "$ACTUATOR")
if echo "$poll_section" | grep -q 'wait "\$PID"'; then
  fail "poll_job still uses wait \$PID (non-child PID bug)"
else
  pass "poll_job does NOT use wait \$PID"
fi

poll_stream_section=$(sed -n '/^poll_job_stream()/,/^[a-z_]*() {/p' "$ACTUATOR")
if echo "$poll_stream_section" | grep -q 'wait "\$PID"'; then
  fail "poll_job_stream still uses wait \$PID (non-child PID bug)"
else
  pass "poll_job_stream does NOT use wait \$PID"
fi

# Verify sleep + load_job_state pattern exists (the fix)
if echo "$poll_section" | grep -q 'sleep 0.1'; then
  pass "poll_job uses sleep 0.1 grace period before re-read"
else
  fail "poll_job missing sleep 0.1 grace period"
fi

if echo "$poll_section" | grep -q 'load_job_state.*|| true'; then
  pass "poll_job re-reads job state with || true guard"
else
  fail "poll_job missing guarded load_job_state re-read"
fi

# ---------------------------------------------------------------------------
echo
echo "-- poll_job: PID dead, job file has final status (happy path) --"

# Launch a fast async job, wait for it to finish, then poll
mkdir -p "$JOBS_DIR"
job_out=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" -a -q "echo poll_ok; exit 0" 2>&1)
job_id=$(echo "$job_out" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$job_id" ]]; then
  fail "could not extract job_id for happy path test"
else
  # Wait for background job to finish and write its status
  sleep 0.1

  # PID should be dead now, but .job file should say "completed"
  poll_out=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" --poll "$job_id" 2>&1)
  check "poll after PID dead → status completed" '"status":"completed"' "$poll_out"
  check "poll after PID dead → exit_code 0" '"exit_code":0' "$poll_out"
  check "poll after PID dead → stdout captured" 'poll_ok' "$poll_out"
fi

# ---------------------------------------------------------------------------
echo
echo "-- poll_job: PID dead, job file has final failed status --"

mkdir -p "$JOBS_DIR"
job_out=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" -a -q "echo fail_output; exit 42" 2>&1)
job_id=$(echo "$job_out" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$job_id" ]]; then
  fail "could not extract job_id for failed exit test"
else
  sleep 0.1

  poll_out=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" --poll "$job_id" 2>&1)
  check "poll failed job → status failed" '"status":"failed"' "$poll_out"
  check "poll failed job → exit_code 42" '"exit_code":42' "$poll_out"
  check "poll failed job → stdout captured" 'fail_output' "$poll_out"
fi

# ---------------------------------------------------------------------------
echo
echo "-- poll_job: race condition — PID dead but .job still says running --"

# Manually craft a .job file with a dead PID and STATUS=running
# This simulates the race where the background subshell died before writing status
mkdir -p "$JOBS_DIR"
race_job_id="race-test-$$"
dead_pid=99999
# Ensure PID is actually dead
while kill -0 "$dead_pid" 2>/dev/null; do
  dead_pid=$((dead_pid + 1))
done

cat > "${JOBS_DIR}/${race_job_id}.job" <<EOF
JOB_ID='${race_job_id}'
PID='${dead_pid}'
COMMAND='echo race_test'
STATUS='running'
START_TIME='$(date +%s)'
CWD='/tmp'
WRITE_MODE='false'
EXIT_CODE=''
END_TIME=''
STDOUT_FILE='${JOBS_DIR}/${race_job_id}.stdout'
STDERR_FILE='${JOBS_DIR}/${race_job_id}.stderr'
EOF
touch "${JOBS_DIR}/${race_job_id}.stdout" "${JOBS_DIR}/${race_job_id}.stderr"

poll_out=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" --poll "$race_job_id" 2>&1)
check "race condition → status failed" '"status":"failed"' "$poll_out"
check "race condition → exit_code 1 (fallback)" '"exit_code":1' "$poll_out"
check_not "race condition → NOT status running" '"status":"running"' "$poll_out"

# Verify the .job file was updated on disk too
source "${JOBS_DIR}/${race_job_id}.job"
if [[ "$STATUS" == "failed" && "$EXIT_CODE" == "1" ]]; then
  pass "race condition → .job file updated to failed on disk"
else
  fail "race condition → .job file not updated (STATUS=$STATUS EXIT_CODE=$EXIT_CODE)"
fi

# ---------------------------------------------------------------------------
echo
echo "-- poll_job_stream: PID dead, job file has final status --"

mkdir -p "$JOBS_DIR"
job_out=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" -a -q "echo stream_ok" 2>&1)
job_id=$(echo "$job_out" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$job_id" ]]; then
  fail "could not extract job_id for stream test"
else
  sleep 0.1

  # poll_job_stream (-s flag) should also read final status correctly
  # Use a temp file to capture output since timeout + subshell can lose buffered data
  stream_tmp="${JOBS_DIR}/stream_out_1.tmp"
  ACTUATOR_JOBS_DIR="$JOBS_DIR" timeout 5 "$ACTUATOR" --poll "$job_id" -s > "$stream_tmp" 2>&1 || true
  stream_out=$(cat "$stream_tmp" 2>/dev/null || true)
  check "poll-stream after PID dead → status completed" '"status":"completed"' "$stream_out"
  check "poll-stream after PID dead → stdout" 'stream_ok' "$stream_out"
fi

# ---------------------------------------------------------------------------
echo
echo "-- poll_job_stream: race condition — PID dead, .job still running --"

mkdir -p "$JOBS_DIR"
race_stream_id="race-stream-$$"
dead_pid2=99998
while kill -0 "$dead_pid2" 2>/dev/null; do
  dead_pid2=$((dead_pid2 + 1))
done

cat > "${JOBS_DIR}/${race_stream_id}.job" <<EOF
JOB_ID='${race_stream_id}'
PID='${dead_pid2}'
COMMAND='echo race_stream'
STATUS='running'
START_TIME='$(date +%s)'
CWD='/tmp'
WRITE_MODE='false'
EXIT_CODE=''
END_TIME=''
STDOUT_FILE='${JOBS_DIR}/${race_stream_id}.stdout'
STDERR_FILE='${JOBS_DIR}/${race_stream_id}.stderr'
EOF
touch "${JOBS_DIR}/${race_stream_id}.stdout" "${JOBS_DIR}/${race_stream_id}.stderr"

stream_tmp2="${JOBS_DIR}/stream_out_2.tmp"
ACTUATOR_JOBS_DIR="$JOBS_DIR" timeout 5 "$ACTUATOR" --poll "$race_stream_id" -s > "$stream_tmp2" 2>&1 || true
stream_out=$(cat "$stream_tmp2" 2>/dev/null || true)
check "stream race condition → status failed" '"status":"failed"' "$stream_out"
check "stream race condition → exit_code 1" '"exit_code":1' "$stream_out"
check_not "stream race condition → NOT status running" '"status":"running"' "$stream_out"

# ---------------------------------------------------------------------------
echo
echo "-- poll_job: completed job polled multiple times (idempotent) --"

mkdir -p "$JOBS_DIR"
job_out=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" -a -q "echo idem_ok" 2>&1)
job_id=$(echo "$job_out" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$job_id" ]]; then
  fail "could not extract job_id for idempotent test"
else
  sleep 0.1

  poll1=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" --poll "$job_id" 2>&1)
  poll2=$(ACTUATOR_JOBS_DIR="$JOBS_DIR" "$ACTUATOR" --poll "$job_id" 2>&1)
  check "idempotent poll #1 → completed" '"status":"completed"' "$poll1"
  check "idempotent poll #2 → completed" '"status":"completed"' "$poll2"

  # Extract exit_codes — should be identical
  ec1=$(echo "$poll1" | grep -o '"exit_code":[0-9]*' | head -1)
  ec2=$(echo "$poll2" | grep -o '"exit_code":[0-9]*' | head -1)
  if [[ "$ec1" == "$ec2" ]]; then
    pass "idempotent poll → exit_code stable across polls"
  else
    fail "idempotent poll → exit_code changed: $ec1 vs $ec2"
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
