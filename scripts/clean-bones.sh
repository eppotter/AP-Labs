#!/usr/bin/env bash
# Clean bones (Story 6.5): proves the template stands alone without its example
# client. Copies the repo (tracked and untracked, not ignored, files) into a
# temp dir, deletes examples/brightside/ and profiles/brightside/, makes the
# copy a git repo (the checks list files with git), then runs npm run check,
# npm test, npm run test:slow and the boot smoke test against a minimal stub
# profile. Any failure
# fails the script. node_modules is a symlink to this repo's (run npm ci first).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$ROOT/node_modules" ] || { echo "clean-bones: run npm ci first" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/aplabs-clean-bones-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

(cd "$ROOT" && git ls-files -z --cached --others --exclude-standard) \
  | (cd "$ROOT" && xargs -0 tar -cf - --) \
  | (cd "$WORK" && tar -xf -)
rm -rf "$WORK/examples/brightside" "$WORK/profiles/brightside"
[ ! -e "$WORK/examples/brightside" ] && [ ! -e "$WORK/profiles/brightside" ]

cd "$WORK"
git init -q
git add -A
git -c user.name=clean-bones -c user.email=clean-bones@example.invalid commit -q -m "clean bones copy"
# After the commit, so the symlink is never tracked.
ln -s "$ROOT/node_modules" node_modules

echo "clean-bones: copy at $WORK without examples/brightside and profiles/brightside"
npm run --silent check
npm test
# The slow tests skip in npm test; run them here too (plan ci-split).
npm run test:slow
node scripts/boot-smoke.js
echo "clean-bones: ok (the template stands alone without the example client)"
