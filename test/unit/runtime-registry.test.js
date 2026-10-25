'use strict';

// kit/runtime/registry: directory-scan discovery (AD-3) and manifest
// validation with ajv (AD-4). Every problem names the file and the field.
// Fixture app and profile under test/fixtures/runtime/; bad cases are built in
// a temp copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry, loadHubs, isVisible } = require('../../kit/runtime/registry');

const FIX = path.join(__dirname, '../fixtures/runtime');
const APP_DIR = path.join(FIX, 'app');
const profile = loadProfile(path.join(FIX, 'profile.yml'));

// Copies the fixture app to a temp dir, lets edit(dir) change it, loads it.
function loadEdited(edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-reg-'));
  try {
    fs.cpSync(APP_DIR, dir, { recursive: true });
    edit(dir);
    return loadRegistry({ appDir: dir, profile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function editJson(dir, rel, fn) {
  const file = path.join(dir, rel);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(data);
  fs.writeFileSync(file, JSON.stringify(data));
}

test('discovers hubs by file name and modules by folder name, in sorted order', () => {
  const { registry, problems } = loadRegistry({ appDir: APP_DIR, profile });
  assert.deepEqual(problems, []);
  assert.deepEqual(registry.hubs.map((h) => h.id), ['alpha', 'beta']);
  assert.deepEqual(registry.modules.map((m) => m.id), ['boom', 'echo', 'prod-only', 'second']);
  assert.deepEqual(registry.entries('alpha').map((m) => m.id), ['echo', 'prod-only', 'second']);
  assert.equal(registry.hubByCommand('/beta').id, 'beta');
  assert.equal(registry.module('echo').file, 'modules/echo/manifest.json');
  assert.equal(typeof registry.module('echo').run, 'function');
  assert.equal(registry.module('nope'), undefined);
  assert.equal(registry.module(undefined), undefined);
});

test('visibility follows the manifest environments', () => {
  const { registry } = loadRegistry({ appDir: APP_DIR, profile });
  assert.equal(isVisible(registry.module('prod-only'), 'dev'), false);
  assert.equal(isVisible(registry.module('prod-only'), 'prod'), true);
  assert.equal(isVisible(registry.module('echo'), 'dev'), true);
});

test('a missing required field names the file and field', () => {
  const { registry, problems } = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => { delete m.description; }));
  assert.equal(registry, null);
  assert.deepEqual(problems, ['modules/echo/manifest.json: field "description" is required']);
});

test('an unknown field is refused by name', () => {
  const { problems } = loadEdited((d) => editJson(d, 'hubs/beta.json', (h) => { h.colour = 'red'; }));
  assert.deepEqual(problems, [
    'hubs/beta.json: unknown field "colour"',
    'modules/boom/manifest.json: field "hub" names hubs/beta.json, which did not load (see above)',
  ]);
});

test('a wrong-typed nested field names its path', () => {
  const { problems } = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => { m.environments = ['dev', 'Prod']; }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^modules\/echo\/manifest.json: field "environments\[1\]" must match pattern/);
});

test('archetype handler requires a handler file', () => {
  const { problems } = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => { delete m.handler; }));
  assert.deepEqual(problems, ['modules/echo/manifest.json: field "handler" is required']);
});

test('invalid JSON, a missing manifest and a bad hub command are each reported', () => {
  const { problems } = loadEdited((d) => {
    fs.writeFileSync(path.join(d, 'modules/second/manifest.json'), '{ nope');
    fs.mkdirSync(path.join(d, 'modules/empty'));
    editJson(d, 'hubs/beta.json', (h) => { h.command = 'beta'; });
  });
  assert.equal(problems.length, 4);
  assert.match(problems[0], /^hubs\/beta.json: field "command" must match pattern/);
  // boom names hub beta, which no longer loads.
  assert.match(problems[1], /^modules\/boom\/manifest.json: field "hub" names hubs\/beta.json, which did not load/);
  assert.equal(problems[2], 'modules/empty: has no manifest.json');
  assert.match(problems[3], /^modules\/second\/manifest.json: is not valid JSON/);
});

test('a module naming a hub with no file is refused', () => {
  const { problems } = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => { m.hub = 'gamma'; }));
  assert.deepEqual(problems, ['modules/echo/manifest.json: field "hub" names no hub ("gamma" has no hubs/gamma.json)']);
});

test('ids must match their file and folder names; hub commands must be unique', () => {
  const { problems } = loadEdited((d) => {
    editJson(d, 'modules/echo/manifest.json', (m) => { m.id = 'echo-two'; });
    editJson(d, 'hubs/beta.json', (h) => { h.command = '/alpha'; });
    fs.writeFileSync(path.join(d, 'hubs/gamma.json'), JSON.stringify({ id: 'delta', command: '/gamma', name: 'G', description: 'g' }));
  });
  assert.ok(problems.includes('hubs/beta.json: field "command" /alpha is already used by hubs/alpha.json'));
  assert.ok(problems.includes('hubs/gamma.json: field "id" must equal the file name ("gamma")'));
  assert.ok(problems.includes('modules/echo/manifest.json: field "id" must equal the folder name ("echo")'));
});

test('a resource the profile does not declare is a configuration fault', () => {
  const { problems } = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => { m.resource = 'TYPO_THING'; }));
  assert.deepEqual(problems, ['modules/echo/manifest.json: field "resource" TYPO_THING is not declared in the profile (configuration fault)']);
});

test('a module on a declared resource that is not open_access registers (access is decided per person)', () => {
  const { registry, problems } = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => { m.resource = 'CLOSED_THING'; }));
  assert.deepEqual(problems, []);
  assert.equal(registry.module('echo').resource, 'CLOSED_THING');
});

test('an archetype whose engine is not built yet is refused', () => {
  const { problems } = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => {
    m.archetype = 'approval-write';
    m.parameters = [{ name: 'zone', type: 'string', enum: ['north'] }];
    m.query = 'query.sql';
    m.write = { connector: 'crm', operation: 'push', destination: 'A list', fields: ['client_id'] };
  }));
  assert.deepEqual(problems, ['modules/echo/manifest.json: field "archetype" "approval-write" is not available yet']);
});

test('a handler file that is missing, throws on load or exports no function is refused', () => {
  const { problems } = loadEdited((d) => {
    fs.rmSync(path.join(d, 'modules/echo/handler.js'));
    fs.writeFileSync(path.join(d, 'modules/second/handler.js'), "'use strict';\nmodule.exports = { run() {} };\n");
    fs.writeFileSync(path.join(d, 'modules/boom/handler.js'), "'use strict';\nthrow new Error('load failed');\n");
  });
  assert.deepEqual(problems, [
    'modules/boom/manifest.json: field "handler" could not be loaded (load failed)',
    'modules/echo/manifest.json: field "handler" names a file that does not exist',
    'modules/second/manifest.json: field "handler" must export one function (module.exports = async (ctx) => ...)',
  ]);
});

test('a missing app dir is one problem; an app dir with no hubs or modules is valid', () => {
  const missing = loadRegistry({ appDir: path.join(os.tmpdir(), 'aplabs-no-such-app'), profile });
  assert.equal(missing.registry, null);
  assert.match(missing.problems[0], /app dir does not exist/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-empty-'));
  try {
    const empty = loadRegistry({ appDir: dir, profile });
    assert.deepEqual(empty.problems, []);
    assert.deepEqual(empty.registry.hubs, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadHubs needs no profile (the manifest generator uses it alone)', () => {
  const { hubs, problems } = loadHubs(APP_DIR);
  assert.deepEqual(problems, []);
  assert.deepEqual(hubs.map((h) => h.command), ['/alpha', '/beta']);
});

// Story 10.1: a scored module (the fixture under test/fixtures/runtime/scored)
// copied into the app, then edited.
const SCORED = path.join(FIX, 'scored');
const RANKED_FILE = 'modules/ranked/manifest.json';
function loadScored(edit = () => {}) {
  return loadEdited((d) => {
    fs.mkdirSync(path.join(d, 'modules/ranked'));
    for (const f of ['manifest.json', 'ranked.sql']) fs.copyFileSync(path.join(SCORED, f), path.join(d, 'modules/ranked', f));
    edit(d);
  });
}
const editRanked = (fn) => loadScored((d) => editJson(d, RANKED_FILE, fn));
const editRankedSql = (fn) => loadScored((d) => {
  const file = path.join(d, 'modules/ranked/ranked.sql');
  fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
});

test('a scored module loads with its row id, its inputs and its limit input', () => {
  const { registry, problems } = loadScored();
  assert.deepEqual(problems, []);
  const m = registry.module('ranked');
  assert.equal(m.row_id, 'person_id');
  assert.deepEqual(m.scoring.inputs.map((i) => [i.name, i.weight, i.min, i.max]), [['tenure', 2, 0, 24], ['spend', 3, 0, 10000], ['idle', -1, 0, 100], ['rise', 1, 0, 1]]);
  assert.equal(m.scoring.limit_parameter, 'limit');
});

test('startup refuses a scored module with min >= max, all-zero weights, or a limit input that is not a declared integer', () => {
  assert.deepEqual(editRanked((m) => { m.scoring.inputs[2].min = 100; }).problems, [
    `${RANKED_FILE}: field "scoring.inputs[2]" (input "idle") has min 100 at or above max 100; the range must be min < max`,
  ]);
  assert.deepEqual(editRanked((m) => { for (const i of m.scoring.inputs) i.weight = 0; }).problems, [
    `${RANKED_FILE}: field "scoring.inputs" has every weight 0; at least one input must count`,
  ]);
  assert.deepEqual(editRanked((m) => { m.scoring.limit_parameter = 'zone'; }).problems, [
    `${RANKED_FILE}: field "scoring.limit_parameter" names "zone", which must be an integer input`,
  ]);
});

test('startup refuses scored SQL that names the limit input, or lacks the ORDER BY row id or the LIMIT 5001', () => {
  const sqlProblem = (text) => `${RANKED_FILE}: field "query" (ranked.sql) ${text}`;
  assert.deepEqual(editRankedSql((sql) => sql.replace('WHERE zone = $zone', 'WHERE zone = $zone AND n <= $limit')).problems, [
    sqlProblem('its SQL names $limit, the scoring limit; the engine keeps the top $limit after scoring, so the SQL must never use it'),
  ]);
  assert.deepEqual(editRankedSql((sql) => sql.replace('ORDER BY person_id\n', '')).problems, [
    sqlProblem('a scored module\'s SQL must end with an ORDER BY whose last key is the row id (ORDER BY ..., person_id) just before LIMIT 5001, so the rows kept at the cap are the same every time'),
  ]);
  assert.deepEqual(editRankedSql((sql) => sql.replace('LIMIT 5001', 'LIMIT 25')).problems, [
    sqlProblem('a scored module\'s SQL must end with LIMIT 5001 (the 5,000-row cap plus one), as a literal; the engine keeps the person\'s number after scoring'),
  ]);
});

test('scoring needs a row id, and the old inputs-and-weights shape is refused by the schema', () => {
  const noId = editRanked((m) => { delete m.row_id; });
  assert.equal(noId.registry, null);
  assert.deepEqual(noId.problems, [`${RANKED_FILE}: must have property row_id when property scoring is present`]);
  const old = editRanked((m) => { m.scoring = { inputs: ['tenure'], weights: { tenure: 1 } }; });
  assert.equal(old.registry, null);
  assert.ok(old.problems.includes(`${RANKED_FILE}: unknown field "scoring.weights"`), old.problems.join('\n'));
  assert.ok(old.problems.some((p) => p.startsWith(`${RANKED_FILE}: field "scoring.inputs[0]" must be object`)), old.problems.join('\n'));
});

test('a write block is refused on any archetype but approval-write', () => {
  const write = { connector: 'crm', operation: 'push', destination: 'A list', fields: ['client_id'] };
  const refusal = (file) => `${file}: field "write" is used only by an approval-write module (writes go through that archetype)`;
  const onHandler = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => { m.write = write; }));
  assert.equal(onHandler.registry, null);
  assert.deepEqual(onHandler.problems, [refusal('modules/echo/manifest.json')]);
  const onPull = editRanked((m) => { m.write = write; });
  assert.equal(onPull.registry, null);
  assert.deepEqual(onPull.problems, [refusal(RANKED_FILE)]);
  // approval-write may carry one (refused only because its engine isn't built yet).
  const onWrite = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => {
    m.archetype = 'approval-write';
    m.parameters = [{ name: 'zone', type: 'string', enum: ['north'] }];
    m.query = 'query.sql';
    m.write = write;
  }));
  assert.deepEqual(onWrite.problems, ['modules/echo/manifest.json: field "archetype" "approval-write" is not available yet']);
});
