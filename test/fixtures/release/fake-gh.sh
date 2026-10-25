#!/usr/bin/env bash
# Stub gh for the template release and update tests (Stories 11.5, 11.6).
# Never touches the network.
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
# `gh pr create ... --body-file <file>` (template:update, Story 11.6): keeps the
# body in pr-body.md and prints a PR URL. pr-exit, if not 0, fails it.
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "create" ]; then
  code="$(cat "$dir/pr-exit" 2>/dev/null || echo 0)"
  if [ "$code" != "0" ]; then
    echo "fake gh: pr create failed" >&2
    exit "$code"
  fi
  shift 2
  while [ $# -gt 0 ]; do
    if [ "$1" = "--body-file" ]; then cp "$2" "$dir/pr-body.md"; shift; fi
    shift
  done
  echo "https://github.invalid/fork/pull/1"
  exit 0
fi
echo "fake gh: unexpected call: $*" >&2
exit 64
