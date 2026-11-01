'use strict';

// Story 19.1 (plan brightside-v1, D5, D6; PR #307 review): the v1 hub the
// plan designs still boots with the shared-notes checks. The example app is
// loaded in place (its adapters and handlers resolve #sdk only inside the
// repo); brightside-v1.json ("notes": "brightside-v0") is checked against the
// hub schema, and D5's first folders (Story 19.2 builds the real ones) are
// copies of the example's manifests with v1 ids: Optimize a route and Route
// map (routing-map, ROUTING_ALL_CREWS), Ask, Request a tool, Add context and
// Data sources, each with v0's key. Boot finds no problem; a scoped pull on
// v1 under another key is refused. The profile is the example's test
// fixture, never profiles/brightside.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../../kit/lib/profile');
const { loadRegistry, loadHubs } = require('../../../kit/runtime/registry');
const { bootProblems } = require('../../../kit/runtime/slack/hub-view');

const APP = path.join(__dirname, '../app');
const profile = loadProfile(path.join(__dirname, 'fixtures/demo-profile.yml'));
const V1 = {
  id: 'brightside-v1',
  command: '/brightside-v1',
  name: 'Brightside v1',
  description: 'Open the Brightside v1 menu',
  sees: ['context', 'data', 'rules'],
  notes: 'brightside-v0',
  welcome: 'Brightside on your real data: it knows the company, follows its rules, and plans routes.',
};

// The example's registry plus the v1 hub (schema-checked) and D5's copies.
function v1(t, { moved = [] } = {}) {
  const { registry, problems } = loadRegistry({ appDir: APP, profile });
  assert.deepEqual(problems, []);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-v1-hub-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'hubs'));
  fs.writeFileSync(path.join(dir, 'hubs/brightside-v1.json'), JSON.stringify(V1));
  const loaded = loadHubs(dir);
  assert.deepEqual(loaded.problems, []);
  const copy = (from, id, extra = {}) => ({
    ...registry.module(from), id, hub: 'brightside-v1', file: `modules/${id}/manifest.json`, ...extra,
  });
  const modules = [
    ...registry.modules.map((m) => (moved.includes(m.id) ? { ...m, hub: 'brightside-v1' } : m)),
    copy('route-planner', 'v1-route-optimize', { label: 'Optimize a route', environments: ['dev'] }),
    copy('routing', 'v1-route-map', { environments: ['dev'] }),
    ...['ask', 'build-request', 'add-context', 'data-sources'].map((tool) => copy(`v0-${tool}`, `v1-${tool}`)),
  ];
  return { hubs: [...registry.hubs, ...loaded.hubs], modules };
}

test('the plan\'s v1 hub (notes shared with v0; route tools, Ask, Request a tool, Add context, Data sources) boots with no problem', (t) => {
  const { hubs, modules } = v1(t);
  assert.equal(hubs.find((h) => h.id === 'brightside-v1').notes, 'brightside-v0');
  assert.deepEqual(modules.filter((m) => m.hub === 'brightside-v1').map((m) => [m.id, m.archetype, m.resource]), [
    ['v1-route-optimize', 'routing-map', 'ROUTING_ALL_CREWS'],
    ['v1-route-map', 'routing-map', 'ROUTING_ALL_CREWS'],
    ['v1-ask', 'ask', 'ASK'],
    ['v1-build-request', 'build-request', 'BUILD_REQUEST'],
    ['v1-add-context', 'add-context', 'ADD_CONTEXT'],
    ['v1-data-sources', 'data-sources', 'DATA_SOURCES'],
  ]);
  for (const env of ['dev', 'prod']) assert.deepEqual(bootProblems({ hubs, modules, env }), [], env);
});

test('on that v1 hub, a scoped pull under a key other than Ask\'s is refused: its reader\'s prompt carries the shared notes', (t) => {
  const { hubs, modules } = v1(t, { moved: ['unpaid-invoices'] });
  const pull = modules.find((m) => m.id === 'unpaid-invoices');
  assert.equal(pull.archetype, 'scoped-pull');
  assert.notEqual(pull.resource, 'ASK');
  const refused = bootProblems({ hubs, modules, env: 'dev' });
  assert.equal(refused.length, 1, refused.join('\n'));
  assert.ok(refused[0].startsWith(`hubs/brightside-v1.json: field "notes" shares the notes of brightside-v0, but modules/unpaid-invoices/manifest.json (a scoped-pull module on brightside-v1) uses "resource" ${pull.resource}, and its AI calls carry the shared notes; use ASK, the key that reads them,`), refused[0]);
});
