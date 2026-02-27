#!/usr/bin/env bash
# Run all actuator test suites
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_SUITES=()

for test_file in "$DIR"/*.test.sh; do
  name=$(basename "$test_file")
  echo "━━━ $name ━━━"
  if output=$(bash "$test_file" 2>&1); then
    echo "$output"
  else
    echo "$output"
    FAILED_SUITES+=("$name")
  fi

  # Extract pass/fail counts from "Results: N passed, N failed"
  pass=$(echo "$output" | grep -o '[0-9]* passed' | tail -1 | grep -o '[0-9]*')
  fail=$(echo "$output" | grep -o '[0-9]* failed' | tail -1 | grep -o '[0-9]*')
  TOTAL_PASS=$(( TOTAL_PASS + ${pass:-0} ))
  TOTAL_FAIL=$(( TOTAL_FAIL + ${fail:-0} ))
  echo
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "TOTAL: $TOTAL_PASS passed, $TOTAL_FAIL failed (${#FAILED_SUITES[@]} suite(s) failed)"
if [[ ${#FAILED_SUITES[@]} -gt 0 ]]; then
  printf '  FAILED: %s\n' "${FAILED_SUITES[@]}"
  exit 1
fi
