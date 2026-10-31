'use strict';

// Plan hub-status-menu, Story 17.1 (D5, D10): the example's manifests carry
// the menu verbs and groups the plan names, and every label and group passes
// the registry's Setup and status-mark refusal. Uses the demo profile's
// fixture copy, never profiles/brightside.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../../kit/lib/profile');
const { loadRegistry } = require('../../../kit/runtime/registry');
const { menuVerbOf } = require('../../../kit/runtime/registry/vocabulary');

const ROOT = path.join(__dirname, '../../..');
const profile = loadProfile(path.join(__dirname, 'fixtures/demo-profile.yml'));
const { registry, problems } = loadRegistry({ appDir: path.join(ROOT, 'examples/brightside/app'), profile });

test('the example app loads: its labels and groups say neither "Setup" nor a status mark', () => {
  assert.deepEqual(problems, []);
});

test('the example\'s verbs and groups are D5\'s and D10\'s', () => {
  const got = Object.fromEntries(registry.modules.map((m) => [m.id, [m.group || null, menuVerbOf(m)]]));
  assert.deepEqual(got, {
    dataset: [null, 'View'],
    'hello-world': [null, 'Run'],
    'labour-cost': ['Lists', 'Run'],
    outbox: [null, 'View'],
    'route-planner': ['Routing', 'View'],
    routing: ['Routing', 'View'],
    'unpaid-invoices': ['Lists', 'Run'],
    'v0-add-context': [null, 'Add'],
    'v0-ask': [null, 'Ask'],
    'v0-build-request': [null, 'Request'],
    'v0-data-sources': [null, 'View'],
    'win-back': ['Lists', 'Review'],
  });
});
