'use strict';

// Brightside's demo profile is valid against the engine's schema. An example
// test (architecture carve-out, moved here from test/unit in Story 6.5): it
// reads profiles/brightside/ and is deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../../kit/lib/profile');

test('the Brightside demo profile is valid', () => {
  const p = loadProfile(path.join(__dirname, '../../../profiles/brightside/profile.yml'));
  assert.equal(p.client.id, 'brightside');
});

// Story 10.2 (Q6): Win-back pushes to the email tool (approval-write), so its
// resource is owner-only and granted to Dana by name; the admin role alone
// does not confer it.
test('WIN_BACK is admin_grantable: false and granted to Dana by name', () => {
  const p = loadProfile(path.join(__dirname, '../../../profiles/brightside/profile.yml'));
  assert.equal(p.resources.find((r) => r.key === 'WIN_BACK').admin_grantable, false);
  const holders = p.users.filter((u) => (u.grants || []).includes('WIN_BACK')).map((u) => u.name);
  assert.deepEqual(holders, ['Dana Reyes']);
});

// Story 10.3: slack.ops_channel stays unset until Ely creates #brightside-ops
// in aplabs-demo and gives its id (DEP ledger), so a failed push is logged
// only. Setting it is a reviewed profile change: update this test with it.
test('slack.ops_channel is not set yet: a failed push is logged only', () => {
  const p = loadProfile(path.join(__dirname, '../../../profiles/brightside/profile.yml'));
  assert.equal(p.slack, undefined);
});

// Story 13.3 (AD-R9, AD-R10): the four coordinate columns are forbidden to
// every query before the generator adds them (Story 14.1), and the routing
// block declares where each node kind keeps them plus the generator's day
// limits. The engine contract knows only the node kinds property and crew.
const COORDINATE_COLUMNS = Object.freeze([
  'properties.geo_lat_e6',
  'properties.geo_lon_e6',
  'crews.base_geo_lat_e6',
  'crews.base_geo_lon_e6',
]);

test('the four coordinate columns are forbidden', () => {
  const p = loadProfile(path.join(__dirname, '../../../profiles/brightside/profile.yml'));
  for (const column of COORDINATE_COLUMNS) assert.ok(p.sql.forbidden_columns.includes(column), `${column} forbidden`);
  for (const column of ['clients.phone', 'properties.street_address', 'properties.postal_code']) {
    assert.ok(p.sql.forbidden_columns.includes(column), `${column} still forbidden`);
  }
});

test('routing declares property and crew nodes and the generator limits', () => {
  const p = loadProfile(path.join(__dirname, '../../../profiles/brightside/profile.yml'));
  assert.deepEqual(p.routing.coordinates.nodes, [
    { kind: 'property', table: 'properties', id_column: 'property_id', lat_column: 'geo_lat_e6', lon_column: 'geo_lon_e6' },
    { kind: 'crew', table: 'crews', id_column: 'crew_id', lat_column: 'base_geo_lat_e6', lon_column: 'base_geo_lon_e6' },
  ]);
  // 06:00, 08:00, 18:00 and 23:00 as minutes after local midnight; 15-minute slots.
  assert.deepEqual(p.routing.limits, {
    earliest_start: 360,
    default_start: 480,
    aim_finish: 1080,
    latest_finish: 1380,
    slot_minutes: 15,
  });
  assert.equal(p.routing.min_travel_minutes, 5);
});
