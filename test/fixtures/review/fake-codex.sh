#!/usr/bin/env bash
# Stub reviewer for the review CLI tests. Never calls a model.
#   FAKE_CODEX_VERDICT  file whose text is written to the -o path (unset: write nothing)
#   FAKE_CODEX_EXIT     exit code (default 0)
#   FAKE_CODEX_RETRY_VERDICT  file written instead when the prompt carries the
#                       VERDICT reminder (the CLI's one retry); unset: as above
#   FAKE_CODEX_RECORD   dir: args.txt (one arg per line, prompt last), stdin.txt;
#                       a reminded run also writes retry-args.txt
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

verdict="${FAKE_CODEX_VERDICT:-}"
prompt="${args[${#args[@]}-1]:-}"
if [[ "$prompt" == *"End with exactly one VERDICT line"* ]]; then
  if [ -n "${FAKE_CODEX_RECORD:-}" ]; then printf '%s\n' "$@" > "$FAKE_CODEX_RECORD/retry-args.txt"; fi
  verdict="${FAKE_CODEX_RETRY_VERDICT:-$verdict}"
fi

echo "fake codex chatter that must stay in the log"
if [ -n "$verdict" ] && [ -n "$out" ]; then cat "$verdict" > "$out"; fi
exit "${FAKE_CODEX_EXIT:-0}"
