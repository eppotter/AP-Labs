'use strict';

// The verify harness: pure logic in kit/lib/verify, then the CLI end to end
// against throwaway repos whose profiles run tiny node one-liners.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { childEnv, checkEnv, classify, tail, summarize, exitCode, parseArgs } = require('../../kit/lib/verify');

const cli = path.join(__dirname, '../../kit/verify/run-all.js');
const node = process.execPath;
const PASS = { id: 'ok', run: [node, '-e', 'process.exit(0)'] };
const FAIL = { id: 'bad', run: [node, '-e', 'console.log("boom"); process.exit(3)'] };
const MISSING = { id: 'gone', run: ['/nonexistent/aplabs-no-such-binary'] };
const SLOW = { id: 'slow', run: [node, '-e', 'setTimeout(() => {}, 10000)'], timeout_seconds: 1 };
const SEES_SECRET = { id: 'secret', run: [node, '-e', 'process.exit(process.env.APLABS_TEST_SECRET ? 1 : 0)'] };
const tmps = [];
test.after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repo(verify) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-verify-'));
  tmps.push(dir);
  if (verify !== undefined) {
    fs.mkdirSync(path.join(dir, '.aplabs'));
    const profile = { schema_version: 1, client: { id: 'tiny', name: 'Tiny' }, users: [{ id: 'solo', name: 'Solo', role: 'admin' }] };
    if (verify) profile.verify = verify;
    fs.writeFileSync(path.join(dir, '.aplabs', 'profile.yml'), YAML.stringify(profile));
  }
  return dir;
}

function run(dir, args = [], extraEnv = {}) {
  const r = spawnSync(node, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...extraEnv } });
  const lines = r.stdout.trim().split('\n');
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, lines, summary: JSON.parse(lines[lines.length - 1]) };
}

test('checkEnv is childEnv plus the governing profile, absolute; never APLABS_PROFILE (issue #77)', () => {
  const parent = { PATH: '/bin', APLABS_PROFILE: '/elsewhere.yml', APLABS_GOVERNING_PROFILE: '/stale.yml' };
  assert.deepEqual(checkEnv(parent, [], 'profiles/acme/profile.yml'), {
    PATH: '/bin', APLABS_GOVERNING_PROFILE: path.resolve('profiles/acme/profile.yml'),
  });
});

test('childEnv passes the allowlist and env_allow, nothing else', () => {
  const parent = { PATH: '/bin', HOME: '/h', CI: 'true', APLABS_TEST_SECRET: 's', DB_URL: 'x', OTHER: 'y' };
  assert.deepEqual(childEnv(parent), { PATH: '/bin', HOME: '/h', CI: 'true' });
  assert.deepEqual(childEnv(parent, ['DB_URL', 'MISSING']), { PATH: '/bin', HOME: '/h', CI: 'true', DB_URL: 'x' });
});

test('classify maps spawn results to outcomes', () => {
  assert.deepEqual(classify({ status: 0 }), { outcome: 'pass' });
  assert.deepEqual(classify({ status: 2 }), { outcome: 'fail', reason: 'exit 2' });
  assert.deepEqual(classify({ status: null, signal: 'SIGSEGV' }), { outcome: 'fail', reason: 'killed by SIGSEGV' });
  assert.deepEqual(classify({ error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGKILL' }), { outcome: 'timeout' });
  assert.deepEqual(classify({ error: { code: 'ENOENT' } }), { outcome: 'skip', reason: 'spawn ENOENT' });
  assert.deepEqual(classify({ error: { code: 'EACCES' } }), { outcome: 'skip', reason: 'spawn EACCES' });
  assert.equal(classify({ error: { code: 'ENOBUFS' }, status: null }).outcome, 'fail');
});

test('summary is ok only when every check passed and at least one ran', () => {
  const r = (outcome) => ({ id: outcome, outcome, seconds: 0 });
  assert.equal(summarize([r('pass'), r('pass')]).ok, true);
  assert.equal(summarize([]).ok, false);
  for (const o of ['fail', 'skip', 'timeout']) assert.equal(summarize([r('pass'), r(o)]).ok, false, o);
  const s = summarize([r('pass'), r('fail'), r('skip'), r('timeout')]);
  assert.deepEqual([s.passed, s.failed, s.skipped, s.timed_out], [1, 1, 1, 1]);
});

test('exit code: 1 on a failure; strict also on skip, timeout or nothing run', () => {
  const s = (outcomes) => summarize(outcomes.map((outcome, i) => ({ id: `c${i}`, outcome, seconds: 0 })));
  assert.equal(exitCode(s(['pass'])), 0);
  assert.equal(exitCode(s(['pass', 'fail'])), 1);
  assert.equal(exitCode(s(['skip', 'timeout'])), 0);
  assert.equal(exitCode(s([])), 0);
  assert.equal(exitCode(s(['pass']), { strict: true }), 0);
  for (const o of [['skip'], ['timeout'], []]) assert.equal(exitCode(s(o), { strict: true }), 1, String(o));
});

test('tail keeps the last lines only', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const t = tail(text).split('\n');
  assert.equal(t.length, 40);
  assert.equal(t[39], 'line 99');
  assert.equal(tail(''), '');
});

test('parseArgs accepts --strict and rejects anything else', () => {
  assert.deepEqual(parseArgs(['--strict']), { strict: true, help: false });
  assert.match(parseArgs(['--fast']).error, /unknown argument "--fast"/);
  assert.match(parseArgs(['extra']).error, /unknown argument/);
});

test('cli: no profile is a skip, exit 0 (1 under --strict)', () => {
  const dir = repo();
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^verify: SKIPPED \(no \.aplabs\/profile\.yml\)$/m);
  assert.equal(r.summary.ok, false);
  assert.equal(run(dir, ['--strict']).code, 1);
});

test('cli: an invalid profile exits 2 with the profile error', () => {
  const dir = repo({ checks: [{ id: 'x', run: 'npm test' }] });
  const r = run(dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[profile\] refusing to start: .*\/verify\/checks\/0\/run/);
  assert.equal(r.summary.error, 'profile');
});

test('cli: unknown flags exit 2', () => {
  const r = run(repo({ checks: [PASS] }), ['--nope']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown argument "--nope"/);
});

test('cli: zero checks is not a pass', () => {
  const dir = repo({ checks: [] });
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^verify: SKIPPED \(0 checks\)$/m);
  assert.equal(r.summary.ok, false);
  assert.equal(run(dir, ['--strict']).code, 1);
});

test('cli: runs every check in order and reports each outcome', () => {
  const r = run(repo({ checks: [PASS, FAIL, MISSING, SLOW] }));
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /^PASS ok \d+\.\d\ds$/);
  assert.match(r.lines[1], /^FAIL bad \d+\.\d\ds \(exit 3\)$/);
  assert.match(r.lines[2], /^SKIP gone \d+\.\d\ds \(spawn ENOENT\)$/);
  assert.match(r.lines[3], /^TIMEOUT slow \d+\.\d\ds$/);
  assert.match(r.stderr, /--- bad stdout \(last lines\) ---\nboom/);
  assert.deepEqual(r.summary.results.map((x) => x.outcome), ['pass', 'fail', 'skip', 'timeout']);
  assert.deepEqual([r.summary.ok, r.summary.passed, r.summary.failed, r.summary.skipped, r.summary.timed_out], [false, 1, 1, 1, 1]);
  assert.equal(r.summary.results[2].reason, 'spawn ENOENT');
  assert.ok(r.summary.results[3].seconds < 3, 'timeout killed the check promptly');
});

test('cli: all checks passing is ok, exit 0', () => {
  const r = run(repo({ checks: [PASS, { ...PASS, id: 'ok-too' }] }), ['--strict']);
  assert.equal(r.code, 0);
  assert.equal(r.summary.ok, true);
  assert.equal(r.summary.passed, 2);
});

test('cli: skip and timeout never pass; strict turns them into exit 1', () => {
  const dir = repo({ checks: [PASS, MISSING] });
  assert.equal(run(dir).code, 0);
  assert.equal(run(dir).summary.ok, false);
  assert.equal(run(dir, ['--strict']).code, 1);
});

test('cli: a non-executable file is a skip', () => {
  const dir = repo({ checks: [{ id: 'noexec', run: ['./script.sh'] }] });
  fs.writeFileSync(path.join(dir, 'script.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const r = run(dir);
  assert.equal(r.summary.results[0].outcome, 'skip');
  assert.equal(r.summary.results[0].reason, 'spawn EACCES');
});

test('cli: checks run from the repo root', () => {
  const dir = repo({ checks: [{ id: 'cwd', run: [node, '-e', 'process.exit(require("fs").existsSync(".aplabs/profile.yml") ? 0 : 1)'] }] });
  assert.equal(run(dir).summary.ok, true);
});

test('cli: a parent env secret reaches a check only via env_allow', () => {
  const secret = { APLABS_TEST_SECRET: 'not-a-real-secret' };
  assert.equal(run(repo({ checks: [SEES_SECRET] }), [], secret).summary.ok, true);
  assert.equal(run(repo({ checks: [SEES_SECRET], env_allow: ['APLABS_TEST_SECRET'] }), [], secret).summary.ok, false);
});

// Issue #24: a check that starts children must not outlive its timeout. The
// check writes its grandchild's pid to a file, then hangs; the grandchild
// shares the check's pipes, which used to stall the run.
function spawnsGrandchild(pidFile, { hang }) {
  const grandchild = 'setInterval(() => {}, 1000)';
  const body = [
    `const c = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" });`,
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    hang ? 'setInterval(() => {}, 1000);' : 'process.exit(0);',
  ].join(' ');
  return [node, '-e', body];
}

async function gone(pid) {
  for (let i = 0; i < 50; i += 1) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('cli: a timed-out check is killed with its whole process group (#24)', async () => {
  const dir = repo({ checks: [] });
  const pidFile = path.join(dir, 'grandchild.pid');
  fs.writeFileSync(path.join(dir, '.aplabs', 'profile.yml'), YAML.stringify({
    schema_version: 1,
    client: { id: 'tiny', name: 'Tiny' },
    users: [{ id: 'solo', name: 'Solo', role: 'admin' }],
    verify: { checks: [{ id: 'tree', run: spawnsGrandchild(pidFile, { hang: true }), timeout_seconds: 1 }] },
  }));
  const started = Date.now();
  const r = run(dir);
  const took = (Date.now() - started) / 1000;
  assert.equal(r.summary.results[0].outcome, 'timeout');
  assert.ok(took < 1 + 3, `returned within timeout + slack, took ${took}s`);
  assert.ok(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'grandchild was killed');
});

test('cli: a check that exits leaves nothing running and does not stall', async () => {
  const dir = repo({ checks: [] });
  const pidFile = path.join(dir, 'grandchild.pid');
  fs.writeFileSync(path.join(dir, '.aplabs', 'profile.yml'), YAML.stringify({
    schema_version: 1,
    client: { id: 'tiny', name: 'Tiny' },
    users: [{ id: 'solo', name: 'Solo', role: 'admin' }],
    verify: { checks: [{ id: 'leaves', run: spawnsGrandchild(pidFile, { hang: false }), timeout_seconds: 30 }] },
  }));
  const started = Date.now();
  const r = run(dir);
  assert.equal(r.summary.results[0].outcome, 'pass');
  assert.ok((Date.now() - started) / 1000 < 5, 'did not wait for the grandchild');
  assert.ok(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'grandchild was killed');
});

test('CI: the Verify step runs --strict in a governed fork, plain in the template (#24)', () => {
  const ci = YAML.parse(fs.readFileSync(path.join(__dirname, '../../.github/workflows/ci.yml'), 'utf8'));
  const step = ci.jobs.test.steps.find((s) => s.name === 'Verify harness');
  assert.ok(step, 'ci.yml has a "Verify harness" step');
  // Run the step's script with a stub npm that prints its arguments.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-ci-bin-'));
  tmps.push(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "npm $*"\n', { mode: 0o755 });
  const runStep = (dir) => {
    const r = spawnSync('/bin/bash', ['-e', '-c', step.run], { cwd: dir, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(runStep(repo({ checks: [PASS] })), 'npm run verify -- --strict');
  assert.equal(runStep(repo()), 'npm run verify');
});
