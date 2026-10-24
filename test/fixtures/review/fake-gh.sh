#!/usr/bin/env bash
# Stub gh for the review CLI tests. Never touches the network.
# State lives in $FAKE_GH_DIR:
#   pr.json     the PR `gh pr view --json ...` prints; absent means "no PR"
#   calls.txt   every invocation, one per line
#   edit-fails  if present, `gh pr edit` exits 1
# `gh pr edit <n> --body-file <f>` copies <f> to body-<n>.md and into pr.json,
# so the next round sees the updated body.
set -euo pipefail

dir="${FAKE_GH_DIR:?FAKE_GH_DIR not set}"
echo "$*" >> "$dir/calls.txt"

case "${1:-} ${2:-}" in
  "pr view")
    if [ ! -f "$dir/pr.json" ]; then echo "no pull requests found for branch" >&2; exit 1; fi
    cat "$dir/pr.json"
    ;;
  "pr edit")
    if [ -f "$dir/edit-fails" ]; then echo "edit failed" >&2; exit 1; fi
    [ "${4:-}" = "--body-file" ] || { echo "fake gh: expected --body-file" >&2; exit 64; }
    cp "$5" "$dir/body-$3.md"
    node -e 'const fs = require("fs"); const p = process.argv[1]; const pr = JSON.parse(fs.readFileSync(p, "utf8"));
pr.body = fs.readFileSync(process.argv[2], "utf8"); fs.writeFileSync(p, JSON.stringify(pr));' "$dir/pr.json" "$5"
    ;;
  *)
    echo "fake gh: unexpected call: $*" >&2
    exit 64
    ;;
esac
