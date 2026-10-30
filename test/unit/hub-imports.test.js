'use strict';

// The hub-imports check (Story 16.1, plan brightside-v0 D1, review A8): npm
// run check fails a module file on a hub that does not see data that imports
// kit/runtime/data, kit/runtime/llm or kit/runtime/knowledge, or names a
// .aplabs or context/ path, naming the file and line. Planted files in a
// temp repo; nothing here is a client's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hubImportProblems } = require('../../kit/verify/hub-imports');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-hub-imports.js');

function tmpRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-hub-imports-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const hub = (root, id, sees) => put(root, `app/hubs/${id}.json`, JSON.stringify({ id, command: `/${id}`, name: id, description: id, ...(sees ? { sees } : {}) }));
const mod = (root, id, hubId, files) => {
  put(root, `app/modules/${id}/manifest.json`, JSON.stringify({ id, hub: hubId }));
  for (const [name, text] of Object.entries(files)) put(root, `app/modules/${id}/${name}`, text);
};
const run = (root) => spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8', env: { ...process.env, APLABS_APP_DIR: '' } });
const WHY = /a module on a hub that does not see data reaches data, the AI and context only through its hub's view/;

test('npm run check runs the hub-imports check, and this repo passes it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.check, /node scripts\/check-hub-imports\.js/);
  assert.deepEqual(hubImportProblems(ROOT, { env: {} }), []);
});

test('a module on a blank hub that imports the runner, the AI service or the knowledge store fails, naming the file and line', (t) => {
  const root = tmpRoot(t);
  hub(root, 'blank', []);
  mod(root, 'peek', 'blank', {
    'handler.js': [
      "'use strict';",
      "const data = require('../../../kit/runtime/data');",
      "const llm = require('kit/runtime/llm/index.js');",
      "import store from '../../../kit/runtime/knowledge/store.js';",
      "const ok = require('#sdk');",
      '// require(\'../../../kit/runtime/data\') in a comment is fine',
      'module.exports = async () => {};',
    ].join('\n'),
  });
  const problems = hubImportProblems(root, { env: {} });
  assert.deepEqual(problems.map((p) => p.replace(/ \(a module on .*\)$/, '')), [
    'app/modules/peek/handler.js:2: imports ../../../kit/runtime/data',
    'app/modules/peek/handler.js:3: imports kit/runtime/llm/index.js',
    'app/modules/peek/handler.js:4: imports ../../../kit/runtime/knowledge/store.js',
  ]);
  for (const p of problems) assert.match(p, WHY);
  const res = run(root);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /check-hub-imports: 3 problem\(s\)/);
});

test('a module on a blank hub that names a .aplabs or context/ path, or loads a computed path, fails', (t) => {
  const root = tmpRoot(t);
  hub(root, 'blank', []);
  mod(root, 'reader', 'blank', {
    'lib/read.js': [
      "const fs = require('node:fs');",
      "fs.readFileSync('.aplabs/context/org.md', 'utf8');",
      'fs.readFileSync(`${dir}/context/data.md`);',
      "const name = 'x'; require(name);",
      "const words = 'Add context to this hub';",
    ].join('\n'),
  });
  const problems = hubImportProblems(root, { env: {} }).map((p) => p.replace(/ \(a module on .*\)$/, ''));
  assert.deepEqual(problems, [
    'app/modules/reader/lib/read.js:2: names a context path (".aplabs/context/org.md")',
    'app/modules/reader/lib/read.js:3: names a context path ("${dir}/context/data.md")',
    'app/modules/reader/lib/read.js:4: a non-literal require, whose target can\'t be checked',
  ]);
});

test('the same imports on a hub that sees data pass; a missing hub file or sees counts as blank (fail closed)', (t) => {
  const root = tmpRoot(t);
  hub(root, 'full', ['context', 'data', 'rules']);
  hub(root, 'nosees');
  const code = "const data = require('../../../kit/runtime/data');\n";
  mod(root, 'ok', 'full', { 'handler.js': code });
  mod(root, 'old', 'nosees', { 'handler.js': code });
  mod(root, 'lost', 'gone', { 'handler.js': code });
  mod(root, 'weird', '../full', { 'handler.js': code });
  const problems = hubImportProblems(root, { env: {} }).map((p) => p.replace(/ \(a module on .*\)$/, ''));
  assert.deepEqual(problems, [
    'app/modules/lost/handler.js:1: imports ../../../kit/runtime/data',
    'app/modules/old/handler.js:1: imports ../../../kit/runtime/data',
    'app/modules/weird/handler.js:1: imports ../../../kit/runtime/data',
  ]);
  assert.equal(run(tmpRoot(t)).status, 0);
});
