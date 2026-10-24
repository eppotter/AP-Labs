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

// The breaks: one per check, each touching rows no other break touches. A
// break's pick(t_, take) chooses its rows from the unedited seeds and returns
// the edit, so it picks the same rows alone or with the others.
const TABLES = ['crews', 'clients', 'invoices', 'payments', 'visits', 'plans', 'crew_memberships', 'fixture_meta'];
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
      return () => { v.status = 'cancelled'; };
    },
  },
  {
    // A plan visit the day before its plan starts.
    check: 'integrity-plan-visits-in-period',
    pick: (t_, take, used) => {
      const planById = new Map(t_.plans.rows.map((p) => [p.plan_id, p]));
      const early = t_.visits.rows.find((v) => v.plan_id && !used.visits.has(v.visit_id));
      take('visits', early.visit_id);
      take('plans', early.plan_id);
      const start = new Date(`${planById.get(early.plan_id).start_date}T00:00:00Z`);
      return () => { early.visit_date = new Date(start.getTime() - 86_400_000).toISOString().slice(0, 10); };
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
    // A plan whose price is one cent off its latest change.
    check: 'integrity-plan-price',
    pick: (t_, take, used) => {
      const priced = t_.plans.rows.find((p) => !used.plans.has(p.plan_id));
      take('plans', priced.plan_id);
      return () => { priced.price_cents = String(Number(priced.price_cents) + 1); };
    },
  },
  {
    // A staff member's ended period stretched onto their next one.
    check: 'integrity-crew-membership-overlap',
    pick: (t_) => {
      const byStaff = new Map();
      for (const m of t_.crew_memberships.rows) byStaff.set(m.staff_name, [...(byStaff.get(m.staff_name) || []), m]);
      const pair = [...byStaff.values()].map((ms) => ms.slice().sort((a, b) => a.start_date.localeCompare(b.start_date)))
        .find((ms) => ms.length >= 2 && ms[0].end_date !== '');
      assert.ok(pair, 'the seeds have a staff member with two periods');
      return () => { pair[0].end_date = pair[1].start_date; };
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
];

// A copy of the fixture with the named breaks applied (default: all), then
// extra(t_) if given, and a schema with its foreign keys removed so an orphan
// can load at all.
function brokenFixture(t, only = BREAKS.map((b) => b.check), extra = null) {
  const dir = tmpDir(t);
  fs.cpSync(path.join(FIXTURE_DIR, 'seeds'), path.join(dir, 'seeds'), { recursive: true });
  const schema = fs.readFileSync(path.join(FIXTURE_DIR, 'schema.sql'), 'utf8').replace(/ REFERENCES \w+ \(\w+\)/g, '');
  assert.doesNotMatch(schema, /REFERENCES/);
  fs.writeFileSync(path.join(dir, 'schema.sql'), schema);
  const file = (name) => path.join(dir, 'seeds', `${name}.csv`);
  const t_ = Object.fromEntries(TABLES.map((name) => [name, readCsv(file(name))]));
  const used = { invoices: new Set(), visits: new Set(), plans: new Set() };
  const take = (kind, id) => {
    assert.ok(!used[kind].has(id), `${kind} ${id} broken twice`);
    used[kind].add(id);
  };
  const edits = BREAKS.map((b) => [b.check, b.pick(t_, take, used)]);
  for (const [check, edit] of edits) if (only.includes(check)) edit();
  if (extra) extra(t_);
  for (const [name, table] of Object.entries(t_)) writeCsv(file(name), table);
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
  assert.deepEqual([byId['integrity-no-end-after-as-of'].outcome, byId['integrity-no-end-after-as-of'].rows], ['fail', 1]);
});
