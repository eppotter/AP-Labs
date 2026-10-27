'use strict';

// Stories 7.1 and 7.2: Brightside's fixture generator. Example tests (AD-1
// carve-out): they read Brightside's own fixture and go with it in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { generate, checkCommitted, readSeedConfig, writeFiles, storedName, gzipSeed, gzipHeaderProblem } = require('../generate');
const { createRng } = require('../lib/prng');
const { checkRules } = require('../lib/rules');
const { ZONES, HISTORY_START, AS_OF } = require('../lib/reference');
const W = require('../lib/words');

const FIXTURE_DIR = path.join(__dirname, '..');
const GENERATE = path.join(FIXTURE_DIR, 'generate.js');
const SMALL = { seed: 7, clients: 60 };
const ruleOpts = { zones: ZONES, historyStart: HISTORY_START, asOf: AS_OF };

// A seed file's text: unzipped for a .csv.gz.
const seedText = (file) => (file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8'));

// The seed files never quote (asserted below), so a plain split is a full parse.
function readCsv(file) {
  const text = seedText(file);
  const lines = text.slice(0, -1).split('\n');
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] === '' ? null : cells[i]]));
  });
  return { text, header, rows };
}

function committed(table) {
  return readCsv(path.join(FIXTURE_DIR, storedName(`seeds/${table}.csv`)));
}

function schemaColumns() {
  const sql = fs.readFileSync(path.join(FIXTURE_DIR, 'schema.sql'), 'utf8');
  const tables = {};
  for (const m of sql.matchAll(/CREATE TABLE (\w+) \(\n([\s\S]*?)\n\);/g)) {
    // Column lines only: a table-level UNIQUE (...) line names no column.
    tables[m[1]] = m[2].split(',\n').map((line) => line.trim()).filter((line) => !line.startsWith('UNIQUE (')).map((line) => line.split(' ')[0]);
  }
  return tables;
}

const fileBytes = (files) => [...files].map(([rel, content]) => `${rel}\0${content}`).join('\0');

test('same seed gives byte-identical files; a different seed does not', () => {
  const a = generate(SMALL).files;
  const b = generate(SMALL).files;
  assert.equal(fileBytes(a), fileBytes(b));
  const c = generate({ ...SMALL, seed: 8 }).files;
  assert.notEqual(c.get('seeds/clients.csv'), a.get('seeds/clients.csv'));
  assert.notEqual(c.get('seeds/crew_memberships.csv'), a.get('seeds/crew_memberships.csv'));
  assert.equal(c.get('schema.sql'), a.get('schema.sql'), 'the schema does not depend on the seed');
});

test('the committed files match a fresh generate from the recorded seed', () => {
  const config = readSeedConfig();
  assert.equal(config.clients, 2000, 'Tier 1 size');
  assert.ok(Number.isInteger(config.seed) && Number.isInteger(config.generator_version));
  assert.deepEqual(checkCommitted(), []);
});

test('the check names a changed, a missing and an extra seed file', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-check-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const config = readSeedConfig();
  const { files } = generate(SMALL);
  // Lay down a small-seed copy, then break it four ways.
  writeFiles(tmp, files);
  assert.deepEqual(checkCommitted(tmp, SMALL), []);
  fs.writeFileSync(path.join(tmp, 'seeds/zones.csv.gz'), gzipSeed(`${files.get('seeds/zones.csv')}moon,Moon\n`));
  fs.rmSync(path.join(tmp, 'seeds/crews.csv.gz'));
  fs.writeFileSync(path.join(tmp, 'seeds/stray.csv'), 'x\n');
  // A plain copy left beside its .gz is a stale file, not a seed.
  fs.writeFileSync(path.join(tmp, 'seeds/packages.csv'), files.get('seeds/packages.csv'));
  assert.deepEqual(checkCommitted(tmp, SMALL), [
    'seeds/zones.csv.gz: differs from a fresh generate',
    'seeds/crews.csv.gz: missing (run npm run fixture:generate)',
    'seeds/packages.csv: not written by the generator',
    'seeds/stray.csv: not written by the generator',
  ]);
  // CRLF line endings are a difference too.
  const crlf = seedText(path.join(FIXTURE_DIR, 'seeds/zones.csv.gz')).replace(/\n/g, '\r\n');
  fs.writeFileSync(path.join(tmp, 'seeds/zones.csv.gz'), gzipSeed(crlf));
  assert.ok(checkCommitted(tmp, config).includes('seeds/zones.csv.gz: differs from a fresh generate'));
  // So is the plain fixture_meta.csv, byte for byte.
  fs.appendFileSync(path.join(tmp, 'seeds/fixture_meta.csv'), 'extra,1\n');
  assert.ok(checkCommitted(tmp, SMALL).includes('seeds/fixture_meta.csv: differs from a fresh generate'));
});

test('every seed but fixture_meta.csv is stored as a deterministic gzip', () => {
  assert.equal(storedName('seeds/visits.csv'), 'seeds/visits.csv.gz');
  assert.equal(storedName('seeds/fixture_meta.csv'), 'seeds/fixture_meta.csv');
  assert.equal(storedName('schema.sql'), 'schema.sql');
  const gz = gzipSeed('a,b\n1,2\n');
  // Magic, deflate, no flags (no name or comment), time 0, OS byte 255.
  assert.deepEqual([...gz.subarray(0, 8)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0]);
  assert.equal(gz[9], 255);
  assert.ok(gz.equals(gzipSeed('a,b\n1,2\n')));
  assert.equal(zlib.gunzipSync(gz).toString('utf8'), 'a,b\n1,2\n');
  assert.equal(gzipHeaderProblem(gz), null);
});

test('the check compares unzipped content and the gzip header, never the deflate bytes', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-gzip-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { files } = generate(SMALL);
  writeFiles(tmp, files);
  const zones = path.join(tmp, 'seeds/zones.csv.gz');
  const content = Buffer.from(files.get('seeds/zones.csv'));
  // Other deflate bytes for the same content (as another zlib build gives) pass.
  const other = zlib.gzipSync(content, { level: 1 });
  other[9] = 255;
  assert.ok(!other.equals(fs.readFileSync(zones)), 'a different deflate stream');
  fs.writeFileSync(zones, other);
  assert.deepEqual(checkCommitted(tmp, SMALL), []);
  // A header that stores a time, a name or the OS, or no gzip at all, does not.
  const withTime = Buffer.from(other);
  withTime.writeUInt32LE(1_700_000_000, 4);
  const withOs = Buffer.from(other);
  withOs[9] = 3;
  const cases = [
    [withTime, 'its gzip header stores a time'],
    [withOs, 'its gzip header has OS byte 3, not 255'],
    [Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 255]), Buffer.from('zones.csv\0'), other.subarray(10)]), 'its gzip header stores a name, comment or extra field'],
    [content, 'not a gzip file'],
  ];
  for (const [bytes, problem] of cases) {
    fs.writeFileSync(zones, bytes);
    assert.deepEqual(checkCommitted(tmp, SMALL), [`seeds/zones.csv.gz: ${problem}`], problem);
  }
  // A valid header on a broken stream is reported, not thrown.
  fs.writeFileSync(zones, Buffer.concat([other.subarray(0, 12), Buffer.alloc(40, 0xff)]));
  assert.match(checkCommitted(tmp, SMALL)[0], /^seeds\/zones\.csv\.gz: does not unzip: /);
});

test('writing leaves a matching .gz alone, rewrites a wrong one and deletes the stale .csv', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-write-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { files } = generate(SMALL);
  const seeds = path.join(tmp, 'seeds');
  // An older, uncompressed layout: every seed as plain .csv.
  fs.mkdirSync(seeds, { recursive: true });
  for (const [rel, content] of files) fs.writeFileSync(path.join(tmp, rel), content);
  writeFiles(tmp, files);
  const want = [...files.keys()].filter((rel) => rel.startsWith('seeds/')).map((rel) => path.basename(storedName(rel))).sort();
  assert.deepEqual(fs.readdirSync(seeds).sort(), want);
  assert.ok(want.includes('fixture_meta.csv') && want.includes('visits.csv.gz'));
  assert.deepEqual(checkCommitted(tmp, SMALL), []);

  // Same content, other deflate bytes: left alone. Changed content or a bad
  // header: rewritten.
  const visits = path.join(seeds, 'visits.csv.gz');
  const kept = zlib.gzipSync(Buffer.from(files.get('seeds/visits.csv')), { level: 1 });
  kept[9] = 255;
  fs.writeFileSync(visits, kept);
  const plans = path.join(seeds, 'plans.csv.gz');
  fs.writeFileSync(plans, gzipSeed('plan_id\n'));
  const zones = path.join(seeds, 'zones.csv.gz');
  fs.writeFileSync(zones, zlib.gzipSync(Buffer.from(files.get('seeds/zones.csv'))));
  // A .gz beside the plain fixture_meta.csv is the stale form there.
  fs.writeFileSync(path.join(seeds, 'fixture_meta.csv.gz'), gzipSeed(files.get('seeds/fixture_meta.csv')));
  writeFiles(tmp, files);
  assert.ok(fs.readFileSync(visits).equals(kept), 'a .gz with matching content is not rewritten');
  assert.ok(fs.readFileSync(plans).equals(gzipSeed(files.get('seeds/plans.csv'))));
  assert.ok(fs.readFileSync(zones).equals(gzipSeed(files.get('seeds/zones.csv'))));
  assert.deepEqual(fs.readdirSync(seeds).sort(), want);
  assert.deepEqual(checkCommitted(tmp, SMALL), []);
});

test('the CLI: --check passes on the repo, bad flags exit 2, --out writes a small seed', (t) => {
  const check = spawnSync(process.execPath, [GENERATE, '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /match a fresh generate/);

  for (const bad of [['--check', '--seed', '3'], ['--seed'], ['--clients', '-1'], ['--bogus']]) {
    const r = spawnSync(process.execPath, [GENERATE, ...bad], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${bad.join(' ')}: ${r.stderr}`);
  }

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [GENERATE, '--seed', '7', '--clients', '60', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(seedText(path.join(out, 'seeds/clients.csv.gz')), generate(SMALL).files.get('seeds/clients.csv'));
  assert.ok(!fs.existsSync(path.join(out, 'seeds/clients.csv')));
});

test('schema.sql and the seed files agree on tables and columns', () => {
  const schema = schemaColumns();
  const expected = ['zones', 'packages', 'add_ons', 'crews', 'staff', 'pay_rates', 'crew_memberships', 'clients', 'properties',
    'plans', 'plan_price_changes', 'visits', 'invoices', 'invoice_lines', 'payments', 'timesheets', 'scheduled_visits', 'service_rules',
    'staff_absences', 'depots', 'fixture_meta'];
  assert.deepEqual(Object.keys(schema), expected, 'load order: referenced tables first');
  assert.deepEqual(fs.readdirSync(path.join(FIXTURE_DIR, 'seeds')).sort(), expected.map((t) => (t === 'fixture_meta' ? `${t}.csv` : `${t}.csv.gz`)).sort());
  for (const table of expected) assert.deepEqual(committed(table).header, schema[table], table);
  // The columns fixture-tables.md names. Appended columns come after the
  // original ones, which keep their order.
  assert.deepEqual(schema.crew_memberships, ['membership_id', 'crew_id', 'staff_name', 'start_date', 'end_date', 'staff_id']);
  assert.deepEqual(schema.clients, ['client_id', 'zone_id', 'first_name', 'last_name', 'email', 'phone', 'created_on']);
  assert.deepEqual(schema.crews, ['crew_id', 'zone_id', 'name', 'base_geo_lat_e6', 'base_geo_lon_e6']);
  assert.deepEqual(schema.properties, ['property_id', 'client_id', 'street_address', 'city', 'postal_code',
    'home_type', 'square_feet', 'bedrooms', 'bathrooms', 'has_pets', 'access_method', 'geo_lat_e6', 'geo_lon_e6']);
  assert.deepEqual(schema.scheduled_visits, ['scheduled_visit_id', 'property_id', 'plan_id', 'crew_id', 'package_id', 'visit_date', 'status',
    'status_changed_on', 'arrival_window', 'scheduled_start', 'scheduled_minutes', 'labour_minutes', 'route_order', 'travel_minutes_from_previous']);
  assert.deepEqual(schema.service_rules, ['rule_id', 'property_id', 'rule_type', 'value', 'strength']);
  assert.deepEqual(schema.staff_absences, ['absence_id', 'staff_id', 'absence_date', 'reported_on']);
  assert.deepEqual(schema.depots, ['depot_id', 'name', 'geo_lat_e6', 'geo_lon_e6']);
  assert.deepEqual(schema.staff, ['staff_id', 'name', 'role', 'hire_date', 'end_date', 'hourly_rate_cents']);
  assert.deepEqual(schema.pay_rates, ['rate_id', 'staff_id', 'start_date', 'end_date', 'role', 'hourly_rate_cents']);
  assert.deepEqual(schema.timesheets, ['timesheet_id', 'visit_id', 'staff_id', 'clock_in', 'clock_out', 'minutes']);
  assert.deepEqual(schema.plans, ['plan_id', 'property_id', 'package_id', 'frequency', 'start_date', 'end_date', 'status', 'start_price_cents', 'price_cents']);
  assert.deepEqual(schema.plan_price_changes, ['change_id', 'plan_id', 'effective_date', 'old_price_cents', 'new_price_cents']);
  assert.deepEqual(schema.visits, ['visit_id', 'property_id', 'plan_id', 'crew_id', 'package_id', 'visit_date', 'status',
    'arrival_window', 'scheduled_start', 'scheduled_minutes', 'route_order', 'travel_minutes_from_previous']);
  assert.deepEqual(schema.invoices, ['invoice_id', 'client_id', 'visit_id', 'issued_on', 'due_on', 'total_cents']);
  assert.deepEqual(schema.invoice_lines, ['line_id', 'invoice_id', 'package_id', 'add_on_id', 'quantity', 'amount_cents']);
  assert.deepEqual(schema.payments, ['payment_id', 'invoice_id', 'paid_on', 'amount_cents', 'method']);
  assert.deepEqual(schema.fixture_meta, ['key', 'value']);
  const sql = fs.readFileSync(path.join(FIXTURE_DIR, 'schema.sql'), 'utf8');
  assert.match(sql, /UNIQUE \(plan_id, effective_date\)/);
  assert.match(sql, /UNIQUE \(property_id, rule_type\)/);
  assert.match(sql, /UNIQUE \(staff_id, absence_date\)/);
  assert.match(sql, /visit_id INTEGER NOT NULL UNIQUE REFERENCES visits \(visit_id\)/);
});

test('seed files are LF-only, unquoted, sorted by primary key, with stable formats', () => {
  const formats = { _cents: /^\d+$/, _date: /^\d{4}-\d{2}-\d{2}$/, _on: /^\d{4}-\d{2}-\d{2}$/, quantity: /^\d+$/ };
  for (const [table, schemaCols] of Object.entries(schemaColumns())) {
    const { text, rows } = committed(table);
    assert.ok(text.endsWith('\n') && !text.includes('\r') && !text.includes('"'), table);
    const pk = schemaCols[0];
    const keys = rows.map((r) => r[pk]);
    const sorted = /_id$/.test(pk) && /^\d+$/.test(keys[0]) ? keys.slice().sort((a, b) => a - b) : keys.slice().sort();
    assert.deepEqual(keys, sorted, `${table} ordered by ${pk}`);
    for (const row of rows) {
      for (const [col, value] of Object.entries(row)) {
        if (value === null) continue;
        for (const [suffix, re] of Object.entries(formats)) {
          if (col.endsWith(suffix)) assert.match(value, re, `${table}.${col}`);
        }
      }
    }
  }
  const { rows } = committed('clients');
  assert.ok(rows.length > 1900 && rows.length < 2100, 'about 2,000 clients');
});

test('synthetic rules hold in the committed files', () => {
  const clients = committed('clients').rows;
  const emails = new Set(clients.map((c) => c.email));
  assert.equal(emails.size, clients.length, 'emails are unique');
  for (const c of clients) {
    assert.ok(c.email.endsWith('.invalid'), c.email);
    assert.match(c.phone, /^555-01\d\d$/);
    assert.ok(W.FIRST_NAMES.includes(c.first_name), c.first_name);
    assert.ok(W.LAST_PREFIXES.some((p) => c.last_name.startsWith(p) && W.LAST_SUFFIXES.includes(c.last_name.slice(p.length))), c.last_name);
    assert.ok(c.created_on >= HISTORY_START && c.created_on <= AS_OF, c.created_on);
  }

  for (const [table, col] of [['packages', 'base_price_cents'], ['add_ons', 'price_cents']]) {
    for (const row of committed(table).rows) assert.ok(Number.isSafeInteger(Number(row[col])) && /^\d+$/.test(row[col]), `${table}.${col}`);
  }

  const zoneOf = new Map(clients.map((c) => [c.client_id, c.zone_id]));
  const citiesOf = new Map(ZONES.map((z) => [z.zone_id, z.cities]));
  for (const p of committed('properties').rows) {
    assert.ok(citiesOf.get(zoneOf.get(p.client_id)).includes(p.city), `property ${p.property_id} in its client's zone`);
  }

  const byStaff = new Map();
  for (const m of committed('crew_memberships').rows) {
    if (!byStaff.has(m.staff_name)) byStaff.set(m.staff_name, []);
    byStaff.get(m.staff_name).push(m);
    assert.ok(m.end_date === null || (m.end_date >= m.start_date && m.end_date <= AS_OF));
  }
  let rejoined = 0;
  for (const periods of byStaff.values()) {
    periods.sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
    if (periods.length > 1) rejoined++;
    for (let i = 1; i < periods.length; i++) {
      assert.ok(periods[i - 1].end_date !== null && periods[i].start_date > periods[i - 1].end_date, `${periods[i].staff_name} overlaps`);
    }
  }
  assert.ok(rejoined > 0, 'some staff move between crews, so the overlap rule is exercised');
});

test('the rule check catches each broken rule once', () => {
  const { tables } = generate(SMALL);
  assert.deepEqual(checkRules(tables, ruleOpts), []);
  const broken = (mutate) => {
    const copy = JSON.parse(JSON.stringify(tables));
    mutate(copy);
    // Keep the row counts true, so only the broken rule reports.
    for (const m of copy.fixture_meta) if (m.key.startsWith('rows_')) m.value = String(copy[m.key.slice(5)].length);
    return checkRules(copy, ruleOpts);
  };
  const cases = [
    [(t) => { t.clients[0].email = 'a@example.com'; }, /does not end in \.invalid/],
    [(t) => { t.clients[1].email = t.clients[0].email; }, /is not unique/],
    [(t) => { t.clients[0].phone = '555-0200'; }, /is not 555-0100 to 555-0199/],
    [(t) => { t.packages[0].base_price_cents = 140.5; }, /is not whole cents/],
    [(t) => { t.properties[0].city = ZONES.find((z) => z.zone_id !== t.clients[0].zone_id).cities[0]; }, /city .* is not in zone/],
    [(t) => { t.properties[0].postal_code = '09999'; }, /postal code .* is not in zone/],
    [(t) => { t.properties[0].client_id = 99999; }, /has no clients row/],
    [(t) => { t.crews.push({ ...t.crews[0] }); }, /duplicate crew_id/],
    [(t) => { t.clients[0].created_on = '2024-09-30'; }, /is outside/],
    [(t) => {
      // A second, open-ended period for someone who has only one.
      const once = t.crew_memberships.filter((m) => t.crew_memberships.filter((o) => o.staff_name === m.staff_name).length === 1);
      t.crew_memberships.push({ ...once[0], membership_id: 9999, crew_id: 2, end_date: null });
    }, /periods overlap/],
    [(t) => {
      // Someone with one period, so moving its end cannot also overlap another.
      const once = t.crew_memberships.find((m) => t.crew_memberships.filter((o) => o.staff_name === m.staff_name).length === 1);
      once.end_date = '2026-10-01';
    }, /ends after as_of/],
  ];
  for (const [mutate, expected] of cases) {
    const problems = broken(mutate);
    assert.equal(problems.length, 1, `${expected}: ${problems.join('; ')}`);
    assert.match(problems[0], expected);
  }
});

test('the generator refuses to write data that breaks a rule', (t) => {
  const original = W.EMAIL_DOMAINS.slice();
  W.EMAIL_DOMAINS.splice(0, W.EMAIL_DOMAINS.length, 'example.com');
  t.after(() => W.EMAIL_DOMAINS.splice(0, W.EMAIL_DOMAINS.length, ...original));
  assert.throws(() => generate(SMALL), /breaks \d+ rule\(s\)[\s\S]*does not end in \.invalid/);
});

test('the PRNG is seeded, bounded and rejects a bad seed', () => {
  const seq = (seed) => { const r = createRng(seed); return Array.from({ length: 5 }, () => r.u32()); };
  assert.deepEqual(seq(42), seq(42));
  assert.notDeepEqual(seq(42), seq(43));
  const r = createRng(1);
  for (let i = 0; i < 1000; i++) {
    const n = r.int(3, 5);
    assert.ok(n >= 3 && n <= 5 && Number.isInteger(n));
    const f = r.next();
    assert.ok(f >= 0 && f < 1);
  }
  for (const bad of [-1, 1.5, 2 ** 32, '7']) assert.throws(() => createRng(bad), TypeError);
});

test('the generator reads no clock and no OS randomness', () => {
  const sources = ['generate.js', ...fs.readdirSync(path.join(FIXTURE_DIR, 'lib')).map((f) => `lib/${f}`)]
    // Comments may name what is banned; code may not use it.
    .map((f) => fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  for (const src of sources) {
    assert.doesNotMatch(src, /Math\.random|Date\.now|new Date\(\)|crypto|performance\.now|process\.hrtime/);
  }
});
