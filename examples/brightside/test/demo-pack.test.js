'use strict';

// The v0 demo pack (plan brightside-v1, D4, Story 18.3): two PDFs and two CSVs
// built from the fixture by examples/brightside/demo-pack/build.js. An example
// test (architecture carve-out): it reads Brightside's own fixture and demo
// pack (never profiles/brightside/), and is deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  buildPack, main, singleTop, DemoPackError, FILES, MAX_PACK_CHARS,
} = require('../demo-pack/build');
const { readCsv, MAX_FILE_BYTES } = require('../../../kit/runtime/slack/files');
const { sniff, pdfPageCount } = require('../../../kit/runtime/llm/file-check');
const { promptChars, CAPS } = require('../../../kit/runtime/knowledge/store');

const ROOT = path.join(__dirname, '../../..');
const PACK = path.join(__dirname, '../demo-pack');
const FIXTURE = path.join(__dirname, '../fixture');
const SCRIPT = path.join(ROOT, 'docs/runtime/demo-script.md');

const pack = buildPack();
const committed = (name) => fs.readFileSync(path.join(PACK, name));
// A CSV's data rows as arrays, through Add context's own reader.
const csvRows = (name) => {
  const { text } = readCsv(committed(name));
  const [header, ...rows] = text.split('\n').map((l) => l.split(','));
  return { header, rows };
};
const seedRows = (table) => {
  const [head, ...lines] = zlib.gunzipSync(fs.readFileSync(path.join(FIXTURE, 'seeds', `${table}.csv.gz`)))
    .toString('utf8').split('\n').filter(Boolean);
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
};
const cents = (dollars) => Math.round(Number(dollars) * 100);

test('the committed files are exactly what the build makes (npm run demo-pack -- --check)', () => {
  for (const [name, bytes] of Object.entries(pack.files)) {
    assert.ok(committed(name).equals(bytes), `${name} is stale: run npm run demo-pack`);
  }
  const out = { text: '', write(s) { this.text += s; } };
  const err = { text: '', write(s) { this.text += s; } };
  assert.equal(main(['--check'], { out, err }), 0, err.text);
  assert.match(out.text, /expected answers/);
});

test('two builds give the same bytes', () => {
  const again = buildPack();
  for (const [name, bytes] of Object.entries(pack.files)) assert.ok(again.files[name].equals(bytes), name);
});

test('each PDF sniffs as a PDF with its page count', () => {
  assert.equal(sniff(committed(FILES.priceList)), 'pdf');
  assert.equal(pdfPageCount(committed(FILES.priceList)), 1);
  assert.equal(sniff(committed(FILES.policies)), 'pdf');
  assert.equal(pdfPageCount(committed(FILES.policies)), 2);
});

test('each CSV passes Add context\'s readCsv', () => {
  const billing = readCsv(committed(FILES.billing));
  assert.deepEqual([billing.rows, billing.columns], [5, 4]);
  const complaints = readCsv(committed(FILES.complaints));
  assert.deepEqual([complaints.rows, complaints.columns], [40, 5]);
});

test('every file is small enough for Slack and Add context', () => {
  let total = 0;
  for (const [name, text] of Object.entries(pack.extracts)) {
    const bytes = committed(name);
    assert.ok(bytes.length < MAX_FILE_BYTES, `${name}: ${bytes.length} bytes`);
    const chars = promptChars(text);
    assert.ok(chars <= CAPS.file, `${name}: ${chars} characters over the file cap`);
    total += chars;
  }
  assert.ok(total <= MAX_PACK_CHARS, `the four files hold ${total} characters`);
  assert.ok(MAX_PACK_CHARS < CAPS.hubChars);
});

test('zone billing: the "cash received" column is labelled so, and the totals are the two signed truths', () => {
  const targets = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'targets.json'), 'utf8')).truths;
  const { header, rows } = csvRows(FILES.billing);
  assert.deepEqual(header, ['Zone', 'Invoices issued in September', 'Billed in September ($)', 'Cash received in September ($)']);
  const zones = seedRows('zones').map((z) => z.name).sort();
  assert.deepEqual(rows.map((r) => r[0]).sort(), zones);
  assert.equal(rows.reduce((s, r) => s + cents(r[2]), 0), targets['billed-revenue-2026-09']);
  assert.equal(rows.reduce((s, r) => s + cents(r[3]), 0), targets['paid-revenue-2026-09']);
});

test('zone billing: zone is the client\'s zone (clients.zone_id), invoices counted by issued_on', () => {
  const zoneName = new Map(seedRows('zones').map((z) => [z.zone_id, z.name]));
  const zoneOf = new Map(seedRows('clients').map((c) => [c.client_id, zoneName.get(c.zone_id)]));
  const issued = new Map();
  for (const i of seedRows('invoices')) {
    if (i.issued_on < '2026-09-01' || i.issued_on >= '2026-10-01') continue;
    const z = zoneOf.get(i.client_id);
    issued.set(z, (issued.get(z) || 0) + 1);
  }
  for (const r of csvRows(FILES.billing).rows) assert.equal(Number(r[1]), issued.get(r[0]), r[0]);
});

test('the complaints CSV holds no personal data', () => {
  const { header, rows } = csvRows(FILES.complaints);
  assert.deepEqual(header, ['Date', 'Zone', 'Crew', 'Category', 'Resolved']);
  const text = readCsv(committed(FILES.complaints)).text;
  assert.doesNotMatch(text, /@|\d{3}-\d{4}/, 'an email or a phone number');
  const words = new Set(text.split(/[\s,]+/));
  for (const c of seedRows('clients')) {
    assert.ok(!words.has(c.first_name) && !words.has(c.last_name), `client ${c.client_id}'s name`);
  }
  for (const p of seedRows('properties')) {
    assert.ok(!text.includes(p.street_address) && !text.includes(p.postal_code), `property ${p.property_id}'s address`);
  }
  for (const s of seedRows('staff')) assert.ok(!text.includes(s.name), `staff ${s.staff_id}'s name`);
  const crews = new Set(seedRows('crews').map((c) => c.name));
  for (const r of rows) {
    assert.match(r[0], /^2026-09-\d\d$/);
    assert.ok(crews.has(r[2]), r[2]);
    assert.ok(['yes', 'no'].includes(r[4]));
  }
});

test('questions 3 and 4 each have one top answer, no tie', () => {
  const billing = csvRows(FILES.billing).rows.map((r) => [r[0], cents(r[2])]).sort((a, b) => b[1] - a[1]);
  assert.ok(billing[0][1] > billing[1][1], 'question 3 ties');
  const late = new Map();
  for (const r of csvRows(FILES.complaints).rows) if (r[3] === 'Late arrival') late.set(r[2], (late.get(r[2]) || 0) + 1);
  const ranked = [...late].sort((a, b) => b[1] - a[1]);
  assert.ok(ranked[0][1] > ranked[1][1], 'question 4 ties');
  const q3 = pack.questions.find((q) => q.n === 3);
  const q4 = pack.questions.find((q) => q.n === 4);
  assert.ok(q3.answer.startsWith(`${billing[0][0]}:`));
  assert.ok(q4.answer.startsWith(`${ranked[0][0]},`));
  assert.equal(q4.count, ranked[0][1]);
});

test('the build refuses a tie at the top', () => {
  assert.throws(() => singleTop([['A', 3], ['B', 3], ['C', 1]], 'q'), DemoPackError);
  assert.deepEqual(singleTop([['A', 2], ['B', 3]], 'q'), ['B', 3]);
});

test('each expected answer rests on what the files say', () => {
  assert.equal(pack.questions.length, 5);
  for (const q of pack.questions) {
    for (const fact of q.facts) assert.ok(pack.extracts[q.file].includes(fact), `question ${q.n}: "${fact}" not in ${q.file}`);
  }
  const unresolved = csvRows(FILES.complaints).rows.filter((r) => r[4] === 'no').length;
  const q5 = pack.questions.find((q) => q.n === 5);
  assert.ok(unresolved > 0);
  assert.equal(q5.count, unresolved);
  assert.ok(q5.answer.startsWith(`${unresolved} of `));
});

test('the demo script\'s Stage 1 has each question and its expected answer', () => {
  const script = fs.readFileSync(SCRIPT, 'utf8');
  const stage = script.slice(script.indexOf('## Stage 1: v0'));
  assert.ok(script.includes('## Stage 1: v0'));
  for (const q of pack.questions) {
    assert.ok(stage.includes(q.question), `question ${q.n} missing`);
    assert.ok(stage.includes(q.answer), `answer ${q.n} missing: ${q.answer}`);
  }
  for (const name of Object.values(FILES)) assert.ok(stage.includes(name), name);
});
