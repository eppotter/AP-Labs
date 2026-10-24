'use strict';

// Plan approval (Story 2.5): the UserPromptSubmit approval recorder, the
// tier-scaled gate decision and the engage flags, run end to end through the
// bash wrapper (bash + node) against fixture git repos in temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { approvalSlugs } = require('../../kit/lib/gate');

const ROOT = path.resolve(__dirname, '../..');
const WRAPPER = path.join(ROOT, 'kit/hooks/write-gate.sh');
const ENGAGE = path.join(ROOT, 'kit/hooks/engage.js');
const BASH = '/bin/bash';
const MINIMAL = fs.readFileSync(path.join(__dirname, '../fixtures/profiles/minimal.yml'), 'utf8');
const PROFILE = `${MINIMAL}tiers: { T3: ["data/**"], T2: ["live/**"] }\ninert: ["docs/**"]\ngate: { exempt: ["sandbox/**"] }\n`;
const DAY = 24 * 60 * 60 * 1000;

const tmpDirs = [];
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-plan-'));
  tmpDirs.push(d);
  return d;
}

const HOME = tmpDir();
const cleanEnv = (env = {}) => ({ PATH: process.env.PATH, HOME, GIT_CONFIG_NOSYSTEM: '1', ...env });
const gitIn = (d, ...args) => execFileSync('git', ['-C', d, ...args], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'ignore'] });

function repo(profile = PROFILE) {
  const d = tmpDir();
  execFileSync('git', ['init', '-q', '-b', 'main', d], { env: cleanEnv() });
  gitIn(d, 'config', 'user.name', 'Plan Tester');
  gitIn(d, 'config', 'user.email', 'plan@example.invalid');
  if (profile !== null) {
    fs.mkdirSync(path.join(d, '.aplabs'));
    fs.writeFileSync(path.join(d, '.aplabs/profile.yml'), profile);
  }
  return d;
}

const common = (d) => path.join(d, '.git', 'aplabs');
const approvalFile = (d, slug) => path.join(common(d), 'approvals', `${slug}.json`);
const logLines = (d, gitDir = path.join(d, '.git')) => {
  const f = path.join(gitDir, 'aplabs/gate.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : [];
};

function run({ dir, input, args = [] }) {
  const r = spawnSync(BASH, [WRAPPER, ...args], {
    cwd: dir, input: JSON.stringify(input), encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: dir }),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function engage(d, ...args) {
  const r = spawnSync('node', [ENGAGE, ...args], { cwd: d, encoding: 'utf8', env: cleanEnv() });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const prompt = (dir, text, session = 'orch-1') => ({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: dir, prompt: text });
const write = (dir, rel, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd: dir, tool_name: 'Write',
  tool_input: { file_path: path.join(dir, rel), content: 'x' }, ...extra,
});
const SILENT = { code: 0, stdout: '', stderr: '' };

function denied(r) {
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

// Writes an approval record directly, as the hook would have `ago` ms back.
function approve(d, slug, ago = 0, session = 'orch-1') {
  fs.mkdirSync(path.dirname(approvalFile(d, slug)), { recursive: true });
  const at = new Date(Date.now() - ago).toISOString();
  fs.writeFileSync(approvalFile(d, slug), JSON.stringify({ slug, at, session_id: session, user: 'Plan Tester', by: 'UserPromptSubmit' }));
}

test('approvalSlugs: whole-word phrase, any case, valid slugs only', () => {
  assert.deepEqual(approvalSlugs('approve plan story-2-5'), ['story-2-5']);
  assert.deepEqual(approvalSlugs('OK. Approve  Plan Story-2-5.'), ['story-2-5']);
  assert.deepEqual(approvalSlugs('approve plan a and approve plan b, approve plan a'), ['a', 'b']);
  // Inside a code block is accepted (documented): the hook cannot tell quoting from intent.
  assert.deepEqual(approvalSlugs('```\napprove plan x1\n```'), ['x1']);
  for (const no of [
    'approve planning x', 'approve plan', 'approve plan <slug>', 'preapprove plan x', 'approve plan foo_bar',
    'approve plan -x', `approve plan ${'a'.repeat(65)}`, 'approve\nplan x', 'approve plans x', 'disapprove plan x', '',
  ]) assert.deepEqual(approvalSlugs(no), [], no);
  assert.deepEqual(approvalSlugs(`approve plan ${'a'.repeat(64)}`), ['a'.repeat(64)]);
});

test('UserPromptSubmit records the approval in the git common dir and never blocks', () => {
  const d = repo();
  const r = run({ dir: d, input: prompt(d, 'Looks good, approve plan Story-2-5 please') });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  assert.match(out.systemMessage, /recorded your approval of plan story-2-5/);
  const rec = JSON.parse(fs.readFileSync(approvalFile(d, 'story-2-5'), 'utf8'));
  assert.deepEqual([rec.slug, rec.session_id, rec.user, rec.by], ['story-2-5', 'orch-1', 'Plan Tester', 'UserPromptSubmit']);
  assert.ok(Math.abs(Date.parse(rec.at) - Date.now()) < 60000);
  assert.match(logLines(d).at(-1), /\tapprove\tplan=story-2-5\tsession=orch-1\tuser=Plan Tester$/);
});

test('UserPromptSubmit: no phrase, a lookalike, or an ungoverned repo is silent and writes nothing', () => {
  const d = repo();
  for (const text of ['hello', 'approve planning story', 'approve plan bad_slug']) {
    assert.deepEqual(run({ dir: d, input: prompt(d, text) }), SILENT);
  }
  assert.equal(fs.existsSync(path.join(common(d), 'approvals')), false);
  const u = repo(null);
  assert.deepEqual(run({ dir: u, input: prompt(u, 'approve plan x') }), SILENT);
  assert.equal(fs.existsSync(common(u)), false);
});

test('an approval typed in one worktree is seen by a builder engaged in another', () => {
  const d = repo();
  gitIn(d, 'add', '-A');
  gitIn(d, 'commit', '-q', '-m', 'init');
  const wt = path.join(tmpDir(), 'builder');
  gitIn(d, 'worktree', 'add', '-q', '-b', 'story', wt);
  assert.equal(engage(wt, '--reason', 'Story 1', '--plan', 'p1').code, 0);
  denied(run({ dir: wt, input: write(wt, 'live/a.js') }));
  // The human approves in the Orchestrator's session, in the main checkout.
  run({ dir: d, input: prompt(d, 'approve plan p1') });
  assert.ok(fs.existsSync(approvalFile(d, 'p1')));
  assert.deepEqual(run({ dir: wt, input: write(wt, 'live/a.js') }), SILENT);
});

test('gate: T0/T1 targets are allowed with a marker and no plan', () => {
  const d = repo();
  engage(d, '--reason', 'small fix');
  assert.deepEqual(run({ dir: d, input: write(d, 'docs/a.md') }), SILENT);
  assert.deepEqual(run({ dir: d, input: write(d, 'src/a.js') }), SILENT);
});

test('gate: T2 without a plan, or with a plan but no approval, is denied', () => {
  const d = repo();
  engage(d, '--reason', 'live change');
  const noPlan = denied(run({ dir: d, input: write(d, 'live/a.js') }));
  assert.match(noPlan, /T2 work and no plan is recorded/);
  assert.match(noPlan, /T2\/T3 work needs the human's approval: ask them to type `approve plan <slug>`/);
  assert.doesNotMatch(noPlan, /Codex/);
  // A T1 path in the same edit does not lower the tier.
  denied(run({ dir: d, input: { ...write(d, 'x'), tool_name: 'apply_patch', tool_input: { command: '*** Update File: src/a.js\n*** Update File: live/b.js\n' } } }));
  engage(d, '--reason', 'live change', '--plan', 'p2');
  const noApproval = denied(run({ dir: d, input: write(d, 'live/a.js') }));
  assert.match(noApproval, /plan p2 has no recorded approval.*`approve plan p2`/);
  assert.match(logLines(d).at(-1), /\tdeny\tno-approval\ttool=Write\tsession=sess-1\tpaths=live\/a\.js$/);
});

test('gate: T2 with a fresh approval is allowed; stale approvals are denied', () => {
  const d = repo();
  engage(d, '--reason', 'live change', '--plan', 'p3');
  approve(d, 'p3', 60 * 1000);
  assert.deepEqual(run({ dir: d, input: write(d, 'live/a.js') }), SILENT);
  // Approved a day before the engage is fine (approve, then build).
  approve(d, 'p3', DAY - 60 * 1000);
  assert.deepEqual(run({ dir: d, input: write(d, 'live/a.js') }), SILENT);
  // More than 24h before the plan was engaged: stale.
  approve(d, 'p3', 2 * DAY);
  assert.match(denied(run({ dir: d, input: write(d, 'live/a.js') })), /approval for plan p3 is stale/);
  // Older than 7 days: stale even for a session-held approval.
  approve(d, 'p3', 8 * DAY, 'sess-1');
  const sub = write(d, 'live/a.js', { agent_id: 'a1' });
  fs.rmSync(path.join(d, '.git/aplabs/engaged/worktree'));
  assert.match(denied(run({ dir: d, input: sub })), /stale/);
  // A record stamped in the future does not count.
  approve(d, 'p3', -2 * DAY, 'sess-1');
  denied(run({ dir: d, input: sub }));
});

test('gate: an onboarding build needs approval even for T1 paths', () => {
  const d = repo();
  engage(d, '--reason', 'onboard billing', '--kind', 'onboarding');
  assert.match(denied(run({ dir: d, input: write(d, 'src/a.js') })), /onboarding build \(T1\) and no plan is recorded/);
  engage(d, '--reason', 'onboard billing', '--kind', 'onboarding', '--plan', 'onb');
  denied(run({ dir: d, input: write(d, 'docs/a.md') }));
  approve(d, 'onb');
  assert.deepEqual(run({ dir: d, input: write(d, 'src/a.js') }), SILENT);
});

test('gate: T3 also needs the plan-review record', () => {
  const d = repo();
  approve(d, 'p4');
  engage(d, '--reason', 'data change', '--plan', 'p4');
  const reason = denied(run({ dir: d, input: write(d, 'data/q.sql') }));
  assert.match(reason, /T3 needs a `bmad-review` pass on plan p4 first/);
  assert.match(reason, /--plan-reviewed/);
  // .aplabs/** is always T3.
  denied(run({ dir: d, input: write(d, '.aplabs/context/data.md') }));
  fs.mkdirSync(path.join(d, 'reviews'));
  fs.writeFileSync(path.join(d, 'reviews/p4.md'), '# review\nno blockers\n');
  const r = engage(d, '--reason', 'data change', '--plan', 'p4', '--plan-reviewed', 'reviews/p4.md');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /approval on record/);
  assert.match(r.stdout, /plan review recorded/);
  const copy = fs.readFileSync(path.join(common(d), 'plan-reviews/p4.md'), 'utf8');
  assert.match(copy, /^<!-- aplabs plan review for p4: copied from reviews\/p4\.md .* by Plan Tester \(main\) -->\n# review\nno blockers\n$/);
  assert.match(logLines(d).at(-1), /\tengage\treason=data change\tuser=Plan Tester\tbranch=main\tplan=p4\tplan_review=reviews\/p4\.md$/);
  assert.deepEqual(run({ dir: d, input: write(d, 'data/q.sql') }), SILENT);
  const rec = JSON.parse(fs.readFileSync(path.join(common(d), 'plan-reviews/p4.json'), 'utf8'));
  assert.deepEqual([rec.slug, rec.source, rec.user, rec.branch], ['p4', 'reviews/p4.md', 'Plan Tester', 'main']);
  assert.equal(rec.engaged_at, rec.at);
  assert.ok(Math.abs(Date.parse(rec.at) - Date.now()) < 60000);
  // Re-engaging later without --plan-reviewed keeps the review: it postdates the approval.
  engage(d, '--reason', 'data change, day two', '--plan', 'p4');
  assert.deepEqual(run({ dir: d, input: write(d, 'data/q.sql') }), SILENT);
});

// Writes a plan-review record directly, as engage would have `ago` ms back.
function reviewRecord(d, slug, ago, fields = {}) {
  const dir = path.join(common(d), 'plan-reviews');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - ago).toISOString();
  fs.writeFileSync(path.join(dir, `${slug}.md`), '# old review\n');
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify({ slug, at, engaged_at: at, source: 'r.md', user: 'Plan Tester', branch: 'main', ...fields }));
}

test('gate: T3 rejects a plan review from an earlier engagement of the same plan (#36)', () => {
  const d = repo();
  reviewRecord(d, 'p7', 3 * DAY);
  approve(d, 'p7', DAY / 2);
  engage(d, '--reason', 'data change', '--plan', 'p7');
  const reason = denied(run({ dir: d, input: write(d, 'data/q.sql') }));
  assert.match(reason, /plan review on record for p7 is not from this plan engagement/);
  assert.match(logLines(d).at(-1), /\tdeny\tstale-plan-review\t/);
  // T2 work on the same plan does not need the review.
  assert.deepEqual(run({ dir: d, input: write(d, 'live/a.js') }), SILENT);
  // A review recorded after the approval counts even though the plan was engaged earlier.
  reviewRecord(d, 'p7', 0);
  assert.deepEqual(run({ dir: d, input: write(d, 'data/q.sql') }), SILENT);
});

test('gate: T3 accepts a review recorded at engage time even before the approval', () => {
  const d = repo();
  fs.mkdirSync(path.join(d, 'reviews'));
  fs.writeFileSync(path.join(d, 'reviews/p8.md'), '# review\n');
  assert.equal(engage(d, '--reason', 'data', '--plan', 'p8', '--plan-reviewed', 'reviews/p8.md').code, 0);
  approve(d, 'p8');
  assert.deepEqual(run({ dir: d, input: write(d, 'data/q.sql') }), SILENT);
});

test('gate: T3 rejects a review record for another slug, with a bad time, or with no record', () => {
  const d = repo();
  approve(d, 'p9', DAY / 2);
  engage(d, '--reason', 'data change', '--plan', 'p9');
  reviewRecord(d, 'p9', 0, { slug: 'other' });
  assert.match(denied(run({ dir: d, input: write(d, 'data/q.sql') })), /not from this plan engagement/);
  reviewRecord(d, 'p9', 0, { at: 'yesterday' });
  assert.match(denied(run({ dir: d, input: write(d, 'data/q.sql') })), /not from this plan engagement/);
  // A legacy copy with no record (written before #36) does not count either.
  fs.rmSync(path.join(common(d), 'plan-reviews/p9.json'));
  assert.match(denied(run({ dir: d, input: write(d, 'data/q.sql') })), /not from this plan engagement/);
  fs.rmSync(path.join(common(d), 'plan-reviews/p9.md'));
  assert.match(denied(run({ dir: d, input: write(d, 'data/q.sql') })), /T3 needs a `bmad-review` pass on plan p9 first/);
});

test('gate: subagent edits go through the tier check and share the session approval', () => {
  const d = repo();
  // No marker at all: a subagent may still make T1 edits.
  assert.deepEqual(run({ dir: d, input: write(d, 'src/a.js', { agent_id: 'a1' }) }), SILENT);
  assert.match(denied(run({ dir: d, input: write(d, 'live/a.js', { agent_id: 'a1' }) })), /no plan is recorded/);
  // The human approves in this session (sess-1); its subagents share it, other sessions do not.
  run({ dir: d, input: prompt(d, 'approve plan p5', 'sess-1') });
  assert.deepEqual(run({ dir: d, input: write(d, 'live/a.js', { agent_id: 'a1' }) }), SILENT);
  denied(run({ dir: d, input: write(d, 'live/a.js', { agent_id: 'a2', session_id: 'other' }) }));
  // T3 still needs the review record.
  assert.match(denied(run({ dir: d, input: write(d, 'data/q.sql', { agent_id: 'a1' }) })), /bmad-review/);
});

test('gate: Codex denies say plainly that approval must be given in Claude Code', () => {
  const d = repo();
  engage(d, '--reason', 'live change', '--plan', 'p6');
  const r = spawnSync(BASH, [WRAPPER, '--harness', 'codex'], {
    cwd: d, encoding: 'utf8', env: cleanEnv(),
    input: JSON.stringify({ cwd: d, tool_name: 'apply_patch', tool_input: { command: '*** Update File: live/a.js\n' } }),
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Codex cannot record approvals: the human must type it in a Claude Code session/);
});

test('gate: an ungoverned repo is unaffected', () => {
  const d = repo(null);
  assert.deepEqual(run({ dir: d, input: write(d, 'live/a.js') }), SILENT);
  assert.deepEqual(run({ dir: d, input: write(d, 'data/a.sql', { agent_id: 'a1' }) }), SILENT);
});

test('engage: --plan, --kind and --plan-reviewed are validated and write nothing on error', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'r.md'), 'x');
  const outside = path.join(tmpDir(), 'r.md');
  fs.writeFileSync(outside, 'x');
  const R = ['--reason', 'x'];
  const cases = [
    [[...R, '--plan', 'Bad_Slug'], /--plan must be a slug/],
    [[...R, '--plan', ''], /--plan must be a slug/],
    [[...R, '--plan', `a${'b'.repeat(64)}`], /--plan must be a slug/],
    [[...R, '--kind', 'bogus'], /--kind must be one of build, onboarding/],
    [[...R, '--plan-reviewed', 'r.md'], /--plan-reviewed needs --plan/],
    [[...R, '--plan', 'p', '--plan-reviewed', 'missing.md'], /no such file: missing\.md/],
    [[...R, '--plan', 'p', '--plan-reviewed', outside], /must be a file inside this repo/],
    [[...R, '--plan', 'p', '--plan-reviewed', '.'], /must be a file inside this repo/],
    [['--plan', 'p'], /a reason is required/],
  ];
  for (const [args, re] of cases) {
    const r = engage(d, ...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, re);
  }
  assert.equal(fs.existsSync(path.join(d, '.git/aplabs')), false);
});

test('engage: --plan and --kind land on the marker and the log line; slugs are lower-cased', () => {
  const d = repo();
  const r = engage(d, '--reason', 'Onboard CRM', '--plan=Onb-1', '--kind=onboarding');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /plan onb-1 \(onboarding\), no approval recorded yet/);
  const m = JSON.parse(fs.readFileSync(path.join(d, '.git/aplabs/engaged/worktree'), 'utf8'));
  assert.deepEqual([m.plan, m.kind, m.reason], ['onb-1', 'onboarding', 'Onboard CRM']);
  assert.match(logLines(d).at(-1), /\tengage\treason=Onboard CRM\tuser=Plan Tester\tbranch=main\tplan=onb-1\tkind=onboarding$/);
});
