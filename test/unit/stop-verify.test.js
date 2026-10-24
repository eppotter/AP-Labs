'use strict';

// Stop hook (Story 3.2): the pure helpers, then the bash wrapper end to end
// (bash + node) against throwaway git repos whose profiles run tiny node
// one-liners as checks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { report, sessionChanged, budgetSeconds, DEFAULT_BUDGET_SECONDS } = require('../../kit/lib/stop-verify');
const { recordSessionHead, readSessionHead, headFile } = require('../../kit/lib/session/head');

const ROOT = path.resolve(__dirname, '../..');
const WRAPPER = path.join(ROOT, 'kit/hooks/stop-verify.sh');
const SESSION_WRAPPER = path.join(ROOT, 'kit/hooks/session-start.sh');
const BASH = '/bin/bash';
const node = process.execPath;

const PASS = { id: 'ok', run: [node, '-e', 'process.exit(0)'] };
const FAIL = { id: 'bad', run: [node, '-e', 'console.log("boom"); console.error("bad thing"); process.exit(3)'] };
const MISSING = { id: 'gone', run: ['/nonexistent/aplabs-no-such-binary'] };
const SLOW = { id: 'slow', run: [node, '-e', 'setTimeout(() => {}, 10000)'], timeout_seconds: 1 };

const tmps = [];
test.after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-stop-'));
  tmps.push(d);
  return d;
}

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1' };

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, ...GIT_ENV } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// A committed git repo. `verify` (optional) becomes the profile's verify
// block; `verify: undefined` with governed false means no profile at all.
function repo({ verify, governed = true, text } = {}) {
  const dir = tmpDir();
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  if (governed) {
    fs.mkdirSync(path.join(dir, '.aplabs'));
    // A governed repo has an app dir, or the built-in write-path check fails.
    fs.mkdirSync(path.join(dir, 'app'));
    fs.writeFileSync(path.join(dir, 'app', '.keep'), '');
    const profile = { schema_version: 1, client: { id: 'tiny', name: 'Tiny' }, users: [{ id: 'solo', name: 'Solo', role: 'admin' }] };
    if (verify) profile.verify = verify;
    fs.writeFileSync(path.join(dir, '.aplabs/profile.yml'), text ?? YAML.stringify(profile));
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const dirty = (dir) => fs.writeFileSync(path.join(dir, 'work.txt'), 'changed\n');

// Runs the wrapper with a clean env, so a CLAUDE_PROJECT_DIR, APLABS_* or
// APLABS_PROFILE from the shell running the tests cannot leak in.
function runWrapper(dir, { input = {}, env = {}, wrapper = WRAPPER } = {}) {
  const r = spawnSync(BASH, [wrapper], {
    cwd: dir,
    input: JSON.stringify({ session_id: 'sess-1', cwd: dir, hook_event_name: 'Stop', ...input }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PROJECT_DIR: dir, ...GIT_ENV, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout ? JSON.parse(r.stdout) : null };
}

const silent = (r) => assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);

// --- pure helpers ---

test('sessionChanged: dirty, moved since session start, or ahead of origin without a record', () => {
  assert.equal(sessionChanged({ dirty: true, head: null }), true);
  assert.equal(sessionChanged({ dirty: false, head: null }), false);
  assert.equal(sessionChanged({ dirty: false, head: 'a', sessionHead: 'a', aheadOfOrigin: true }), false);
  assert.equal(sessionChanged({ dirty: false, head: 'b', sessionHead: 'a' }), true);
  assert.equal(sessionChanged({ dirty: false, head: 'a', sessionHead: null, aheadOfOrigin: true }), true);
  assert.equal(sessionChanged({ dirty: false, head: 'a', sessionHead: null, aheadOfOrigin: false }), false);
});

test('report: pass line, block on fail, report skip and timeout', () => {
  const r = (id, outcome, extra = {}) => ({ id, outcome, seconds: 1, stdout: '', stderr: '', ...extra });
  assert.deepEqual(report([r('a', 'pass'), r('b', 'pass')]), { systemMessage: 'AP Labs verify: all 2 checks passed (2.0s).' });

  const block = report([r('a', 'pass'), r('b', 'fail', { reason: 'exit 1', stderr: 'oops\n' }), r('c', 'skip', { reason: 'spawn ENOENT' })]);
  assert.equal(block.decision, 'block');
  assert.match(block.reason, /^Verify failed: b\./);
  assert.match(block.reason, /--- b \(exit 1\) ---\n\[stderr, last lines\]\noops/);
  assert.match(block.reason, /Also not passed: SKIP c \(spawn ENOENT\)/);

  const soft = report([r('a', 'pass'), r('c', 'skip', { reason: 'spawn ENOENT' }), r('d', 'timeout')], ['e'], { budget: 5 });
  assert.equal(soft.decision, undefined);
  assert.match(soft.systemMessage, /1 of 4 checks passed; SKIP c \(spawn ENOENT\); TIMEOUT d after 1s; NOT RUN e \(hook budget of 5s reached\)\. Not a pass, not blocked\./);
  assert.match(report([r('d', 'timeout', { deadlineHit: true })], [], { budget: 7 }).systemMessage, /TIMEOUT d \(hook budget of 7s reached\)/);
});

test('report: the block tail is short', () => {
  const stdout = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n');
  const out = report([{ id: 'big', outcome: 'fail', seconds: 0, stdout, stderr: '' }]);
  assert.ok(out.reason.length < 2500, `reason is ${out.reason.length} chars`);
  assert.match(out.reason, /line 199/);
  assert.doesNotMatch(out.reason, /line 100 /);
});

test('budgetSeconds: default, override, junk ignored', () => {
  assert.equal(budgetSeconds({}), DEFAULT_BUDGET_SECONDS);
  assert.equal(budgetSeconds({ APLABS_STOP_VERIFY_BUDGET_SECONDS: '30' }), 30);
  for (const v of ['0', '-1', 'abc', '1.5']) assert.equal(budgetSeconds({ APLABS_STOP_VERIFY_BUDGET_SECONDS: v }), DEFAULT_BUDGET_SECONDS, v);
});

test('session head: recorded once inside the git dir, bad ids refused', () => {
  const dir = repo();
  const gitDir = git(dir, 'rev-parse', '--absolute-git-dir');
  const head = git(dir, 'rev-parse', 'HEAD');
  const file = recordSessionHead(dir, 'abc-123');
  assert.equal(file, path.join(gitDir, 'aplabs/session/abc-123.head'));
  assert.equal(readSessionHead(gitDir, 'abc-123'), head);
  fs.writeFileSync(path.join(dir, 'x'), 'x');
  git(dir, 'add', 'x');
  git(dir, 'commit', '-q', '-m', 'x');
  recordSessionHead(dir, 'abc-123');
  assert.equal(readSessionHead(gitDir, 'abc-123'), head, 'a resumed session keeps its first HEAD');
  for (const bad of ['../x', '', '.hidden', 'a/b', undefined, 7]) assert.equal(headFile(gitDir, bad), null, String(bad));
  assert.equal(recordSessionHead(tmpDir(), 'abc'), null, 'not a git repo');
});

// --- the wrapper end to end ---

test('wrapper: ungoverned repo is silent', () => {
  const dir = repo({ governed: false });
  dirty(dir);
  silent(runWrapper(dir));
});

test('wrapper: invalid profile or zero checks is silent', () => {
  const bad = repo({ text: 'schema_version: 1\nbogus: 1\n' });
  dirty(bad);
  silent(runWrapper(bad));
  const none = repo({ verify: { checks: [] } });
  dirty(none);
  silent(runWrapper(none));
});

test('wrapper: the built-in engine:write-path check runs even with zero checks, and blocks a live write (DEP-012)', () => {
  for (const checks of [[], [PASS]]) {
    const dir = repo({ verify: { checks } });
    fs.mkdirSync(path.join(dir, 'app/modules/m'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/modules/m/handler.js'), "await crm.write.put({ idempotencyKey: 'k', dryRun: false });\n");
    const r = runWrapper(dir);
    assert.equal(r.code, 0);
    assert.equal(r.out.decision, 'block', `checks: ${checks.length}`);
    assert.match(r.out.reason, /^Verify failed: engine:write-path\./);
    assert.match(r.out.reason, /app\/modules\/m\/handler\.js:1: passes dryRun other than true/);
  }
});

test('wrapper: clean tree is silent', () => {
  silent(runWrapper(repo({ verify: { checks: [FAIL] } })));
});

test('wrapper: dirty tree + passing check prints one pass line', () => {
  const dir = repo({ verify: { checks: [PASS] } });
  dirty(dir);
  const r = runWrapper(dir);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.deepEqual(Object.keys(r.out), ['systemMessage']);
  assert.match(r.out.systemMessage, /^AP Labs verify: all 2 checks passed \(\d+\.\ds\)\.$/, 'the check and the built-in engine:write-path');
});

test('wrapper: a failing check blocks with its id and output tail', () => {
  const dir = repo({ verify: { checks: [PASS, FAIL, MISSING] } });
  dirty(dir);
  const r = runWrapper(dir);
  assert.equal(r.code, 0);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /^Verify failed: bad\./);
  assert.match(r.out.reason, /bad thing/);
  assert.match(r.out.reason, /boom/);
  assert.match(r.out.reason, /SKIP gone/);
  assert.match(r.out.systemMessage, /FAILED bad/);
});

test('wrapper: skip and timeout are reported, never blocked', () => {
  const dir = repo({ verify: { checks: [PASS, MISSING, SLOW] } });
  dirty(dir);
  const r = runWrapper(dir);
  assert.equal(r.code, 0);
  assert.equal(r.out.decision, undefined);
  assert.match(r.out.systemMessage, /2 of 4 checks passed; SKIP gone \(spawn ENOENT\); TIMEOUT slow after 1s\. Not a pass, not blocked\./);
});

test('wrapper: a spent hook budget is reported, never blocked', () => {
  const slow = { ...SLOW, timeout_seconds: 30 };
  const dir = repo({ verify: { checks: [slow, PASS] } });
  dirty(dir);
  const started = Date.now();
  const r = runWrapper(dir, { env: { APLABS_STOP_VERIFY_BUDGET_SECONDS: '1' } });
  assert.ok(Date.now() - started < 20000, 'the budget cut the 30s check short');
  assert.equal(r.out.decision, undefined);
  assert.match(r.out.systemMessage, /TIMEOUT slow \(hook budget of 1s reached\); NOT RUN ok \(hook budget of 1s reached\)/);
});

test('wrapper: stop_hook_active never runs the checks', () => {
  const dir = repo({ verify: { checks: [FAIL] } });
  dirty(dir);
  silent(runWrapper(dir, { input: { stop_hook_active: true } }));
});

test('wrapper: APLABS_STOP_VERIFY=0 opts out', () => {
  const dir = repo({ verify: { checks: [FAIL] } });
  dirty(dir);
  silent(runWrapper(dir, { env: { APLABS_STOP_VERIFY: '0' } }));
  assert.equal(runWrapper(dir, { env: { APLABS_STOP_VERIFY: '1' } }).out.decision, 'block');
});

test('wrapper: a commit since session start counts as a change; no commit does not', () => {
  const dir = repo({ verify: { checks: [PASS] } });
  // SessionStart records HEAD for sess-1 (and prints its banner).
  const start = runWrapper(dir, { wrapper: SESSION_WRAPPER });
  assert.match(start.out.systemMessage, /AP Labs Orchestrator/);
  silent(runWrapper(dir));
  fs.writeFileSync(path.join(dir, 'y'), 'y');
  git(dir, 'add', 'y');
  git(dir, 'commit', '-q', '-m', 'y');
  assert.match(runWrapper(dir).out.systemMessage, /all 2 checks passed/);
  // A different session, with no record, falls back to "ahead of origin/main":
  // there is no origin/main here, so a clean tree is silent.
  silent(runWrapper(dir, { input: { session_id: 'other' } }));
});

test('wrapper: without a session record, commits not on origin/main count', () => {
  const dir = repo({ verify: { checks: [PASS] } });
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  silent(runWrapper(dir, { input: { session_id: 'none' } }));
  fs.writeFileSync(path.join(dir, 'z'), 'z');
  git(dir, 'add', 'z');
  git(dir, 'commit', '-q', '-m', 'z');
  assert.match(runWrapper(dir, { input: { session_id: 'none' } }).out.systemMessage, /all 2 checks passed/);
});

test('wrapper: fails open when the Node entry throws, even after partial output', () => {
  const dir = repo({ verify: { checks: [FAIL] } });
  dirty(dir);
  const broken = path.join(tmpDir(), 'broken.js');
  fs.writeFileSync(broken, "process.stdout.write('{\"decision\":'); throw new Error('boom');\n");
  const r = runWrapper(dir, { env: { APLABS_STOP_VERIFY_JS: broken } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^aplabs-hooks: stop-verify failed/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('wrapper: fails open when node is not on PATH', () => {
  const dir = repo({ verify: { checks: [FAIL] } });
  dirty(dir);
  const r = spawnSync(BASH, [WRAPPER], { cwd: dir, input: '{}', encoding: 'utf8', env: { PATH: tmpDir(), CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^aplabs-hooks: node not found/);
});

test('.claude/settings.json registers the Stop hook, and it is silent here', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.hooks.Stop.length, 1);
  const [hook] = settings.hooks.Stop[0].hooks;
  assert.match(hook.command, /\$CLAUDE_PROJECT_DIR\/kit\/hooks\/stop-verify\.sh/);
  assert.ok(hook.timeout > DEFAULT_BUDGET_SECONDS, 'the harness timeout leaves room for the hook to report its own budget');
  // This repo has no profile, so the real command must print nothing.
  const r = spawnSync(BASH, ['-c', hook.command], {
    cwd: ROOT, input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: ROOT },
  });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});
