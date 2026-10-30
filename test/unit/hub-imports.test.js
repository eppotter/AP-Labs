'use strict';

// The hub-imports check (Story 16.1, plan brightside-v0 D1, review A8, PR
// #262 review): npm run check fails a module file that imports
// kit/runtime/data on a hub that does not see data, or kit/runtime/llm or
// kit/runtime/knowledge, or names the profile's context files, on a hub that
// does not see context, naming the file and line. Planted files in a temp
// repo; nothing here is a client's.

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
const WHY = / \(a module reaches data, the AI and context only through its hub's view, as its hub's sees allows \(plan brightside-v0, D1\)\)$/;
const short = (problems) => problems.map((p) => {
  assert.match(p, WHY);
  return p.replace(WHY, '');
});

// One file importing all three engine folders, by a relative path and by name.
const IMPORTS_ALL = [
  "'use strict';",
  "const data = require('../../../kit/runtime/data');",
  "const llm = require('kit/runtime/llm/index.js');",
  "import store from '../../../kit/runtime/knowledge/store.js';",
  "const ok = require('#sdk');",
  "// require('../../../kit/runtime/data') in a comment is fine",
  'module.exports = async () => {};',
].join('\n');

test('npm run check runs the hub-imports check, and this repo passes it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.check, /node scripts\/check-hub-imports\.js/);
  assert.deepEqual(hubImportProblems(ROOT, { env: {} }), []);
});

test('a blank hub: importing the runner, the AI service or the knowledge store fails, naming the file and line', (t) => {
  const root = tmpRoot(t);
  hub(root, 'blank', []);
  mod(root, 'peek', 'blank', { 'handler.js': IMPORTS_ALL });
  assert.deepEqual(short(hubImportProblems(root, { env: {} })), [
    'app/modules/peek/handler.js:2: imports ../../../kit/runtime/data on a hub that does not see data',
    'app/modules/peek/handler.js:3: imports kit/runtime/llm/index.js on a hub that does not see context',
    'app/modules/peek/handler.js:4: imports ../../../kit/runtime/knowledge/store.js on a hub that does not see context',
  ]);
  const res = run(root);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /check-hub-imports: 3 problem\(s\)/);
});

test('a ["data"] hub: the runner is allowed; the AI service, the knowledge store and the context files are not', (t) => {
  const root = tmpRoot(t);
  hub(root, 'numbers', ['data']);
  mod(root, 'peek', 'numbers', {
    'handler.js': IMPORTS_ALL,
    'read.js': "require('node:fs').readFileSync('.aplabs/context/org.md', 'utf8');\n",
  });
  assert.deepEqual(short(hubImportProblems(root, { env: {} })), [
    'app/modules/peek/handler.js:3: imports kit/runtime/llm/index.js on a hub that does not see context',
    'app/modules/peek/handler.js:4: imports ../../../kit/runtime/knowledge/store.js on a hub that does not see context',
    'app/modules/peek/read.js:1: names a context path (".aplabs/context/org.md") on a hub that does not see context',
  ]);
});

test('a ["context"] hub: the AI service and the context files are allowed; the runner is not', (t) => {
  const root = tmpRoot(t);
  hub(root, 'words', ['context']);
  mod(root, 'peek', 'words', {
    'handler.js': IMPORTS_ALL,
    'read.js': "require('node:fs').readFileSync('.aplabs/context/org.md', 'utf8');\n",
  });
  assert.deepEqual(short(hubImportProblems(root, { env: {} })), [
    'app/modules/peek/handler.js:2: imports ../../../kit/runtime/data on a hub that does not see data',
  ]);
});

test('context paths: .aplabs/context and the four context files fail; a URL or other text with /context/ passes', (t) => {
  const root = tmpRoot(t);
  hub(root, 'blank', []);
  mod(root, 'reader', 'blank', {
    'lib/read.js': [
      "const fs = require('node:fs');",
      "fs.readFileSync('.aplabs/context/org.md', 'utf8');",
      'fs.readFileSync(`${dir}/context/data.md`);',
      "fs.readFileSync('/srv/app/.aplabs/context');",
      "fs.readFileSync('context/Guardrails.md');",
      "const help = 'https://docs.example.com/context/getting-started';",
      "const page = 'https://example.com/context/org.html';",
      "const words = 'Add context to this hub';",
      "const tpl = 'templates/context/intro.txt';",
      "const name = 'x'; require(name);",
    ].join('\n'),
  });
  assert.deepEqual(short(hubImportProblems(root, { env: {} })), [
    'app/modules/reader/lib/read.js:2: names a context path (".aplabs/context/org.md") on a hub that does not see context',
    'app/modules/reader/lib/read.js:3: names a context path ("${dir}/context/data.md") on a hub that does not see context',
    'app/modules/reader/lib/read.js:4: names a context path ("/srv/app/.aplabs/context") on a hub that does not see context',
    'app/modules/reader/lib/read.js:5: names a context path ("context/Guardrails.md") on a hub that does not see context',
    'app/modules/reader/lib/read.js:10: a non-literal require, whose target can\'t be checked',
  ]);
});

test('a full hub passes everything; a missing hub file or sees counts as seeing nothing (fail closed)', (t) => {
  const root = tmpRoot(t);
  hub(root, 'full', ['context', 'data', 'rules']);
  hub(root, 'nosees');
  const code = "const data = require('../../../kit/runtime/data');\nconst name = 'x'; require(name);\n";
  mod(root, 'ok', 'full', { 'handler.js': code });
  mod(root, 'old', 'nosees', { 'handler.js': code });
  mod(root, 'lost', 'gone', { 'handler.js': code });
  mod(root, 'weird', '../full', { 'handler.js': code });
  const problems = short(hubImportProblems(root, { env: {} }));
  assert.deepEqual(problems.filter((p) => /imports/.test(p)), [
    'app/modules/lost/handler.js:1: imports ../../../kit/runtime/data on a hub that does not see data',
    'app/modules/old/handler.js:1: imports ../../../kit/runtime/data on a hub that does not see data',
    'app/modules/weird/handler.js:1: imports ../../../kit/runtime/data on a hub that does not see data',
  ]);
  assert.ok(!problems.some((p) => p.startsWith('app/modules/ok/')), 'a full hub is not checked');
  assert.equal(run(tmpRoot(t)).status, 0);
});
