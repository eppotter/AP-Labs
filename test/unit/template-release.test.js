'use strict';

// Story 11.5: `npm run template:release -- vX.Y.Z [--push]`. Every test runs on
// temp git repos (a bare "origin" and a clone) with a fake gh: nothing reaches
// GitHub, and no tag is created anywhere but in the temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTemplate, PASSING_RUNS, REPO } = require('../fixtures/temp-git');
const lib = require('../../kit/lib/template');
const { parseArgs } = require('../../kit/release/release');

const RELEASE = 'kit/release/release.js';

// A template whose newest tag is v0.1.0 (here and on origin), with a v0.2.0
// changelog entry committed and pushed, and a fake gh where every check passed.
// Built once; each test gets its own copy.
let base;
test.before(() => {
  const r = makeTemplate();
  r.git(r.work, ['tag', '-a', 'v0.1.0', '-m', 'v0.1.0']);
  r.git(r.work, ['push', '-q', 'origin', 'refs/tags/v0.1.0']);
  const log = fs.readFileSync(path.join(r.work, 'CHANGELOG.md'), 'utf8')
    .replace('## v0.1.0', '## v0.2.0\n\n### What changed\n\n- Runtime.\n\n### What a fork must do\n\n- Take the update.\n\n## v0.1.0');
  r.write(r.work, 'CHANGELOG.md', log);
  r.commit(r.work, 'changelog: v0.2.0');
  r.git(r.work, ['push', '-q', 'origin', 'main']);
  r.fakeGh();
  base = r;
});
test.after(() => base && base.cleanup());

function ready(t) {
  const r = base.copy();
  t.after(r.cleanup);
  return r;
}

const release = (r, args, cwd = r.work) => r.run(RELEASE, args, cwd);
const remoteTags = (r) => r.git(r.work, ['ls-remote', '--tags', '--refs', 'origin']);
const localTag = (r, v) => r.git(r.work, ['tag', '--list', v]);

function refused(res, pattern) {
  assert.equal(res.code, 1, `expected a refusal; stdout: ${res.stdout} stderr: ${res.stderr}`);
  assert.match(res.stderr, /refusing to release/);
  assert.match(res.stderr, pattern);
}

test('a passing release creates the annotated tag on main\'s head, locally only, and leaves package.json alone', (t) => {
  const r = ready(t);
  const head = r.git(r.work, ['rev-parse', 'HEAD']);
  const res = release(r, ['v0.2.0']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /tagged v0\.2\.0 on main/);
  assert.match(res.stdout, /not pushed/);
  assert.equal(r.git(r.work, ['cat-file', '-t', 'v0.2.0']), 'tag', 'an annotated tag');
  assert.equal(r.git(r.work, ['rev-parse', 'v0.2.0^{commit}']), head);
  assert.doesNotMatch(remoteTags(r), /v0\.2\.0/, 'nothing is pushed without --push');
  assert.equal(r.git(r.work, ['status', '--porcelain']), '', 'the command writes no file');
  const calls = r.ghCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `api repos/{owner}/{repo}/commits/${head}/check-runs?per_page=100`);
});

test('--push pushes only that tag to origin', (t) => {
  const r = ready(t);
  r.git(r.work, ['tag', 'unrelated-local-tag']);
  const res = release(r, ['v0.2.0', '--push']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /pushed v0\.2\.0 to origin/);
  const tags = remoteTags(r);
  assert.match(tags, /refs\/tags\/v0\.2\.0$/m);
  assert.doesNotMatch(tags, /unrelated-local-tag/, 'never --tags');
});

test('refuses in a fork (a repo with .aplabs/profile.yml)', (t) => {
  const r = ready(t);
  const fork = r.cloneFork();
  r.git(fork, ['push', '-q', 'origin', 'main']);
  const res = release(r, ['v0.2.0'], fork);
  refused(res, /this is a fork/);
  assert.equal(r.git(fork, ['tag', '--list', 'v0.2.0']), '');
});

test('refuses a dirty worktree, naming it, and creates no tag', (t) => {
  const r = ready(t);
  r.write(r.work, 'notes.txt', 'scratch\n');
  refused(release(r, ['v0.2.0']), /worktree is not clean/);
  assert.equal(localTag(r, 'v0.2.0'), '');
});

test('refuses off main', (t) => {
  const r = ready(t);
  r.git(r.work, ['checkout', '-q', '-b', 'feat/x']);
  refused(release(r, ['v0.2.0']), /not on main \(on feat\/x\)/);
});

test('refuses when the local head is not origin/main (behind or ahead)', (t) => {
  const r = ready(t);
  // Someone else pushes to main.
  const other = path.join(r.dir, 'other');
  r.git(r.dir, ['clone', '-q', r.bare, other]);
  r.write(other, 'README.md', 'changed\n');
  r.commit(other, 'other');
  r.git(other, ['push', '-q', 'origin', 'main']);
  refused(release(r, ['v0.2.0']), /local head \w+ is not origin\/main/);
  assert.equal(localTag(r, 'v0.2.0'), '');
  assert.ok(!r.ghCalls().length, 'checks are not read for a head that is not origin\'s');
});

test('refuses a version that is not vX.Y.Z', (t) => {
  const r = ready(t);
  for (const v of ['0.2.0', 'v01.2.0', 'v0.2.0-rc.1']) {
    refused(release(r, [v]), /not a version/);
  }
});

test('refuses a version not higher than the newest tag', (t) => {
  const r = ready(t);
  refused(release(r, ['v0.0.9']), /not higher than the newest tag, v0\.1\.0/);
});

test('refuses a tag that already exists on origin, even when it is not here', (t) => {
  const r = ready(t);
  const other = path.join(r.dir, 'other');
  r.git(r.dir, ['clone', '-q', r.bare, other]);
  r.git(other, ['tag', '-a', 'v0.2.0', '-m', 'early']);
  r.git(other, ['push', '-q', 'origin', 'refs/tags/v0.2.0']);
  assert.equal(localTag(r, 'v0.2.0'), '');
  refused(release(r, ['v0.2.0']), /the tag v0\.2\.0 already exists on origin/);
  assert.equal(localTag(r, 'v0.2.0'), '');
});

test('refuses a tag that already exists here', (t) => {
  const r = ready(t);
  r.git(r.work, ['tag', '-a', 'v0.2.0', '-m', 'local']);
  refused(release(r, ['v0.2.0']), /already exists here/);
});

test('refuses with no changelog entry, or one missing a section; never writes the changelog', (t) => {
  const r = ready(t);
  const before = fs.readFileSync(path.join(r.work, 'CHANGELOG.md'), 'utf8');
  refused(release(r, ['v0.3.0']), /CHANGELOG\.md has no "## v0\.3\.0" entry/);
  assert.equal(fs.readFileSync(path.join(r.work, 'CHANGELOG.md'), 'utf8'), before);

  r.write(r.work, 'CHANGELOG.md', before.replace('### What a fork must do\n\n- Take the update.\n', ''));
  r.commit(r.work, 'drop a section');
  r.git(r.work, ['push', '-q', 'origin', 'main']);
  refused(release(r, ['v0.2.0']), /v0\.2\.0 entry has no "### What a fork must do" section/);
});

test('refuses when a check failed, is still running, or a named job is missing', (t) => {
  const cases = [
    [[...PASSING_RUNS.slice(0, 2), { name: 'container', status: 'completed', conclusion: 'failure' }], /not every check on main's head passed: container \(failure\)/],
    [[...PASSING_RUNS, { name: 'lint', status: 'in_progress', conclusion: null }], /lint \(in_progress\)/],
    [PASSING_RUNS.filter((c) => c.name !== 'container'), /the "container" check is missing/],
    [PASSING_RUNS.filter((c) => c.name !== 'clean-bones'), /the "clean-bones" check is missing/],
    [[], /no checks are reported on main's head/],
  ];
  const r = ready(t);
  for (const [runs, pattern] of cases) {
    r.fakeGh(runs);
    refused(release(r, ['v0.2.0']), pattern);
    assert.equal(localTag(r, 'v0.2.0'), '');
  }
});

test('refuses when gh fails', (t) => {
  const r = ready(t);
  r.fakeGh(PASSING_RUNS, { exit: 1 });
  refused(release(r, ['v0.2.0']), /could not read the checks on main's head with gh/);
});

test('names every reason at once', (t) => {
  const r = ready(t);
  r.write(r.work, 'notes.txt', 'scratch\n');
  r.fakeGh(PASSING_RUNS.filter((c) => c.name !== 'test'));
  const res = release(r, ['v0.0.1']);
  refused(res, /worktree is not clean/);
  assert.match(res.stderr, /not higher than the newest tag/);
  assert.match(res.stderr, /no "## v0\.0\.1" entry/);
  assert.match(res.stderr, /the "test" check is missing/);
});

test('usage errors exit 2', (t) => {
  const r = ready(t);
  assert.equal(release(r, []).code, 2);
  assert.equal(release(r, ['v0.2.0', '--force']).code, 2);
  assert.equal(release(r, ['v0.2.0', 'v0.3.0']).code, 2);
  assert.deepEqual(parseArgs(['v1.0.0', '--push']), { version: 'v1.0.0', push: true });
});

test('checkRunProblems: a required job must succeed; other checks may be skipped', () => {
  assert.deepEqual(lib.checkRunProblems([...PASSING_RUNS, { name: 'docs', status: 'completed', conclusion: 'skipped' }]), []);
  const skippedRequired = PASSING_RUNS.map((c) => (c.name === 'test' ? { ...c, conclusion: 'skipped' } : c));
  assert.deepEqual(lib.checkRunProblems(skippedRequired), ['the "test" check did not succeed on main\'s head']);
  assert.deepEqual(lib.REQUIRED_JOBS, ['test', 'clean-bones', 'container']);
});

test('versions compare as numbers', () => {
  assert.equal(lib.newestVersion(['v0.9.0', 'v0.10.0', 'v0.2.0', 'other']), 'v0.10.0');
  assert.equal(lib.newestVersion([]), null);
  assert.ok(lib.compareVersions('v1.0.0', 'v0.99.99') > 0);
});

test('the template\'s CHANGELOG.md has v0.1.0, an Unreleased section and the release checklist (N7)', () => {
  const text = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
  assert.deepEqual(lib.changelogProblems(text, 'v0.1.0'), []);
  assert.match(text, /^## Unreleased$/m);
  assert.match(text, /^## Release checklist$/m);
  assert.match(text, /re-pin the base image digest/i);
  assert.ok(text.indexOf('## Unreleased') < text.indexOf('## v0.1.0'), 'newest first');
});

test('AGENTS.md: the Orchestrator never pushes release tags (Q14)', () => {
  const text = fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('The Orchestrator never passes `--push` to `template:release` and never runs `git push --tags`.'));
});
