'use strict';

// Story 7.2: plans, visits, invoices, payments and fixture_meta, and the
// planted known truths. Example tests (AD-1 carve-out): they read Brightside's
// own fixture and go with it in a fork.
//
// The known truths are recomputed here from the committed CSVs (unzipped), written
// straight from the definitions in fixture-tables.md, independently of the
// generator's lib/truths.js. Story 7.6 checks the same figures a third way, in
// SQL. Rule mutations and planting run on small seeds, for speed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { generate, readSeedConfig, readTargets, GENERATOR_VERSION } = require('../generate');
const { TABLES } = require('../lib/tables');
const { checkRules } = require('../lib/rules');
const { computeTruths, TRUTH_IDS } = require('../lib/truths');
const { buildReference, ZONES, HISTORY_START, AS_OF } = require('../lib/reference');
const { createRng } = require('../lib/prng');

const FIXTURE_DIR = path.join(__dirname, '..');
const SEEDS = path.join(FIXTURE_DIR, 'seeds');
const SMALL = { seed: 7, clients: 60 };
const ruleOpts = { zones: ZONES, historyStart: HISTORY_START, asOf: AS_OF };
const TEN_MB = 10 * 1024 * 1024;

// A committed seed's CSV text: seeds/<table>.csv.gz unzipped, else seeds/<table>.csv.
function seedText(name) {
  const gz = path.join(SEEDS, `${name}.csv.gz`);
  return fs.existsSync(gz) ? zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8') : fs.readFileSync(path.join(SEEDS, `${name}.csv`), 'utf8');
}

// Committed CSVs, typed from lib/tables.js (they never quote: a plain split is a full parse).
function loadCommitted() {
  const tables = {};
  for (const table of TABLES) {
    const lines = seedText(table.name).slice(0, -1).split('\n');
    const header = lines[0].split(',');
    const numeric = new Set(table.columns.filter((c) => c.type === 'INTEGER' || c.type === 'BIGINT').map((c) => c.name));
    tables[table.name] = lines.slice(1).map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(header.map((h, i) => {
        const v = cells[i];
        if (v === '') return [h, null];
        return [h, numeric.has(h) ? Number(v) : v];
      }));
    });
  }
  return tables;
}

let cache;
const committed = () => (cache ??= loadCommitted());

// Day arithmetic of its own, so these checks share no code with the generator.
const dayOf = (iso) => Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000);

// The seven known truths, straight from fixture-tables.md (Definitions).
function recompute(t) {
  const asOf = dayOf(AS_OF);
  const owner = new Map(t.properties.map((p) => [p.property_id, p.client_id]));
  // Plan active at d: start_date <= d AND (end_date IS NULL OR end_date >= d).
  const activeAt = (p, d) => dayOf(p.start_date) <= d && (p.end_date === null || dayOf(p.end_date) >= d);
  // Lapsed in the last 90 days: cancelled, end_date > as_of - 90 AND end_date <= as_of.
  const lapsed90 = (p) => p.status === 'cancelled' && dayOf(p.end_date) > asOf - 90 && dayOf(p.end_date) <= asOf;
  const winback = t.clients.filter((c) => {
    if (c.zone_id !== 'north') return false;
    const own = t.plans.filter((p) => owner.get(p.property_id) === c.client_id);
    return own.some(lapsed90) && !own.some((p) => activeAt(p, asOf));
  });
  // Price change before lapse: new > old, effective between end_date - 59 and end_date.
  const rose = (p) => t.plan_price_changes.some((ch) => ch.plan_id === p.plan_id && ch.new_price_cents > ch.old_price_cents
    && dayOf(ch.effective_date) >= dayOf(p.end_date) - 59 && dayOf(ch.effective_date) <= dayOf(p.end_date));
  const lapsedPlansOf = (c) => t.plans.filter((p) => owner.get(p.property_id) === c.client_id && lapsed90(p));
  const sept = (iso) => iso >= '2026-09-01' && iso <= '2026-09-30';
  const paidToDate = new Map();
  for (const pay of t.payments) {
    if (pay.paid_on <= AS_OF) paidToDate.set(pay.invoice_id, (paidToDate.get(pay.invoice_id) || 0) + pay.amount_cents);
  }
  let outstanding = 0;
  for (const inv of t.invoices) {
    const owed = inv.total_cents - (paidToDate.get(inv.invoice_id) || 0);
    if (owed > 0) outstanding += owed;
  }
  return {
    figures: {
      'clients-total': t.clients.filter((c) => c.created_on <= AS_OF).length,
      'active-plans-at-as-of': t.plans.filter((p) => activeAt(p, asOf)).length,
      'winback-north-90d': winback.length,
      'winback-north-90d-price-rise': winback.filter((c) => lapsedPlansOf(c).some(rose)).length,
      'paid-revenue-2026-09': t.payments.filter((p) => sept(p.paid_on)).reduce((s, p) => s + p.amount_cents, 0),
      'billed-revenue-2026-09': t.invoices.filter((i) => sept(i.issued_on)).reduce((s, i) => s + i.total_cents, 0),
      'outstanding-at-as-of': outstanding,
    },
    winback,
    lapsedPlansOf,
  };
}

test('the committed data hits every planted target in targets.json', () => {
  const targets = readTargets();
  assert.deepEqual(Object.keys(targets).sort(), TRUTH_IDS.slice().sort());
  const { figures } = recompute(committed());
  for (const id of TRUTH_IDS) assert.equal(figures[id], targets[id], id);
  // And the generator's own computation agrees.
  assert.deepEqual(computeTruths(committed(), { asOf: AS_OF }), figures);
});

test('the planted figures make the win-back demo worth running', () => {
  const targets = readTargets();
  const { winback, lapsedPlansOf } = recompute(committed());
  assert.ok(targets['winback-north-90d'] > 25, 'more candidates than the demo\'s top 25');
  const share = targets['winback-north-90d-price-rise'] / targets['winback-north-90d'];
  assert.ok(share > 0.25 && share < 0.75, 'a meaningful share, not all, had a price rise');
  // "The lapsed plan" is never ambiguous: one lapse per candidate in the window.
  for (const c of winback) assert.equal(lapsedPlansOf(c).length, 1, `client ${c.client_id}`);
  assert.ok(targets['billed-revenue-2026-09'] !== targets['paid-revenue-2026-09'], 'billed and paid differ');
  assert.ok(targets['outstanding-at-as-of'] > 0, 'some invoices are unpaid at as_of');
});

test('every integrity and synthetic-only rule holds in the committed files', () => {
  assert.deepEqual(checkRules(committed(), ruleOpts), []);
});

test('the activity is realistic within the rules', () => {
  const t = committed();
  const count = (rows, f) => rows.filter(f).length;
  for (const f of ['weekly', 'biweekly', 'monthly']) assert.ok(count(t.plans, (p) => p.frequency === f) > 100, f);
  assert.ok(count(t.plans, (p) => p.status === 'active') > 500 && count(t.plans, (p) => p.status === 'cancelled') > 500);
  assert.ok(count(t.visits, (v) => v.status === 'cancelled') > 1000, 'some visits are cancelled');
  assert.ok(count(t.visits, (v) => v.plan_id === null) > 1000, 'some visits are one-offs');
  assert.ok(count(t.invoice_lines, (l) => l.add_on_id !== null) > 1000, 'some invoices carry add-ons');
  assert.ok(count(t.plan_price_changes, (c) => c.new_price_cents < c.old_price_cents) > 10, 'some price changes are cuts');
  assert.ok(count(t.payments, (p) => p.method === 'ach') > 1000 && count(t.payments, (p) => p.method === 'card') > 1000);
  const paymentsPer = new Map();
  for (const p of t.payments) paymentsPer.set(p.invoice_id, (paymentsPer.get(p.invoice_id) || 0) + 1);
  assert.ok([...paymentsPer.values()].filter((n) => n > 1).length > 500, 'partial payments');
  const unpaid = count(t.invoices, (i) => !paymentsPer.has(i.invoice_id));
  assert.ok(unpaid > 100 && unpaid < t.invoices.length / 10, 'some, not many, invoices are unpaid');
  // History spans the whole window.
  const dates = t.visits.map((v) => v.visit_date).sort();
  assert.ok(dates[0] >= HISTORY_START && dates[0] < '2024-10-08');
  assert.ok(dates[dates.length - 1] > '2026-09-20' && dates[dates.length - 1] <= AS_OF);
});

test('fixture_meta records the version, seed, as_of and each table\'s row count', () => {
  const t = committed();
  const meta = Object.fromEntries(t.fixture_meta.map((m) => [m.key, m.value]));
  const config = readSeedConfig();
  assert.equal(meta.generator_version, String(GENERATOR_VERSION));
  assert.equal(config.generator_version, GENERATOR_VERSION, 'seed.json records the generator version');
  assert.equal(meta.seed, String(config.seed));
  assert.equal(meta.as_of, '2026-09-30');
  assert.equal(meta.history_start, '2024-10-01');
  for (const table of TABLES) {
    if (table.name !== 'fixture_meta') assert.equal(meta[`rows_${table.name}`], String(t[table.name].length), table.name);
  }
});

// The size on disk, so compressed: seeds/*.csv.gz count at their gzip size.
test('the committed seed files total under 10 MB', () => {
  const files = fs.readdirSync(SEEDS).map((f) => path.join(SEEDS, f)).concat(path.join(FIXTURE_DIR, 'schema.sql'));
  const bytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  assert.ok(bytes < TEN_MB, `${bytes} bytes`);
});

test('a small seed is deterministic and passes every rule, unplanted', () => {
  const a = generate(SMALL);
  const b = generate(SMALL);
  for (const table of TABLES) assert.equal(a.files.get(`seeds/${table.name}.csv`), b.files.get(`seeds/${table.name}.csv`), table.name);
  assert.ok(a.tables.visits.length > 500 && a.tables.payments.length > 500);
  assert.deepEqual(checkRules(a.tables, ruleOpts), []);
  assert.notEqual(generate({ ...SMALL, seed: 8 }).files.get('seeds/visits.csv'), a.files.get('seeds/visits.csv'));
});

test('planting hits targets above and below the natural figures, deterministically', () => {
  const base = { seed: 11, clients: 400 };
  const natural = computeTruths(generate(base).tables, { asOf: AS_OF });
  assert.ok(natural['winback-north-90d'] >= 3 && natural['winback-north-90d-price-rise'] >= 1, JSON.stringify(natural));
  const shifts = [
    { 'active-plans-at-as-of': 4, 'winback-north-90d': 3, 'winback-north-90d-price-rise': 2, 'paid-revenue-2026-09': 6789, 'billed-revenue-2026-09': 12345, 'outstanding-at-as-of': -4321 },
    { 'active-plans-at-as-of': -4, 'winback-north-90d': -1, 'winback-north-90d-price-rise': -1, 'paid-revenue-2026-09': -789, 'billed-revenue-2026-09': -2345, 'outstanding-at-as-of': 1234 },
  ];
  for (const shift of shifts) {
    const targets = { 'clients-total': base.clients };
    for (const id of TRUTH_IDS) if (id !== 'clients-total') targets[id] = natural[id] + shift[id];
    const run = generate({ ...base, targets });
    assert.deepEqual(computeTruths(run.tables, { asOf: AS_OF }), targets);
    assert.deepEqual(checkRules(run.tables, ruleOpts), []);
    assert.equal(generate({ ...base, targets }).files.get('seeds/payments.csv'), run.files.get('seeds/payments.csv'));
  }
});

test('an unreachable target fails loudly instead of writing', () => {
  const base = { seed: 11, clients: 400 };
  const natural = computeTruths(generate(base).tables, { asOf: AS_OF });
  assert.throws(() => generate({ ...base, targets: { ...natural, 'winback-north-90d': 5000 } }), /cannot plant winback-north-90d/);
  assert.throws(() => generate({ ...base, targets: { ...natural, 'clients-total': 401 } }), /cannot plant clients-total/);
  assert.throws(() => generate({ ...base, generator_version: GENERATOR_VERSION - 1 }), /generator_version/);
});

test('the rule check catches each broken activity rule once', () => {
  const { tables } = generate(SMALL);
  assert.deepEqual(checkRules(tables, ruleOpts), []);
  const broken = (mutate) => {
    const copy = JSON.parse(JSON.stringify(tables));
    mutate(copy);
    // Keep the row counts true, so only the broken rule reports.
    for (const m of copy.fixture_meta) if (m.key.startsWith('rows_')) m.value = String(copy[m.key.slice(5)].length);
    return checkRules(copy, ruleOpts);
  };
  const first = (rows, f, what) => {
    const row = rows.find(f);
    assert.ok(row, `the small seed has ${what}`);
    return row;
  };
  const invoiceOf = (t, v) => t.invoices.find((i) => i.visit_id === v.visit_id);
  const paidOf = (t, inv) => t.payments.filter((p) => p.invoice_id === inv.invoice_id).reduce((s, p) => s + p.amount_cents, 0);
  const cases = [
    // Foreign keys resolve; no orphans.
    [(t) => { t.payments[0].invoice_id = 999999; }, /has no invoices row/],
    [(t) => { t.visits[0].plan_id = 999999; }, /has no plans row/],
    [(t) => {
      const inv = first(t.invoices, (i) => paidOf(t, i) === 0, 'an unpaid invoice');
      t.invoice_lines = t.invoice_lines.filter((l) => l.invoice_id !== inv.invoice_id);
    }, /has no lines/],
    // Invoice total equals the sum of its lines.
    [(t) => { t.invoices[0].total_cents += 1; }, /is not the sum of its lines/],
    // Payments never exceed their invoice.
    [(t) => { const p = t.payments[0]; p.amount_cents += t.invoices.find((i) => i.invoice_id === p.invoice_id).total_cents; }, /exceed the total/],
    // One invoice per completed visit, none for cancelled.
    [(t) => { first(t.visits, (v) => v.status === 'cancelled', 'a cancelled visit').status = 'completed'; }, /completed but not invoiced/],
    [(t) => { first(t.visits, (v) => v.status === 'completed', 'a completed visit').status = 'cancelled'; }, /cancelled but invoiced/],
    [(t) => {
      // A second, well-formed invoice for an invoiced visit.
      const inv = t.invoices[0];
      t.invoices.push({ ...inv, invoice_id: 99999 });
      for (const l of t.invoice_lines.filter((x) => x.invoice_id === inv.invoice_id)) t.invoice_lines.push({ ...l, line_id: l.line_id + 900000, invoice_id: 99999 });
    }, /visit_id.*is not unique/],
    // Plan visits fall inside the plan's active period.
    [(t) => {
      const ended = new Map(t.plans.filter((p) => p.end_date !== null && p.end_date < AS_OF).map((p) => [p.plan_id, p]));
      const v = first(t.visits, (x) => x.status === 'cancelled' && ended.has(x.plan_id), 'a cancelled visit on an ended plan');
      v.visit_date = AS_OF;
    }, /outside plan \d+'s active period/],
    // status agrees with end_date; no end_date after as_of.
    [(t) => { first(t.plans, (p) => p.status === 'active', 'an active plan').status = 'cancelled'; }, /disagrees with end_date/],
    [(t) => { first(t.plans, (p) => p.status === 'cancelled', 'a cancelled plan').end_date = '2026-10-15'; }, /is after as_of/],
    // price_cents equals the latest change's new price (or start_price_cents).
    [(t) => { t.plans[0].price_cents += 100; }, /is not the latest price/],
    [(t) => {
      const once = t.plan_price_changes.filter((c) => t.plan_price_changes.filter((o) => o.plan_id === c.plan_id).length === 1);
      first(once, () => true, 'a plan with one change').old_price_cents += 100;
    }, /is not the price before it/],
    [(t) => {
      // A second change on the same day, chained correctly, breaks only uniqueness.
      const c = first(t.plan_price_changes, (x) => t.plan_price_changes.filter((o) => o.plan_id === x.plan_id).length === 1, 'a plan with one change');
      t.plan_price_changes.push({ ...c, change_id: 99999, old_price_cents: c.new_price_cents, new_price_cents: c.new_price_cents + 100 });
      t.plans.find((p) => p.plan_id === c.plan_id).price_cents = c.new_price_cents + 100;
    }, /\(plan_id, effective_date\).*is not unique/],
    // Lines, payments and visits stay well formed.
    [(t) => { first(t.invoice_lines, (l) => l.add_on_id !== null, 'an add-on line').add_on_id = null; }, /exactly one of package_id and add_on_id/],
    [(t) => { t.payments[0].paid_on = '2026-10-01'; }, /paid after as_of/],
    [(t) => { t.payments[0].method = 'cash'; }, /is not card or ach/],
    [(t) => {
      const v = first(t.visits, (x) => x.plan_id === null && x.status === 'cancelled', 'a cancelled one-off');
      const zone = t.clients.find((c) => c.client_id === t.properties.find((p) => p.property_id === v.property_id).client_id).zone_id;
      v.crew_id = t.crews.find((c) => c.zone_id !== zone).crew_id;
    }, /is not in the property's zone/],
    [(t) => { const inv = t.invoices[0]; inv.client_id = t.clients.find((c) => c.client_id !== inv.client_id).client_id; }, /is not visit \d+'s client/],
  ];
  for (const [mutate, expected] of cases) {
    const problems = broken(mutate);
    assert.equal(problems.length, 1, `${expected}: ${problems.join('; ')}`);
    assert.match(problems[0], expected);
  }
  // A stale row count is caught (the helper above keeps counts true, so break it here).
  const copy = JSON.parse(JSON.stringify(tables));
  copy.fixture_meta.find((m) => m.key === 'rows_visits').value = '1';
  const problems = checkRules(copy, ruleOpts);
  assert.equal(problems.length, 1, problems.join('; '));
  assert.match(problems[0], /fixture_meta: rows_visits is not/);
});

// Only the columns the reference build writes: the operations build appends
// columns to crew_memberships and properties (checked in operations.test.js).
const project = (rows, like) => rows.map((r) => Object.fromEntries(Object.keys(like[0]).map((k) => [k, r[k]])));

test('activity draws come after the reference draws, so the reference rows are unchanged', () => {
  const reference = buildReference(createRng(SMALL.seed), { clients: SMALL.clients });
  const { tables } = generate(SMALL);
  for (const name of Object.keys(reference)) assert.deepEqual(project(tables[name], reference[name]), reference[name], name);
});
