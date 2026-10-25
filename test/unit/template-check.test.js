'use strict';

// Story 11.5: `npm run template:check [-- --record vX.Y.Z]`, the "engine
// untouched" check, and the fingerprint it rests on (review N9). Every test
// runs on temp git repos: a bare "origin" template with a v0.1.0 tag and a
// cloned fork. Nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { makeTemplate } = require('../fixtures/temp-git');
const lib = require('../../kit/lib/template');
const { ENGINE_DIRS } = require('../../kit/runtime/paths');

const CHECK = 'kit/release/check.js';

// The template tagged v0.1.0 on origin, and a fork cloned from it (with the
// tag) that has a profile and no record yet. Built once; each test copies it.
let base;
test.before(() => {
  const r = makeTemplate();
  r.git(r.work, ['tag', '-a', 'v0.1.0', '-m', 'v0.1.0']);
  r.git(r.work, ['push', '-q', 'origin', 'refs/tags/v0.1.0']);
  r.cloneFork('fork');
  base = r;
});
test.after(() => base && base.cleanup());

function setup(t) {
  const r = base.copy();
  t.after(r.cleanup);
  r.fork = path.join(r.dir, 'fork');
  r.check = (args = [], cwd = r.fork) => r.run(CHECK, args, cwd);
  return r;
}

// A fork with its record written (v0.1.0) and committed.
function recorded(t) {
  const r = setup(t);
  const res = r.check(['--record', 'v0.1.0']);
  assert.equal(res.code, 0, res.stderr);
  r.commit(r.fork, 'record the template version');
  return r;
}

test('the template (no profile) is not a fork: skipped, and --record refuses', (t) => {
  const r = setup(t);
  const res = r.check([], r.work);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /not a fork \(no \.aplabs\/profile\.yml\); skipped/);
  const rec = r.check(['--record', 'v0.1.0'], r.work);
  assert.equal(rec.code, 1);
  assert.match(rec.stderr, /not a fork/);
  assert.ok(!fs.existsSync(path.join(r.work, lib.RECORD_REL)));
});

test('a fork with a profile and no record fails, naming the fix (review B8)', (t) => {
  const r = setup(t);
  const res = r.check();
  assert.equal(res.code, 1);
  assert.match(res.stderr, /fork without a template record; run `npm run template:check -- --record vX\.Y\.Z`/);
});

test('a malformed record fails (it is never read generously)', (t) => {
  const r = setup(t);
  const bad = [
    'version: v0.1.0\n',
    'version: 0.1.0\nengine_sha256: ' + 'a'.repeat(64) + '\n',
    'version: v0.1.0\nengine_sha256: ABC\n',
    'version: v0.1.0\nengine_sha256: ' + 'a'.repeat(64) + '\nextra: 1\n',
    '- not a mapping\n',
    'version: [\n',
  ];
  for (const text of bad) {
    r.write(r.fork, lib.RECORD_REL, text);
    const res = r.check();
    assert.equal(res.code, 1, text);
    assert.match(res.stderr, /FAILED: \.aplabs\/template-version/, text);
  }
});

test('--record writes the two keys after checking the engine is the tag\'s; an untouched fork then passes', (t) => {
  const r = recorded(t);
  const doc = lib.readRecord(r.fork);
  assert.equal(doc.record.version, 'v0.1.0');
  assert.equal(doc.record.engine_sha256, lib.refFingerprint(r.fork, 'refs/tags/v0.1.0').sha256);
  const res = r.check();
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /engine is untouched since v0\.1\.0 \(3 files\)/);
  // The fork's own files never count.
  r.write(r.fork, 'app/modules/x/manifest.json', '{}\n');
  r.write(r.fork, '.aplabs/context/org.md', '# Org\n');
  r.write(r.fork, 'README.md', 'the fork\n');
  r.commit(r.fork, 'fork work');
  assert.equal(r.check().code, 0);
});

test('one edited kit/ file fails, naming it, when the tag is here', (t) => {
  const r = recorded(t);
  r.write(r.fork, 'kit/lib/b.js', "'use strict';\nmodule.exports = 3;\n");
  r.commit(r.fork, 'edit the engine');
  const res = r.check();
  assert.equal(res.code, 1);
  assert.match(res.stderr, /the engine differs from v0\.1\.0 in 1 file\(s\):\n- kit\/lib\/b\.js \(changed\)/);
});

test('an added, deleted or schema file is named too, even uncommitted', (t) => {
  const r = recorded(t);
  r.write(r.fork, 'kit/runtime/new.js', '1;\n');
  r.git(r.fork, ['add', 'kit/runtime/new.js']);
  fs.rmSync(path.join(r.fork, 'kit/runtime/a.js'));
  r.write(r.fork, 'profiles/_schema/profile.schema.json', '{}\n');
  const res = r.check();
  assert.equal(res.code, 1);
  assert.match(res.stderr, /- kit\/runtime\/a\.js \(deleted\)/);
  assert.match(res.stderr, /- kit\/runtime\/new\.js \(added\)/);
  assert.match(res.stderr, /- profiles\/_schema\/profile\.schema\.json \(changed\)/);
});

test('offline, with no tag and no upstream remote, it fails saying only that the engine changed', (t) => {
  const r = recorded(t);
  r.git(r.fork, ['tag', '-d', 'v0.1.0']);
  r.git(r.fork, ['remote', 'remove', 'origin']);
  r.write(r.fork, 'kit/lib/b.js', '2;\n');
  r.commit(r.fork, 'edit');
  const res = r.check();
  assert.equal(res.code, 1);
  assert.match(res.stderr, /the engine changed since v0\.1\.0/);
  assert.match(res.stderr, /can't name the files/);
  assert.doesNotMatch(res.stderr, /kit\/lib\/b\.js/);
  // Untouched, the same offline fork passes: the record alone is enough.
  r.git(r.fork, ['revert', '--no-edit', 'HEAD']);
  assert.equal(r.check().code, 0);
});

test('with the upstream remote it fetches the one tag and names each file', (t) => {
  const r = recorded(t);
  r.git(r.fork, ['tag', '-d', 'v0.1.0']);
  r.git(r.fork, ['remote', 'rename', 'origin', 'upstream']);
  r.write(r.fork, 'kit/runtime/a.js', '9;\n');
  r.commit(r.fork, 'edit');
  const res = r.check();
  assert.equal(res.code, 1);
  assert.match(res.stderr, /- kit\/runtime\/a\.js \(changed\)/);
  assert.equal(r.git(r.fork, ['tag', '--list']), 'v0.1.0', 'only that tag was fetched');
});

test('a hand-edited record fails even with the engine untouched', (t) => {
  const r = recorded(t);
  r.write(r.fork, lib.RECORD_REL, lib.recordText({ version: 'v0.1.0', engine_sha256: 'b'.repeat(64) }));
  const res = r.check();
  assert.equal(res.code, 1);
  assert.match(res.stderr, /the record itself was edited/);
});

test('--record refuses a missing tag and an engine that is not the tag\'s, and writes nothing', (t) => {
  const r = setup(t);
  const missing = r.check(['--record', 'v9.9.9']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /refusing --record v9\.9\.9: the tag v9\.9\.9 is not here/);
  r.write(r.fork, 'kit/lib/b.js', '0;\n');
  const edited = r.check(['--record', 'v0.1.0']);
  assert.equal(edited.code, 1);
  assert.match(edited.stderr, /not v0\.1\.0's; 1 file\(s\) differ:\n- kit\/lib\/b\.js \(changed\)/);
  assert.ok(!fs.existsSync(path.join(r.fork, lib.RECORD_REL)));
  assert.equal(r.check(['--record', 'latest']).code, 2);
  assert.equal(r.check(['--bogus']).code, 2);
});

test('the fingerprint frames each file as path, NUL, 8-byte length, bytes (review N9)', () => {
  const expected = crypto.createHash('sha256');
  for (const [p, b] of [['a', 'bc'], ['b/c', '']]) {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(Buffer.byteLength(b)));
    expected.update(Buffer.from(p)).update(Buffer.from([0])).update(len).update(Buffer.from(b));
  }
  const entries = [{ path: 'b/c', bytes: Buffer.from('') }, { path: 'a', bytes: Buffer.from('bc') }];
  assert.equal(lib.frame(entries), expected.digest('hex'), 'sorted by path, then framed');
  // Moving bytes between the path and the content changes the hash.
  assert.notEqual(lib.frame([{ path: 'ab', bytes: Buffer.from('c') }]), lib.frame([{ path: 'a', bytes: Buffer.from('bc') }]));
  assert.notEqual(lib.frame([{ path: 'a', bytes: Buffer.from('') }, { path: 'b', bytes: Buffer.from('') }]), lib.frame([{ path: 'a', bytes: Buffer.from('\0b') }]));
});

test('the fingerprint covers exactly the tracked kit/ and profiles/_schema/ files, symlinks by target', (t) => {
  assert.deepEqual([...ENGINE_DIRS], ['kit', 'profiles/_schema']);
  const r = setup(t);
  fs.symlinkSync('a.js', path.join(r.fork, 'kit/runtime/link.js'));
  r.commit(r.fork, 'a link');
  const tracked = lib.worktreeFingerprint(r.fork);
  assert.deepEqual(Object.keys(tracked.files).sort(), ['kit/lib/b.js', 'kit/runtime/a.js', 'kit/runtime/link.js', 'profiles/_schema/profile.schema.json']);
  assert.equal(tracked.sha256, lib.refFingerprint(r.fork, 'HEAD').sha256, 'the worktree and git\'s objects agree');
  // Untracked engine files and files outside the engine are not in it.
  r.write(r.fork, 'kit/scratch.tmp', 'x');
  r.write(r.fork, 'scripts/x.sh', 'echo\n');
  r.write(r.fork, 'profiles/acme/profile.yml', 'x: 1\n');
  assert.equal(lib.worktreeFingerprint(r.fork).sha256, tracked.sha256);
});
