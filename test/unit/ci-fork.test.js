'use strict';

// Story 11.5 (review B10): a fork that deleted the example client keeps a
// green CI. A clean-bones-style copy (makeCopyFork: the repo's files without
// examples/brightside/ or profiles/brightside/, with a stub
// .aplabs/profile.yml) runs every `run` step of .github/workflows/ci.yml that
// needs no network, the way GitHub runs it (bash -eo pipefail), and each must
// pass. The steps it can't run here are listed by name with the reason, and
// the list is checked against ci.yml so it can't go stale. Any new step is
// run by default. The fork-copy test is slow and runs only under
// `npm run test:slow` (plan ci-split); the shape checks run in `npm test`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const YAML = require('yaml');
const { makeCopyFork, REPO } = require('../fixtures/temp-fork');
const { slowSkip } = require('../fixtures/slow');

const CI = path.join(REPO, '.github/workflows/ci.yml');
const GUARD = 'if [ -f .aplabs/profile.yml ] && [ ! -d examples/brightside ]; then echo "skipped: no example client in this fork"; exit 0; fi';
const FIXTURE_STEPS = Object.freeze([
  'test/Fixture seeds match the generator',
  'test/Fixture builds into DuckDB (offline)',
  'test/Fixture checks pass (integrity, synthetic-only)',
]);
const ENGINE_STEP = 'test/Engine untouched (forks only)';
// Plan template-dist D.2: the dist job runs only in the template source repo.
const DIST_STEP = 'dist/Distribution tree builds and passes its tests';
const DIST_GUARD = 'if [ -f .aplabs/profile.yml ] || [ ! -d docs/reference ]; then echo "skipped: not the template source repo"; exit 0; fi';
const DIST_SKIP = /^skipped: not the template source repo$/m;

// Steps not run here, and why. Every other run step is.
const NOT_RUN = Object.freeze({
  'changes/Changed files': 'writes the job outputs to $GITHUB_OUTPUT; test/unit/ci-changes.test.js tests the script',
  'test/Install': 'npm ci downloads packages (network)',
  'test/Tests (unit, hook, acceptance)': 'the fast suite; CI runs it, not this copy',
  'test/Slow tests (fork copy, template update)': 'runs the ci-fork test itself (and the template-update test); CI runs it',
  'test/Ledger row': 'pull requests only; compares with the base branch fetched from origin',
  'clean-bones/Install': 'npm ci downloads packages (network)',
  'clean-bones/Clean bones': 'runs the full suite in a copy, which this test is part of',
  'dist/Install': 'npm ci downloads packages (network)',
  'container/Build the image': 'docker build pulls the base image (network)',
  'container/Show the image (user, platform, size)': 'needs the image the build step makes',
  'container/Smoke test inside the image (no network, read-only, fake Slack)': 'needs the image the build step makes',
});
// Run only where the tool is there (CI always has it).
const NEEDS_SHELLCHECK = 'test/Shellcheck';

function steps() {
  const doc = YAML.parse(fs.readFileSync(CI, 'utf8'));
  const out = [];
  for (const [job, def] of Object.entries(doc.jobs)) {
    for (const s of def.steps || []) if (s.run) out.push({ key: `${job}/${s.name}`, run: s.run, if: s.if });
  }
  return out;
}

const hasShellcheck = () => {
  const sc = spawnSync('shellcheck', ['--version'], { stdio: 'ignore' });
  const gnuXargs = spawnSync('xargs', ['--no-run-if-empty', 'true'], { input: '', stdio: ['pipe', 'ignore', 'ignore'] });
  return !sc.error && sc.status === 0 && gnuXargs.status === 0;
};

// The env a step gets: this process's, minus any APLABS_* setting, so the
// copy's own .aplabs/profile.yml is what governs (as in a fork's CI).
function stepEnv() {
  const env = { ...process.env, CI: 'true' };
  for (const k of Object.keys(env)) if (k.startsWith('APLABS_')) delete env[k];
  return env;
}

const runStep = (cwd, script) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
  cwd, env: stepEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000,
});

test('ci.yml: the three fixture steps start with the fork guard, and the engine check runs only with a profile', () => {
  const all = steps();
  const keys = all.map((s) => s.key);
  for (const key of Object.keys(NOT_RUN)) assert.ok(keys.includes(key), `NOT_RUN names a step ci.yml no longer has: ${key}`);
  for (const key of FIXTURE_STEPS) {
    const s = all.find((x) => x.key === key);
    assert.ok(s, `missing step ${key}`);
    assert.equal(s.run.split('\n')[0], GUARD, `${key} starts with the fork guard`);
  }
  // Nothing else in ci.yml skips on a missing example.
  assert.equal(all.filter((s) => s.run.includes(GUARD)).length, FIXTURE_STEPS.length);
  const engine = all.find((s) => s.key === ENGINE_STEP);
  assert.ok(engine, 'the engine check step is in the test job');
  assert.match(engine.run, /^if \[ -f \.aplabs\/profile\.yml \]; then\n\s+npm run template:check\n/);
  assert.equal(engine.if, undefined, 'never skipped by a step condition');
  const distStep = all.find((s) => s.key === DIST_STEP);
  assert.ok(distStep, 'the dist job has its check step');
  assert.deepEqual(distStep.run.trim().split('\n'), [DIST_GUARD, 'npm run template:publish -- --check']);
  assert.equal(distStep.if, undefined, 'never skipped by a step condition');
});

test('ci.yml: the dist job is read-only, has no secrets and uses only checkout and setup-node', () => {
  const doc = YAML.parse(fs.readFileSync(CI, 'utf8'));
  const job = doc.jobs.dist;
  assert.ok(job, 'a dist job');
  assert.deepEqual(job.permissions, { contents: 'read' });
  const text = YAML.stringify(job);
  assert.doesNotMatch(text, /secrets\.|\$\{\{/, 'no secrets or expressions');
  const uses = job.steps.filter((s) => s.uses).map((s) => s.uses.split('@')[0]);
  assert.deepEqual(uses, ['actions/checkout', 'actions/setup-node']);
  assert.deepEqual(job.steps.filter((s) => s.run).map((s) => s.name), ['Install', 'Distribution tree builds and passes its tests']);
});

test('the dist guard skips in a fork and in a copy without docs/reference/; the template source runs the step', (t) => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aplabs-dist-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (profile, reference) => {
    fs.rmSync(path.join(dir, '.aplabs'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true });
    if (profile) {
      fs.mkdirSync(path.join(dir, '.aplabs'));
      fs.writeFileSync(path.join(dir, '.aplabs/profile.yml'), 'x: 1\n');
    }
    if (reference) fs.mkdirSync(path.join(dir, 'docs/reference'), { recursive: true });
    const r = runStep(dir, `${DIST_GUARD}\necho ran`);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(at(false, true), 'ran', 'the template source repo');
  assert.equal(at(true, true), 'skipped: not the template source repo', 'a fork');
  assert.equal(at(false, false), 'skipped: not the template source repo', 'the dist repo (no docs/reference/)');
  assert.equal(at(true, false), 'skipped: not the template source repo', 'a fork of the dist repo');
});

test('the fork guard skips only in a fork without the example; the template always runs the step', (t) => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aplabs-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `${GUARD}\necho ran`;
  const at = (profile, example) => {
    fs.rmSync(path.join(dir, '.aplabs'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'examples'), { recursive: true, force: true });
    if (profile) {
      fs.mkdirSync(path.join(dir, '.aplabs'));
      fs.writeFileSync(path.join(dir, '.aplabs/profile.yml'), 'x: 1\n');
    }
    if (example) fs.mkdirSync(path.join(dir, 'examples/brightside'), { recursive: true });
    const r = runStep(dir, script);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(at(true, false), 'skipped: no example client in this fork');
  assert.equal(at(false, true), 'ran', 'the template');
  assert.equal(at(false, false), 'ran', 'no profile: the template, even without the example');
  assert.equal(at(true, true), 'ran', 'a fork that kept the example');
});

// Slow (about 30 s): runs only under `npm run test:slow` (plan ci-split).
test('a clean-bones-style fork copy passes every ci.yml run step that needs no network', { skip: slowSkip(), timeout: 600000 }, (t) => {
  const fork = makeCopyFork('fork');
  t.after(fork.cleanup);
  const { root } = fork;
  assert.ok(fs.existsSync(path.join(root, '.aplabs/profile.yml')));
  assert.ok(!fs.existsSync(path.join(root, 'examples/brightside')));
  const all = steps();
  const engine = all.find((s) => s.key === ENGINE_STEP);

  // Day one, before the record: the engine step fails the fork (review B8).
  const before = runStep(root, engine.run);
  assert.notEqual(before.status, 0, 'a fork with no record fails CI');
  assert.match(before.stderr, /fork without a template record/);

  // The fork records the release it was made from (here a local tag on the copy).
  const git = (args) => execFileSync('git', ['-c', 'user.name=ci-fork', '-c', 'user.email=ci-fork@example.invalid', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['tag', 'v0.0.1']);
  const rec = spawnSync(process.execPath, ['kit/release/check.js', '--record', 'v0.0.1'], { cwd: root, env: stepEnv(), encoding: 'utf8' });
  assert.equal(rec.status, 0, rec.stderr);
  git(['add', '.aplabs/template-version']);
  git(['commit', '-q', '--no-verify', '-m', 'record the template version']);

  const shellcheck = hasShellcheck();
  const ran = [];
  for (const s of all) {
    if (NOT_RUN[s.key]) continue;
    if (s.key === NEEDS_SHELLCHECK && !shellcheck) {
      t.diagnostic(`${s.key}: shellcheck (or GNU xargs) not installed here, not run (CI runs it)`);
      continue;
    }
    assert.doesNotMatch(s.run, /\$\{\{/, `${s.key} uses a GitHub expression: list it in NOT_RUN or drop the expression`);
    const r = runStep(root, s.run);
    assert.equal(r.status, 0, `${s.key} failed in a fork copy:\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
    if (FIXTURE_STEPS.includes(s.key)) assert.match(r.stdout, /^skipped: no example client in this fork$/m, s.key);
    if (s.key === ENGINE_STEP) assert.match(r.stdout, /engine is untouched since v0\.0\.1/);
    if (s.key === DIST_STEP) assert.match(r.stdout, DIST_SKIP, 'the dist job skips in a fork (review B5)');
    ran.push(s.key);
  }
  for (const key of [...FIXTURE_STEPS, ENGINE_STEP, DIST_STEP, 'test/Syntax', 'test/Verify harness']) assert.ok(ran.includes(key), `ran ${key}`);
});
