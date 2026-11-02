'use strict';

// The v0 demo pack (plan brightside-v1, D4; Story 18.3, rebuilt around three
// business questions): two PDFs and three CSVs built from the fixture by
// examples/brightside/demo-pack/build.js. An example test (architecture
// carve-out): it reads Brightside's own fixture and demo pack (never
// profiles/brightside/), and is deleted with the example in a fork. The
// question figures are worked out again here, independently of the build.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  buildPack, main, singleTop, DemoPackError, FILES, RETIRED, MAX_PACK_CHARS, AUTHOR,
} = require('../demo-pack/build');
const { writePdf, pdfExtract, paginate } = require('../demo-pack/pdf');
const { readCsv, MAX_FILE_BYTES } = require('../../../kit/runtime/slack/files');
const { sniff, pdfPageCount } = require('../../../kit/runtime/llm/file-check');
const { promptChars, CAPS } = require('../../../kit/runtime/knowledge/store');
const { addedContextPrompt } = require('../../../kit/runtime/llm/context');

const ROOT = path.join(__dirname, '../../..');
const PACK = path.join(__dirname, '../demo-pack');
const FIXTURE = path.join(__dirname, '../fixture');
const SCRIPT = path.join(ROOT, 'docs/runtime/demo-script.md');
const AS_OF = '2026-09-30';

const pack = buildPack();
const committed = (name) => fs.readFileSync(path.join(PACK, name));
// A CSV's rows as arrays, through Add context's own reader.
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
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PER_YEAR = { weekly: 52, biweekly: 26, monthly: 12 };
const answer = (n) => pack.questions.find((q) => q.n === n).answer;

test('the committed files are exactly what the build makes (npm run demo-pack -- --check)', () => {
  for (const [name, bytes] of Object.entries(pack.files)) {
    assert.ok(committed(name).equals(bytes), `${name} is stale: run npm run demo-pack`);
  }
  for (const name of RETIRED) assert.ok(!fs.existsSync(path.join(PACK, name)), `${name} is retired`);
  const out = { text: '', write(s) { this.text += s; } };
  const err = { text: '', write(s) { this.text += s; } };
  assert.equal(main(['--check'], { out, err }), 0, err.text);
  assert.match(out.text, /expected answers/);
  for (const q of pack.questions) assert.ok(out.text.includes(q.answer), `question ${q.n}'s answer is printed`);
  for (const f of pack.followUps) assert.ok(out.text.includes(f.answer), `"${f.question}" is printed`);
});

test('two builds give the same bytes', () => {
  const again = buildPack();
  for (const [name, bytes] of Object.entries(pack.files)) assert.ok(again.files[name].equals(bytes), name);
});

test('each PDF sniffs as a PDF of 2 or 3 pages, and its text reads back from its bytes', () => {
  for (const name of [FILES.memo, FILES.agreement]) {
    assert.equal(sniff(committed(name)), 'pdf', name);
    const pages = pdfPageCount(committed(name));
    assert.ok(pages >= 2 && pages <= 3, `${name}: ${pages} pages`);
    assert.equal(pdfExtract(committed(name)), pack.extracts[name]);
    assert.equal(pack.extracts[name].split('\n\n').length, pages, `${name}: one text per page`);
  }
  assert.match(pack.extracts[FILES.memo], /BRIGHTSIDE HOME CLEANING \| INTERNAL MEMO/);
  assert.match(pack.extracts[FILES.memo], /Date: \| June 12, 2026/);
  assert.match(pack.extracts[FILES.agreement], /Effective January 1, 2026/);
});

test('pdf.js: a table row reads back as its cells, a right-aligned cell holds only figures, a page never overflows', () => {
  const bytes = writePdf({
    title: 'T',
    pages: [[{ text: 'Head (1)', bold: true }, { cells: [{ text: 'A', x: 0 }, { text: '$1,234.50', x: 300, right: true }] }]],
    footer: (i, n) => `Page ${i + 1} of ${n}`,
  });
  assert.equal(pdfExtract(bytes), 'Head (1)\nA | $1,234.50\nPage 1 of 1');
  assert.throws(() => writePdf({ title: 'T', pages: [[{ cells: [{ text: 'words', x: 100, right: true }] }]] }), RangeError);
  assert.throws(() => writePdf({ title: 'T', pages: [[{ text: 'café' }]] }), RangeError);
  const line = { text: 'x' };
  assert.equal(paginate([Array(40).fill(line)]).length, 1); // 40 lines of 11pt fit one page
  assert.equal(paginate([Array(30).fill(line), Array(30).fill(line)]).length, 2);
  assert.throws(() => paginate([Array(200).fill(line)]), RangeError);
});

test('each CSV passes Add context\'s readCsv', () => {
  const shape = (name) => {
    const r = readCsv(committed(name));
    return [r.rows, r.columns];
  };
  assert.deepEqual(shape(FILES.planChanges), [9, 8]);
  assert.deepEqual(shape(FILES.aging), [6, 11]);
  assert.deepEqual(shape(FILES.crewTime), [15, 7]);
});

test('the five files fit Slack, Add context and the hub, with room to spare', () => {
  let total = 0;
  for (const [name, text] of Object.entries(pack.extracts)) {
    const bytes = committed(name);
    assert.ok(bytes.length < MAX_FILE_BYTES, `${name}: ${bytes.length} bytes`);
    const chars = promptChars(text);
    assert.ok(chars <= CAPS.file, `${name}: ${chars} characters over the file cap`);
    total += chars;
  }
  assert.equal(total, pack.total);
  assert.ok(total <= MAX_PACK_CHARS, `the five files hold ${total} characters`);
  // As the hub holds them: five notes, each with a title, in one prompt.
  const entries = Object.entries(pack.extracts).map(([name, text], i) => ({
    id: String(i + 1).padStart(32, '0'), title: name.replace(/\.(pdf|csv)$/, ''), text,
  }));
  const prompt = addedContextPrompt(entries);
  assert.ok(prompt.length <= CAPS.hubChars - 3000, `the hub's notes would be ${prompt.length} characters`);
  assert.ok(entries.length < CAPS.hubEntries);
});

test('question 1: cancellations, their yearly value and the gain, worked out again from the seeds', () => {
  const plans = seedRows('plans');
  const changes = seedRows('plan_price_changes');
  const cancelledIn = (ym) => plans.filter((p) => p.status === 'cancelled' && (p.end_date || '').startsWith(ym));
  const value = (ps) => ps.reduce((s, p) => s + Number(p.price_cents) * PER_YEAR[p.frequency], 0);
  const base = ['01', '02', '03', '04', '05', '06'].map((m) => cancelledIn(`2026-${m}`));
  const after = ['07', '08', '09'].map((m) => cancelledIn(`2026-${m}`));
  const baseCount = base.reduce((s, x) => s + x.length, 0);
  const afterCount = after.reduce((s, x) => s + x.length, 0);
  const extra = afterCount - baseCount / 2;
  const extraValue = after.reduce((s, x) => s + value(x), 0) - base.reduce((s, x) => s + value(x), 0) / 2;
  const planBy = new Map(plans.map((p) => [p.plan_id, p]));
  let gain = 0;
  let stayed = 0;
  for (const c of changes) {
    if (!c.effective_date.startsWith('2026-07') || Number(c.new_price_cents) <= Number(c.old_price_cents)) continue;
    const p = planBy.get(c.plan_id);
    if (p.end_date && p.end_date < AS_OF) continue;
    stayed += 1;
    gain += (Number(c.new_price_cents) - Number(c.old_price_cents)) * PER_YEAR[p.frequency];
  }
  assert.ok(extra > 2 * 20, 'the memo\'s expectation is clearly missed');
  const a = answer(1);
  assert.ok(a.includes(`had ${afterCount} plan cancellations, ${extra} more`), a);
  assert.ok(a.includes(`average of ${(baseCount / 6).toFixed(1)} a month`), a);
  assert.ok(a.includes(`worth ${usd(Math.round(extraValue))} a year`), a);
  assert.ok(a.includes(`added ${usd(gain)} a year on the ${stayed} increased plans`), a);
  assert.ok(a.includes(gain > extraValue ? 'yes, it paid off' : 'no, it did not pay off'), a);
  // The CSV carries what the answer needs.
  const { rows } = csvRows(FILES.planChanges);
  assert.deepEqual(rows.map((r) => r[0]), ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((m) => `2026-${m}`));
  assert.equal(rows.reduce((s, r) => s + Number(r[3]), 0), baseCount + afterCount);
  const july = rows[6];
  assert.deepEqual([Number(july[6]), cents(july[7])], [stayed, gain]);
  assert.equal(Number(rows[8][5]), 815, 'active plans at as_of: the signed truth');
});

test('question 2: past due, over 30 days and the late fee, worked out again from the seeds', () => {
  const paid = new Map();
  for (const p of seedRows('payments')) if (p.paid_on <= AS_OF) paid.set(p.invoice_id, (paid.get(p.invoice_id) || 0) + Number(p.amount_cents));
  const days = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;
  let open = 0;
  let pastDue = 0;
  let over30 = 0;
  let over30n = 0;
  let n = 0;
  for (const i of seedRows('invoices')) {
    assert.equal(days(i.due_on, i.issued_on), 14, `invoice ${i.invoice_id} is net 14`);
    const bal = Number(i.total_cents) - (paid.get(i.invoice_id) || 0);
    if (i.issued_on > AS_OF || bal <= 0) continue;
    n += 1;
    open += bal;
    const late = days(AS_OF, i.due_on);
    if (late > 0) pastDue += bal;
    if (late > 30) {
      over30 += bal;
      over30n += 1;
    }
  }
  const targets = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'targets.json'), 'utf8')).truths;
  assert.equal(open, targets['outstanding-at-as-of']);
  const fee = Math.round((over30 * 15) / 1000);
  const a = answer(2);
  for (const s of [usd(pastDue), usd(open), `${n.toLocaleString('en-US')} invoices`, usd(over30), `${over30n} invoices`, usd(fee)]) {
    assert.ok(a.includes(s), `${s} in: ${a}`);
  }
  const { header, rows } = csvRows(FILES.aging);
  const total = rows.find((r) => r[0] === 'All zones');
  const zones = rows.filter((r) => r !== total);
  assert.deepEqual(zones.map((r) => r[0]).sort(), seedRows('zones').map((z) => z.name).sort());
  for (let c = 1; c < header.length; c += 1) {
    assert.equal(zones.reduce((s, r) => s + cents(r[c]), 0), cents(total[c]), `the total row's ${header[c]}`);
  }
  assert.deepEqual([cents(total[7]), cents(total[8]), cents(total[9]), Number(total[10])], [open, pastDue, over30, over30n]);
});

test('question 3: crew time against schedule, worked out again from the seeds', () => {
  const visits = new Map(seedRows('visits').filter((v) => v.status === 'completed' && v.visit_date.startsWith('2026-09'))
    .map((v) => [v.visit_id, v]));
  const crewName = new Map(seedRows('crews').map((c) => [c.crew_id, c.name]));
  const rates = seedRows('pay_rates');
  const staffRate = new Map(seedRows('staff').map((s) => [s.staff_id, Number(s.hourly_rate_cents)]));
  const rateOn = (sid, d) => {
    const r = rates.find((x) => x.staff_id === sid && x.start_date <= d && (!x.end_date || x.end_date >= d));
    return r ? Number(r.hourly_rate_cents) : staffRate.get(sid);
  };
  const by = new Map();
  const seen = new Set();
  for (const t of seedRows('timesheets')) {
    const v = visits.get(t.visit_id);
    if (!v) continue;
    assert.ok(!seen.has(`${t.visit_id}/${t.staff_id}`), 'one timesheet row per staff member per visit');
    seen.add(`${t.visit_id}/${t.staff_id}`);
    const name = crewName.get(v.crew_id);
    const c = by.get(name) || { s: 0, a: 0, cost: 0 };
    c.s += Number(v.scheduled_minutes);
    c.a += Number(t.minutes);
    c.cost += (Number(t.minutes) - Number(v.scheduled_minutes)) * rateOn(t.staff_id, v.visit_date); // cent-minutes
    by.set(name, c);
  }
  const ranked = [...by].map(([name, c]) => [name, ((c.a - c.s) / c.s) * 100, Math.round(c.cost / 60)]).sort((x, y) => y[1] - x[1]);
  assert.ok(ranked[0][1].toFixed(1) !== ranked[1][1].toFixed(1), 'no tie at the top');
  assert.ok(ranked.at(-1)[1].toFixed(1) !== ranked.at(-2)[1].toFixed(1), 'no tie at the bottom');
  const a = answer(3);
  assert.ok(a.startsWith(`${ranked[0][0]} ran furthest over: ${ranked[0][1].toFixed(1)}%`), a);
  assert.ok(a.includes(`${ranked[1][0]} was next at ${ranked[1][1].toFixed(1)}%`), a);
  assert.ok(a.includes(`${ranked.at(-1)[0]} kept closest to schedule`), a);
  assert.ok(a.includes(usd(ranked[0][2])), a);
  const breakers = ranked.filter((r) => r[1] > 8).map((r) => r[0]);
  assert.ok(breakers.length >= 1);
  for (const b of breakers) assert.ok(a.includes(b), `${b} breaks the standard`);
  const { rows } = csvRows(FILES.crewTime);
  assert.equal(rows.length, by.size);
  for (const r of rows) {
    const c = by.get(r[0]);
    assert.deepEqual([Number(r[3]), Number(r[4]), cents(r[6])], [c.s, c.a, Math.round(c.cost / 60)], r[0]);
  }
});

test('no personal data: the CSVs are aggregates, and the PDFs name no client or staff member', () => {
  const clients = seedRows('clients');
  const staff = seedRows('staff');
  const props = seedRows('properties');
  for (const name of [FILES.planChanges, FILES.aging, FILES.crewTime]) {
    const text = pack.extracts[name];
    assert.doesNotMatch(text, /@|\d{3}-\d{4}/, `${name}: an email or a phone number`);
    const words = new Set(text.split(/[\s,]+/));
    for (const c of clients) assert.ok(!words.has(c.first_name) && !words.has(c.last_name), `${name}: client ${c.client_id}'s name`);
    for (const p of props) assert.ok(!text.includes(p.street_address), `${name}: property ${p.property_id}'s address`);
  }
  for (const name of Object.keys(pack.extracts)) {
    const text = pack.extracts[name];
    for (const s of staff) assert.ok(!text.includes(s.name), `${name}: staff ${s.staff_id}'s name`);
    for (const c of clients) assert.ok(!text.includes(`${c.first_name} ${c.last_name}`), `${name}: client ${c.client_id}'s name`);
    assert.doesNotMatch(text, /@/, `${name}: an email`);
  }
  assert.ok(pack.extracts[FILES.memo].includes(AUTHOR));
});

test('the build refuses a tie at the top', () => {
  assert.throws(() => singleTop([['A', 3], ['B', 3], ['C', 1]], 'q'), DemoPackError);
  assert.deepEqual(singleTop([['A', 2], ['B', 3]], 'q'), ['B', 3]);
});

test('each question needs a PDF and a CSV, and each answer rests on what the files say', () => {
  assert.equal(pack.questions.length, 3);
  for (const q of pack.questions) {
    assert.equal(q.files.filter((f) => f.endsWith('.pdf')).length, 1, `question ${q.n}`);
    assert.equal(q.files.filter((f) => f.endsWith('.csv')).length, 1, `question ${q.n}`);
  }
  for (const item of [...pack.questions, ...pack.followUps]) {
    for (const [file, fact] of item.facts) {
      assert.ok(item.files.includes(file), `"${item.question}": ${file} is one of its files`);
      assert.ok(pack.extracts[file].includes(fact), `"${item.question}": "${fact}" not in ${file}`);
    }
  }
});

test('the demo script\'s Stage 1 has each question, its expected answer and each follow-up; no retired file anywhere', () => {
  const script = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(script.includes('## Stage 1: v0'));
  const stage = script.slice(script.indexOf('## Stage 1: v0'), script.indexOf('## Stage 2: v1'));
  for (const q of pack.questions) {
    assert.ok(stage.includes(q.question), `question ${q.n} missing`);
    assert.ok(stage.includes(q.answer), `answer ${q.n} missing: ${q.answer}`);
  }
  for (const f of pack.followUps) {
    assert.ok(stage.includes(f.question), `follow-up missing: ${f.question}`);
    assert.ok(stage.includes(f.answer), `follow-up answer missing: ${f.answer}`);
  }
  for (const name of Object.values(FILES)) assert.ok(stage.includes(name), name);
  for (const name of RETIRED) assert.ok(!script.includes(name), `${name} is retired`);
  assert.ok(!/4 notes/.test(script), 'the pack is five notes now');
});
