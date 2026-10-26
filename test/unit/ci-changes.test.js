'use strict';

// Plan ci-save-minutes: scripts/ci-changes.js decides which CI jobs a run
// needs, and ci.yml's triggers, concurrency and job conditions use it. Only a
// pull request is ever narrowed; everything else runs every job, so
// template:release always finds the four required jobs green on main's head.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const YAML = require('yaml');
const ch = require('../../scripts/ci-changes');
const { REQUIRED_JOBS } = require('../../kit/lib/template');

const REPO = path.resolve(__dirname, '../..');
const CI = YAML.parse(fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8'));
const CODE_IF = "needs.changes.outputs.code == 'true'";
const CONTAINER_IF = "needs.changes.outputs.container == 'true'";

test('a run that is not a pull request runs every job', () => {
  for (const event of ['push', 'workflow_dispatch', undefined, 'schedule']) {
    const p = ch.plan(event, ['docs/x.md']);
    assert.equal(p.code, true, String(event));
    assert.equal(p.container, true, String(event));
  }
});

test('a pull request with no listed files runs every job', () => {
  assert.deepEqual([ch.plan('pull_request', []).code, ch.plan('pull_request', []).container], [true, true]);
  assert.deepEqual([ch.plan('pull_request', null).code, ch.plan('pull_request', null).container], [true, true]);
});

test('docs-only: every file under docs/ and the review tool calls it docs only', () => {
  assert.equal(ch.isCiDocsOnly(['docs/ledger.md', 'docs/planning/x.md', 'docs/reference/dist-deny.txt']), true);
  const p = ch.plan('pull_request', ['docs/ledger.md', 'docs/PLAN-v1.md']);
  assert.equal(p.code, false);
  assert.equal(p.container, false, 'docs/ is kept out of the image');
});

test('a Markdown file outside docs/ is code: code reads it', () => {
  for (const f of ['CHANGELOG.md', 'README.md', 'kit/templates/job.md', 'profiles/brightside/context/data.md',
    'test/fixtures/llm/context/org.md', 'examples/brightside-install/README.md']) {
    assert.equal(ch.isCiDocsOnly(['docs/ledger.md', f]), false, f);
  }
});

test('a protected path is never docs-only, even under docs/', () => {
  assert.equal(ch.isCiDocsOnly(['docs/ledger.md', 'docs/.github/x.md']), false);
  assert.equal(ch.isCiDocsOnly(['docs/ledger.md', 'AGENTS.md']), false);
});

test('the container runs for any image input and skips for files kept out of the image', () => {
  for (const f of ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'kit/runtime/app/index.js',
    'scripts/container-smoke.js', 'examples/brightside/app/x.js', 'profiles/brightside/profile.yml',
    'test/fixtures/llm/context/org.md', '.github/workflows/ci.yml', 'some-new-dir/x.js', '.gitignore']) {
    assert.equal(ch.isContainerInput(f), true, f);
  }
  for (const f of ['docs/ledger.md', 'test/unit/x.test.js', 'test/acceptance/a.test.js', '.claude/agents/builder.md',
    '.agents/skills/x.md', '_bmad/x', '.codex/config.toml', '.github/CODEOWNERS', 'README.md', 'CHANGELOG.md']) {
    assert.equal(ch.isContainerInput(f), false, f);
  }
  // A PR touching only unit tests: code, no image.
  const p = ch.plan('pull_request', ['test/unit/x.test.js', 'docs/ledger.md']);
  assert.deepEqual([p.code, p.container], [true, false]);
  // A runtime-only PR: everything.
  const r = ch.plan('pull_request', ['kit/runtime/app/index.js', 'docs/ledger.md']);
  assert.deepEqual([r.code, r.container], [true, true]);
});

test('every folder the container check ignores is kept out by .dockerignore', () => {
  const lines = new Set(fs.readFileSync(path.join(REPO, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim()));
  for (const d of ch.CONTAINER_IGNORED_DIRS) assert.ok(lines.has(d), `.dockerignore keeps out ${d}`);
  // The smoke run mounts the fixtures, so they stay an input.
  const smoke = CI.jobs.container.steps.map((s) => s.run || '').join('\n');
  assert.match(smoke, /\$PWD\/test\/fixtures:/);
  assert.ok(ch.CONTAINER_INPUTS.includes('test/fixtures/'));
});

// --- main() against a real merge commit ------------------------------------

function mergeRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-ci-changes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'pr');
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'y\n');
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'pr');
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'main.txt'), 'moved on\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'main moved');
  git('merge', '-q', '--no-ff', '--no-edit', 'pr');
  return dir;
}

function runMain(env, cwd) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/ci-changes.js')], { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, err: r.stderr };
}

test('main: a docs-only PR merge commit prints code=false container=false', (t) => {
  const dir = mergeRepo(t, ['docs/a.md']);
  const { out, err } = runMain({ GITHUB_EVENT_NAME: 'pull_request' }, dir);
  assert.equal(out, 'code=false\ncontainer=false\n');
  assert.match(err, /docs only/);
});

test('main: lists the PR\'s files, not what main changed meanwhile', (t) => {
  const dir = mergeRepo(t, ['test/unit/x.test.js']);
  assert.equal(runMain({ GITHUB_EVENT_NAME: 'pull_request' }, dir).out, 'code=true\ncontainer=false\n');
});

test('main: no merge commit or no git repo runs everything, and never fails', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-ci-changes-nogit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { out, err } = runMain({ GITHUB_EVENT_NAME: 'pull_request' }, dir);
  assert.equal(out, 'code=true\ncontainer=true\n');
  assert.match(err, /could not list/);
});

test('main: a push runs everything', (t) => {
  const dir = mergeRepo(t, ['docs/a.md']);
  assert.equal(runMain({ GITHUB_EVENT_NAME: 'push' }, dir).out, 'code=true\ncontainer=true\n');
});

// --- the workflow shape -----------------------------------------------------

// Plan ledger-rows (AC6): PRs land without main merged in, so every push to
// main runs every job again (#205 had limited it to CHANGELOG.md pushes).
test('ci.yml: every PR runs, every push to main runs, and so does a run by hand', () => {
  assert.ok('pull_request' in CI.on);
  assert.equal(CI.on.pull_request, null, 'no path or branch filter on pull requests');
  assert.deepEqual(CI.on.push, { branches: ['main'] }, 'no path filter on main: every push runs');
  assert.ok('workflow_dispatch' in CI.on);
});

test('a push to main runs every job, whatever it changed', () => {
  for (const files of [['docs/a.md'], ['CHANGELOG.md'], ['kit/a.js'], ['docs/ledger/builds/feat-x.md'], [], null]) {
    const p = ch.plan('push', files);
    assert.deepEqual([p.code, p.container], [true, true], JSON.stringify(files));
  }
});

test('ci.yml: a PR cancels its superseded run; any other run has its own group and is never cancelled', () => {
  assert.match(CI.concurrency.group, /github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| github\.run_id/);
  assert.equal(CI.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
});

test('ci.yml: the changes job gates clean-bones, dist and container; the test job always runs', () => {
  const ch = CI.jobs.changes;
  assert.ok(ch, 'a changes job');
  assert.equal(ch.if, undefined, 'never skipped');
  assert.deepEqual(ch.permissions, { contents: 'read' });
  assert.equal(ch.steps.find((s) => s.name === 'Changed files').run, 'node scripts/ci-changes.js >> "$GITHUB_OUTPUT"');
  assert.doesNotMatch(JSON.stringify(ch), /secrets\./);
  assert.equal(CI.jobs.test.if, undefined, 'the test job runs on every PR');
  assert.equal(CI.jobs['clean-bones'].if, CODE_IF);
  assert.equal(CI.jobs.dist.if, CODE_IF);
  assert.equal(CI.jobs.container.if, CONTAINER_IF);
  for (const job of REQUIRED_JOBS) assert.ok(CI.jobs[job], `the release's required job ${job} is still in ci.yml`);
  for (const [name, job] of Object.entries(CI.jobs)) assert.ok(job['timeout-minutes'] > 0, `${name} has a timeout`);
  // The ledger check and every other step of the test job run unconditionally.
  const conditioned = CI.jobs.test.steps.filter((s) => s.if).map((s) => s.name);
  assert.deepEqual(conditioned, ['Slow tests (fork copy, template update)', 'Ledger row']);
});
