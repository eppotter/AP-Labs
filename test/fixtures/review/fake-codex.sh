#!/usr/bin/env bash
# Stub reviewer for the review CLI tests. Never calls a model.
#   FAKE_CODEX_VERDICT  file whose text is written to the -o path (unset: write nothing)
#   FAKE_CODEX_EXIT     exit code (default 0)
#   FAKE_CODEX_RECORD   dir: args.txt (one arg per line, prompt last), stdin.txt
set -euo pipefail

out=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = "-o" ]; then out="${args[i + 1]}"; fi
done

if [ -n "${FAKE_CODEX_RECORD:-}" ]; then
  printf '%s\n' "$@" > "$FAKE_CODEX_RECORD/args.txt"
  if IFS= read -r _; then echo open; else echo closed; fi > "$FAKE_CODEX_RECORD/stdin.txt"
fi

echo "fake codex chatter that must stay in the log"
if [ -n "${FAKE_CODEX_VERDICT:-}" ] && [ -n "$out" ]; then cat "$FAKE_CODEX_VERDICT" > "$out"; fi
exit "${FAKE_CODEX_EXIT:-0}"
