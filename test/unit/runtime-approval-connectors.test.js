'use strict';

// Story 10.2 (finding B1): connectors are loaded only by
// kit/runtime/archetypes/approval-write/connectors.js, by discovery, only for
// the connectors approval-write modules name, one instance per connector per
// process, made with the app's logger and env. A missing connector, one that
// fails to load or isn't a declared connector, and an unknown operation each
// stop startup naming the module and the field. No other engine file imports
// a connector, and no engine file outside the allow-listed folders reads a
// module's write block. The app dir is a fixture, never a client's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { loadModules, loadRegistry } = require('../../kit/runtime/registry');
const { checkWrite, createConnectors, connectorIds } = require('../../kit/runtime/archetypes/approval-write/connectors');
const { main } = require('../../kit/runtime/app');
const { writePathProblems } = require('../../kit/verify/write-path');
const { testLog } = require('../../kit/runtime/sdk');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const ROOT = path.resolve(__dirname, '../..');
const FIX = path.join(__dirname, '../fixtures/runtime/approval');
const APP = path.join(FIX, 'app');
const PROFILE_PATH = path.join(FIX, 'profile.yml');
const profile = loadProfile(PROFILE_PATH);
const mail = require(path.join(APP, 'connectors/mail/connector.js'));
const MANIFEST = 'modules/leads/manifest.json';

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// A copy of the fixture app dir that edit(dir) may change.
function appCopy(edit = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-approval-'));
  tmpDirs.push(dir);
  fs.cpSync(APP, dir, { recursive: true });
  // The copied connector requires '#sdk', which resolves from this repo only.
  fs.writeFileSync(path.join(dir, 'connectors/mail/connector.js'), `module.exports = require(${JSON.stringify(path.join(APP, 'connectors/mail/connector.js'))});\n`);
  edit(dir);
  return dir;
}
const editManifest = (dir, fn) => {
  const file = path.join(dir, MANIFEST);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(m);
  fs.writeFileSync(file, JSON.stringify(m));
};
const problemsOf = (dir) => loadModules(dir, { hubs: [{ id: 'alpha' }], profile }).problems;

test('the fixture app loads: its connector exists and declares the module\'s write operation', () => {
  const { registry, problems } = loadRegistry({ appDir: APP, profile });
  assert.deepEqual(problems, []);
  const mod = registry.module('leads');
  assert.equal(mod.archetype, 'approval-write');
  assert.deepEqual(checkWrite(mod, APP), []);
  assert.deepEqual(connectorIds(registry.modules), ['mail']);
});

test('one instance per connector, made with the app\'s logger and env, shared by every module that names it', () => {
  const { registry } = loadRegistry({ appDir: APP, profile });
  const mod = registry.module('leads');
  const twin = Object.freeze({ ...mod, id: 'leads-twin' });
  const before = mail.state.created;
  const log = testLog();
  const env = { FIXTURE_MAIL_OFF: '' };
  const connectors = createConnectors({ appDir: APP, modules: [mod, twin], log, env });
  assert.equal(mail.state.created - before, 1, 'two modules, one connector: one instance');
  assert.deepEqual(Object.keys(mail.state.deps).sort(), ['env', 'log']);
  assert.equal(mail.state.deps.log, log, 'made with the app\'s logger');
  assert.equal(mail.state.deps.env, env, 'and the app\'s env');
  assert.deepEqual(connectors.ids(), ['mail']);
  assert.ok(connectors.has('mail'));
  assert.equal(connectors.get('mail'), connectors.get('mail'));
  assert.equal(connectors.get('mail').id, 'mail');
  // Only connectors an approval-write module names are made.
  assert.deepEqual(createConnectors({ appDir: APP, modules: [], log, env }).ids(), []);
  assert.equal(mail.state.created - before, 1);
});

test('boot makes one instance per connector the modules name, and hands it to the hubs', async (t) => {
  const before = mail.state.created;
  const lines = [];
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      APLABS_PROFILE: PROFILE_PATH,
      APLABS_APP_DIR: APP,
      APLABS_DATA_PATH: path.join(os.tmpdir(), 'aplabs-no-data', 'none.duckdb'),
    },
    cwd: os.tmpdir(),
    deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => res.data.close());
  assert.equal(mail.state.created - before, 1);
  assert.deepEqual(res.connectors.ids(), ['mail']);
});

test('a missing connector folder stops startup, naming the module and the connector', () => {
  const dir = appCopy((d) => editManifest(d, (m) => { m.write.connector = 'nope'; }));
  assert.deepEqual(problemsOf(dir), [
    `${MANIFEST}: field "write.connector" names "nope", but connectors/nope/connector.js does not exist in the app dir`,
  ]);
  assert.throws(() => createConnectors({
    appDir: dir, modules: [{ archetype: 'approval-write', write: { connector: 'nope' } }], log: testLog(), env: {},
  }), /connectors\/nope\/connector\.js does not exist/);
});

test('a connector that fails to load, fails checkDeclaration or is not a declared connector stops startup', () => {
  const cases = [
    ["throw new Error('boom at load');", /could not be loaded \(boom at load\)/],
    // defineConnector runs checkDeclaration as the file loads.
    [`const { defineConnector } = require(${JSON.stringify(path.join(ROOT, 'kit/runtime/sdk'))});\nmodule.exports = defineConnector({ id: 'mail', system: 'x', auth: { env: ['lower'] }, killSwitchEnv: 'X_OFF', rateLimit: { perSecond: 1, batchSize: 1 }, write: { sendList: { plan() {}, apply() {} } } });`, /could not be loaded \(connector "mail": field "auth.env" must list env var names/],
    ['module.exports = { write: { sendList() {} } };', /does not export a connector declared with defineConnector/],
  ];
  for (const [source, expected] of cases) {
    const dir = appCopy((d) => fs.writeFileSync(path.join(d, 'connectors/mail/connector.js'), `'use strict';\n${source}\n`));
    const problems = problemsOf(dir);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.ok(problems[0].startsWith(`${MANIFEST}: field "write.connector" names "mail", but connectors/mail/connector.js `), problems[0]);
    assert.match(problems[0], expected);
  }
});

test('a connector whose id is not its folder name stops startup', () => {
  const dir = appCopy((d) => {
    fs.renameSync(path.join(d, 'connectors/mail'), path.join(d, 'connectors/post'));
    editManifest(d, (m) => { m.write.connector = 'post'; });
  });
  assert.deepEqual(problemsOf(dir), [`${MANIFEST}: field "write.connector" names "post", but connectors/post/connector.js declares id "mail" (it must equal its folder name)`]);
});

test('a write operation the connector does not declare stops startup, naming what it has', () => {
  const dir = appCopy((d) => editManifest(d, (m) => { m.write.operation = 'pushList'; }));
  assert.deepEqual(problemsOf(dir), [`${MANIFEST}: field "write.operation" "pushList" is not a write operation of connector "mail" (it has sendList)`]);
});

test('a connector folder no approval-write module names is never loaded', () => {
  const dir = appCopy((d) => {
    fs.mkdirSync(path.join(d, 'connectors/unused'));
    fs.writeFileSync(path.join(d, 'connectors/unused/connector.js'), "throw new Error('must not load');\n");
  });
  assert.deepEqual(problemsOf(dir), []);
});

// Every .js file under dir, relative to ROOT.
function jsUnder(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...jsUnder(abs));
    else if (d.name.endsWith('.js')) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out;
}
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

test('no other engine file imports a connector: only approval-write/connectors.js loads one', () => {
  const files = jsUnder(path.join(ROOT, 'kit/runtime'));
  // A require with a computed path loads app code: handlers, jobs, connectors.
  const dynamic = files.filter((f) => /\brequire\(\s*[^'"`\s)]/.test(codeOf(f))).sort();
  assert.deepEqual(dynamic, [
    'kit/runtime/archetypes/approval-write/connectors.js',
    'kit/runtime/jobs/index.js',
    'kit/runtime/registry/index.js',
  ]);
  // Only the loader names a connector file or the app's connectors folder.
  const naming = files.filter((f) => /['"`]connector\.js['"`]|['"`]connectors['"`]/.test(codeOf(f)));
  assert.deepEqual(naming, ['kit/runtime/archetypes/approval-write/connectors.js']);
  // A literal require of a connectors path is the contract or the loader,
  // never a connector.
  const allowed = ['kit/runtime/connectors/contract', 'kit/runtime/connectors/suite', 'kit/runtime/archetypes/approval-write/connectors'];
  for (const f of files) {
    for (const m of codeOf(f).matchAll(/require\(\s*['"`]([^'"`]*connectors[^'"`]*)['"`]\s*\)/g)) {
      const target = path.relative(ROOT, path.resolve(ROOT, path.dirname(f), m[1])).split(path.sep).join('/').replace(/\.js$/, '');
      assert.ok(allowed.includes(target), `${f} requires ${m[1]}`);
    }
  }
});

test('no engine file outside approval-write and the contract reads a module\'s write block', () => {
  const files = jsUnder(path.join(ROOT, 'kit/runtime'))
    .filter((f) => !f.startsWith('kit/runtime/archetypes/approval-write/') && !f.startsWith('kit/runtime/connectors/'));
  const reads = [];
  for (const f of files) {
    codeOf(f).split('\n').forEach((line) => {
      // A call (stream.write(...)) and the logger's deps.write are not a write block.
      if (/\.write\b(?!\s*\()/.test(line.replace(/\bdeps\.write\b/g, ''))) reads.push(`${f}: ${line.trim()}`);
    });
  }
  assert.deepEqual(reads, []);
});

test('npm run check\'s write-path check passes with the archetype and its connector loader in place', () => {
  assert.deepEqual(writePathProblems(ROOT, { env: {} }), []);
});
