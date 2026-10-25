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
  createData, openLocked, dataPathFor, DataUnavailableError, QueryRefusedError, PARAM_RULES, LOCKDOWN, extensionLoads, installedExtensions,
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

test('no file outside kit/runtime/data, kit/fixture/build.js, kit/fixture/motherduck.js, kit/fixture/md-probe.js and scripts/install-duckdb-extensions.js imports @duckdb/node-api', () => {
  // motherduck.js (Story 7.7) opens the human-run MotherDuck connection for
  // fixture:publish and status --remote. It can't go through kit/runtime/data,
  // whose lockdown forbids the network by design, and the app never loads it.
  // md-probe.js (plan motherduck-read, Story A) is the human-run lockdown
  // probe: it opens MotherDuck as a reader; the app never loads it either.
  // install-duckdb-extensions.js (Story 11.2, DEP-016): image build only; the
  // app never loads it (the next test checks nothing under kit/runtime/ does).
  const allowed = new Set(['kit/runtime/data/index.js', 'kit/fixture/build.js', 'kit/fixture/motherduck.js', 'kit/fixture/md-probe.js', 'scripts/install-duckdb-extensions.js']);
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

test('nothing under kit/runtime/ requires the image-build extension installer', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'kit/runtime'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter((f) => /\.(c|m)?js$/.test(f) && fs.existsSync(path.join(REPO, f)));
  assert.ok(files.length > 20, 'the scan saw kit/runtime');
  const requires = /(?:require|import)\s*\(?\s*['"`][^'"`]*install-duckdb-extensions|from\s+['"`][^'"`]*install-duckdb-extensions/;
  assert.ok(requires.test("require('../../scripts/install-duckdb-extensions')"), 'the pattern catches a require');
  const offenders = files.filter((f) => requires.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

// --- extensionLoads (Story 11.2) ----------------------------------------------

test('extensionLoads: a built-in extension loads; a missing one does not, with its path reduced to a file name', async () => {
  assert.deepEqual(await extensionLoads('json'), { loaded: true });
  const missing = await extensionLoads('aplabs_no_such_extension');
  assert.equal(missing.loaded, false);
  assert.match(missing.reason, /aplabs_no_such_extension/);
  assert.doesNotMatch(missing.reason, /[\\/]/, 'no path in the reason');
});

test('extensionLoads: runs LOAD and nothing else, on an in-memory instance with auto-install and auto-load off', async () => {
  const calls = [];
  const create = async (where, options) => {
    calls.push({ where, options });
    return {
      connect: async () => ({ run: async (sql) => { calls.push(sql); }, closeSync: () => calls.push('conn closed') }),
      closeSync: () => calls.push('instance closed'),
    };
  };
  assert.deepEqual(await extensionLoads('motherduck', { create }), { loaded: true });
  assert.deepEqual(calls, [
    { where: ':memory:', options: { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' } },
    'LOAD motherduck',
    'conn closed',
    'instance closed',
  ]);
});

test('extensionLoads: a failed LOAD resolves loaded: false and still closes the instance', async () => {
  const calls = [];
  const create = async () => ({
    connect: async () => ({
      run: async () => { throw new Error('IO Error: Extension "/home/x/.duckdb/extensions/v1/linux_amd64/motherduck.duckdb_extension" not found.\nmore'); },
      closeSync: () => calls.push('conn closed'),
    }),
    closeSync: () => calls.push('instance closed'),
  });
  const r = await extensionLoads('motherduck', { create });
  assert.deepEqual(r, { loaded: false, reason: 'IO Error: Extension "motherduck.duckdb_extension" not found.' });
  assert.deepEqual(calls, ['conn closed', 'instance closed']);
});

test('extensionLoads: a malformed name is refused before DuckDB, never spliced into SQL', async () => {
  const create = async () => assert.fail('DuckDB must not start');
  for (const bad of ['', 'MotherDuck', 'json; INSTALL x', "a'b", '1abc', 'md:x', null, 7]) {
    await assert.rejects(extensionLoads(bad, { create }), TypeError, String(bad));
  }
});

// --- installedExtensions (Story 11.2) -----------------------------------------

test('installedExtensions: version, platform and where DuckDB finds each named extension', async () => {
  const r = await installedExtensions(['json', 'aplabs_no_such_extension']);
  assert.match(r.version, /^v\d+\.\d+\.\d+/);
  assert.match(r.platform, /^[a-z0-9_]+$/);
  assert.equal(r.extensions[0].name, 'json');
  assert.equal(r.extensions[0].installed, true);
  assert.deepEqual(r.extensions[1], { name: 'aplabs_no_such_extension', installed: false, installPath: '' });
});

test('installedExtensions: reads only, on an in-memory instance with auto-install and auto-load off; names never reach SQL', async () => {
  const calls = [];
  const rows = {
    'SELECT library_version AS v FROM pragma_version()': [{ v: 'v1.5.6' }],
    'SELECT platform AS p FROM pragma_platform()': [{ p: 'linux_amd64' }],
    'SELECT extension_name AS name, installed, install_path AS path FROM duckdb_extensions()': [
      { name: 'motherduck', installed: true, path: '/h/.duckdb/extensions/v1.5.6/linux_amd64/motherduck.duckdb_extension' },
    ],
  };
  const create = async (where, options) => {
    calls.push({ where, options });
    return {
      connect: async () => ({
        runAndReadAll: async (sql) => { calls.push(sql); return { getRowObjectsJson: () => rows[sql] }; },
        closeSync: () => calls.push('conn closed'),
      }),
      closeSync: () => calls.push('instance closed'),
    };
  };
  const r = await installedExtensions(['motherduck', 'motherduck_impl'], { create });
  assert.deepEqual(r, {
    version: 'v1.5.6',
    platform: 'linux_amd64',
    extensions: [
      { name: 'motherduck', installed: true, installPath: '/h/.duckdb/extensions/v1.5.6/linux_amd64/motherduck.duckdb_extension' },
      { name: 'motherduck_impl', installed: false, installPath: '' },
    ],
  });
  assert.deepEqual(calls, [
    { where: ':memory:', options: { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' } },
    ...Object.keys(rows),
    'conn closed',
    'instance closed',
  ]);
  const never = async () => assert.fail('DuckDB must not start');
  for (const bad of [[], ['MotherDuck'], ["a'b"], 'motherduck', null, [7]]) {
    await assert.rejects(installedExtensions(bad, { create: never }), TypeError, String(bad));
  }
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

test('DuckDB agrees with the guardrail\'s lexing refusals: E-strings and dollar quoting are real syntax', async (t) => {
  const { one } = await rawLocked(t);
  // Each is refused by the guardrail; each means something different to DuckDB
  // than a naive reader would think, which is why it is refused.
  assert.deepEqual(await one("SELECT E'a\\'b' AS s"), [{ s: "a'b" }], 'E-strings escape with a backslash');
  assert.deepEqual(await one('SELECT $$x$$ AS s'), [{ s: 'x' }], 'dollar quoting is a string');
  for (const sql of ["SELECT E'a\\'b' AS s", 'SELECT $$x$$ AS s']) {
    assert.equal(sqlGuard.checkSql(sql).ok, false, sql);
  }
});

test('the guardrail and DuckDB agree on where a nested block comment ends', async (t) => {
  const { one } = await rawLocked(t);
  // The `/* /* */ ... */` trick: whatever sits between the first */ and the
  // matching one is comment to both, and code after the matching one is code
  // to both.
  const cases = [
    ['SELECT 1 AS n /* /* */ , 2 AS m */', [{ n: 1 }]],
    ['SELECT 1 AS n /* /* */ */ , 2 AS m', [{ n: 1, m: 2 }]],
    ['SELECT 1 AS n /* a /* b */ c */', [{ n: 1 }]],
    ['SELECT 1 AS n /*/ */ , 2 AS m', [{ n: 1, m: 2 }]],
    ['SELECT 1 AS n /* /*/ */ */ , 2 AS m', [{ n: 1, m: 2 }]],
    ['SELECT 1 AS n /* /**/ */ , 2 AS m', [{ n: 1, m: 2 }]],
    ['SELECT 1 AS n /* **/ , 2 AS m', [{ n: 1, m: 2 }]],
  ];
  for (const [sql, rows] of cases) {
    assert.equal(sqlGuard.checkSql(sql).ok, true, `guardrail accepts: ${sql}`);
    assert.deepEqual(await one(sql), rows, sql);
  }
  for (const sql of ['SELECT 1 AS n /* /* */', 'SELECT 1 AS n /* /* /* */ */']) {
    assert.equal(sqlGuard.checkSql(sql).rule, sqlGuard.RULES.UNTERMINATED, sql);
    await assert.rejects(one(sql), /unterminated \/\* comment/, sql);
  }

  // Random comment bodies (seeded, so a failure reproduces): where the
  // guardrail says the comment ends, DuckDB must too. Appending `, 2 AS m`
  // there runs only if DuckDB closed the comment at exactly that point; a body
  // the guardrail calls unterminated must not run at all.
  const pieces = ['/', '*', '/*', '*/', ' ', '\n', 'a', '-', "'"];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const prefix = 'SELECT 1 AS n ';
  let closed = 0;
  for (let k = 0; k < 2000; k += 1) {
    let text = `${prefix}/*`;
    for (let j = 1 + rnd(14); j > 0; j -= 1) text += pieces[rnd(pieces.length)];
    const end = sqlGuard.blockCommentEnd(text, prefix.length);
    if (end === -1) {
      await assert.rejects(one(`${text}\n`), /unterminated|syntax error/, `guardrail: unterminated, DuckDB ran: ${JSON.stringify(text)}`);
      continue;
    }
    closed += 1;
    const sql = `${text.slice(0, end)} , 2 AS m`;
    assert.deepEqual(await one(sql), [{ n: 1, m: 2 }], `comment end disagrees: ${JSON.stringify(sql)}`);
  }
  assert.ok(closed > 500, `enough closed comments exercised (${closed})`);
});

// --- AC4: missing or unreadable data -----------------------------------------

test('a missing file is unavailable, and a file that appears later is opened on the next run', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'later.duckdb');
  const data = createData({ file, profile: PROFILE });
  t.after(() => data.close());
  await assert.rejects(data.open(), (err) => err instanceof DataUnavailableError && /does not exist/.test(err.reason));
  await assert.rejects(data.run('SELECT 1 AS n'), (err) => err.code === 'DATA_UNAVAILABLE');
  assert.deepEqual(data.describe(), { source: 'local fixture', label: 'later.duckdb', available: false, problem: 'the data file does not exist' });
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

test('describe().problem never shows the data file\'s full path, even when DuckDB\'s error does', async (t) => {
  const dir = path.join(tmpDir(t), 'a dir with spaces');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'garbage.duckdb');
  fs.writeFileSync(file, 'this is not a database\n'.repeat(500));
  const data = createData({ file, profile: PROFILE });
  await assert.rejects(data.run('SELECT 1 AS n'), (err) => {
    assert.ok(!err.reason.includes(dir) && !err.message.includes(dir), err.reason);
    return true;
  });
  const { problem } = data.describe();
  assert.match(problem, /could not be opened/);
  assert.match(problem, /garbage\.duckdb/, 'the file name is kept');
  assert.ok(!problem.includes(dir), `no directory in: ${problem}`);
  assert.ok(!problem.includes(os.tmpdir()) && !problem.includes(fs.realpathSync(os.tmpdir())), `no temp dir in: ${problem}`);
});

test('data unavailable is a typed refusal (AD-17), worded only by kit/runtime/messages', () => {
  const errors = require('../../kit/runtime/errors');
  const { messageFor } = require('../../kit/runtime/messages');
  const sdk = require('../../kit/runtime/sdk');
  assert.equal(DataUnavailableError, errors.DataUnavailable, 'kit/runtime/data re-exports the one class');
  assert.equal(sdk.DataUnavailableError, errors.DataUnavailable, 'the SDK export still works');
  const err = new errors.DataUnavailable('the data file does not exist');
  assert.ok(err instanceof errors.RuntimeRefusal);
  assert.equal(err.code, 'DATA_UNAVAILABLE');
  assert.equal(err.reason, 'the data file does not exist');
  assert.match(messageFor(err), /^The data isn't available right now, so I can't answer that\. The app is still running; please tell your admin\.$/);
  assert.ok(!messageFor(err).includes(err.reason), 'the reason is logged, never shown');
  assert.equal(require('../../kit/runtime/data').DATA_UNAVAILABLE, undefined, 'no reply text in kit/runtime/data');
});

test('the data path: APLABS_DATA_PATH (absolute), else the built fixture under the var dir', () => {
  const profile = { client: { id: 'acme' } };
  assert.deepEqual(dataPathFor(profile, { APLABS_DATA_PATH: '/d/x.duckdb' }), { path: '/d/x.duckdb' });
  assert.deepEqual(dataPathFor(profile, { APLABS_DATA_PATH: 'x.duckdb' }), { problem: 'APLABS_DATA_PATH must be an absolute path' });
  assert.deepEqual(dataPathFor(profile, { APLABS_VAR_DIR: '/v' }), { path: '/v/fixture/acme.duckdb' });
  assert.deepEqual(dataPathFor(profile, {}), { path: path.join(REPO, 'var', 'fixture', 'acme.duckdb') });
});
