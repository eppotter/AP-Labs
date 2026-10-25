'use strict';

// kit/lib/fork (Story 11.3): what may differ between forks. compareForks on
// small temp trees, packageDelta on plain objects. The two-forks acceptance
// test (test/acceptance/two-forks.test.js) runs both on real copies.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  compareForks, packageDelta, areaOf, listFiles, deletedRoots, updateRule, UPDATE_RULES,
} = require('../../kit/lib/fork');

const tmps = [];
test.after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// A temp tree from { 'rel/path': 'content' }.
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-fork-unit-'));
  tmps.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const BASE = Object.freeze({
  'kit/lib/a.js': 'engine a\n',
  'profiles/_schema/profile.schema.json': '{}\n',
  'scripts/x.sh': 'echo x\n',
  'package.json': '{}\n',
  '.aplabs/profile.yml': 'client: a\n',
  'app/hubs/ops.json': '{}\n',
});

test('areaOf: engine, fork, package and template paths', () => {
  assert.equal(areaOf('kit/lib/fork/index.js'), 'engine');
  assert.equal(areaOf('profiles/_schema/profile.schema.json'), 'engine');
  assert.equal(areaOf('.aplabs/profile.yml'), 'fork');
  assert.equal(areaOf('.aplabs/context/org.md'), 'fork');
  assert.equal(areaOf('app/modules/m/manifest.json'), 'fork');
  assert.equal(areaOf('package.json'), 'package');
  assert.equal(areaOf('package-lock.json'), 'package');
  assert.equal(areaOf('scripts/check-syntax.sh'), 'template');
  assert.equal(areaOf('application/x.js'), 'template', 'a prefix is not the app dir');
  assert.equal(areaOf('kitchen/x.js'), 'template', 'a prefix is not kit/');
  assert.equal(areaOf('client/m.js', { appDir: 'client' }), 'fork', 'the app dir can be named');
  assert.equal(areaOf('app/m.js', { appDir: 'client' }), 'template');
});

test('listFiles: never walks .git or node_modules, lists a symlink without following it', () => {
  const root = tree({ 'a.txt': 'a', '.git/HEAD': 'x', 'node_modules/p/index.js': 'x', 'sub/node_modules/q.js': 'x' });
  const outside = tree({ 'secret.txt': 's' });
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.deepEqual(listFiles(root), ['a.txt', 'link']);
});

test('compareForks: identical trees have no differences', () => {
  assert.deepEqual(compareForks(tree(BASE), tree(BASE)), { differences: [], problems: [] });
});

test('compareForks: fork-owned and package differences are listed, not problems', () => {
  const a = tree(BASE);
  const b = tree({ ...BASE, '.aplabs/profile.yml': 'client: b\n', 'package.json': '{"x":1}\n', 'app/modules/m/manifest.json': '{}' });
  fs.rmSync(path.join(b, 'app/hubs/ops.json'));
  const r = compareForks(a, b);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.differences, [
    { path: '.aplabs/profile.yml', change: 'changed', area: 'fork' },
    { path: 'app/hubs/ops.json', change: 'only-in-a', area: 'fork' },
    { path: 'app/modules/m/manifest.json', change: 'only-in-b', area: 'fork' },
    { path: 'package.json', change: 'changed', area: 'package' },
  ]);
});

test('compareForks: one byte changed under kit/ is a problem naming the file', () => {
  const r = compareForks(tree(BASE), tree({ ...BASE, 'kit/lib/a.js': 'engine A\n' }));
  assert.deepEqual(r.differences, [{ path: 'kit/lib/a.js', change: 'changed', area: 'engine' }]);
  assert.deepEqual(r.problems, ['kit/lib/a.js: differs between the forks (an engine file, identical in every fork)']);
});

test('compareForks: an engine file in one fork only, and a template file changed, are problems', () => {
  const r = compareForks(tree(BASE), tree({ ...BASE, 'profiles/_schema/extra.json': '{}', 'scripts/x.sh': 'echo y\n' }));
  assert.deepEqual(r.problems, [
    'profiles/_schema/extra.json: is only in b (an engine file, identical in every fork)',
    'scripts/x.sh: differs between the forks (a template file a fork does not change)',
  ]);
});

test('compareForks: a symlink is compared by its target, never followed', () => {
  const a = tree(BASE);
  const b = tree(BASE);
  fs.symlinkSync('lib/a.js', path.join(a, 'kit/link'));
  fs.symlinkSync('lib/a.js', path.join(b, 'kit/link'));
  assert.deepEqual(compareForks(a, b).problems, []);
  fs.rmSync(path.join(b, 'kit/link'));
  fs.writeFileSync(path.join(b, 'kit/link'), 'engine a\n');
  assert.deepEqual(compareForks(a, b).problems, ['kit/link: differs between the forks (an engine file, identical in every fork)']);
});

test('compareForks: the app dir can be named', () => {
  const a = tree({ ...BASE, 'client/m.js': 'a' });
  const b = tree({ ...BASE, 'client/m.js': 'b' });
  assert.deepEqual(compareForks(a, b, { appDir: 'client' }).problems, []);
  assert.equal(compareForks(a, b).problems.length, 1);
});

const PKG = Object.freeze({
  name: 'ap-labs',
  version: '0.0.0',
  scripts: { test: 'node --test' },
  dependencies: { ajv: '8.20.0', yaml: '2.9.1' },
});

test('packageDelta: an untouched package.json has no delta', () => {
  assert.deepEqual(packageDelta(PKG, structuredClone(PKG)), { appended: [], problems: [] });
});

test('packageDelta: an appended dependency is listed, wherever npm sorted it', () => {
  const fork = { ...PKG, dependencies: { 'left-pad': '1.3.0', ajv: '8.20.0', yaml: '2.9.1', zod: '4.0.0' } };
  assert.deepEqual(packageDelta(PKG, fork), {
    appended: [{ section: 'dependencies', name: 'left-pad', spec: '1.3.0' }, { section: 'dependencies', name: 'zod', spec: '4.0.0' }],
    problems: [],
  });
  const dev = { ...PKG, devDependencies: { eslint: '9.0.0' } };
  assert.deepEqual(packageDelta(PKG, dev).appended, [{ section: 'devDependencies', name: 'eslint', spec: '9.0.0' }]);
});

test('packageDelta: a dependency changed or removed is a problem naming it', () => {
  assert.deepEqual(packageDelta(PKG, { ...PKG, dependencies: { ajv: '8.21.0', yaml: '2.9.1' } }).problems, [
    'package.json: dependencies "ajv" was changed (8.20.0 to 8.21.0)',
  ]);
  assert.deepEqual(packageDelta(PKG, { ...PKG, dependencies: { yaml: '2.9.1', ajvx: '1.0.0' } }), {
    appended: [{ section: 'dependencies', name: 'ajvx', spec: '1.0.0' }],
    problems: ['package.json: dependencies "ajv" was removed'],
  });
  const { dependencies, ...noDeps } = PKG;
  assert.deepEqual(packageDelta(PKG, noDeps).problems, [
    'package.json: dependencies "ajv" was removed',
    'package.json: dependencies "yaml" was removed',
  ]);
});

test('packageDelta: any other field changed, added or removed is a problem naming it', () => {
  const r = packageDelta(PKG, { ...PKG, scripts: { test: 'true' }, private: false, version: undefined });
  assert.deepEqual(r.problems, [
    'package.json: field "private" was added',
    'package.json: field "scripts" was changed',
    'package.json: field "version" was changed',
  ]);
  const { name, ...noName } = PKG;
  assert.deepEqual(packageDelta(PKG, noName).problems, ['package.json: field "name" was removed']);
  assert.deepEqual(packageDelta(PKG, { ...PKG, dependencies: ['ajv'] }).problems, ['package.json: field "dependencies" was changed']);
});

test('packageDelta: names that look like object keys are plain names', () => {
  const fork = JSON.parse('{"name":"ap-labs","version":"0.0.0","scripts":{"test":"node --test"},"dependencies":{"ajv":"8.20.0","yaml":"2.9.1","constructor":"1.0.0","__proto__":"2.0.0"}}');
  assert.deepEqual(packageDelta(PKG, fork).appended.map((a) => a.name), ['constructor', '__proto__']);
});

test('packageDelta: not an object is a problem', () => {
  assert.deepEqual(packageDelta(PKG, null).problems, ['package.json: is not an object']);
});

const LOCK = Object.freeze({
  name: 'ap-labs',
  version: '0.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'ap-labs', version: '0.0.0', dependencies: { ajv: '8.20.0', yaml: '2.9.1' } },
    'node_modules/ajv': { version: '8.20.0', integrity: 'sha512-a' },
    'node_modules/yaml': { version: '2.9.1', integrity: 'sha512-y' },
  },
});

// The lockfile after appending left-pad (and the package it pulls in).
function appendedLock() {
  const lock = structuredClone(LOCK);
  lock.packages[''].dependencies['left-pad'] = '1.3.0';
  lock.packages['node_modules/left-pad'] = { version: '1.3.0', integrity: 'sha512-l' };
  lock.packages['node_modules/pad-core'] = { version: '0.1.0', integrity: 'sha512-p' };
  return lock;
}
const appendedPkg = () => ({ ...PKG, dependencies: { ...PKG.dependencies, 'left-pad': '1.3.0' } });

test('packageDelta: the lockfile changes that follow from an appended dependency are allowed', () => {
  assert.deepEqual(packageDelta(PKG, appendedPkg(), { templateLock: LOCK, forkLock: appendedLock() }), {
    appended: [{ section: 'dependencies', name: 'left-pad', spec: '1.3.0' }],
    problems: [],
  });
  assert.deepEqual(packageDelta(PKG, PKG, { templateLock: LOCK, forkLock: structuredClone(LOCK) }).problems, []);
});

test('packageDelta: a lockfile entry changed, removed or added with nothing appended is a problem naming it', () => {
  const changed = appendedLock();
  changed.packages['node_modules/ajv'].version = '8.21.0';
  delete changed.packages['node_modules/yaml'];
  changed.packages[''].dependencies.ajv = '8.21.0';
  assert.deepEqual(packageDelta(PKG, appendedPkg(), { templateLock: LOCK, forkLock: changed }).problems, [
    'package-lock.json root entry: dependencies "ajv" was changed (8.20.0 to 8.21.0)',
    'package-lock.json: entry "node_modules/ajv" was changed',
    'package-lock.json: entry "node_modules/yaml" was removed',
  ]);

  const sneaky = structuredClone(LOCK);
  sneaky.packages['node_modules/extra'] = { version: '1.0.0' };
  assert.deepEqual(packageDelta(PKG, PKG, { templateLock: LOCK, forkLock: sneaky }).problems, [
    'package-lock.json: entry "node_modules/extra" was added with no appended dependency',
  ]);

  const version = { ...appendedLock(), lockfileVersion: 2 };
  assert.deepEqual(packageDelta(PKG, appendedPkg(), { templateLock: LOCK, forkLock: version }).problems, [
    'package-lock.json: field "lockfileVersion" was changed',
  ]);
  assert.deepEqual(packageDelta(PKG, PKG, { templateLock: LOCK }).problems, ['package-lock.json: is not an object']);
});

// Story 11.6 (review B9): the path rules a template update applies.

test('UPDATE_RULES: the fork-owned list is the ledger and the planning docs; deleted roots are derived', () => {
  assert.deepEqual([...UPDATE_RULES.forkOwned], ['docs/ledger.md', 'docs/planning']);
  assert.equal(typeof UPDATE_RULES.deletedOnPurpose, 'string', 'no fixed list of deleted roots');
  assert.ok(Object.isFrozen(UPDATE_RULES) && Object.isFrozen(UPDATE_RULES.forkOwned));
});

test('deletedRoots: lifts each deleted file to the shallowest folder the fork has nothing under', () => {
  const recorded = [
    'README.md', 'docs/a.md', 'docs/b.md', 'examples/README.md', 'examples/demo/app/x.js', 'examples/demo/fixture/y.sql',
    'profiles/_schema/profile.schema.json', 'profiles/demo/profile.yml', 'scripts/old.sh', 'scripts/keep.sh', 'gone/deep/file.txt',
  ];
  const fork = ['README.md', 'docs/a.md', 'examples/README.md', 'profiles/_schema/profile.schema.json', 'scripts/keep.sh', '.aplabs/profile.yml'];
  assert.deepEqual(deletedRoots(recorded, fork), ['docs/b.md', 'examples/demo', 'gone', 'profiles/demo', 'scripts/old.sh']);
  assert.deepEqual(deletedRoots(recorded, recorded), []);
});

test('deletedRoots: engine paths never count (the update refuses an engine edit first)', () => {
  assert.deepEqual(deletedRoots(['kit/lib/a.js', 'kit/lib/b.js', 'README.md'], ['kit/lib/a.js', 'README.md']), []);
});

test('updateRule: fork, package, fork-owned, deleted and template paths', () => {
  const opts = { deletedRoots: ['examples/demo', 'profiles/demo'], appDir: 'app' };
  assert.equal(updateRule('.aplabs/profile.yml', opts), 'fork');
  assert.equal(updateRule('.aplabs/template-version', opts), 'fork');
  assert.equal(updateRule('app/hubs/x.json', opts), 'fork');
  assert.equal(updateRule('apps/x.json', opts), 'template');
  assert.equal(updateRule('client/app/x.json', { ...opts, appDir: 'client/app' }), 'fork');
  assert.equal(updateRule('package.json', opts), 'package');
  assert.equal(updateRule('package-lock.json', opts), 'package');
  assert.equal(updateRule('docs/ledger.md', opts), 'fork-owned');
  assert.equal(updateRule('docs/planning/plan.md', opts), 'fork-owned');
  assert.equal(updateRule('docs/planningish.md', opts), 'template');
  assert.equal(updateRule('examples/demo/new.md', opts), 'deleted');
  assert.equal(updateRule('examples/demo2/new.md', opts), 'template');
  assert.equal(updateRule('profiles/demo/profile.yml', opts), 'deleted');
  assert.equal(updateRule('kit/lib/a.js', opts), 'template');
  assert.equal(updateRule('README.md'), 'template');
});
