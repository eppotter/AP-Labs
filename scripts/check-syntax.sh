#!/usr/bin/env bash
# Syntax-check every tracked JS, shell and JSON file we own. Vendored skills
# (.agents/, _bmad/) are excluded: they are pinned upstream copies.
# A failure to list files fails the check: checking nothing must never pass.
set -euo pipefail
cd "$(dirname "$0")/.."

list() {
  local out
  out=$(git ls-files "$1" ':(exclude).agents' ':(exclude)_bmad') || { # Shellcheck too, so a lint failure shows up before CI. Missing locally is a
# reported skip, never a pass; CI always runs it.
if command -v shellcheck >/dev/null 2>&1; then
  if [ -n "$sh" ]; then
    # shellcheck disable=SC2086
    shellcheck $sh || fail=1
  fi
else
  echo "check-syntax: shellcheck not installed, SKIPPED locally (CI runs it)"
fi

echo "check-syntax: cannot list $1 files" >&2; exit 2; }
  printf '%s' "$out"
}

js=$(list '*.js')
sh=$(list '*.sh')
json=$(list '*.json')
[ -n "$js" ] || { echo "check-syntax: no JS files found; refusing to pass" >&2; exit 2; }

fail=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  node --check "$f" || fail=1
done <<< "$js"

while IFS= read -r f; do
  [ -n "$f" ] || continue
  bash -n "$f" || fail=1
done <<< "$sh"

while IFS= read -r f; do
  [ -n "$f" ] || continue
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" || { echo "bad JSON: $f"; fail=1; }
done <<< "$json"

echo "check-syntax: $(wc -l <<< "$js" | tr -d ' ') js, $(wc -l <<< "$sh" | tr -d ' ') sh, $(wc -l <<< "$json" | tr -d ' ') json checked"
exit "$fail"
