'use strict';

// DEP-012 / AD-15: only the approval-write archetype writes live. The
// write-path check (scripts/check-write-path.js, also run by npm run check)
// fails app code, the templates or the engine that passes dryRun other than
// true, reaches a connector's write operations, creates a connector instance
// or declares a connector outside the allow-list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

test('the allow-list is the approval-write archetype, the contract, and each connector\'s own folder', () => {
  assert.deepEqual(ALLOWED, [
    'kit/runtime/archetypes/approval-write/**',
    'kit/runtime/connectors/**',
    'kit/templates/connector/**',
    '<app dir>/connectors/**',
  ]);
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
  ].join('\n'));
  // Allowed: the connector's own folder, a dry run, a stream write, a non-connector create().
  put(root, 'app/connectors/email/connector.js', "await x.write.createList({ dryRun: false }); defineConnector({}); c.create({});\n");
  put(root, 'app/modules/fine/handler.js', "process.stdout.write('x'); Object.create(null); createLog({ write: deps.write }); const r = require('../../connectors/email/outbox');\n");
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

  const problems = writePathProblems(root, { APLABS_APP_DIR: other });
  const where = problems.map((p) => p.split(': ')[0]);
  assert.deepEqual(where, [
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
  assert.match(said, /handler\.js:10: declares a connector outside a connectors\/ folder/);
  assert.match(said, /reaches a connector's write operations/);
  for (const p of problems) assert.match(p, /only kit\/runtime\/archetypes\/approval-write writes live \(AD-15, DEP-012\)/, p);
});

test('the CLI fails naming the file and why, and passes a clean tree', (t) => {
  const root = tmpRoot(t);
  put(root, 'app/modules/m/handler.js', "await crm.write.put({ idempotencyKey: 'k', dryRun: false });\n");
  const bad = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8', env: { ...process.env, APLABS_APP_DIR: '' } });
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /app\/modules\/m\/handler\.js:1: passes dryRun other than true/);
  fs.rmSync(path.join(root, 'app'), { recursive: true });
  put(root, 'app/modules/m/handler.js', "await preview({ idempotencyKey: 'k' });\n");
  const ok = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8', env: { ...process.env, APLABS_APP_DIR: '' } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /check-write-path: ok/);
});
