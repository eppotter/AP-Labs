'use strict';

// The last verify result (issue #45): `npm run verify` and the Stop hook
// record each run's per-check outcomes in <git-dir>/aplabs/verify/last.json,
// so the session banner can flag a known truth whose last check failed
// without running anything at session start. Inside .git, so never tracked;
// in a linked worktree <git-dir> is that worktree's own.
//
//   { at, head, source: "verify" | "stop-hook", results: [{ id, outcome }] }
//
// Best effort both ways: writing never throws (a run must not fail because
// the record could not be written), and a missing, malformed or old record
// reads as null.

const fs = require('fs');
const path = require('path');
const { git } = require('../session/head');

// A record older than this is ignored: the banner should not keep flagging a
// failure nobody has re-checked in a week.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OUTCOMES = new Set(['pass', 'fail', 'skip', 'timeout']);

const lastFile = (gitDir) => path.join(gitDir, 'aplabs', 'verify', 'last.json');

// The absolute git dir for `dir`, or null outside a git repo.
const gitDirOf = (dir) => git(dir, ['rev-parse', '--absolute-git-dir']);

// Writes the record for a run in the repo at `cwd`. `results` are the
// runner's results ({ id, outcome, ... }). Returns the file, or null when
// there is no git dir or the write failed.
function writeLastResult(cwd, results, source, now = Date.now()) {
  try {
    const gitDir = gitDirOf(cwd);
    if (!gitDir) return null;
    const record = {
      at: new Date(now).toISOString(),
      head: git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
      source,
      results: results.map((r) => ({ id: r.id, outcome: r.outcome })),
    };
    const file = lastFile(gitDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    return file;
  } catch {
    return null;
  }
}

// The record in `gitDir`, or null when missing, malformed, stamped in the
// future or older than MAX_AGE_MS. Results with a bad shape are dropped.
function readLastResult(gitDir, now = Date.now()) {
  if (!gitDir) return null;
  let v;
  try {
    v = JSON.parse(fs.readFileSync(lastFile(gitDir), 'utf8'));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || !Array.isArray(v.results)) return null;
  const at = typeof v.at === 'string' ? Date.parse(v.at) : NaN;
  if (!Number.isFinite(at) || now - at > MAX_AGE_MS || at - now > 60 * 1000) return null;
  const results = v.results.filter((r) => r && typeof r.id === 'string' && OUTCOMES.has(r.outcome));
  return { at: v.at, head: typeof v.head === 'string' ? v.head : null, source: v.source, results };
}

module.exports = { MAX_AGE_MS, lastFile, gitDirOf, writeLastResult, readLastResult };
