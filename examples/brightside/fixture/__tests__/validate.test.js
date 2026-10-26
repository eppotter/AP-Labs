'use strict';

// Story 7.6: Brightside's fixture checks pass on its seeds, its known truths
// match the planted targets through the query runner, and a deliberately
// broken copy of the generator's output (a smaller run, for speed) fails each
// check exactly once.
// Example test (AD-1 carve-out): it reads Brightside's own fixture, profile
// and context and goes with them in a fork. It builds into temporary
// directories, never var/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { build, readRows } = require('../../../../kit/fixture/build');
const { loadChecks, validate } = require('../../../../kit/fixture/validate');
const { createData } = require('../../../../kit/runtime/data');
const { loadProfile } = require('../../../../kit/lib/profile');
const { truthChecksFor, loadTruths } = require('../../../../kit/lib/truths');
const { contextDirFor } = require('../../../../kit/lib/onboard');
const { runChecks } = require('../../../../kit/lib/verify/runner');
const { checkEnv, checkLine } = require('../../../../kit/lib/verify');
const { TRUTH_IDS } = require('../lib/truths');
const { ROUTING_TARGET_IDS } = require('../lib/scenarios');
const { packS3, TRUTH_IDS: ROUTING_TRUTH_IDS } = require('../truths/routing');
const { generate, writeFiles } = require('../generate');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE_DIR = path.join(__dirname, '..');
const PROFILE_FILE = path.join(REPO, 'profiles', 'brightside', 'profile.yml');
const PROFILE = loadProfile(PROFILE_FILE);
const FORBIDDEN = PROFILE.sql.forbidden_columns;
const TARGETS = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'targets.json'), 'utf8')).truths;
const ROUTING_TARGETS = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'targets.json'), 'utf8')).routing;

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brightside-validate-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// One build of the committed seeds, shared by the tests that only read it.
let shared;
function builtFixture() {
  if (!shared) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brightside-validate-')));
    const out = path.join(dir, 'brightside.duckdb');
    shared = build({ fixtureDir: FIXTURE_DIR, out }).then(() => ({ dir, out }));
  }
  return shared;
}
test.after(async () => {
  if (shared) fs.rmSync((await shared).dir, { recursive: true, force: true });
});

test('every check in checks/ passes on the committed seeds, with Brightside\'s forbidden columns', async (t) => {
  const { out } = await builtFixture();
  const checks = loadChecks(FIXTURE_DIR);
  assert.equal(checks.length, 30);
  const results = await validate({ checks, db: out, forbiddenColumns: FORBIDDEN });
  assert.deepEqual(results.filter((r) => r.outcome !== 'pass'), []);
});

test('the profile\'s fixture-validate check names no profile: verify passes the governing one', () => {
  const check = PROFILE.verify.checks.find((c) => c.id === 'fixture-validate');
  assert.deepEqual(check.run, ['node', 'kit/fixture/validate.js', 'examples/brightside/fixture']);
});

// The query truths (Story 7.6), then the routing truths (Story 14.4), in
// data.md's order.
const ALL_TRUTH_IDS = [...TRUTH_IDS, ...ROUTING_TARGET_IDS];
const ROUTING_SCRIPT = 'examples/brightside/fixture/truths/routing.js';
// A routing truth's expect: its planted answer; S3's three counts packed into
// one number as the script prints them (100 x in-zone + 10 x cross-zone + unplaced).
const routingExpect = (id) => (id === 'route-change-s3-crosszone' ? packS3(ROUTING_TARGETS[id]) : ROUTING_TARGETS[id]);

test('data.md holds one truth per planted target: owner Dana Reyes, signed off 2026-10-25 (Story 4.3), tolerance 0', () => {
  const entries = loadTruths(contextDirFor(PROFILE_FILE)).filter((e) => TRUTH_IDS.includes(e.id));
  assert.deepEqual(entries.map((e) => e.id).sort(), [...TRUTH_IDS].sort());
  assert.deepEqual(Object.keys(TARGETS).sort(), [...TRUTH_IDS].sort());
  for (const e of entries) {
    assert.deepEqual(e.problems, [], e.id);
    assert.equal(e.truth.expect, TARGETS[e.id], `${e.id}: expect must be the planted target`);
    assert.deepEqual(e.truth.tolerance, { kind: 'abs', value: 0 }, e.id);
    assert.equal(e.truth.owner, 'Dana Reyes', e.id);
    assert.equal(e.truth.signedOff, '2026-10-25', e.id);
    // No --profile: the governing profile applies, so a fork that copies the
    // block enforces its own forbidden columns, never Brightside's (issue #77).
    assert.deepEqual(e.truth.run, ['node', 'kit/fixture/query.js', `examples/brightside/fixture/truths/${e.id}.sql`], e.id);
  }
});

test('data.md holds the five routing truths (Story 14.4): planted targets, tolerance 0, owner Dana Reyes, sign-off pending', () => {
  const entries = loadTruths(contextDirFor(PROFILE_FILE));
  assert.deepEqual(entries.map((e) => e.id), ALL_TRUTH_IDS);
  assert.deepEqual(Object.keys(ROUTING_TARGETS).sort(), [...ROUTING_TARGET_IDS].sort());
  assert.deepEqual(ROUTING_TRUTH_IDS, ROUTING_TARGET_IDS.filter((id) => id !== 'scheduled-stops-next-14d'));
  for (const e of entries.filter((x) => ROUTING_TARGET_IDS.includes(x.id))) {
    assert.deepEqual(e.problems, [], e.id);
    assert.equal(e.truth.expect, routingExpect(e.id), `${e.id}: expect must be the planted target`);
    assert.deepEqual(e.truth.tolerance, { kind: 'abs', value: 0 }, e.id);
    assert.equal(e.truth.owner, 'Dana Reyes', e.id);
    assert.equal(e.truth.signedOff, 'pending', `${e.id}: not signed off until Dana Reyes confirms it`);
    // No --profile here either: the governing profile applies.
    const run = e.id === 'scheduled-stops-next-14d'
      ? ['node', 'kit/fixture/query.js', `examples/brightside/fixture/truths/${e.id}.sql`]
      : ['node', ROUTING_SCRIPT, e.id];
    assert.deepEqual(e.truth.run, run, e.id);
  }
  assert.equal(routingExpect('route-change-s3-crosszone'), 510);
});

test('each truth runs as npm run verify runs it and matches its target; no output line holds a coordinate', async () => {
  const { out } = await builtFixture();
  // As verify passes it: no APLABS_PROFILE, the governing profile in
  // APLABS_GOVERNING_PROFILE. The data file is the temp build, so
  // APLABS_DATA_PATH is set here only.
  const env = checkEnv({ PATH: process.env.PATH, APLABS_DATA_PATH: out }, ['APLABS_DATA_PATH'], PROFILE_FILE);
  const { results } = await runChecks(truthChecksFor(PROFILE_FILE), env, REPO);
  assert.deepEqual(results.map((r) => [r.id, r.outcome, r.reason || null]), ALL_TRUTH_IDS.map((id) => [`truth:${id}`, 'pass', null]));

  // GRD-002: every line verify prints for a truth, and everything the truth
  // printed, is checked against every coordinate in the fixture: no
  // micro-degree integer (with or without its sign), and no decimal inside
  // the fixture's latitude or longitude range (a value in degrees).
  const coords = await readRows(out, `SELECT geo_lat_e6 AS a, geo_lon_e6 AS o FROM properties
    UNION ALL SELECT base_geo_lat_e6, base_geo_lon_e6 FROM crews`);
  assert.ok(coords.length > 2000);
  const integers = new Set();
  const [lat, lon] = [[], []];
  for (const r of coords) {
    const [a, o] = [Number(r.a), Number(r.o)];
    assert.ok(Number.isSafeInteger(a) && Number.isSafeInteger(o));
    integers.add(String(Math.abs(a))).add(String(Math.abs(o)));
    lat.push(Math.abs(a) / 1e6);
    lon.push(Math.abs(o) / 1e6);
  }
  const range = (list) => [Math.min(...list) - 0.05, Math.max(...list) + 0.05];
  const [latRange, lonRange] = [range(lat), range(lon)];
  const inside = (x, [lo, hi]) => x >= lo && x <= hi;
  const lines = results.flatMap((r) => [checkLine(r), ...`${r.stdout || ''}\n${r.stderr || ''}`.split('\n')]).filter(Boolean);
  // The routing truths printed more than their number (S1's optimized
  // minutes, S3's three counts), so the scan covers real output.
  assert.ok(lines.some((l) => /^in_zone \d+$/.test(l)) && lines.some((l) => /^optimized drive minutes \d+$/.test(l)));
  for (const line of lines) {
    for (const tok of line.match(/\d+(?:\.\d+)?/g) || []) {
      if (tok.includes('.')) assert.ok(!inside(Number(tok), latRange) && !inside(Number(tok), lonRange), `a degree value in: ${line}`);
      else assert.ok(!integers.has(String(Number(tok))), `a micro-degree value in: ${line}`);
    }
  }
});

// The trap: end_date is inclusive, and one plan's last active day is as_of.
// It is active at as_of by the definition but already has status 'cancelled',
// so a count on the status column is one short. The truth uses the definition.
test('active plans at as_of uses the definition (815), never status = active (814)', async (t) => {
  const { out } = await builtFixture();
  const data = createData({ file: out, profile: PROFILE });
  t.after(() => data.close());
  const one = async (sql) => Object.values((await data.run(sql))[0])[0];
  const truthSql = fs.readFileSync(path.join(FIXTURE_DIR, 'truths', 'active-plans-at-as-of.sql'), 'utf8');
  assert.equal(await one(truthSql), String(TARGETS['active-plans-at-as-of']));
  assert.equal(await one("SELECT COUNT(plan_id) AS n FROM plans WHERE status = 'active'"), String(TARGETS['active-plans-at-as-of'] - 1));
  assert.equal(await one("SELECT COUNT(plan_id) AS n FROM plans WHERE end_date = (SELECT CAST(value AS DATE) FROM fixture_meta WHERE key = 'as_of')"), '1');
  assert.doesNotMatch(truthSql.replace(/^--.*$/gm, ''), /status/i);
});

// --- a deliberately broken seed ---

// file is seeds/<table>.csv; the generator stores most seeds as <file>.gz.
function readCsv(file) {
  const text = fs.existsSync(`${file}.gz`) ? zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString('utf8') : fs.readFileSync(file, 'utf8');
  const [header, ...lines] = text.trimEnd().split('\n');
  const cols = header.split(',');
  return { cols, rows: lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v]))) };
}

// Writes the edited seed as plain <file> and deletes <file>.gz, so the build
// reads the edit and never sees the seed in both forms.
function writeCsv(file, { cols, rows }) {
  fs.rmSync(`${file}.gz`, { force: true });
  fs.writeFileSync(file, `${[cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n')}\n`);
}

// The breaks: one per check, each touching rows no other break touches. A
// break's pick(t_, take) chooses its rows from the unedited seeds and returns
// the edit, so it picks the same rows alone or with the others.
const TABLES = ['crews', 'clients', 'invoices', 'payments', 'visits', 'plans', 'plan_price_changes', 'invoice_lines', 'crew_memberships', 'fixture_meta',
  'staff', 'pay_rates', 'properties', 'timesheets', 'scheduled_visits', 'service_rules', 'staff_absences'];

// Local timestamps ("YYYY-MM-DD HH:MM:SS") as whole minutes, and back.
const toMinute = (ts) => Date.parse(`${ts.replace(' ', 'T')}Z`) / 60000;
const fromMinute = (m) => new Date(m * 60000).toISOString().replace('T', ' ').slice(0, 19);
const crewDay = (v) => `${v.crew_id}|${v.visit_date}`;
const covers = (row, d) => row.start_date <= d && (row.end_date === '' || row.end_date >= d);
// The role a staff member holds on a date, from pay_rates.
const roleOn = (t_, staffId, d) => t_.pay_rates.rows.find((r) => r.staff_id === staffId && covers(r, d)).role;

// A cancelled visit that is last on its crew-day route and whose crew has no
// visit on the day newDate(v) gives: it can move there as route stop 1 without
// touching the schedule or timesheet checks (it has no timesheets).
function movableCancelledVisit(t_, used, filter, newDate) {
  const size = new Map();
  for (const v of t_.visits.rows) size.set(crewDay(v), (size.get(crewDay(v)) || 0) + 1);
  return t_.visits.rows.find((v) => v.status === 'cancelled' && filter(v) && !used.visits.has(v.visit_id)
    && Number(v.route_order) === size.get(crewDay(v)) && !size.has(crewDay({ ...v, visit_date: newDate(v) })));
}
const BREAKS = [
  {
    // A crew in a zone that does not exist. DuckDB enforces the schema's
    // foreign keys, so only the stripped schema copy lets it load (issue #77).
    check: 'integrity-foreign-keys',
    pick: (t_) => () => { t_.crews.rows[0].zone_id = 'nowhere'; },
  },
  {
    // A client with no property.
    check: 'integrity-orphans',
    pick: (t_) => {
      const extra = { ...t_.clients.rows[0], client_id: String(t_.clients.rows.length + 1), email: 'orphan.client@home.invalid' };
      return () => {
        t_.clients.rows.push(extra);
        t_.fixture_meta.rows.find((r) => r.key === 'rows_clients').value = String(t_.clients.rows.length);
      };
    },
  },
  {
    // An invoice whose total is one cent more than its lines.
    check: 'integrity-invoice-total',
    pick: (t_, take) => {
      const inv = t_.invoices.rows[0];
      take('invoices', inv.invoice_id);
      take('visits', inv.visit_id);
      return () => { inv.total_cents = String(Number(inv.total_cents) + 1); };
    },
  },
  {
    // A payment larger than its invoice.
    check: 'integrity-payments-within-invoice',
    pick: (t_, take, used) => {
      const pay = t_.payments.rows.find((p) => !used.invoices.has(p.invoice_id));
      const payInv = t_.invoices.rows.find((i) => i.invoice_id === pay.invoice_id);
      take('invoices', payInv.invoice_id);
      take('visits', payInv.visit_id);
      return () => { pay.amount_cents = String(Number(pay.amount_cents) + Number(payInv.total_cents)); };
    },
  },
  {
    // An invoiced visit marked cancelled.
    check: 'integrity-invoice-per-completed-visit',
    pick: (t_, take, used) => {
      const invoicedVisit = new Set(t_.invoices.rows.map((i) => i.visit_id));
      const v = t_.visits.rows.find((x) => invoicedVisit.has(x.visit_id) && !used.visits.has(x.visit_id));
      take('visits', v.visit_id);
      // Its timesheets go too: a cancelled visit has none (integrity-timesheet-visit).
      return () => {
        v.status = 'cancelled';
        t_.timesheets.rows = t_.timesheets.rows.filter((s) => s.visit_id !== v.visit_id);
        t_.fixture_meta.rows.find((r) => r.key === 'rows_timesheets').value = String(t_.timesheets.rows.length);
      };
    },
  },
  {
    // A plan visit the day before its plan starts. A cancelled one, last on
    // its route, onto a day its crew is free, so only this check sees it.
    check: 'integrity-plan-visits-in-period',
    pick: (t_, take, used) => {
      const planById = new Map(t_.plans.rows.map((p) => [p.plan_id, p]));
      const dayBefore = (v) => new Date(Date.parse(`${planById.get(v.plan_id).start_date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      // Never its plan's last visit, which the booked schedule's cadence
      // counts from (integrity-scheduled-cadence).
      const lastOf = new Map();
      for (const v of t_.visits.rows) if (v.plan_id !== '' && !(lastOf.get(v.plan_id) >= v.visit_date)) lastOf.set(v.plan_id, v.visit_date);
      const early = movableCancelledVisit(t_, used, (v) => v.plan_id !== '' && !used.plans.has(v.plan_id) && v.visit_date !== lastOf.get(v.plan_id), dayBefore);
      take('visits', early.visit_id);
      take('plans', early.plan_id);
      return () => { early.visit_date = dayBefore(early); early.route_order = '1'; };
    },
  },
  {
    // An open plan marked cancelled.
    check: 'integrity-plan-status',
    pick: (t_, take, used) => {
      const open = t_.plans.rows.find((p) => p.end_date === '' && !used.plans.has(p.plan_id));
      take('plans', open.plan_id);
      return () => { open.status = 'cancelled'; };
    },
  },
  {
    // A cancelled plan that ends after as_of.
    check: 'integrity-no-end-after-as-of',
    pick: (t_, take, used) => {
      const ended = t_.plans.rows.find((p) => p.end_date !== '' && !used.plans.has(p.plan_id));
      take('plans', ended.plan_id);
      return () => { ended.end_date = '2026-10-15'; };
    },
  },
  {
    // A payment made the day after as_of (issue #77 item 8).
    check: 'integrity-no-date-after-as-of',
    pick: (t_, take, used) => {
      const pay = t_.payments.rows.find((p) => !used.invoices.has(p.invoice_id));
      take('invoices', pay.invoice_id);
      return () => { pay.paid_on = dayAfterAsOf(t_); };
    },
  },
  {
    // A plan whose price is one cent off its latest change.
    check: 'integrity-plan-price',
    pick: (t_, take, used) => {
      const priced = t_.plans.rows.find((p) => !used.plans.has(p.plan_id));
      take('plans', priced.plan_id);
      return () => { priced.price_cents = String(Number(priced.price_cents) + 1); };
    },
  },
  {
    // A package line that also names an add-on (issue #77 item 7).
    check: 'integrity-invoice-line-item',
    pick: (t_, take, used) => {
      const addOn = t_.invoice_lines.rows.find((l) => l.add_on_id !== '').add_on_id;
      const line = t_.invoice_lines.rows.find((l) => l.package_id !== '' && !used.invoices.has(l.invoice_id));
      take('invoices', line.invoice_id);
      return () => { line.add_on_id = addOn; };
    },
  },
  {
    // A staff member's ended period stretched onto their next one. A cleaner
    // in both, so the extra days add no second crew lead.
    check: 'integrity-crew-membership-overlap',
    pick: (t_) => {
      const byStaff = new Map();
      for (const m of t_.crew_memberships.rows) byStaff.set(m.staff_name, [...(byStaff.get(m.staff_name) || []), m]);
      const pair = [...byStaff.values()].map((ms) => ms.slice().sort((a, b) => a.start_date.localeCompare(b.start_date)))
        .find((ms) => ms.length >= 2 && ms[0].end_date !== ''
          && roleOn(t_, ms[0].staff_id, ms[0].start_date) === 'cleaner' && roleOn(t_, ms[1].staff_id, ms[1].start_date) === 'cleaner');
      assert.ok(pair, 'the seeds have a staff member with two periods');
      return () => { pair[0].end_date = pair[1].start_date; };
    },
  },
  {
    // A staff name that differs from their crew memberships'.
    check: 'integrity-staff',
    pick: (t_) => () => { t_.staff.rows[0].name = 'Nobody Known'; },
  },
  {
    // A cleaner's earlier pay period below the cleaner minimum.
    check: 'integrity-pay-rates',
    pick: (t_) => {
      const rows = t_.pay_rates.rows;
      const p = rows.find((r, i) => r.role === 'cleaner' && rows[i + 1] && rows[i + 1].staff_id === r.staff_id);
      return () => { p.hourly_rate_cents = '1500'; };
    },
  },
  {
    // A crew lead's pay period recorded as cleaner (rate kept in cleaner
    // bounds, staff kept in step), so their crew has no lead for a while.
    check: 'integrity-crew-lead',
    pick: (t_) => {
      const ms = t_.crew_memberships.rows;
      const p = t_.pay_rates.rows.find((r) => {
        if (r.role !== 'crew_lead') return false;
        const own = ms.filter((m) => m.staff_id === r.staff_id
          && m.start_date <= (r.end_date || '9999-12-31') && (m.end_date === '' || m.end_date >= r.start_date));
        if (new Set(own.map((m) => m.crew_id)).size !== 1) return false;
        return ms.some((e) => e.crew_id === own[0].crew_id && covers(r, e.start_date) && own.some((m) => covers(m, e.start_date)));
      });
      assert.ok(p, 'the seeds have a lead period to demote');
      const staff = t_.staff.rows.find((s) => s.staff_id === p.staff_id);
      const last = t_.pay_rates.rows.filter((r) => r.staff_id === p.staff_id).at(-1) === p;
      return () => {
        p.role = 'cleaner';
        p.hourly_rate_cents = String(Math.min(Number(p.hourly_rate_cents), 2400));
        if (last) { staff.role = 'cleaner'; staff.hourly_rate_cents = p.hourly_rate_cents; }
      };
    },
  },
  {
    // A home of 7,000 square feet.
    check: 'integrity-property-details',
    pick: (t_) => () => { t_.properties.rows[0].square_feet = '7000'; },
  },
  {
    // A gap in a crew-day's route: its last stop renumbered past the end.
    check: 'integrity-route-order',
    pick: (t_, take, used) => {
      const size = new Map();
      for (const v of t_.visits.rows) size.set(crewDay(v), (size.get(crewDay(v)) || 0) + 1);
      const v = t_.visits.rows.find((x) => size.get(crewDay(x)) >= 2 && Number(x.route_order) === size.get(crewDay(x)) && !used.visits.has(x.visit_id));
      take('visits', v.visit_id);
      return () => { v.route_order = String(Number(v.route_order) + 3); };
    },
  },
  {
    // An arrival window that disagrees with the scheduled start.
    check: 'integrity-visit-schedule',
    pick: (t_, take, used) => {
      const v = t_.visits.rows.find((x) => !used.visits.has(x.visit_id));
      take('visits', v.visit_id);
      return () => { v.arrival_window = v.arrival_window === 'morning' ? 'afternoon' : 'morning'; };
    },
  },
  {
    // A timesheet moved onto a cancelled visit.
    check: 'integrity-timesheet-visit',
    pick: (t_, take, used) => {
      const sheet = t_.timesheets.rows.find((s) => !used.visits.has(s.visit_id));
      const cancelled = t_.visits.rows.find((v) => v.status === 'cancelled' && !used.visits.has(v.visit_id));
      take('visits', sheet.visit_id);
      take('visits', cancelled.visit_id);
      return () => { sheet.visit_id = cancelled.visit_id; };
    },
  },
  {
    // A timesheet whose clock_out equals its clock_in.
    check: 'integrity-timesheet-times',
    pick: (t_, take, used) => {
      const sheet = t_.timesheets.rows.find((s) => !used.visits.has(s.visit_id));
      take('visits', sheet.visit_id);
      return () => { sheet.clock_out = sheet.clock_in; sheet.minutes = '0'; };
    },
  },
  {
    // A staff member's later timesheet that day pulled back to start a minute
    // before their earlier one ends (minutes kept consistent).
    check: 'integrity-timesheet-overlap',
    pick: (t_, take, used) => {
      const byStaffDay = new Map();
      for (const s of t_.timesheets.rows) {
        const k = `${s.staff_id}|${s.clock_in.slice(0, 10)}`;
        byStaffDay.set(k, [...(byStaffDay.get(k) || []), s]);
      }
      const [first, second] = [...byStaffDay.values()]
        .map((list) => list.slice().sort((a, b) => a.clock_in.localeCompare(b.clock_in)))
        .find((list) => list.length >= 2 && list.slice(0, 2).every((s) => !used.visits.has(s.visit_id)));
      take('visits', first.visit_id);
      take('visits', second.visit_id);
      const start = toMinute(first.clock_out) - 1;
      return () => {
        second.minutes = String(toMinute(second.clock_out) - start);
        second.clock_in = fromMinute(start);
      };
    },
  },
  {
    // A real-looking email.
    check: 'synthetic-email',
    pick: (t_) => () => { t_.clients.rows[1].email = 'real.person@example.com'; },
  },
  {
    // An out-of-range phone.
    check: 'synthetic-phone',
    pick: (t_) => () => { t_.clients.rows[2].phone = '555-0200'; },
  },
  {
    // A property placed outside the synthetic box (Story 14.1).
    check: 'synthetic-coordinates',
    pick: (t_) => () => { t_.properties.rows[3].geo_lat_e6 = '-1000000'; },
  },
  {
    // A gap in a booked crew-day's route: its last stop renumbered past the
    // end, so the order of the stops (and their times) is unchanged.
    check: 'integrity-scheduled-route-order',
    pick: (t_, take, used) => {
      const size = new Map();
      for (const v of t_.scheduled_visits.rows) size.set(crewDay(v), (size.get(crewDay(v)) || 0) + 1);
      const v = t_.scheduled_visits.rows.find((x) => Number(x.route_order) === size.get(crewDay(x)) && !used.scheduled.has(x.scheduled_visit_id));
      take('scheduled', v.scheduled_visit_id);
      return () => { v.route_order = String(Number(v.route_order) + 3); };
    },
  },
  {
    // A booked arrival window that disagrees with the scheduled start. Its
    // property has no time_of_day rule, so integrity-rules does not see it.
    check: 'integrity-scheduled-schedule',
    pick: (t_, take, used) => {
      const windowed = new Set(t_.service_rules.rows.filter((r) => r.rule_type === 'time_of_day').map((r) => r.property_id));
      const v = t_.scheduled_visits.rows.find((x) => !used.scheduled.has(x.scheduled_visit_id) && !windowed.has(x.property_id));
      take('scheduled', v.scheduled_visit_id);
      return () => { v.arrival_window = v.arrival_window === 'morning' ? 'afternoon' : 'morning'; };
    },
  },
  {
    // A booked visit whose status was set the day after as_of.
    check: 'integrity-scheduled-after-as-of',
    pick: (t_, take, used) => {
      const v = t_.scheduled_visits.rows.find((x) => !used.scheduled.has(x.scheduled_visit_id));
      take('scheduled', v.scheduled_visit_id);
      return () => { v.status_changed_on = dayAfterAsOf(t_); };
    },
  },
  {
    // A booked visit on a package that is not its plan's.
    check: 'integrity-scheduled-cadence',
    pick: (t_, take, used) => {
      const v = t_.scheduled_visits.rows.find((x) => !used.scheduled.has(x.scheduled_visit_id));
      take('scheduled', v.scheduled_visit_id);
      return () => { v.package_id = v.package_id === 'deep' ? 'standard' : 'deep'; };
    },
  },
  {
    // A day_of_week rule marked soft: day and window rules are hard (Story 14.2).
    check: 'integrity-rules',
    pick: (t_) => {
      const rule = t_.service_rules.rows.find((r) => r.rule_type === 'day_of_week');
      return () => { rule.strength = 'soft'; };
    },
  },
  {
    // An absence reported the day after as_of (Story 14.2). Added, so the
    // break never depends on how many background absences a seed draws.
    check: 'integrity-staff-absences',
    pick: (t_) => () => {
      const horizon = t_.fixture_meta.rows.find((r) => r.key === 'schedule_horizon_end').value;
      const away = new Set(t_.staff_absences.rows.filter((a) => a.absence_date === horizon).map((a) => a.staff_id));
      const member = t_.crew_memberships.rows.find((m) => m.end_date === '' && !away.has(m.staff_id));
      t_.staff_absences.rows.push({ absence_id: String(t_.staff_absences.rows.length + 1), staff_id: member.staff_id, absence_date: horizon, reported_on: dayAfterAsOf(t_) });
      t_.fixture_meta.rows.find((r) => r.key === 'rows_staff_absences').value = String(t_.staff_absences.rows.length);
    },
  },
];

// The broken copies start from a smaller run of the same generator (same
// code and rules, unplanted, about a fifth of the rows), so the thirty-odd
// broken builds stay fast. The committed seeds are checked whole above.
const BREAK_BASE = { seed: 11, clients: 400 };
let breakBase;
function breakBaseDir() {
  if (!breakBase) {
    breakBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brightside-break-base-')));
    writeFiles(breakBase, generate(BREAK_BASE).files);
  }
  return breakBase;
}
test.after(() => { if (breakBase) fs.rmSync(breakBase, { recursive: true, force: true }); });

let seedCache;
function seedTables() {
  seedCache ??= Object.fromEntries(TABLES.map((name) => [name, readCsv(path.join(breakBaseDir(), 'seeds', `${name}.csv`))]));
  return seedCache;
}

const changed = (before, after) => after.rows.length !== before.rows.length
  || after.rows.some((row, i) => before.cols.some((c) => row[c] !== before.rows[i][c]));

function dayAfterAsOf(t_) {
  const asOf = t_.fixture_meta.rows.find((r) => r.key === 'as_of').value;
  return new Date(Date.parse(`${asOf}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

// A copy of the fixture with the named breaks applied (default: all), then
// extra(t_) if given, and a schema with its foreign keys removed so an orphan
// can load at all.
function brokenFixture(t, only = BREAKS.map((b) => b.check), extra = null) {
  const dir = tmpDir(t);
  fs.cpSync(path.join(breakBaseDir(), 'seeds'), path.join(dir, 'seeds'), { recursive: true });
  const schema = fs.readFileSync(path.join(breakBaseDir(), 'schema.sql'), 'utf8').replace(/ REFERENCES \w+ \(\w+\)/g, '');
  assert.doesNotMatch(schema, /REFERENCES/);
  fs.writeFileSync(path.join(dir, 'schema.sql'), schema);
  const file = (name) => path.join(dir, 'seeds', `${name}.csv`);
  // Fresh row copies of the seeds, parsed once per run (the seeds are large).
  const base = seedTables();
  const t_ = Object.fromEntries(TABLES.map((name) => [name, { cols: base[name].cols, rows: base[name].rows.map((r) => ({ ...r })) }]));
  const used = { invoices: new Set(), visits: new Set(), plans: new Set(), scheduled: new Set() };
  const take = (kind, id) => {
    assert.ok(!used[kind].has(id), `${kind} ${id} broken twice`);
    used[kind].add(id);
  };
  const edits = BREAKS.map((b) => [b.check, b.pick(t_, take, used)]);
  for (const [check, edit] of edits) if (only.includes(check)) edit();
  if (extra) extra(t_);
  // The copy already holds the seeds: rewrite only the tables an edit changed.
  for (const [name, table] of Object.entries(t_)) if (changed(base[name], table)) writeCsv(file(name), table);
  fs.cpSync(path.join(FIXTURE_DIR, 'checks'), path.join(dir, 'checks'), { recursive: true });
  return dir;
}

async function validateBroken(t, only, extra) {
  const dir = brokenFixture(t, only, extra);
  const out = path.join(dir, 'broken.duckdb');
  await build({ fixtureDir: dir, out });
  return validate({ checks: loadChecks(dir), db: out, forbiddenColumns: FORBIDDEN });
}

const failures = (results) => results.filter((r) => r.outcome !== 'pass').map((r) => [r.id, r.rows ?? r.error]);

test('every check has exactly one break', () => {
  assert.deepEqual(BREAKS.map((b) => b.check).sort(), loadChecks(FIXTURE_DIR).map((c) => c.id).sort());
});

test('a deliberately broken seed fails each integrity and synthetic-only check exactly once', async (t) => {
  const results = await validateBroken(t);
  assert.deepEqual(results.map((r) => [r.id, r.outcome, r.rows]), results.map((r) => [r.id, 'fail', 1]));
});

// Which check failed for which break: each break alone fails its own check
// with one row, and every other check passes.
test('each break alone fails only its own check', async (t) => {
  const got = await Promise.all(BREAKS.map(async (b) => [b.check, failures(await validateBroken(t, [b.check]))]));
  assert.deepEqual(got, BREAKS.map((b) => [b.check, [[b.check, 1]]]));
});

// Issue #77 item 5: with no as_of to compare against, the as_of checks would
// return no rows and pass. Each returns one guard row instead.
test('with no as_of row in fixture_meta, the as_of check fails on its guard row', async (t) => {
  const results = await validateBroken(t, [], (t_) => { t_.fixture_meta.rows = t_.fixture_meta.rows.filter((r) => r.key !== 'as_of'); });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  for (const id of ['integrity-no-end-after-as-of', 'integrity-no-date-after-as-of']) {
    assert.deepEqual([byId[id].outcome, byId[id].rows], ['fail', 1], id);
  }
});

// Stories 14.1 and 14.2: with no schedule_horizon_end to compare against,
// the three checks that read it fail on their guard row instead of passing.
test('with no schedule_horizon_end row in fixture_meta, the checks that read it fail on their guard row only', async (t) => {
  const results = await validateBroken(t, [], (t_) => { t_.fixture_meta.rows = t_.fixture_meta.rows.filter((r) => r.key !== 'schedule_horizon_end'); });
  assert.deepEqual(failures(results), [['integrity-scheduled-after-as-of', 1], ['integrity-scheduled-cadence', 1], ['integrity-staff-absences', 1]]);
});

// Story 14.1: the cadence check's other rules, each alone.
for (const [what, edit] of [
  ['a booked visit on an ended plan', (t_) => {
    // A plan with one booked visit, ended on as_of: the plan ending on as_of has none.
    const count = new Map();
    for (const v of t_.scheduled_visits.rows) count.set(v.plan_id, (count.get(v.plan_id) || 0) + 1);
    const plan = t_.plans.rows.find((p) => count.get(p.plan_id) === 1);
    plan.end_date = t_.fixture_meta.rows.find((r) => r.key === 'as_of').value;
    plan.status = 'cancelled';
  }],
  ['a booked date a day off its cadence', (t_) => {
    // A plan's only booked visit, alone on its crew-day, moved a day later
    // onto a day its crew has nothing booked.
    const count = new Map();
    for (const v of t_.scheduled_visits.rows) count.set(v.plan_id, (count.get(v.plan_id) || 0) + 1);
    const size = new Map();
    for (const v of t_.scheduled_visits.rows) size.set(crewDay(v), (size.get(crewDay(v)) || 0) + 1);
    const next = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const horizon = t_.fixture_meta.rows.find((r) => r.key === 'schedule_horizon_end').value;
    const v = t_.scheduled_visits.rows.find((x) => count.get(x.plan_id) === 1 && size.get(crewDay(x)) === 1
      && next(x.visit_date) <= horizon && !size.has(crewDay({ ...x, visit_date: next(x.visit_date) })));
    v.visit_date = next(v.visit_date);
  }],
  ['an active plan with its next date not booked', (t_) => {
    // A plan's only booked visit, last on its crew-day, removed.
    const count = new Map();
    for (const v of t_.scheduled_visits.rows) count.set(v.plan_id, (count.get(v.plan_id) || 0) + 1);
    const size = new Map();
    for (const v of t_.scheduled_visits.rows) size.set(crewDay(v), (size.get(crewDay(v)) || 0) + 1);
    const v = t_.scheduled_visits.rows.find((x) => count.get(x.plan_id) === 1 && Number(x.route_order) === size.get(crewDay(x)));
    t_.scheduled_visits.rows = t_.scheduled_visits.rows.filter((x) => x !== v);
    t_.fixture_meta.rows.find((r) => r.key === 'rows_scheduled_visits').value = String(t_.scheduled_visits.rows.length);
  }],
]) {
  test(`${what} fails integrity-scheduled-cadence only`, async (t) => {
    assert.deepEqual(failures(await validateBroken(t, [], edit)), [['integrity-scheduled-cadence', 1]]);
  });
}

// Story 14.2: a booked visit may move to another crew of its zone on its own
// day (the planted scenarios do), but never to another zone's crew. The
// visit is alone on its crew-day, its property has no preferred crew, and
// the crew it moves to has nothing that day, so no other check sees it.
function moveToCrewOf(t_, sameZone) {
  const zoneOf = new Map(t_.crews.rows.map((c) => [c.crew_id, c.zone_id]));
  const size = new Map();
  for (const v of t_.scheduled_visits.rows) size.set(crewDay(v), (size.get(crewDay(v)) || 0) + 1);
  const preferred = new Set(t_.service_rules.rows.filter((r) => r.rule_type === 'preferred_crew').map((r) => r.property_id));
  for (const v of t_.scheduled_visits.rows) {
    if (size.get(crewDay(v)) !== 1 || preferred.has(v.property_id)) continue;
    const to = t_.crews.rows.find((c) => c.crew_id !== v.crew_id && (zoneOf.get(c.crew_id) === zoneOf.get(v.crew_id)) === sameZone
      && !size.has(crewDay({ ...v, crew_id: c.crew_id })));
    if (to) { v.crew_id = to.crew_id; return; }
  }
  throw new Error('no visit to move');
}

test('a booked visit moved to another zone\'s crew fails integrity-scheduled-cadence only', async (t) => {
  assert.deepEqual(failures(await validateBroken(t, [], (t_) => moveToCrewOf(t_, false))), [['integrity-scheduled-cadence', 1]]);
});

test('a booked visit moved to another crew of its zone fails no check', async (t) => {
  assert.deepEqual(failures(await validateBroken(t, [], (t_) => moveToCrewOf(t_, true))), []);
});

// Story 14.2: integrity-rules' other rules, each alone. Each edits one rule,
// or one booked visit of a property with one booked visit.
const bookedOnce = (t_, filter) => {
  const count = new Map();
  for (const v of t_.scheduled_visits.rows) if (v.status === 'scheduled') count.set(v.property_id, (count.get(v.property_id) || 0) + 1);
  return t_.service_rules.rows.find((r) => filter(r) && count.get(r.property_id) === 1);
};
for (const [what, edit, rows = 1] of [
  ['a day_of_week value out of week order', (t_) => {
    const rule = t_.service_rules.rows.find((r) => r.rule_type === 'day_of_week' && r.value.includes('|'));
    rule.value = rule.value.split('|').reverse().join('|');
  }],
  ['a time_of_day its one booked visit is not in', (t_) => {
    const rule = bookedOnce(t_, (r) => r.rule_type === 'time_of_day');
    rule.value = rule.value === 'morning' ? 'afternoon' : 'morning';
  }],
  ['a day_of_week its one booked visit is not on', (t_) => {
    const rule = bookedOnce(t_, (r) => r.rule_type === 'day_of_week');
    const names = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    rule.value = names.find((d) => !rule.value.split('|').includes(d));
  }],
  ['a preferred crew in another zone', (t_) => {
    // Its one booked visit is then off its preferred crew too: two rows.
    const zoneOf = new Map(t_.crews.rows.map((c) => [c.crew_id, c.zone_id]));
    const rule = bookedOnce(t_, (r) => r.rule_type === 'preferred_crew');
    rule.value = t_.crews.rows.find((c) => zoneOf.get(c.crew_id) !== zoneOf.get(rule.value)).crew_id;
  }, 2],
  ['an unknown rule type', (t_) => { t_.service_rules.rows[0].rule_type = 'favourite_colour'; }],
]) {
  test(`${what} fails integrity-rules only`, async (t) => {
    assert.deepEqual(failures(await validateBroken(t, [], edit)), [['integrity-rules', rows]]);
  });
}

// Story 14.2: an absence by someone with no membership covering the day.
test('an absence of someone on no crew that day fails integrity-staff-absences only', async (t) => {
  const results = await validateBroken(t, [], (t_) => {
    const open = new Set(t_.crew_memberships.rows.filter((m) => m.end_date === '').map((m) => m.staff_id));
    const gone = t_.staff.rows.find((x) => !open.has(x.staff_id));
    const horizon = t_.fixture_meta.rows.find((r) => r.key === 'schedule_horizon_end').value;
    t_.staff_absences.rows.push({ absence_id: String(t_.staff_absences.rows.length + 1), staff_id: gone.staff_id, absence_date: horizon, reported_on: t_.fixture_meta.rows.find((r) => r.key === 'as_of').value });
    t_.fixture_meta.rows.find((r) => r.key === 'rows_staff_absences').value = String(t_.staff_absences.rows.length);
  });
  assert.deepEqual(failures(results), [['integrity-staff-absences', 1]]);
});

// Issue #77 item 8: the outstanding and clients-total truths count on every
// event date being on or before as_of. The paid_on break is in BREAKS; these
// are the other three dates, each alone.
for (const [what, edit] of [
  ['an invoice issued', (t_) => { t_.invoices.rows[0].issued_on = dayAfterAsOf(t_); }],
  // A cancelled one-off, last on its route, so it moves as route stop 1 of an
  // empty day and no schedule or timesheet check sees it.
  ['a one-off visit', (t_) => {
    const v = movableCancelledVisit(t_, { visits: new Set() }, (x) => x.plan_id === '', () => dayAfterAsOf(t_));
    v.visit_date = dayAfterAsOf(t_);
    v.route_order = '1';
  }],
  ['a client created', (t_) => { t_.clients.rows[0].created_on = dayAfterAsOf(t_); }],
]) {
  test(`${what} after as_of fails integrity-no-date-after-as-of only`, async (t) => {
    assert.deepEqual(failures(await validateBroken(t, [], edit)), [['integrity-no-date-after-as-of', 1]]);
  });
}

// Issue #77 item 6: integrity-plan-price also checks the changes themselves.
// Each break moves one change of a plan with two or more, so the plan's
// latest change (and so its price) stays the same: only the new rule fails.
function changesOfAPlanWithTwo(t_) {
  const byPlan = new Map();
  for (const c of t_.plan_price_changes.rows) byPlan.set(c.plan_id, [...(byPlan.get(c.plan_id) || []), c]);
  const changes = [...byPlan.values()].find((cs) => cs.length >= 2).sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  return { plan: t_.plans.rows.find((p) => p.plan_id === changes[0].plan_id), changes };
}

test('a price change before its plan starts fails integrity-plan-price only', async (t) => {
  const results = await validateBroken(t, [], (t_) => {
    const { plan, changes } = changesOfAPlanWithTwo(t_);
    changes[0].effective_date = new Date(Date.parse(`${plan.start_date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  });
  assert.deepEqual(failures(results), [['integrity-plan-price', 1]]);
});

test('a price change whose old price is not the previous new price fails integrity-plan-price only', async (t) => {
  const results = await validateBroken(t, [], (t_) => {
    const { changes } = changesOfAPlanWithTwo(t_);
    changes[1].old_price_cents = String(Number(changes[1].old_price_cents) + 1);
  });
  assert.deepEqual(failures(results), [['integrity-plan-price', 1]]);
});
