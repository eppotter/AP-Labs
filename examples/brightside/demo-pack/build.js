'use strict';

// The v0 demo pack (plan brightside-v1, D4, Story 18.3): two PDFs and two CSVs
// an admin uploads to /brightside-v0's Add context, so the blank bot can then
// answer the five questions of the v0 script (docs/runtime/demo-script.md,
// "Stage 1: v0").
//
//   npm run demo-pack              build the four files here and print the
//                                  five questions with their expected answers
//   npm run demo-pack -- --check   build in memory; exit 1 if a committed
//                                  file differs (nothing is written)
//
// Every figure comes from the fixture's committed seeds
// (examples/brightside/fixture/seeds), read here without DuckDB, so the files
// agree with the data:
//   - price-list-2026.pdf: every package and add-on with its price
//     (`packages`, `add_ons`).
//   - service-policies.pdf: arrival windows (morning before 12:00, afternoon
//     from 12:00, as `visits.arrival_window` is set), 24 hours' notice to
//     reschedule with no fee (the data has none), what each package includes,
//     and how a crew-out day is handled (GRD-008's words).
//   - zone-billing-2026-09.csv: per zone, invoices issued and billed $ (by
//     `invoices.issued_on`, MET-004) and cash received in September $ (by
//     `payments.paid_on`, MET-003). The zone is the client's
//     (`clients.zone_id`): through `invoices.client_id` for billed, through
//     payments -> invoices -> clients for cash. The build fails unless the
//     totals equal the signed truths `billed-revenue-2026-09` and
//     `paid-revenue-2026-09` (targets.json).
//   - complaints-2026-09.csv: synthetic, seeded (COMPLAINTS_SEED). Each row is
//     a completed September visit's date, its crew's zone and the crew's name,
//     with a drawn category and resolved yes/no. No client name, email,
//     phone, address or staff name: nothing about a person.
//
// Checks, each failing the build: the two truth totals; questions 3 and 4
// each have exactly one top answer, no tie (SQLsmith P3-14); each CSV passes
// Add context's readCsv (200 rows, 30 columns, 6,000 escaped characters);
// the four files' text fits in MAX_PACK_CHARS escaped characters (under the
// hub's 15,000), and each PDF's text under the store's 6,000 file cap.
// Deterministic: the same seeds give the same bytes.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRng } = require('../fixture/lib/prng');
const { writePdf, pdfText } = require('./pdf');
const { readCsv } = require('../../../kit/runtime/slack/files');
const { promptChars, CAPS } = require('../../../kit/runtime/knowledge/store');

const HERE = __dirname;
const FIXTURE = path.join(HERE, '..', 'fixture');
const SEEDS = path.join(FIXTURE, 'seeds');
const MONTH_START = '2026-09-01';
const MONTH_END = '2026-10-01'; // exclusive
// The complaints draw. Chosen so questions 3 and 4 have no tie; the build
// checks it, so a seed change that makes a tie fails loudly.
const COMPLAINTS_SEED = 20260930;
const COMPLAINTS = 40;
const RESOLVED_CHANCE = 0.75;
const CATEGORIES = Object.freeze([
  ['Late arrival', 7], ['Missed area', 5], ['Damaged item', 2], ['Products used', 2], ['Billing question', 2],
]);
// The four files' text, escaped as the knowledge store measures it.
const MAX_PACK_CHARS = 11000;
const OFFICE_PHONE = '555-0100'; // GRD-007's synthetic range

const FILES = Object.freeze({
  priceList: 'price-list-2026.pdf',
  policies: 'service-policies.pdf',
  billing: 'zone-billing-2026-09.csv',
  complaints: 'complaints-2026-09.csv',
});

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

const inMonth = (day) => day >= MONTH_START && day < MONTH_END;
// Cents as dollars: 2600 -> "26.00" (CSV), money() -> "$26.00" with commas.
const dollars = (cents) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const money = (cents) => `$${Math.trunc(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
const csvText = (rows) => `${rows.map((r) => r.join(',')).join('\n')}\n`;

// The single top entry of [[name, value], ...] by value, or a DemoPackError
// naming the tie.
function singleTop(pairs, what) {
  const sorted = [...pairs].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) throw new DemoPackError(`${what}: nothing to rank`);
  if (sorted.length > 1 && sorted[1][1] === sorted[0][1]) {
    throw new DemoPackError(`${what}: a tie at the top (${sorted[0][0]} and ${sorted[1][0]}, ${sorted[0][1]} each)`);
  }
  return sorted[0];
}

function readFixture() {
  const targets = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'targets.json'), 'utf8')).truths;
  return {
    targets,
    zones: readSeedRows('zones'),
    packages: readSeedRows('packages'),
    addOns: readSeedRows('add_ons'),
    crews: readSeedRows('crews'),
    clients: readSeedRows('clients'),
    invoices: readSeedRows('invoices'),
    payments: readSeedRows('payments'),
    visits: readSeedRows('visits'),
  };
}

function priceList({ packages, addOns }) {
  const row = (name, cents) => `${name}: ${money(Number(cents))}`;
  return [[
    { text: 'Brightside Home Cleaning: Price list 2026', size: 16, bold: true },
    { text: '' },
    { text: 'Packages (base price per visit)', size: 13, bold: true },
    ...[...packages].sort((a, b) => Number(a.base_price_cents) - Number(b.base_price_cents))
      .map((p) => ({ text: row(p.name, p.base_price_cents) })),
    { text: '' },
    { text: 'Add-ons (per visit, on top of the package)', size: 13, bold: true },
    ...[...addOns].sort((a, b) => a.name.localeCompare(b.name, 'en'))
      .map((a) => ({ text: row(a.name, a.price_cents) })),
    { text: '' },
    { text: 'The base price is for a typical home. The price for your home is set when you book:' },
    { text: 'its size and how often we visit (weekly, every two weeks or monthly) change it.' },
    { text: `Questions about prices: call the office on ${OFFICE_PHONE}.` },
  ]];
}

function policies({ packages, addOns }) {
  const names = Object.fromEntries(packages.map((p) => [p.package_id, p.name]));
  const addOnNames = [...addOns].map((a) => a.name).sort((a, b) => a.localeCompare(b, 'en'));
  const h = (text) => ({ text, size: 13, bold: true });
  const t = (text) => ({ text });
  const gap = { text: '' };
  return [[
    { text: 'Brightside Home Cleaning: Service policies 2026', size: 16, bold: true },
    gap,
    h('Arrival windows'),
    t('You book a morning or an afternoon window, not an exact time.'),
    t('Morning: the crew arrives before 12:00 noon.'),
    t('Afternoon: the crew arrives from 12:00 noon.'),
    gap,
    h('Rescheduling and cancelling'),
    t('To reschedule or cancel a visit, give us at least 24 hours\' notice.'),
    t('There is no fee to reschedule or cancel.'),
    t(`With less notice, call the office on ${OFFICE_PHONE} and we will do our best.`),
    gap,
    h('What each package includes'),
    t(`${names.standard}: kitchen and bathrooms cleaned, surfaces dusted, floors vacuumed`),
    t('and mopped, bins emptied.'),
    t(`${names.deep}: everything in a ${names.standard}, plus door frames, light switches,`),
    t('cabinet fronts and a scrub of tile grout.'),
    t(`${names.move_out}: a ${names.deep} of an empty home, inside every cupboard and closet,`),
    t('ready for the handover.'),
    t('Add-ons cost extra (see the price list):'),
    t(`${addOnNames.join(', ')}.`),
    gap,
    h('Paying'),
    t('We invoice each completed visit. Pay by card or bank transfer (ACH), in full or in parts.'),
  ], [
    h('When a crew is out for the day'),
    t('A crew is out for the day when its crew lead is absent, or nobody on the crew is present.'),
    t('A stand-in lead counts as the lead for that day.'),
    t('A member present for part of the day counts as present.'),
    t('A crew with its lead and at least one other person present works the day with fewer'),
    t('people, so its visits take longer.'),
    t('When a crew is out, its visits need a new crew: another crew of the same zone takes them'),
    t('where it has room. We tell you before your visit changes.'),
    gap,
    h('Contact'),
    t(`Call the office on ${OFFICE_PHONE}, or reply to any email from us.`),
  ]];
}

// Billed and cash received in September, per client zone (see the header).
function zoneBilling({ zones, clients, invoices, payments, targets }) {
  const zoneOf = new Map(clients.map((c) => [c.client_id, c.zone_id]));
  const invoiceClient = new Map(invoices.map((i) => [i.invoice_id, i.client_id]));
  const by = new Map(zones.map((z) => [z.zone_id, { name: z.name, issued: 0, billed: 0, cash: 0 }]));
  const zoneRow = (clientId, what) => {
    const row = by.get(zoneOf.get(clientId));
    if (!row) throw new DemoPackError(`${what}: client ${clientId} has no known zone`);
    return row;
  };
  for (const i of invoices) {
    if (!inMonth(i.issued_on)) continue;
    const row = zoneRow(i.client_id, `invoice ${i.invoice_id}`);
    row.issued += 1;
    row.billed += Number(i.total_cents);
  }
  for (const p of payments) {
    if (!inMonth(p.paid_on)) continue;
    if (!invoiceClient.has(p.invoice_id)) throw new DemoPackError(`payment ${p.payment_id}: no invoice ${p.invoice_id}`);
    zoneRow(invoiceClient.get(p.invoice_id), `payment ${p.payment_id}`).cash += Number(p.amount_cents);
  }
  const rows = [...by.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const billed = rows.reduce((s, r) => s + r.billed, 0);
  const cash = rows.reduce((s, r) => s + r.cash, 0);
  if (billed !== targets['billed-revenue-2026-09']) throw new DemoPackError(`billed total ${billed} is not the truth billed-revenue-2026-09 (${targets['billed-revenue-2026-09']})`);
  if (cash !== targets['paid-revenue-2026-09']) throw new DemoPackError(`cash total ${cash} is not the truth paid-revenue-2026-09 (${targets['paid-revenue-2026-09']})`);
  const header = ['Zone', 'Invoices issued in September', 'Billed in September ($)', 'Cash received in September ($)'];
  return {
    rows,
    text: csvText([header, ...rows.map((r) => [r.name, String(r.issued), dollars(r.billed), dollars(r.cash)])]),
  };
}

// Synthetic complaints on real September visits (see the header).
function complaints({ crews, zones, visits }) {
  const zoneName = new Map(zones.map((z) => [z.zone_id, z.name]));
  const crew = new Map(crews.map((c) => [c.crew_id, { name: c.name, zone: zoneName.get(c.zone_id) }]));
  const pool = visits
    .filter((v) => v.status === 'completed' && inMonth(v.visit_date))
    .sort((a, b) => Number(a.visit_id) - Number(b.visit_id));
  if (pool.length < COMPLAINTS) throw new DemoPackError(`only ${pool.length} completed September visits`);
  const rng = createRng(COMPLAINTS_SEED);
  const chosen = new Set();
  while (chosen.size < COMPLAINTS) chosen.add(rng.int(0, pool.length - 1));
  const rows = [...chosen].map((i) => {
    const v = pool[i];
    const c = crew.get(v.crew_id);
    if (!c || !c.zone) throw new DemoPackError(`visit ${v.visit_id}: unknown crew ${v.crew_id}`);
    return {
      date: v.visit_date, crewId: Number(v.crew_id), zone: c.zone, crew: c.name,
      category: rng.weighted(CATEGORIES), resolved: rng.chance(RESOLVED_CHANCE) ? 'yes' : 'no',
    };
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.crewId - b.crewId));
  const header = ['Date', 'Zone', 'Crew', 'Category', 'Resolved'];
  return { rows, text: csvText([header, ...rows.map((r) => [r.date, r.zone, r.crew, r.category, r.resolved])]) };
}

// The five v0 questions and their expected answers (D4), from the built
// data. `facts`: strings each answer rests on, every one in the files.
function questions({ packages, addOns }, billing, complaintRows) {
  const deep = packages.find((p) => p.package_id === 'deep');
  const oven = addOns.find((a) => a.add_on_id === 'oven');
  if (!deep || !oven) throw new DemoPackError('the fixture has no deep clean or no inside-oven add-on');
  const [topZone] = singleTop(billing.rows.map((r) => [r.name, r.billed]), 'question 3, billed by zone');
  const zone = billing.rows.find((r) => r.name === topZone);
  const late = new Map();
  for (const r of complaintRows) if (r.category === 'Late arrival') late.set(r.crew, (late.get(r.crew) || 0) + 1);
  const [topCrew, lateCount] = singleTop([...late], 'question 4, late-arrival complaints by crew');
  const open = complaintRows.filter((r) => r.resolved === 'no').length;
  return [
    {
      n: 1, file: FILES.priceList,
      question: `How much is a deep clean, and what does the ${oven.name.toLowerCase()} add-on cost?`,
      answer: `${deep.name} ${money(Number(deep.base_price_cents))} (base price); ${oven.name} ${money(Number(oven.price_cents))}.`,
      facts: [deep.name, money(Number(deep.base_price_cents)), oven.name, money(Number(oven.price_cents))],
    },
    {
      n: 2, file: FILES.policies,
      question: 'How much notice does a customer need to give to reschedule?',
      answer: '24 hours\' notice, and there is no fee.',
      facts: ['24 hours\' notice', 'no fee'],
    },
    {
      n: 3, file: FILES.billing,
      question: 'Which zone billed the most in September, and how much cash did we receive from that zone in September?',
      answer: `${zone.name}: billed ${money(zone.billed)} on ${zone.issued} invoices; cash received in September ${money(zone.cash)}.`,
      facts: [zone.name, dollars(zone.billed), String(zone.issued), dollars(zone.cash)],
    },
    {
      n: 4, file: FILES.complaints,
      question: 'Which crew had the most late-arrival complaints in September?',
      answer: `${topCrew}, with ${lateCount} late-arrival complaints.`,
      facts: [topCrew, 'Late arrival'],
      count: lateCount,
    },
    {
      n: 5, file: FILES.complaints,
      question: 'How many complaints in September are still unresolved?',
      answer: `${open} of ${complaintRows.length}.`,
      facts: [],
      count: open,
    },
  ];
}

// Builds the pack in memory. Returns { files: { name: Buffer }, extracts:
// { name: text }, questions, billing, complaints }; throws DemoPackError when
// a check fails.
function buildPack() {
  const data = readFixture();
  const pricePages = priceList(data);
  const policyPages = policies(data);
  const billing = zoneBilling(data);
  const complaint = complaints(data);
  const files = {
    [FILES.priceList]: writePdf({ title: 'Brightside price list 2026', pages: pricePages }),
    [FILES.policies]: writePdf({ title: 'Brightside service policies 2026', pages: policyPages }),
    [FILES.billing]: Buffer.from(billing.text, 'utf8'),
    [FILES.complaints]: Buffer.from(complaint.text, 'utf8'),
  };
  const extracts = {
    [FILES.priceList]: pdfText(pricePages),
    [FILES.policies]: pdfText(policyPages),
    [FILES.billing]: readCsv(files[FILES.billing]).text,
    [FILES.complaints]: readCsv(files[FILES.complaints]).text,
  };
  let total = 0;
  for (const [name, text] of Object.entries(extracts)) {
    const chars = promptChars(text);
    if (chars > CAPS.file) throw new DemoPackError(`${name}: ${chars} characters, over the store's ${CAPS.file} file cap`);
    total += chars;
  }
  if (total > MAX_PACK_CHARS) throw new DemoPackError(`the four files hold ${total} characters, over ${MAX_PACK_CHARS}`);
  return {
    files, extracts, questions: questions(data, billing, complaint.rows), billing: billing.rows, complaints: complaint.rows,
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
    out.write(`${name}  ${bytes.length} bytes\n`);
  }
  out.write('\nThe v0 questions and their expected answers:\n');
  for (const q of pack.questions) out.write(`${q.n}. "${q.question}"\n   ${q.answer}  (${q.file})\n`);
  return stale ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  buildPack, main, singleTop, readSeedRows, DemoPackError, FILES, MAX_PACK_CHARS, COMPLAINTS_SEED,
};
