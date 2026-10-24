#!/usr/bin/env bash
# Stub Claude reviewer for the review CLI tests. Never calls a model.
#   FAKE_CLAUDE_VERDICT file whose text is printed (unset: print nothing)
#   FAKE_CLAUDE_EXIT    exit code (default 0)
#   FAKE_CLAUDE_RECORD  dir: NUL-delimited args.txt and stdin.txt
set -euo pipefail

if [ -n "${FAKE_CLAUDE_RECORD:-}" ]; then
  printf '%s\0' "$@" > "$FAKE_CLAUDE_RECORD/args.txt"
  cat > "$FAKE_CLAUDE_RECORD/stdin.txt"
else
  cat >/dev/null
fi

if [ -n "${FAKE_CLAUDE_VERDICT:-}" ]; then cat "$FAKE_CLAUDE_VERDICT"; fi
exit "${FAKE_CLAUDE_EXIT:-0}"
