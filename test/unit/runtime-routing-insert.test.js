'use strict';

// insertStop (Story 19.5, plan brightside-v1 D8): where one new stop would go
// on its crew, and the two cheapest other crews of the zone. The day is
// synthetic and built here: places on a line, drive minutes the distance
// between them, every crew starting and ending at the Office (depot:o, at
// 0). w1 is off the line: 100 minutes from anywhere. Expected values are
// worked out by hand (comments show the arithmetic).

const test = require('node:test');
const assert = require('node:assert/strict');
const routing = require('../../kit/runtime/routing');
const sdk = require('../../kit/runtime/sdk');
const { RoutingFault, ROUTING_PROBLEMS } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');

const AT = Object.freeze({
  'depot:o': 0, 'property:p1': 10, 'property:p2': 20, 'property:p3': 30, 'property:q1': 14, 'property:q2': 40, 'property:r1': 15, 'property:n1': 15,
});
const OFF = 'property:w1';
const NODES = [...Object.keys(AT), OFF];

function matrix() {
  const rows = [];
  for (const from of NODES) {
    for (const to of NODES) {
      if (from === to) continue;
      const minutes = from === OFF || to === OFF ? 100 : Math.abs(AT[from] - AT[to]);
      rows.push({ from_node: from, to_node: to, minutes });
    }
  }
  return rows;
}

const stop = (id, crew, order, over = {}) => ({
  stopId: id, node: `property:${id}`, currentCrewId: crew, labourMinutes: 60, serviceMinutes: 60, locked: false, rules: [], routeOrder: order, ...over,
});
const crew = (id, zone, over = {}) => ({
  crewId: id, zoneId: zone, baseNode: 'depot:o', headcountPlanned: 2, headcountPresent: 2, available: true, ...over,
});

// k1, k2, k3, k5 (out) and k6 work zone z; k4 works zone y.
function day() {
  return {
    day: '2026-11-03',
    asOf: '2026-11-02',
    limits: {
      earliestStart: 420, defaultStart: 480, aimFinish: 1020, latestFinish: 1140, startRoundTo: 5,
    },
    crews: [crew('k1', 'z'), crew('k2', 'z'), crew('k3', 'z'), crew('k4', 'y'), crew('k5', 'z', { available: false, headcountPresent: 0 }), crew('k6', 'z')],
    stops: [
      stop('p1', 'k1', 1), stop('p2', 'k1', 2), stop('p3', 'k1', 3),
      stop('q1', 'k2', 1), stop('q2', 'k3', 1), stop('r1', 'k4', 1), stop('w1', 'k6', 1),
    ],
  };
}

const NEW = Object.freeze({
  stopId: 'n1', node: 'property:n1', currentCrewId: 'k1', labourMinutes: 60, serviceMinutes: 30, locked: false, rules: [],
});
const fresh = (over = {}) => ({ ...JSON.parse(JSON.stringify(NEW)), ...over });
const travel = routing.travel.fromMatrix(matrix());
const insert = (input = day(), s = fresh(), opts = {}) => routing.insertStop(input, s, { travel, returnToBase: true, ...opts });

function faultOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RoutingFault, `expected a RoutingFault, got ${err && err.name}: ${err && err.message}`);
    return err.details;
  }
  return assert.fail('expected a RoutingFault');
}

test('insertStop is exported from the routing index and the sdk', () => {
  assert.equal(typeof routing.insertStop, 'function');
  assert.equal(sdk.routing.insertStop, routing.insertStop);
});

test('the cheapest position on the crew: between p1 and p2, adding no drive; of equal places the first wins', () => {
  // k1 booked: o->p1 10, p1->p2 10, p2->p3 10, p3->o 30 = 60 minutes.
  // n1 first: 15+5+10+10+30 = 70 (+10); second: 10+5+5+10+30 = 60 (+0);
  // third: 10+10+5+15+30 = 70 (+10); last: 10+10+10+15+15 = 60 (+0). Second
  // and last tie on every position of the tuple: the first of them wins.
  const r = insert();
  assert.equal(r.crewId, 'k1');
  assert.equal(r.stopId, 'n1');
  assert.equal(r.fits, true);
  assert.equal(r.position, 2);
  assert.deepEqual(r.order, ['p1', 'n1', 'p2', 'p3']);
  // p1 480 to 540, drive 5: n1 at 545.
  assert.equal(r.start, 545);
  assert.deepEqual(r.before, {
    hardBreaks: 0, softPenalty: 0, driveMinutes: 60, aimFinishMinutes: 0,
  });
  assert.deepEqual(r.added, {
    hardBreaks: 0, softPenalty: 0, driveMinutes: 0, aimFinishMinutes: 0,
  });
  assert.equal(r.after.driveMinutes, 60);
  assert.equal(r.reason, 'the cheapest place on crew k1 is stop 2 of 4, starting at 09:05; it adds 0 minutes of driving');
});

test('the two cheapest other crews of the zone: never another zone, never a crew out, never a third', () => {
  // k3 (q2 at 40): o->n1 15, n1->q2 25, q2->o 40 = 80, as booked (+0).
  // k2 (q1 at 14): o->n1 15, n1->q1 1, q1->o 14 = 30, booked 28 (+2).
  // k6 (w1, off the line): +15. k4 (zone y, r1 at 15) would add 0: another zone.
  const r = insert();
  assert.deepEqual(r.others.map((o) => [o.crewId, o.position, o.added.driveMinutes]), [['k3', 1, 0], ['k2', 1, 2]]);
  assert.equal(r.others[0].start, 480);
  assert.equal(r.others[1].reason, 'could go on crew k2 as stop 1 of 2, starting at 08:00; it adds 2 minutes of driving');
  // With k3 out, k6 comes in second.
  const input = day();
  input.crews.find((c) => c.crewId === 'k3').available = false;
  assert.deepEqual(insert(input).others.map((o) => [o.crewId, o.added.driveMinutes]), [['k2', 2], ['k6', 15]]);
  // One other working crew in the zone: one row; none: none.
  const alone = day();
  alone.crews = alone.crews.filter((c) => ['k1', 'k2', 'k4'].includes(c.crewId));
  alone.stops = alone.stops.filter((s) => ['k1', 'k2', 'k4'].includes(s.currentCrewId));
  assert.deepEqual(insert(alone).others.map((o) => o.crewId), ['k2']);
  alone.crews = alone.crews.filter((c) => c.crewId !== 'k2');
  alone.stops = alone.stops.filter((s) => s.currentCrewId !== 'k2');
  assert.deepEqual(insert(alone).others, []);
});

test('an impossible window: placed last and flagged, with the solver\'s reason; no other crew is offered', () => {
  // 05:00 to before 05:30 is before the crew day's earliest start (07:00).
  const s = fresh({ rules: [{ ruleId: 'time-of-day', value: { startFrom: 300, startBefore: 330 }, strength: 'hard' }] });
  const r = insert(day(), s);
  assert.equal(r.fits, false);
  assert.equal(r.position, 4);
  assert.deepEqual(r.order, ['p1', 'p2', 'p3', 'n1']);
  assert.ok(r.added.hardBreaks > 0);
  assert.match(r.reason, /^no place on crew k1 keeps every hard rule, so it is placed last \(time of day: /);
  assert.deepEqual(r.others, []);
  // A soft window it can't meet still fits (a soft break is allowed).
  const soft = fresh({ rules: [{ ruleId: 'time-of-day', value: { startFrom: 300, startBefore: 330 }, strength: 'soft' }] });
  const ok = insert(day(), soft);
  assert.equal(ok.fits, true);
  assert.equal(ok.added.hardBreaks, 0);
  assert.ok(ok.added.softPenalty > 0);
});

test('a day too full for the stop: placed last and flagged', () => {
  // A 10-hour stop after k1's three hours ends past the 19:00 latest finish.
  const r = insert(day(), fresh({ serviceMinutes: 600 }));
  assert.equal(r.fits, false);
  assert.equal(r.position, 4);
  assert.match(r.reason, /placed last/);
});

test('an order the person chose: the stop goes into that order, the others keep theirs', () => {
  // o->p3 30, p3->p1 20, p1->p2 10, p2->o 20 = 80. n1 first: 15+15+20+10+20 = 80 (+0).
  const r = insert(day(), fresh(), { order: ['p3', 'p1', 'p2'] });
  assert.deepEqual(r.order, ['n1', 'p3', 'p1', 'p2']);
  assert.equal(r.before.driveMinutes, 80);
  assert.equal(r.added.driveMinutes, 0);
});

test('identical output for the same input, and neither argument is changed', () => {
  const input = day();
  const s = fresh();
  const before = JSON.stringify([input, s]);
  const a = JSON.stringify(insert(input, s));
  const b = JSON.stringify(insert(day(), fresh()));
  assert.equal(a, b);
  assert.equal(JSON.stringify([input, s]), before);
});

test('faults name the field, never a value: the stop, its crew, the order and the options', () => {
  const cases = [
    [() => insert(day(), null), 'stop', 'not_object'],
    [() => insert(day(), fresh({ stopId: 'p1' })), 'stop.stopId', 'duplicate'],
    [() => insert(day(), fresh({ stopId: 'a b' })), 'stop.stopId', 'bad_id'],
    [() => insert(day(), fresh({ node: '15 Main St' })), 'stop.node', 'bad_node'],
    [() => insert(day(), fresh({ currentCrewId: 'k9' })), 'stop.currentCrewId', 'unknown_crew'],
    [() => insert(day(), fresh({ currentCrewId: 'k5' })), 'stop.currentCrewId', 'not_working'],
    [() => insert(day(), fresh({ locked: true, start: 600 })), 'stop.locked', 'locked'],
    [() => insert(day(), fresh({ serviceMinutes: -1 })), 'stop.serviceMinutes', 'out_of_range'],
    [() => insert(day(), fresh(), { order: ['p1', 'p2'] }), 'opts.order', 'missing_stop'],
    [() => insert(day(), fresh(), { order: ['p1', 'p2', 'q1'] }), 'opts.order[2]', 'other_crew_stop'],
    [() => insert(day(), fresh(), { order: ['p1', 'p2', 'n1'] }), 'opts.order[2]', 'unknown_stop'],
    [() => insert(day(), fresh(), { order: ['p1', 'p1', 'p2'] }), 'opts.order[1]', 'duplicate'],
    [() => insert(day(), fresh(), { order: 'p1' }), 'opts.order', 'not_list'],
    [() => routing.insertStop(day(), fresh(), { travel }), 'opts.returnToBase', 'missing'],
    [() => routing.insertStop(day(), fresh(), { returnToBase: true }), 'opts.travel', 'not_function'],
    [() => insert({ ...day(), day: '2026-13-01' }), 'day', 'bad_date'],
  ];
  for (const [fn, field, problem] of cases) {
    const details = faultOf(fn);
    assert.deepEqual([details.field, details.problem], [field, problem], `${field} ${problem}`);
    assert.ok(ROUTING_PROBLEMS.includes(problem), problem);
    const words = messageFor(new RoutingFault(details), { admin: 'Sam' });
    assert.ok(!words.includes('15 Main St'), 'never a value');
  }
});
