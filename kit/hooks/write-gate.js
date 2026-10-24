'use strict';

// Write gate hook entry (Story 2.4), called by kit/hooks/write-gate.sh. One
// entry for two events, picked by the hook input's hook_event_name:
//   SubagentStart (Claude Code): writes the session-keyed engagement marker.
//   PreToolUse (Claude Code and Codex): allows or denies an edit tool call.
// All logic is in kit/lib/gate. Tripwire, not a control: see the threat model
// there and in kit/hooks/README.md.
//
// Output contract:
//   allow          → exit 0, no output (both harnesses)
//   deny, Claude   → exit 0, stdout {hookSpecificOutput.permissionDecision: "deny", …}
//   deny, Codex    → exit 2, reason on stdout; the wrapper moves it to stderr
//                    (Codex's "exit 2 + reason on stderr" block, as in CanonCRM's guard)
//
// Start directory: CLAUDE_PROJECT_DIR (Claude Code), else the `cwd` field of
// the hook input (Codex), else the process cwd.

const fs = require('fs');
const { decide, markSubagent } = require('../lib/gate');

function hookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const harness = process.argv.includes('--harness') ? process.argv[process.argv.indexOf('--harness') + 1] : 'claude';
const input = hookInput();
const startDir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' && input.cwd) || process.cwd();

if (input.hook_event_name === 'SubagentStart') {
  markSubagent(input, startDir);
} else {
  const r = decide(input, startDir);
  if (r.decision === 'deny') {
    if (harness === 'codex') {
      process.stdout.write(`${r.reason}\n`);
      process.exitCode = 2;
    } else {
      process.stdout.write(`${JSON.stringify({
        systemMessage: 'AP Labs write gate: edit blocked until the work is routed (see the reason given to the model).',
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason },
      })}\n`);
    }
  }
}
