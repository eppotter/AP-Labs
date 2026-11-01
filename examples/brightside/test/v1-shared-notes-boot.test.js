'use strict';

// Story 19.1 (plan brightside-v1, D5, D6; PR #307 review), on the real v1 hub
// since Story 19.2: brightside-v1.json ("notes": "brightside-v0") and its
// folders boot with the shared-notes checks. The example app is loaded in
// place (its adapters and handlers resolve #sdk only inside the repo). Boot
// finds no problem in dev or prod; a scoped pull moved onto v1 under a key
// other than Ask's is refused, because its reader's prompt would carry the
// shared notes. The profile is the example's test fixture, never
// profiles/brightside.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../../kit/lib/profile');
const { loadRegistry } = require('../../../kit/runtime/registry');
const { bootProblems } = require('../../../kit/runtime/slack/hub-view');

const APP = path.join(__dirname, '../app');
const profile = loadProfile(path.join(__dirname, 'fixtures/demo-profile.yml'));

// The example's registry, with any module in moved put on the v1 hub.
function v1({ moved = [] } = {}) {
  const { registry, problems } = loadRegistry({ appDir: APP, profile });
  assert.deepEqual(problems, []);
  const modules = registry.modules.map((m) => (moved.includes(m.id) ? { ...m, hub: 'brightside-v1' } : m));
  return { hubs: registry.hubs, modules };
}

test('the v1 hub (notes shared with v0; route skills, Ask, Request a tool, Add context, Data sources) boots with no problem', () => {
  const { hubs, modules } = v1();
  assert.equal(hubs.find((h) => h.id === 'brightside-v1').notes, 'brightside-v0');
  assert.deepEqual(modules.filter((m) => m.hub === 'brightside-v1').map((m) => [m.id, m.archetype, m.resource]), [
    ['v1-add-context', 'add-context', 'ADD_CONTEXT'],
    ['v1-ask', 'ask', 'ASK'],
    ['v1-build-request', 'build-request', 'BUILD_REQUEST'],
    ['v1-data-sources', 'data-sources', 'DATA_SOURCES'],
    ['v1-route-cancellation', 'routing-map', 'ROUTING_ALL_CREWS'],
    ['v1-route-crew-out', 'routing-map', 'ROUTING_ALL_CREWS'],
    ['v1-route-map', 'routing-map', 'ROUTING_ALL_CREWS'],
    ['v1-route-optimize', 'routing-map', 'ROUTING_ALL_CREWS'],
  ]);
  for (const env of ['dev', 'prod']) assert.deepEqual(bootProblems({ hubs, modules, env }), [], env);
});

test('on the v1 hub, a scoped pull under a key other than Ask\'s is refused: its reader\'s prompt carries the shared notes', () => {
  const { hubs, modules } = v1({ moved: ['unpaid-invoices'] });
  const pull = modules.find((m) => m.id === 'unpaid-invoices');
  assert.equal(pull.archetype, 'scoped-pull');
  assert.notEqual(pull.resource, 'ASK');
  const refused = bootProblems({ hubs, modules, env: 'dev' });
  assert.equal(refused.length, 1, refused.join('\n'));
  assert.ok(refused[0].startsWith(`hubs/brightside-v1.json: field "notes" shares the notes of brightside-v0, but modules/unpaid-invoices/manifest.json (a scoped-pull module on brightside-v1) uses "resource" ${pull.resource}, and its AI calls carry the shared notes; use ASK, the key that reads them,`), refused[0]);
});
