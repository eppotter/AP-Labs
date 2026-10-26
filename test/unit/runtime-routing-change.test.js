'use strict';

// A broken day: place the orphans (Story 12.4, AD-R7, AD-R11). Inputs are
// synthetic and come from test/fixtures/routing/*.json only; a test that
// needs a variant clones a fixture and edits the clone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const routing = require('../../kit/runtime/routing');
const { RoutingFault } = require('../../kit/runtime/errors');

const DIR = path.join(__dirname, '../fixtures/routing');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const place = (day, opts = {}) => routing.placeOrphans(day.input, { travel: routing.travel.fromMatrix(day.matrix), ...opts });
const CONFIRM = 'call to confirm the new time';
const REBOOK = 'call to rebook';

function faultOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RoutingFault, `expected a RoutingFault, got ${err && err.name}: ${err && err.message}`);
    return err.details;
  }
  return assert.fail('expected a RoutingFault');
}

const rowsOf = (result) => result.plans.flatMap((p) => p.stops.map((row) => ({ ...row, crewId: p.crewId })));
const planOf = (result, crewId) => result.plans.find((p) => p.crewId === crewId);
const orderOf = (result, crewId) => planOf(result, crewId).stops.map((s) => s.stopId);

// The orphans: every stop booked on a crew that is out today.
function orphansOf(day) {
  const out = new Set(day.input.crews.filter((c) => !c.available).map((c) => c.crewId));
  return day.input.stops.filter((s) => out.has(s.currentCrewId)).map((s) => s.stopId).sort();
}

// The same day with the orphans taken out: the receiving crews' times before
// the change, worked out by the engine with nothing to place.
function beforeStarts(day) {
  const orphans = new Set(orphansOf(day));
  const bare = clone(day);
  bare.input.stops = bare.input.stops.filter((s) => !orphans.has(s.stopId));
  const result = place(bare);
  assert.deepEqual(result.shifted, []);
  return new Map(rowsOf(result).map((r) => [r.stopId, r.start]));
}

// Each crew's route re-walked here from the matrix and the rules: no hard
// rule broken, every start at or after the arrival, a locked stop at its
// booked start, and every finish within the crew day.
function assertRoutesKeepHardRules(day, result, registry = routing.rules.v1Registry()) {
  const travel = routing.travel.fromMatrix(day.matrix);
  const byId = new Map(day.input.stops.map((s) => [s.stopId, s]));
  const ctx = { day: day.input.day, limits: day.input.limits };
  for (const plan of result.plans) {
    const crew = day.input.crews.find((c) => c.crewId === plan.crewId);
    assert.equal(crew.available, true, `crew ${plan.crewId} is out but has a plan`);
    let prev = crew.baseNode;
    let finish = null;
    for (const row of plan.stops) {
      const stop = byId.get(row.stopId);
      const leg = travel(prev, stop.node);
      assert.equal(row.travelMinutesFromPrevious, leg, row.stopId);
      if (finish !== null) assert.ok(row.start >= finish + leg, `${row.stopId} starts before it can arrive`);
      if (stop.locked) assert.equal(row.start, stop.start, `${row.stopId} keeps its locked start`);
      const tally = registry.evaluate(stop, { crewId: plan.crewId, start: row.start, finish: row.start + stop.serviceMinutes }, ctx);
      assert.equal(tally.hardBreaks, 0, `${row.stopId} breaks a hard rule: ${JSON.stringify(tally.checks)}`);
      finish = row.start + stop.serviceMinutes;
      prev = stop.node;
    }
  }
}

test('sick-crew: every orphan is placed keeping every hard rule, or is unplaced with a reason', () => {
  const day = load('sick-crew');
  const result = place(day);
  assertRoutesKeepHardRules(day, result);
  const orphans = orphansOf(day);
  const placed = rowsOf(result).filter((r) => orphans.includes(r.stopId)).map((r) => r.stopId);
  const unplaced = result.unplaced.map((u) => u.stopId);
  const recommended = result.moves.filter((m) => m.recommendation).map((m) => m.stopId);
  assert.deepEqual([...placed, ...unplaced, ...recommended].sort(), orphans, 'each orphan is accounted for exactly once');
  assert.equal(result.placed, placed.length);
  assert.equal(result.orphans, orphans.length);
  assert.ok(placed.length >= 3, `the fixture places most orphans: ${placed}`);
  for (const u of result.unplaced) {
    assert.match(u.reason, new RegExp(`${REBOOK}$`));
    assert.match(u.reason, /crew s1 is not working today/);
  }
  assert.deepEqual(unplaced, ['o9'], 'the Saturday-only stop has no slot anywhere');
  assert.match(result.unplaced[0].reason, /day of the week: the customer's days are Saturday, not Monday/);
  assert.equal(result.cost.hardBreaks, 0);
  assert.deepEqual(result.plans.map((p) => p.crewId), ['s2', 's3', 's4'], 'the crew that is out has no plan');
});

test('sick-crew: an orphan with one feasible crew goes there (hardest first), in its own zone', () => {
  const day = load('sick-crew');
  const result = place(day);
  assert.ok(orderOf(result, 's3').includes('o4'), 'o4 can only go to crew s3');
  const zoneOf = new Map(day.input.crews.map((c) => [c.crewId, c.zoneId]));
  for (const move of result.moves) {
    assert.equal(move.fromCrew, 's1');
    assert.equal(move.crossZone, false);
    assert.equal(move.recommendation, false);
    assert.equal(zoneOf.get(move.toCrew), 'east');
    assert.equal(move.start, rowsOf(result).find((r) => r.stopId === move.stopId).start);
    assert.match(move.reason, /crew s1 is not working today/);
  }
  assert.deepEqual(result.moves.map((m) => m.stopId), ['o1', 'o2', 'o4']);
  assert.ok(rowsOf(result).find((r) => r.stopId === 'o2').start < 480, 'o2 keeps its window');
});

// Two orphans compete for crew c2's last free half hour. k2 may only go to
// c2 (a hard preferred-crew rule); k0, first by stopId and cheaper on c2,
// could also go to c4. Hardest first gives c2 to k2 and sends k0 to c4.
test('hardest first: the orphan with fewer feasible crews in its zone is placed first', () => {
  const day = load('cross-zone');
  const k2 = day.input.stops.find((s) => s.stopId === 'k2');
  k2.rules = [{ ruleId: 'preferred-crew', value: 'c2', strength: 'hard' }];
  day.input.stops = day.input.stops.filter((s) => s.stopId !== 'k1');
  day.input.stops.push({ ...clone(k2), stopId: 'k0', node: 'property:k0', routeOrder: 3, rules: [] });
  day.input.crews.push({ ...clone(day.input.crews.find((c) => c.crewId === 'c3')), crewId: 'c4', zoneId: 'east', baseNode: 'crew:c4' });
  const rename = (node, from, to) => (node === from ? to : node);
  const extra = [];
  for (const row of day.matrix) {
    if (row.from_node === 'crew:c3' || row.to_node === 'crew:c3') {
      extra.push({ ...row, from_node: rename(row.from_node, 'crew:c3', 'crew:c4'), to_node: rename(row.to_node, 'crew:c3', 'crew:c4') });
    }
  }
  for (const row of [...day.matrix, ...extra]) {
    if (row.from_node === 'property:k2' || row.to_node === 'property:k2') {
      extra.push({ ...row, from_node: rename(row.from_node, 'property:k2', 'property:k0'), to_node: rename(row.to_node, 'property:k2', 'property:k0') });
    }
  }
  extra.push({ from_node: 'property:k0', to_node: 'property:k2', minutes: 5 }, { from_node: 'property:k2', to_node: 'property:k0', minutes: 5 });
  day.matrix = [...day.matrix, ...extra];
  const travel = routing.travel.fromMatrix(day.matrix);
  assert.ok(travel('crew:c2', 'property:k0') < travel('crew:c4', 'property:k0'), 'k0 is cheaper on c2');
  const result = place(day);
  assertRoutesKeepHardRules(day, result);
  assert.ok(orderOf(result, 'c2').includes('k2'));
  assert.ok(!orderOf(result, 'c2').includes('k0'), 'c2 has room for one of them only');
  assert.deepEqual(orderOf(result, 'c4'), ['k0']);
  assert.deepEqual(result.unplaced, []);
  assert.equal(result.placed, 2);
});

test('sick-crew: existing stops keep their order, and each one whose time moves has a "call to confirm" row', () => {
  const day = load('sick-crew');
  const result = place(day);
  const before = beforeStarts(day);
  const orphans = new Set(orphansOf(day));
  const booked = (crewId) => day.input.stops.filter((s) => s.currentCrewId === crewId).sort((a, b) => a.routeOrder - b.routeOrder).map((s) => s.stopId);
  for (const plan of result.plans) {
    assert.deepEqual(plan.stops.map((s) => s.stopId).filter((id) => !orphans.has(id)), booked(plan.crewId), `crew ${plan.crewId} keeps its order`);
    assert.deepEqual(plan.stops.map((s) => s.routeOrder), plan.stops.map((s, i) => i + 1));
  }
  const moved = rowsOf(result).filter((r) => !orphans.has(r.stopId) && r.start !== before.get(r.stopId));
  assert.ok(moved.length > 0, 'the fixture shifts at least one existing stop');
  assert.deepEqual(result.shifted.map((s) => s.stopId), moved.map((r) => r.stopId).sort());
  for (const row of result.shifted) {
    const now = moved.find((r) => r.stopId === row.stopId);
    assert.equal(row.crewId, now.crewId);
    assert.equal(row.start, now.start);
    assert.equal(row.previousStart, before.get(row.stopId));
    assert.match(row.reason, new RegExp(`${CONFIRM}$`));
    assert.match(row.reason, /after stops? o\d/);
  }
  assert.ok(!result.shifted.some((s) => s.crewId === 's4'), 'a crew that receives nothing shifts nothing');
  assert.ok(!result.shifted.some((s) => s.stopId === 'a2'), 'the locked stop never shifts');
  assert.deepEqual(planOf(result, 's4').stops.map((s) => s.start), [...before.entries()].filter(([id]) => id.startsWith('w')).map(([, t]) => t));
});

test('a day with no crew out places nothing and shifts nothing', () => {
  const day = load('sick-crew');
  day.input.crews[0].available = true;
  const result = place(day);
  assert.equal(result.orphans, 0);
  assert.equal(result.placed, 0);
  assert.deepEqual([result.moves, result.shifted, result.unplaced], [[], [], []]);
  assert.match(result.reason, /every crew is working today/);
});

test('all-crews-out: every stop is unplaced with a reason, and no crew has a plan', () => {
  const day = load('all-crews-out');
  const result = place(day);
  assert.deepEqual(result.unplaced.map((u) => u.stopId), day.input.stops.map((s) => s.stopId).sort());
  for (const u of result.unplaced) assert.match(u.reason, new RegExp(`not working today.*${REBOOK}$`));
  assert.match(result.unplaced.find((u) => u.stopId === 'f1').reason, /locked to crew x2 at 09:00/);
  assert.deepEqual([result.plans, result.moves, result.shifted], [[], [], []]);
  assert.equal(result.placed, 0);
  assert.equal(result.orphans, day.input.stops.length);
});

test('cross-zone: the only fit in another zone is a recommendation in moves[], in no crew\'s plan, not counted as placed', () => {
  const day = load('cross-zone');
  const result = place(day);
  assertRoutesKeepHardRules(day, result);
  const cross = result.moves.filter((m) => m.crossZone);
  assert.equal(cross.length, 1);
  assert.equal(cross[0].stopId, 'k1');
  assert.deepEqual([cross[0].fromCrew, cross[0].toCrew, cross[0].recommendation], ['c1', 'c3', true]);
  assert.ok(Number.isSafeInteger(cross[0].start));
  assert.match(cross[0].reason, /no slot on crew c2 keeps every hard rule/);
  assert.match(cross[0].reason, /zone west/);
  assert.match(cross[0].reason, /a recommendation only/);
  assert.ok(!rowsOf(result).some((r) => r.stopId === 'k1'), 'k1 is in no crew\'s plan');
  assert.deepEqual(orderOf(result, 'c3'), ['p1'], 'crew c3 keeps its booked day');
  assert.ok(orderOf(result, 'c2').includes('k2'), 'k2 still fits in its own zone');
  assert.equal(result.placed, 1);
  assert.equal(result.orphans, 2);
  assert.deepEqual(result.unplaced, []);
  assert.ok(!result.shifted.some((s) => s.crewId === 'c3'));
});

test('cross-zone: with no other crew anywhere the stop is unplaced, "call to rebook"', () => {
  const day = load('cross-zone');
  day.input.crews.find((c) => c.crewId === 'c3').available = false;
  const result = place(day);
  assert.ok(result.unplaced.some((u) => u.stopId === 'k1'));
  const k1 = result.unplaced.find((u) => u.stopId === 'k1');
  assert.match(k1.reason, /no crew in another zone is working today; call to rebook$/);
  assert.ok(!result.moves.some((m) => m.crossZone));
});

test('the same input gives byte-identical output, and the input is not changed', () => {
  for (const name of ['sick-crew', 'cross-zone', 'all-crews-out']) {
    const day = load(name);
    const copy = clone(day);
    const first = JSON.stringify(place(day));
    assert.deepEqual(day, copy);
    assert.equal(JSON.stringify(place(load(name))), first);
  }
});

test('the input order of crews and stops does not change the answer', () => {
  const day = load('sick-crew');
  const flipped = clone(day);
  flipped.input.crews.reverse();
  flipped.input.stops.reverse();
  assert.equal(JSON.stringify(place(flipped)), JSON.stringify(place(day)));
});

test('with returnToBase a receiving crew still gets home by the latest finish', () => {
  const day = load('cross-zone');
  const travel = routing.travel.fromMatrix(day.matrix);
  const result = place(day, { returnToBase: true });
  for (const plan of result.plans) {
    const last = plan.stops[plan.stops.length - 1];
    const stop = day.input.stops.find((s) => s.stopId === last.stopId);
    assert.ok(last.start + stop.serviceMinutes + travel(stop.node, `crew:${plan.crewId}`) <= day.input.limits.latestFinish);
  }
});

test('bad input and options throw RoutingFault naming the field', () => {
  const day = load('sick-crew');
  const travel = routing.travel.fromMatrix(day.matrix);
  assert.deepEqual(faultOf(() => routing.placeOrphans(day.input, {})), { field: 'opts.travel', problem: 'not_function' });
  assert.deepEqual(faultOf(() => routing.placeOrphans(day.input, { travel, returnToBase: 1 })), { field: 'opts.returnToBase', problem: 'not_true_false' });
  assert.deepEqual(faultOf(() => routing.placeOrphans({ ...day.input, day: '2026-13-01' }, { travel })), { field: 'day', problem: 'bad_date' });
});

test('output holds ids, minutes and rule words only, never a place', () => {
  const keys = new Set();
  const walkKeys = (v) => {
    if (Array.isArray(v)) v.forEach(walkKeys);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walkKeys(x); }
  };
  for (const name of ['sick-crew', 'cross-zone', 'all-crews-out']) {
    const result = place(load(name));
    assert.doesNotMatch(JSON.stringify(result), /\b(property|crew):[A-Za-z0-9_-]/, 'no node id, which an adapter may derive from a place');
    for (const row of [...rowsOf(result), ...result.moves, ...result.shifted, ...result.unplaced]) {
      assert.ok(typeof row.reason === 'string' && row.reason.length > 0, JSON.stringify(row));
    }
    walkKeys(result);
  }
  assert.deepEqual([...keys].sort(), [
    'aimFinishMinutes', 'cost', 'crewId', 'crewsOut', 'crossZone', 'day', 'driveMinutes', 'fromCrew', 'hardBreaks', 'moves', 'orphans',
    'placed', 'plans', 'previousStart', 'reason', 'recommendation', 'routeOrder', 'shifted', 'softPenalty', 'start', 'stopId', 'stops',
    'toCrew', 'travelMinutesFromPrevious', 'unplaced', 'zoneId',
  ]);
});

// Wall-clock minutes and ISO strings only: the same day gives the same answer
// whatever the machine's time zone, across the 2026-11-01 DST change.
test('placeOrphans output is identical under two TZ values across 2026-11-01', () => {
  const names = ['sick-crew', 'cross-zone'];
  const script = `
    const fs = require('node:fs');
    const routing = require(${JSON.stringify(path.resolve(__dirname, '../../kit/runtime/routing'))});
    const out = process.argv.slice(1).map((file) => {
      const day = JSON.parse(fs.readFileSync(file, 'utf8'));
      day.input.day = '2026-11-01';
      return routing.placeOrphans(day.input, { travel: routing.travel.fromMatrix(day.matrix) });
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const files = names.map((n) => path.join(DIR, `${n}.json`));
  const outputs = ['America/New_York', 'Pacific/Auckland'].map((TZ) => {
    const r = spawnSync(process.execPath, ['-e', script, ...files], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  assert.equal(outputs[0], outputs[1]);
  const here = names.map((n) => {
    const day = load(n);
    day.input.day = '2026-11-01';
    return place(day);
  });
  assert.equal(outputs[0], JSON.stringify(here));
});
