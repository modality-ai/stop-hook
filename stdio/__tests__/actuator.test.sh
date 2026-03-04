#!/usr/bin/env bash
set -uo pipefail

ACTUATOR="$(dirname "$0")/../actuator"
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; (( PASS++ )) || true; }
fail() { echo "  FAIL: $1"; (( FAIL++ )) || true; }
check() {
  if [[ "$3" == *"$2"* ]]; then pass "$1"; else fail "$1 — expected: '$2', got: '$3'"; fi
}

D=/tmp/actuator-test-$$
export ACTUATOR_POLL_INTERVAL=0.1
echo "=== actuator tests ==="

# -- sync --
out=$(ACTUATOR_JOBS_DIR=$D "$ACTUATOR" -q "echo hello_world" 2>&1)
check "sync → completed + stdout" '"status":"completed"' "$out"
check "sync → stdout" 'hello_world' "$out"

out=$(ACTUATOR_JOBS_DIR=$D "$ACTUATOR" -q "exit 1" 2>&1)
check "sync fail → exit_code 1" '"exit_code":1' "$out"

# -- async --
job_out=$(ACTUATOR_JOBS_DIR=$D "$ACTUATOR" -a -q "echo async_ok" 2>&1)
check "async → running" '"status":"running"' "$job_out"
job_id=$(echo "$job_out" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
sleep 0.5
poll_out=$(ACTUATOR_JOBS_DIR=$D "$ACTUATOR" -p "$job_id" 2>&1)
check "async poll → completed" '"status":"completed"' "$poll_out"
check "async poll → stdout" 'async_ok' "$poll_out"

# -- streaming --
stream_out=$(ACTUATOR_JOBS_DIR=$D "$ACTUATOR" -s 'echo line1; echo line2; echo line3' 2>&1)
event_count=$(echo "$stream_out" | grep -c '"event":"stdout"' || echo 0)
if [[ "$event_count" -ge 3 ]]; then pass "streaming → $event_count stdout events"
else fail "streaming → expected 3+, got $event_count"; fi
check "streaming → completed" '"status":"completed"' "$stream_out"

# -- seq interleaving --
out_no_seq=$(ACTUATOR_JOBS_DIR=$D "$ACTUATOR" -q 'echo aaa; echo bbb >&2' 2>&1)
check "seq → hidden by default" 'aaa' "$out_no_seq"
if [[ "$out_no_seq" != *'"seq":'* ]]; then pass "seq → no seq field without --seq"
else fail "seq → no seq field without --seq — got seq in output"; fi
out=$(ACTUATOR_JOBS_DIR=$D "$ACTUATOR" --seq -q 'echo aaa; echo bbb >&2' 2>&1)
check "seq → field present with --seq" '"seq":' "$out"
seq_val=$(echo "$out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["seq"])' 2>/dev/null || echo "")
check "seq → has stdout" 'aaa' "$seq_val"
check "seq → has stderr" 'bbb' "$seq_val"
if [[ "$seq_val" == *$'\t'* ]]; then fail "seq → tags leaked"; else pass "seq → raw content only"; fi

# -- error handling --
out=$(ACTUATOR_JOBS_DIR=$D "$ACTUATOR" --poll no_such_job 2>&1)
check "missing job → error" '"error":"Job not found"' "$out"

# -- cleanup --
rm -rf "$D" 2>/dev/null || true
echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
