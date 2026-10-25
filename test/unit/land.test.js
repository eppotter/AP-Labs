'use strict';

// npm run land: the pure checks, and the CLI in-process against a stub gh
// (test/fixtures/land/fake-gh.sh), a throwaway repo with a local bare origin,
// a fake clock and a fake notify. No real gh, network or Slack.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs, parseBody, prRefusals, isPending, checksRefusal } = require('../../kit/lib/land');
const { main } = require('../../kit/land/cli');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BRANCH = 'feat/x';
const REVIEWED = `What this does: tests.\nKind: infra\n\nReview rounds: 1/3\nReviewed head: ${HEAD}\n`;
const GREEN = [{ name: 'test', state: 'SUCCESS', bucket: 'pass' }, { name: 'docs', state: 'SKIPPED', bucket: 'skipping' }];
const tmps = [];
test.after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const openPr = (extra = {}) => ({ number: 7, state: 'OPEN', baseRefName: 'main', headRefName: BRANCH, headRefOid: HEAD,
  isDraft: false, isCrossRepository: false, body: REVIEWED, ...extra });

function setup({ pr = openPr(), checks = GREEN, remoteBranch = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-land-'));
  tmps.push(tmp);
  const gh = path.join(tmp, 'gh');
  const repo = path.join(tmp, 'repo');
  const origin = path.join(tmp, 'origin.git');
  fs.mkdirSync(gh);
  fs.mkdirSync(repo);
  const env = {
    PATH: process.env.PATH,
    HOME: tmp,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    APLABS_GH_BIN: path.join(__dirname, '../fixtures/land/fake-gh.sh'),
    FAKE_GH_DIR: gh,
  };
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8' }).trim();
  git(tmp, 'init', '-q', '--bare', origin);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  if (remoteBranch) git(repo, 'push', '-q', 'origin', `main:refs/heads/${BRANCH}`);
  const write = (name, value) => fs.writeFileSync(path.join(gh, name), typeof value === 'string' ? value : JSON.stringify(value));
  write('pr.json', pr);
  write('checks.json', checks);
  const calls = () => (fs.existsSync(path.join(gh, 'calls.txt')) ? fs.readFileSync(path.join(gh, 'calls.txt'), 'utf8') : '');
  const remoteHas = (branch) => git(origin, 'branch', '--list', branch) !== '';
  let clock = 0;
  const notified = [];
  const land = async (argv = ['7'], { notify } = {}) => {
    const stdout = [];
    const stderr = [];
    const code = await main(argv, env, {
      cwd: repo,
      out: (s) => stdout.push(s),
      err: (s) => stderr.push(s),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollMs: 60000,
      notify: async (args, notifyEnv) => {
        notified.push({ args, calls: calls() });
        return notify ? notify(args, notifyEnv) : 0;
      },
    });
    return { code, out: stdout.join('\n'), err: stderr.join('\n') };
  };
  return { gh, write, calls, remoteHas, land, notified, flag: (name) => write(name, '') };
}

const merged = (calls) => /^pr merge /m.test(calls);

test('parseArgs: PR number, flags and usage errors', () => {
  assert.deepEqual(parseArgs(['7']), { pr: 7, notify: undefined, timeoutMin: 15 });
  assert.deepEqual(parseArgs(['--notify', 'Story 1.5 merged', '12', '--timeout-min', '0']), { pr: 12, notify: 'Story 1.5 merged', timeoutMin: 0 });
  assert.deepEqual(parseArgs(['-h']), { help: true });
  assert.match(parseArgs([]).error, /no PR number/);
  assert.match(parseArgs(['7', '8']).error, /one PR number only/);
  assert.match(parseArgs(['#7']).error, /not a PR number/);
  assert.match(parseArgs(['0']).error, /not a PR number/);
  assert.match(parseArgs(['7', '--notify']).error, /--notify needs/);
  assert.match(parseArgs(['7', '--notify', '--timeout-min']).error, /--notify needs/);
  assert.match(parseArgs(['7', '--timeout-min', 'soon']).error, /--timeout-min needs/);
  assert.match(parseArgs(['7', '--admin']).error, /unknown argument: --admin/);
});

test('parseBody: review lines, CRLF, malformed and repeated lines fail closed', () => {
  assert.deepEqual(parseBody(REVIEWED.replace(/\n/g, '\r\n')), { kind: true, exempt: false, reviewedHead: HEAD, refuter: null });
  assert.equal(parseBody('Kind: infra\nReview: exempt — docs only').exempt, true);
  assert.equal(parseBody('Kind: infra\nReview: exempt').exempt, false);
  assert.equal(parseBody('Kind: infra\nReview: exempt — docs only\nReview: exempt — docs only').exempt, 'invalid');
  assert.equal(parseBody('Kind: infra\nReview: exempt — docs only\nReview: exempt').exempt, 'invalid');
  assert.equal(parseBody('Kind: party').kind, false);
  assert.equal(parseBody('Reviewed head: abc123').reviewedHead, 'invalid');
  assert.equal(parseBody(`Reviewed head: ${HEAD}\nReviewed head: ${OTHER}`).reviewedHead, 'invalid');
  assert.deepEqual(parseBody('Refuter: 1 confirmed, 2 not reproduced, 3 escalated, 4 pending').refuter,
    { confirmed: 1, fixed: null, notReproduced: 2, escalated: 3, pending: 4 }, 'the old format, with no fixed count, still parses');
  assert.deepEqual(parseBody('Refuter: 1 confirmed, 5 fixed, 2 not reproduced, 3 escalated, 4 pending').refuter,
    { confirmed: 1, fixed: 5, notReproduced: 2, escalated: 3, pending: 4 });
  assert.equal(parseBody('Refuter: 1 confirmed, 2 not reproduced, 5 fixed, 3 escalated, 4 pending').refuter, 'invalid');
  assert.equal(parseBody('Refuter: all good').refuter, 'invalid');
});

test('prRefusals: each of conditions a-d', () => {
  assert.deepEqual(prRefusals(openPr()), []);
  assert.match(prRefusals(openPr({ state: 'CLOSED' })).join(), /is CLOSED, not OPEN/);
  assert.match(prRefusals(openPr({ baseRefName: 'staging' })).join(), /targets staging, not main/);
  assert.match(prRefusals(openPr({ body: REVIEWED.replace('Kind: infra', 'Kind: misc') })).join(), /no valid Kind line/);
  assert.match(prRefusals(openPr({ body: 'Kind: fix' })).join(), /no Reviewed head line and no Review: exempt line/);
  assert.match(prRefusals(openPr({ headRefOid: OTHER })).join(), /not the PR head .*not reviewed/);
  assert.deepEqual(prRefusals(openPr({ body: 'Kind: docs\n\nReview: exempt — docs only' })), []);
  assert.deepEqual(prRefusals(openPr({ body: 'Kind: docs\n\nReview: exempt — docs only\nReview: exempt — revert' })),
    ['The PR body has more than one Review: exempt line.']);
  assert.deepEqual(prRefusals(openPr({ body: `${REVIEWED}\nReview: exempt — docs only\nReview: exempt — docs only\n` })),
    ['The PR body has more than one Review: exempt line.'], 'a repeated exempt line refuses even next to a valid reviewed head');
  const refuter = (line) => prRefusals(openPr({ body: `${REVIEWED}\n${line}\n` })).join();
  assert.equal(refuter('Refuter: 0 confirmed, 2 not reproduced, 0 escalated, 0 pending'), '');
  assert.match(refuter('Refuter: 0 confirmed, 0 not reproduced, 0 escalated, 1 pending'), /1 pending/);
  assert.match(refuter('Refuter: 0 confirmed, 0 not reproduced, 1 escalated, 0 pending'), /1 escalated/);
  assert.match(refuter('Refuter: 1 confirmed, 0 not reproduced, 0 escalated, 0 pending'), /1 confirmed/);
  assert.match(refuter('Refuter: unknown'), /malformed or repeated/);
  // The old format cannot tell a fixed P1 from a blocking one, so it fails closed and says how to rewrite it.
  assert.match(refuter('Refuter: 1 confirmed, 0 not reproduced, 0 escalated, 0 pending'), /predates the fixed count.*--refute/);
  // The new format: a P1 fixed and checked by a later round does not block.
  assert.equal(refuter('Refuter: 0 confirmed, 1 fixed, 0 not reproduced, 0 escalated, 0 pending'), '');
  assert.match(refuter('Refuter: 1 confirmed, 1 fixed, 0 not reproduced, 0 escalated, 0 pending'), /1 confirmed/);
  assert.doesNotMatch(refuter('Refuter: 1 confirmed, 1 fixed, 0 not reproduced, 0 escalated, 0 pending'), /predates/);
  assert.match(refuter('Refuter: 0 confirmed, 2 fixed, 0 not reproduced, 1 escalated, 0 pending'), /1 escalated/);
  assert.match(refuter('Refuter: 0 confirmed, 2 fixed, 0 not reproduced, 0 escalated, 1 pending'), /1 pending/);
});

test('checksRefusal and isPending: green, red, cancelled and none', () => {
  assert.equal(checksRefusal(GREEN), null);
  assert.match(checksRefusal([...GREEN, { name: 'lint', state: 'FAILURE', bucket: 'fail' }]), /not green: lint \(fail\)/);
  assert.match(checksRefusal([{ name: 'test', state: 'CANCELLED', bucket: 'cancel' }]), /test \(cancel\)/);
  assert.match(checksRefusal([]), /No CI checks/);
  assert.equal(isPending([...GREEN, { name: 'test', bucket: 'pending' }]), true);
  assert.equal(isPending(GREEN), false);
});

test('usage errors exit 2 and call nothing', async () => {
  const t = setup();
  const r = await t.land(['seven']);
  assert.equal(r.code, 2);
  assert.match(r.err, /not a PR number: seven\nusage: npm run land/);
  assert.equal(t.calls(), '');
});

test('a verified PR merges with a pinned merge commit, is confirmed MERGED and its branch deleted', async () => {
  const t = setup();
  const r = await t.land();
  assert.equal(r.code, 0, r.err);
  const calls = t.calls().split('\n').filter(Boolean);
  assert.deepEqual(calls.slice(-2), [`pr merge 7 --merge --match-head-commit ${HEAD}`, 'pr view 7 --json state']);
  assert.ok(!calls.some((c) => /--admin|--auto|--squash|--rebase/.test(c)));
  assert.ok(!calls.includes('pr ready 7'), 'a non-draft is not readied');
  assert.match(r.out, /Merged PR #7/);
  assert.match(r.out, /Deleted remote branch feat\/x/);
  assert.equal(t.remoteHas(BRANCH), false);
  assert.equal(t.notified.length, 0, 'no notify without --notify');
});

test('a PR whose only confirmed P1 was fixed and re-reviewed in a later round merges', async () => {
  const t = setup({ pr: openPr({ body: `${REVIEWED}\nRefuter: 0 confirmed, 1 fixed, 0 not reproduced, 0 escalated, 0 pending\n` }) });
  const r = await t.land();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Merged PR #7/);
});

for (const [name, pr, reason] of [
  ['closed PR', openPr({ state: 'CLOSED' }), /is CLOSED, not OPEN/],
  ['wrong base', openPr({ baseRefName: 'staging' }), /targets staging/],
  ['no Kind line', openPr({ body: `Reviewed head: ${HEAD}` }), /no valid Kind line/],
  ['reviewed head is not the PR head', openPr({ headRefOid: OTHER }), /not the PR head/],
  ['Refuter pending', openPr({ body: `${REVIEWED}\nRefuter: 0 confirmed, 0 not reproduced, 0 escalated, 1 pending\n` }), /1 pending/],
  ['Refuter escalated', openPr({ body: `${REVIEWED}\nRefuter: 0 confirmed, 1 not reproduced, 1 escalated, 0 pending\n` }), /1 escalated/],
]) {
  test(`refuses, without checking CI or merging: ${name}`, async () => {
    const t = setup({ pr });
    const r = await t.land();
    assert.equal(r.code, 1);
    assert.match(r.err, /^Refusing to land PR #7:/);
    assert.match(r.err, reason);
    assert.doesNotMatch(t.calls(), /pr checks|pr ready|pr merge/);
    assert.equal(t.remoteHas(BRANCH), true);
  });
}

test('red CI refuses, even when gh exits non-zero with the JSON', async () => {
  const t = setup({ checks: [...GREEN, { name: 'test-node20', state: 'FAILURE', bucket: 'fail' }] });
  t.write('checks-exit', '1');
  const r = await t.land();
  assert.equal(r.code, 1);
  assert.match(r.err, /CI is not green: test-node20 \(fail\)/);
  assert.equal(merged(t.calls()), false);
});

test('no checks on the head refuses', async () => {
  const t = setup();
  t.flag('no-checks');
  const r = await t.land();
  assert.equal(r.code, 1);
  assert.match(r.err, /No CI checks are reported/);
  assert.equal(merged(t.calls()), false);
});

test('pending CI is polled and refused at the timeout', async () => {
  const t = setup({ checks: [{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }] });
  t.write('checks-exit', '8');
  const r = await t.land(['7', '--timeout-min', '3']);
  assert.equal(r.code, 1);
  assert.match(r.err, /CI checks still pending after 3 min: test\./);
  assert.equal((t.calls().match(/^pr checks /gm) || []).length, 4, 'polled at 0, 1, 2 and 3 minutes');
  assert.equal(merged(t.calls()), false);
});

test('pending CI that turns green lands', async () => {
  const t = setup();
  t.write('checks-1.json', [{ name: 'test', state: 'QUEUED', bucket: 'pending' }]);
  const r = await t.land();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Waiting for CI on PR #7: 1 check\(s\) pending/);
  assert.equal(merged(t.calls()), true);
});

test('a PR whose head moves while CI runs is refused', async () => {
  const t = setup();
  t.write('pr-2.json', openPr({ headRefOid: OTHER }));
  const r = await t.land();
  assert.equal(r.code, 1);
  assert.match(r.err, /head moved|not the PR head/);
  assert.equal(merged(t.calls()), false);
});

test('an exempt PR lands without a Reviewed head line', async () => {
  const t = setup({ pr: openPr({ body: 'What this does: docs.\nKind: docs\n\nReview: exempt — docs only\n' }) });
  const r = await t.land();
  assert.equal(r.code, 0, r.err);
  assert.equal(merged(t.calls()), true);
});

test('repeated exempt lines refuse the merge before checks', async () => {
  const t = setup({ pr: openPr({ body: 'What this does: docs.\nKind: docs\n\nReview: exempt — docs only\nReview: exempt — docs only\n' }) });
  const r = await t.land();
  assert.equal(r.code, 1);
  assert.match(r.err, /more than one Review: exempt line/);
  assert.equal(merged(t.calls()), false);
});

test('a draft is readied only after every condition passes, then merged', async () => {
  const t = setup({ pr: openPr({ isDraft: true }) });
  const r = await t.land();
  assert.equal(r.code, 0, r.err);
  const calls = t.calls();
  assert.ok(calls.indexOf('pr checks') < calls.indexOf('pr ready 7') && calls.indexOf('pr ready 7') < calls.indexOf('pr merge'));

  const red = setup({ pr: openPr({ isDraft: true }), checks: [{ name: 'test', bucket: 'fail' }] });
  assert.equal((await red.land()).code, 1);
  assert.doesNotMatch(red.calls(), /pr ready/);
});

test('merge reported success but the state is not MERGED: exit 1, no delete, no notify', async () => {
  const t = setup();
  t.flag('merge-noop');
  const r = await t.land(['7', '--notify', 'Story 1.5 merged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /not merged\. gh pr merge reported success but the PR state is not MERGED/);
  assert.equal(t.remoteHas(BRANCH), true);
  assert.equal(t.notified.length, 0);
});

test('a failed merge exits 1 with gh\'s reason', async () => {
  const t = setup();
  t.flag('merge-fails');
  const r = await t.land();
  assert.equal(r.code, 1);
  assert.match(r.err, /gh pr merge failed: Pull request is not mergeable/);
  assert.equal(t.remoteHas(BRANCH), true);
});

test('a head branch that is already gone is tolerated', async () => {
  const t = setup({ remoteBranch: false });
  const r = await t.land();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Remote branch feat\/x was already deleted/);
  assert.equal(r.err, '');
});

test('a fork\'s head branch is never deleted by name', async () => {
  const t = setup({ pr: openPr({ isCrossRepository: true }) });
  const r = await t.land();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /on a fork/);
  assert.equal(t.remoteHas(BRANCH), true);
});

test('--notify posts kind merged only after a confirmed merge', async () => {
  const t = setup();
  const r = await t.land(['7', '--notify', 'PR #7 merged: land']);
  assert.equal(r.code, 0, r.err);
  assert.equal(t.notified.length, 1);
  assert.deepEqual(t.notified[0].args, ['--kind', 'merged', '--', 'PR #7 merged: land']);
  assert.match(t.notified[0].calls, /^pr view 7 --json state$/m, 'notify runs after the MERGED check');

  const refused = setup({ pr: openPr({ state: 'CLOSED' }) });
  await refused.land(['7', '--notify', 'nope']);
  assert.equal(refused.notified.length, 0);
});

test('a notify failure warns but keeps exit 0', async () => {
  const t = setup();
  const failing = await t.land(['7', '--notify', 'merged'], { notify: () => 1 });
  assert.equal(failing.code, 0);
  assert.match(failing.err, /Warning: the Slack notice failed \(1\)\. PR #7 is merged/);

  const u = setup();
  const throwing = await u.land(['7', '--notify', 'merged'], { notify: () => { throw new Error('boom'); } });
  assert.equal(throwing.code, 0);
  assert.match(throwing.err, /Slack notice failed \(threw boom\)/);
});

test('the real notify module runs in-process: with no webhook it warns and land still exits 0', async () => {
  const t = setup();
  const stderr = [];
  const code = await main(['7', '--notify', 'merged'], { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null',
    APLABS_GH_BIN: path.join(__dirname, '../fixtures/land/fake-gh.sh'), FAKE_GH_DIR: t.gh }, {
    cwd: os.tmpdir(), out: () => {}, err: (s) => stderr.push(s),
    notifyDeps: { platform: 'linux', out: () => {}, err: (s) => stderr.push(s), fetch: async () => { throw new Error('unexpected fetch'); } },
  });
  assert.equal(code, 0);
  assert.match(stderr.join('\n'), /no Slack webhook configured/);
  assert.match(stderr.join('\n'), /Warning: the Slack notice failed \(1\)/);
});
