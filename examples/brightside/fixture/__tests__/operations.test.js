'use strict';

// Brightside's operations data (lib/operations.js): staff, pay_rates and
// timesheets, home details appended to properties, the schedule appended to
// visits and staff_id appended to crew_memberships. Example tests (AD-1
// carve-out): they read Brightside's own fixture and go with it in a fork.
//
// The hard invariant: the operations build draws from its own stream, so every
// column that existed before it keeps its values. Figures here are computed
// from the committed CSVs with code of their own, never the generator's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generate, readSeedConfig } = require('../generate');
const { TABLES } = require('../lib/tables');
const { createRng, deriveSeed } = require('../lib/prng');
const { buildReference, ZONES, HISTORY_START, AS_OF } = require('../lib/reference');
const { buildActivity } = require('../lib/activity');
const { checkRules } = require('../lib/rules');
const { checkOperations } = require('../lib/operations-rules');
const { OPERATIONS_STREAM } = require('../lib/operations');

const FIXTURE_DIR = path.join(__dirname, '..');
const SEEDS = path.join(FIXTURE_DIR, 'seeds');
const SMALL = { seed: 7, clients: 60 };
const ruleOpts = { zones: ZONES, historyStart: HISTORY_START, asOf: AS_OF };
const NEW_TABLES = ['staff', 'pay_rates', 'timesheets'];

// Committed CSVs, typed from lib/tables.js (they never quote: a plain split is a full parse).
function loadCommitted() {
  const tables = {};
  for (const table of TABLES) {
    const lines = fs.readFileSync(path.join(SEEDS, `${table.name}.csv`), 'utf8').slice(0, -1).split('\n');
    const header = lines[0].split(',');
    const numeric = new Set(table.columns.filter((c) => c.type === 'INTEGER' || c.type === 'BIGINT').map((c) => c.name));
    tables[table.name] = lines.slice(1).map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(header.map((h, i) => [h, cells[i] === '' ? null : numeric.has(h) ? Number(cells[i]) : cells[i]]));
    });
  }
  return tables;
}
let cache;
const committed = () => (cache ??= loadCommitted());

// The tables as the main stream alone makes them: reference, then activity.
function mainStreamOnly(config) {
  const rng = createRng(config.seed);
  const tables = buildReference(rng, { clients: config.clients });
  Object.assign(tables, buildActivity(rng, tables, { asOf: AS_OF, targets: config.targets || null }));
  return tables;
}

const project = (rows, like) => rows.map((r) => Object.fromEntries(Object.keys(like[0]).map((k) => [k, r[k]])));

test('the operations build moves no existing value: every earlier column is the main stream\'s alone', () => {
  for (const config of [SMALL, readSeedConfig()]) {
    const before = mainStreamOnly(config);
    const { tables } = generate(config);
    for (const name of Object.keys(before)) {
      assert.equal(tables[name].length, before[name].length, `${config.seed} ${name}: row count`);
      assert.deepEqual(project(tables[name], before[name]), before[name], `${config.seed} ${name}`);
    }
  }
});

test('appended columns come last: each extended table starts with its original columns, in order', () => {
  const before = mainStreamOnly(SMALL);
  for (const name of ['crew_memberships', 'properties', 'visits']) {
    const cols = TABLES.find((t) => t.name === name).columns.map((c) => c.name);
    const original = Object.keys(before[name][0]);
    assert.deepEqual(cols.slice(0, original.length), original, name);
    assert.ok(cols.length > original.length, `${name} gains columns`);
  }
});

test('the operations stream is its own: seeded from the fixture seed and a label', () => {
  assert.equal(deriveSeed(20241001, OPERATIONS_STREAM), deriveSeed(20241001, OPERATIONS_STREAM));
  assert.notEqual(deriveSeed(20241001, OPERATIONS_STREAM), deriveSeed(20241002, OPERATIONS_STREAM));
  assert.notEqual(deriveSeed(20241001, OPERATIONS_STREAM), deriveSeed(20241001, 'another/stream'));
  assert.notEqual(deriveSeed(20241001, OPERATIONS_STREAM), 20241001);
  const a = createRng(deriveSeed(7, OPERATIONS_STREAM));
  const b = createRng(7);
  assert.notDeepEqual([a.u32(), a.u32(), a.u32()], [b.u32(), b.u32(), b.u32()]);
  for (const bad of [-1, 1.5, 2 ** 32]) assert.throws(() => deriveSeed(bad, 'x'), TypeError);
  assert.throws(() => deriveSeed(1, ''), TypeError);
});

test('a small seed is deterministic and passes every operations rule', () => {
  const a = generate(SMALL);
  for (const name of [...NEW_TABLES, 'properties', 'visits', 'crew_memberships']) {
    assert.equal(a.files.get(`seeds/${name}.csv`), generate(SMALL).files.get(`seeds/${name}.csv`), name);
  }
  assert.deepEqual(checkOperations(a.tables, ruleOpts), []);
  assert.notEqual(generate({ ...SMALL, seed: 8 }).files.get('seeds/timesheets.csv'), a.files.get('seeds/timesheets.csv'));
});

test('every rule holds in the committed files', () => {
  const t = committed();
  assert.deepEqual(checkRules(t, ruleOpts), []);
  assert.deepEqual(checkOperations(t, ruleOpts), []);
});

test('staff are the crew_memberships names, one crew lead per crew, rates in realistic US ranges', () => {
  const t = committed();
  assert.deepEqual(t.staff.map((s) => s.name).sort(), [...new Set(t.crew_memberships.map((m) => m.staff_name))].sort());
  const nameOf = new Map(t.staff.map((s) => [s.staff_id, s.name]));
  for (const m of t.crew_memberships) assert.equal(nameOf.get(m.staff_id), m.staff_name, `membership ${m.membership_id}`);
  const current = t.staff.filter((s) => s.end_date === null);
  assert.equal(current.filter((s) => s.role === 'crew_lead').length, t.crews.length, 'one current lead per crew');
  for (const s of current) {
    const [lo, hi] = s.role === 'crew_lead' ? [2200, 3000] : [1700, 2400];
    assert.ok(s.hourly_rate_cents >= lo && s.hourly_rate_cents <= hi && s.hourly_rate_cents % 25 === 0, `staff ${s.staff_id}`);
  }
  // Raises over time: most people with a long history have had one.
  const periods = new Map();
  for (const r of t.pay_rates) periods.set(r.staff_id, (periods.get(r.staff_id) || 0) + 1);
  const longServing = t.staff.filter((s) => s.hire_date < '2024-01-01');
  assert.ok(longServing.filter((s) => periods.get(s.staff_id) > 1).length > longServing.length * 0.8, 'raises');
  assert.ok(t.pay_rates.some((r, i, all) => i > 0 && all[i - 1].staff_id === r.staff_id && all[i - 1].role !== r.role), 'some role changes');
});

test('home details are correlated: bigger homes have more rooms', () => {
  const t = committed();
  const homes = t.properties.slice().sort((a, b) => a.square_feet - b.square_feet);
  const quarter = Math.floor(homes.length / 4);
  const avg = (rows, f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const small = homes.slice(0, quarter);
  const big = homes.slice(-quarter);
  assert.ok(avg(big, (p) => p.bedrooms) > avg(small, (p) => p.bedrooms) + 1, 'bedrooms rise with size');
  assert.ok(avg(big, (p) => Number(p.bathrooms)) > avg(small, (p) => Number(p.bathrooms)) + 0.5, 'bathrooms rise with size');
  for (const type of ['house', 'townhouse', 'condo', 'apartment']) assert.ok(homes.some((p) => p.home_type === type), type);
  assert.ok(homes.some((p) => p.bathrooms.endsWith('.5')), 'half bathrooms');
  assert.ok(avg(homes.filter((p) => p.home_type === 'house'), (p) => p.square_feet) > avg(homes.filter((p) => p.home_type === 'apartment'), (p) => p.square_feet));
  // Access is a method, never a code.
  for (const p of homes) assert.match(p.access_method, /^(key|lockbox|client_home|door_code_on_file)$/);
});

// Labour cost per visit: SUM(minutes / 60 * the rate on the visit date).
function labourByVisit(t) {
  const periods = new Map();
  for (const r of t.pay_rates) periods.set(r.staff_id, [...(periods.get(r.staff_id) || []), r]);
  const visitDate = new Map(t.visits.map((v) => [v.visit_id, v.visit_date]));
  const cost = new Map();
  for (const s of t.timesheets) {
    const d = visitDate.get(s.visit_id);
    const rate = periods.get(s.staff_id).find((r) => r.start_date <= d && (r.end_date === null || r.end_date >= d)).hourly_rate_cents;
    cost.set(s.visit_id, (cost.get(s.visit_id) || 0) + (s.minutes / 60) * rate);
  }
  return cost;
}

test('margins are plausible: labour is 40-55% of revenue at the median, and it varies by job', () => {
  const t = committed();
  const cost = labourByVisit(t);
  const shares = t.invoices.map((i) => cost.get(i.visit_id) / i.total_cents).sort((a, b) => a - b);
  const median = shares[Math.floor(shares.length / 2)];
  assert.ok(median > 0.4 && median < 0.55, `median labour share ${median}`);
  assert.ok(shares[Math.floor(shares.length * 0.9)] > median + 0.08, 'some jobs are priced thin');
  assert.ok(shares[Math.floor(shares.length * 0.1)] < median - 0.08, 'some jobs are priced rich');
});

test('timesheets: every member on every completed visit, none on a cancelled one, actuals around the schedule', () => {
  const t = committed();
  const sheets = new Map();
  for (const s of t.timesheets) sheets.set(s.visit_id, (sheets.get(s.visit_id) || 0) + 1);
  const completed = t.visits.filter((v) => v.status === 'completed');
  const cancelled = t.visits.filter((v) => v.status === 'cancelled');
  assert.ok(cancelled.length > 1000);
  for (const v of cancelled) {
    assert.ok(!sheets.has(v.visit_id), `cancelled visit ${v.visit_id} has a timesheet`);
    assert.ok(v.scheduled_start && v.route_order >= 1, `cancelled visit ${v.visit_id} keeps its schedule`);
  }
  // Crews always have three members, and all three work each completed visit.
  for (const v of completed) assert.equal(sheets.get(v.visit_id), 3, `visit ${v.visit_id}`);
  const scheduled = new Map(t.visits.map((v) => [v.visit_id, v.scheduled_minutes]));
  const over = t.timesheets.filter((s) => s.minutes > scheduled.get(s.visit_id) * 1.15).length;
  const under = t.timesheets.filter((s) => s.minutes < scheduled.get(s.visit_id) * 0.95).length;
  assert.ok(over > t.timesheets.length * 0.1 && over < t.timesheets.length * 0.5, `overruns ${over}`);
  assert.ok(under > t.timesheets.length * 0.05, `early finishes ${under}`);
});

test('the schedule is honest: heavy crew-days run long, and nobody works through the night', () => {
  const t = committed();
  const visitOf = new Map(t.visits.map((v) => [v.visit_id, v]));
  const minute = (ts) => Date.parse(`${ts.replace(' ', 'T')}Z`) / 60000;
  const days = new Map();
  for (const s of t.timesheets) {
    const v = visitOf.get(s.visit_id);
    const key = `${v.crew_id}|${v.visit_date}`;
    const d = days.get(key) || { first: Infinity, last: -Infinity };
    d.first = Math.min(d.first, minute(s.clock_in));
    d.last = Math.max(d.last, minute(s.clock_out));
    days.set(key, d);
  }
  const spans = [...days.values()].map((d) => d.last - d.first);
  const over10h = spans.filter((m) => m > 600).length;
  assert.ok(over10h > 100 && over10h < spans.length * 0.2, `${over10h} crew-days over 10 hours`);
  assert.ok(Math.max(...spans) < 20 * 60, 'no crew-day is 20 hours or more');
  // Morning and afternoon windows both occur; travel is zone-realistic.
  assert.ok(t.visits.some((v) => v.arrival_window === 'morning') && t.visits.some((v) => v.arrival_window === 'afternoon'));
  for (const v of t.visits) assert.ok(v.travel_minutes_from_previous >= 5 && v.travel_minutes_from_previous <= 35);
});

test('the operations rule check catches each broken rule once', () => {
  const { tables } = generate(SMALL);
  const broken = (mutate) => {
    const copy = JSON.parse(JSON.stringify(tables));
    mutate(copy);
    return checkOperations(copy, ruleOpts);
  };
  const completedSheet = (t) => t.timesheets[0];
  const cases = [
    [(t) => { t.crew_memberships[0].staff_name = 'Somebody Else'; }, /is not staff \d+'s name/],
    [(t) => {
      const multi = t.pay_rates.find((r, i, all) => all[i + 1] && all[i + 1].staff_id === r.staff_id && r.role === 'cleaner');
      multi.hourly_rate_cents = 1500;
    }, /outside cleaner bounds/],
    [(t) => { t.properties[0].square_feet = 7000; }, /square_feet 7000 is outside/],
    [(t) => { t.properties[0].access_method = '4321'; }, /access_method 4321 is not one of/],
    [(t) => {
      const day = t.visits.filter((v) => v.crew_id === t.visits[0].crew_id && v.visit_date === t.visits[0].visit_date);
      day.find((v) => v.route_order === day.length).route_order = day.length + 3;
    }, /route_order is not 1 to/],
    [(t) => { t.visits[0].arrival_window = t.visits[0].arrival_window === 'morning' ? 'afternoon' : 'morning'; }, /arrival_window .* disagrees/],
    [(t) => { const s = completedSheet(t); s.clock_out = s.clock_in; s.minutes = 0; }, /clock_out is not after clock_in/],
    [(t) => { const s = completedSheet(t); s.minutes += 1; }, /minutes \d+ is not clock_out - clock_in/],
    [(t) => {
      // Someone not on the visit's crew that day, with no other timesheet then.
      const s = completedSheet(t);
      const v = t.visits.find((x) => x.visit_id === s.visit_id);
      const elsewhere = t.staff.find((st) => !t.crew_memberships.some((m) => m.staff_id === st.staff_id && m.crew_id === v.crew_id)
        && !t.timesheets.some((o) => o.staff_id === st.staff_id && o.clock_in.slice(0, 10) === v.visit_date));
      s.staff_id = elsewhere.staff_id;
    }, /is not on crew \d+ on/],
    [(t) => {
      // Two timesheets of one person on one day, the second pulled back into the first.
      const byStaffDay = new Map();
      for (const s of t.timesheets) {
        const k = `${s.staff_id}|${s.clock_in.slice(0, 10)}`;
        byStaffDay.set(k, [...(byStaffDay.get(k) || []), s]);
      }
      const [first, second] = [...byStaffDay.values()].find((list) => list.length >= 2).sort((a, b) => (a.clock_in < b.clock_in ? -1 : 1));
      const [date, time] = first.clock_out.split(' ');
      const [h, m] = time.split(':').map(Number);
      const back = h * 60 + m - 1;
      const shift = (Date.parse(`${second.clock_in.replace(' ', 'T')}Z`) - Date.parse(`${date}T${String(Math.floor(back / 60)).padStart(2, '0')}:${String(back % 60).padStart(2, '0')}:00Z`)) / 60000;
      second.clock_in = `${date} ${String(Math.floor(back / 60)).padStart(2, '0')}:${String(back % 60).padStart(2, '0')}:00`;
      second.minutes += shift;
    }, /already clocked in elsewhere/],
  ];
  for (const [mutate, expected] of cases) {
    const problems = broken(mutate);
    assert.equal(problems.length, 1, `${expected}: ${problems.join('; ')}`);
    assert.match(problems[0], expected);
  }
  // A cancelled visit keeps its schedule but may not carry timesheets.
  const problems = broken((t) => {
    const v = t.visits.find((x) => x.visit_id === t.timesheets[0].visit_id);
    v.status = 'cancelled';
  });
  assert.ok(problems.length >= 1 && problems.every((p) => /is cancelled/.test(p)), problems.join('; '));
});
