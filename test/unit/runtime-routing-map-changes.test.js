'use strict';

// Which booked visits a route skill's result changes (Story 20.3, plan
// brightside-v1 D14): routing-map/changes.js, pure. A move within the same
// window is not a change; a crew change is; an added stop is never a visit;
// the stop Fill with #n moved up changes its date; the timing model's own
// offset from the booked times is no change; Crew out's stops to rebook and
// its cross-zone recommendations are held, never emailed. Made-up ids.

const test = require('node:test');
const assert = require('node:assert/strict');
const changes = require('../../kit/runtime/archetypes/routing-map/changes');
const { planView } = require('../../kit/runtime/archetypes/routing-map/views');
const routing = require('../../kit/runtime/routing');

// Stops each 90 minutes long, timed one after another from 08:00 in the order
// given (the stand-in for the engine's timing from the Office).
const timed = (order) => new Map(order.map((id, i) => [id, 480 + i * 90]));
const startsOf = (order) => timed(order);

// A plan as the editor holds it: booked order 1..5, booked starts as timed.
function plan(over = {}) {
  const booked = ['11', '12', '13', '14', '15'];
  const starts = timed(booked);
  return {
    day: '2026-10-01',
    crewId: '4',
    booked,
    order: booked.slice(),
    input: { stops: booked.map((stopId) => ({ stopId, start: starts.get(stopId) })) },
    added: null,
    filled: null,
    ...over,
  };
}

test('the day as booked changes nothing', () => {
  assert.deepEqual(changes.ofPlan(plan(), startsOf, 'Crew Four'), { visits: [], held: [] });
});

test('a move within the same window is not a change; a move across noon is (and only that stop\'s window is new)', () => {
  // 11 08:00, 12 09:30, 13 11:00, 14 12:30, 15 14:00. Swapping 11 and 12 keeps both in the morning.
  assert.deepEqual(changes.ofPlan(plan({ order: ['12', '11', '13', '14', '15'] }), startsOf, 'Crew Four').visits, []);
  // 14 to first: 14 08:00 (was afternoon), 11 09:30, 12 11:00, 13 12:30 (was morning), 15 14:00.
  const got = changes.ofPlan(plan({ order: ['14', '11', '12', '13', '15'] }), startsOf, 'Crew Four').visits;
  assert.deepEqual(got.map((v) => [v.id, v.before.window, v.after.window]), [['14', 'afternoon', 'morning'], ['13', 'morning', 'afternoon']]);
  assert.deepEqual(got[0], {
    id: '14',
    before: { date: '2026-10-01', window: 'afternoon', crewId: '4' },
    after: {
      date: '2026-10-01', window: 'morning', crewId: '4', crewName: 'Crew Four',
    },
  });
});

test('the timing model\'s own offset from the booked times is no change: only a start that crosses noon against the booked order timed the same way', () => {
  // Booked 13 at 12:05 (afternoon) though the model times it at 11:00 in the booked order.
  const p = plan();
  p.input.stops.find((s) => s.stopId === '13').start = 725;
  assert.deepEqual(changes.ofPlan(p, startsOf, 'Crew Four').visits, [], 'shown as booked: nothing');
  // Moved to last: the model now times it at 14:00, still afternoon as booked: no change.
  assert.deepEqual(changes.ofPlan({ ...p, order: ['11', '12', '14', '15', '13'] }, startsOf, 'Crew Four').visits.map((v) => v.id), ['14']);
});

test('an added stop is never emailed, though the visits it moves are', () => {
  const p = plan({
    booked: ['11', 'add-900', '12', '13', '14', '15'],
    bookedBase: ['11', '12', '13', '14', '15'],
    order: ['11', 'add-900', '12', '13', '14', '15'],
    added: { stopId: 'add-900' },
  });
  p.input.stops.push({ stopId: 'add-900' });
  const got = changes.ofPlan(p, startsOf, 'Crew Four').visits;
  assert.ok(!got.some((v) => v.id === 'add-900'));
  // 13 moves from 11:00 to 12:30: across noon.
  assert.deepEqual(got.map((v) => v.id), ['13']);
});

test('Fill with #n: the moved-up visit changes its date (and its crew, when another crew had it); a stop id that names no visit is skipped', () => {
  const p = plan({ filled: { stopId: '13', from: '2026-10-05', fromCrew: '2' } });
  const got = changes.ofPlan(p, startsOf, 'Crew Four').visits;
  assert.deepEqual(got, [{
    id: '13',
    before: { date: '2026-10-05', window: null, crewId: '2' },
    after: {
      date: '2026-10-01', window: 'morning', crewId: '4', crewName: 'Crew Four',
    },
  }]);
  const noCrew = changes.ofPlan(plan({ filled: { stopId: '13', from: '2026-10-05', fromCrew: null } }), startsOf, null).visits;
  assert.deepEqual(noCrew[0].before, { date: '2026-10-05', window: null, crewId: null });
  assert.equal(noCrew[0].after.crewName, null, 'no label, no made-up name');
  const odd = plan({ booked: ['x-1'], order: ['x-1'], input: { stops: [{ stopId: 'x-1', start: 480 }] } });
  assert.deepEqual(changes.ofPlan({ ...odd, order: ['x-1'] }, () => new Map([['x-1', 800]]), 'Crew Four').visits, []);
});

// --- Crew out --------------------------------------------------------------------------------

test('Crew out: a stop moved to another crew of the zone is a change (its crew, and its window when the start crosses noon); a stop to rebook and a cross-zone one are held', () => {
  const stops = new Map([
    ['21', { start: 500, currentCrewId: '7' }],
    ['22', { start: 700, currentCrewId: '7' }],
    ['23', { start: 800, currentCrewId: '7' }],
    ['24', { start: 900, currentCrewId: '7' }],
    ['31', { start: 690, currentCrewId: '8' }],
    ['32', { start: 600, currentCrewId: '8' }],
  ]);
  const result = {
    moves: [
      { stopId: '21', fromCrew: '7', toCrew: '8', crossZone: false, recommendation: false, start: 540 },
      { stopId: '22', fromCrew: '7', toCrew: '8', crossZone: false, recommendation: false, start: 760 },
      { stopId: '23', fromCrew: '7', toCrew: '14', crossZone: true, recommendation: true, start: 640 },
    ],
    // 31 moved within the morning; 32 across noon.
    shifted: [
      { stopId: '31', crewId: '8', previousStart: 690, start: 700 },
      { stopId: '32', crewId: '8', previousStart: 600, start: 780 },
    ],
    unplaced: [{ stopId: '24' }],
  };
  const zone = new Set(['7', '8']);
  const got = changes.ofCrewOut({
    result, day: '2026-10-03', stopOf: (id) => stops.get(id), shown: (c) => zone.has(c),
  });
  assert.deepEqual(got.visits.map((v) => [v.id, v.before.crewId, v.after.crewId, v.before.window, v.after.window]), [
    ['21', '7', '8', 'morning', 'morning'],
    ['22', '7', '8', 'morning', 'afternoon'],
    ['32', '8', '8', 'morning', 'afternoon'],
  ]);
  assert.deepEqual(got.held, [{ id: '23', reason: 'cross-zone' }, { id: '24', reason: 'rebook' }]);
  const named = changes.named(got, new Map([['crew:8', { crewName: 'East crew B' }]]));
  assert.deepEqual(named.visits.map((v) => v.after.crewName), ['East crew B', 'East crew B', 'East crew B']);
  assert.equal(changes.named(got, new Map()).visits[0].after.crewName, null);
});

test('Crew out through the Route change view: placeOrphans\' result gives the changes beside the plan; no crew out, no changes', () => {
  const crew = (crewId, available = true) => ({
    crewId, zoneId: 'z', baseNode: `crew:${crewId}`, headcountPlanned: 2, headcountPresent: available ? 2 : 0, available,
  });
  const stop = (stopId, crewId, routeOrder, start) => ({
    stopId, node: `property:${stopId}`, currentCrewId: crewId, labourMinutes: 60, serviceMinutes: 60, locked: false, rules: [], routeOrder, start,
  });
  const input = {
    day: '2026-10-03',
    asOf: '2026-09-30',
    limits: {
      earliestStart: 360, defaultStart: 480, aimFinish: 1080, latestFinish: 1380, startRoundTo: 5,
    },
    crews: [crew('7', false), crew('8')],
    stops: [stop('41', '7', 1, 480), { ...stop('42', '7', 2, 600), locked: true }, stop('51', '8', 1, 480)],
  };
  const travel = () => 10;
  const plan = planView({
    view: 'change', input, travel, scope: { all: true }, pick: { kind: 'zone', id: 'z' }, gapFill: { horizon_days: 14, limit: 5 },
  });
  const result = routing.placeOrphans(input, { travel });
  assert.ok(result.unplaced.some((u) => u.stopId === '42'), 'the locked stop of the crew that is out is to rebook');
  assert.deepEqual(plan.changes.held, [{ id: '42', reason: 'rebook' }], 'listed, never emailed');
  assert.deepEqual(plan.changes.visits.map((v) => [v.id, v.after.crewId]), [['41', '8']]);
  const none = planView({
    view: 'change', input: { ...input, crews: [crew('7'), crew('8')] }, travel, scope: { all: true }, pick: { kind: 'zone', id: 'z' }, gapFill: { horizon_days: 14, limit: 5 },
  });
  assert.equal(none.changes, undefined);
});
