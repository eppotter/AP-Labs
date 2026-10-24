#!/usr/bin/env bash
# Stub gh for the retro CLI tests. Never touches the network.
#   FAKE_RETRO_PRS    JSON file holding an array of PRs in gh's --json shape
#   FAKE_RETRO_CALLS  if set, every invocation is appended to this file
#   FAKE_RETRO_FAIL   if set, every call fails with this message on stderr
#   FAKE_RETRO_RAW    if set, every call prints this text instead of JSON
# `gh pr list ...` prints the whole array; `gh pr view <n> ...` prints PR <n>,
# or fails like gh does when there is no such PR.
set -euo pipefail

if [ -n "${FAKE_RETRO_CALLS:-}" ]; then echo "$*" >> "$FAKE_RETRO_CALLS"; fi
if [ -n "${FAKE_RETRO_FAIL:-}" ]; then echo "$FAKE_RETRO_FAIL" >&2; exit 1; fi
if [ -n "${FAKE_RETRO_RAW:-}" ]; then echo "$FAKE_RETRO_RAW"; exit 0; fi
prs="${FAKE_RETRO_PRS:?FAKE_RETRO_PRS not set}"

case "${1:-} ${2:-}" in
  "pr list")
    cat "$prs"
    ;;
  "pr view")
    node -e 'const prs = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const pr = prs.find((p) => String(p.number) === process.argv[2]);
if (!pr) { console.error(`GraphQL: Could not resolve to a PullRequest with the number of ${process.argv[2]}.`); process.exit(1); }
console.log(JSON.stringify(pr));' "$prs" "${3:-}"
    ;;
  *)
    echo "fake gh: unexpected call: $*" >&2
    exit 64
    ;;
esac
