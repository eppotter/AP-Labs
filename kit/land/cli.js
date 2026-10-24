'use strict';

// Merge a PR only when it is verified (Story 1.5):
//
//   npm run land -- <pr-number> [--notify "<message>"] [--timeout-min N]
//
// Refuses, with no merge, unless the PR is open against main, its body has a
// Kind line, the reviewed head is the PR head (or review was exempt), the
// Refuter line shows nothing confirmed, escalated or pending, and every CI
// check on the head passed. Pending checks are polled until --timeout-min
// (default 15). Then a draft is marked ready, the PR is merged with a merge
// commit pinned to the checked head, the MERGED state is confirmed with gh, the
// remote head branch is deleted and, with --notify, Slack is told.
//
// Exit codes: 0 merged, 1 refused or failed, 2 usage. Never --admin, --auto,
// --squash or --rebase. The gh binary can be overridden (APLABS_GH_BIN) and
// deps lets tests inject the clock, sleep, notify and output streams.

const { spawnSync } = require('node:child_process');
const {
  POLL_MS,
  USAGE,
  PR_FIELDS,
  parseArgs,
  prRefusals,
  isPending,
  checksRefusal,
  alreadyDeleted,
} = require('../lib/land');

async function main(argv, env = process.env, deps = {}) {
  const out = deps.out || ((s) => console.log(s));
  const err = deps.err || ((s) => console.error(s));
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = deps.pollMs ?? POLL_MS;
  const cwd = deps.cwd || process.cwd();
  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.error) {
    err(`${args.error}\n${USAGE}`);
    return 2;
  }
  const { pr: n, notify, timeoutMin } = args;
  const ghBin = env.APLABS_GH_BIN || 'gh';
  const run = (cmd, cmdArgs) => {
    const r = spawnSync(cmd, cmdArgs, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: !r.error && r.status === 0, stdout: r.stdout || '', stderr: r.error ? r.error.message : (r.stderr || '').trim() };
  };
  const gh = (...a) => run(ghBin, a);
  const refuse = (reasons) => {
    err(`Refusing to land PR #${n}:\n${reasons.map((r) => `- ${r}`).join('\n')}`);
    return 1;
  };
  const view = () => {
    const r = gh('pr', 'view', String(n), '--json', PR_FIELDS);
    if (!r.ok) return { error: `gh pr view failed: ${r.stderr || 'no output'}` };
    try {
      return { pr: JSON.parse(r.stdout) };
    } catch {
      return { error: 'gh pr view printed something that is not JSON.' };
    }
  };

  const first = view();
  if (first.error) return refuse([first.error]);
  const reasons = prRefusals(first.pr);
  if (reasons.length) return refuse(reasons);
  const head = first.pr.headRefOid;

  // gh exits non-zero while checks are pending or failing and when there are
  // none, so the JSON on stdout is read whatever the exit code.
  const deadline = now() + timeoutMin * 60000;
  let checks;
  for (;;) {
    const r = gh('pr', 'checks', String(n), '--json', 'name,state,bucket');
    try {
      checks = JSON.parse(r.stdout);
      if (!Array.isArray(checks)) throw new Error('not a list');
    } catch {
      if (/no checks reported/i.test(r.stderr)) checks = [];
      else return refuse([`gh pr checks failed: ${r.stderr || 'no readable output'}`]);
    }
    if (!isPending(checks)) break;
    if (now() >= deadline) {
      const pending = checks.filter((c) => c.bucket === 'pending').map((c) => c.name);
      return refuse([`CI checks still pending after ${timeoutMin} min: ${pending.join(', ')}.`]);
    }
    out(`Waiting for CI on PR #${n}: ${checks.filter((c) => c.bucket === 'pending').length} check(s) pending.`);
    await sleep(pollMs);
  }
  const ci = checksRefusal(checks);
  if (ci) return refuse([ci]);

  // The PR may have moved while CI ran: check it again, on the same head.
  const second = view();
  if (second.error) return refuse([second.error]);
  const again = prRefusals(second.pr);
  if (second.pr.headRefOid !== head) again.push(`The PR head moved from ${head.slice(0, 12)} while CI ran. Run land again.`);
  if (again.length) return refuse(again);
  const pr = second.pr;

  if (pr.isDraft) {
    const r = gh('pr', 'ready', String(n));
    if (!r.ok) return refuse([`Could not mark the draft ready: ${r.stderr || 'gh pr ready failed'}`]);
    out(`Marked PR #${n} ready for review.`);
  }

  const merge = gh('pr', 'merge', String(n), '--merge', '--match-head-commit', head);
  const state = gh('pr', 'view', String(n), '--json', 'state');
  let merged = false;
  try {
    merged = state.ok && JSON.parse(state.stdout).state === 'MERGED';
  } catch {
    // Not confirmed: reported below.
  }
  if (!merged) {
    err(`PR #${n} is not merged.${merge.ok ? ' gh pr merge reported success but the PR state is not MERGED.' : ` gh pr merge failed: ${merge.stderr || 'no output'}`}`);
    return 1;
  }
  if (!merge.ok) err(`gh pr merge exited with an error, but PR #${n} is MERGED.`);
  out(`Merged PR #${n} at ${head.slice(0, 12)}.`);

  // A fork's branch name means nothing on origin: never delete by name there.
  if (pr.isCrossRepository || !pr.headRefName || pr.headRefName === pr.baseRefName) {
    out(`Left the head branch alone (${pr.isCrossRepository ? 'it is on a fork' : 'no branch to delete'}).`);
  } else {
    const del = run('git', ['push', 'origin', '--delete', pr.headRefName]);
    if (del.ok) out(`Deleted remote branch ${pr.headRefName}.`);
    else if (alreadyDeleted(del.stderr)) out(`Remote branch ${pr.headRefName} was already deleted.`);
    else err(`Warning: could not delete remote branch ${pr.headRefName}: ${del.stderr}. Delete it by hand.`);
  }

  if (notify) {
    const notifyMain = deps.notify || require('../notify/cli').main;
    let code;
    try {
      code = await notifyMain(['--kind', 'merged', '--', notify], env, deps.notifyDeps);
    } catch (e) {
      code = `threw ${e && e.message}`;
    }
    if (code !== 0) err(`Warning: the Slack notice failed (${code}). PR #${n} is merged; post the update by hand.`);
  }
  return 0;
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
