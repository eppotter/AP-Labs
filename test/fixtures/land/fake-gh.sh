#!/usr/bin/env bash
# Stub gh for the land CLI tests. Never touches the network.
# State lives in $FAKE_GH_DIR:
#   pr.json          what every `gh pr view` prints (the CLI picks its fields)
#   pr-2.json        if present, printed instead from the second `pr view` on
#   checks.json      what `gh pr checks` prints; checks-<k>.json, if present,
#                    is printed instead on the k-th call
#   no-checks        if present, `gh pr checks` fails like gh with no checks
#   checks-exit      exit code for `gh pr checks` after printing (default 0)
#   merge-fails      if present, `gh pr merge` exits 1 and changes nothing
#   merge-noop       if present, `gh pr merge` exits 0 but changes nothing
#   ready-fails      if present, `gh pr ready` exits 1
#   calls.txt        every invocation, one per line
# `gh pr ready` sets isDraft false and `gh pr merge` sets state MERGED in every
# pr*.json.
set -euo pipefail

dir="${FAKE_GH_DIR:?FAKE_GH_DIR not set}"
echo "$*" >> "$dir/calls.txt"

# Sets field $1 to JSON value $2 in every pr*.json.
set_field() {
  local f
  for f in "$dir"/pr*.json; do
    node -e 'const fs = require("fs"); const p = process.argv[1]; const pr = JSON.parse(fs.readFileSync(p, "utf8"));
pr[process.argv[2]] = JSON.parse(process.argv[3]); fs.writeFileSync(p, JSON.stringify(pr));' "$f" "$1" "$2"
  done
}

# How many times call kind $1 has run, this one included.
count() {
  local n
  n=$(( $(cat "$dir/count-$1" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$dir/count-$1"
  echo "$n"
}

case "${1:-} ${2:-}" in
  "pr view")
    n=$(count view)
    if [ "$n" -ge 2 ] && [ -f "$dir/pr-2.json" ]; then cat "$dir/pr-2.json"; else cat "$dir/pr.json"; fi
    ;;
  "pr checks")
    n=$(count checks)
    if [ -f "$dir/no-checks" ]; then echo "no checks reported on the 'feat/x' branch" >&2; exit 1; fi
    if [ -f "$dir/checks-$n.json" ]; then cat "$dir/checks-$n.json"; else cat "$dir/checks.json"; fi
    exit "$(cat "$dir/checks-exit" 2>/dev/null || echo 0)"
    ;;
  "pr ready")
    if [ -f "$dir/ready-fails" ]; then echo "ready failed" >&2; exit 1; fi
    set_field isDraft false
    ;;
  "pr merge")
    if [ -f "$dir/merge-fails" ]; then echo "Pull request is not mergeable" >&2; exit 1; fi
    if [ ! -f "$dir/merge-noop" ]; then set_field state '"MERGED"'; fi
    ;;
  *)
    echo "fake gh: unexpected call: $*" >&2
    exit 64
    ;;
esac
