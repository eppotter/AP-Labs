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

// Story 15.5 (AD-R17): the routing map's two resource keys, neither conferred
// by the admin role, and its audience. A dev placeholder until Dana Reyes
// confirms the real audience (DEP-024): Dana (the user Ely drives in dev) is
// the one dispatcher and no crew leads are listed. When the list arrives,
// update the profile and this test with it.
test('the routing audience: two keys by name only; a dev placeholder with Dana as the one dispatcher (DEP-024)', () => {
  const p = loadProfile(path.join(__dirname, '../../../profiles/brightside/profile.yml'));
  assert.deepEqual(p.routing.audience, { all_crews: 'ROUTING_ALL_CREWS', own_crew: 'ROUTING_OWN_CREW', crew_leads: [] });
  for (const key of ['ROUTING_ALL_CREWS', 'ROUTING_OWN_CREW']) {
    assert.equal(p.resources.find((r) => r.key === key).admin_grantable, false, key);
  }
  const holders = (key) => p.users.filter((u) => (u.grants || []).includes(key)).map((u) => u.id);
  assert.deepEqual(holders('ROUTING_ALL_CREWS'), ['dana']);
  assert.deepEqual(holders('ROUTING_OWN_CREW'), []);
  // The map floors Dana signs GRD-002 against.
  assert.equal(p.routing.map_grid_e6, 2000);
  assert.equal(p.routing.map_min_span_km, 5);
});

// Story 15.11 (AD-R18): Brightside turns the street map on with OpenStreetMap's
// free tiles (dev and the demo only; a fork sets its own provider, DEP-031).
// The User-Agent names the app and a contact (DEP-030), never the client,
// since every tile request carries it to the provider. The Routing module
// stays dev-only until Dana Reyes signs GRD-002 (DEP-025, Story 15.6).
test('routing.basemap: OpenStreetMap tiles, its credit, a contact and no client name in the User-Agent', () => {
  const p = loadProfile(path.join(__dirname, '../../../profiles/brightside/profile.yml'));
  const b = p.routing.basemap;
  assert.equal(b.url_template, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(b.attribution, '© OpenStreetMap contributors');
  assert.equal(b.attribution_url, 'https://www.openstreetmap.org/copyright');
  assert.equal(b.max_zoom, 19);
  assert.equal(b.cache_days, 7);
  assert.match(b.user_agent, /^aplabs-routing-map\/[0-9.]+ \(\+mailto:[^\s@()]+@[^\s@()]+\)$/);
  const ua = b.user_agent.toLowerCase();
  const names = [p.client.id, p.client.name, ...p.client.name.split(/\s+/), ...p.users.flatMap((u) => [u.id, ...u.name.split(/\s+/)])];
  for (const name of names) assert.ok(!ua.includes(name.toLowerCase()), `the User-Agent names no client or client person (${name})`);
});

test('the Routing module stays dev-only with the street map on', () => {
  const manifest = require('../app/modules/routing/manifest.json');
  assert.deepEqual(manifest.environments, ['dev']);
});
