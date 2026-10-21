#!/usr/bin/env bash
# Run the browser acceptance specs one at a time against a running Console.
#
# The sandbox's headless shell is a single process, so a run that drives many
# pages at once drops its client-side navigations. One spec invocation per
# test keeps each measurement on its own.
set -uo pipefail

cd "$(dirname "$0")"

CONFIG=playwright.sandbox.config.ts
FILTER="${1:-}"

titles=$(pnpm exec playwright test --config "$CONFIG" --list 2>/dev/null \
  | grep -E '\.spec\.ts:' \
  | grep -v 'playtesting-usability' \
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
    echo "$output" | tail -25
    failures=$((failures + 1))
  fi
done <<< "$titles"

echo "---"
echo "failed: $failures"
exit $((failures > 0))
