'use strict';

// Brightside's routing adapter (Story 14.3) on hand-made rows: a fake data
// object answers the adapter's three queries and records every travelMatrix
// rectangle. Checked here, without DuckDB: a module's ctx.data (run and
// describe only) is refused; a crew is out when its lead is absent or nobody
// is present (pending Dana Reyes, DEP-028); the rule and cadence mappings;
// every travel read stays within max_pairs; a bad day is refused before any
// query. The same adapter on the built fixture, with the planted scenarios
// through the engine, is examples/brightside/test/routing-adapter.test.js.
// App code: it requires only '#sdk' and the adapter.

const test = require('node:test');
const assert = require('node:assert/strict');
const { testContext, routing, RoutingFault } = require('#sdk');
const { createAdapter, SQL, isoDaysOf, serviceFor } = require('../adapter');

const ROUTING = Object.freeze({
  max_pairs: 10000,
  gap_fill: { horizon_days: 14, limit: 5 },
  limits: { earliest_start: 360, default_start: 480, aim_finish: 1080, latest_finish: 1380, slot_minutes: 15 },
});
const DAY = '2026-10-02';

const crewRow = (crewId, zone, over = {}) => ({
  crew_id: crewId, zone_id: zone, headcount_planned: 3, headcount_present: 3, leads_planned: 1, leads_present: 1, ...over,
});
const visitRow = (id, propertyId, crewId, order, over = {}) => ({
  scheduled_visit_id: id, property_id: propertyId, crew_id: crewId, status: 'scheduled', visit_date: DAY, route_order: order,
  start_minutes: 480 + order * 90, scheduled_minutes: 60, labour_minutes: 180,
  preferred_crew: null, preferred_crew_strength: null, allowed_days: null, allowed_days_strength: null, time_window: null, time_window_strength: null,
  ...over,
});

// A fake full data object: the three queries by their text, and travelMatrix
// answering 7 minutes for every pair asked.
function fakeData({ crews, visits, candidates = [] }) {
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

test('a module ctx.data (run and describe only) is refused: the adapter needs travelMatrix', async () => {
  const { data } = testContext({ rows: (sql) => (sql === SQL.crews ? [crewRow(1, 'n')] : sql === SQL.day ? [visitRow(10, 100, 1, 1)] : [{ value: '2026-09-30' }]) });
  const adapter = createAdapter({ data, routing: ROUTING });
  await assert.rejects(adapter.dayInput({ day: DAY }), (err) => err instanceof RoutingFault && err.details.problem === 'data_unavailable');
});

test('a crew is out when its lead is absent or nobody is present (pending Dana Reyes, DEP-028)', async () => {
  const data = fakeData({
    crews: [
      crewRow(1, 'n'),
      crewRow(2, 'n', { headcount_present: 2, leads_present: 0 }),
      crewRow(3, 'n', { headcount_present: 0, leads_present: 0 }),
      crewRow(4, 'n', { leads_planned: 0, leads_present: 0 }),
      crewRow(5, 'n', { headcount_present: 1 }),
    ],
    visits: [],
  });
  const { input } = await createAdapter({ data, routing: ROUTING }).dayInput({ day: DAY });
  assert.deepEqual(input.crews.map((c) => [c.crewId, c.available]), [['1', true], ['2', false], ['3', false], ['4', false], ['5', true]]);
  assert.deepEqual(input.crews.map((c) => c.baseNode), ['crew:1', 'crew:2', 'crew:3', 'crew:4', 'crew:5']);
});

test('rules map to rule instances; flexible means no hard day or time rule; cadence counts monthly as 30', async () => {
  const data = fakeData({
    crews: [crewRow(1, 'n', { headcount_present: 2 })],
    visits: [
      visitRow(10, 100, 1, 1, { preferred_crew: '1', preferred_crew_strength: 'soft', allowed_days: 'MON|THU', allowed_days_strength: 'hard' }),
      visitRow(11, 101, 1, 2, { status: 'cancelled' }),
      visitRow(12, 102, 1, 3, { time_window: 'afternoon', time_window_strength: 'hard' }),
    ],
    candidates: [
      { scheduled_visit_id: 20, property_id: 200, crew_id: 1, visit_date: '2026-10-05', scheduled_minutes: 60, labour_minutes: 150, frequency: 'monthly', prev_visit_date: '2026-09-04',
        preferred_crew: null, preferred_crew_strength: null, allowed_days: null, allowed_days_strength: null, time_window: 'morning', time_window_strength: 'hard' },
      { scheduled_visit_id: 21, property_id: 201, crew_id: 1, visit_date: '2026-10-09', scheduled_minutes: 60, labour_minutes: 90, frequency: 'biweekly', prev_visit_date: null,
        preferred_crew: '1', preferred_crew_strength: 'soft', allowed_days: null, allowed_days_strength: null, time_window: 'morning', time_window_strength: 'soft' },
    ],
  });
  const { input } = await createAdapter({ data, routing: ROUTING }).gapInput({ day: DAY, crewId: 1 });
  assert.equal(routing.validateInput(input), input);
  assert.deepEqual(input.stops[0].rules, [
    { ruleId: 'preferred-crew', value: '1', strength: 'soft' },
    { ruleId: 'day-of-week', value: [1, 4], strength: 'hard' },
  ]);
  assert.deepEqual(input.stops[1].rules, [{ ruleId: 'time-of-day', value: { startFrom: 720, startBefore: 1380 }, strength: 'hard' }]);
  assert.deepEqual(input.cancelled, [{ stopId: '11', node: 'property:101', currentCrewId: '1', start: 660, serviceMinutes: 90 }]);
  const [monthly, biweekly] = input.candidates;
  assert.deepEqual([monthly.cadenceDays, monthly.flexible, monthly.prevVisitDate, monthly.serviceMinutes], [30, false, '2026-09-04', 75]);
  assert.deepEqual(monthly.rules, [{ ruleId: 'time-of-day', value: { startFrom: 360, startBefore: 720 }, strength: 'hard' }]);
  assert.deepEqual([biweekly.cadenceDays, biweekly.flexible, biweekly.prevVisitDate, biweekly.serviceMinutes], [14, true, null, 45]);
  // The gap's rectangle: previous x [...candidates, next], candidates x next.
  assert.deepEqual(data.calls, [[1, 3], [2, 1]]);
});

test('mapping helpers: ISO day numbers, service time to the slot and at least 30', () => {
  assert.deepEqual(isoDaysOf('MON|THU'), [1, 4]);
  assert.deepEqual(isoDaysOf('SUN|MON'), [1, 7]);
  assert.throws(() => isoDaysOf('MON,THU'), RoutingFault);
  assert.equal(serviceFor(180, 3, 15), 60);
  assert.equal(serviceFor(180, 2, 15), 90);
  assert.equal(serviceFor(40, 3, 15), 30);
});

test('a bad rule value, strength or plan frequency is refused with a RoutingFault, never guessed', async () => {
  const run = (visit, candidates = []) => createAdapter({ data: fakeData({ crews: [crewRow(1, 'n')], visits: [visit], candidates }), routing: ROUTING });
  await assert.rejects(run(visitRow(10, 100, 1, 1, { time_window: 'evening', time_window_strength: 'hard' })).dayInput({ day: DAY }), RoutingFault);
  await assert.rejects(run(visitRow(10, 100, 1, 1, { allowed_days: 'MON', allowed_days_strength: 'firm' })).dayInput({ day: DAY }), RoutingFault);
  const cand = { scheduled_visit_id: 20, property_id: 200, crew_id: 1, visit_date: '2026-10-05', scheduled_minutes: 60, labour_minutes: 150, frequency: 'yearly', prev_visit_date: null,
    preferred_crew: null, preferred_crew_strength: null, allowed_days: null, allowed_days_strength: null, time_window: null, time_window_strength: null };
  await assert.rejects(run(visitRow(10, 100, 1, 1, { status: 'cancelled' }), [cand]).gapInput({ day: DAY, crewId: 1 }), RoutingFault);
});

test('a bad day is refused before any query; gapInput needs a known crew', async () => {
  const data = fakeData({ crews: [crewRow(1, 'n')], visits: [] });
  const adapter = createAdapter({ data, routing: ROUTING });
  await assert.rejects(adapter.dayInput({ day: '2026-10-02T00:00' }), (err) => err.details.problem === 'bad_date');
  assert.equal(data.queries.length, 0);
  await assert.rejects(adapter.gapInput({ day: DAY }), (err) => err.details.problem === 'missing');
  await assert.rejects(adapter.gapInput({ day: DAY, crewId: 9 }), (err) => err.details.problem === 'unknown_crew');
});

test('every travel read stays within max_pairs: a big rectangle is split, and the engine still finds every pair', async () => {
  const visits = Array.from({ length: 12 }, (_, i) => visitRow(10 + i, 100 + i, 1 + (i % 2), i + 1, { start_minutes: 480 + i * 40, labour_minutes: 90 }));
  const data = fakeData({ crews: [crewRow(1, 'n'), crewRow(2, 'n')], visits });
  const { input, travel } = await createAdapter({ data, routing: { ...ROUTING, max_pairs: 20 } }).dayInput({ day: DAY });
  assert.ok(data.calls.length > 1);
  for (const [f, t] of data.calls) assert.ok(f * t <= 20);
  for (const a of [...input.crews.map((c) => c.baseNode), ...input.stops.map((s) => s.node)]) {
    for (const b of input.stops) assert.equal(travel(a, b.node), 7);
  }
  assert.equal(routing.optimizeDay(input, { travel }).cost.hardBreaks, 0);
});
