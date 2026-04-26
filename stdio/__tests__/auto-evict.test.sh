#!/usr/bin/env bash
set -uo pipefail

ACTUATOR="$(dirname "$0")/../actuator"
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; (( PASS++ )) || true; }
fail() { echo "  FAIL: $1"; (( FAIL++ )) || true; }

echo "=== auto-eviction tests ==="

# 1. eviction triggers when count exceeds threshold
D=/tmp/actuator-evict-test-$$
for i in $(seq 1 6); do
  ACTUATOR_JOBS_DIR=$D "$ACTUATOR" -a -q "echo job_$i" > /dev/null 2>&1
done
sleep 0.3
before=$(ls "$D"/*.job 2>/dev/null | wc -l | tr -d ' ')
ACTUATOR_JOBS_DIR=$D ACTUATOR_CLEANUP_THRESHOLD=4 ACTUATOR_EVICT_COUNT=2 "$ACTUATOR" -l > /dev/null 2>&1
after=$(ls "$D"/*.job 2>/dev/null | wc -l | tr -d ' ')
if [[ "$after" -lt "$before" ]]; then pass "eviction triggers → jobs reduced on -l ($before → $after)"
else fail "eviction triggers → expected fewer jobs, got ($before → $after)"; fi
rm -rf "$D"

# 2. running jobs are NOT evicted
D=/tmp/actuator-evict2-test-$$
long_out=$(ACTUATOR_JOBS_DIR=$D "$ACTUATOR" -a -q "sleep 30" 2>&1)
long_id=$(echo "$long_out" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
for i in 1 2 3 4; do
  ACTUATOR_JOBS_DIR=$D "$ACTUATOR" -a -q "echo done_$i" > /dev/null 2>&1
done
sleep 0.2
ACTUATOR_JOBS_DIR=$D ACTUATOR_CLEANUP_THRESHOLD=3 ACTUATOR_EVICT_COUNT=10 "$ACTUATOR" -l > /dev/null 2>&1
if [[ -f "$D/${long_id}.job" ]]; then pass "running job preserved → not evicted"
else fail "running job preserved → was evicted"; fi
ACTUATOR_JOBS_DIR=$D "$ACTUATOR" -k "$long_id" > /dev/null 2>&1 || true
rm -rf "$D"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
