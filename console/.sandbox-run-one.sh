#!/usr/bin/env bash
# Run each test of a spec file in its own Playwright invocation.
#
# The sandbox's headless shell is a single process, so a run that drives many
# pages at once drops its client-side navigations. One invocation per test
# keeps each measurement on its own.
set -uo pipefail
cd "$(dirname "$0")"
CONFIG=playwright.sandbox.config.ts
SPEC="${1:?spec file}"
FILTER="${2:-}"

titles=$(pnpm exec playwright test --config "$CONFIG" --list 2>/dev/null \
  | grep -E '\.spec\.ts:' \
  | grep -F "$SPEC" \
  | sed -E 's/^.*› //')

failures=0
while IFS= read -r title; do
  [ -z "$title" ] && continue
  if [ -n "$FILTER" ] && [[ "$title" != *"$FILTER"* ]]; then
    continue
  fi
  output=$(pnpm exec playwright test --config "$CONFIG" --grep "$title" 2>&1)
  if [[ "$output" == *"Running 1 test"* ]] && [[ "$output" == *"1 passed"* ]]; then
    echo "PASS  $title"
  else
    echo "FAIL  $title"
    echo "$output" | grep -E "Error|expect|✘|✖" | head -8
    failures=$((failures + 1))
  fi
done <<< "$titles"

echo "---"
echo "failed: $failures"
exit $((failures > 0))
