'use strict';

// SessionStart hook entry (Story 2.1), called by kit/hooks/session-start.sh.
// Prints the banner JSON for a governed repo, nothing otherwise. All logic is
// in kit/lib/session.
//
// Start directory: CLAUDE_PROJECT_DIR (Claude Code), else the `cwd` field of
// the hook input on stdin (Codex), else the process cwd.
//
// In a governed repo it also records the session's starting HEAD for the Stop
// hook (kit/lib/session/head.js). That never prints and never throws.

const fs = require('fs');
const { sessionStart } = require('../lib/session');
const { recordSessionHead } = require('../lib/session/head');

function hookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const input = hookInput();
const startDir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' && input.cwd) || process.cwd();
const out = sessionStart(startDir);
if (out) {
  recordSessionHead(startDir, input.session_id);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
