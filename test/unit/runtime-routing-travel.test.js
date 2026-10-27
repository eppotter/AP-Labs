'use strict';

// The routing input contract and the travel port (Story 12.1, AD-R2, AD-R3).
// Inputs are synthetic and come from test/fixtures/routing/*.json only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const routing = require('../../kit/runtime/routing');
const { RoutingFault, ROUTING_PROBLEMS } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');

const FIXTURE = path.join(__dirname, '../fixtures/routing/day-small.json');
const DAY = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

// The RoutingFault's details for an input, or a failure when it passes.
function faultOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RoutingFault, `expected a RoutingFault, got ${err && err.name}`);
    return err.details;
  }
  return assert.fail('expected a RoutingFault');
}
const inputFault = (edit) => {
  const input = clone(DAY.input);
  edit(input);
  return faultOf(() => routing.validateInput(input));
};

test('validateInput returns the day-small input unchanged (the same object, not a copy)', () => {
  const input = clone(DAY.input);
  const before = clone(input);
  assert.equal(routing.validateInput(input), input);
  assert.deepEqual(input, before);
});

test('a stop with no stopId throws RoutingFault naming the field', () => {
  assert.deepEqual(inputFault((i) => { delete i.stops[1].stopId; }), { field: 'stops[1].stopId', problem: 'missing' });
});

test('float minutes throw RoutingFault naming the field', () => {
  assert.deepEqual(inputFault((i) => { i.stops[2].serviceMinutes = 60.5; }), { field: 'stops[2].serviceMinutes', problem: 'not_integer' });
});

test('a stop on an unknown crew throws RoutingFault naming the field', () => {
  assert.deepEqual(inputFault((i) => { i.stops[0].currentCrewId = 'c9'; }), { field: 'stops[0].currentCrewId', problem: 'unknown_crew' });
});

test('a node id without a property: or crew: prefix throws RoutingFault naming the field', () => {
  assert.deepEqual(inputFault((i) => { i.stops[3].node = 'p4'; }), { field: 'stops[3].node', problem: 'bad_node' });
});

test('a non-ISO date throws RoutingFault naming the field', () => {
  assert.deepEqual(inputFault((i) => { i.day = '11/01/2026'; }), { field: 'day', problem: 'bad_date' });
});

test('validateInput never coerces: each wrong type or value is refused, naming the field', () => {
  const cases = [
    [(i) => { i.stops[0].stopId = 101; }, 'stops[0].stopId', 'not_text'],
    [(i) => { i.stops[0].labourMinutes = '270'; }, 'stops[0].labourMinutes', 'not_integer'],
    [(i) => { i.stops[0].locked = 'yes'; }, 'stops[0].locked', 'not_true_false'],
    [(i) => { i.stops = {}; }, 'stops', 'not_list'],
    [(i) => { i.limits = null; }, 'limits', 'not_object'],
    [(i) => { delete i.asOf; }, 'asOf', 'missing'],
    [(i) => { i.asOf = '2026-02-30'; }, 'asOf', 'bad_date'],
    [(i) => { i.day = '2026-11-01T00:00:00Z'; }, 'day', 'bad_date'],
    [(i) => { i.limits.latestFinish = 1500; }, 'limits.latestFinish', 'out_of_range'],
    [(i) => { i.limits.aimFinish = 1400; }, 'limits.aimFinish', 'out_of_range'],
    [(i) => { i.limits.startRoundTo = 0; }, 'limits.startRoundTo', 'out_of_range'],
    [(i) => { i.stops[1].serviceMinutes = -5; }, 'stops[1].serviceMinutes', 'out_of_range'],
    [(i) => { i.crews[1].crewId = 'c1'; }, 'crews[1].crewId', 'duplicate'],
    [(i) => { i.crews[0].crewId = 'crew 1'; }, 'crews[0].crewId', 'bad_id'],
    [(i) => { i.crews[0].available = 1; }, 'crews[0].available', 'not_true_false'],
    [(i) => { i.crews[0].baseNode = 'crew:51.5,-0.1'; }, 'crews[0].baseNode', 'bad_node'],
    [(i) => { i.stops[1].node = 'place:p2'; }, 'stops[1].node', 'bad_node'],
    [(i) => { i.stops[3].stopId = 'v101'; }, 'stops[3].stopId', 'duplicate'],
    [(i) => { i.candidates[0].stopId = 'v102'; }, 'candidates[0].stopId', 'duplicate'],
    [(i) => { i.stops[1].locked = true; }, 'stops[1].start', 'missing'],
    [(i) => { i.stops[0].start = 1441; }, 'stops[0].start', 'out_of_range'],
    [(i) => { i.stops[0].routeOrder = 0; }, 'stops[0].routeOrder', 'out_of_range'],
    [(i) => { i.stops[0].rules = {}; }, 'stops[0].rules', 'not_list'],
    [(i) => { i.stops[0].rules[0].ruleId = 'TimeOfDay'; }, 'stops[0].rules[0].ruleId', 'bad_id'],
    [(i) => { i.stops[2].rules[0].strength = 'firm'; }, 'stops[2].rules[0].strength', 'bad_strength'],
    [(i) => { i.stops[0].rules.push({ ruleId: 'time-of-day', value: {} }); }, 'stops[0].rules[1].ruleId', 'duplicate'],
    [(i) => { delete i.stops[1].rules[0].value; }, 'stops[1].rules[0].value', 'missing'],
    [(i) => { i.candidates[0].plannedDate = '2026-11-9'; }, 'candidates[0].plannedDate', 'bad_date'],
    [(i) => { i.candidates[0].cadenceDays = 0; }, 'candidates[0].cadenceDays', 'out_of_range'],
    [(i) => { i.candidates[0].flexible = 'true'; }, 'candidates[0].flexible', 'not_true_false'],
    [(i) => { i.candidates[0].currentCrewId = 'c9'; }, 'candidates[0].currentCrewId', 'unknown_crew'],
  ];
  for (const [edit, field, problem] of cases) {
    assert.deepEqual(inputFault(edit), { field, problem }, `${field} ${problem}`);
  }
  assert.deepEqual(faultOf(() => routing.validateInput(null)), { field: 'input', problem: 'not_object' });
  assert.deepEqual(faultOf(() => routing.validateInput([])), { field: 'input', problem: 'not_object' });
});

test('optional fields may be left out: candidates, routeOrder, start on an unlocked stop, strength, a null prevVisitDate', () => {
  const input = clone(DAY.input);
  delete input.candidates;
  delete input.stops[1].routeOrder;
  assert.equal(routing.validateInput(input), input);
  const more = clone(DAY.input);
  more.candidates[0].prevVisitDate = null;
  delete more.candidates[0].currentCrewId;
  assert.equal(routing.validateInput(more), more);
});

test('travel.fromMatrix: a known pair returns its minutes', () => {
  const travel = routing.travel.fromMatrix(DAY.matrix);
  for (const row of DAY.matrix) assert.equal(travel(row.from_node, row.to_node), row.minutes);
  assert.equal(travel('crew:c1', 'property:p1'), 13);
});

test('travel.fromMatrix: a missing pair throws RoutingFault, never 0', () => {
  const travel = routing.travel.fromMatrix(DAY.matrix);
  // No return leg to a base is in the matrix (data-design §6), and no self pair.
  assert.deepEqual(faultOf(() => travel('property:p1', 'crew:c1')), { field: 'travel', problem: 'no_travel', from: 'property:p1', to: 'crew:c1' });
  assert.deepEqual(faultOf(() => travel('property:p1', 'property:p1')), { field: 'travel', problem: 'no_travel', from: 'property:p1', to: 'property:p1' });
  assert.equal(faultOf(() => routing.travel.fromMatrix([])('crew:c1', 'property:p1')).problem, 'no_travel');
});

test('travel.fromMatrix refuses a malformed matrix, naming the row', () => {
  const bad = (edit) => {
    const rows = clone(DAY.matrix);
    edit(rows);
    return faultOf(() => routing.travel.fromMatrix(rows));
  };
  assert.deepEqual(bad((r) => { r[0].minutes = 7.5; }), { field: 'matrix[0].minutes', problem: 'not_integer' });
  assert.deepEqual(bad((r) => { r[1].minutes = -1; }), { field: 'matrix[1].minutes', problem: 'out_of_range' });
  assert.deepEqual(bad((r) => { r[2].minutes = '9'; }), { field: 'matrix[2].minutes', problem: 'not_integer' });
  assert.deepEqual(bad((r) => { r[3].from_node = 'p1'; }), { field: 'matrix[3].from_node', problem: 'bad_node' });
  assert.deepEqual(bad((r) => { delete r[4].to_node; }), { field: 'matrix[4].to_node', problem: 'missing' });
  assert.deepEqual(bad((r) => { r.push({ ...r[0] }); }), { field: `matrix[${DAY.matrix.length}]`, problem: 'duplicate' });
  assert.deepEqual(faultOf(() => routing.travel.fromMatrix({})), { field: 'matrix', problem: 'not_list' });
});

test('the travel port is a synchronous function that holds its own copy of the matrix', () => {
  const rows = clone(DAY.matrix);
  const travel = routing.travel.fromMatrix(rows);
  rows[0].minutes = 999;
  assert.equal(travel(DAY.matrix[0].from_node, DAY.matrix[0].to_node), DAY.matrix[0].minutes);
  assert.equal(typeof travel('crew:c1', 'property:p1'), 'number');
  assert.ok(Object.isFrozen(travel));
});

test('RoutingFault takes a problem from a fixed list, and its words name the field, never a value', () => {
  assert.throws(() => new RoutingFault({ field: 'day', problem: 'nope' }), TypeError);
  for (const problem of ROUTING_PROBLEMS) {
    const details = problem === 'no_travel' ? { field: 'travel', problem, from: 'property:p1', to: 'crew:c1' } : { field: 'stops[1].stopId', problem };
    const words = messageFor(new RoutingFault(details), { admin: 'Sam' });
    assert.equal(typeof words, 'string', problem);
    assert.match(words, problem === 'no_travel' ? /property:p1/ : /stops\[1\]\.stopId/, problem);
    assert.match(words, /please tell Sam/, problem);
  }
  const words = messageFor(new RoutingFault({ field: 'stops[3].node', problem: 'bad_node' }));
  assert.match(words, /property:&lt;id&gt;/);
  assert.equal(new RoutingFault({ field: 'day', problem: 'bad_date' }).code, 'ROUTING_FAULT');
});

// Wall-clock minutes and ISO strings only: the same input gives the same
// output whatever the machine's time zone, across the 2026-11-01 DST change.
test('contract and travel output are identical under two TZ values across 2026-11-01', () => {
  assert.equal(DAY.input.day, '2026-11-01');
  const script = `
    const fs = require('node:fs');
    const routing = require(${JSON.stringify(path.resolve(__dirname, '../../kit/runtime/routing'))});
    const day = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const input = routing.validateInput(day.input);
    const travel = routing.travel.fromMatrix(day.matrix);
    const legs = day.matrix.map((r) => [r.from_node, r.to_node, travel(r.from_node, r.to_node)]);
    let fault = null;
    try { routing.validateInput({ ...day.input, day: '2026-11-01T02:00:00' }); } catch (err) { fault = err.details; }
    process.stdout.write(JSON.stringify({ input, legs, fault }));
  `;
  const outputs = ['America/New_York', 'Pacific/Auckland'].map((TZ) => {
    const r = spawnSync(process.execPath, ['-e', script, FIXTURE], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  assert.equal(outputs[0], outputs[1]);
  const parsed = JSON.parse(outputs[0]);
  assert.deepEqual(parsed.input, DAY.input);
  assert.deepEqual(parsed.fault, { field: 'day', problem: 'bad_date' });
});
