'use strict';

// evaluateOrder (Story 15.12, AD-R24): one crew's day in a given order, timed
// and checked against the rules, from a depot. Inputs are synthetic and come
// from test/fixtures/routing/route-depot.json only; a test that needs a
// variant clones the fixture and edits the clone. Expected values are worked
// out by hand from the fixture's matrix (comments show the arithmetic).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const routing = require('../../kit/runtime/routing');
const sdk = require('../../kit/runtime/sdk');
const { RoutingFault, ROUTING_PROBLEMS } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');

const FIXTURE = path.join(__dirname, '../fixtures/routing/route-depot.json');
const load = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const BOOKED = ['s2', 's4', 's1', 's6', 's3', 's5'];

const evaluate = (day, order, opts = {}) => routing.evaluateOrder(day.input, {
  travel: routing.travel.fromMatrix(day.matrix), returnToBase: true, crewId: 'k1', order, ...opts,
});

function faultOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RoutingFault, `expected a RoutingFault, got ${err && err.name}: ${err && err.message}`);
    return err.details;
  }
  return assert.fail('expected a RoutingFault');
}

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  items.forEach((x, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

// The fixture with crew k2 and its stop taken out: k1 alone, from the depot.
function oneCrew() {
  const day = load();
  day.input.crews = day.input.crews.filter((c) => c.crewId === 'k1');
  day.input.stops = day.input.stops.filter((s) => s.currentCrewId === 'k1');
  return day;
}

const COST = ['hardBreaks', 'softPenalty', 'driveMinutes', 'aimFinishMinutes'];
function compareCost(a, b) {
  for (const k of COST) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return 0;
}

test('evaluateOrder is exported from the routing index and the sdk', () => {
  assert.equal(typeof routing.evaluateOrder, 'function');
  assert.equal(sdk.routing.evaluateOrder, routing.evaluateOrder);
});

test('the booked order from the depot: times, drives, leaveAt and backAt match hand-computed values', () => {
  const result = evaluate(load(), BOOKED);
  // office->p2 20, first stop at defaultStart 480; p2->p4 22, 570+22=592 -> 595;
  // p4->p1 20, 670+20=690; p1->p6 17, 750+17=767 -> 770; p6->p3 36,
  // 815+36=851 -> 855 (window 13:00 to 17:00); p3->p5 26, 915+26=941 -> 945;
  // p5->office 17, 1005+17=1022.
  assert.deepEqual(result.stops.map((s) => [s.stopId, s.routeOrder, s.start, s.finish, s.travelMinutesFromPrevious]), [
    ['s2', 1, 480, 570, 20],
    ['s4', 2, 595, 670, 22],
    ['s1', 3, 690, 750, 20],
    ['s6', 4, 770, 815, 17],
    ['s3', 5, 855, 915, 36],
    ['s5', 6, 945, 1005, 26],
  ]);
  for (const s of result.stops) assert.deepEqual(s.breaks, [], s.stopId);
  assert.equal(result.leaveAt, 460);
  assert.equal(result.finish, 1005);
  assert.equal(result.returnMinutes, 17);
  assert.equal(result.backAt, 1022);
  assert.equal(result.lateBack, false);
  assert.deepEqual(result.cost, { hardBreaks: 0, softPenalty: 0, driveMinutes: 158, aimFinishMinutes: 0 });
  assert.deepEqual(Object.keys(result).sort(), ['backAt', 'cost', 'crewId', 'day', 'finish', 'lateBack', 'leaveAt', 'returnMinutes', 'stops']);
  assert.deepEqual(Object.keys(result.stops[0]).sort(), ['breaks', 'finish', 'routeOrder', 'start', 'stopId', 'travelMinutesFromPrevious']);
});

test('a first stop that waits for its window: leaveAt is its start less the first drive', () => {
  const result = evaluate(load(), ['s3', 's2', 's4', 's1', 's6', 's5']);
  // s3's window opens at 13:00 (780); office->p3 is 30, so the crew leaves at 750.
  assert.deepEqual([result.stops[0].start, result.stops[0].travelMinutesFromPrevious, result.leaveAt], [780, 30, 750]);
  // s2 after s3: 840 + p3->p2 13 = 853 -> 855, outside 08:00 to before 12:00.
  assert.equal(result.stops[1].start, 855);
  assert.deepEqual(result.stops[1].breaks, [{
    ruleId: 'time-of-day', label: 'time of day', strength: 'hard', reason: "starts at 14:15, outside the customer's window (08:00 to before 12:00)",
  }]);
  assert.equal(result.stops.length, 6);
  assert.equal(result.cost.hardBreaks, 1);
});

test('an order that runs past aim-finish and past 23:00: every stop kept, breaks listed, lateBack set, times past 24:00 stay integers', () => {
  const day = load();
  for (const s of day.input.stops) if (s.currentCrewId === 'k1') s.serviceMinutes = 240;
  const result = evaluate(day, BOOKED);
  // s2 480-720; s4 720+22=742 -> 745-985; s1 985+20=1005-1245 (165 past
  // 18:00); s6 1245+17=1262 -> 1265, no start finishes by 23:00, so it keeps
  // its arrival: 1265-1505; s3 1505+36=1541 -> 1545-1785; s5 1785+26=1811 ->
  // 1815-2055; back 2055+17=2072.
  assert.deepEqual(result.stops.map((s) => [s.stopId, s.start, s.finish]), [
    ['s2', 480, 720], ['s4', 745, 985], ['s1', 1005, 1245], ['s6', 1265, 1505], ['s3', 1545, 1785], ['s5', 1815, 2055],
  ]);
  for (const s of result.stops) {
    assert.ok(Number.isSafeInteger(s.start) && Number.isSafeInteger(s.finish), s.stopId);
  }
  const breaks = Object.fromEntries(result.stops.map((s) => [s.stopId, s.breaks]));
  assert.deepEqual(breaks.s2, []);
  assert.deepEqual(breaks.s4, []);
  assert.deepEqual(breaks.s1, [{
    ruleId: 'aim-finish', label: 'aim-finish time', strength: 'soft', reason: 'finishes at 20:45, 165 minutes past the aim-finish time of 18:00',
  }]);
  assert.deepEqual(breaks.s6, [
    { ruleId: 'crew-day-limits', label: 'crew day limits', strength: 'hard', reason: "finishes at 25:05, after the crew day's latest finish of 23:00" },
    { ruleId: 'aim-finish', label: 'aim-finish time', strength: 'soft', reason: 'finishes at 25:05, 425 minutes past the aim-finish time of 18:00' },
  ]);
  assert.deepEqual(breaks.s3.map((b) => b.ruleId), ['crew-day-limits', 'time-of-day', 'aim-finish']);
  assert.equal(breaks.s3[1].reason, "starts at 25:45, outside the customer's window (13:00 to before 17:00)");
  assert.deepEqual(breaks.s5.map((b) => b.ruleId), ['crew-day-limits', 'aim-finish']);
  assert.equal(result.finish, 2055);
  assert.equal(result.backAt, 2072);
  assert.equal(result.lateBack, true);
  // Hard: s6 1, s3 2, s5 1, the late return 1. Aim: 165 + 425 + 705 + 975.
  assert.deepEqual(result.cost, { hardBreaks: 5, softPenalty: 0, driveMinutes: 158, aimFinishMinutes: 2270 });
});

test('a soft preferred-crew break is listed with its strength', () => {
  const day = load();
  day.input.stops.find((s) => s.stopId === 's5').rules = [{ ruleId: 'preferred-crew', value: 'k2' }];
  const result = evaluate(day, BOOKED);
  assert.deepEqual(result.stops[5].breaks, [{ ruleId: 'preferred-crew', label: 'preferred crew', strength: 'soft', reason: 'on crew k1, not the preferred crew k2' }]);
  assert.equal(result.cost.softPenalty, 100);
});

test('a locked stop that cannot keep its start is a hard break, not dropped', () => {
  const day = load();
  Object.assign(day.input.stops.find((s) => s.stopId === 's1'), { locked: true, start: 600 });
  const result = evaluate(day, BOOKED);
  const s1 = result.stops.find((s) => s.stopId === 's1');
  assert.equal(s1.start, 690);
  assert.deepEqual(s1.breaks, [{ ruleId: 'locked-start', label: 'locked start', strength: 'hard', reason: 'starts at 11:30, after its locked start of 10:00' }]);
  assert.equal(result.cost.hardBreaks, 1);
});

test('without returnToBase: no return leg, backAt null, lateBack false', () => {
  const result = evaluate(load(), BOOKED, { returnToBase: false });
  assert.equal(result.returnMinutes, 0);
  assert.equal(result.backAt, null);
  assert.equal(result.lateBack, false);
  assert.equal(result.cost.driveMinutes, 141);
});

test('a crew with no stops and an empty order gives an empty day', () => {
  const day = load();
  day.input.stops = day.input.stops.filter((s) => s.currentCrewId !== 'k1');
  const empty = evaluate(day, []);
  assert.deepEqual(empty.stops, []);
  assert.deepEqual([empty.leaveAt, empty.finish, empty.backAt, empty.returnMinutes, empty.lateBack], [null, null, null, 0, false]);
  assert.deepEqual(empty.cost, { hardBreaks: 0, softPenalty: 0, driveMinutes: 0, aimFinishMinutes: 0 });
});

test('a bad order throws RoutingFault naming the field', () => {
  const day = load();
  const cases = [
    [BOOKED.slice(0, 5), { field: 'opts.order', problem: 'missing_stop' }],
    [[...BOOKED, 's2'], { field: 'opts.order[6]', problem: 'duplicate' }],
    [[...BOOKED.slice(0, 5), 's9', 's5'], { field: 'opts.order[5]', problem: 'unknown_stop' }],
    [[...BOOKED, 't1'], { field: 'opts.order[6]', problem: 'other_crew_stop' }],
    [[...BOOKED.slice(0, 5), 5], { field: 'opts.order[5]', problem: 'not_text' }],
    ['s1,s2', { field: 'opts.order', problem: 'not_list' }],
  ];
  for (const [order, want] of cases) assert.deepEqual(faultOf(() => evaluate(day, order)), want, JSON.stringify(order));
  assert.deepEqual(faultOf(() => evaluate(day, undefined)), { field: 'opts.order', problem: 'missing' });
  assert.deepEqual(faultOf(() => evaluate(day, BOOKED, { crewId: 'k9' })), { field: 'opts.crewId', problem: 'unknown_crew' });
  assert.deepEqual(faultOf(() => evaluate(day, BOOKED, { crewId: undefined })), { field: 'opts.crewId', problem: 'missing' });
  assert.deepEqual(faultOf(() => evaluate(day, BOOKED, { crewId: 7 })), { field: 'opts.crewId', problem: 'not_text' });
  assert.deepEqual(faultOf(() => evaluate(day, BOOKED, { returnToBase: undefined })), { field: 'opts.returnToBase', problem: 'missing' });
  assert.deepEqual(faultOf(() => evaluate(day, BOOKED, { returnToBase: 'yes' })), { field: 'opts.returnToBase', problem: 'not_true_false' });
  assert.deepEqual(faultOf(() => evaluate(day, BOOKED, { travel: null })), { field: 'opts.travel', problem: 'not_function' });
  assert.deepEqual(faultOf(() => routing.evaluateOrder(day.input, null)), { field: 'opts', problem: 'not_object' });
  const badInput = clone(day.input);
  badInput.crews[0].baseNode = 'place:office';
  assert.deepEqual(faultOf(() => routing.evaluateOrder(badInput, { travel: routing.travel.fromMatrix(day.matrix), returnToBase: true, crewId: 'k1', order: BOOKED })),
    { field: 'crews[0].baseNode', problem: 'bad_node' });
});

test('the new order problems have words that name the field', () => {
  for (const problem of ['missing_stop', 'unknown_stop', 'other_crew_stop']) {
    assert.ok(ROUTING_PROBLEMS.includes(problem), problem);
    assert.match(messageFor(new RoutingFault({ field: 'opts.order[2]', problem }), { admin: 'Sam' }), /opts\.order\[2\]/, problem);
  }
});

test('evaluateOrder leaves its input untouched and gives the same JSON twice', () => {
  const day = load();
  const before = clone(day);
  const first = JSON.stringify(evaluate(day, BOOKED));
  assert.deepEqual(day, before);
  assert.equal(first, JSON.stringify(evaluate(load(), BOOKED)));
});

test('the output holds no node id, the depot\'s included (AD-R11)', () => {
  const day = load();
  for (const s of day.input.stops) s.serviceMinutes = 240;
  const text = JSON.stringify([evaluate(load(), BOOKED), evaluate(day, BOOKED), evaluate(load(), ['s3', 's2', 's4', 's1', 's6', 's5'])]);
  assert.doesNotMatch(text, /\b(property|crew|depot):[A-Za-z0-9_-]/);
  assert.doesNotMatch(text, /office/);
});

test('evaluateOrder on optimizeDay\'s order gives optimizeDay\'s cost and starts', () => {
  const day = oneCrew();
  const opt = routing.optimizeDay(day.input, { travel: routing.travel.fromMatrix(day.matrix), returnToBase: true });
  const plan = opt.plans[0];
  const result = evaluate(day, plan.stops.map((s) => s.stopId));
  assert.deepEqual(result.cost, opt.cost);
  assert.deepEqual(result.stops.map((s) => [s.stopId, s.start, s.travelMinutesFromPrevious]), plan.stops.map((s) => [s.stopId, s.start, s.travelMinutesFromPrevious]));
});

test('optimizeDay with returnToBase from a depot equals brute force over every order (6 stops)', () => {
  const day = oneCrew();
  const ids = day.input.stops.map((s) => s.stopId);
  assert.ok(ids.length <= 7);
  const all = permutations(ids).map((order) => ({ order, cost: evaluate(day, order).cost }));
  all.sort((a, b) => compareCost(a.cost, b.cost));
  const best = all[0].cost;
  assert.equal(best.hardBreaks, 0);
  const opt = routing.optimizeDay(day.input, { travel: routing.travel.fromMatrix(day.matrix), returnToBase: true });
  assert.deepEqual(opt.unplaced, []);
  assert.deepEqual(opt.cost, best);
  assert.ok(compareCost(opt.booked, best) > 0, 'the fixture is booked in a poor order');
});

test('evaluateOrder output is byte-identical under two TZ values', () => {
  const script = `
    const fs = require('node:fs');
    const routing = require(${JSON.stringify(path.resolve(__dirname, '../../kit/runtime/routing'))});
    const day = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    day.input.day = '2026-11-01';
    const out = routing.evaluateOrder(day.input, { travel: routing.travel.fromMatrix(day.matrix), returnToBase: true, crewId: 'k1', order: ${JSON.stringify(BOOKED)} });
    process.stdout.write(JSON.stringify(out));
  `;
  const outputs = ['America/New_York', 'Pacific/Auckland'].map((TZ) => {
    const r = spawnSync(process.execPath, ['-e', script, FIXTURE], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  assert.equal(outputs[0], outputs[1]);
  const day = load();
  day.input.day = '2026-11-01';
  assert.equal(outputs[0], JSON.stringify(evaluate(day, BOOKED)));
});
