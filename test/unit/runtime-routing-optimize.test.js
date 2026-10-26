'use strict';

// Optimize a day (Story 12.3, AD-R5, AD-R6, AD-R11). Inputs are synthetic and
// come from test/fixtures/routing/*.json only; a test that needs a variant
// clones a fixture and edits the clone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const routing = require('../../kit/runtime/routing');
const { constructionPlans, relocations, DEFAULT_BUDGET, BOOKED_BEST } = require('../../kit/runtime/routing/optimize');
const { RoutingFault } = require('../../kit/runtime/errors');

const DIR = path.join(__dirname, '../fixtures/routing');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const optimize = (day, opts = {}) => routing.optimizeDay(day.input, { travel: routing.travel.fromMatrix(day.matrix), ...opts });

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

// One crew's drive and aim-finish minutes for an order, worked out here from
// the matrix alone: the first stop at the default start, each next one at its
// arrival rounded up to the start step (no customer rules on these stops).
function walk(day, crewId, order) {
  const travel = routing.travel.fromMatrix(day.matrix);
  const { limits } = day.input;
  const crew = day.input.crews.find((c) => c.crewId === crewId);
  const byId = new Map(day.input.stops.map((s) => [s.stopId, s]));
  let drive = 0;
  let aim = 0;
  let prev = crew.baseNode;
  let finish = null;
  for (const stopId of order) {
    const stop = byId.get(stopId);
    const leg = travel(prev, stop.node);
    drive += leg;
    const start = finish === null ? limits.defaultStart : Math.ceil((finish + leg) / limits.startRoundTo) * limits.startRoundTo;
    finish = start + stop.serviceMinutes;
    aim += Math.max(0, finish - limits.aimFinish);
    prev = stop.node;
  }
  return { drive, aim };
}

const orderOf = (result, crewId) => result.plans.find((p) => p.crewId === crewId).stops.map((s) => s.stopId);
const rowsOf = (result) => result.plans.flatMap((p) => p.stops.map((row) => ({ ...row, crewId: p.crewId })));

// Every returned row re-checked against the rules on its own slot: no hard
// break, ever (AD-R5).
function assertNoHardBreak(day, result, registry = routing.rules.v1Registry()) {
  const byId = new Map(day.input.stops.map((s) => [s.stopId, s]));
  const ctx = { day: day.input.day, limits: day.input.limits };
  for (const row of rowsOf(result)) {
    const stop = byId.get(row.stopId);
    const tally = registry.evaluate(stop, { crewId: row.crewId, start: row.start, finish: row.start + stop.serviceMinutes }, ctx);
    assert.equal(tally.hardBreaks, 0, `${row.stopId} breaks a hard rule: ${JSON.stringify(tally.checks)}`);
  }
  assert.equal(result.cost.hardBreaks, 0);
}

test('known-optimal: the optimized drive minutes equal a brute force over every order', () => {
  const day = load('known-optimal');
  assert.ok(day.input.stops.length <= 7 && day.input.crews.length === 1);
  const ids = day.input.stops.map((s) => s.stopId);
  const best = Math.min(...permutations(ids).map((order) => walk(day, 'k1', order).drive));
  const result = optimize(day);
  assert.equal(result.source, 'suggested');
  assert.equal(result.cost.driveMinutes, best);
  assert.equal(walk(day, 'k1', orderOf(result, 'k1')).drive, best);
  assert.ok(result.booked.driveMinutes > best, 'the fixture is booked in a poor order');
  assert.deepEqual(result.unplaced, []);
});

test('zigzag: no hard break, drive no worse than booked, a reason on every row, the same JSON twice', () => {
  const day = load('zigzag');
  const first = optimize(day);
  const second = optimize(load('zigzag'));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assertNoHardBreak(day, first);
  assert.ok(first.cost.driveMinutes <= first.booked.driveMinutes);
  assert.ok(first.cost.driveMinutes < first.booked.driveMinutes, 'the zigzag gets shorter');
  const rows = rowsOf(first);
  assert.equal(rows.length, day.input.stops.length);
  assert.equal(rows.reduce((n, r) => n + r.travelMinutesFromPrevious, 0), first.cost.driveMinutes);
  for (const row of [...rows, ...first.moves, ...first.unplaced]) assert.ok(typeof row.reason === 'string' && row.reason.length > 0, JSON.stringify(row));
  assert.ok(first.moves.length > 0);
  for (const plan of first.plans) assert.deepEqual(plan.stops.map((s) => s.routeOrder), plan.stops.map((s, i) => i + 1));
  assert.equal(typeof first.reason, 'string');
});

test('zigzag: no stop moves across zones, and moves are flagged same-zone', () => {
  const day = load('zigzag');
  const zoneOf = new Map(day.input.crews.map((c) => [c.crewId, c.zoneId]));
  const booked = new Map(day.input.stops.map((s) => [s.stopId, s.currentCrewId]));
  const result = optimize(day);
  for (const row of rowsOf(result)) assert.equal(zoneOf.get(row.crewId), zoneOf.get(booked.get(row.stopId)), row.stopId);
  for (const move of result.moves) {
    assert.equal(move.crossZone, false);
    assert.equal(zoneOf.get(move.fromCrew), zoneOf.get(move.toCrew));
  }
});

test('a zone whose only crew is out: its stops go to unplaced[], never to another zone', () => {
  const day = load('zigzag');
  day.input.crews.find((c) => c.crewId === 's1').available = false;
  const result = optimize(day);
  assert.deepEqual(result.unplaced, ['v09', 'v10', 'v11'].map((stopId) => ({ stopId, reason: 'no crew in zone south is working today' })));
  assert.deepEqual(result.plans.map((p) => p.crewId), ['n1', 'n2']);
  assert.equal(result.source, 'suggested');
  assertNoHardBreak(day, result);
});

test('a crew that is out: its stops move to its zone\'s other crew, and a locked one is unplaced', () => {
  const day = load('zigzag');
  day.input.crews.find((c) => c.crewId === 'n2').available = false;
  Object.assign(day.input.stops.find((s) => s.stopId === 'v05'), { locked: true, start: 600 });
  const result = optimize(day);
  assert.deepEqual(result.unplaced, [{ stopId: 'v05', reason: 'locked to crew n2, which is not working today' }]);
  assert.deepEqual(orderOf(result, 'n1').slice().sort(), ['v01', 'v02', 'v03', 'v04', 'v06', 'v07', 'v08']);
  assert.ok(result.reason.startsWith('the booked order breaks 4 hard rules'));
  assertNoHardBreak(day, result);
});

test('a booked order already optimal comes back as booked, with "booked order is already best"', () => {
  const day = load('known-optimal');
  const order = orderOf(optimize(day), 'k1');
  for (const stop of day.input.stops) stop.routeOrder = order.indexOf(stop.stopId) + 1;
  const result = optimize(day);
  assert.equal(BOOKED_BEST, 'booked order is already best');
  assert.equal(result.source, 'booked');
  assert.equal(result.reason, BOOKED_BEST);
  assert.deepEqual(orderOf(result, 'k1'), order);
  assert.deepEqual(result.cost, result.booked);
  assert.deepEqual(result.moves, []);
  assert.deepEqual(result.unplaced, []);
});

test('an equally good order is not strictly better, so the booked order stays', () => {
  const day = load('zigzag');
  const suggested = optimize(day);
  for (const plan of suggested.plans) {
    for (const row of plan.stops) Object.assign(day.input.stops.find((s) => s.stopId === row.stopId), { currentCrewId: plan.crewId, routeOrder: row.routeOrder });
  }
  const result = optimize(day);
  assert.equal(result.source, 'booked');
  assert.equal(result.reason, BOOKED_BEST);
  assert.deepEqual(result.cost, suggested.cost);
});

test('a booked order that breaks a hard rule is never returned', () => {
  const day = load('known-optimal');
  const order = orderOf(optimize(day), 'k1');
  for (const stop of day.input.stops) stop.routeOrder = order.indexOf(stop.stopId) + 1;
  // The stop booked last must start before 08:10, which only first place allows.
  const last = day.input.stops.find((s) => s.stopId === order[order.length - 1]);
  last.rules = [{ ruleId: 'time-of-day', value: { startFrom: 360, startBefore: 490 } }];
  const result = optimize(day);
  assert.equal(result.booked.hardBreaks, 1);
  assert.equal(result.source, 'suggested');
  assert.equal(orderOf(result, 'k1')[0], last.stopId);
  assert.ok(result.cost.driveMinutes > walk(day, 'k1', order).drive, 'the plan drives further than booked, and still wins');
  assertNoHardBreak(day, result);
});

test('contradictory-rules: a stop whose hard rules cannot all hold is unplaced with a reason', () => {
  const day = load('contradictory-rules');
  const result = optimize(day);
  assert.deepEqual(result.unplaced.map((u) => u.stopId), ['x1', 'x2']);
  for (const u of result.unplaced) assert.match(u.reason, /^no slot on crew c1 keeps every hard rule \(.+\)$/);
  assert.match(result.unplaced.find((u) => u.stopId === 'x2').reason, /day of the week: the customer's days are Tuesday or Wednesday, not Monday/);
  assert.deepEqual(orderOf(result, 'c1').slice().sort(), ['y1', 'y2']);
  assert.ok(result.booked.hardBreaks > 0);
  assert.equal(result.source, 'suggested');
  assert.match(result.reason, /2 stops could not be placed/);
  assertNoHardBreak(day, result);
});

test('an unplaced stop counts against the plan: a hard-free booked order that serves it is kept', () => {
  const day = load('known-optimal');
  const order = orderOf(optimize(day), 'k1');
  for (const stop of day.input.stops) stop.routeOrder = order.indexOf(stop.stopId) + 1;
  const result = optimize(day, { budget: 0 });
  assert.equal(result.source, 'booked');
  assert.deepEqual(result.unplaced, []);
});

test('aim-finish minutes are compared after drive time, never summed with the preferred-crew penalty', () => {
  const day = load('known-optimal');
  // Long visits push the day past 18:00, so every order runs late.
  const service = { s1: 150, s2: 60, s3: 180, s4: 90, s5: 120, s6: 45 };
  for (const stop of day.input.stops) stop.serviceMinutes = service[stop.stopId];
  day.input.stops.find((s) => s.stopId === 's1').rules = [{ ruleId: 'preferred-crew', value: 'k9' }];
  const ids = day.input.stops.map((s) => s.stopId);
  const all = permutations(ids).map((order) => ({ order, ...walk(day, 'k1', order) }));
  const lexBest = all.reduce((b, x) => (x.drive < b.drive || (x.drive === b.drive && x.aim < b.aim) ? x : b));
  const sumBest = all.reduce((b, x) => (x.drive + x.aim < b.drive + b.aim ? x : b));
  assert.ok(lexBest.aim > sumBest.aim, 'the fixture makes the two objectives disagree');
  const result = optimize(day);
  assert.equal(result.cost.driveMinutes, lexBest.drive);
  assert.equal(result.cost.aimFinishMinutes, lexBest.aim);
  assert.equal(result.cost.softPenalty, 100, 'the preferred-crew break alone');
  assert.match(rowsOf(result).find((r) => r.stopId === 's1').reason, /preferred crew: on crew k1, not the preferred crew k9/);
});

test('a rule a test registers (no engine edit) is honoured by the solver', () => {
  const day = load('known-optimal');
  const plain = orderOf(optimize(day), 'k1');
  const target = plain[plain.length - 1];
  const registry = routing.rules.v1Registry().register({
    id: 'start-before',
    label: 'start before',
    defaultStrength: 'hard',
    weight: 1,
    check: (stop, slot, { value }) => (slot.start < value
      ? { ok: true, reason: `starts before minute ${value}` }
      : { ok: false, reason: `starts at minute ${slot.start}, not before minute ${value}` }),
  });
  day.input.stops.find((s) => s.stopId === target).rules = [{ ruleId: 'start-before', value: 600 }];
  const result = optimize(day, { rules: registry });
  const row = rowsOf(result).find((r) => r.stopId === target);
  assert.ok(row.start < 600, `${target} starts at ${row.start}`);
  assert.notDeepEqual(orderOf(result, 'k1'), plain);
  assert.match(row.reason, /start before: starts before minute 600/);
  assertNoHardBreak(day, result, registry);
  // The v1 registry alone does not know the rule, and says so.
  assert.deepEqual(faultOf(() => optimize(day)), { field: `stops[${day.input.stops.findIndex((s) => s.stopId === target)}].rules[0].ruleId`, problem: 'unknown_rule' });
});

test('locked stops keep their crew and start', () => {
  const day = load('locked');
  const result = optimize(day);
  const rows = rowsOf(result);
  for (const stop of day.input.stops.filter((s) => s.locked)) {
    const row = rows.find((r) => r.stopId === stop.stopId);
    assert.equal(row.crewId, stop.currentCrewId, stop.stopId);
    assert.equal(row.start, stop.start, stop.stopId);
    assert.match(row.reason, new RegExp(`^locked: keeps crew ${stop.currentCrewId}`));
  }
  assert.ok(!result.moves.some((m) => m.stopId === 'l2'), 'l2 stays on a2 though it sits next to a1');
  assertNoHardBreak(day, result);
});

test('a locked start that cannot be kept with another locked stop is unplaced, never broken', () => {
  const day = load('locked');
  Object.assign(day.input.stops.find((s) => s.stopId === 'u1'), { locked: true, start: 610 });
  const result = optimize(day);
  assert.deepEqual(result.unplaced.map((u) => u.stopId), ['u1']);
  assert.match(result.unplaced[0].reason, /^locked to crew a1 at 10:10, but that can't be kept without breaking a hard rule/);
  assertNoHardBreak(day, result);
});

test('the budget is an evaluation count: 0 returns the construction result, a small one stops early', () => {
  const day = load('zigzag');
  const travel = routing.travel.fromMatrix(day.matrix);
  const zero = optimize(day, { budget: 0 });
  assert.equal(zero.evaluations, 0);
  assert.equal(zero.source, 'suggested');
  assert.deepEqual(zero.plans, constructionPlans(day.input, { travel }));
  const five = optimize(day, { budget: 5 });
  assert.ok(five.evaluations <= 5);
  const full = optimize(day);
  assert.equal(DEFAULT_BUDGET, 20000);
  assert.ok(full.evaluations > 5 && full.evaluations <= DEFAULT_BUDGET);
  assert.ok(full.cost.driveMinutes <= zero.cost.driveMinutes);
  assert.deepEqual(optimize(day, { budget: DEFAULT_BUDGET }), full);
});

test('bad options throw RoutingFault naming the option', () => {
  const day = load('zigzag');
  const travel = routing.travel.fromMatrix(day.matrix);
  assert.deepEqual(faultOf(() => routing.optimizeDay(day.input, {})), { field: 'opts.travel', problem: 'not_function' });
  assert.deepEqual(faultOf(() => routing.optimizeDay(day.input, { travel, budget: -1 })), { field: 'opts.budget', problem: 'out_of_range' });
  assert.deepEqual(faultOf(() => routing.optimizeDay(day.input, { travel, budget: 1.5 })), { field: 'opts.budget', problem: 'not_integer' });
  assert.deepEqual(faultOf(() => routing.optimizeDay(day.input, { travel, rules: {} })), { field: 'opts.rules', problem: 'not_function' });
  assert.deepEqual(faultOf(() => routing.optimizeDay(day.input, { travel, returnToBase: 'yes' })), { field: 'opts.returnToBase', problem: 'not_true_false' });
  assert.deepEqual(faultOf(() => routing.optimizeDay({ ...day.input, day: '2026-11-2' }, { travel })), { field: 'day', problem: 'bad_date' });
});

test('returnToBase adds the last leg home to the drive minutes', () => {
  const day = load('known-optimal');
  const travel = routing.travel.fromMatrix(day.matrix);
  const away = optimize(day);
  const home = optimize(day, { returnToBase: true });
  const order = orderOf(home, 'k1');
  const last = day.input.stops.find((s) => s.stopId === order[order.length - 1]);
  assert.equal(home.cost.driveMinutes, walk(day, 'k1', order).drive + travel(last.node, 'crew:k1'));
  assert.ok(home.cost.driveMinutes >= away.cost.driveMinutes);
});

test('reasons and output hold ids, minutes and rule words only, never a place', () => {
  const result = optimize(load('zigzag'));
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /\b(property|crew):[A-Za-z0-9_-]/, 'no node id, which an adapter may derive from a place');
  const keys = new Set();
  const walkKeys = (v) => {
    if (Array.isArray(v)) v.forEach(walkKeys);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walkKeys(x); }
  };
  walkKeys(result);
  assert.deepEqual([...keys].sort(), [
    'aimFinishMinutes', 'booked', 'cost', 'crewId', 'crossZone', 'day', 'driveMinutes', 'evaluations', 'fromCrew', 'hardBreaks',
    'moves', 'plans', 'reason', 'routeOrder', 'softPenalty', 'source', 'start', 'stopId', 'stops', 'toCrew', 'travelMinutesFromPrevious',
    'unplaced', 'zoneId',
  ]);
});

// Wall-clock minutes and ISO strings only: the same day gives the same plan
// whatever the machine's time zone, across the 2026-11-01 DST change.
test('optimize output is identical under two TZ values across 2026-11-01', () => {
  const script = `
    const fs = require('node:fs');
    const routing = require(${JSON.stringify(path.resolve(__dirname, '../../kit/runtime/routing'))});
    const out = process.argv.slice(1).map((file) => {
      const day = JSON.parse(fs.readFileSync(file, 'utf8'));
      day.input.day = '2026-11-01';
      return routing.optimizeDay(day.input, { travel: routing.travel.fromMatrix(day.matrix) });
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const files = ['zigzag', 'locked'].map((n) => path.join(DIR, `${n}.json`));
  const outputs = ['America/New_York', 'Pacific/Auckland'].map((TZ) => {
    const r = spawnSync(process.execPath, ['-e', script, ...files], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  assert.equal(outputs[0], outputs[1]);
  const here = ['zigzag', 'locked'].map((n) => {
    const day = load(n);
    day.input.day = '2026-11-01';
    return optimize(day);
  });
  assert.equal(outputs[0], JSON.stringify(here));
});

// Review of PR #198, finding 1: every relocation within a route is in the
// move set, forward (to a later index) as well as backward, and none is the
// route unchanged.
test('the within-crew relocations hold every forward and backward move of one stop, never the route unchanged', () => {
  for (let n = 2; n <= 6; n += 1) {
    const order = [...Array(n).keys()];
    const got = [...relocations(order)].map((r) => r.join(','));
    assert.ok(!got.includes(order.join(',')), `n=${n}: a relocation left the route unchanged`);
    for (let i = 0; i < n; i += 1) {
      for (let t = 0; t < n; t += 1) {
        if (t === i) continue;
        const want = order.filter((x) => x !== i);
        want.splice(t, 0, i);
        assert.ok(got.includes(want.join(',')), `n=${n}: stop ${i} to index ${t} is missing`);
      }
    }
  }
  assert.deepEqual([...relocations(['a', 'b', 'c'])][0], ['b', 'a', 'c'], 'the first move is a forward one');
  assert.deepEqual([...relocations(['a', 'b', 'c'])][1], ['b', 'c', 'a'], 'stop a to the last index');
});

// A soft rule on every stop that always passes and records each slot the
// solver tries, so a test can watch the slot search.
function spyRegistry(seen) {
  return routing.rules.v1Registry().register({
    id: 'spy',
    label: 'spy',
    defaultStrength: 'soft',
    weight: 1,
    everyStop: true,
    check: (stop, slot) => {
      seen.push({ stopId: stop.stopId, start: slot.start, finish: slot.finish });
      return { ok: true, reason: 'seen' };
    },
  });
}

// Review of PR #198, finding 2: the slot search never tries a start that
// cannot finish by latestFinish (and, with returnToBase, get back to base).
test('the slot search never tries an unlocked stop\'s start past the latest one that can finish in the day', () => {
  for (const name of ['contradictory-rules', 'zigzag', 'known-optimal']) {
    for (const returnToBase of [false, true]) {
      const day = load(name);
      const travel = routing.travel.fromMatrix(day.matrix);
      const seen = [];
      optimize(day, { rules: spyRegistry(seen), returnToBase });
      const { latestFinish } = day.input.limits;
      const byId = new Map(day.input.stops.map((s) => [s.stopId, s]));
      const zoneOf = new Map(day.input.crews.map((c) => [c.crewId, c.zoneId]));
      for (const { stopId, start, finish } of seen) {
        const stop = byId.get(stopId);
        if (stop.locked) continue;
        const crews = day.input.crews.filter((c) => c.zoneId === zoneOf.get(stop.currentCrewId));
        const home = returnToBase ? Math.min(...crews.map((c) => travel(stop.node, c.baseNode))) : 0;
        assert.ok(finish + home <= latestFinish, `${name} returnToBase=${returnToBase}: ${stopId} tried at ${start}, finishing ${finish}`);
      }
    }
  }
});

test('with returnToBase, a crew that could not get back to base by the latest finish is never returned', () => {
  const day = load('known-optimal');
  const rows = optimize(day).plans[0].stops;
  const last = day.input.stops.find((s) => s.stopId === rows[rows.length - 1].stopId);
  const lastFinish = rows[rows.length - 1].start + last.serviceMinutes;
  Object.assign(day.input.limits, { aimFinish: lastFinish, latestFinish: lastFinish });
  assert.deepEqual(optimize(day).unplaced, [], 'without the return leg every stop still fits');
  const home = optimize(day, { returnToBase: true });
  assert.ok(home.unplaced.length > 0, 'a stop gives way so the crew gets home in time');
  for (const u of home.unplaced) assert.match(u.reason, /^no slot on crew k1 keeps every hard rule \(.+\)$/);
  const travel = routing.travel.fromMatrix(day.matrix);
  const kept = home.plans[0].stops;
  const end = day.input.stops.find((s) => s.stopId === kept[kept.length - 1].stopId);
  assert.ok(kept[kept.length - 1].start + end.serviceMinutes + travel(end.node, 'crew:k1') <= lastFinish);
  assert.equal(home.cost.hardBreaks, 0);
});

// AD-R5: no returned plan ever breaks a hard rule or runs past the crew day,
// whatever the fixture, budget or return leg.
test('no returned plan ever has a hard break or a stop finishing after the latest finish', () => {
  for (const name of ['known-optimal', 'zigzag', 'locked', 'contradictory-rules']) {
    for (const returnToBase of [false, true]) {
      for (const budget of [0, 3, DEFAULT_BUDGET]) {
        const day = load(name);
        const travel = routing.travel.fromMatrix(day.matrix);
        const result = optimize(day, { returnToBase, budget });
        const at = `${name} returnToBase=${returnToBase} budget=${budget}`;
        assert.equal(result.cost.hardBreaks, 0, at);
        assertNoHardBreak(day, result);
        const byId = new Map(day.input.stops.map((s) => [s.stopId, s]));
        for (const plan of result.plans) {
          const base = day.input.crews.find((c) => c.crewId === plan.crewId).baseNode;
          plan.stops.forEach((row, k) => {
            const stop = byId.get(row.stopId);
            const back = returnToBase && k === plan.stops.length - 1 ? travel(stop.node, base) : 0;
            assert.ok(row.start + stop.serviceMinutes + back <= day.input.limits.latestFinish, `${at}: ${row.stopId}`);
          });
        }
      }
    }
  }
});
