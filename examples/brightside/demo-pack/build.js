'use strict';

// The v0 demo pack (plan brightside-v1, D4; Story 18.3, rebuilt around three
// business questions): two PDFs and three CSVs an admin uploads to
// /brightside-v0's Add context, so the blank bot can then answer the three
// questions of the v0 script (docs/runtime/demo-script.md, "Stage 1: v0").
// Each question needs a PDF and a CSV together: the policy or plan in the
// PDF, the numbers in the CSV.
//
//   npm run demo-pack              build the five files here and print the
//                                  questions with their expected answers
//   npm run demo-pack -- --check   build in memory; exit 1 if a committed
//                                  file differs (nothing is written)
//
// Every figure comes from the fixture's committed seeds
// (examples/brightside/fixture/seeds, as_of 2026-09-30), read here without
// DuckDB, so the files agree with the data. Nothing about a person: the CSVs
// are aggregates (no client name, email, phone or address), and the PDFs'
// author is invented.
//
// The files and their methods, pinned:
//   - 2026-mid-year-pricing-and-operations-memo.pdf: the ops manager's June memo.
//     It announces the July 1 price increase (its range and average from the
//     increases effective 2026-07-01), gives the reasons (staff time on site
//     over scheduled in January to May, from completed visits' timesheets),
//     expects at most MEMO_EXPECTED_EXTRA extra cancellations, pins how the
//     increase is judged (question 1's method), sets the schedule standard
//     (SCHEDULE_STANDARD_PCT) and lists `packages` and `add_ons` prices.
//   - customer-service-agreement-2026.pdf: the customer terms. Net NET_DAYS
//     (checked on every invoice), invoiced on the visit day (checked), the
//     payment methods in `payments.method`, the late fee
//     (LATE_FEE_BASIS_POINTS a month past LATE_FEE_AFTER_DAYS days),
//     rescheduling, cancelling a plan, arrival windows, packages, crew-out.
//   - plan-changes-2026.csv, one row per month, January to as_of's month:
//     price increases (plan_price_changes with new > old, by
//     effective_date) and their mean % increase; plans cancelled (status
//     'cancelled', by end_date) and their yearly value (price_cents x
//     VISITS_PER_YEAR[frequency]); plans active at month end (MET-001: start
//     on or before, no end or end on or after); of the month's increases,
//     those on plans active at as_of and the yearly value they add
//     ((new - old) x visits a year).
//   - receivables-aging-2026-09-30.csv, per client zone plus an "All zones"
//     row: open invoices at as_of (MET-005: total minus payments made on or
//     before as_of, where above zero), the open balance by days past due
//     (as_of - due_on: current is 0 or less, then 1-30, 31-60, 61-90, over
//     90), past due, over 30 days past due and their invoice count. The
//     total must equal the signed truth outstanding-at-as-of.
//   - crew-time-vs-schedule-2026-09.csv, per crew of completed visits in
//     as_of's month: one timesheet row per staff member per visit (checked);
//     scheduled staff-minutes = each row's visit.scheduled_minutes; actual =
//     timesheets.minutes; % over = actual / scheduled - 1; wages for time
//     over schedule = sum of (minutes - scheduled) x the staff member's rate
//     on the visit date (pay_rates, else staff.hourly_rate_cents) / 60, net:
//     early finishes count against overruns, as both are paid time.
//
// Question 1's method (also in the memo, section 3): extra cancellations =
// July to September cancellations - 3 x the January to June monthly average;
// their yearly value likewise from the cancelled plans' yearly value; the
// gain = the July increases' yearly value on plans still active at as_of.
// It paid off if the gain is more than the extra cancellations' value.
//
// Checks, each failing the build: the truths (active plans, outstanding);
// net 14 and same-day invoicing; no tie at the top or bottom of any ranking
// a question uses; the memo's expectation is clearly missed or beaten; no
// crew sits within STANDARD_MARGIN_PCT of the standard; each CSV passes Add
// context's readCsv; each file's text, as pdfExtract reads it from the PDF
// bytes, fits the store's 6,000 file cap, and the five fit in MAX_PACK_CHARS
// (under the hub's 15,000, leaving room for each note's title and wrapper).
// Deterministic: the same seeds give the same bytes.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  writePdf, pdfExtract, paginate, TEXT_WIDTH,
} = require('./pdf');
const { readCsv } = require('../../../kit/runtime/slack/files');
const { promptChars, CAPS } = require('../../../kit/runtime/knowledge/store');

const HERE = __dirname;
const FIXTURE = path.join(HERE, '..', 'fixture');
const SEEDS = path.join(FIXTURE, 'seeds');
const VISITS_PER_YEAR = Object.freeze({ weekly: 52, biweekly: 26, monthly: 12 });
const FREQUENCY_WORDS = Object.freeze({ weekly: 'Weekly', biweekly: 'Every two weeks', monthly: 'Monthly' });
const PAYMENT_WORDS = Object.freeze({ card: 'card', ach: 'bank transfer (ACH)' });
const BASELINE_MONTHS = 6; // January to June
const INCREASE_MONTH = '2026-07';
const AFTER_MONTHS = Object.freeze(['2026-07', '2026-08', '2026-09']);
const INCREASE_DAY = '2026-07-01';
const MEMO_DATE = 'June 12, 2026';
const MEMO_DATA_END = '2026-06-01'; // the memo's "January to May" (exclusive)
// Policies the documents set (not figures from the data).
const MEMO_EXPECTED_EXTRA = 20;
const SCHEDULE_STANDARD_PCT = 8;
const STANDARD_MARGIN_PCT = 0.3;
const NET_DAYS = 14;
const LATE_FEE_BASIS_POINTS = 150; // 1.5% a month
const LATE_FEE_AFTER_DAYS = 30;
const OFFICE_PHONE = '555-0100'; // GRD-007's synthetic range
const AUTHOR = 'Morgan Ellery';
// The five files' text, escaped as the knowledge store measures it.
const MAX_PACK_CHARS = 13000;

const FILES = Object.freeze({
  memo: '2026-mid-year-pricing-and-operations-memo.pdf',
  agreement: 'customer-service-agreement-2026.pdf',
  planChanges: 'plan-changes-2026.csv',
  aging: 'receivables-aging-2026-09-30.csv',
  crewTime: 'crew-time-vs-schedule-2026-09.csv',
});
// Files an earlier pack held; the build deletes them when it writes.
const RETIRED = Object.freeze([
  'price-list-2026.pdf', 'service-policies.pdf', 'zone-billing-2026-09.csv', 'complaints-2026-09.csv',
]);

class DemoPackError extends Error {}

// A committed seed's rows as objects. The seeds hold no quoted fields; one
// that does is refused rather than split wrongly.
function readSeedRows(table) {
  const text = zlib.gunzipSync(fs.readFileSync(path.join(SEEDS, `${table}.csv.gz`))).toString('utf8');
  if (text.includes('"')) throw new DemoPackError(`seeds/${table}: a quoted field; this reader takes plain fields only`);
  const [header, ...lines] = text.split('\n').filter(Boolean);
  const cols = header.split(',');
  return lines.map((line) => {
    const f = line.split(',');
    if (f.length !== cols.length) throw new DemoPackError(`seeds/${table}: a row with ${f.length} fields, not ${cols.length}`);
    return Object.fromEntries(cols.map((c, i) => [c, f[i]]));
  });
}

function readMeta() {
  const lines = fs.readFileSync(path.join(SEEDS, 'fixture_meta.csv'), 'utf8').split('\n').filter(Boolean).slice(1);
  return Object.fromEntries(lines.map((l) => l.split(',')));
}

// --- formatting ---------------------------------------------------------

const sign = (n) => (n < 0 ? '-' : '');
// Cents as dollars: -2600 -> "-26.00" (CSV); money() -> "$26.00" with commas.
const dollars = (cents) => `${sign(cents)}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const money = (cents) => `${sign(cents)}$${Math.trunc(Math.abs(cents) / 100).toLocaleString('en-US')}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const count = (n) => n.toLocaleString('en-US');
// One decimal, half away from zero on the exact value.
const oneDp = (x) => (Math.round(x * 10 + (x >= 0 ? 1e-9 : -1e-9)) / 10).toFixed(1);
const csvText = (rows) => `${rows.map((r) => r.join(',')).join('\n')}\n`;
const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
const monthEnd = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
const longDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
  timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
});

// The single top entry of [[name, value], ...] by value, or a DemoPackError
// naming the tie. Compare displayed values, so a tie on the page is a tie.
function singleTop(pairs, what) {
  const sorted = [...pairs].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) throw new DemoPackError(`${what}: nothing to rank`);
  if (sorted.length > 1 && sorted[1][1] === sorted[0][1]) {
    throw new DemoPackError(`${what}: a tie at the top (${sorted[0][0]} and ${sorted[1][0]}, ${sorted[0][1]} each)`);
  }
  return sorted[0];
}
const singleBottom = (pairs, what) => {
  const [name, value] = singleTop(pairs.map(([n, v]) => [n, -v]), `${what} (lowest)`);
  return [name, -value];
};

function readFixture() {
  const targets = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'targets.json'), 'utf8')).truths;
  const meta = readMeta();
  if (!/^\d{4}-\d\d-\d\d$/.test(meta.as_of || '')) throw new DemoPackError('fixture_meta has no as_of');
  return {
    targets,
    asOf: meta.as_of,
    zones: readSeedRows('zones'),
    packages: readSeedRows('packages'),
    addOns: readSeedRows('add_ons'),
    crews: readSeedRows('crews'),
    clients: readSeedRows('clients'),
    invoices: readSeedRows('invoices'),
    payments: readSeedRows('payments'),
    visits: readSeedRows('visits'),
    timesheets: readSeedRows('timesheets'),
    payRates: readSeedRows('pay_rates'),
    staff: readSeedRows('staff'),
    plans: readSeedRows('plans'),
    priceChanges: readSeedRows('plan_price_changes'),
  };
}

// --- question 1: plan changes ---------------------------------------------

const yearlyCents = (priceCents, frequency) => {
  const n = VISITS_PER_YEAR[frequency];
  if (!n) throw new DemoPackError(`a plan with an unknown frequency ${frequency}`);
  return Number(priceCents) * n;
};
// MET-001: running on the day.
const activeOn = (plan, iso) => plan.start_date <= iso && (!plan.end_date || plan.end_date >= iso);

function planChanges({
  plans, priceChanges, asOf, targets,
}) {
  const planBy = new Map(plans.map((p) => [p.plan_id, p]));
  const year = asOf.slice(0, 4);
  const months = [];
  for (let m = 1; m <= Number(asOf.slice(5, 7)); m += 1) months.push(`${year}-${String(m).padStart(2, '0')}`);
  if (months.length !== BASELINE_MONTHS + AFTER_MONTHS.length || months.at(-1) !== AFTER_MONTHS.at(-1)) {
    throw new DemoPackError(`as_of ${asOf}: question 1 needs January to September ${year}`);
  }
  const increases = priceChanges.filter((c) => Number(c.new_price_cents) > Number(c.old_price_cents));
  const rows = months.map((ym) => {
    const inc = increases.filter((c) => c.effective_date.startsWith(ym));
    const pct = inc.map((c) => ((Number(c.new_price_cents) - Number(c.old_price_cents)) / Number(c.old_price_cents)) * 100);
    const cancelled = plans.filter((p) => p.status === 'cancelled' && (p.end_date || '').startsWith(ym));
    let stayed = 0;
    let added = 0;
    for (const c of inc) {
      const plan = planBy.get(c.plan_id);
      if (!plan) throw new DemoPackError(`price change ${c.change_id}: no plan ${c.plan_id}`);
      if (!activeOn(plan, asOf)) continue;
      stayed += 1;
      added += yearlyCents(Number(c.new_price_cents) - Number(c.old_price_cents), plan.frequency);
    }
    const end = monthEnd(ym);
    return {
      month: ym,
      increases: inc.length,
      avgPct: inc.length ? pct.reduce((s, x) => s + x, 0) / inc.length : null,
      cancelled: cancelled.length,
      cancelledValue: cancelled.reduce((s, p) => s + yearlyCents(p.price_cents, p.frequency), 0),
      active: plans.filter((p) => activeOn(p, end > asOf ? asOf : end)).length,
      stayed,
      added,
    };
  });
  if (rows.at(-1).active !== targets['active-plans-at-as-of']) {
    throw new DemoPackError(`active plans at ${asOf} ${rows.at(-1).active} is not the truth active-plans-at-as-of (${targets['active-plans-at-as-of']})`);
  }
  const header = ['Month', 'Price increases', 'Average increase (%)', 'Plans cancelled', 'Yearly value of cancelled plans ($)',
    'Active plans at month end', `Increased plans still active on ${asOf}`, 'Yearly value added on those plans ($)'];
  const text = csvText([header, ...rows.map((r) => [r.month, String(r.increases), r.avgPct === null ? '' : oneDp(r.avgPct),
    String(r.cancelled), dollars(r.cancelledValue), String(r.active), String(r.stayed), dollars(r.added)])]);

  // Question 1's method (see the header).
  const base = rows.slice(0, BASELINE_MONTHS);
  const after = rows.filter((r) => AFTER_MONTHS.includes(r.month));
  const july = rows.find((r) => r.month === INCREASE_MONTH);
  const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0);
  const scale = AFTER_MONTHS.length / BASELINE_MONTHS;
  const baseAvg = sum(base, 'cancelled') / BASELINE_MONTHS;
  const extra = sum(after, 'cancelled') - sum(base, 'cancelled') * scale;
  const extraValue = Math.round(sum(after, 'cancelledValue') - sum(base, 'cancelledValue') * scale);
  if (!Number.isInteger(extra * 10)) throw new DemoPackError(`question 1: ${extra} extra cancellations is not a whole tenth`);
  if (!(extra >= 2 * MEMO_EXPECTED_EXTRA || extra <= MEMO_EXPECTED_EXTRA / 2)) {
    throw new DemoPackError(`question 1: ${extra} extra cancellations is too close to the memo's ${MEMO_EXPECTED_EXTRA} to be clear`);
  }
  const net = july.added - extraValue;
  if (Math.abs(net) < 0.1 * Math.max(july.added, extraValue)) throw new DemoPackError(`question 1: the gain and the loss are too close (${net})`);

  // The memo's own figures, for the increases it announces (effective July 1).
  const announced = increases.filter((c) => c.effective_date === INCREASE_DAY);
  if (!announced.length) throw new DemoPackError(`no price increases on ${INCREASE_DAY}`);
  const aPct = announced.map((c) => ((Number(c.new_price_cents) - Number(c.old_price_cents)) / Number(c.old_price_cents)) * 100);
  const announcedValue = announced.reduce((s, c) => s + yearlyCents(Number(c.new_price_cents) - Number(c.old_price_cents), planBy.get(c.plan_id).frequency), 0);
  return {
    rows,
    text,
    q1: {
      afterCancelled: sum(after, 'cancelled'),
      baseAvg,
      extra,
      extraValue,
      gain: july.added,
      stayed: july.stayed,
      july,
      net,
    },
    memo: {
      minPct: Math.floor(Math.min(...aPct)),
      maxPct: Math.ceil(Math.max(...aPct)),
      avgPct: Math.round(aPct.reduce((s, x) => s + x, 0) / aPct.length),
      // To the nearest $1,000.
      ifAllStay: Math.round(announcedValue / 100000) * 100000,
    },
  };
}

// --- question 2: receivables aging -----------------------------------------

const BUCKETS = Object.freeze([
  ['current', 'Not yet due ($)', (d) => d <= 0],
  ['d1', '1-30 days past due ($)', (d) => d >= 1 && d <= 30],
  ['d31', '31-60 days past due ($)', (d) => d >= 31 && d <= 60],
  ['d61', '61-90 days past due ($)', (d) => d >= 61 && d <= 90],
  ['d90', 'Over 90 days past due ($)', (d) => d > 90],
]);

function receivables({
  zones, clients, invoices, payments, visits, asOf, targets,
}) {
  const visitDay = new Map(visits.map((v) => [v.visit_id, v.visit_date]));
  for (const i of invoices) {
    if (day(i.due_on) - day(i.issued_on) !== NET_DAYS) throw new DemoPackError(`invoice ${i.invoice_id} is not net ${NET_DAYS}`);
    if (visitDay.get(i.visit_id) !== i.issued_on) throw new DemoPackError(`invoice ${i.invoice_id} is not issued on its visit's day`);
  }
  const zoneOf = new Map(clients.map((c) => [c.client_id, c.zone_id]));
  const paid = new Map();
  for (const p of payments) {
    if (p.paid_on <= asOf) paid.set(p.invoice_id, (paid.get(p.invoice_id) || 0) + Number(p.amount_cents));
  }
  const blank = (name) => ({
    name, open: 0, n: 0, over30n: 0, ...Object.fromEntries(BUCKETS.map(([k]) => [k, 0])),
  });
  const by = new Map(zones.map((z) => [z.zone_id, blank(z.name)]));
  const all = blank('All zones');
  for (const i of invoices) {
    if (i.issued_on > asOf) continue;
    const balance = Number(i.total_cents) - (paid.get(i.invoice_id) || 0);
    if (balance <= 0) continue;
    const row = by.get(zoneOf.get(i.client_id));
    if (!row) throw new DemoPackError(`invoice ${i.invoice_id}: client ${i.client_id} has no known zone`);
    const late = day(asOf) - day(i.due_on);
    const [bucket] = BUCKETS.find(([, , fits]) => fits(late));
    for (const r of [row, all]) {
      r.open += balance;
      r.n += 1;
      r[bucket] += balance;
      if (late > LATE_FEE_AFTER_DAYS) r.over30n += 1;
    }
  }
  if (all.open !== targets['outstanding-at-as-of']) {
    throw new DemoPackError(`open total ${all.open} is not the truth outstanding-at-as-of (${targets['outstanding-at-as-of']})`);
  }
  const rows = [...by.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const r of [...rows, all]) {
    r.pastDue = r.open - r.current;
    r.over30 = r.d31 + r.d61 + r.d90;
  }
  const header = ['Zone', 'Open invoices', ...BUCKETS.map(([, label]) => label), 'Total open ($)', 'Past due ($)',
    `Over ${LATE_FEE_AFTER_DAYS} days past due ($)`, `Invoices over ${LATE_FEE_AFTER_DAYS} days past due`];
  const line = (r) => [r.name, String(r.n), ...BUCKETS.map(([k]) => dollars(r[k])), dollars(r.open), dollars(r.pastDue),
    dollars(r.over30), String(r.over30n)];
  // Half up to the cent.
  const fee = Math.floor((all.over30 * LATE_FEE_BASIS_POINTS + 5000) / 10000);
  return {
    rows, all, fee, text: csvText([header, ...rows.map(line), line(all)]),
  };
}

// --- question 3: crew time against schedule --------------------------------

function crewTime({
  crews, zones, visits, timesheets, payRates, staff, asOf,
}) {
  const ym = asOf.slice(0, 7);
  const month = new Map(visits.filter((v) => v.status === 'completed' && v.visit_date.startsWith(ym)).map((v) => [v.visit_id, v]));
  const zoneName = new Map(zones.map((z) => [z.zone_id, z.name]));
  const staffRate = new Map(staff.map((s) => [s.staff_id, Number(s.hourly_rate_cents)]));
  const ratesBy = new Map();
  for (const r of payRates) {
    if (!ratesBy.has(r.staff_id)) ratesBy.set(r.staff_id, []);
    ratesBy.get(r.staff_id).push(r);
  }
  const rateOn = (staffId, iso) => {
    const r = (ratesBy.get(staffId) || []).find((x) => x.start_date <= iso && (!x.end_date || x.end_date >= iso));
    if (r) return Number(r.hourly_rate_cents);
    if (!staffRate.has(staffId)) throw new DemoPackError(`staff ${staffId}: no pay rate`);
    return staffRate.get(staffId);
  };
  const by = new Map(crews.map((c) => [c.crew_id, {
    name: c.name, zone: zoneName.get(c.zone_id), visits: new Set(), scheduled: 0, actual: 0, costCentMinutes: 0,
  }]));
  const seen = new Set();
  for (const t of timesheets) {
    const v = month.get(t.visit_id);
    if (!v) continue;
    const key = `${t.visit_id}/${t.staff_id}`;
    if (seen.has(key)) throw new DemoPackError(`visit ${t.visit_id}: two timesheet rows for staff ${t.staff_id}`);
    seen.add(key);
    const crew = by.get(v.crew_id);
    if (!crew || !crew.zone) throw new DemoPackError(`visit ${v.visit_id}: unknown crew ${v.crew_id}`);
    const sched = Number(v.scheduled_minutes);
    crew.visits.add(v.visit_id);
    crew.scheduled += sched;
    crew.actual += Number(t.minutes);
    crew.costCentMinutes += (Number(t.minutes) - sched) * rateOn(t.staff_id, v.visit_date);
  }
  const rows = [...by.values()].filter((c) => c.visits.size).map((c) => ({
    ...c,
    visits: c.visits.size,
    pct: oneDp(((c.actual - c.scheduled) / c.scheduled) * 100),
    cost: Math.round(c.costCentMinutes / 60),
  })).sort((a, b) => a.zone.localeCompare(b.zone, 'en') || a.name.localeCompare(b.name, 'en'));
  if (!rows.length) throw new DemoPackError(`no completed visits in ${ym}`);
  for (const r of rows) {
    if (Math.abs(Number(r.pct) - SCHEDULE_STANDARD_PCT) < STANDARD_MARGIN_PCT) {
      throw new DemoPackError(`${r.name} is ${r.pct}% over, too close to the ${SCHEDULE_STANDARD_PCT}% standard to be clear`);
    }
  }
  const header = ['Crew', 'Zone', 'Completed visits', 'Scheduled staff-minutes', 'Actual staff-minutes', 'Over schedule (%)',
    'Wages for time over schedule ($)'];
  return {
    rows,
    text: csvText([header, ...rows.map((r) => [r.name, r.zone, String(r.visits), String(r.scheduled), String(r.actual), r.pct, dollars(r.cost)])]),
  };
}

// Staff time on site over scheduled, company-wide, completed visits in
// [from, to): the memo's "visits running long".
function overrunPct({ visits, timesheets }, from, to) {
  const inRange = new Map(visits.filter((v) => v.status === 'completed' && v.visit_date >= from && v.visit_date < to)
    .map((v) => [v.visit_id, Number(v.scheduled_minutes)]));
  let scheduled = 0;
  let actual = 0;
  for (const t of timesheets) {
    if (!inRange.has(t.visit_id)) continue;
    scheduled += inRange.get(t.visit_id);
    actual += Number(t.minutes);
  }
  if (!scheduled) throw new DemoPackError(`no completed visits from ${from} to ${to}`);
  return oneDp(((actual - scheduled) / scheduled) * 100);
}

// --- the PDFs ---------------------------------------------------------------

const WRAP_EM = 0.5; // a conservative mean Helvetica width, per em
function wrap(text, { size = 11, x = 0 } = {}) {
  const max = Math.floor((TEXT_WIDTH - x) / (size * WRAP_EM));
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
const para = (text, opts = {}) => wrap(text, opts).map((t) => ({ text: t, size: opts.size, x: opts.x }));
const bullet = (text) => wrap(`- ${text}`, { x: 8 }).map((t, i) => (i ? { text: t, x: 16 } : { text: t, x: 8 }));
// columns: [{ header, x, right? }]; rows: arrays of strings.
const table = (columns, rows, size = 10.5) => [
  { rule: true, size },
  // A header holds words, so a right-aligned column's header ends near x, by
  // an estimate of its width.
  {
    cells: columns.map((c) => ({ text: c.header, x: c.right ? Math.max(0, c.x - c.header.length * size * 0.5) : c.x })),
    size,
    bold: true,
  },
  { rule: true, size },
  ...rows.map((r) => ({ cells: columns.map((c, i) => ({ text: r[i], x: c.x, right: c.right })), size })),
  { rule: true, size },
];
const letterhead = (kind) => [
  { cells: [{ text: 'BRIGHTSIDE HOME CLEANING', x: 0 }, { text: kind, x: 330 }], size: 15, bold: true },
  { text: `Home and move-out cleaning | Centerpoint office | ${OFFICE_PHONE}`, size: 9 },
  { rule: true, size: 9 },
];

// A section: its heading and body, kept together on one page.
const section = (title, ...items) => [{ text: '' }, { text: title, size: 12.5, bold: true }, ...items.flat()];

function memoBlocks(data, plan, crew) {
  const { packages, addOns } = data;
  const m = plan.memo;
  const long = overrunPct(data, `${data.asOf.slice(0, 4)}-01-01`, MEMO_DATA_END);
  if (!crew.rows.some((r) => Number(r.pct) > SCHEDULE_STANDARD_PCT)) throw new DemoPackError('no crew breaks the schedule standard');
  const ifAllStay = money(m.ifAllStay).replace(/\.00$/, '');
  return [
    [
      ...letterhead('INTERNAL MEMO'),
      { text: '' },
      { cells: [{ text: 'To:', x: 0, bold: true }, { text: 'Office team and crew leads', x: 60 }] },
      { cells: [{ text: 'From:', x: 0, bold: true }, { text: `${AUTHOR}, Operations Manager`, x: 60 }] },
      { cells: [{ text: 'Date:', x: 0, bold: true }, { text: MEMO_DATE, x: 60 }] },
      { cells: [{ text: 'Subject:', x: 0, bold: true }, { text: 'Mid-year pricing and operations', x: 60 }] },
      { rule: true },
    ],
    section('1. Summary', para(`From July 1 we are raising the price of our recurring cleaning plans, by about ${m.avgPct}% `
      + 'on average. We are also setting a standard for how closely crews keep to scheduled time. This memo explains '
      + 'both, says how we will judge the increase at the end of September, and lists our current prices.')),
    section(
      '2. The July price increase',
      para(`What changes. On July 1 most plans' price per visit goes up by ${m.minPct}% to ${m.maxPct}%, depending on `
        + `the package and the home: about ${m.avgPct}% on average. A plan that renews later in July changes on its `
        + 'renewal date. Every customer gets written notice by June 16, as our service agreement requires.'),
      { text: '' },
      { text: 'Why. Our costs have risen faster than our prices:' },
      bullet('Wages: the yearly pay rises for crew members and crew leads.'),
      bullet('Supplies: cleaning products and equipment cost more than a year ago.'),
      bullet(`Visits running long: from January to May, staff time on site ran ${long}% over scheduled time, `
        + 'and we pay for that time.'),
      { text: '' },
      para(`What we expect. Some customers will cancel. We expect no more than ${MEMO_EXPECTED_EXTRA} cancellations `
        + `beyond our usual rate over July to September. If every plan stays, the increase adds about ${ifAllStay} a year.`),
    ),
    section(
      '3. How we will judge the increase',
      para('At the end of September we will work out three figures from the plan records:'),
      bullet('A. Extra cancellations: plans cancelled in July to September, less three times the monthly '
        + 'average for January to June.'),
      bullet('B. What they cost us: the yearly value of the plans cancelled in July to September, less three '
        + 'times the January to June monthly average. A plan\'s yearly value is its price per visit times its '
        + 'visits a year (the table below).'),
      bullet('C. What the increase brings: the yearly value the July increases add on the plans still active on '
        + 'September 30 (each increase per visit, times visits a year).'),
      para('The increase has paid off if C is more than B.'),
      { text: '' },
      table([{ header: 'Plan frequency', x: 0 }, { header: 'Visits a year', x: 230, right: true }],
        Object.entries(VISITS_PER_YEAR).map(([f, n]) => [FREQUENCY_WORDS[f], String(n)])),
    ),
    section('4. Schedule standard', para('Every visit is booked for a set time, and each person on the crew is '
      + `scheduled for that time. From July the standard is: a crew's total staff time on site in a month stays within `
      + `${SCHEDULE_STANDARD_PCT}% of its scheduled staff time (each visit's scheduled minutes times the people on it). `
      + 'Time over schedule is paid at each person\'s hourly rate; a visit that finishes early counts against it. '
      + `A crew more than ${SCHEDULE_STANDARD_PCT}% over in a month gets a schedule review with me.`)),
    section(
      '5. Current prices',
      para('List prices for new bookings, per visit. They stay as below for the rest of the year. The base price is '
        + 'for a typical home; the price for a home is set at booking, by its size and how often we visit.'),
      { text: '' },
      table([{ header: 'Package', x: 0 }, { header: 'Base price per visit', x: 330, right: true }],
        [...packages].sort((a, b) => Number(a.base_price_cents) - Number(b.base_price_cents))
          .map((p) => [p.name, money(Number(p.base_price_cents))])),
      { text: '' },
      table([{ header: 'Add-on', x: 0 }, { header: 'Price per visit', x: 330, right: true }],
        [...addOns].sort((a, b) => a.name.localeCompare(b.name, 'en')).map((a) => [a.name, money(Number(a.price_cents))])),
    ),
    [
      { text: '' },
      ...para(`Questions about any of this: talk to me or call the office on ${OFFICE_PHONE}.`),
      { text: '' },
      { text: `${AUTHOR}, Operations Manager`, bold: true },
    ],
  ];
}

function agreementBlocks({ packages, addOns, payments }) {
  const names = Object.fromEntries(packages.map((p) => [p.package_id, p.name]));
  for (const k of ['standard', 'deep', 'move_out']) if (!names[k]) throw new DemoPackError(`no ${k} package`);
  const methods = [...new Set(payments.map((p) => p.method))]
    .sort((a, b) => Object.keys(PAYMENT_WORDS).indexOf(a) - Object.keys(PAYMENT_WORDS).indexOf(b));
  for (const mth of methods) if (!PAYMENT_WORDS[mth]) throw new DemoPackError(`payment method ${mth} has no words`);
  const addOnNames = [...addOns].map((a) => a.name).sort((a, b) => a.localeCompare(b, 'en'));
  const fee = `${LATE_FEE_BASIS_POINTS / 100}%`;
  return [
    [
      ...letterhead('SERVICE AGREEMENT'),
      { text: '' },
      { text: 'Customer service agreement', size: 14, bold: true },
      { text: 'Effective January 1, 2026. Applies to every plan and booking from that date.', size: 10 },
      { text: '' },
      ...para('This agreement covers every cleaning visit Brightside Home Cleaning ("we") makes for a customer ("you"), '
        + 'on a recurring plan or a one-time booking. Booking a visit or a plan means you accept it. Your price per '
        + 'visit is on your booking confirmation.'),
    ],
    section(
      '1. What each package includes',
      bullet(`${names.standard}: kitchen and bathrooms cleaned, surfaces dusted, floors vacuumed and mopped, bins emptied.`),
      bullet(`${names.deep}: everything in a ${names.standard}, plus door frames, light switches, cabinet fronts and a `
        + 'scrub of tile grout.'),
      bullet(`${names.move_out}: a ${names.deep} of an empty home, inside every cupboard and closet, ready for the handover.`),
      para(`Add-ons cost extra, per visit: ${addOnNames.join(', ')}.`),
    ),
    section('2. Plans and prices', para('A recurring plan books a visit every week, every two weeks or every month, at a '
      + 'set price per visit. We may change a plan\'s price with at least 14 days\' written notice; the new price '
      + 'applies from the date in the notice.')),
    section(
      '3. Arrival windows',
      para('You book a window, not an exact time.'),
      table([{ header: 'Window', x: 0 }, { header: 'The crew arrives', x: 150 }],
        [['Morning', 'before 12:00 noon'], ['Afternoon', 'from 12:00 noon']]),
    ),
    section(
      '4. Rescheduling, skipping and cancelling',
      bullet('To reschedule or skip a visit, give us at least 24 hours\' notice. There is no fee.'),
      bullet(`With less notice, call the office on ${OFFICE_PHONE} and we will do our best.`),
      bullet('To cancel a plan, call the office or reply to any email from us, with at least 7 days\' notice. '
        + 'There is no cancellation fee. Visits in those 7 days go ahead unless you skip them as above.'),
    ),
    section('5. Invoices and payment', para('We invoice each completed visit on the day of the visit. Payment is due '
      + `within ${NET_DAYS} days of the invoice date (net ${NET_DAYS}). Pay by `
      + `${methods.map((mth) => PAYMENT_WORDS[mth]).join(' or ')}, in full or in parts.`)),
    section(
      '6. Late payment',
      para('An invoice not paid in full by its due date is past due. Days past due count from the due date.'),
      table([{ header: 'Days past due', x: 0 }, { header: 'What happens', x: 110 }], [
        ['1 to 14', 'We send a reminder email.'],
        [`15 to ${LATE_FEE_AFTER_DAYS}`, 'We call you.'],
        [`More than ${LATE_FEE_AFTER_DAYS}`, `A late fee of ${fee} a month on the unpaid balance, charged once a month.`],
        ['More than 60', 'Visits pause until the balance is paid.'],
        ['More than 90', 'We may pass the balance to a collection agency.'],
      ]),
    ),
    section('7. When a crew is out for the day', para('A crew is out for the day when its crew lead is absent, or '
      + 'nobody on the crew is present. A stand-in lead counts as the lead for that day. A crew with its lead and at '
      + 'least one other person present works the day with fewer people, so its visits take longer. When a crew is '
      + 'out, another crew of the same zone takes its visits where it has room. We tell you before your visit changes.')),
    section('8. Contact', para(`Call the office on ${OFFICE_PHONE}, or reply to any email from us.`)),
  ];
}

// --- the questions ----------------------------------------------------------

// The three v0 questions and the follow-ups, with their expected answers,
// from the built data. `facts`: strings each answer rests on, each in the
// text of `from` (one file name per fact, the fact's file).
function questions(data, plan, aging, crew) {
  const q = plan.q1;
  const july = q.july;
  const paidOff = q.net > 0;
  const deep = data.packages.find((p) => p.package_id === 'deep');
  const oven = data.addOns.find((a) => a.add_on_id === 'oven');
  if (!deep || !oven) throw new DemoPackError('the fixture has no deep clean or no inside-oven add-on');

  const [top, topPct] = singleTop(crew.rows.map((r) => [r.name, Number(r.pct)]), 'question 3, % over by crew');
  const [, secondPct] = [...crew.rows].map((r) => [r.name, Number(r.pct)]).sort((a, b) => b[1] - a[1])[1];
  const second = crew.rows.find((r) => Number(r.pct) === secondPct);
  const [bottom] = singleBottom(crew.rows.map((r) => [r.name, Number(r.pct)]), 'question 3, % over by crew');
  const [costTop] = singleTop(crew.rows.map((r) => [r.name, r.cost]), 'question 3, wages by crew');
  const t = crew.rows.find((r) => r.name === top);
  const b = crew.rows.find((r) => r.name === bottom);
  const breakers = crew.rows.filter((r) => Number(r.pct) > SCHEDULE_STANDARD_PCT)
    .sort((x, y) => Number(y.pct) - Number(x.pct)).map((r) => r.name);
  const totalCost = crew.rows.reduce((s, r) => s + r.cost, 0);
  const listed = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const costNote = costTop === second.name ? ', the largest wage cost' : '';
  if (topPct === secondPct) throw new DemoPackError('question 3: a tie at the top');

  const all = aging.all;
  const [z90] = singleTop(aging.rows.map((r) => [r.name, r.d90]), 'follow-up, over 90 days by zone');
  const zone90 = aging.rows.find((r) => r.name === z90);

  const main = [
    {
      n: 1,
      files: [FILES.memo, FILES.planChanges],
      question: 'Did our July price increase cost us customers? Was it worth it?',
      answer: `${q.extra > 0 ? 'Yes, it cost customers' : 'No, it did not cost customers'}, and ${paidOff ? 'yes, it paid off' : 'no, it did not pay off'}. `
        + `July to September had ${q.afterCancelled} plan cancellations, ${oneDp(q.extra).replace(/\.0$/, '')} more than three times the `
        + `January to June average of ${oneDp(q.baseAvg)} a month; the memo expected no more than ${MEMO_EXPECTED_EXTRA} extra. `
        + `Those extra cancellations were worth ${money(q.extraValue)} a year. The increase added ${money(q.gain)} a year on the `
        + `${q.stayed} increased plans still active on ${data.asOf}. Net: ${money(Math.abs(q.net))} a year ${paidOff ? 'more' : 'less'}.`,
      facts: [
        [FILES.planChanges, `${INCREASE_MONTH},${july.increases},${oneDp(july.avgPct)},${july.cancelled},`],
        [FILES.planChanges, `,${july.stayed},${dollars(july.added)}`],
        [FILES.memo, `no more than ${MEMO_EXPECTED_EXTRA} cancellations`],
        [FILES.memo, 'The increase has paid off if C is more than B.'],
      ],
    },
    {
      n: 2,
      files: [FILES.agreement, FILES.aging],
      question: 'How much are customers past due, and how much could we collect in late fees under our terms?',
      answer: `Past due: ${money(all.pastDue)} of the ${money(all.open)} open on ${count(all.n)} invoices. `
        + `More than ${LATE_FEE_AFTER_DAYS} days past due: ${money(all.over30)} on ${all.over30n} invoices. `
        + `At the agreement's ${LATE_FEE_BASIS_POINTS / 100}% a month, that is ${money(aging.fee)} in late fees a month.`,
      facts: [
        [FILES.aging, `All zones,${all.n},`],
        [FILES.aging, `${dollars(all.open)},${dollars(all.pastDue)},${dollars(all.over30)},${all.over30n}`],
        [FILES.agreement, `A late fee of ${LATE_FEE_BASIS_POINTS / 100}% a month on the unpaid balance`],
        [FILES.agreement, `(net ${NET_DAYS})`],
      ],
    },
    {
      n: 3,
      files: [FILES.memo, FILES.crewTime],
      question: 'Which crews ran furthest over schedule in September, and what did it cost us in wages?',
      answer: `${top} ran furthest over: ${t.pct}% over its scheduled staff time (${count(t.actual)} minutes against `
        + `${count(t.scheduled)} on ${t.visits} visits), ${money(t.cost)} in wages. ${second.name} was next at ${second.pct}%, `
        + `${money(second.cost)}${costNote}. ${breakers.length === 1 ? `Only ${breakers[0]} breaks` : `Only ${listed(breakers)} break`} the memo's `
        + `${SCHEDULE_STANDARD_PCT}% standard. ${bottom} kept closest to schedule, ${b.pct}% over. All crews together: `
        + `${money(totalCost)} in wages for time over schedule.`,
      facts: [
        [FILES.crewTime, `${t.name},${t.zone},${t.visits},${t.scheduled},${t.actual},${t.pct},${dollars(t.cost)}`],
        [FILES.crewTime, `${b.name},${b.zone},${b.visits},`],
        [FILES.memo, `within ${SCHEDULE_STANDARD_PCT}% of its`],
      ],
    },
  ];
  const followUps = [
    {
      files: [FILES.memo],
      question: 'What did the memo expect the increase to add if every plan stayed?',
      answer: `About ${money(plan.memo.ifAllStay).replace(/\.00$/, '')} a year.`,
      facts: [[FILES.memo, money(plan.memo.ifAllStay).replace(/\.00$/, '')]],
    },
    {
      files: [FILES.aging],
      question: 'Which zone owes the most that is more than 90 days past due?',
      answer: `${zone90.name}: ${money(zone90.d90)}.`,
      facts: [[FILES.aging, dollars(zone90.d90)]],
    },
    {
      files: [FILES.agreement],
      question: 'What happens when a customer is more than 60 days past due?',
      answer: 'Their visits pause until the balance is paid. After 90 days we may pass the balance to a collection agency.',
      facts: [[FILES.agreement, 'Visits pause until the balance is paid.']],
    },
    {
      files: [FILES.agreement],
      question: 'How much notice does a customer need to give to reschedule?',
      answer: '24 hours\' notice, and there is no fee.',
      facts: [[FILES.agreement, '24 hours\' notice'], [FILES.agreement, 'There is no fee.']],
    },
    {
      files: [FILES.memo],
      question: `How much is a deep clean, and what does the ${oven.name.toLowerCase()} add-on cost?`,
      answer: `${deep.name} ${money(Number(deep.base_price_cents))} per visit (base price); ${oven.name} ${money(Number(oven.price_cents))}.`,
      facts: [[FILES.memo, deep.name], [FILES.memo, money(Number(deep.base_price_cents))], [FILES.memo, oven.name],
        [FILES.memo, money(Number(oven.price_cents))]],
    },
  ];
  return { main, followUps };
}

// Builds the pack in memory. Returns { files: { name: Buffer }, extracts:
// { name: text }, chars: { name: n }, total, questions, followUps };
// throws DemoPackError when a check fails.
function buildPack() {
  const data = readFixture();
  const plan = planChanges(data);
  const aging = receivables(data);
  const crew = crewTime(data);
  const footer = (title) => (i, n) => `${title} | Page ${i + 1} of ${n}`;
  const files = {
    [FILES.memo]: writePdf({
      title: 'Brightside mid-year pricing and operations memo 2026',
      pages: paginate(memoBlocks(data, plan, crew)),
      footer: footer(`Internal memo, ${MEMO_DATE}`),
    }),
    [FILES.agreement]: writePdf({
      title: 'Brightside customer service agreement 2026',
      pages: paginate(agreementBlocks(data)),
      footer: footer('Customer service agreement 2026'),
    }),
    [FILES.planChanges]: Buffer.from(plan.text, 'utf8'),
    [FILES.aging]: Buffer.from(aging.text, 'utf8'),
    [FILES.crewTime]: Buffer.from(crew.text, 'utf8'),
  };
  const extracts = {};
  for (const [name, bytes] of Object.entries(files)) {
    extracts[name] = name.endsWith('.pdf') ? pdfExtract(bytes) : readCsv(bytes).text;
  }
  const chars = {};
  let total = 0;
  for (const [name, text] of Object.entries(extracts)) {
    chars[name] = promptChars(text);
    if (chars[name] > CAPS.file) throw new DemoPackError(`${name}: ${chars[name]} characters, over the store's ${CAPS.file} file cap`);
    total += chars[name];
  }
  if (total > MAX_PACK_CHARS) throw new DemoPackError(`the five files hold ${total} characters, over ${MAX_PACK_CHARS}`);
  const { main, followUps } = questions(data, plan, aging, crew);
  for (const item of [...main, ...followUps]) {
    for (const [file, fact] of item.facts) {
      if (!extracts[file].includes(fact)) throw new DemoPackError(`"${item.question}": "${fact}" is not in ${file}`);
    }
  }
  return {
    files, extracts, chars, total, questions: main, followUps, plan: plan.rows, aging, crew: crew.rows,
  };
}

function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, dir = HERE } = {}) {
  const check = argv.includes('--check');
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length) {
    err.write(`unknown argument ${unknown[0]}\nusage: npm run demo-pack [-- --check]\n`);
    return 2;
  }
  let pack;
  try {
    pack = buildPack();
  } catch (e) {
    if (!(e instanceof DemoPackError)) throw e;
    err.write(`demo pack: ${e.message}\n`);
    return 1;
  }
  let stale = 0;
  for (const [name, bytes] of Object.entries(pack.files)) {
    const file = path.join(dir, name);
    if (check) {
      const same = fs.existsSync(file) && fs.readFileSync(file).equals(bytes);
      if (!same) {
        stale += 1;
        err.write(`demo pack: ${name} differs from the build; run npm run demo-pack\n`);
      }
    } else {
      fs.writeFileSync(file, bytes);
    }
    out.write(`${name}  ${bytes.length} bytes, ${pack.chars[name]} characters\n`);
  }
  for (const name of RETIRED) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    if (check) {
      stale += 1;
      err.write(`demo pack: ${name} is retired; run npm run demo-pack\n`);
    } else {
      fs.unlinkSync(file);
    }
  }
  out.write(`All five: ${pack.total} characters (at most ${MAX_PACK_CHARS}; the hub holds ${CAPS.hubChars}).\n`);
  out.write('\nThe v0 questions and their expected answers:\n');
  for (const q of pack.questions) out.write(`${q.n}. "${q.question}"\n   ${q.answer}\n   (${q.files.join(' + ')})\n`);
  out.write('\nFollow-ups:\n');
  for (const f of pack.followUps) out.write(`- "${f.question}"\n  ${f.answer}  (${f.files.join(' + ')})\n`);
  return stale ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  buildPack, main, singleTop, readSeedRows, DemoPackError, FILES, RETIRED, MAX_PACK_CHARS,
  SCHEDULE_STANDARD_PCT, MEMO_EXPECTED_EXTRA, LATE_FEE_BASIS_POINTS, NET_DAYS, VISITS_PER_YEAR, AUTHOR,
};
