#!/usr/bin/env bash
# Stub gh for the review CLI tests. Never touches the network.
# State lives in $FAKE_GH_DIR:
#   pr.json             the PR `gh pr view --json ...` prints; absent means "no PR"
#   calls.txt           every invocation, one per line
#   edit-fails          if present, `gh pr edit` exits 1
#   labels.json         what `gh label list --json name` prints (absent: [])
#   label-exists-error  if present, `gh label create` fails with "already exists"
#   label-create-fails  if present, `gh label create` fails with another error
#   issue-create-fails  if present, `gh issue create` exits 1
#   comment-fails       if present, `gh issue comment` exits 1
# `gh pr edit <n> --body-file <f>` copies <f> to body-<n>.md and into pr.json,
# so the next round sees the updated body. `gh issue create` numbers issues
# from 42, saves the body to issue-<n>.md and the args to issue-<n>.args, and
# prints the issue URL. `gh issue comment <n> --body-file <f>` appends <f> to
# issue-<n>.comments.md.
set -euo pipefail

dir="${FAKE_GH_DIR:?FAKE_GH_DIR not set}"
echo "$*" >> "$dir/calls.txt"

# The value after flag $1 in the remaining args.
flag() {
  local want="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$want" ]; then
      echo "${2:-}"
      return
    fi
    shift
  done
}

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
  "label list")
    if [ -f "$dir/labels.json" ]; then cat "$dir/labels.json"; else echo "[]"; fi
    ;;
  "label create")
    if [ -f "$dir/label-exists-error" ]; then echo "label with name \"$3\" already exists; use \`--force\` to update" >&2; exit 1; fi
    if [ -f "$dir/label-create-fails" ]; then echo "HTTP 403: forbidden" >&2; exit 1; fi
    echo "[{\"name\":\"$3\"}]" > "$dir/labels.json"
    ;;
  "issue create")
    if [ -f "$dir/issue-create-fails" ]; then echo "issue create failed" >&2; exit 1; fi
    n=42
    while [ -f "$dir/issue-$n.md" ]; do n=$((n + 1)); done
    cp "$(flag --body-file "$@")" "$dir/issue-$n.md"
    printf '%s\n' "$@" > "$dir/issue-$n.args"
    echo "https://github.com/example/repo/issues/$n"
    ;;
  "issue comment")
    if [ -f "$dir/comment-fails" ]; then echo "comment failed" >&2; exit 1; fi
    cat "$(flag --body-file "$@")" >> "$dir/issue-$3.comments.md"
    ;;
  *)
    echo "fake gh: unexpected call: $*" >&2
    exit 64
    ;;
esac
