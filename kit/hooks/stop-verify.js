'use strict';

// Stop hook entry (Story 3.2), called by kit/hooks/stop-verify.sh. Prints the
// hook output JSON, or nothing. All logic is in kit/lib/stop-verify.
//
// Start directory: CLAUDE_PROJECT_DIR, else the `cwd` field of the hook
// input, else the process cwd. An internal error fails open: a one-line
// systemMessage, exit 0, the turn ends normally.

const fs = require('fs');
const { stopVerify } = require('../lib/stop-verify');
const { installSignalCleanup } = require('../lib/verify/runner');

function hookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function main() {
  installSignalCleanup();
  const input = hookInput();
  const startDir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' && input.cwd) || process.cwd();
  let out;
  try {
    out = await stopVerify(input, { startDir });
  } catch (err) {
    out = { systemMessage: `AP Labs verify hook error (did not block): ${String(err && err.message).split('\n')[0]}` };
  }
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

main();
