'use strict';

// DEP-012 / AD-15: only the approval-write archetype writes live. The
// write-path check (kit/verify/write-path.js, run through
// scripts/check-write-path.js by npm run check, and here by npm test) fails app
// code, the templates or the engine that passes dryRun other than true,
// reaches or aliases a connector's write operations, creates a connector
// instance or declares a connector outside the allow-list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const engine = require('../../kit/verify/write-path');
const { ALLOWED, writePathProblems, scannedDirs } = require('../../scripts/check-write-path');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-write-path.js');

function tmpRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-write-path-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const run = (root, env = {}) => spawnSync(process.execPath, [SCRIPT, '--root', root], {
  encoding: 'utf8', env: { ...process.env, APLABS_APP_DIR: '', ...env },
});

test('the allow-list is the approval-write archetype, the contract, and each connector\'s own folder', () => {
  assert.deepEqual(ALLOWED, [
    'kit/runtime/archetypes/approval-write/**',
    'kit/runtime/connectors/**',
    'kit/templates/connector/**',
    '<app dir>/connectors/<id>/**',
  ]);
  assert.equal(engine.ALLOWED, ALLOWED, 'the script is a shim over the engine');
});

test('this repo passes the write-path check', () => {
  const dirs = scannedDirs(ROOT, {}).map((d) => path.relative(ROOT, d).split(path.sep).join('/'));
  for (const d of ['kit/runtime', 'kit/templates']) assert.ok(dirs.includes(d), `${d} is always scanned`);
  assert.deepEqual(writePathProblems(ROOT, {}), []);
});

test('the check catches each way app code could write live, naming the file and the line', (t) => {
  const root = tmpRoot(t);
  put(root, 'app/modules/push/handler.js', [
    "const email = require('../../connectors/email/connector');",
    "const sdk = require('#sdk');",
    '// a comment may say dryRun: false; it never runs',
    'const instance = email.create({ log });',
    "await instance.write.addContacts({ idempotencyKey: 'k', dryRun: false });",
    "const w = instance.write['createList'];",
    "instance['write'].createList({ dryRun: live });",
    'const { write } = instance;',
    'await instance.write?.createList({ dryRun });',
    'const own = sdk.defineConnector({});',
    "await instance.write.createList({ idempotencyKey: 'k', dryRun: true });",
    '/* a closed comment */ go({ dryRun: false });',
    '/* a comment that runs on',
    '   dryRun: false, still a comment */ go({ dryRun: false });',
  ].join('\n'));
  // Allowed: the connector's own folder, a dry run, a stream write, a non-connector create().
  put(root, 'app/connectors/email/connector.js', "await x.write.createList({ dryRun: false }); defineConnector({}); c.create({});\n");
  put(root, 'app/modules/fine/handler.js', "process.stdout.write('x'); Object.create(null); const r = require('../../connectors/email/outbox');\n");
  // Passing a deps.write function along is fine in a file that imports no connector.
  put(root, 'app/modules/fine/log.js', 'createLog({ write: deps.write });\n');
  // A loose file in connectors/ is not a connector's own folder.
  put(root, 'app/connectors/helper.js', "await crm.write.put({ dryRun: false });\n");
  // Aliasing a write in a file that imports a connector, through an index import.
  put(root, 'app/modules/alias/handler.js', [
    "const conns = require('../../connectors');",
    'const w = conns.crm.write;',
    'send(conns.crm.write);',
    "process.stdout.write('fine');",
  ].join('\n'));
  // The engine outside the allow-list is scanned too; the archetype is allowed.
  put(root, 'kit/runtime/app/bad.js', "await crm.write.put({ idempotencyKey: 'k', dryRun: false });\n");
  put(root, 'kit/runtime/archetypes/approval-write/push.js', "await crm.write.put({ idempotencyKey: 'k', dryRun: false });\n");
  put(root, 'kit/runtime/connectors/contract.js', "if (dryRun !== false) return plan;\n");
  put(root, 'kit/templates/module/handler.js', "await crm.write.put({ dryRun: false });\n");
  put(root, 'kit/templates/connector/connector.js', "await crm.write.put({ dryRun: false });\n");
  put(root, 'examples/acme/app/modules/m/handler.js', "await crm.write.put({ dryRun: false });\n");
  put(root, 'examples/acme/app/connectors/crm/connector.test.js', "await crm.write.put({ dryRun: false });\n");
  const other = path.join(root, 'elsewhere');
  put(other, 'modules/m/handler.js', 'const { write } = crm;\n');
  // Example clients are scanned only because package.json lists them.
  const listed = (dirs) => writePathProblems(root, { APLABS_APP_DIR: other }).filter((p) => p.startsWith(dirs));
  assert.deepEqual(listed('examples/'), [], 'not listed in package.json: not scanned');
  put(root, 'package.json', JSON.stringify({ name: 'x', aplabs: { appDirs: ['examples/*/app'] } }));

  const problems = writePathProblems(root, { APLABS_APP_DIR: other });
  const where = problems.map((p) => p.split(': ')[0]);
  assert.deepEqual(where, [
    'app/connectors/helper.js:1',
    'app/connectors/helper.js:1',
    'app/modules/alias/handler.js:2',
    'app/modules/alias/handler.js:3',
    'app/modules/push/handler.js:4',
    'app/modules/push/handler.js:5',
    'app/modules/push/handler.js:5',
    'app/modules/push/handler.js:6',
    'app/modules/push/handler.js:7',
    'app/modules/push/handler.js:7',
    'app/modules/push/handler.js:8',
    'app/modules/push/handler.js:9',
    'app/modules/push/handler.js:9',
    'app/modules/push/handler.js:10',
    'app/modules/push/handler.js:11',
    'app/modules/push/handler.js:12',
    'app/modules/push/handler.js:14',
    'elsewhere/modules/m/handler.js:1',
    'examples/acme/app/modules/m/handler.js:1',
    'examples/acme/app/modules/m/handler.js:1',
    'kit/runtime/app/bad.js:1',
    'kit/runtime/app/bad.js:1',
    'kit/templates/module/handler.js:1',
    'kit/templates/module/handler.js:1',
  ]);
  const said = problems.join('\n');
  assert.match(said, /handler\.js:5: passes dryRun other than true/);
  assert.match(said, /handler\.js:4: creates a connector instance/);
  assert.match(said, /handler\.js:10: declares a connector outside a connector's own folder/);
  assert.match(said, /alias\/handler\.js:2: aliases a connector's write operations/);
  assert.match(said, /reaches a connector's write operations/);
  for (const p of problems) assert.match(p, /only kit\/runtime\/archetypes\/approval-write writes live \(AD-15, DEP-012\)/, p);
});

test('the engine names no example client; this repo lists its example app dirs in package.json', () => {
  for (const f of ['kit/verify/write-path.js', 'kit/verify/builtins.js', 'kit/verify/run-all.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /\bexamples\//, f);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.aplabs.appDirs, ['examples/*/app']);
  assert.deepEqual(engine.configuredAppDirs(ROOT).problems, []);
});

test('package.json aplabs.appDirs must be repo-relative paths inside the repo', (t) => {
  const root = tmpRoot(t);
  for (const bad of ['nope', ['/abs'], ['../up'], ['a/../b'], [3]]) {
    put(root, 'package.json', JSON.stringify({ aplabs: { appDirs: bad } }));
    assert.match(writePathProblems(root, {}).join('\n'), /package\.json aplabs\.appDirs/, JSON.stringify(bad));
  }
  put(root, 'package.json', '{ not json');
  assert.match(writePathProblems(root, {}).join('\n'), /package\.json can't be read/);
});

test('the built-in verify check reports pass or fail like any check', (t) => {
  const root = tmpRoot(t);
  const pass = engine.writePathCheck(root, {});
  assert.deepEqual([pass.id, pass.outcome, pass.stderr], ['engine:write-path', 'pass', '']);
  put(root, 'app/modules/m/handler.js', "go({ dryRun: false });\n");
  const fail = engine.writePathCheck(root, {});
  assert.equal(fail.outcome, 'fail');
  assert.match(fail.reason, /^1 problem\(s\)/);
  assert.match(fail.stderr, /app\/modules\/m\/handler\.js:1/);
});

test('a governed repo with no app dir fails, and so does an APLABS_APP_DIR that is missing', (t) => {
  const root = tmpRoot(t);
  // Ungoverned, no app dir (the template without its example, clean bones): passes.
  assert.equal(run(root).status, 0);
  assert.deepEqual(writePathProblems(root, {}), []);
  // An APLABS_APP_DIR that is missing always fails, governed or not.
  const missing = path.join(root, 'nope');
  const set = run(root, { APLABS_APP_DIR: missing });
  assert.equal(set.status, 1);
  assert.match(set.stderr, /APLABS_APP_DIR .*nope.* is not a directory/);
  assert.match(writePathProblems(root, { APLABS_APP_DIR: missing }).join('\n'), /APLABS_APP_DIR/);
  // Governed (.aplabs/profile.yml) with no app/: fails, naming what it looked for.
  put(root, '.aplabs/profile.yml', 'client: x\n');
  const governed = run(root);
  assert.equal(governed.status, 1);
  assert.match(governed.stderr, /no app dir found/);
  // Governed with app/: passes.
  put(root, 'app/modules/m/handler.js', "await preview({ idempotencyKey: 'k' });\n");
  assert.equal(run(root).status, 0);
});

test('the CLI fails naming the file and why, and passes a clean tree', (t) => {
  const root = tmpRoot(t);
  put(root, 'app/modules/m/handler.js', "await crm.write.put({ idempotencyKey: 'k', dryRun: false });\n");
  const bad = run(root);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /app\/modules\/m\/handler\.js:1: passes dryRun other than true/);
  put(root, 'app/modules/m/handler.js', "await preview({ idempotencyKey: 'k' });\n");
  const ok = run(root);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /check-write-path: ok/);
});

test('a scheduled job that reaches a connector\'s write fails npm run check (Story 11.1, Q3)', (t) => {
  const root = tmpRoot(t);
  put(root, 'app/jobs.json', '[]\n');
  put(root, 'app/jobs/push.js', [
    "const crm = require('../connectors/crm/connector');",
    'module.exports = { run: async (ctx) => { await crm.write.put({ idempotencyKey: ctx.name }); } };',
  ].join('\n'));
  put(root, 'app/jobs/fine.js', "module.exports = { run: async (ctx) => { ctx.log.info('read only'); } };\n");
  const problems = writePathProblems(root, {});
  assert.deepEqual(problems.map((p) => p.split(': ')[0]), ['app/jobs/push.js:2']);
  assert.match(problems[0], /reaches a connector's write operations/);
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /app\/jobs\/push\.js:2: reaches a connector's write operations/);
});

test('the approval-write archetype (Story 10.2) passes only because it is the allow-listed folder: the same code anywhere else fails', (t) => {
  const root = tmpRoot(t);
  const real = fs.readFileSync(path.join(ROOT, 'kit/runtime/archetypes/approval-write/index.js'), 'utf8');
  put(root, 'kit/runtime/archetypes/approval-write/index.js', real);
  assert.deepEqual(writePathProblems(root, {}), [], 'inside the archetype folder');
  put(root, 'kit/runtime/archetypes/scoped-pull/push.js', real);
  const problems = writePathProblems(root, {});
  assert.ok(problems.length > 0, 'the push code outside the archetype is caught');
  for (const p of problems) assert.match(p, /^kit\/runtime\/archetypes\/scoped-pull\/push\.js:\d+: /, p);
});
