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
    fs.writeFileSync(path.join(d, 'hubs/gamma.json'), JSON.stringify({ id: 'delta', command: '/gamma', name: 'G', description: 'g', sees: [] }));
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

test('every archetype the schema names is built: approval-write is accepted (Story 10.2), data-sources (Story 16.3) and build-request (Story 16.6) too', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../kit/runtime/schema/module.schema.json'), 'utf8'));
  assert.deepEqual(schema.properties.archetype.enum, ['handler', 'scoped-pull', 'approval-write', 'routing-map', 'data-sources', 'build-request']);
  assert.deepEqual([...require('../../kit/runtime/registry').BUILT_ARCHETYPES], schema.properties.archetype.enum);
  const { registry, problems } = loadApproval();
  assert.deepEqual(problems, []);
  assert.equal(registry.module('leads').archetype, 'approval-write');
  assert.match(registry.module('leads').sql, /^-- A fixture approval-write list/);
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
  const write = {
    connector: 'crm', operation: 'push', destination: 'A list', fields: ['client_id'], send: { ref: 'client_id' }, list_name: 'a-{run_date}',
  };
  const refusal = (file) => `${file}: field "write" is used only by an approval-write module (writes go through that archetype)`;
  const onHandler = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => { m.write = write; }));
  assert.equal(onHandler.registry, null);
  assert.deepEqual(onHandler.problems, [refusal('modules/echo/manifest.json')]);
  const onPull = editRanked((m) => { m.write = write; });
  assert.equal(onPull.registry, null);
  assert.deepEqual(onPull.problems, [refusal(RANKED_FILE)]);
  // approval-write carries one, and must.
  assert.deepEqual(loadApproval().problems, []);
  assert.deepEqual(editLeads((m) => { delete m.write; }).problems, [`${LEADS_FILE}: field "write" is required`]);
});

// Story 10.2: an approval-write module's startup refusals, each naming the
// module file and the field. The fixture app and profile are
// test/fixtures/runtime/approval (the connector's own refusals are in
// runtime-approval-connectors.test.js).
const APPROVAL = path.join(FIX, 'approval');
const approvalProfile = loadProfile(path.join(APPROVAL, 'profile.yml'));
const LEADS_FILE = 'modules/leads/manifest.json';
function loadApproval(edit = () => {}, { withProfile = approvalProfile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-reg-aw-'));
  try {
    fs.cpSync(path.join(APPROVAL, 'app'), dir, { recursive: true });
    // The copied connector requires '#sdk', which resolves from this repo only.
    fs.writeFileSync(path.join(dir, 'connectors/mail/connector.js'), `module.exports = require(${JSON.stringify(path.join(APPROVAL, 'app/connectors/mail/connector.js'))});\n`);
    edit(dir);
    return loadRegistry({ appDir: dir, profile: withProfile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const editLeads = (fn) => loadApproval((d) => editJson(d, LEADS_FILE, fn));

test('startup refuses an approval-write module whose resource is not admin_grantable: false in the profile', () => {
  const grantable = loadProfile(path.join(APPROVAL, 'profile.yml'));
  const open = { ...grantable, resources: grantable.resources.map((r) => (r.key === 'PUSH_LEADS' ? { ...r, admin_grantable: true } : r)) };
  const { registry, problems } = loadApproval(() => {}, { withProfile: open });
  assert.equal(registry, null);
  assert.deepEqual(problems, [`${LEADS_FILE}: field "resource" PUSH_LEADS must be declared admin_grantable: false in the profile: a push sends client data out, so only people granted it by name may use it (AD-16)`]);
});

test('startup refuses an approval-write module with no row_id, or whose row_id is not in write.fields', () => {
  assert.deepEqual(editLeads((m) => { delete m.row_id; }).problems, [`${LEADS_FILE}: field "row_id" is required`]);
  assert.deepEqual(editLeads((m) => { m.write.fields = ['first', 'address']; m.write.send = { first: 'first', address: 'address' }; }).problems, [
    `${LEADS_FILE}: field "write.fields" must include the row id "person_id"`,
  ]);
});

test('startup refuses a write.fields entry the module\'s query does not return', () => {
  assert.deepEqual(editLeads((m) => { m.write.fields.push('phone'); }).problems, [
    `${LEADS_FILE}: field "write.fields" names "phone", which the module's query never returns`,
  ]);
});

test('startup refuses a send mapping that names a field not in write.fields', () => {
  assert.deepEqual(editLeads((m) => { m.write.send.score = 'score'; }).problems, [
    `${LEADS_FILE}: field "write.send.score" names "score", which is not in write.fields`,
  ]);
});

test('startup refuses a list name placeholder that is not {run_date} or a required input with allowed values', () => {
  assert.deepEqual(editLeads((m) => { m.write.list_name = 'leads-{region}-{run_date}'; }).problems, [
    `${LEADS_FILE}: field "write.list_name" uses {region}, which is not a declared input or {run_date}`,
  ]);
  const notEnum = loadApproval((d) => {
    editJson(d, LEADS_FILE, (m) => {
      m.parameters.push({ name: 'tag', type: 'string', pattern: '[a-z]+', max_length: 8, required: true });
      m.write.list_name = 'leads-{tag}';
    });
    const sql = path.join(d, 'modules/leads/leads.sql');
    fs.writeFileSync(sql, fs.readFileSync(sql, 'utf8').replace('WHERE zone = $zone', 'WHERE zone = $zone AND tag = $tag'));
  });
  assert.deepEqual(notEnum.problems, [
    `${LEADS_FILE}: field "write.list_name" uses {tag}; a list name may use only {run_date} and required inputs with allowed values (enum), so nothing typed freely reaches it`,
  ]);
  const optional = loadApproval((d) => {
    editJson(d, LEADS_FILE, (m) => { m.parameters[0].required = false; });
  });
  assert.deepEqual(optional.problems, [
    `${LEADS_FILE}: field "write.list_name" uses {zone}; a list name may use only {run_date} and required inputs with allowed values (enum), so nothing typed freely reaches it`,
  ]);
  assert.deepEqual(editLeads((m) => { m.write.list_name = 'leads-{zone-{run_date}'; }).problems, [
    `${LEADS_FILE}: field "write.list_name" has a "{" or "}" that is not a placeholder ({run_date}, or {<input>})`,
  ]);
  assert.deepEqual(editLeads((m) => { m.write.list_name = 'leads-{run_date}'; }).problems, []);
});

test('startup refuses a write block with no send mapping or list name, or a list name with other characters', () => {
  const missing = editLeads((m) => { delete m.write.send; delete m.write.list_name; });
  assert.deepEqual(missing.problems.sort(), [`${LEADS_FILE}: field "write.list_name" is required`, `${LEADS_FILE}: field "write.send" is required`]);
  assert.match(editLeads((m) => { m.write.list_name = 'leads/<zone>'; }).problems[0], /field "write.list_name" must match pattern/);
});

test('startup refuses an approval-write module with a handler', () => {
  assert.deepEqual(editLeads((m) => { m.handler = 'handler.js'; }).problems, [
    `${LEADS_FILE}: field "handler" is not used by an approval-write module (the engine runs its form)`,
  ]);
});

// --- Story 15.4: the routing-map archetype (AD-R16) -------------------------------------

const ROUTING_PROFILE = loadProfile(path.join(__dirname, '../fixtures/profiles/routing-audience.yml'));
const ROUTING_ADAPTER = path.join(__dirname, '../fixtures/routing-map/adapter.js');
const ROUTING_FILE = 'modules/routing/manifest.json';

// A temp app: one hub and a routing-map module whose adapter re-exports the
// fixture adapter ('#sdk' resolves from this repo only). edit(dir) changes it.
function loadRouting(edit = () => {}, { withProfile = ROUTING_PROFILE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-reg-rm-'));
  try {
    fs.mkdirSync(path.join(dir, 'hubs'));
    fs.mkdirSync(path.join(dir, 'modules/routing'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hubs/ops.json'), JSON.stringify({ id: 'ops', command: '/ops', name: 'Ops', description: 'Ops tools', sees: ['context', 'data', 'rules'] }));
    fs.writeFileSync(path.join(dir, ROUTING_FILE), JSON.stringify({
      id: 'routing', hub: 'ops', label: 'Routing', description: 'Routes on a map', resource: 'ROUTING_ALL_CREWS',
      archetype: 'routing-map', environments: ['dev'], adapter: 'adapter.js',
    }));
    fs.writeFileSync(path.join(dir, 'modules/routing/adapter.js'), `module.exports = require(${JSON.stringify(ROUTING_ADAPTER)});\n`);
    edit(dir);
    return loadRegistry({ appDir: dir, profile: withProfile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const editRouting = (fn) => loadRouting((d) => editJson(d, ROUTING_FILE, fn));

test('a routing-map module with an adapter validates and loads its createAdapter', () => {
  const { registry, problems } = loadRouting();
  assert.deepEqual(problems, []);
  const mod = registry.module('routing');
  assert.equal(mod.archetype, 'routing-map');
  assert.equal(mod.adapter, 'adapter.js');
  assert.equal(mod.createAdapter, require(ROUTING_ADAPTER).createAdapter);
  assert.equal(mod.run, undefined, 'no handler');
});

test('a routing-map module without an adapter, or with an unknown field, fails naming the field', () => {
  assert.deepEqual(editRouting((m) => { delete m.adapter; }).problems, [`${ROUTING_FILE}: field "adapter" is required`]);
  assert.deepEqual(editRouting((m) => { m.map_style = 'dark'; }).problems, [`${ROUTING_FILE}: unknown field "map_style"`]);
  assert.match(editRouting((m) => { m.adapter = '../escape.js'; }).problems[0], /field "adapter" must match pattern/);
});

test('a routing-map adapter that is missing, throws on load or exports no createAdapter is refused', () => {
  const missing = loadRouting((d) => fs.rmSync(path.join(d, 'modules/routing/adapter.js')));
  assert.deepEqual(missing.problems, [`${ROUTING_FILE}: field "adapter" names a file that does not exist`]);
  const throws = loadRouting((d) => fs.writeFileSync(path.join(d, 'modules/routing/adapter.js'), "throw new Error('load failed');\n"));
  assert.deepEqual(throws.problems, [`${ROUTING_FILE}: field "adapter" could not be loaded (load failed)`]);
  const none = loadRouting((d) => fs.writeFileSync(path.join(d, 'modules/routing/adapter.js'), 'module.exports = { input() {} };\n'));
  assert.deepEqual(none.problems, [`${ROUTING_FILE}: field "adapter" must export createAdapter (module.exports = { createAdapter })`]);
});

test('a routing-map module has no handler, query, parameters, scoring or row_id; an adapter belongs to routing-map only', () => {
  assert.deepEqual(editRouting((m) => { m.handler = 'handler.js'; }).problems, [
    `${ROUTING_FILE}: field "handler" is not used by a routing-map module (the engine draws its map)`,
  ]);
  assert.deepEqual(editRouting((m) => { m.query = 'q.sql'; m.parameters = []; }).problems.sort(), [
    `${ROUTING_FILE}: field "parameters" is not used by a routing-map module (the engine draws its map)`,
    `${ROUTING_FILE}: field "query" is not used by a routing-map module (the engine draws its map)`,
  ]);
  const { problems } = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => { m.adapter = 'adapter.js'; }));
  assert.deepEqual(problems, ['modules/echo/manifest.json: field "adapter" is used only by a routing-map module']);
});

test('Story 15.14: a routing-map module may name its screen, views or route-editor; any other value, or a screen on another archetype, is refused', () => {
  for (const screen of ['views', 'route-editor']) {
    const { registry, problems } = editRouting((m) => { m.screen = screen; });
    assert.deepEqual(problems, [], screen);
    assert.equal(registry.module('routing').screen, screen);
  }
  assert.equal(loadRouting().registry.module('routing').screen, undefined, 'no screen: the views (the default)');
  assert.match(editRouting((m) => { m.screen = 'editor'; }).problems[0], /field "screen" must be equal to one of the allowed values/);
  const { problems } = loadEdited((d) => editJson(d, 'modules/echo/manifest.json', (m) => { m.screen = 'route-editor'; }));
  assert.deepEqual(problems, ['modules/echo/manifest.json: field "screen" is used only by a routing-map module']);
});

test('a routing-map module needs the profile\'s routing audience, and its resource is the audience\'s all_crews key', () => {
  const noAudience = loadRouting(() => {}, { withProfile: { ...ROUTING_PROFILE, routing: { ...ROUTING_PROFILE.routing, audience: undefined } } });
  assert.deepEqual(noAudience.problems, [`${ROUTING_FILE}: field "archetype" routing-map needs routing.audience in the profile (who sees which crews)`]);
  assert.deepEqual(editRouting((m) => { m.resource = 'ROUTING_OWN_CREW'; }).problems, [
    `${ROUTING_FILE}: field "resource" must be the profile's routing.audience.all_crews key (ROUTING_ALL_CREWS)`,
  ]);
  assert.deepEqual(editRouting((m) => { m.resource = 'NOT_DECLARED'; }).problems, [
    `${ROUTING_FILE}: field "resource" NOT_DECLARED is not declared in the profile (configuration fault)`,
    `${ROUTING_FILE}: field "resource" must be the profile's routing.audience.all_crews key (ROUTING_ALL_CREWS)`,
  ]);
});
