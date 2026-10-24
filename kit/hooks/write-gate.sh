#!/usr/bin/env bash
# Write gate hook (PreToolUse on edit tools, and SubagentStart) for Claude Code
# and Codex: runs kit/hooks/write-gate.js with the hook input on stdin.
#
# THREAT MODEL: a tripwire against the accidental case (writing code before
# the work is routed), not a hard security control. It fails open on any
# internal error. The hard controls stay server-side: review, CI, merge gating.
#
# Usage: write-gate.sh [--harness claude|codex]   (default claude)
#
# Node's exit code decides what the harness sees:
#   0      allow, or a Claude Code deny as JSON: stdout passed through, exit 0
#   2      a Codex deny: Node's stdout (the reason) goes to stderr, exit 2
#   other  a crash or missing dependency: fail open, exit 0, one stderr note
# Node's stdout is buffered and printed only on 0 or 2, so a crash can never
# leave half a JSON payload.
#
# APLABS_WRITE_GATE_JS (tests only) replaces the Node entry, so tests can
# point the wrapper at a broken script and prove fail-open.

dir="${BASH_SOURCE[0]%/*}"
[ "$dir" = "${BASH_SOURCE[0]}" ] && dir=.
script="${APLABS_WRITE_GATE_JS:-$dir/write-gate.js}"

note() { printf 'aplabs-hooks: %s\n' "$*" >&2; }

command -v node >/dev/null 2>&1 || { note "node not found on PATH, write gate skipped (edit allowed)"; exit 0; }

out="$(node "$script" "$@" 2>/dev/null)"
rc=$?
case "$rc" in
  0) [ -n "$out" ] && printf '%s\n' "$out"; exit 0 ;;
  2) printf '%s\n' "$out" >&2; exit 2 ;;
  *) note "write gate failed (exit $rc), edit allowed"; exit 0 ;;
esac
