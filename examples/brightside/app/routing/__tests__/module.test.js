'use strict';

// Brightside's routing adapter as the routing-map archetype's adapter (Story
// 15.5, AD-R16, AD-R17), on hand-made rows: a fake full data object answers
// the adapter's queries and records every query and travel rectangle.
// Checked here, without DuckDB: the Routing module's adapter file is this
// adapter; asOf; input() per view and scope (compare and zone cut to a crew
// lead's crew, change and gap not; a dispatcher's gap fills every crew's
// gaps, with a candidate's service time the longest of the gap crews'; a lead
// whose crew is not in the day gets the whole day, for the archetype's
// configuration refusal); labels() returns only crew name, client name and
// city, its query filtered by the scope, and refuses a node id without a
// kind prefix. The same adapter through the archetype on the built fixture
// (S3's route change, a lead's view) is
// examples/brightside/test/routing-module.test.js.
// App code: it requires only '#sdk' and the routing folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const { RoutingFault } = require('#sdk');
const { createAdapter, SQL } = require('../adapter');
const moduleAdapter = require('../../modules/routing/adapter');

const ROUTING = Object.freeze({
  max_pairs: 10000,
  gap_fill: { horizon_days: 14, limit: 5 },
  limits: { earliest_start: 360, default_start: 480, aim_finish: 1080, latest_finish: 1380, slot_minutes: 15 },
});
const DAY = '2026-10-02';
const LEAD = Object.freeze({ crewId: '2' });
const ALL = Object.freeze({ all: true });

const crewRow = (crewId, zone, over = {}) => ({
  crew_id: crewId, zone_id: zone, headcount_planned: 3, headcount_present: 3, leads_planned: 1, leads_present: 1, ...over,
});
const visitRow = (id, propertyId, crewId, order, over = {}) => ({
  scheduled_visit_id: id, property_id: propertyId, crew_id: crewId, status: 'scheduled', visit_date: DAY, route_order: order,
  start_minutes: 480 + (order - 1) * 120, scheduled_minutes: 60, labour_minutes: 180,
  preferred_crew: null, preferred_crew_strength: null, allowed_days: null, allowed_days_strength: null, time_window: null, time_window_strength: null,
  ...over,
});
const candidateRow = (id, propertyId, crewId) => ({
  scheduled_visit_id: id, property_id: propertyId, crew_id: crewId, visit_date: '2026-10-06', scheduled_minutes: 60, labour_minutes: 180, frequency: 'biweekly', prev_visit_date: null,
  preferred_crew: null, preferred_crew_strength: null, allowed_days: null, allowed_days_strength: null, time_window: null, time_window_strength: null,
});

// Two zones: crews 1 and 2 in north (crew 2 has 2 people present), crew 3
// in south. Crew 1 and crew 2 each have a cancelled visit.
const CREWS = [crewRow(1, 'n'), crewRow(2, 'n', { headcount_present: 2 }), crewRow(3, 's')];
const VISITS = [
  visitRow(10, 100, 1, 1), visitRow(11, 101, 1, 2, { status: 'cancelled' }), visitRow(12, 102, 1, 3),
  visitRow(20, 200, 2, 1), visitRow(21, 201, 2, 2, { status: 'cancelled' }), visitRow(22, 202, 2, 3),
  visitRow(30, 300, 3, 1),
];
const LABEL_ROWS = [
  { node: 'crew:1', crew_name: 'Maple crew', client_name: null, city: null },
  { node: 'crew:2', crew_name: 'Cedar crew', client_name: null, city: null },
  { node: 'property:100', crew_name: null, client_name: 'Ana Ruiz', city: 'Pinecrest' },
];

function fakeData({ crews = CREWS, visits = VISITS, candidates = [candidateRow(40, 400, 3)], labels = LABEL_ROWS } = {}) {
  const calls = [];
  const queries = [];
  return {
    calls,
    queries,
    run: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === SQL.crews) return crews;
      if (sql === SQL.day) return visits;
      if (sql === SQL.candidates) return candidates;
      if (sql === SQL.labels) {
        // As labels.sql filters: a lead's crew rows only.
        return labels.filter((r) => !r.node.startsWith('crew:') || params.crew_id === '' || r.node === `crew:${params.crew_id}`);
      }
      if (/fixture_meta/.test(sql)) return [{ value: '2026-09-30' }];
      throw new Error('unexpected query');
    },
    describe: () => ({ source: 'fake', label: null, available: true, problem: null }),
    travelMatrix: async (fromIds, toIds) => {
      calls.push([fromIds.length, toIds.length]);
      return fromIds.flatMap((f) => toIds.map((t) => ({ from_node: f, to_node: t, minutes: 7 })));
    },
  };
}

test('the Routing module\'s adapter file is Brightside\'s routing adapter, with the archetype\'s three functions', () => {
  assert.equal(moduleAdapter.createAdapter, createAdapter);
  const adapter = createAdapter({ data: fakeData(), routing: ROUTING });
  for (const fn of ['asOf', 'input', 'labels']) assert.equal(typeof adapter[fn], 'function', fn);
});

test('asOf is the fixture\'s as_of date', async () => {
  assert.equal(await createAdapter({ data: fakeData(), routing: ROUTING }).asOf(), '2026-09-30');
});

test('compare and zone: a dispatcher gets every crew; a crew lead only their crew and its stops', async () => {
  for (const view of ['compare', 'zone']) {
    const all = await createAdapter({ data: fakeData(), routing: ROUTING }).input({ day: DAY, view, scope: ALL });
    assert.deepEqual(all.input.crews.map((c) => c.crewId), ['1', '2', '3'], view);
    assert.equal(typeof all.travel, 'function');
    const lead = await createAdapter({ data: fakeData(), routing: ROUTING }).input({ day: DAY, view, scope: LEAD });
    assert.deepEqual(lead.input.crews.map((c) => c.crewId), ['2'], view);
    assert.deepEqual(lead.input.stops.map((s) => s.stopId), ['20', '22'], view);
  }
});

test('change is never cut to a crew lead\'s crew: the engine needs the other crews to place a sick crew\'s stops', async () => {
  const crews = [crewRow(1, 'n', { leads_present: 0 }), crewRow(2, 'n'), crewRow(3, 's')];
  const { input } = await createAdapter({ data: fakeData({ crews }), routing: ROUTING }).input({ day: DAY, view: 'change', scope: LEAD });
  assert.deepEqual(input.crews.map((c) => [c.crewId, c.available]), [['1', false], ['2', true], ['3', true]]);
  assert.equal(input.cancelled, undefined);
});

test('gap: a dispatcher fills every crew\'s gaps, each candidate timed for the gap crew with the fewest people', async () => {
  const data = fakeData();
  const { input } = await createAdapter({ data, routing: ROUTING }).input({ day: DAY, view: 'gap', scope: ALL });
  assert.deepEqual(input.cancelled.map((c) => c.stopId), ['11', '21']);
  // 180 labour minutes: 60 on crew 1 (3 present), 90 on crew 2 (2 present).
  assert.deepEqual(input.candidates.map((c) => [c.stopId, c.serviceMinutes]), [['40', 90]]);
  // Each gap's two rectangles: previous x [candidate, next], candidate x next.
  assert.deepEqual(data.calls, [[1, 2], [1, 1], [1, 2], [1, 1]]);
});

test('gap: a crew lead fills their crew\'s gap only, timed for their crew', async () => {
  const { input } = await createAdapter({ data: fakeData(), routing: ROUTING }).input({ day: DAY, view: 'gap', scope: { crewId: '1' } });
  assert.deepEqual(input.cancelled.map((c) => c.stopId), ['11']);
  assert.deepEqual(input.candidates.map((c) => [c.stopId, c.serviceMinutes]), [['40', 60]]);
  assert.deepEqual(input.crews.map((c) => c.crewId), ['1', '2', '3'], 'every crew: a candidate may be booked on another');
});

test('a day with no cancelled visit: a dispatcher\'s gap view reads no candidates', async () => {
  const data = fakeData({ visits: VISITS.filter((v) => v.status === 'scheduled') });
  const { input } = await createAdapter({ data, routing: ROUTING }).input({ day: DAY, view: 'gap', scope: ALL });
  assert.deepEqual([input.cancelled, input.candidates], [[], []]);
  assert.ok(!data.queries.some((q) => q.sql === SQL.candidates));
});

test('a crew lead whose crew is not in the day gets the whole day, so the archetype refuses it as a configuration fault', async () => {
  for (const view of ['compare', 'zone', 'change', 'gap']) {
    const { input } = await createAdapter({ data: fakeData(), routing: ROUTING }).input({ day: DAY, view, scope: { crewId: '9' } });
    assert.deepEqual(input.crews.map((c) => c.crewId), ['1', '2', '3'], view);
  }
});

test('labels: only crew name, client name and city, keyed by node id; a dispatcher\'s query names no crew scope', async () => {
  const data = fakeData();
  const got = await createAdapter({ data, routing: ROUTING }).labels({ day: DAY, nodeIds: ['crew:1', 'crew:2', 'property:100', 'property:100'], scope: ALL });
  assert.deepEqual(got, {
    'crew:1': { crewName: 'Maple crew' },
    'crew:2': { crewName: 'Cedar crew' },
    'property:100': { clientName: 'Ana Ruiz', city: 'Pinecrest' },
  });
  const [q] = data.queries;
  assert.equal(q.sql, SQL.labels);
  assert.deepEqual(q.params, { crew_ids: '1,2', property_ids: '100', crew_id: '' });
});

test('labels: a crew lead\'s query is filtered to their crew, so no other crew is named', async () => {
  const data = fakeData();
  const got = await createAdapter({ data, routing: ROUTING }).labels({ day: DAY, nodeIds: ['crew:1', 'crew:2', 'property:100'], scope: LEAD });
  assert.deepEqual(Object.keys(got).sort(), ['crew:2', 'property:100']);
  assert.equal(data.queries[0].params.crew_id, '2');
});

test('labels: a node id without a kind prefix is refused before any query; no ids reads nothing', async () => {
  const data = fakeData();
  const adapter = createAdapter({ data, routing: ROUTING });
  for (const bad of ['100', 'site:1', 'crew:1;', 'property:']) {
    await assert.rejects(adapter.labels({ day: DAY, nodeIds: [bad], scope: ALL }), (err) => err instanceof RoutingFault && err.details.problem === 'bad_node', bad);
  }
  assert.deepEqual(await adapter.labels({ day: DAY, nodeIds: [], scope: ALL }), {});
  assert.equal(data.queries.length, 0);
});

test('labels.sql names only the crew name, the client\'s name and the city, never an address, postal code or coordinate', () => {
  const select = SQL.labels.split('\n').filter((l) => !l.startsWith('--')).join('\n');
  for (const hidden of ['street_address', 'postal_code', 'geo_lat_e6', 'geo_lon_e6', 'phone', 'email']) {
    assert.ok(!select.includes(hidden), hidden);
  }
  assert.match(select, /\$crew_id/);
});
