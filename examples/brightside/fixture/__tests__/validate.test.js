'use strict';

// Story 7.6: Brightside's fixture checks pass on its seeds, its known truths
// match the planted targets through the query runner, and a deliberately
// broken copy of the seeds fails each check exactly once.
// Example test (AD-1 carve-out): it reads Brightside's own fixture, profile
// and context and goes with them in a fork. It builds into temporary
// directories, never var/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../../../kit/fixture/build');
const { loadChecks, validate } = require('../../../../kit/fixture/validate');
const { createData } = require('../../../../kit/runtime/data');
const { loadProfile } = require('../../../../kit/lib/profile');
const { truthChecksFor, loadTruths } = require('../../../../kit/lib/truths');
const { contextDirFor } = require('../../../../kit/lib/onboard');
const { runChecks } = require('../../../../kit/lib/verify/runner');
const { checkEnv } = require('../../../../kit/lib/verify');
const { TRUTH_IDS } = require('../lib/truths');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE_DIR = path.join(__dirname, '..');
const PROFILE_FILE = path.join(REPO, 'profiles', 'brightside', 'profile.yml');
const PROFILE = loadProfile(PROFILE_FILE);
const FORBIDDEN = PROFILE.sql.forbidden_columns;
const TARGETS = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'targets.json'), 'utf8')).truths;

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
  assert.equal(checks.length, 12);
  const results = await validate({ checks, db: out, forbiddenColumns: FORBIDDEN });
  assert.deepEqual(results.filter((r) => r.outcome !== 'pass'), []);
});

test('the profile\'s fixture-validate check names no profile: verify passes the governing one', () => {
  const check = PROFILE.verify.checks.find((c) => c.id === 'fixture-validate');
  assert.deepEqual(check.run, ['node', 'kit/fixture/validate.js', 'examples/brightside/fixture']);
});

test('data.md holds one truth per planted target: owner Dana Reyes, pending sign-off, tolerance 0', () => {
  const entries = loadTruths(contextDirFor(PROFILE_FILE));
  assert.deepEqual(entries.map((e) => e.id).sort(), [...TRUTH_IDS].sort());
  assert.deepEqual(Object.keys(TARGETS).sort(), [...TRUTH_IDS].sort());
  for (const e of entries) {
    assert.deepEqual(e.problems, [], e.id);
    assert.equal(e.truth.expect, TARGETS[e.id], `${e.id}: expect must be the planted target`);
    assert.deepEqual(e.truth.tolerance, { kind: 'abs', value: 0 }, e.id);
    assert.equal(e.truth.owner, 'Dana Reyes', e.id);
    assert.equal(e.truth.signedOff, 'pending', e.id);
    // No --profile: the governing profile applies, so a fork that copies the
    // block enforces its own forbidden columns, never Brightside's (issue #77).
    assert.deepEqual(e.truth.run, ['node', 'kit/fixture/query.js', `examples/brightside/fixture/truths/${e.id}.sql`], e.id);
  }
});

test('each truth runs through the query runner, as npm run verify runs it, and matches its target', async (t) => {
  const { out } = await builtFixture();
  // As verify passes it: no APLABS_PROFILE, the governing profile in
  // APLABS_GOVERNING_PROFILE. The data file is the temp build, so
  // APLABS_DATA_PATH is set here only.
  const env = checkEnv({ PATH: process.env.PATH, APLABS_DATA_PATH: out }, ['APLABS_DATA_PATH'], PROFILE_FILE);
  const { results } = await runChecks(truthChecksFor(PROFILE_FILE), env, REPO);
  assert.deepEqual(results.map((r) => [r.id, r.outcome, r.reason || null]), TRUTH_IDS.map((id) => [`truth:${id}`, 'pass', null]));
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

function readCsv(file) {
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const cols = header.split(',');
  return { cols, rows: lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v]))) };
}

function writeCsv(file, { cols, rows }) {
  fs.writeFileSync(file, `${[cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n')}\n`);
}

// A copy of the seeds with one row broken per check, and a schema with its
// foreign keys removed so an orphan can load at all (DuckDB enforces them).
// Each break touches rows no other break touches. Returns { dir, broken }:
// the check each break targets.
function brokenFixture(t) {
  const dir = tmpDir(t);
  fs.cpSync(path.join(FIXTURE_DIR, 'seeds'), path.join(dir, 'seeds'), { recursive: true });
  const schema = fs.readFileSync(path.join(FIXTURE_DIR, 'schema.sql'), 'utf8').replace(/ REFERENCES \w+ \(\w+\)/g, '');
  assert.doesNotMatch(schema, /REFERENCES/);
  fs.writeFileSync(path.join(dir, 'schema.sql'), schema);
  const file = (name) => path.join(dir, 'seeds', `${name}.csv`);
  const t_ = Object.fromEntries(['crews', 'clients', 'invoices', 'payments', 'visits', 'plans', 'crew_memberships', 'fixture_meta']
    .map((name) => [name, readCsv(file(name))]));
  const broken = [];
  const used = { invoices: new Set(), visits: new Set(), plans: new Set() };
  const take = (kind, id) => {
    assert.ok(!used[kind].has(id), `${kind} ${id} broken twice`);
    used[kind].add(id);
  };

  // A crew in a zone that does not exist.
  t_.crews.rows[0].zone_id = 'nowhere';
  broken.push('integrity-foreign-keys');

  // A client with no property.
  const extra = { ...t_.clients.rows[0], client_id: String(t_.clients.rows.length + 1), email: 'orphan.client@home.invalid' };
  t_.clients.rows.push(extra);
  t_.fixture_meta.rows.find((r) => r.key === 'rows_clients').value = String(t_.clients.rows.length);
  broken.push('integrity-orphans');

  // An invoice whose total is one cent more than its lines.
  const inv = t_.invoices.rows[0];
  take('invoices', inv.invoice_id);
  take('visits', inv.visit_id);
  inv.total_cents = String(Number(inv.total_cents) + 1);
  broken.push('integrity-invoice-total');

  // A payment larger than its invoice.
  const pay = t_.payments.rows.find((p) => !used.invoices.has(p.invoice_id));
  const payInv = t_.invoices.rows.find((i) => i.invoice_id === pay.invoice_id);
  take('invoices', payInv.invoice_id);
  take('visits', payInv.visit_id);
  pay.amount_cents = String(Number(pay.amount_cents) + Number(payInv.total_cents));
  broken.push('integrity-payments-within-invoice');

  // An invoiced visit marked cancelled.
  const invoicedVisit = new Set(t_.invoices.rows.map((i) => i.visit_id));
  const cancelledVisit = t_.visits.rows.find((v) => invoicedVisit.has(v.visit_id) && !used.visits.has(v.visit_id));
  take('visits', cancelledVisit.visit_id);
  cancelledVisit.status = 'cancelled';
  broken.push('integrity-invoice-per-completed-visit');

  // A plan visit the day before its plan starts.
  const planById = new Map(t_.plans.rows.map((p) => [p.plan_id, p]));
  const early = t_.visits.rows.find((v) => v.plan_id && !used.visits.has(v.visit_id));
  take('visits', early.visit_id);
  take('plans', early.plan_id);
  const start = new Date(`${planById.get(early.plan_id).start_date}T00:00:00Z`);
  early.visit_date = new Date(start.getTime() - 86_400_000).toISOString().slice(0, 10);
  broken.push('integrity-plan-visits-in-period');

  // An open plan marked cancelled.
  const open = t_.plans.rows.find((p) => p.end_date === '' && !used.plans.has(p.plan_id));
  take('plans', open.plan_id);
  open.status = 'cancelled';
  broken.push('integrity-plan-status');

  // A cancelled plan that ends after as_of.
  const ended = t_.plans.rows.find((p) => p.end_date !== '' && !used.plans.has(p.plan_id));
  take('plans', ended.plan_id);
  ended.end_date = '2026-10-15';
  broken.push('integrity-no-end-after-as-of');

  // A plan whose price is one cent off its latest change.
  const priced = t_.plans.rows.find((p) => !used.plans.has(p.plan_id));
  take('plans', priced.plan_id);
  priced.price_cents = String(Number(priced.price_cents) + 1);
  broken.push('integrity-plan-price');

  // A staff member's ended period stretched onto their next one.
  const byStaff = new Map();
  for (const m of t_.crew_memberships.rows) byStaff.set(m.staff_name, [...(byStaff.get(m.staff_name) || []), m]);
  const pair = [...byStaff.values()].map((ms) => ms.sort((a, b) => a.start_date.localeCompare(b.start_date)))
    .find((ms) => ms.length >= 2 && ms[0].end_date !== '');
  assert.ok(pair, 'the seeds have a staff member with two periods');
  pair[0].end_date = pair[1].start_date;
  broken.push('integrity-crew-membership-overlap');

  // A real-looking email and an out-of-range phone.
  t_.clients.rows[1].email = 'real.person@example.com';
  broken.push('synthetic-email');
  t_.clients.rows[2].phone = '555-0200';
  broken.push('synthetic-phone');

  for (const [name, table] of Object.entries(t_)) writeCsv(file(name), table);
  fs.cpSync(path.join(FIXTURE_DIR, 'checks'), path.join(dir, 'checks'), { recursive: true });
  return { dir, broken };
}

test('a deliberately broken seed fails each integrity and synthetic-only check exactly once', async (t) => {
  const { dir, broken } = brokenFixture(t);
  const out = path.join(dir, 'broken.duckdb');
  await build({ fixtureDir: dir, out });
  const results = await validate({ checks: loadChecks(dir), db: out, forbiddenColumns: FORBIDDEN });
  assert.deepEqual(broken.slice().sort(), results.map((r) => r.id).sort(), 'one break per check');
  assert.deepEqual(results.map((r) => [r.id, r.outcome, r.rows]), results.map((r) => [r.id, 'fail', 1]));
});
