'use strict';

// `npm run engage -- --reason "<story or task>"` (Story 2.4): opens the write
// gate in this worktree for the profile's gate.engagement_ttl_minutes by
// writing <git-dir>/aplabs/engaged/worktree, and appends a line (time, reason,
// git user name, branch) to <git-dir>/aplabs/gate.log.
//
// Story 2.5 flags, all recorded on the marker and the log line:
//   --plan <slug>           the approved plan this work belongs to (T2/T3 and
//                           onboarding edits need its `approve plan <slug>`)
//   --kind onboarding       an onboarding build: approval needed at any tier
//                           (default kind: build)
//   --plan-reviewed <path>  copy the bmad-review output (a file in this repo)
//                           to <git-common-dir>/aplabs/plan-reviews/<slug>.md
//                           plus the <slug>.json record the gate reads (slug,
//                           time, source); needs --plan. T3 edits need a
//                           record from the current plan engagement.
//
// It exists because AP Labs builders run as separate delegated sessions where
// SubagentStart never fires. It is model-runnable by design: the gate is a
// logged tripwire, not a control. Exit 0 ok (or nothing to do), 2 usage, 1 error.

const { engage, EngageError } = require('../lib/gate');

// Value of --name or --name=value, undefined when absent ('' when given empty).
function arg(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1] || '';
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}

try {
  const argv = process.argv.slice(2);
  const r = engage(process.cwd(), arg(argv, 'reason') || '', Date.now(), {
    plan: arg(argv, 'plan'), kind: arg(argv, 'kind'), planReviewed: arg(argv, 'plan-reviewed'),
  });
  if (!r.governed) {
    process.stdout.write('engage: this repo is not governed (no .aplabs/profile.yml), the write gate does not apply here.\n');
  } else {
    process.stdout.write(`engage: write gate open in this worktree for ${r.ttl} minutes. Logged to ${r.log}.\n`);
    if (r.plan) process.stdout.write(`engage: plan ${r.plan} (${r.kind})${r.approved ? ', approval on record' : ', no approval recorded yet: T2/T3 edits stay blocked until the human types `approve plan ' + r.plan + '`'}.\n`);
    if (r.review) process.stdout.write(`engage: plan review recorded at ${r.review}.\n`);
    if (r.invalid) process.stdout.write('engage: note the profile is invalid, so edits stay blocked until it is fixed.\n');
  }
} catch (err) {
  process.stderr.write(`engage: ${err.message}\n`);
  process.exitCode = err instanceof EngageError ? 2 : 1;
}
