'use strict';

// `npm run engage -- --reason "<story or task>"` (Story 2.4): opens the write
// gate in this worktree for the profile's gate.engagement_ttl_minutes by
// writing <git-dir>/aplabs/engaged/worktree, and appends a line (time, reason,
// git user name, branch) to <git-dir>/aplabs/gate.log.
//
// It exists because AP Labs builders run as separate delegated sessions where
// SubagentStart never fires. It is model-runnable by design: the gate is a
// logged tripwire, not a control. Exit 0 ok (or nothing to do), 2 usage, 1 error.

const { engage, EngageError } = require('../lib/gate');

function reasonArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reason') return argv[i + 1] || '';
    if (argv[i].startsWith('--reason=')) return argv[i].slice('--reason='.length);
  }
  return '';
}

try {
  const r = engage(process.cwd(), reasonArg(process.argv.slice(2)));
  if (!r.governed) {
    process.stdout.write('engage: this repo is not governed (no .aplabs/profile.yml), the write gate does not apply here.\n');
  } else {
    process.stdout.write(`engage: write gate open in this worktree for ${r.ttl} minutes. Logged to ${r.log}.\n`);
    if (r.invalid) process.stdout.write('engage: note the profile is invalid, so edits stay blocked until it is fixed.\n');
  }
} catch (err) {
  process.stderr.write(`engage: ${err.message}\n`);
  process.exitCode = err instanceof EngageError ? 2 : 1;
}
