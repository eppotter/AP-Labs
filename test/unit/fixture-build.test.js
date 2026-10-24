'use strict';

// Story 7.3: kit/fixture/build loads a fixture's schema and seeds into DuckDB.
// Engine tests: they read the minimal fixture in test/fixtures/fixture-build/,
// never a client's, and each builds into its own temporary directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build, readRows, main, parseArgs, defaultOut, schemaTables, FixtureBuildError } = require('../../kit/fixture/build');

const REPO = path.join(__dirname, '..', '..');
const MINI = path.join(__dirname, '..', 'fixtures', 'fixture-build', 'mini');
const BUILD = path.join(REPO, 'kit', 'fixture', 'build.js');

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-fixture-build-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A writable copy of the minimal fixture, for tests that break it.
function copyMini(t) {
  const dir = path.join(tmpDir(t), 'fixture');
  fs.cpSync(MINI, dir, { recursive: true });
  return dir;
}

test('builds every table with row counts matching fixture_meta', async (t) => {
  const out = path.join(tmpDir(t), 'db', 'mini.duckdb');
  const result = await build({ fixtureDir: MINI, out });
  assert.equal(result.out, out);
  assert.deepEqual(result.tables, [
    { name: 'regions', rows: 2 },
    { name: 'shops', rows: 3 },
    { name: 'fixture_meta', rows: 3 },
  ]);
  const counts = await readRows(out, "SELECT (SELECT count(*) FROM regions)::INT AS regions, (SELECT count(*) FROM shops)::INT AS shops");
  assert.deepEqual(counts, [{ regions: 2, shops: 3 }]);
});

test('loads values with the schema types: zero-padded text, NULL dates, BIGINT cents', async (t) => {
  const out = path.join(tmpDir(t), 'mini.duckdb');
  await build({ fixtureDir: MINI, out });
  const rows = await readRows(out, 'SELECT shop_id, region_id, postal_code, opened_on, closed_on, revenue_cents FROM shops ORDER BY shop_id');
  assert.deepEqual(rows[0], { shop_id: 1, region_id: 'hill', postal_code: '00402', opened_on: '2025-01-15', closed_on: null, revenue_cents: '9007199254740993' });
  assert.equal(rows[1].closed_on, '2025-12-31');
  const types = await readRows(out, "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'shops' ORDER BY ordinal_position");
  assert.deepEqual(types.map((r) => r.data_type), ['INTEGER', 'VARCHAR', 'VARCHAR', 'DATE', 'DATE', 'BIGINT']);
});

test('a rebuild replaces the file whole and leaves no temporary files', async (t) => {
  const dir = tmpDir(t);
  const out = path.join(dir, 'mini.duckdb');
  await build({ fixtureDir: MINI, out });
  const second = await build({ fixtureDir: MINI, out });
  assert.deepEqual(second.tables.map((x) => x.rows), [2, 3, 3]);
  const rows = await readRows(out, 'SELECT count(*)::INT AS n FROM shops');
  assert.deepEqual(rows, [{ n: 3 }], 'no duplicated rows after a rebuild');
  assert.deepEqual(fs.readdirSync(dir), ['mini.duckdb']);
});

test('a row count that disagrees with fixture_meta fails and keeps the old file', async (t) => {
  const fixture = copyMini(t);
  const out = path.join(tmpDir(t), 'mini.duckdb');
  await build({ fixtureDir: fixture, out });
  const before = fs.readFileSync(out);
  fs.writeFileSync(path.join(fixture, 'seeds', 'fixture_meta.csv'), 'key,value\nas_of,2026-09-30\nrows_regions,2\nrows_shops,4\n');
  await assert.rejects(build({ fixtureDir: fixture, out }), (err) => err instanceof FixtureBuildError && /shops: 3 rows loaded, fixture_meta says 4/.test(err.message));
  assert.ok(before.equals(fs.readFileSync(out)), 'the previous build is untouched');
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['mini.duckdb']);
});

test('a table missing from fixture_meta, or a count for no table, fails', async (t) => {
  const fixture = copyMini(t);
  fs.writeFileSync(path.join(fixture, 'seeds', 'fixture_meta.csv'), 'key,value\nrows_regions,2\nrows_ghosts,1\n');
  await assert.rejects(build({ fixtureDir: fixture, out: path.join(tmpDir(t), 'x.duckdb') }), (err) =>
    /fixture_meta has no rows_shops/.test(err.message) && /rows_ghosts but there is no table ghosts/.test(err.message));
});

test('a seed header that does not match the table columns fails', async (t) => {
  const fixture = copyMini(t);
  fs.writeFileSync(path.join(fixture, 'seeds', 'regions.csv'), 'name,region_id\nHill,hill\nVale,vale\n');
  await assert.rejects(build({ fixtureDir: fixture, out: path.join(tmpDir(t), 'x.duckdb') }), /seeds\/regions\.csv header \(name,region_id\) does not match table columns \(region_id,name\)/);
});

test('a missing or extra seed file fails before DuckDB opens', async (t) => {
  const fixture = copyMini(t);
  fs.rmSync(path.join(fixture, 'seeds', 'shops.csv'));
  fs.writeFileSync(path.join(fixture, 'seeds', 'extra.csv'), 'a\n1\n');
  const out = path.join(tmpDir(t), 'x.duckdb');
  await assert.rejects(build({ fixtureDir: fixture, out }), (err) =>
    /table shops has no seeds\/shops\.csv/.test(err.message) && /seeds\/extra\.csv has no table/.test(err.message));
  assert.equal(fs.existsSync(out), false);
});

test('a bad value fails the build as a FixtureBuildError and writes nothing', async (t) => {
  const fixture = copyMini(t);
  fs.writeFileSync(path.join(fixture, 'seeds', 'shops.csv'), 'shop_id,region_id,postal_code,opened_on,closed_on,revenue_cents\n1,nowhere,00402,2025-01-15,,1\n');
  const dir = tmpDir(t);
  await assert.rejects(build({ fixtureDir: fixture, out: path.join(dir, 'x.duckdb') }), (err) => err instanceof FixtureBuildError && /DuckDB load failed/.test(err.message));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('schemaTables lists tables in creation order', () => {
  assert.deepEqual(schemaTables(fs.readFileSync(path.join(MINI, 'schema.sql'), 'utf8')), ['regions', 'shops', 'fixture_meta']);
});

test('the default file is var/fixture/<client>.duckdb, under APLABS_VAR_DIR when set', () => {
  assert.equal(defaultOut('/x/acme/fixture', null, {}), path.join(REPO, 'var', 'fixture', 'acme.duckdb'));
  assert.equal(defaultOut('/x/acme/fixture', 'other', { APLABS_VAR_DIR: '/v' }), path.join('/v', 'fixture', 'other.duckdb'));
});

test('var/ is gitignored, so a built file is never committed', () => {
  const r = spawnSync('git', ['check-ignore', '-q', 'var/fixture/brightside.duckdb'], { cwd: REPO });
  assert.equal(r.status, 0);
});

test('parseArgs and main report usage errors with exit 2', async () => {
  assert.deepEqual(parseArgs(['fx', '--out', 'a.duckdb']), { fixtureDir: 'fx', out: 'a.duckdb', name: null });
  assert.match(parseArgs([]).error, /missing <fixture-dir>/);
  assert.match(parseArgs(['fx', '--out']).error, /--out needs a value/);
  assert.match(parseArgs(['fx', '--bogus']).error, /unknown option/);
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(await main([]), 2);
  } finally {
    console.error = err;
  }
});

test('the CLI builds offline and prints the file, tables and rows', (t) => {
  const dir = tmpDir(t);
  const r = spawnSync(process.execPath, [BUILD, MINI, '--out', path.join(dir, 'cli.duckdb')], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^fixture:build: cli\.duckdb: 3 tables, 8 rows, \d+\.\ds\n$/);
});

test('the CLI exits 1 with the reason when the build fails', (t) => {
  const fixture = copyMini(t);
  fs.rmSync(path.join(fixture, 'seeds', 'regions.csv'));
  const r = spawnSync(process.execPath, [BUILD, fixture, '--out', path.join(tmpDir(t), 'x.duckdb')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /table regions has no seeds\/regions\.csv/);
});

test('the runtime never loads the fixture builder', () => {
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard', 'kit/runtime'], { cwd: REPO, encoding: 'utf8' })
    .stdout.split('\n').filter((f) => f.endsWith('.js'));
  const offenders = files.filter((f) => /require\([^)]*fixture\/build|require\([^)]*kit\/fixture|require\(['"]\.\.\/fixture/.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
  assert.deepEqual(offenders, []);
});
