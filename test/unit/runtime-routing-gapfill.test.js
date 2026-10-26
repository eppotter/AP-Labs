'use strict';

// Fill a gap with ranked candidates (Story 12.5, AD-R8, AD-R11). Inputs are
// synthetic and come from test/fixtures/routing/gap*.json only; a test that
// needs a variant clones a fixture and edits the clone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const routing = require('../../kit/runtime/routing');
const scoring = require('../../kit/runtime/scoring');
const { dayNumber } = require('../../kit/runtime/routing/gapfill');
const { RoutingFault } = require('../../kit/runtime/errors');

const DIR = path.join(__dirname, '../fixtures/routing');
const NAMES = ['gap', 'gap-tight', 'gap-adjacent', 'gap-two'];
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const fill = (day, opts = {}) => routing.fillGap(day.input, { travel: routing.travel.fromMatrix(day.matrix), ...opts });
const idsOf = (gap) => gap.candidates.map((r) => r.stopId);
const excludedIds = (gap) => gap.excluded.map((r) => r.stopId);
const reasonFor = (gap, stopId) => gap.excluded.find((r) => r.stopId === stopId).reason;

function faultOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RoutingFault, `expected a RoutingFault, got ${err && err.name}: ${err && err.message}`);
    return err.details;
  }
  return assert.fail('expected a RoutingFault');
}

test('gap: the planted best fill ranks first, both decoys are excluded, at most 5 rows, each with score and reason', () => {
  const result = fill(load('gap'));
  assert.equal(result.gaps.length, 1);
  const [gap] = result.gaps;
  assert.deepEqual({ gapId: gap.gapId, crewId: gap.crewId, cancelled: gap.cancelled, after: gap.after, before: gap.before, from: gap.from, to: gap.to },
    { gapId: 'x1', crewId: 'g1', cancelled: ['x1'], after: 'a2', before: 'a3', from: 720, to: 960 });
  assert.equal(gap.candidates[0].stopId, 'c1', 'the planted best fill ranks first');
  assert.ok(gap.candidates.length <= 5);
  assert.equal(gap.candidates.length, 5);
  assert.equal(gap.valid, 6, 'six candidates fit; the top five are shown');
  for (const id of ['c2', 'c3']) {
    assert.ok(!idsOf(gap).includes(id), `decoy ${id} is not offered`);
    assert.ok(excludedIds(gap).includes(id), `decoy ${id} is listed as excluded`);
  }
  // The window decoy is closer than the best fill (5 + 6 minutes against 10 + 12).
  assert.match(reasonFor(gap, 'c2'), /time of day: .*outside the customer's window/);
  assert.match(reasonFor(gap, 'c3'), /4 days since its last visit .* under half its 14-day cadence/);
  gap.candidates.forEach((row, k) => {
    assert.equal(row.rank, k + 1);
    assert.ok(Number.isInteger(row.score) && row.score >= 0 && row.score <= 100, JSON.stringify(row));
    assert.ok(typeof row.reason === 'string' && row.reason.length > 0);
    if (k > 0) assert.ok(gap.candidates[k - 1].score >= row.score, 'best first');
  });
  assert.match(gap.reason, /^6 of 12 candidates fit the 240-minute gap on crew g1 from 12:00 to 16:00/);
});

test('gap: equal scores break the tie by stopId', () => {
  const [gap] = fill(load('gap')).gaps;
  const c6 = gap.candidates.find((r) => r.stopId === 'c6');
  const c7 = gap.candidates.find((r) => r.stopId === 'c7');
  assert.equal(c6.score, c7.score);
  assert.equal(c7.rank, c6.rank + 1);
  // The same tie with the input order reversed.
  const day = load('gap');
  day.input.candidates.reverse();
  assert.deepEqual(idsOf(fill(day).gaps[0]), idsOf(gap));
});

test('the cancelled property and any property already visited on the gap date are never offered', () => {
  const [gap] = fill(load('gap')).gaps;
  assert.match(reasonFor(gap, 'c8'), /its property cancelled a visit on 2026-11-04/);
  assert.match(reasonFor(gap, 'c9'), /its property already has a visit on 2026-11-04/);
  for (const name of NAMES) {
    const day = load(name);
    const nodeOf = new Map(day.input.candidates.map((c) => [c.stopId, c.node]));
    const banned = new Set([...day.input.cancelled, ...day.input.stops].map((s) => s.node));
    for (const g of fill(day).gaps) for (const row of g.candidates) assert.ok(!banned.has(nodeOf.get(row.stopId)), `${name}: ${row.stopId}`);
  }
});

test('gap-tight: no candidate fits, so the list is empty with a reason', () => {
  const result = fill(load('gap-tight'));
  const [gap] = result.gaps;
  assert.deepEqual(gap.candidates, []);
  assert.equal(gap.valid, 0);
  assert.equal(gap.minutes, 80);
  assert.match(gap.reason, /^no candidate fits the 80-minute gap on crew t1 from 10:00 to 11:20/);
  assert.deepEqual(excludedIds(gap), ['k1', 'k2', 'k3']);
  assert.match(reasonFor(gap, 'k1'), /10 minutes' drive in, 60 on site and 12 out need 82 minutes; the gap from 10:00 to 11:20 has 80 minutes/);
  assert.match(result.reason, /no candidate to offer/);
});

test('no candidate ever shifts a later stop: drive in, service and drive out fit inside the gap', () => {
  for (const name of NAMES) {
    const day = load(name);
    const travel = routing.travel.fromMatrix(day.matrix);
    const byId = new Map([...day.input.stops, ...day.input.cancelled, ...day.input.candidates].map((s) => [s.stopId, s]));
    for (const g of fill(day).gaps) {
      const crew = day.input.crews.find((c) => c.crewId === g.crewId);
      const fromNode = g.after ? byId.get(g.after).node : crew.baseNode;
      if (g.after) assert.equal(g.from, byId.get(g.after).start + byId.get(g.after).serviceMinutes);
      assert.equal(g.to, g.before ? byId.get(g.before).start : day.input.limits.latestFinish);
      for (const row of g.candidates) {
        const cand = byId.get(row.stopId);
        assert.equal(row.travelInMinutes, travel(fromNode, cand.node));
        assert.equal(row.travelOutMinutes, g.before ? travel(cand.node, byId.get(g.before).node) : 0);
        assert.ok(row.start >= g.from + row.travelInMinutes, `${name} ${row.stopId} starts before it can arrive`);
        assert.ok(row.start + cand.serviceMinutes + row.travelOutMinutes <= g.to, `${name} ${row.stopId} would shift the next stop`);
        assert.equal(row.start % day.input.limits.startRoundTo, 0);
      }
    }
  }
});

test('every offered slot keeps every hard rule of the candidate on the gap crew and day', () => {
  const registry = routing.rules.v1Registry();
  for (const name of NAMES) {
    const day = load(name);
    const byId = new Map(day.input.candidates.map((s) => [s.stopId, s]));
    for (const g of fill(day).gaps) {
      for (const row of g.candidates) {
        const cand = byId.get(row.stopId);
        const tally = registry.evaluate(cand, { crewId: g.crewId, start: row.start, finish: row.start + cand.serviceMinutes }, { day: day.input.day, limits: day.input.limits });
        assert.equal(tally.hardBreaks, 0, `${name} ${row.stopId}`);
        const ownSoftBreak = tally.checks.some((c) => !c.ok && cand.rules.some((r) => r.ruleId === c.ruleId));
        assert.equal(row.windowFit, !ownSoftBreak, `${name} ${row.stopId} windowFit`);
      }
    }
  }
  const [gap] = fill(load('gap')).gaps;
  assert.equal(gap.candidates.find((r) => r.stopId === 'c12').windowFit, false, 'c12 is off its soft preferred crew');
});

test('gap-adjacent: two adjacent cancellations form one gap', () => {
  const result = fill(load('gap-adjacent'));
  assert.equal(result.gaps.length, 1);
  const [gap] = result.gaps;
  assert.deepEqual(gap.cancelled, ['z1', 'z2']);
  assert.equal(gap.gapId, 'z1');
  assert.deepEqual([gap.after, gap.before, gap.from, gap.to], ['s1', 's2', 540, 780]);
  assert.deepEqual(idsOf(gap), ['q1'], 'the two-hour visit fits only the merged gap');
  assert.match(reasonFor(gap, 'q2'), /its property cancelled a visit/, 'the second cancelled property is never offered either');
  assert.match(gap.reason, /cancelled stops z1, z2/);
});

test('a gap at the start of the day runs from the crew-day start and drives in from the base', () => {
  const day = load('gap-adjacent');
  day.input.stops = day.input.stops.filter((s) => s.stopId !== 's1');
  const [gap] = fill(day).gaps;
  assert.deepEqual([gap.after, gap.before, gap.from, gap.to], [null, 's2', day.input.limits.earliestStart, 780]);
  const [row] = gap.candidates;
  assert.equal(row.stopId, 'q1');
  assert.equal(row.travelInMinutes, 12);
  assert.equal(row.extraDriveMinutes, 12 + 10 - 20);
});

test('gap-two: a candidate offered in both gaps carries alsoOfferedFor[], and exclude[] removes it', () => {
  const result = fill(load('gap-two'));
  assert.deepEqual(result.gaps.map((g) => g.gapId), ['y1', 'y2']);
  const [first, second] = result.gaps;
  assert.deepEqual([second.after, second.before, second.to], ['s2', null, 1380], 'the last gap runs to the crew day\'s latest finish');
  assert.ok(idsOf(first).includes('k1') && idsOf(second).includes('k1'));
  assert.deepEqual(first.candidates.find((r) => r.stopId === 'k1').alsoOfferedFor, ['y2']);
  assert.deepEqual(second.candidates.find((r) => r.stopId === 'k1').alsoOfferedFor, ['y1']);
  assert.deepEqual(first.candidates.find((r) => r.stopId === 'k3').alsoOfferedFor, []);
  assert.deepEqual(second.candidates.find((r) => r.stopId === 'k2').alsoOfferedFor, []);

  const without = fill(load('gap-two'), { exclude: ['k1'] });
  for (const g of without.gaps) {
    assert.ok(!idsOf(g).includes('k1'));
    assert.match(reasonFor(g, 'k1'), /left out at the caller's request/);
  }
  assert.deepEqual(idsOf(without.gaps[0]), ['k3']);
  assert.deepEqual(idsOf(without.gaps[1]), ['k2']);
});

test('returnToBase: the last gap drives out to the crew base', () => {
  const [, last] = fill(load('gap-two'), { returnToBase: true }).gaps;
  const k1 = last.candidates.find((r) => r.stopId === 'k1');
  assert.equal(k1.travelOutMinutes, 15);
  assert.equal(k1.extraDriveMinutes, 12 + 15 - 20);
});

test('ranking goes through scoring.rank() with the engine-declared spec', (t) => {
  const spy = t.mock.method(scoring, 'rank');
  const result = fill(load('gap-two'));
  assert.equal(spy.mock.callCount(), 2, 'once per gap');
  for (const call of spy.mock.calls) {
    const [rows, spec, options] = call.arguments;
    assert.equal(spec.row_id, 'stopId');
    assert.deepEqual(spec.scoring.inputs.map((i) => i.name), ['extra_drive_minutes', 'flexible', 'days_moved_up', 'window_fit']);
    assert.deepEqual(spec.scoring.inputs.map((i) => Math.sign(i.weight)), [-1, 1, -1, 1]);
    assert.deepEqual(options, { limit: 5 });
    assert.ok(rows.every((r) => typeof r.stopId === 'string'));
  }
  // The rows come back in rank()'s order, with its scores.
  const [rows, spec] = spy.mock.calls[0].arguments;
  const ranked = scoring.rank(rows, spec, { limit: 5 });
  assert.deepEqual(result.gaps[0].candidates.map((r) => [r.stopId, r.score]), ranked.map((r) => [r.row.stopId, r.score]));
});

test('a gap with no fitting candidate never calls rank()', (t) => {
  const spy = t.mock.method(scoring, 'rank');
  fill(load('gap-tight'));
  assert.equal(spy.mock.callCount(), 0);
});

test('overridden weights change the ranking; weights that fail checkScoring throw', (t) => {
  const day = load('gap');
  const flexFirst = fill(day, { weights: { extra_drive_minutes: 0, days_moved_up: 0, window_fit: 0, flexible: 1 } }).gaps[0];
  // With only flexible counting, every flexible survivor ties at 100, ties by stopId.
  assert.deepEqual(idsOf(flexFirst), ['c1', 'c12', 'c5', 'c6', 'c7']);
  assert.ok(flexFirst.candidates.every((r) => r.score === 100));

  const check = t.mock.method(scoring, 'checkScoring');
  const zero = { extra_drive_minutes: 0, flexible: 0, days_moved_up: 0, window_fit: 0 };
  assert.deepEqual(faultOf(() => fill(day, { weights: zero })), { field: 'opts.weights', problem: 'bad_weights' });
  assert.ok(check.mock.callCount() >= 1, 'checkScoring judged the weights');
  assert.deepEqual(check.mock.calls.at(-1).arguments[0].scoring.inputs.map((i) => i.weight), [0, 0, 0, 0]);

  assert.deepEqual(faultOf(() => fill(day, { weights: { speed: 1 } })), { field: 'opts.weights.speed', problem: 'unknown_weight' });
  assert.deepEqual(faultOf(() => fill(day, { weights: { 'not a name': 1 } })), { field: 'opts.weights.?', problem: 'unknown_weight' });
  assert.deepEqual(faultOf(() => fill(day, { weights: { flexible: '2' } })), { field: 'opts.weights.flexible', problem: 'bad_weights' });
  assert.deepEqual(faultOf(() => fill(day, { weights: { flexible: Number.NaN } })), { field: 'opts.weights.flexible', problem: 'bad_weights' });
  assert.deepEqual(faultOf(() => fill(day, { weights: [] })), { field: 'opts.weights', problem: 'not_object' });
});

test('limit and horizonDays: defaults 5 and 14, overridable, checked', () => {
  const day = load('gap');
  assert.equal(fill(day, { limit: 2 }).gaps[0].candidates.length, 2);
  assert.deepEqual(idsOf(fill(day, { limit: 50 }).gaps[0]), ['c1', 'c6', 'c7', 'c12', 'c5', 'c4']);
  assert.deepEqual(faultOf(() => fill(day, { limit: 0 })), { field: 'opts.limit', problem: 'out_of_range' });
  assert.deepEqual(faultOf(() => fill(day, { limit: 2.5 })), { field: 'opts.limit', problem: 'not_integer' });
  const wide = fill(day, { horizonDays: 20, limit: 50 }).gaps[0];
  assert.ok(idsOf(wide).includes('c11'), 'a 15-days-ahead visit is a candidate on a 20-day horizon');
  assert.deepEqual(faultOf(() => fill(day, { horizonDays: 0 })), { field: 'opts.horizonDays', problem: 'out_of_range' });
});

test('cadence: exactly half the cadence since the last visit is allowed; a null prevVisitDate is never too close', () => {
  const day = load('gap');
  const c3 = day.input.candidates.find((c) => c.stopId === 'c3');
  c3.prevVisitDate = '2026-10-28';
  assert.ok(idsOf(fill(day, { limit: 50 }).gaps[0]).includes('c3'), '7 days on a 14-day cadence');
  c3.prevVisitDate = '2026-10-29';
  assert.ok(!idsOf(fill(day, { limit: 50 }).gaps[0]).includes('c3'), '6 days on a 14-day cadence');
  c3.prevVisitDate = null;
  assert.ok(idsOf(fill(day, { limit: 50 }).gaps[0]).includes('c3'));
});

test('a locked candidate, or one not planned after the gap date, is not moved up', () => {
  const day = load('gap');
  const c1 = day.input.candidates.find((c) => c.stopId === 'c1');
  c1.locked = true;
  c1.start = 600;
  assert.match(reasonFor(fill(day).gaps[0], 'c1'), /locked to its booked day/);
  const early = load('gap');
  early.input.candidates.find((c) => c.stopId === 'c1').plannedDate = '2026-11-04';
  assert.match(reasonFor(fill(early).gaps[0], 'c1'), /planned for 2026-11-04, not after 2026-11-04/);
});

test('a gap on a crew that is out offers nothing and says why', () => {
  const day = load('gap');
  day.input.crews.find((c) => c.crewId === 'g1').available = false;
  const [gap] = fill(day).gaps;
  assert.deepEqual(gap.candidates, []);
  assert.match(gap.reason, /crew g1 is not working today/);
});

test('no cancellation: no gap, with a reason', () => {
  const day = load('gap');
  day.input.cancelled = [];
  const result = fill(day);
  assert.deepEqual(result.gaps, []);
  assert.match(result.reason, /no gap to fill/);
});

test('bad input and options throw RoutingFault naming the field', () => {
  const day = load('gap');
  const travel = routing.travel.fromMatrix(day.matrix);
  const run = (input, opts = {}) => () => routing.fillGap(input, { travel, ...opts });
  assert.deepEqual(faultOf(() => routing.fillGap(day.input, {})), { field: 'opts.travel', problem: 'not_function' });
  const { cancelled, ...noCancelled } = day.input;
  assert.equal(cancelled.length, 1);
  assert.deepEqual(faultOf(run(noCancelled)), { field: 'cancelled', problem: 'missing' });
  const bad = (edit) => {
    const input = clone(day.input);
    edit(input);
    return faultOf(run(input));
  };
  assert.deepEqual(bad((i) => { i.cancelled = {}; }), { field: 'cancelled', problem: 'not_list' });
  assert.deepEqual(bad((i) => { i.cancelled[0].currentCrewId = 'zz'; }), { field: 'cancelled[0].currentCrewId', problem: 'unknown_crew' });
  assert.deepEqual(bad((i) => { i.cancelled[0].stopId = 'a1'; }), { field: 'cancelled[0].stopId', problem: 'duplicate' });
  assert.deepEqual(bad((i) => { i.cancelled[0].node = '1 Main St'; }), { field: 'cancelled[0].node', problem: 'bad_node' });
  assert.deepEqual(bad((i) => { delete i.cancelled[0].start; }), { field: 'cancelled[0].start', problem: 'missing' });
  assert.deepEqual(bad((i) => { i.cancelled[0].serviceMinutes = -1; }), { field: 'cancelled[0].serviceMinutes', problem: 'out_of_range' });
  assert.deepEqual(bad((i) => { delete i.stops[1].start; }), { field: 'stops[1].start', problem: 'missing' });
  assert.deepEqual(bad((i) => { i.candidates[0].rules = [{ ruleId: 'no-such-rule', value: 1 }]; }), { field: 'candidates[0].rules[0].ruleId', problem: 'unknown_rule' });
  assert.deepEqual(faultOf(run(day.input, { exclude: 'c1' })), { field: 'opts.exclude', problem: 'not_list' });
  assert.deepEqual(faultOf(run(day.input, { exclude: ['c 1'] })), { field: 'opts.exclude[0]', problem: 'bad_id' });
  // A drive the matrix lacks is a fault, never 0.
  const short = clone(day);
  short.matrix = short.matrix.filter((r) => !(r.from_node === 'property:a2' && r.to_node === 'property:c1'));
  assert.equal(faultOf(() => fill(short)).problem, 'no_travel');
});

test('dayNumber counts days by arithmetic alone', () => {
  assert.equal(dayNumber('1970-01-01'), 0);
  assert.equal(dayNumber('2000-03-01') - dayNumber('2000-02-28'), 2, 'a leap day');
  assert.equal(dayNumber('2100-03-01') - dayNumber('2100-02-28'), 1, 'no leap day');
  assert.equal(dayNumber('2026-11-04') - dayNumber('2026-10-24'), 11);
  assert.equal(dayNumber('2027-01-01') - dayNumber('2026-12-31'), 1);
});

test('output holds ids, dates, minutes and rule words only, never a place', () => {
  const keys = new Set();
  const walkKeys = (v) => {
    if (Array.isArray(v)) v.forEach(walkKeys);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walkKeys(x); }
  };
  for (const name of NAMES) {
    const result = fill(load(name));
    assert.doesNotMatch(JSON.stringify(result), /\b(property|crew):[A-Za-z0-9_-]/, 'no node id, which an adapter may derive from a place');
    for (const g of result.gaps) for (const row of [...g.candidates, ...g.excluded]) assert.ok(typeof row.reason === 'string' && row.reason.length > 0);
    walkKeys(result);
  }
  assert.deepEqual([...keys].sort(), [
    'after', 'alsoOfferedFor', 'before', 'cancelled', 'candidates', 'considered', 'crewId', 'day', 'daysMovedUp', 'excluded',
    'extraDriveMinutes', 'flexible', 'from', 'fromCrew', 'gapId', 'gaps', 'minutes', 'plannedDate', 'rank', 'reason', 'score',
    'start', 'stopId', 'to', 'travelInMinutes', 'travelOutMinutes', 'valid', 'windowFit',
  ]);
});

test('fillGap never changes its input, and the same input gives byte-identical JSON', () => {
  for (const name of NAMES) {
    const day = load(name);
    const before = JSON.stringify(day);
    const a = JSON.stringify(fill(day));
    const b = JSON.stringify(fill(day));
    assert.equal(a, b, name);
    assert.equal(JSON.stringify(day), before, `${name} input unchanged`);
  }
});

// Wall-clock minutes and ISO strings only: the same day gives the same answer
// whatever the machine's time zone, across the 2026-11-01 DST change.
test('fillGap output is identical under two TZ values across 2026-11-01', () => {
  const script = `
    const fs = require('node:fs');
    const routing = require(${JSON.stringify(path.resolve(__dirname, '../../kit/runtime/routing'))});
    const out = process.argv.slice(1).map((file) => {
      const day = JSON.parse(fs.readFileSync(file, 'utf8'));
      day.input.day = '2026-11-01';
      return routing.fillGap(day.input, { travel: routing.travel.fromMatrix(day.matrix) });
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const files = NAMES.map((n) => path.join(DIR, `${n}.json`));
  const outputs = ['America/New_York', 'Pacific/Auckland'].map((TZ) => {
    const r = spawnSync(process.execPath, ['-e', script, ...files], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  assert.equal(outputs[0], outputs[1]);
  const here = NAMES.map((n) => {
    const day = load(n);
    day.input.day = '2026-11-01';
    return fill(day);
  });
  assert.equal(outputs[0], JSON.stringify(here));
});
