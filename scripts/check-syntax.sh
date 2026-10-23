#!/usr/bin/env bash
# Syntax-check every tracked JS and shell file. Fails on the first bad file.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
while IFS= read -r f; do
  node --check "$f" || fail=1
done < <(git ls-files '*.js')

while IFS= read -r f; do
  bash -n "$f" || fail=1
done < <(git ls-files '*.sh')

while IFS= read -r f; do
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" || { echo "bad JSON: $f"; fail=1; }
done < <(git ls-files '*.json')

exit "$fail"
