'use strict';

// The rule registry and the v1 rules (Story 12.2, AD-R4). Slots are synthetic
// and come from test/fixtures/routing/*.json only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const routing = require('../../kit/runtime/routing');
const { RoutingFault, ROUTING_PROBLEMS } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');

const FIXTURE = path.join(__dirname, '../fixtures/routing/rules-v1.json');
const RULES = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const DAY = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/routing/day-small.json'), 'utf8'));
const { createRegistry, v1Registry, V1_RULES, isoWeekday } = routing.rules;

function faultOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RoutingFault, `expected a RoutingFault, got ${err && err.name}: ${err && err.message}`);
    return err.details;
  }
  return assert.fail('expected a RoutingFault');
}

const ctxFor = (c) => ({ day: c.day || RULES.ctx.day, limits: RULES.ctx.limits });
const checkOf = (c, registry = v1Registry()) => registry.evaluate(c.stop, c.slot, ctxFor(c)).checks.find((x) => x.ruleId === c.ruleId);

// A minimal valid rule for registration tests.
const rule = (over = {}) => ({ id: 'fixture-rule', label: 'fixture rule', defaultStrength: 'soft', weight: 5, check: () => ({ ok: true, reason: 'fine' }), ...over });

test('the v1 rules are the five named in AD-R4, with their defaults', () => {
  const r = v1Registry();
  assert.deepEqual(r.list().map((x) => [x.id, x.defaultStrength, x.weight, x.overridable, x.everyStop, x.position]), [
    ['crew-day-limits', 'hard', null, false, true, 'softPenalty'],
    ['day-of-week', 'hard', 100, true, false, 'softPenalty'],
    ['time-of-day', 'hard', 100, true, false, 'softPenalty'],
    ['preferred-crew', 'soft', 100, true, false, 'softPenalty'],
    ['aim-finish', 'soft', 1, true, true, 'aimFinishMinutes'],
  ]);
  assert.equal(V1_RULES.length, 5);
});

// One passing and one failing slot per v1 rule (plus a second failing slot
// for crew-day-limits' other bound). ok matches and the reason is exact.
for (const c of RULES.cases) {
  test(`${c.ruleId}: ${c.name}`, () => {
    const check = checkOf(c);
    assert.ok(check, `${c.ruleId} applied`);
    assert.equal(check.ok, c.ok);
    assert.equal(check.reason, c.reason);
    assert.doesNotMatch(check.reason, /[{}[\]]|undefined|NaN|null/, 'plain words');
  });
}

test('every v1 rule has a passing and a failing case in the fixture', () => {
  for (const r of V1_RULES) {
    const cases = RULES.cases.filter((c) => c.ruleId === r.id);
    assert.ok(cases.some((c) => c.ok), `${r.id} passing`);
    assert.ok(cases.some((c) => !c.ok), `${r.id} failing`);
  }
});

test('a broken hard rule counts once in hardBreaks; a broken soft rule adds weight to its own position', () => {
  const r = v1Registry();
  const ctx = { day: '2026-11-03', limits: RULES.ctx.limits };
  const stop = { stopId: 's9', rules: [{ ruleId: 'day-of-week', value: [1] }, { ruleId: 'preferred-crew', value: 'c1' }] };
  const t = r.evaluate(stop, { crewId: 'c2', start: 1030, finish: 1120 }, ctx);
  assert.equal(t.hardBreaks, 1);
  assert.equal(t.softPenalty, 100, 'preferred-crew only, never aim-finish');
  assert.equal(t.aimFinishMinutes, 40, 'aim-finish in its own position');
  assert.deepEqual(t.checks.map((x) => [x.ruleId, x.strength, x.ok, x.penalty]), [
    ['crew-day-limits', 'hard', true, 0],
    ['day-of-week', 'hard', false, 0],
    ['preferred-crew', 'soft', false, 100],
    ['aim-finish', 'soft', false, 40],
  ]);
});

test('a rule without an instance on the stop is not checked, unless it applies to every stop', () => {
  const t = v1Registry().evaluate({ stopId: 's1', rules: [] }, { crewId: 'c1', start: 480, finish: 540 }, { day: RULES.ctx.day, limits: RULES.ctx.limits });
  assert.deepEqual(t.checks.map((x) => x.ruleId), ['crew-day-limits', 'aim-finish']);
  assert.deepEqual([t.hardBreaks, t.softPenalty, t.aimFinishMinutes], [0, 0, 0]);
});

test('day-of-week with strength soft is soft; with no strength it is hard', () => {
  const r = v1Registry();
  const slot = { crewId: 'c1', start: 480, finish: 540 };
  const ctx = { day: '2026-11-03', limits: RULES.ctx.limits };
  const soft = r.evaluate({ stopId: 'a', rules: [{ ruleId: 'day-of-week', value: [1], strength: 'soft' }] }, slot, ctx);
  const hard = r.evaluate({ stopId: 'b', rules: [{ ruleId: 'day-of-week', value: [1] }] }, slot, ctx);
  const dow = (t) => t.checks.find((x) => x.ruleId === 'day-of-week');
  assert.deepEqual([dow(soft).strength, soft.hardBreaks, soft.softPenalty], ['soft', 0, 100]);
  assert.deepEqual([dow(hard).strength, hard.hardBreaks, hard.softPenalty], ['hard', 1, 0]);
  const pref = r.evaluate({ stopId: 'c', rules: [{ ruleId: 'preferred-crew', value: 'c2', strength: 'hard' }] }, slot, ctx);
  assert.deepEqual([pref.hardBreaks, pref.softPenalty], [1, 0], 'a soft rule may be made hard');
});

test('crew-day-limits refuses a soft override (and accepts a restated hard)', () => {
  const r = v1Registry();
  const slot = { crewId: 'c1', start: 480, finish: 540 };
  const ctx = { day: RULES.ctx.day, limits: RULES.ctx.limits };
  const soft = { stopId: 'a', rules: [{ ruleId: 'crew-day-limits', value: null, strength: 'soft' }] };
  assert.deepEqual(faultOf(() => r.evaluate(soft, slot, ctx, 'stops[4]')), { field: 'stops[4].rules[0].strength', problem: 'not_overridable' });
  assert.deepEqual(faultOf(() => r.resolve(soft)), { field: 'stop.rules[0].strength', problem: 'not_overridable' });
  const hard = { stopId: 'a', rules: [{ ruleId: 'crew-day-limits', value: null, strength: 'hard' }] };
  assert.equal(r.evaluate(hard, slot, ctx).checks[0].strength, 'hard');
});

test('register throws RoutingFault on a malformed rule', () => {
  const cases = [
    [rule({ check: undefined }), 'rule[fixture-rule].check', 'missing'],
    [rule({ check: 'ok' }), 'rule[fixture-rule].check', 'not_function'],
    [rule({ defaultStrength: 'firm' }), 'rule[fixture-rule].defaultStrength', 'bad_strength'],
    [rule({ defaultStrength: undefined }), 'rule[fixture-rule].defaultStrength', 'missing'],
    [rule({ weight: 0 }), 'rule[fixture-rule].weight', 'out_of_range'],
    [rule({ weight: -3 }), 'rule[fixture-rule].weight', 'out_of_range'],
    [rule({ weight: 1.5 }), 'rule[fixture-rule].weight', 'not_integer'],
    [rule({ weight: undefined }), 'rule[fixture-rule].weight', 'missing'],
    [rule({ defaultStrength: 'hard', weight: 0 }), 'rule[fixture-rule].weight', 'out_of_range'],
    [rule({ defaultStrength: 'hard', overridable: false }), 'rule[fixture-rule].weight', 'out_of_range'],
    [rule({ overridable: false }), 'rule[fixture-rule].overridable', 'not_overridable'],
    [rule({ overridable: 'no' }), 'rule[fixture-rule].overridable', 'not_true_false'],
    [rule({ everyStop: 1 }), 'rule[fixture-rule].everyStop', 'not_true_false'],
    [rule({ position: 'driveMinutes' }), 'rule[fixture-rule].position', 'out_of_range'],
    [rule({ checkValue: 'x' }), 'rule[fixture-rule].checkValue', 'not_function'],
    [rule({ label: '' }), 'rule[fixture-rule].label', 'not_text'],
    [rule({ label: undefined }), 'rule[fixture-rule].label', 'missing'],
    [rule({ id: 'Fixture Rule' }), 'rule.id', 'bad_id'],
    [rule({ id: 7 }), 'rule.id', 'not_text'],
    [rule({ id: undefined }), 'rule.id', 'missing'],
    [null, 'rule', 'not_object'],
  ];
  for (const [bad, field, problem] of cases) {
    assert.deepEqual(faultOf(() => createRegistry().register(bad)), { field, problem }, `${field} ${problem}`);
  }
});

test('register refuses a duplicate id, including a v1 id, and keeps the first', () => {
  const r = createRegistry().register(rule());
  assert.deepEqual(faultOf(() => r.register(rule({ label: 'other' }))), { field: 'rule[fixture-rule].id', problem: 'duplicate' });
  assert.equal(r.get('fixture-rule').label, 'fixture rule');
  assert.deepEqual(faultOf(() => v1Registry().register(rule({ id: 'preferred-crew' }))), { field: 'rule[preferred-crew].id', problem: 'duplicate' });
});

test('a registered rule is a frozen copy: changing the original afterwards changes nothing', () => {
  const original = rule();
  const r = createRegistry().register(original);
  original.weight = 999;
  original.check = () => ({ ok: false, reason: 'changed' });
  assert.equal(r.get('fixture-rule').weight, 5);
  assert.ok(Object.isFrozen(r.get('fixture-rule')));
  assert.ok(Object.isFrozen(r.list()));
  const t = r.evaluate({ stopId: 'a', rules: [{ ruleId: 'fixture-rule', value: 1 }] }, { crewId: 'c1', start: 480, finish: 540 }, { day: RULES.ctx.day, limits: RULES.ctx.limits });
  assert.equal(t.checks[0].ok, true);
});

test('a fork registers its own rule on top of the v1 rules, with no engine edit', () => {
  const r = v1Registry().register(rule({
    id: 'no-early-start',
    label: 'no early start',
    weight: 7,
    checkValue: (v) => (Number.isSafeInteger(v) ? null : 'not_integer'),
    check: (stop, slot, { value }) => (slot.start >= value ? { ok: true, reason: 'late enough' } : { ok: false, reason: `starts ${value - slot.start} minutes early`, amount: 2 }),
  }));
  const t = r.evaluate({ stopId: 'a', rules: [{ ruleId: 'no-early-start', value: 540 }] }, { crewId: 'c1', start: 480, finish: 540 }, { day: RULES.ctx.day, limits: RULES.ctx.limits });
  assert.equal(t.softPenalty, 14);
  assert.equal(t.checks.at(-1).reason, 'starts 60 minutes early');
  assert.deepEqual(faultOf(() => r.resolve({ stopId: 'a', rules: [{ ruleId: 'no-early-start', value: 'nine' }] })), { field: 'stop.rules[0].value', problem: 'not_integer' });
});

test('a stop naming an unregistered rule, or a bad strength, is refused, never ignored', () => {
  const r = v1Registry();
  assert.deepEqual(faultOf(() => r.resolve({ stopId: 'a', rules: [{ ruleId: 'no-pets', value: true }] }, 'stops[2]')), { field: 'stops[2].rules[0].ruleId', problem: 'unknown_rule' });
  assert.deepEqual(faultOf(() => r.resolve({ stopId: 'a', rules: [{ ruleId: 'day-of-week', value: [1], strength: 'firm' }] })), { field: 'stop.rules[0].strength', problem: 'bad_strength' });
});

test('each v1 rule checks its own instance value', () => {
  const r = v1Registry();
  const cases = [
    ['day-of-week', 3, 'not_list'],
    ['day-of-week', [], 'out_of_range'],
    ['day-of-week', [0], 'out_of_range'],
    ['day-of-week', [8], 'out_of_range'],
    ['day-of-week', [1.5], 'not_integer'],
    ['day-of-week', [2, 2], 'duplicate'],
    ['time-of-day', 'morning', 'not_object'],
    ['time-of-day', { startFrom: 480 }, 'missing'],
    ['time-of-day', { startFrom: 480, startBefore: '720' }, 'not_integer'],
    ['time-of-day', { startFrom: 480, startBefore: 1500 }, 'out_of_range'],
    ['time-of-day', { startFrom: 720, startBefore: 480 }, 'out_of_range'],
    ['time-of-day', { startFrom: 480, startBefore: 480 }, 'out_of_range'],
    ['preferred-crew', 5, 'not_text'],
    ['preferred-crew', 'crew 1', 'bad_id'],
  ];
  for (const [ruleId, value, problem] of cases) {
    assert.deepEqual(faultOf(() => r.resolve({ stopId: 'a', rules: [{ ruleId, value }] })), { field: 'stop.rules[0].value', problem }, `${ruleId} ${JSON.stringify(value)}`);
  }
});

test('a check that returns a malformed result is refused', () => {
  const ctx = { day: RULES.ctx.day, limits: RULES.ctx.limits };
  const slot = { crewId: 'c1', start: 480, finish: 540 };
  const stop = { stopId: 'a', rules: [{ ruleId: 'fixture-rule', value: 1 }] };
  const evalWith = (check) => createRegistry().register(rule({ check })).evaluate(stop, slot, ctx);
  assert.deepEqual(faultOf(() => evalWith(() => true)), { field: 'rule[fixture-rule].check', problem: 'not_object' });
  assert.deepEqual(faultOf(() => evalWith(() => ({ ok: false }))), { field: 'rule[fixture-rule].check.reason', problem: 'not_text' });
  assert.deepEqual(faultOf(() => evalWith(() => ({ ok: false, reason: 'x', amount: -1 }))), { field: 'rule[fixture-rule].check.amount', problem: 'out_of_range' });
});

test('the day-small fixture resolves against the v1 rules (12.1 and 12.2 agree on rule instances)', () => {
  const r = v1Registry();
  const input = routing.validateInput(DAY.input);
  input.stops.forEach((stop, i) => assert.ok(r.resolve(stop, `stops[${i}]`).length >= 2));
  const v103 = r.resolve(input.stops[2]).find((x) => x.rule.id === 'day-of-week');
  assert.equal(v103.strength, 'soft');
});

test('isoWeekday matches the calendar for every day of 2024 to 2028 (Mon 1, Sun 7)', () => {
  for (let t = Date.UTC(2024, 0, 1); t <= Date.UTC(2028, 11, 31); t += 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const expected = new Date(t).getUTCDay() || 7;
    assert.equal(isoWeekday(iso), expected, iso);
  }
  assert.deepEqual(faultOf(() => isoWeekday('11/02/2026')), { field: 'day', problem: 'bad_date' });
});

test('the new problems have plain words that name the field', () => {
  for (const problem of ['unknown_rule', 'not_overridable', 'not_function']) {
    assert.ok(ROUTING_PROBLEMS.includes(problem));
    const words = messageFor(new RoutingFault({ field: 'stops[1].rules[0].ruleId', problem }), { admin: 'Sam' });
    assert.match(words, /stops\[1\]\.rules\[0\]\.ruleId/);
    assert.match(words, /please tell Sam/);
  }
});

// Wall-clock minutes and ISO dates only: the rule results are identical
// whatever the machine's time zone, across the 2026-11-01 DST change.
test('rule results are identical under two TZ values across 2026-11-01', () => {
  const script = `
    const fs = require('node:fs');
    const routing = require(${JSON.stringify(path.resolve(__dirname, '../../kit/runtime/routing'))});
    const f = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const r = routing.rules.v1Registry();
    const days = ['2026-10-31', '2026-11-01', '2026-11-02'];
    const out = days.flatMap((day) => f.cases.map((c) => r.evaluate(c.stop, c.slot, { day, limits: f.ctx.limits })));
    process.stdout.write(JSON.stringify(out));
  `;
  const outputs = ['America/New_York', 'Pacific/Auckland'].map((TZ) => {
    const res = spawnSync(process.execPath, ['-e', script, FIXTURE], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  });
  assert.equal(outputs[0], outputs[1]);
  assert.ok(outputs[0].includes("Sunday is one of the customer's days"), '2026-11-01 is a Sunday in both zones');
  assert.ok(outputs[0].includes('not Saturday'), '2026-10-31 is a Saturday in both zones');
});
