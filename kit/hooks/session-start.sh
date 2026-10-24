#!/usr/bin/env bash
# SessionStart hook for Claude Code and Codex: runs kit/hooks/session-start.js
# with the hook input on stdin and passes its stdout through.
#
# Fails open: a missing node or a failing script exits 0 with one stderr note
# and no stdout, so the session always starts. Node's stdout is buffered and
# printed only on success, so a crash can never leave half a JSON payload.
#
# APLABS_SESSION_START_JS (tests only) replaces the Node entry, so tests can
# point the wrapper at a script that throws.

dir="${BASH_SOURCE[0]%/*}"
[ "$dir" = "${BASH_SOURCE[0]}" ] && dir=.
script="${APLABS_SESSION_START_JS:-$dir/session-start.js}"

note() { printf 'aplabs-hooks: %s\n' "$*" >&2; }

command -v node >/dev/null 2>&1 || { note "node not found on PATH, session-start skipped"; exit 0; }

if out="$(node "$script" 2>/dev/null)"; then
  [ -n "$out" ] && printf '%s\n' "$out"
else
  note "session-start failed, Orchestrator banner not shown"
fi
exit 0
