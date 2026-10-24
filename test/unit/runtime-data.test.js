'use strict';

// Story 7.5: kit/runtime/data, the one read-only query runner (AD-9, AD-10).
// Integration tests against real DuckDB: each builds the minimal fixture in
// test/fixtures/fixture-build/ into its own temporary directory, never a
// client's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build } = require('../../kit/fixture/build');
const sqlGuard = require('../../kit/runtime/sql');
const {
  createData, openLocked, dataPathFor, DataUnavailableError, QueryRefusedError, PARAM_RULES, LOCKDOWN,
} = require('../../kit/runtime/data');

const REPO = path.join(__dirname, '..', '..');
const MINI = path.join(__dirname, '..', 'fixtures', 'fixture-build', 'mini');
// A forbidden column on the mini fixture, as a profile would declare it.
const PROFILE = { client: { id: 'mini' }, sql: { forbidden_columns: ['shops.postal_code'] } };

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-data-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function builtMini(t) {
  const file = path.join(tmpDir(t), 'mini.duckdb');
  await build({ fixtureDir: MINI, out: file });
  return file;
}

async function source(t, profile = PROFILE) {
  const data = createData({ file: await builtMini(t), profile });
  t.after(() => data.close());
  return data;
}

// A raw connection on a locked instance: the guardrail is NOT in front of it,
// so these tests show what the lockdown alone stops.
async function rawLocked(t) {
  const instance = await openLocked(await builtMini(t));
  const conn = await instance.connect();
  t.after(() => { conn.closeSync(); instance.closeSync(); });
  const one = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson();
  return { one };
}

// --- AC1: the lockdown -------------------------------------------------------

test('opens read-only with external access and extension auto-install/load off, then locks the configuration', async (t) => {
  assert.deepEqual(Object.keys(LOCKDOWN), ['access_mode', 'enable_external_access', 'autoinstall_known_extensions', 'autoload_known_extensions']);
  const { one } = await rawLocked(t);
  const [s] = await one(`SELECT current_setting('access_mode') AS access_mode,
    current_setting('enable_external_access') AS external,
    current_setting('autoinstall_known_extensions') AS autoinstall,
    current_setting('autoload_known_extensions') AS autoload,
    current_setting('lock_configuration') AS locked`);
  assert.deepEqual(s, { access_mode: 'read_only', external: false, autoinstall: false, autoload: false, locked: true });
});

test('a later SET fails once the configuration is locked', async (t) => {
  const { one } = await rawLocked(t);
  for (const sql of ['SET enable_external_access = true', 'SET lock_configuration = false', 'SET threads = 1']) {
    await assert.rejects(one(sql), /configuration has been locked/, sql);
  }
});

test('the lockdown alone blocks files, attaching, extensions and writes, with no guardrail in front', async (t) => {
  const { one } = await rawLocked(t);
  const hosts = path.join(tmpDir(t), 'secret.csv');
  fs.writeFileSync(hosts, 'a\n1\n');
  await assert.rejects(one(`SELECT * FROM read_csv('${hosts}')`), /file system operations are disabled/);
  await assert.rejects(one(`SELECT * FROM '${hosts}'`), /does not exist|disabled/);
  await assert.rejects(one("SELECT * FROM read_text('https://example.com/x')"), /disabled|not.*exist|not.*supported|extension/i);
  await assert.rejects(one(`ATTACH '${path.join(path.dirname(hosts), 'other.duckdb')}' AS other`), /file system operations are disabled/);
  await assert.rejects(one('INSTALL httpfs'), /disabled/);
  await assert.rejects(one('CREATE TABLE x (a INTEGER)'), /read-only/);
  await assert.rejects(one("UPDATE regions SET name = 'x'"), /read-only/);
});

// --- AC2: run(sql, params) ---------------------------------------------------

test('every run() calls the guardrail first, with the profile\'s forbidden columns', async (t) => {
  const data = await source(t);
  const spy = t.mock.method(sqlGuard, 'checkSql');
  await data.run('SELECT name FROM regions ORDER BY region_id');
  await assert.rejects(data.run('SELECT postal_code FROM shops'), (err) => err instanceof QueryRefusedError && err.rule === sqlGuard.RULES.FORBIDDEN_COLUMN);
  await assert.rejects(data.run("SELECT * FROM read_csv('x.csv')"), (err) => err instanceof QueryRefusedError);
  assert.equal(spy.mock.callCount(), 3);
  for (const call of spy.mock.calls) assert.deepEqual(call.arguments[1], { forbiddenColumns: ['shops.postal_code'] });
});

test('a refused query never reaches DuckDB, even when the data is unavailable', async (t) => {
  const data = createData({ file: path.join(tmpDir(t), 'missing.duckdb'), profile: PROFILE });
  await assert.rejects(data.run('DROP TABLE regions'), (err) => err instanceof QueryRefusedError && err.rule === sqlGuard.RULES.WRITE_OR_DDL);
});

test('binds declared named parameters as prepared-statement values', async (t) => {
  const data = await source(t);
  const rows = await data.run(
    'SELECT shop_id, revenue_cents FROM shops WHERE region_id = $region AND shop_id >= $min ORDER BY shop_id',
    { region: 'vale', min: 2 },
    { declared: ['region', 'min'] },
  );
  assert.deepEqual(rows, [{ shop_id: 2, revenue_cents: '125000' }, { shop_id: 3, revenue_cents: '0' }]);
});

test('a value is data, never SQL: a quote-and-comment string matches nothing', async (t) => {
  const data = await source(t);
  const rows = await data.run('SELECT shop_id FROM shops WHERE region_id = $region', { region: "vale' OR 1=1 --" }, { declared: ['region'] });
  assert.deepEqual(rows, []);
});

test('a parameter the caller did not declare is refused', async (t) => {
  const data = await source(t);
  const sql = 'SELECT shop_id FROM shops WHERE region_id = $region';
  const undeclared = (err) => err instanceof QueryRefusedError && err.rule === PARAM_RULES.UNDECLARED;
  await assert.rejects(data.run(sql, { region: 'vale' }), undeclared, 'declared nothing');
  await assert.rejects(data.run(sql, { region: 'vale', extra: 1 }, { declared: ['region'] }), undeclared, 'extra key');
  await assert.rejects(data.run(sql, { region: 'vale', extra: 1 }, { declared: ['region', 'extra'] }), undeclared, 'declared but not in the query');
});

test('a placeholder with no value, a positional placeholder and a non-scalar value are refused', async (t) => {
  const data = await source(t);
  await assert.rejects(
    data.run('SELECT shop_id FROM shops WHERE region_id = $region', {}, { declared: ['region'] }),
    (err) => err.rule === PARAM_RULES.MISSING,
  );
  for (const sql of ['SELECT shop_id FROM shops WHERE shop_id = $1', 'SELECT shop_id FROM shops WHERE shop_id = ?']) {
    await assert.rejects(data.run(sql, {}), (err) => err.rule === PARAM_RULES.POSITIONAL, sql);
  }
  for (const bad of [{ toString: () => "'x'" }, ['vale'], Number.NaN, undefined]) {
    await assert.rejects(
      data.run('SELECT shop_id FROM shops WHERE region_id = $region', { region: bad }, { declared: ['region'] }),
      (err) => err.rule === PARAM_RULES.BAD_VALUE,
    );
  }
  await assert.rejects(data.run('SELECT 1 AS n', 'not an object'), (err) => err.rule === PARAM_RULES.BAD_VALUE);
});

test('no file outside kit/runtime/data and kit/fixture/build.js imports @duckdb/node-api', () => {
  const allowed = new Set(['kit/runtime/data/index.js', 'kit/fixture/build.js']);
  const pkg = ['@duckdb', 'node-api'].join('/');
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.js', '*.cjs', '*.mjs'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.ok(files.length > 50, 'the scan saw the repo');
  const importer = new RegExp(`(require|import)\\s*\\(?\\s*['"\`]${pkg.replace('/', '\\/')}|from\\s+['"\`]${pkg.replace('/', '\\/')}`);
  const offenders = files.filter((f) => !allowed.has(f) && fs.existsSync(path.join(REPO, f))
    && importer.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
  assert.deepEqual(offenders, []);
  for (const f of allowed) assert.ok(importer.test(fs.readFileSync(path.join(REPO, f), 'utf8')), `${f} still matches the pattern`);
});

// --- Guardrail parity with real DuckDB (open risk from Story 7.4) -------------

test('queries the guardrail accepts actually run on DuckDB', async (t) => {
  const data = await source(t);
  const accepted = [
    "SELECT COALESCE(closed_on::VARCHAR, '--') AS c FROM shops ORDER BY shop_id",
    'SELECT revenue_cents // 100 AS whole FROM shops',
    "SELECT 'it''s' AS a, 'back\\slash' AS b",
    'SELECT /* note */ shop_id FROM shops -- trailing\nWHERE shop_id = 1',
    'WITH v AS (SELECT region_id FROM regions) SELECT count(*) AS n FROM v',
    'SELECT s.shop_id, r.name FROM shops AS s JOIN regions r ON r.region_id = s.region_id',
    'SELECT "shop_id" FROM "shops" WHERE closed_on IS NOT DISTINCT FROM NULL',
    'SELECT EXTRACT(year FROM opened_on) AS y, TRIM(BOTH \'x\' FROM \'xax\') AS t FROM shops',
    'SELECT region_id, count(*) AS n FROM shops GROUP BY region_id HAVING count(*) > 0 ORDER BY 1',
    'SELECT shop_id FROM shops UNION ALL SELECT 99 ORDER BY 1 LIMIT 2',
    'SELECT (SELECT max(shop_id) FROM shops) AS top, 2 * 3 AS six;',
    'SELECT x.n FROM (SELECT shop_id AS n FROM shops) AS x WHERE x.n IN (1, 2)',
    'SELECT 1-- c\n AS n',
    'SELECT 1 AS n /*/ */',
    'SELECT "a""b" FROM (SELECT 1 AS "a""b")',
    'SELECT 1_000 AS a, .5 AS b, 1e3 AS c',
    'SELECT list_transform([1, 2], x -> x + 1) AS l, {\'a\': 1} AS st',
  ];
  for (const sql of accepted) {
    assert.equal(sqlGuard.checkSql(sql, { forbiddenColumns: PROFILE.sql.forbidden_columns }).ok, true, `guardrail accepts: ${sql}`);
    await data.run(sql); // throws if DuckDB disagrees about what the text means
  }
  const [row] = await data.run("SELECT 'it''s' AS a, 'back\\slash' AS b");
  assert.deepEqual(row, { a: "it's", b: 'back\\slash' }, 'a backslash is an ordinary character in DuckDB');
  const [c] = await data.run("SELECT COALESCE(NULL, '--') AS c, 7 // 2 AS d");
  assert.deepEqual(c, { c: '--', d: 3 }, "'--' in a string and // are not comments");
});

test('DuckDB agrees with the guardrail\'s lexing refusals: nested comments, E-strings and dollar quoting are real syntax', async (t) => {
  const { one } = await rawLocked(t);
  // Each is refused by the guardrail; each means something different to DuckDB
  // than a naive reader would think, which is why it is refused.
  assert.deepEqual(await one('SELECT 1 /* a /* b */ c */ AS n'), [{ n: 1 }], 'block comments nest');
  assert.deepEqual(await one("SELECT E'a\\'b' AS s"), [{ s: "a'b" }], 'E-strings escape with a backslash');
  assert.deepEqual(await one('SELECT $$x$$ AS s'), [{ s: 'x' }], 'dollar quoting is a string');
  for (const sql of ['SELECT 1 /* a /* b */ c */ AS n', "SELECT E'a\\'b' AS s", 'SELECT $$x$$ AS s']) {
    assert.equal(sqlGuard.checkSql(sql).ok, false, sql);
  }
});

// --- AC4: missing or unreadable data -----------------------------------------

test('a missing file is unavailable, and a file that appears later is opened on the next run', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'later.duckdb');
  const data = createData({ file, profile: PROFILE });
  t.after(() => data.close());
  await assert.rejects(data.open(), (err) => err instanceof DataUnavailableError && /does not exist/.test(err.reason));
  await assert.rejects(data.run('SELECT 1 AS n'), (err) => err.code === 'DATA_UNAVAILABLE');
  assert.deepEqual(data.describe(), { source: 'local fixture', file: 'later.duckdb', available: false, problem: 'the data file does not exist' });
  await build({ fixtureDir: MINI, out: file });
  assert.deepEqual(await data.run('SELECT count(*)::INT AS n FROM regions'), [{ n: 2 }]);
  assert.equal(data.describe().available, true);
});

test('a file DuckDB cannot open is unavailable, not a crash', async (t) => {
  const file = path.join(tmpDir(t), 'garbage.duckdb');
  fs.writeFileSync(file, 'this is not a database\n'.repeat(500));
  const data = createData({ file, profile: PROFILE });
  await assert.rejects(data.run('SELECT 1 AS n'), (err) => err instanceof DataUnavailableError && /could not be opened/.test(err.reason));
});

test('the data path: APLABS_DATA_PATH (absolute), else the built fixture under the var dir', () => {
  const profile = { client: { id: 'acme' } };
  assert.deepEqual(dataPathFor(profile, { APLABS_DATA_PATH: '/d/x.duckdb' }), { path: '/d/x.duckdb' });
  assert.deepEqual(dataPathFor(profile, { APLABS_DATA_PATH: 'x.duckdb' }), { problem: 'APLABS_DATA_PATH must be an absolute path' });
  assert.deepEqual(dataPathFor(profile, { APLABS_VAR_DIR: '/v' }), { path: '/v/fixture/acme.duckdb' });
  assert.deepEqual(dataPathFor(profile, {}), { path: path.join(REPO, 'var', 'fixture', 'acme.duckdb') });
});
