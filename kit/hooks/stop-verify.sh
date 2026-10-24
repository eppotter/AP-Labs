#!/usr/bin/env bash
# Stop hook for Claude Code: runs kit/hooks/stop-verify.js with the hook input
# on stdin and passes its stdout through (a block decision, a report, or
# nothing).
#
# Fails open: a missing node or a failing script exits 0 with one stderr note
# and no stdout, so a broken hook never traps a turn. Node's stdout is
# buffered and printed only on success, so a crash can never leave half a
# JSON payload.
#
# APLABS_STOP_VERIFY_JS (tests only) replaces the Node entry, so tests can
# point the wrapper at a script that throws.

dir="${BASH_SOURCE[0]%/*}"
[ "$dir" = "${BASH_SOURCE[0]}" ] && dir=.
script="${APLABS_STOP_VERIFY_JS:-$dir/stop-verify.js}"

note() { printf 'aplabs-hooks: %s\n' "$*" >&2; }

command -v node >/dev/null 2>&1 || { note "node not found on PATH, stop-verify skipped"; exit 0; }

if out="$(node "$script" 2>/dev/null)"; then
  [ -n "$out" ] && printf '%s\n' "$out"
else
  note "stop-verify failed, checks not run"
fi
exit 0
