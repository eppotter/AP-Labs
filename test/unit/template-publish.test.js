'use strict';

// Plan template-dist, Story D.2: `npm run template:publish -- vX.Y.Z [--first]
// [--push]` and `-- --check`. Every test runs on temp git repos
// (test/fixtures/temp-git.js, makePublishRepos): a bare source origin with a
// work clone and annotated tags, and an empty bare dist remote added with
// --no-tags. Nothing reaches GitHub or the network. The deny words are made up.

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makePublishRepos } = require('../fixtures/temp-git');
const { main: publish, parseArgs, pushCommand, IDENTITY } = require('../../kit/release/publish');
const { main: update } = require('../../kit/release/update');
const lib = require('../../kit/lib/template');
const dist = require('../../kit/lib/dist');

// base: v1.0.0 tagged, an empty dist. published: base with v1.0.0 published
// to dist with --first and pushed (each test that needs it skips that second).
let base;
let published;
test.before(() => {
  base = makePublishRepos();
  published = base.copy();
  const res = publish(['v1.0.0', '--first', '--push'], published.env, { cwd: published.work, out: () => {}, err: (s) => { throw new Error(s); } });
  if (res !== 0) throw new Error('could not publish v1.0.0 for the published base');
});
test.after(() => {
  if (published) published.cleanup();
  if (base) base.cleanup();
});

// Each test's own copy (of base, or of published).
function setup(t, from = base) {
  const r = from.copy();
  t.after(r.cleanup);
  return r;
}

// This repo's own tags (refs/tags/), names and objects.
const sourceTags = (r) => r.git(r.work, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags/']);

// Runs the command in the template, and checks that every run leaves this
// repo's own tags as they were (review B1).
function run(r, args, deps = {}) {
  const out = [];
  const err = [];
  const before = sourceTags(r);
  const code = publish(args, r.env, { cwd: r.work, out: (s) => out.push(s), err: (s) => err.push(s), ...deps });
  assert.equal(sourceTags(r), before, `the source repo's tags are unchanged by ${args.join(' ')}`);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function refused(res, pattern) {
  assert.equal(res.code, 1, `expected a refusal; out: ${res.out} err: ${res.err}`);
  assert.match(res.err, /refusing to /);
  assert.match(res.err, pattern);
}

const distGit = (r, args) => r.git(r.distBare, args);
const distRefs = (r) => distGit(r, ['for-each-ref', '--format=%(refname)']);
const localDist = (r) => r.git(r.work, ['for-each-ref', '--format=%(refname)', 'refs/dist/']);

// Publishes v1.0.0 with --first and pushes it.
function first(r) {
  const res = run(r, ['v1.0.0', '--first', '--push']);
  assert.equal(res.code, 0, res.err);
  return res;
}

// --- arguments -------------------------------------------------------------

test('parseArgs: a version with --first and --push, or --check alone', () => {
  assert.deepEqual(parseArgs(['v1.0.0']), { version: 'v1.0.0', first: false, push: false });
  assert.deepEqual(parseArgs(['v1.0.0', '--first', '--push']), { version: 'v1.0.0', first: true, push: true });
  assert.deepEqual(parseArgs(['--check']), { check: true });
  assert.match(parseArgs([]).error, /no version/);
  assert.match(parseArgs(['--check', 'v1.0.0']).error, /--check takes no version/);
  assert.match(parseArgs(['--check', '--push']).error, /--check takes no/);
  assert.match(parseArgs(['v1.0.0', '--force']).error, /unknown argument/);
  assert.match(parseArgs(['v1.0.0', 'v1.1.0']).error, /one version only/);
  assert.equal(pushCommand('v1.2.3'), 'git push --atomic dist refs/dist/main:refs/heads/main refs/dist/tags/v1.2.3:refs/tags/v1.2.3');
});

test('usage errors exit 2', (t) => {
  const r = setup(t);
  assert.equal(run(r, []).code, 2);
  assert.equal(run(r, ['v1.0.0', '--force']).code, 2);
});

// Every case below has its own copy of the repos, so they run four at a time.
describe("template:publish on temp repos", { concurrency: 4 }, () => {
  // --- publishing --------------------------------------------------------------

  test('--first v1.0.0 without --push: local refs/dist only, nothing pushed, the push command printed', (t) => {
    const r = setup(t);
    const res = run(r, ['v1.0.0', '--first']);
    assert.equal(res.code, 0, res.err);
    assert.equal(distRefs(r), '', 'nothing is pushed');
    assert.deepEqual(localDist(r).split('\n'), ['refs/dist/main', 'refs/dist/tags/v1.0.0']);
    assert.equal(r.git(r.work, ['cat-file', '-t', 'refs/dist/tags/v1.0.0']), 'tag', 'an annotated tag object');
    assert.equal(r.git(r.work, ['rev-parse', 'refs/dist/tags/v1.0.0^{commit}']), r.git(r.work, ['rev-parse', 'refs/dist/main']));
    assert.ok(res.out.includes(`A human pushes it:\n  ${pushCommand('v1.0.0')}`), res.out);
    assert.match(res.out, /parent none: a new root/);
  });

  test('--first --push: dist gets main and v1.0.0, without the excluded paths, the ledger rowless, the same engine and a fixed message', (t) => {
    const r = setup(t);
    const res = first(r);
    assert.match(res.out, /pushed v1\.0\.0 and main to the dist remote/);
    assert.deepEqual(distRefs(r).split('\n'), ['refs/heads/main', 'refs/tags/v1.0.0']);
    const files = distGit(r, ['ls-tree', '-r', '--name-only', 'main']).split('\n');
    for (const e of dist.EXCLUDED) assert.ok(!files.some((f) => dist.isExcluded(f, [e])), `${e} is absent`);
    for (const f of ['kit/runtime/a.js', 'kit/lib/b.js', 'profiles/_schema/profile.schema.json', 'README.md', 'docs/ledger.md', 'docs/readme-link', 'examples/demo/README.md']) {
      assert.ok(files.includes(f), `${f} ships`);
    }
    assert.equal(distGit(r, ['ls-tree', 'main', 'docs/readme-link']).split(' ')[0], '120000', 'the symlink stays a symlink');
    const ledger = distGit(r, ['show', 'main:docs/ledger.md']);
    assert.match(ledger, /^\| PR \| Story \| Summary \|$/m);
    assert.doesNotMatch(ledger, /#1|#2/, 'no rows ship');
    assert.equal(lib.refFingerprint(r.distBare, 'main').sha256, lib.refFingerprint(r.work, 'refs/tags/v1.0.0').sha256);
    const source = r.git(r.work, ['rev-parse', 'v1.0.0^{commit}']);
    assert.equal(distGit(r, ['log', '-1', '--format=%B', 'main']), `AP Labs template v1.0.0\n\nSource: ${source}`);
    assert.equal(distGit(r, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main']), `${IDENTITY.name} <${IDENTITY.email}>|${IDENTITY.name} <${IDENTITY.email}>`);
    assert.equal(distGit(r, ['rev-list', '--count', 'main']), '1', 'a root commit');
    assert.equal(distGit(r, ['cat-file', '-t', 'v1.0.0']), 'tag');
    assert.match(distGit(r, ['cat-file', 'tag', 'v1.0.0']), new RegExp(`^tagger ${IDENTITY.name} <${IDENTITY.email}> `, 'm'));
    assert.match(distGit(r, ['cat-file', 'tag', 'v1.0.0']), /\n\nAP Labs template v1\.0\.0$/);
  });

  test('v1.1.0 after v1.0.0: the parent is dist v1.0.0', (t) => {
    const r = setup(t, published);
    r.release('v1.1.0', (w) => r.write(w, 'README.md', 'A template, v1.1.0.\n'));
    const res = run(r, ['v1.1.0', '--push']);
    assert.equal(res.code, 0, res.err);
    const v100 = distGit(r, ['rev-parse', 'v1.0.0^{commit}']);
    assert.equal(distGit(r, ['rev-parse', 'v1.1.0^{commit}']), distGit(r, ['rev-parse', 'main']));
    assert.equal(distGit(r, ['rev-parse', 'main^']), v100);
    assert.equal(distGit(r, ['show', 'main:README.md']), 'A template, v1.1.0.');
  });

  test('already published with the same tree exits 0, before and after the push', (t) => {
    const r = setup(t);
    assert.equal(run(r, ['v1.0.0', '--first']).code, 0);
    const again = run(r, ['v1.0.0', '--first']);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /already published here \(the same tree\), not pushed yet/);
    assert.ok(again.out.includes(pushCommand('v1.0.0')));
    const pushed = run(r, ['v1.0.0', '--first', '--push']);
    assert.equal(pushed.code, 0, pushed.err);
    assert.deepEqual(distRefs(r).split('\n'), ['refs/heads/main', 'refs/tags/v1.0.0']);
    const done = run(r, ['v1.0.0']);
    assert.equal(done.code, 0, done.err);
    assert.match(done.out, /v1\.0\.0 is already published \(the same tree\); nothing to do/);
  });

  test('the same release always builds the same commit (fixed identity, the source\'s date)', (t) => {
    const r = setup(t);
    const other = base.copy();
    t.after(other.cleanup);
    assert.equal(run(r, ['v1.0.0', '--first']).code, 0);
    assert.equal(run(other, ['v1.0.0', '--first']).code, 0);
    assert.equal(r.git(r.work, ['rev-parse', 'refs/dist/main']), other.git(other.work, ['rev-parse', 'refs/dist/main']));
  });

  test('end to end: a fork cloned from dist at v1.0.0 takes v1.1.0 with template:update, dist as upstream', (t) => {
    const r = setup(t, published);
    // The fork, as the fork guide makes it: clone dist at the tag, rename the
    // remote to upstream, add its own origin, delete the example, add a profile
    // and record the release.
    const fork = path.join(r.dir, 'fork');
    r.git(r.dir, ['clone', '-q', '--branch', 'v1.0.0', r.distBare, fork]);
    r.git(fork, ['switch', '-q', '-c', 'main']);
    r.git(fork, ['remote', 'rename', 'origin', 'upstream']);
    r.git(fork, ['remote', 'set-url', 'upstream', '../dist.git']);
    r.git(r.dir, ['init', '-q', '--bare', '-b', 'main', path.join(r.dir, 'fork-origin.git')]);
    r.git(fork, ['remote', 'add', 'origin', '../fork-origin.git']);
    fs.rmSync(path.join(fork, 'examples/demo'), { recursive: true });
    r.write(fork, '.aplabs/profile.yml', 'schema_version: 1\nclient: { id: stub, name: Stub Co }\n');
    r.commit(fork, 'fork: day one');
    const rec = r.run('kit/release/check.js', ['--record', 'v1.0.0'], fork);
    assert.equal(rec.code, 0, rec.stderr);
    r.commit(fork, 'fork: record the template version');
    r.git(fork, ['push', '-q', '-u', 'origin', 'main']);

    r.release('v1.1.0', (w) => {
      r.write(w, 'README.md', 'A template, v1.1.0.\n');
      r.write(w, 'examples/demo/README.md', 'The demo client, v1.1.0.\n');
    });
    assert.equal(run(r, ['v1.1.0', '--push']).code, 0);

    r.fakeGh();
    const out = [];
    const err = [];
    const code = update(['v1.1.0'], r.env, {
      cwd: fork, out: (s) => out.push(s), err: (s) => err.push(s),
      runChecks: () => ({ ok: true }), npmCi: () => ({ ok: true }), regenLock: () => ({ ok: true }),
    });
    assert.equal(code, 0, err.join('\n'));
    assert.ok(r.ghCalls().some((c) => c.startsWith('pr create') && c.includes('--head template/v1.1.0')), 'the PR is opened');
    assert.equal(r.git(fork, ['show', 'template/v1.1.0:README.md']), 'A template, v1.1.0.');
    assert.ok(!r.git(fork, ['ls-tree', '-r', '--name-only', 'template/v1.1.0']).includes('examples/demo'), 'the deleted example stays deleted');
    // The merge's second parent is dist's v1.1.0: forks share the dist history.
    assert.equal(r.git(fork, ['rev-parse', 'template/v1.1.0^2']), distGit(r, ['rev-parse', 'v1.1.0^{commit}']));
  });

  // --- refusals ----------------------------------------------------------------

  test('refuses in a fork', (t) => {
    const r = setup(t);
    r.write(r.work, '.aplabs/profile.yml', 'schema_version: 1\n');
    refused(run(r, ['v1.0.0', '--first']), /this is a fork/);
    refused(run(r, ['--check'], { runTests: () => assert.fail('never runs') }), /this is a fork/);
    assert.equal(localDist(r), '');
  });

  test('refuses with no dist remote', (t) => {
    const r = setup(t);
    r.git(r.work, ['remote', 'remove', 'dist']);
    refused(run(r, ['v1.0.0', '--first']), /there is no `dist` remote/);
  });

  test('refuses a dist remote without --no-tags', (t) => {
    const r = setup(t);
    r.git(r.work, ['config', '--unset', 'remote.dist.tagOpt']);
    refused(run(r, ['v1.0.0', '--first']), /remote\.dist\.tagOpt is not --no-tags/);
    assert.equal(distRefs(r), '');
  });

  test('refuses a lightweight tag', (t) => {
    const r = setup(t, published);
    r.write(r.work, 'README.md', 'v1.1.0\n');
    r.commit(r.work, 'v1.1.0');
    r.git(r.work, ['tag', 'v1.1.0']);
    r.git(r.work, ['push', '-q', 'origin', 'main', 'refs/tags/v1.1.0']);
    refused(run(r, ['v1.1.0']), /v1\.1\.0 is a lightweight tag/);
  });

  test('refuses a tag that is not on origin, or not origin\'s', (t) => {
    const r = setup(t, published);
    r.write(r.work, 'README.md', 'v1.1.0\n');
    r.commit(r.work, 'v1.1.0');
    r.git(r.work, ['push', '-q', 'origin', 'main']);
    r.git(r.work, ['tag', '-a', 'v1.1.0', '-m', 'v1.1.0']);
    refused(run(r, ['v1.1.0']), /the tag v1\.1\.0 is not on origin/);
    // Origin has a different v1.1.0 object.
    const other = path.join(r.dir, 'other');
    r.git(r.dir, ['clone', '-q', r.bare, other]);
    r.git(other, ['tag', '-a', 'v1.1.0', '-m', 'someone else\'s']);
    r.git(other, ['push', '-q', 'origin', 'refs/tags/v1.1.0']);
    refused(run(r, ['v1.1.0']), /the local tag v1\.1\.0 \(\w+\) is not origin's \(\w+\)/);
  });

  test('refuses a tag whose commit is not on origin/main', (t) => {
    const r = setup(t, published);
    r.git(r.work, ['switch', '-q', '-c', 'side']);
    r.write(r.work, 'README.md', 'unreviewed\n');
    r.commit(r.work, 'side');
    r.git(r.work, ['tag', '-a', 'v1.1.0', '-m', 'v1.1.0']);
    r.git(r.work, ['push', '-q', 'origin', 'side', 'refs/tags/v1.1.0']);
    refused(run(r, ['v1.1.0']), /the commit of v1\.1\.0 is not on origin\/main/);
  });

  test('refuses a missing local tag and a version that is not vX.Y.Z', (t) => {
    const r = setup(t);
    refused(run(r, ['v9.9.9', '--first']), /there is no local tag v9\.9\.9/);
    refused(run(r, ['1.0.0', '--first']), /not a version: 1\.0\.0/);
  });

  test('refuses an empty dist without --first, and --first on a dist with any ref', (t) => {
    const r = setup(t);
    refused(run(r, ['v1.0.0']), /the dist remote is empty: the first release is published with --first/);
    assert.equal(localDist(r), '');
    first(r);
    r.release('v1.1.0', (w) => r.write(w, 'README.md', 'v1.1.0\n'));
    refused(run(r, ['v1.1.0', '--first']), /--first refuses: the dist remote already has refs/);
    // Any ref at all, not only main or a tag.
    const s = setup(t);
    const other = path.join(s.dir, 'other');
    s.git(s.dir, ['clone', '-q', s.bare, other]);
    s.git(other, ['push', '-q', '../dist.git', 'HEAD:refs/heads/stray']);
    refused(run(s, ['v1.0.0', '--first']), /--first refuses/);
  });

  test('refuses when the dist repo\'s main moved past the newest dist tag', (t) => {
    const r = setup(t, published);
    const clone = path.join(r.dir, 'dist-clone');
    r.git(r.dir, ['clone', '-q', r.distBare, clone]);
    r.write(clone, 'NOTE.md', 'pushed by hand\n');
    r.commit(clone, 'by hand');
    r.git(clone, ['push', '-q', 'origin', 'main']);
    r.release('v1.1.0', (w) => r.write(w, 'README.md', 'v1.1.0\n'));
    refused(run(r, ['v1.1.0']), /the dist repo's main moved; fix by hand/);
    assert.ok(!localDist(r).includes('v1.1.0'));
  });

  test('refuses a version not higher than the newest dist release', (t) => {
    const r = setup(t);
    r.release('v1.1.0', (w) => r.write(w, 'README.md', 'v1.1.0\n'));
    assert.equal(run(r, ['v1.1.0', '--first', '--push']).code, 0);
    refused(run(r, ['v1.0.0']), /v1\.0\.0 is not higher than the newest dist release, v1\.1\.0/);
  });

  test('refuses a tag already published with a different tree', (t) => {
    const r = setup(t, published);
    // The source tag is moved to other content (and pushed), after publishing.
    r.write(r.work, 'README.md', 'changed after publishing\n');
    r.commit(r.work, 'retag');
    r.git(r.work, ['tag', '-f', '-a', 'v1.0.0', '-m', 'v1.0.0 again']);
    r.git(r.work, ['push', '-q', '-f', 'origin', 'main', 'refs/tags/v1.0.0']);
    refused(run(r, ['v1.0.0']), /v1\.0\.0 is already published with a different tree/);
  });

  test('refuses a deny-list hit in content, naming file:line, never the word', (t) => {
    const r = setup(t, published);
    r.release('v1.1.0', (w) => r.write(w, 'docs/guide.md', 'fine\nabout Zorblax\n'));
    const res = run(r, ['v1.1.0']);
    refused(res, /deny-list hit: docs\/guide\.md:2: deny pattern 1/);
    assert.doesNotMatch(res.err + res.out, /zorblax/i);
  });

  test('refuses a deny-list hit in a path', (t) => {
    const r = setup(t, published);
    r.release('v1.1.0', (w) => r.write(w, 'docs/frimp-notes.md', 'clean\n'));
    const res = run(r, ['v1.1.0']);
    refused(res, /deny-list hit: docs\/frimp-notes\.md \(path\): deny pattern 2/);
    assert.doesNotMatch(res.err.replace('docs/frimp-notes.md', ''), /frimp/i);
  });

  test('refuses a missing deny file, read from the tag\'s tree (not the worktree)', (t) => {
    const r = setup(t, published);
    r.release('v1.1.0', (w) => fs.rmSync(path.join(w, dist.DENY_FILE)));
    // Put back in the worktree only: the tag's tree still has none.
    r.write(r.work, dist.DENY_FILE, 'zorblax\n');
    refused(run(r, ['v1.1.0']), /the deny list docs\/reference\/dist-deny\.txt is missing.*read from refs\/tags\/v1\.1\.0's tree/);
  });

  test('refuses an invalid regex in the deny file', (t) => {
    const r = setup(t, published);
    r.release('v1.1.0', (w) => r.write(w, dist.DENY_FILE, 'zorblax\n(unclosed\n'));
    refused(run(r, ['v1.1.0']), /invalid regex on line 2/);
  });

  test('refuses a symlink into docs/reference/', (t) => {
    const r = setup(t, published);
    r.release('v1.1.0', (w) => fs.symlinkSync('reference/notes.md', path.join(w, 'docs/notes-link')));
    refused(run(r, ['v1.1.0']), /docs\/notes-link is a symlink into the excluded path docs\/reference\/notes\.md/);
  });

  test('refuses a gitlink', (t) => {
    const r = setup(t, published);
    // Staged by hand, since release()'s `git add -A` would drop a gitlink with
    // no folder behind it.
    const head = r.git(r.work, ['rev-parse', 'HEAD']);
    r.git(r.work, ['update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`]);
    r.git(r.work, ['commit', '-q', '--no-verify', '-m', 'a gitlink']);
    r.git(r.work, ['tag', '-a', 'v1.1.0', '-m', 'v1.1.0']);
    r.git(r.work, ['push', '-q', 'origin', 'main', 'refs/tags/v1.1.0']);
    refused(run(r, ['v1.1.0']), /vendor\/sub is a gitlink/);
  });

  test('refuses an injected exclusion under kit/', (t) => {
    const r = setup(t);
    refused(run(r, ['v1.0.0', '--first'], { excluded: [...dist.EXCLUDED, 'kit/lib'] }), /"kit\/lib" overlaps the engine path "kit"/);
    assert.equal(localDist(r), '');
  });

  test('refuses when the dist remote can\'t be fetched (never taken for an empty one)', (t) => {
    const r = setup(t);
    r.git(r.work, ['remote', 'set-url', 'dist', '../no-such-dist.git']);
    refused(run(r, ['v1.0.0', '--first']), /could not fetch from the dist remote.*never taken for an empty one/);
    assert.equal(localDist(r), '');
  });

  test('names every reason at once', (t) => {
    const r = setup(t);
    r.git(r.work, ['config', '--unset', 'remote.dist.tagOpt']);
    r.release('v1.1.0', (w) => r.write(w, 'docs/guide.md', 'zorblax\n'));
    r.git(r.work, ['tag', 'v1.2.0']);
    const res = run(r, ['v1.1.0', '--first'], { excluded: dist.EXCLUDED });
    refused(res, /tagOpt is not --no-tags/);
    assert.match(res.err, /deny-list hit: docs\/guide\.md:1/);
  });

  // --- --check -------------------------------------------------------------------

  test('--check builds HEAD\'s distribution tree into a temp repo and runs the injected tests there', (t) => {
    const r = setup(t);
    let seen = null;
    const res = run(r, ['--check'], {
      runTests: (dir) => {
        const files = r.git(dir, ['ls-files']).split('\n');
        seen = {
          files,
          ledger: fs.readFileSync(path.join(dir, 'docs/ledger.md'), 'utf8'),
          link: fs.readlinkSync(path.join(dir, 'docs/readme-link')),
          clean: r.git(dir, ['status', '--porcelain']),
          engine: lib.refFingerprint(dir, 'HEAD').sha256,
        };
        return { ok: true };
      },
    });
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /ok \(the distribution tree builds and passes its tests\)/);
    assert.ok(seen, 'the runner ran');
    assert.ok(!seen.files.some((f) => dist.isExcluded(f)), 'no excluded path');
    assert.ok(seen.files.includes('kit/lib/b.js'));
    assert.doesNotMatch(seen.ledger, /#1/);
    assert.equal(seen.link, '../README.md');
    assert.equal(seen.clean, '');
    assert.equal(seen.engine, lib.refFingerprint(r.work, 'HEAD').sha256);
    assert.equal(localDist(r), '', '--check writes no dist ref');
    assert.equal(r.git(r.work, ['status', '--porcelain']), '', 'and leaves the worktree and index alone');
  });

  test('--check fails when the injected test run fails, and on a deny hit before running it', (t) => {
    const r = setup(t);
    refused(run(r, ['--check'], { runTests: () => ({ ok: false, detail: 'exit 1' }) }), /npm run check && npm test && npm run test:slow failed in the distribution tree \(exit 1\)/);
    r.write(r.work, 'docs/guide.md', 'zorblax\n');
    r.commit(r.work, 'a hit');
    refused(run(r, ['--check'], { runTests: () => assert.fail('never runs') }), /deny-list hit: docs\/guide\.md:1/);
  });

  test('--check warns about shipped files that name an excluded path (N8), without failing', (t) => {
    const r = setup(t);
    r.write(r.work, 'docs/guide.md', 'See docs/planning/ for history.\n');
    r.commit(r.work, 'a mention');
    const res = run(r, ['--check'], { runTests: () => ({ ok: true }) });
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /warning: 1 shipped file\(s\) mention an excluded path \(N8, not a failure\): docs\/guide\.md/);
  });
});

// --- the repo ------------------------------------------------------------------

test('AGENTS.md: the Orchestrator never publishes with --push or pushes to dist', () => {
  const text = fs.readFileSync(path.join(__dirname, '../../AGENTS.md'), 'utf8');
  assert.ok(text.includes('The Orchestrator never passes `--push` to `template:publish` and never pushes to the `dist` remote.'));
});

test('package.json runs template:publish', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.equal(pkg.scripts['template:publish'], 'node kit/release/publish.js');
});

test('CHANGELOG.md\'s release checklist ends with publishing to the dist repo', () => {
  const text = fs.readFileSync(path.join(__dirname, '../../CHANGELOG.md'), 'utf8');
  assert.match(text, /^6\. Run `npm run template:publish -- vX\.Y\.Z`; Ely pushes the dist commit and tag/m);
  assert.match(text, /^3\. .*`dist` among them/m);
});
