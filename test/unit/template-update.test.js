'use strict';

// Story 11.6: `npm run template:update -- vX.Y.Z` takes a template release
// into a fork. Every test runs on temp git repos (test/fixtures/temp-git.js,
// makeUpdateRepos): a bare template remote with v1.0.0 (each test adds its
// own v1.1.0), a fork cloned from it with the demo client deleted, its own
// ledger line and the Stub Co client (test/fixtures/fork/), and a bare repo as
// the fork's origin. A fake gh records the PR; injected steps stand in for
// `npm run check && npm test`, `npm ci` and the lockfile regeneration. Nothing
// reaches GitHub or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeUpdateRepos, FORK_LEDGER_LINE, PLANNING_DOC } = require('../fixtures/temp-git');
const { main: update, parseArgs } = require('../../kit/release/update');
const lib = require('../../kit/lib/template');
const { slowSkip } = require('../fixtures/slow');

const BRANCH = 'template/v1.1.0';

// Every test on the temp repos takes 5 s or more, so each is gated by
// slowSkip() and runs only under `npm run test:slow` (plan ci-split). The
// repos are made only when those tests run.
let base;
test.before(() => {
  if (!slowSkip()) base = makeUpdateRepos();
});
test.after(() => base && base.cleanup());

function setup(t) {
  const r = base.copy();
  t.after(r.cleanup);
  return r;
}

// The fake lockfile regeneration: the template's lock with the root entry's
// dependencies set from package.json (what npm would write, minus fetching).
function fakeRegen(calls) {
  return (root) => {
    calls.regen++;
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const file = path.join(root, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    lock.packages[''].dependencies = pkg.dependencies;
    fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
    return { ok: true };
  };
}

function run(r, { version = 'v1.1.0', checks = true, ...deps } = {}) {
  const calls = { checks: 0, ci: 0, regen: 0 };
  const out = [];
  const err = [];
  const code = update([version], r.env, {
    cwd: r.fork,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    runChecks: () => {
      calls.checks++;
      return checks ? { ok: true } : { ok: false, detail: 'exit 1' };
    },
    npmCi: () => {
      calls.ci++;
      return { ok: true };
    },
    regenLock: fakeRegen(calls),
    ...deps,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), calls };
}

// What "the fork is unchanged" means: main, the current branch, a clean tree,
// no update branch here or on origin, and no PR.
function snapshot(r) {
  return {
    main: r.git(r.fork, ['rev-parse', 'refs/heads/main']),
    branch: r.git(r.fork, ['symbolic-ref', '--short', 'HEAD']),
    status: r.git(r.fork, ['status', '--porcelain']),
    branches: r.git(r.fork, ['branch', '--list', 'template/*']),
    originHeads: r.git(r.fork, ['ls-remote', '--heads', 'origin']),
  };
}

function assertUnchanged(r, before) {
  assert.deepEqual(snapshot(r), before);
  assert.ok(!r.ghCalls().some((c) => c.startsWith('pr create')), 'no PR was opened');
}

const show = (r, ref, rel) => r.git(r.fork, ['show', `${ref}:${rel}`]);
const exists = (r, ref, rel) => {
  try {
    r.git(r.fork, ['cat-file', '-e', `${ref}:${rel}`]);
    return true;
  } catch {
    return false;
  }
};
const prBody = (r) => fs.readFileSync(path.join(r.dir, 'pr-body.md'), 'utf8');
const editFile = (root, rel, fn) => fs.writeFileSync(path.join(root, rel), fn(fs.readFileSync(path.join(root, rel), 'utf8')));
const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const writeJson = (root, rel, v) => fs.writeFileSync(path.join(root, rel), `${JSON.stringify(v, null, 2)}\n`);

// The fork appends a dependency on main, as a fork may (AD-1).
function forkAppends(r, name = 'left-pad', spec = '1.3.0') {
  const pkg = readJson(r.fork, 'package.json');
  pkg.dependencies = { ...pkg.dependencies, [name]: spec };
  writeJson(r.fork, 'package.json', pkg);
  r.forkCommit(`fork: append ${name}`);
}

test('parseArgs takes one version', () => {
  assert.deepEqual(parseArgs(['v1.2.3']), { version: 'v1.2.3' });
  assert.match(parseArgs([]).error, /no version/);
  assert.match(parseArgs(['v1.0.0', 'v2.0.0']).error, /one version only/);
  assert.match(parseArgs(['--force']).error, /unknown argument/);
});

test('a clean update: a branch, a merge commit, the record updated and a PR', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  const before = snapshot(r);
  const tagSha = r.release('v1.1.0', (w) => {
    editFile(w, 'README.md', (s) => `${s}\nA line from v1.1.0.\n`);
    fs.writeFileSync(path.join(w, 'kit/lib/template/release-note.md'), 'New in v1.1.0.\n');
  }, { mustDo: ['- Run `npm ci`.'] });
  const res = run(r);
  assert.equal(res.code, 0, res.err);

  // Back on main, main untouched; the branch is pushed to origin.
  assert.equal(r.git(r.fork, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(r.git(r.fork, ['rev-parse', 'refs/heads/main']), before.main);
  assert.equal(r.git(r.fork, ['status', '--porcelain']), '');
  const head = r.git(r.fork, ['rev-parse', `refs/heads/${BRANCH}`]);
  assert.match(r.git(r.fork, ['ls-remote', '--heads', 'origin', BRANCH]), new RegExp(head));
  // A merge commit of main and the tag.
  assert.deepEqual(r.git(r.fork, ['rev-list', '--parents', '-n', '1', head]).split(' ').slice(1), [before.main, tagSha]);
  assert.match(show(r, BRANCH, 'README.md'), /A line from v1\.1\.0\./);
  assert.equal(show(r, BRANCH, 'kit/lib/template/release-note.md'), 'New in v1.1.0.');
  // The record names v1.1.0 and its engine.
  const record = show(r, BRANCH, lib.RECORD_REL);
  assert.match(record, /^version: v1\.1\.0$/m);
  assert.match(record, new RegExp(`^engine_sha256: ${lib.refFingerprint(r.fork, 'refs/tags/v1.1.0').sha256}$`, 'm'));
  // Checks ran once; the lockfile did not change, so no npm ci.
  assert.deepEqual(res.calls, { checks: 1, ci: 0, regen: 0 });

  const call = r.ghCalls().find((c) => c.startsWith('pr create'));
  assert.ok(call, 'gh opened a PR');
  assert.match(call, /--base main --head template\/v1\.1\.0/);
  const body = prBody(r);
  assert.match(body, /^\*\*What this does:\*\* .*v1\.1\.0.*v1\.0\.0/);
  assert.match(body, /^Kind: infra$/m);
  assert.match(body, /\(CHANGELOG\.md#v110\)/);
  assert.match(body, /- Run `npm ci`\./);
  assert.match(body, /Deleted on purpose by this fork since v1\.0\.0 \(derived from what it deleted\): `examples(\/demo)?`, `profiles\/demo`\./);
});

test('a fork that edited a kit/ file is refused, naming it', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  editFile(r.fork, 'kit/lib/fork/index.js', (s) => `${s}// a fork's edit\n`);
  r.forkCommit('fork: edit the engine');
  r.release('v1.1.0', (w) => editFile(w, 'README.md', (s) => `${s}\nmore\n`));
  const before = snapshot(r);
  const res = run(r);
  assert.equal(res.code, 1);
  assert.match(res.err, /the fork edited the engine since v1\.0\.0/);
  assert.match(res.err, /kit\/lib\/fork\/index\.js \(changed\)/);
  assertUnchanged(r, before);
  assert.equal(res.calls.checks, 0);
});

test('a deleted example file changed upstream stays deleted (a conflict, resolved)', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  r.release('v1.1.0', (w) => editFile(w, 'examples/demo/README.md', (s) => `${s}Changed upstream.\n`));
  const res = run(r);
  assert.equal(res.code, 0, res.err);
  assert.ok(!exists(r, BRANCH, 'examples/demo/README.md'));
  const body = prBody(r);
  assert.match(body, /`examples\/demo\/README\.md`: kept deleted \(the fork deleted it on purpose\)/);
  assert.match(body, /Removed again[^]*- `examples\/demo\/README\.md`/);
});

test('a new upstream file under the deleted example stays absent', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  r.release('v1.1.0', (w) => r.write(w, 'examples/demo/app/hubs/new.json', '{ "id": "new" }\n'));
  const res = run(r);
  assert.equal(res.code, 0, res.err);
  assert.ok(!exists(r, BRANCH, 'examples/demo/app/hubs/new.json'));
  assert.match(prBody(r), /Removed again[^]*- `examples\/demo\/app\/hubs\/new\.json`/);
});

test('the fork\'s ledger is kept on a conflict', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  r.release('v1.1.0', (w) => editFile(w, 'docs/ledger.md', (s) => `<!-- upstream's line -->\n${s}`));
  const res = run(r);
  assert.equal(res.code, 0, res.err);
  assert.equal(show(r, BRANCH, 'docs/ledger.md'), show(r, 'main', 'docs/ledger.md'));
  assert.ok(show(r, BRANCH, 'docs/ledger.md').startsWith(FORK_LEDGER_LINE));
  assert.match(prBody(r), /`docs\/ledger\.md`: kept the fork's version \(fork-owned\)/);
});

test('a clean upstream edit to the ledger or planning docs is not applied', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  const planning = PLANNING_DOC.path; // the fixture's own, never this repo's
  r.release('v1.1.0', (w) => {
    editFile(w, 'docs/ledger.md', (s) => `${s}\nA clean upstream line.\n`);
    editFile(w, planning, (s) => `${s}\nA clean upstream line.\n`);
    r.write(w, 'docs/planning/new-upstream-plan.md', 'A plan.\n');
  });
  const res = run(r);
  assert.equal(res.code, 0, res.err);
  assert.equal(show(r, BRANCH, 'docs/ledger.md'), show(r, 'main', 'docs/ledger.md'));
  assert.equal(show(r, BRANCH, planning), show(r, 'main', planning));
  assert.ok(!exists(r, BRANCH, 'docs/planning/new-upstream-plan.md'));
  const body = prBody(r);
  assert.match(body, /Kept as on the fork's main[^]*- `docs\/ledger\.md`/);
  assert.ok(body.includes(`- \`${planning}\``));
  assert.match(body, /- `docs\/planning\/new-upstream-plan\.md`/);
});

test('an upstream file under .aplabs/ or the app dir aborts with the fork unchanged', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  r.release('v1.1.0', (w) => {
    r.write(w, '.aplabs/extra.yml', 'x: 1\n');
    r.write(w, 'app/hubs/upstream.json', '{ "id": "upstream" }\n');
  });
  const before = snapshot(r);
  const res = run(r);
  assert.equal(res.code, 1);
  assert.match(res.err, /aborted the update to v1\.1\.0; the fork is unchanged and back on main/);
  assert.match(res.err, /\.aplabs\/extra\.yml/);
  assert.match(res.err, /app\/hubs\/upstream\.json/);
  assertUnchanged(r, before);
  assert.equal(res.calls.checks, 0);
});

test('an upstream file under APLABS_APP_DIR aborts too', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  r.release('v1.1.0', (w) => r.write(w, 'client-app/hubs/upstream.json', '{ "id": "upstream" }\n'));
  const before = snapshot(r);
  const calls = [];
  const code = update(['v1.1.0'], { ...r.env, APLABS_APP_DIR: 'client-app' }, {
    cwd: r.fork, out: () => {}, err: (s) => calls.push(s), runChecks: () => ({ ok: true }),
  });
  assert.equal(code, 1);
  assert.match(calls.join('\n'), /app dir app\/, client-app\/[^]*client-app\/hubs\/upstream\.json/);
  assertUnchanged(r, before);
});

test('a fork that changed package.json beyond appending is refused when the release changes it', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  const pkg = readJson(r.fork, 'package.json');
  pkg.scripts.start = 'node my-own-start.js';
  writeJson(r.fork, 'package.json', pkg);
  r.forkCommit('fork: edit a script');
  r.release('v1.1.0', (w) => {
    const p = readJson(w, 'package.json');
    p.dependencies.yaml = '9.9.9';
    writeJson(w, 'package.json', p);
  });
  const before = snapshot(r);
  const res = run(r);
  assert.equal(res.code, 1);
  assert.match(res.err, /the fork changed package\.json beyond appending dependencies: package\.json: field "scripts" was changed/);
  assertUnchanged(r, before);
});

test('a fork-appended dependency survives an upstream bump of another', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  forkAppends(r);
  r.release('v1.1.0', (w) => {
    const pkg = readJson(w, 'package.json');
    pkg.dependencies.yaml = '9.9.9';
    writeJson(w, 'package.json', pkg);
    const lock = readJson(w, 'package-lock.json');
    lock.packages[''].dependencies.yaml = '9.9.9';
    writeJson(w, 'package-lock.json', lock);
  });
  const res = run(r);
  assert.equal(res.code, 0, res.err);
  const pkg = JSON.parse(show(r, BRANCH, 'package.json'));
  assert.equal(pkg.dependencies.yaml, '9.9.9');
  assert.equal(pkg.dependencies['left-pad'], '1.3.0');
  assert.deepEqual(Object.keys(pkg.dependencies), [...Object.keys(pkg.dependencies)].sort());
  const lock = JSON.parse(show(r, BRANCH, 'package-lock.json'));
  assert.equal(lock.packages[''].dependencies['left-pad'], '1.3.0');
  assert.equal(lock.packages[''].dependencies.yaml, '9.9.9');
  // The lock was regenerated and changed, so npm ci ran before the checks.
  assert.deepEqual(res.calls, { checks: 1, ci: 1, regen: 1 });
  const body = prBody(r);
  assert.match(body, /`package\.json`: the template's, with the fork's appended dependencies re-applied \(left-pad 1\.3\.0\)/);
  assert.match(body, /`package-lock\.json`: the template's, regenerated with `npm install --package-lock-only --ignore-scripts`/);
});

test('a fork-appended dependency the template now ships aborts with nothing changed', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  forkAppends(r);
  r.release('v1.1.0', (w) => {
    const pkg = readJson(w, 'package.json');
    pkg.dependencies['left-pad'] = '1.3.0';
    writeJson(w, 'package.json', pkg);
  });
  const before = snapshot(r);
  const res = run(r);
  assert.equal(res.code, 1);
  assert.match(res.err, /the fork appended left-pad \(dependencies\), which the template now ships itself/);
  assertUnchanged(r, before);
  assert.deepEqual(res.calls, { checks: 0, ci: 0, regen: 0 });
});

test('any other conflict aborts, restores main and leaves the fork as it was', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  editFile(r.fork, 'README.md', (s) => `Fork's first line.\n${s}`);
  r.forkCommit('fork: edit the README');
  r.release('v1.1.0', (w) => editFile(w, 'README.md', (s) => `Upstream's first line.\n${s}`));
  const before = snapshot(r);
  const res = run(r);
  assert.equal(res.code, 1);
  assert.match(res.err, /conflicts with the fork outside the files an update resolves/);
  assert.match(res.err, /README\.md/);
  assertUnchanged(r, before);
});

test('failing checks: the branch is kept, nothing pushed, no PR', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  r.release('v1.1.0', (w) => editFile(w, 'README.md', (s) => `${s}\nmore\n`));
  const before = snapshot(r);
  const res = run(r, { checks: false });
  assert.equal(res.code, 1);
  assert.match(res.err, /npm run check && npm test failed on template\/v1\.1\.0/);
  assert.match(res.err, /Kept the branch template\/v1\.1\.0 \(not pushed\), opened no PR, and returned to main/);
  assert.equal(r.git(r.fork, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(r.git(r.fork, ['rev-parse', 'refs/heads/main']), before.main);
  assert.ok(r.git(r.fork, ['rev-parse', `refs/heads/${BRANCH}`]));
  assert.equal(r.git(r.fork, ['ls-remote', '--heads', 'origin', BRANCH]), '');
  assert.ok(!r.ghCalls().some((c) => c.startsWith('pr create')));
});

test('an injected 1-to-2 migration upgrades the profile, keeping its comments', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  r.release('v1.1.0', (w) => {
    const schema = readJson(w, 'profiles/_schema/profile.schema.json');
    schema.properties.schema_version = { const: 2 };
    schema.properties.note = { type: 'string' };
    writeJson(w, 'profiles/_schema/profile.schema.json', schema);
  });
  const steps = { 1: (doc) => doc.set('note', 'added by step 1') };
  const res = run(r, { migrationSteps: () => steps });
  assert.equal(res.code, 0, res.err);
  const profile = show(r, BRANCH, '.aplabs/profile.yml');
  assert.match(profile, /^schema_version: 2$/m);
  assert.match(profile, /^note: added by step 1$/m);
  assert.match(profile, /^# A minimal stub fork profile \(Story 6\.5\)/);
  assert.match(profile, /^# Story 11\.3 \(two forks\)/m);
  const body = prBody(r);
  assert.match(body, /Migrated `\.aplabs\/profile\.yml` \(steps from schema_version 1\)/);
  assert.match(body, /```diff[^]*-schema_version: 1[^]*\+schema_version: 2[^]*```/);
});

test('a migration whose result fails the new schema aborts with the fork unchanged', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  r.release('v1.1.0', (w) => {
    const schema = readJson(w, 'profiles/_schema/profile.schema.json');
    schema.properties.schema_version = { const: 2 };
    writeJson(w, 'profiles/_schema/profile.schema.json', schema);
  });
  const before = snapshot(r);
  const res = run(r, { migrationSteps: () => ({ 1: (doc) => doc.set('not_in_the_schema', true) }) });
  assert.equal(res.code, 1);
  assert.match(res.err, /the migrated \.aplabs\/profile\.yml does not pass v1\.1\.0's schema/);
  assertUnchanged(r, before);
});

test('a fork whose profile schema_version is newer than the template\'s is refused', { skip: slowSkip() }, (t) => {
  const r = setup(t);
  editFile(r.fork, '.aplabs/profile.yml', (s) => s.replace('schema_version: 1', 'schema_version: 2'));
  r.forkCommit('fork: a newer schema version');
  r.release('v1.1.0', (w) => editFile(w, 'README.md', (s) => `${s}\nmore\n`));
  const before = snapshot(r);
  const res = run(r);
  assert.equal(res.code, 1);
  assert.match(res.err, /the fork's profile schema_version 2 is newer than v1\.1\.0's \(1\)/);
  assertUnchanged(r, before);
});

test('refusals before anything changes: no upstream, dirty, off main, behind origin, not newer', { skip: slowSkip() }, async (t) => {
  await t.test('no upstream remote', (t2) => {
    const r = setup(t2);
    r.release('v1.1.0');
    r.git(r.fork, ['remote', 'remove', 'upstream']);
    const before = snapshot(r);
    const res = run(r);
    assert.equal(res.code, 1);
    assert.match(res.err, /there is no `upstream` remote/);
    assertUnchanged(r, before);
  });
  await t.test('a dirty tree', (t2) => {
    const r = setup(t2);
    r.release('v1.1.0');
    r.write(r.fork, 'stray.txt', 'x\n');
    const res = run(r);
    assert.equal(res.code, 1);
    assert.match(res.err, /the worktree is not clean/);
    assert.equal(r.git(r.fork, ['branch', '--list', 'template/*']), '');
  });
  await t.test('not on main', (t2) => {
    const r = setup(t2);
    r.release('v1.1.0');
    r.git(r.fork, ['switch', '-q', '-c', 'feature']);
    const before = snapshot(r);
    const res = run(r);
    assert.equal(res.code, 1);
    assert.match(res.err, /not on main \(on feature\)/);
    assertUnchanged(r, before);
  });
  await t.test('local main behind origin/main', (t2) => {
    const r = setup(t2);
    r.release('v1.1.0');
    r.write(r.fork, 'docs/fork-note.md', 'x\n');
    r.forkCommit('fork: a note');
    r.git(r.fork, ['reset', '-q', '--hard', 'HEAD~1']);
    const before = snapshot(r);
    const res = run(r);
    assert.equal(res.code, 1);
    assert.match(res.err, /the local main [0-9a-f]{12} is not origin\/main [0-9a-f]{12}/);
    assertUnchanged(r, before);
  });
  await t.test('a version not newer than the record', (t2) => {
    const r = setup(t2);
    const res = run(r, { version: 'v1.0.0' });
    assert.equal(res.code, 1);
    assert.match(res.err, /v1\.0\.0 is not newer than the recorded v1\.0\.0/);
  });
  await t.test('the template (no profile) is not a fork', (t2) => {
    const r = setup(t2);
    const err = [];
    const code = update(['v1.1.0'], r.env, { cwd: r.work, out: () => {}, err: (s) => err.push(s) });
    assert.equal(code, 1);
    assert.match(err.join('\n'), /this is not a fork \(no \.aplabs\/profile\.yml\)/);
  });
});

test('packagePlan: re-applies appended dependencies, refuses other edits and shipped names', () => {
  const recordedPkg = { name: 'x', scripts: { a: 'b' }, dependencies: { ajv: '1', yaml: '1' } };
  const templatePkg = { name: 'x', scripts: { a: 'c' }, dependencies: { ajv: '1', yaml: '2' } };
  const ok = lib.packagePlan({ recordedPkg, forkPkg: { ...recordedPkg, dependencies: { ...recordedPkg.dependencies, 'left-pad': '1.3.0' } }, templatePkg });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.pkg, { name: 'x', scripts: { a: 'c' }, dependencies: { ajv: '1', 'left-pad': '1.3.0', yaml: '2' } });
  const edited = lib.packagePlan({ recordedPkg, forkPkg: { ...recordedPkg, scripts: { a: 'mine' } }, templatePkg });
  assert.match(edited.problems[0], /beyond appending dependencies: package\.json: field "scripts" was changed/);
  const shipped = lib.packagePlan({ recordedPkg, forkPkg: { ...recordedPkg, dependencies: { ...recordedPkg.dependencies, zod: '3' } }, templatePkg: { ...templatePkg, dependencies: { ...templatePkg.dependencies, zod: '4' } } });
  assert.match(shipped.problems[0], /appended zod \(dependencies\), which the template now ships itself/);
});

test('changelogEntry reads the "What a fork must do" lines', () => {
  const text = '# C\n\n## v1.1.0\n\n### What changed\n\n- a\n\n### What a fork must do\n\n- run b\n- run c\n\n## v1.0.0\n\n### What a fork must do\n\n- old\n';
  assert.deepEqual(lib.changelogEntry(text, 'v1.1.0').forkMustDo, ['- run b', '- run c']);
  assert.equal(lib.changelogEntry(text, 'v2.0.0').found, false);
  assert.equal(lib.changelogAnchor('v1.1.0'), 'v110');
});
