'use strict';

// The commit a session started on (Story 3.2). The SessionStart hook records
// HEAD in <git-dir>/aplabs/session/<session_id>.head; the Stop hook compares
// against it to tell whether the session committed anything. Inside .git, so
// never tracked; in a linked worktree <git-dir> is that worktree's own.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Session ids come from hook input: untrusted, so only a plain file name.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// One git call, stdout trimmed; null on any failure (not a repo, no git).
function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function headFile(gitDir, sessionId) {
  if (!gitDir || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  return path.join(gitDir, 'aplabs', 'session', `${sessionId}.head`);
}

// Records the current HEAD for `sessionId`. Returns the file written, or null
// when there is nothing to record (not a git repo, no commit yet, bad id).
// Never throws: the banner must not depend on it.
function recordSessionHead(startDir, sessionId) {
  try {
    const gitDir = git(startDir, ['rev-parse', '--absolute-git-dir']);
    const file = headFile(gitDir, sessionId);
    const head = file && git(startDir, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (!head) return null;
    // A resumed session keeps the HEAD it first started on.
    if (fs.existsSync(file)) return file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${head}\n`);
    return file;
  } catch {
    return null;
  }
}

// The recorded HEAD for `sessionId`, or null when none was recorded.
function readSessionHead(gitDir, sessionId) {
  const file = headFile(gitDir, sessionId);
  if (!file) return null;
  try {
    const head = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

module.exports = { SESSION_ID, git, headFile, recordSessionHead, readSessionHead };
