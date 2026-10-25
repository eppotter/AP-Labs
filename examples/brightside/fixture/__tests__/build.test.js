'use strict';

// Story 7.3: Brightside's committed schema and seeds build into DuckDB. Most
// seeds are stored as seeds/<table>.csv.gz (plan seed-compress); the build
// and the fixture version read them as the plain CSVs they unzip to.
// Example test (AD-1 carve-out): it reads Brightside's own fixture and goes
// with it in a fork. It builds into a temporary directory, never var/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { build, readRows, isBuildOf, FixtureBuildError } = require('../../../../kit/fixture/build');
const { seedsHash } = require('../../../../kit/fixture/remote');

const FIXTURE_DIR = path.join(__dirname, '..');

function meta() {
  const lines = fs.readFileSync(path.join(FIXTURE_DIR, 'seeds', 'fixture_meta.csv'), 'utf8').trim().split('\n').slice(1);
  return Object.fromEntries(lines.map((l) => l.split(',')));
}

test('Brightside builds in under 60 seconds with every table at its fixture_meta count', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brightside-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'brightside.duckdb');

  const result = await build({ fixtureDir: FIXTURE_DIR, out });
  assert.ok(result.ms < 60_000, `build took ${result.ms} ms`);

  const m = meta();
  const expected = Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('rows_')).map(([k, v]) => [k.slice(5), Number(v)]));
  assert.equal(Object.keys(expected).length, 16);
  const loaded = Object.fromEntries(result.tables.filter((x) => x.name !== 'fixture_meta').map((x) => [x.name, x.rows]));
  assert.deepEqual(loaded, expected);

  // Counted again from the file itself, opened read-only.
  const union = Object.keys(expected).map((table) => `SELECT '${table}' AS t, count(*)::INT AS n FROM ${table}`).join(' UNION ALL ');
  const counted = Object.fromEntries((await readRows(out, union)).map((r) => [r.t, r.n]));
  assert.deepEqual(counted, expected);

  // Spot rows: the first client and property, with zero-padded postal codes kept as text.
  assert.deepEqual(await readRows(out, 'SELECT client_id, zone_id, first_name, last_name, email, created_on FROM clients WHERE client_id = 1'), [
    { client_id: 1, zone_id: 'central', first_name: 'Briar', last_name: 'Redley', email: 'briar.redley.1@home.invalid', created_on: '2024-12-07' },
  ]);
  assert.deepEqual(await readRows(out, 'SELECT property_id, client_id, city, postal_code FROM properties WHERE property_id = 1'), [
    { property_id: 1, client_id: 1, city: 'Centerpoint', postal_code: '00402' },
  ]);
  // A one-package invoice line has a NULL add-on, not an empty string.
  assert.deepEqual(await readRows(out, 'SELECT line_id, package_id, add_on_id, amount_cents FROM invoice_lines WHERE line_id = 1'), [
    { line_id: 1, package_id: 'standard', add_on_id: null, amount_cents: '14600' },
  ]);
  assert.deepEqual(await readRows(out, "SELECT value FROM fixture_meta WHERE key = 'as_of'"), [{ value: m.as_of }]);
});

// The version Brightside's seeds had as plain CSVs, before they were
// compressed. Compressing must not change it, so the shared MotherDuck copy
// and the bot see no change. A seed or generator change moves it on purpose:
// update it then.
const VERSION_AS_PLAIN_CSV = '3+80453e2a90d0';

// A copy of the fixture with every seed unzipped to plain seeds/<table>.csv.
function plainCopy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brightside-plain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(FIXTURE_DIR, 'schema.sql'), path.join(dir, 'schema.sql'));
  fs.mkdirSync(path.join(dir, 'seeds'));
  for (const f of fs.readdirSync(path.join(FIXTURE_DIR, 'seeds'))) {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, 'seeds', f));
    if (f.endsWith('.gz')) fs.writeFileSync(path.join(dir, 'seeds', f.slice(0, -3)), zlib.gunzipSync(raw));
    else fs.writeFileSync(path.join(dir, 'seeds', f), raw);
  }
  return dir;
}

test('compressed seeds keep the fixture version and build exactly the rows their plain CSVs build', async (t) => {
  const seeds = fs.readdirSync(path.join(FIXTURE_DIR, 'seeds'));
  assert.ok(seeds.filter((f) => f.endsWith('.csv.gz')).length >= 15, 'the seeds are compressed');
  assert.equal(`${meta().generator_version}+${seedsHash(FIXTURE_DIR).slice(0, 12)}`, VERSION_AS_PLAIN_CSV);

  const plain = plainCopy(t);
  assert.equal(seedsHash(plain), seedsHash(FIXTURE_DIR), 'a .csv.gz hashes as its unzipped .csv');
  const out = path.join(plain, 'plain.duckdb');
  await build({ fixtureDir: plain, out });
  // Same tables, column types and rows (kit/fixture/build contentDigest).
  assert.equal(await isBuildOf(out, FIXTURE_DIR), true);
});

test('a seed in both .csv and .csv.gz, or a .gz that will not unzip, is refused', async (t) => {
  const both = plainCopy(t);
  fs.copyFileSync(path.join(FIXTURE_DIR, 'seeds', 'zones.csv.gz'), path.join(both, 'seeds', 'zones.csv.gz'));
  const out = path.join(both, 'x.duckdb');
  const ambiguous = /seeds\/zones\.csv and seeds\/zones\.csv\.gz are both present/;
  await assert.rejects(build({ fixtureDir: both, out }), (err) => err instanceof FixtureBuildError && ambiguous.test(err.message));
  assert.throws(() => seedsHash(both), ambiguous);
  assert.ok(!fs.existsSync(out));

  const broken = plainCopy(t);
  fs.rmSync(path.join(broken, 'seeds', 'zones.csv'));
  fs.writeFileSync(path.join(broken, 'seeds', 'zones.csv.gz'), Buffer.from('zone_id,name\n'));
  const notGzip = /seeds\/zones\.csv\.gz is not valid gzip/;
  await assert.rejects(build({ fixtureDir: broken, out: path.join(broken, 'x.duckdb') }), (err) => err instanceof FixtureBuildError && notGzip.test(err.message));
  assert.throws(() => seedsHash(broken), notGzip);
});

test('a compressed seed\'s header is checked unzipped', async (t) => {
  const dir = plainCopy(t);
  fs.rmSync(path.join(dir, 'seeds', 'zones.csv'));
  fs.writeFileSync(path.join(dir, 'seeds', 'zones.csv.gz'), zlib.gzipSync('name,zone_id\nx,y\n'));
  await assert.rejects(build({ fixtureDir: dir, out: path.join(dir, 'x.duckdb') }), /seeds\/zones\.csv header \(name,zone_id\) does not match table columns/);
});
