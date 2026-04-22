#!/usr/bin/env bash
# Tests for offload_message error_count fix and grep -c || var=0 pattern
# in _compress_git_status, _compress_build, and _compress_lint
set -uo pipefail

ACTUATOR="$(cd "$(dirname "$0")" && pwd)/../actuator"
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; (( PASS++ )) || true; }
fail() { echo "  FAIL: $1"; (( FAIL++ )) || true; }
check() {
  if [[ "$3" == *"$2"* ]]; then pass "$1"; else fail "$1 — expected: '$2', got: '$3'"; fi
}
check_absent() {
  if [[ "$3" != *"$2"* ]]; then pass "$1"; else fail "$1 — unexpected '$2' in: '$3'"; fi
}

# Source only function definitions (before main), neutralising set -e and readonly.
# Extract once to a temp file — avoids re-parsing actuator on every test call,
# and uses a heredoc to avoid shell-quoting traps on single quotes / backslashes.
if [[ ! -x "$ACTUATOR" ]]; then echo "FATAL: actuator not found at $ACTUATOR"; exit 1; fi
MAIN_LINE=$(grep -n "^main() {" "$ACTUATOR" | head -1 | cut -d: -f1)
if [[ -z "$MAIN_LINE" ]]; then echo "FATAL: could not locate main() in $ACTUATOR"; exit 1; fi
TMPFILES=()
FN_DEFS=$(mktemp); TMPFILES+=("$FN_DEFS")
head -$(( MAIN_LINE - 1 )) "$ACTUATOR" | sed 's/^set -.*//; s/^readonly /declare /' > "$FN_DEFS"
_source_fns() {
  bash << ENDSOURCE
source "$FN_DEFS"
$*
ENDSOURCE
}

# Cleanup on exit
cleanup() { rm -f "${TMPFILES[@]}" 2>/dev/null || true; }
trap cleanup EXIT

mktest() { local f; f=$(mktemp); TMPFILES+=("$f"); printf '%s' "$1" > "$f"; echo "$f"; }

echo "=== offload_message + compress tests ==="

# ---------------------------------------------------------------------------
# offload_message
# ---------------------------------------------------------------------------

# mode=0: no errors → [x]0/, no duplicate zero (the original bug)
CLEAN_FILE=$(mktest $'starting process\nall done\n')
result=$(_source_fns "VERBOSE_LEVEL=0; offload_message stdout '$CLEAN_FILE'" 2>/dev/null)
check        "offload_message no errors → [x]0/2L"            '[x]0/2L' "$result"
check_absent "offload_message no errors → no duplicate [x]00" '[x]00'  "$result"

# mode=0: exact error count — error + fatal on separate lines
ERR_FILE=$(mktest $'starting\nerror: something failed\nfatal: bad state\ndone\n')
result=$(_source_fns "VERBOSE_LEVEL=0; offload_message stdout '$ERR_FILE'" 2>/dev/null)
check "offload_message errors → [x]2/" '[x]2/' "$result"

# mode=0: all keyword variants (exception, traceback, panic, failed) in one fixture
ALL_KW=$(mktest $'exception raised\ntraceback follows\npanic here\ntask failed\n')
result=$(_source_fns "VERBOSE_LEVEL=0; offload_message stdout '$ALL_KW'" 2>/dev/null)
check "offload_message → exception/traceback/panic/failed all counted" '[x]4/' "$result"

# mode=0: case-insensitive matching (grep -i)
UPPER_FILE=$(mktest $'ERROR: uppercase error\nFATAL: uppercase fatal\n')
result=$(_source_fns "VERBOSE_LEVEL=0; offload_message stdout '$UPPER_FILE'" 2>/dev/null)
check "offload_message → case-insensitive ERROR/FATAL" '[x]2/' "$result"

# mode=0: multiple keywords on ONE line → grep -c counts lines, not occurrences
MULTI_KW=$(mktest $'error: fatal exception traceback\nnormal line\n')
result=$(_source_fns "VERBOSE_LEVEL=0; offload_message stdout '$MULTI_KW'" 2>/dev/null)
check "offload_message multi-keyword line → [x]1/ (per-line)" '[x]1/' "$result"

# mode=0: missing file → [x]0/0L (guarded by -f check)
result=$(_source_fns "VERBOSE_LEVEL=0; offload_message stdout '/nonexistent/path/$$'" 2>/dev/null)
check "offload_message missing file → [x]0/0L" '[x]0/0L' "$result"

# mode=0: empty file (0 bytes)
EMPTY_FILE=$(mktest '')
result=$(_source_fns "VERBOSE_LEVEL=0; offload_message stdout '$EMPTY_FILE'" 2>/dev/null)
check "offload_message empty file → [x]0/0L" '[x]0/0L' "$result"

# mode=0: no trailing newline → wc -l counts newline chars, not lines of text
NO_NL_FILE=$(mktest 'no newline at end')
result=$(_source_fns "VERBOSE_LEVEL=0; offload_message stdout '$NO_NL_FILE'" 2>/dev/null)
check "offload_message no trailing newline → 0L" '0L' "$result"

# mode=1: surfaced error lines, stream type, line count, error count
V1_FILE=$(mktest $'starting\nerror: disk full\nfatal: oom\ndone\n')
result=$(_source_fns "VERBOSE_LEVEL=1; offload_message stdout '$V1_FILE'" 2>/dev/null)
check "offload_message VERBOSE=1 → stream type 'stdout'" 'stdout'    "$result"
check "offload_message VERBOSE=1 → surfaced error line"  'disk full' "$result"

# mode=1: head-5 cap — 6 error lines but only first 5 surfaced
CAP_FILE=$(mktest $'e1: error alpha\ne2: error beta\ne3: error gamma\ne4: error delta\ne5: error epsilon\ne6: error zeta\n')
result=$(_source_fns "VERBOSE_LEVEL=1; offload_message stdout '$CAP_FILE'" 2>/dev/null)
check        "offload_message VERBOSE=1 cap → line 5 present" 'epsilon' "$result"
check_absent "offload_message VERBOSE=1 cap → line 6 absent"  'zeta'    "$result"

# mode=2: verbose tail format — stream_type, N lines, error(s), path, Last N lines, tail, grep hint
V2_FILE=$(mktest $'line1\nline2\nerror: boom\nline4\n')
result=$(_source_fns "VERBOSE_LEVEL=2; offload_message stderr '$V2_FILE'" 2>/dev/null)
check "offload_message VERBOSE=2 → stderr: prefix"   'stderr:'       "$result"
check "offload_message VERBOSE=2 → 1 error(s)"       '1 error(s)'    "$result"
check "offload_message VERBOSE=2 → file path"        "$V2_FILE"      "$result"
check "offload_message VERBOSE=2 → Last 10 lines"    'Last 10 lines' "$result"
check "offload_message VERBOSE=2 → Use grep hint"    'Use grep'      "$result"

# mode=2: tail-10 boundary — 12-line file, lines 1–2 excluded from tail
TAIL_FILE=$(mktest $'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\n')
result=$(_source_fns "VERBOSE_LEVEL=2; offload_message stdout '$TAIL_FILE'" 2>/dev/null)
check        "offload_message VERBOSE=2 tail → line3 in tail"  'line3' "$result"
check_absent "offload_message VERBOSE=2 tail → line2 excluded" 'line2' "$result"

# mode=2: missing file → 0 lines, 0 error(s)
result=$(_source_fns "VERBOSE_LEVEL=2; offload_message stdout '/nonexistent/$$'" 2>/dev/null)
check "offload_message VERBOSE=2 missing → 0 lines/errors" '0 lines, 0 error(s)' "$result"

# mode=3: tail depth switches from 10 → 20
V3_FILE=$(mktest $'line1\nline2\nline3\n')
result=$(_source_fns "VERBOSE_LEVEL=3; offload_message stdout '$V3_FILE'" 2>/dev/null)
check "offload_message VERBOSE=3 → Last 20 lines" 'Last 20 lines' "$result"

# ---------------------------------------------------------------------------
# _compress_git_status
# ---------------------------------------------------------------------------

# empty input → all counts 0 (|| var=0 fallback)
result=$(_source_fns '_compress_git_status "" 0' 2>/dev/null)
check "_compress_git_status empty → M:0 A:0 D:0 ?:0" 'M:0 A:0 D:0 ?:0' "$result"

# exact counts for all four categories
GIT_OUT=$' M src/foo.ts\nA  new.ts\n D deleted.ts\n?? untracked.txt'
result=$(_source_fns "_compress_git_status '$GIT_OUT' 0" 2>/dev/null)
check "_compress_git_status → M:1 A:1 D:1 ?:1" 'M:1 A:1 D:1 ?:1' "$result"

# MM: staged+unstaged on same file — grep -c counts the line once
result=$(_source_fns '_compress_git_status "MM src/both.ts" 0' 2>/dev/null)
if [[ "$result" =~ M:[1-9] ]]; then pass "_compress_git_status MM → M counted once"
else fail "_compress_git_status MM → expected M>0, got: '$result'"; fi

# mode=1: verbose labels + raw content + head-20 cap
GS1_OUT=$' M src/foo.ts\n?? new.txt'
result=$(_source_fns "_compress_git_status '$GS1_OUT' 1" 2>/dev/null)
check "_compress_git_status mode=1 → Modified: label" 'Modified:'  "$result"
check "_compress_git_status mode=1 → raw content"     'src/foo.ts' "$result"

_TEST_G21=""
for i in $(seq 1 21); do _TEST_G21+=" M file${i}.ts"$'\n'; done
export _TEST_G21
result=$(_source_fns '_compress_git_status "$_TEST_G21" 1' 2>/dev/null)
check        "_compress_git_status mode=1 cap → line 20 present" 'file20' "$result"
check_absent "_compress_git_status mode=1 cap → line 21 absent"  'file21' "$result"
unset _TEST_G21

# mode=2: raw passthrough
result=$(_source_fns "_compress_git_status 'raw git status' 2" 2>/dev/null)
check "_compress_git_status mode=2 → passthrough" 'raw git status' "$result"

# ---------------------------------------------------------------------------
# _compress_build
# ---------------------------------------------------------------------------

# mode=0: no errors → ok status, [x]0 [!]0, duration fallback (?)
result=$(_source_fns "_compress_build 'Build ok' 0" 2>/dev/null)
check_absent "_compress_build no errors → no [x] status" '[x] [x]'  "$result"
check        "_compress_build no errors → [x]0 [!]0"    '[x]0 [!]0' "$result"
check        "_compress_build no duration → (?)"         '(?)'       "$result"

# mode=0: exact error + warning counts, errors>0 flips status to [x]
BUILD_OUT=$'error: could not compile src/main.rs\nwarning: unused variable x\nwarning: deprecated function foo'
result=$(_source_fns "_compress_build '$BUILD_OUT' 0" 2>/dev/null)
check "_compress_build → [x] status + [x]1 [!]2" '[x] [x]1 [!]2' "$result"

# mode=0: case-insensitive ERROR:/WARNING: (grep -ciE flag)
export _TEST_CI=$'ERROR: uppercase error\nWARNING: uppercase warning'
result=$(_source_fns '_compress_build "$_TEST_CI" 0' 2>/dev/null)
check "_compress_build case-insensitive ERROR → [x]1" '[x]1' "$result"
unset _TEST_CI

# mode=0: Rust-style `: error[` pattern
result=$(_source_fns "_compress_build 'src/main.rs: error[E0308]: mismatched types' 0" 2>/dev/null)
check "_compress_build Rust error[ → [x]1" '[x]1' "$result"

# mode=0: duration extracted — s and ms units; multiple durations → tail -1 (last wins)
result=$(_source_fns "_compress_build 'Build finished in 2.3s' 0" 2>/dev/null)
check "_compress_build duration s → (2.3s)" '(2.3s)' "$result"

result=$(_source_fns "_compress_build 'Compiled in 450ms' 0" 2>/dev/null)
check "_compress_build duration ms → (450ms)" '(450ms)' "$result"

export _TEST_MULTIDUR=$'compiled in 1s\nlinked in 2.5s'
result=$(_source_fns '_compress_build "$_TEST_MULTIDUR" 0' 2>/dev/null)
check        "_compress_build multi-duration → last wins (2.5s)" '(2.5s)' "$result"
check_absent "_compress_build multi-duration → first discarded"  '(1s)'   "$result"
unset _TEST_MULTIDUR

# mode=1: Build label, status, counts, surfaced ^error lines, head-5 cap
result=$(_source_fns "_compress_build 'Finished in 0.5s' 1" 2>/dev/null)
check "_compress_build mode=1 no errors → 'Build ok'" 'Build ok' "$result"

BM1_ERR=$'error: undefined reference\nerror: linker failed\nsome other output'
result=$(_source_fns "_compress_build '$BM1_ERR' 1" 2>/dev/null)
check "_compress_build mode=1 → surfaced error line" 'undefined reference' "$result"

export _TEST_B6=$'error: one\nerror: two\nerror: three\nerror: four\nerror: five\nerror: six\nother'
result=$(_source_fns '_compress_build "$_TEST_B6" 1' 2>/dev/null)
check        "_compress_build mode=1 cap → line 5 present" 'five' "$result"
check_absent "_compress_build mode=1 cap → line 6 absent"  'six'  "$result"
unset _TEST_B6

# mode=2: raw passthrough
result=$(_source_fns "_compress_build 'raw build output' 2" 2>/dev/null)
check "_compress_build mode=2 → passthrough" 'raw build output' "$result"

# ---------------------------------------------------------------------------
# _compress_lint
# ---------------------------------------------------------------------------

# empty input → [x]0 [!]0 0F (all three fields default, || files=0 fix)
result=$(_source_fns '_compress_lint "" 0' 2>/dev/null)
check "_compress_lint empty → [x]0 [!]0 0F" '[x]0 [!]0 0F' "$result"

# basic counts + all four file extensions (.ts .tsx .js .jsx .min.js .min.ts)
LINT_OUT=$'src/foo.ts:\nsrc/bar.tsx:\nsrc/app.jsx:\nsrc/comp.min.js:\n4 errors  2 warnings'
result=$(_source_fns "_compress_lint '$LINT_OUT' 0" 2>/dev/null)
check "_compress_lint → [x]4 [!]2 4F" '[x]4 [!]2 4F' "$result"

# awk sums across multiple separate N error tokens (core of paste→awk fix)
# Old `paste -sd+ | bc` on macOS always fell back to 0; awk sums natively
MULTI_LINT=$'src/a.ts:\nsrc/b.tsx:\nsrc/c.js:\n1 error\n2 errors\n1 warning\n2 warnings'
result=$(_source_fns "_compress_lint '$MULTI_LINT' 0" 2>/dev/null)
check "_compress_lint awk sum → [x]3 [!]3 3F accumulated" '[x]3 [!]3 3F' "$result"

# awk large sum (100): verifies multi-digit extraction ([0-9]+ → full number)
result=$(_source_fns '_compress_lint "src/a.ts:
100 errors  50 warnings" 0' 2>/dev/null)
check "_compress_lint large sum → [x]100 [!]50" '[x]100 [!]50' "$result"

# awk zero token: "0 errors" still produces [x]0 cleanly
result=$(_source_fns '_compress_lint "src/a.ts:
0 errors  0 warnings" 0' 2>/dev/null)
check "_compress_lint zero token → [x]0 [!]0 1F" '[x]0 [!]0 1F' "$result"

# files=0 fallback: non-empty input with no .ts/.js paths → || files=0 fires
result=$(_source_fns '_compress_lint "plain text no file paths" 0' 2>/dev/null)
check "_compress_lint no ts paths → 0F" '0F' "$result"

# mode=1: labels, surfaced TS error lines, head-5 cap
# Note: avoid "digit space error" in detail lines (e.g. "10:5 error" → grep -oE '[0-9]+ error' matches "5 error")
# Also avoid extra `.ts:` matches in detail lines (files count uses grep -cE '^[^[:space:]].*\.(ts|js|tsx|jsx):')
LM1_OUT=$'src/foo.ts:\n1 error  0 warnings\nerror TS2304: cannot find name'
result=$(_source_fns "_compress_lint '$LM1_OUT' 1" 2>/dev/null)
check "_compress_lint mode=1 → labels"              '[x]1 errors [!]0 warnings in 1 files' "$result"
check "_compress_lint mode=1 → surfaced TS error"   'cannot find name'                      "$result"

export _TEST_L6=$'src/a.ts:\n6 errors\nerror TS1: one\nerror TS2: two\nerror TS3: three\nerror TS4: four\nerror TS5: five\nerror TS6: six'
result=$(_source_fns '_compress_lint "$_TEST_L6" 1' 2>/dev/null)
check        "_compress_lint mode=1 cap → line 5 present" 'five' "$result"
check_absent "_compress_lint mode=1 cap → line 6 absent"  'six'  "$result"
unset _TEST_L6

# mode=2: raw passthrough
result=$(_source_fns "_compress_lint 'raw lint output' 2" 2>/dev/null)
check "_compress_lint mode=2 → passthrough" 'raw lint output' "$result"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
