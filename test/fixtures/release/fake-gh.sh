#!/usr/bin/env bash
# Stub gh for the template release tests (Story 11.5). Never touches the network.
# State lives in $FAKE_GH_DIR:
#   check-runs.json  what `gh api repos/.../commits/<sha>/check-runs` prints
#   gh-exit          if present and not 0, that call fails with this exit code
#   gh-calls.txt     every invocation, one per line
set -euo pipefail

dir="${FAKE_GH_DIR:?FAKE_GH_DIR not set}"
echo "$*" >> "$dir/gh-calls.txt"

if [ "${1:-}" = "api" ] && [[ "${2:-}" == */check-runs* ]]; then
  code="$(cat "$dir/gh-exit" 2>/dev/null || echo 0)"
  if [ "$code" != "0" ]; then
    echo "HTTP 404: Not Found" >&2
    exit "$code"
  fi
  cat "$dir/check-runs.json"
  exit 0
fi
echo "fake gh: unexpected call: $*" >&2
exit 64
