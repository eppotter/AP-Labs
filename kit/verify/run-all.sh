#!/usr/bin/env bash
# Run every registered verification check. No checks are registered yet, so
# report that as skipped rather than passed (PR-04).
set -euo pipefail

checks_dir="$(cd "$(dirname "$0")" && pwd)/checks"
shopt -s nullglob
checks=("$checks_dir"/*.sh)

if [ "${#checks[@]}" -eq 0 ]; then
  echo "verify: SKIPPED (0 checks registered)"
  exit 0
fi

fail=0
for c in "${checks[@]}"; do
  if bash "$c"; then echo "PASS $(basename "$c")"; else echo "FAIL $(basename "$c")"; fail=1; fi
done
exit "$fail"
