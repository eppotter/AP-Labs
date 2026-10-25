'use strict';

// Plan motherduck-read, Story B: kit/runtime/data reading MotherDuck. Every
// test uses the fake instance factory (test/fixtures/fake-motherduck.js): no
// test opens a real connection, reads the Keychain or holds a real key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createData, DataUnavailableError, QueryRefusedError, LOCKDOWN } = require('../../kit/runtime/data');
const md = require('../../kit/runtime/data/motherduck');
const remote = require('../../kit/fixture/remote');
const { createFakeMotherDuck } = require('../fixtures/fake-motherduck');

const REPO = path.join(__dirname, '..', '..');
const DB = 'brightside_fixture';
// A fake value shaped like nothing real; it only has to be findable in output.
const TOKEN = 'fake-read-key-0000-not-a-credential';
const PROFILE = Object.freeze({
  client: { id: 'tiny' },
  data: { source: 'motherduck', database: DB },
  sql: { forbidden_columns: [] },
});

// A clock the tests move by hand, for the 30s reconnect wait.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function source(t, fake, opts = {}) {
  const data = createData({ profile: PROFILE, token: TOKEN, connect: fake.create, ...opts });
  t.after(() => data.close());
  return data;
}

const SETUP = [
  'LOAD motherduck',
  `SET motherduck_token = '${TOKEN}'`,
  `ATTACH 'md:${DB}' AS "${DB}" (READ_ONLY)`,
  'SET enable_external_access = false',
  'SET lock_configuration = true',
  `USE "${DB}"`,
];

const unavailable = (pattern) => (err) => {
  assert.ok(err instanceof DataUnavailableError, `a DataUnavailableError, got ${err && err.stack}`);
  if (pattern) assert.match(err.reason, pattern);
  assert.ok(!err.message.includes(TOKEN) && !err.reason.includes(TOKEN), 'the key never shows');
  return true;
};

// --- The lockdown ------------------------------------------------------------

test('MD_LOCKDOWN is one frozen constant: an in-memory instance with extension auto-install and auto-load off', () => {
  assert.ok(Object.isFrozen(md.MD_LOCKDOWN) && Object.isFrozen(md.MD_LOCKDOWN.instance));
  assert.ok(Object.isFrozen(md.MD_LOCKDOWN.setup) && Object.isFrozen(md.MD_LOCKDOWN.perConnection));
  assert.equal(md.MD_LOCKDOWN.path, ':memory:');
  assert.deepEqual({ ...md.MD_LOCKDOWN.instance }, { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' });
  assert.deepEqual(md.setupStatements(DB, TOKEN), SETUP.slice(0, 5));
  assert.deepEqual(md.perConnectionStatements(DB), [`USE "${DB}"`]);
  // The local file's lockdown is untouched.
  assert.deepEqual({ ...LOCKDOWN }, {
    access_mode: 'READ_ONLY', enable_external_access: 'false', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false',
  });
});

test('opening runs LOAD, the key, ATTACH READ_ONLY, external access off and the lock, in that order, then USE and one check', async (t) => {
  const fake = createFakeMotherDuck();
  const data = source(t, fake);
  await data.open();
  assert.deepEqual(fake.state.created, [{ where: ':memory:', options: { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' } }]);
  const [setup] = fake.state.instances[0].connections;
  assert.deepEqual(setup.statements.slice(0, 6), SETUP);
  assert.equal(setup.statements.length, 7);
  assert.match(setup.statements[6], /current_database\(\)/);
  assert.ok(setup.closed, 'the setup connection is closed');
  assert.ok(!setup.statements.some((s) => /^(INSTALL|CREATE)\b/i.test(s)), 'nothing is installed or created');
  assert.deepEqual(data.describe(), { source: 'MotherDuck', label: DB, available: true, problem: null });
});

test('every run connection runs USE <db> before its query, and the guardrail still runs first', async (t) => {
  const fake = createFakeMotherDuck({ rows: () => [{ n: '3' }] });
  const data = source(t, fake);
  assert.deepEqual(await data.run('SELECT count(*) AS n FROM zones'), [{ n: '3' }]);
  assert.deepEqual(await data.run('SELECT 1 AS n'), [{ n: '3' }]);
  const conns = fake.state.instances[0].connections.slice(1);
  assert.equal(conns.length, 2);
  assert.deepEqual(conns[0].statements, [`USE "${DB}"`, 'SELECT count(*) AS n FROM zones']);
  assert.deepEqual(conns[1].statements, [`USE "${DB}"`, 'SELECT 1 AS n']);
  assert.ok(conns.every((c) => c.closed));

  const before = fake.state.instances[0].connections.length;
  for (const sql of ['DROP TABLE zones', "ATTACH 'md:my_db' AS x", 'USE my_db', 'SET enable_external_access = true']) {
    await assert.rejects(data.run(sql), (err) => err instanceof QueryRefusedError, sql);
  }
  assert.equal(fake.state.instances[0].connections.length, before, 'a refused query never reaches DuckDB');
});

test('the connection must land on data.database and find fixture_meta; otherwise the data is unavailable', async (t) => {
  const noMeta = createFakeMotherDuck({ hasMeta: false });
  await assert.rejects(source(t, noMeta).open(), unavailable(/has no fixture_meta table/));
  assert.ok(noMeta.state.instances[0].closed, 'the instance is closed');

  // USE succeeded, yet current_database() reports another database.
  const wrongDb = createFakeMotherDuck({ landOn: 'memory' });
  await assert.rejects(source(t, wrongDb).open(), unavailable(/^the connection is on memory, not brightside_fixture$/));
  assert.ok(wrongDb.state.instances[0].closed);
});

test('a missing database is unavailable and is never created', async (t) => {
  const fake = createFakeMotherDuck({ database: 'some_other_db' });
  const data = source(t, fake);
  await assert.rejects(data.open(), unavailable(/could not be opened \(Catalog Error: database "brightside_fixture" not found\)/));
  const statements = fake.state.instances[0].connections.flatMap((c) => c.statements);
  assert.ok(!statements.some((s) => /\bCREATE\b/i.test(s)), statements.join('\n'));
  assert.ok(fake.state.instances[0].closed);
  assert.equal(data.describe().available, false);
  assert.match(data.describe().problem, /not found/);
});

test('a missing MotherDuck extension is unavailable, with a reason naming the install step; nothing is installed', async (t) => {
  const fake = createFakeMotherDuck({
    failOn: (sql) => (sql === 'LOAD motherduck'
      ? new Error('IO Error: Extension "/Users/someone/.duckdb/extensions/v1.5.6/osx_arm64/motherduck.duckdb_extension" not found.')
      : null),
  });
  const data = source(t, fake);
  await assert.rejects(data.open(), unavailable(/^the MotherDuck extension is not installed \(install it ahead of time with INSTALL motherduck/));
  assert.equal(data.describe().problem, md.MISSING_EXTENSION);
  assert.ok(!data.describe().problem.includes('/Users/'), 'no path');
  assert.deepEqual(fake.state.instances[0].connections[0].statements, ['LOAD motherduck']);
});

test('an error from setting the key never shows the key', async (t) => {
  const fake = createFakeMotherDuck({
    failOn: (sql) => (sql.startsWith('SET motherduck_token') ? new Error(`Invalid Input Error: bad token near ${sql}`) : null),
  });
  const data = source(t, fake);
  await assert.rejects(data.open(), unavailable(/bad token near SET motherduck_token = '\[redacted\]'/));
  assert.ok(!JSON.stringify(data.describe()).includes(TOKEN));
});

// --- Time limits ---------------------------------------------------------------

test('a slow connect times out; one attempt at a time; the late instance is closed at once', async (t) => {
  const c = clock();
  const fake = createFakeMotherDuck({ createDelayMs: 80 });
  const data = source(t, fake, { connectTimeoutMs: 20, now: c.now });
  await assert.rejects(data.open(), unavailable(/^connecting to MotherDuck timed out after 20ms$/));
  // The first attempt is still running: no second one starts, even past the wait.
  c.advance(md.RETRY_AFTER_MS + 1);
  await assert.rejects(data.run('SELECT 1 AS n'), unavailable(/a MotherDuck connect attempt is still running/));
  assert.equal(fake.state.created.length, 1);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fake.state.instances.length, 1);
  assert.ok(fake.state.instances[0].closed, 'the late instance is closed, never adopted');
  assert.equal(data.describe().available, false);
  assert.match(data.describe().problem, /timed out/);
});

test('a slow query is interrupted at its limit and is unavailable; the instance is dropped and the reconnect waits 30s', async (t) => {
  const c = clock();
  const fake = createFakeMotherDuck({ hangQueries: true });
  const data = source(t, fake, { queryTimeoutMs: 20, now: c.now });
  await data.open();
  await assert.rejects(data.run('SELECT 1 AS n'), unavailable(/^query timed out after 20ms$/));
  const conn = fake.state.instances[0].connections[1];
  assert.equal(conn.interrupted, 1, 'the timer called conn.interrupt()');
  assert.equal(data.describe().available, false);
  await new Promise((r) => setImmediate(r));
  assert.ok(fake.state.instances[0].closed, 'the dropped instance is closed');
  assert.ok(conn.closed);

  fake.state.hangQueries = false;
  await assert.rejects(data.run('SELECT 1 AS n'), unavailable(/^waiting to reconnect to MotherDuck \(query timed out/));
  assert.equal(fake.state.created.length, 1, 'no reconnect inside the wait');
  c.advance(md.RETRY_AFTER_MS);
  assert.deepEqual(await data.run('SELECT 1 AS n'), []);
  assert.equal(fake.state.created.length, 2);
});

test('a key revoked mid-run: the next query is unavailable with a redacted reason, the instance dropped, and it reconnects after the wait', async (t) => {
  const c = clock();
  const fake = createFakeMotherDuck({ rows: () => [{ ok: true }] });
  const data = source(t, fake, { now: c.now });
  assert.deepEqual(await data.run('SELECT 1 AS ok'), [{ ok: true }]);
  fake.revoke(`Invalid Input Error: Your token ${TOKEN} has been revoked\nmore detail on another line`);
  await assert.rejects(data.run('SELECT 1 AS ok'), unavailable(/^the MotherDuck query failed \(Invalid Input Error: Your token \[redacted\] has been revoked\)$/));
  assert.equal(data.describe().available, false);
  assert.ok(fake.state.instances[0].closed);
  await assert.rejects(data.run('SELECT 1 AS ok'), unavailable(/waiting to reconnect/));
  fake.restore();
  c.advance(md.RETRY_AFTER_MS);
  assert.deepEqual(await data.run('SELECT 1 AS ok'), [{ ok: true }]);
  assert.equal(fake.state.created.length, 2);
});

test('a catalog or binder error is unavailable too, but keeps the instance', async (t) => {
  const fake = createFakeMotherDuck({
    rows: (sql) => {
      if (/nope/.test(sql)) throw new Error('Catalog Error: Table with name nope does not exist!');
      if (/missing_col/.test(sql)) throw new Error('Binder Error: Referenced column "missing_col" not found');
      return [{ n: 1 }];
    },
  });
  const data = source(t, fake);
  await assert.rejects(data.run('SELECT 1 AS n FROM nope'), unavailable(/Catalog Error/));
  await assert.rejects(data.run('SELECT missing_col FROM zones'), unavailable(/Binder Error/));
  assert.equal(data.describe().available, true);
  assert.deepEqual(await data.run('SELECT 1 AS n'), [{ n: 1 }]);
  assert.equal(fake.state.created.length, 1);
  assert.ok(!fake.state.instances[0].closed);
});

test('close() while connecting: the instance that arrives later is closed, never adopted', async (t) => {
  const fake = createFakeMotherDuck({ createDelayMs: 30 });
  const data = createData({ profile: PROFILE, token: TOKEN, connect: fake.create });
  const opening = data.open().catch((e) => e);
  data.close();
  await opening;
  assert.ok(fake.state.instances[0].closed);
  assert.equal(data.describe().available, false);
});

test('MotherDuck mode needs the read key and a valid name; the local mode never takes one', () => {
  const fake = createFakeMotherDuck();
  assert.throws(() => createData({ profile: PROFILE, connect: fake.create }), /needs the read key \(MOTHERDUCK_READ_TOKEN\)/);
  assert.throws(() => createData({ profile: { ...PROFILE, data: { source: 'motherduck', database: 'my_db' } }, token: TOKEN, connect: fake.create }), /MotherDuck's own/);
  const local = createData({ file: '/nowhere/x.duckdb', profile: { client: { id: 'x' } }, connect: () => assert.fail('local mode never connects to MotherDuck') });
  assert.deepEqual(local.describe(), { source: 'local fixture', label: 'x.duckdb', available: false, problem: null });
});

// --- Names, errors and the boundary ---------------------------------------------

test('the database name check lives in the runtime; kit/fixture/remote uses the same one', () => {
  assert.equal(remote.databaseNameProblem, md.databaseNameProblem);
  assert.equal(remote.STAGING_SUFFIX, md.STAGING_SUFFIX);
  assert.equal(remote.TOKEN_ENV, md.PUBLISH_TOKEN_ENV);
  assert.equal(md.databaseNameProblem('brightside_fixture'), null);
  for (const bad of ['my_db', 'sample_data', 'x__publishing', 'Bad', '9x', '', 'a"b', undefined]) {
    assert.ok(md.databaseNameProblem(bad), `${bad} is refused`);
  }
});

test('error classification: catalog and binder keep the instance; a missing extension is named; reasons drop paths and keys', () => {
  assert.equal(md.classifyError(new Error('Catalog Error: x')), 'catalog');
  assert.equal(md.classifyError(new Error('Binder Error: x')), 'binder');
  assert.equal(md.classifyError(new Error('IO Error: Extension "/a/b/motherduck.duckdb_extension" not found.')), 'missing_extension');
  assert.equal(md.classifyError(new Error('IO Error: network unreachable')), 'other');
  assert.equal(md.classifyError(new Error('Parser Error: syntax error')), 'other');
  assert.ok(md.keepsInstance('catalog') && md.keepsInstance('binder') && !md.keepsInstance('other'));
  assert.equal(md.reasonFor(new Error(`IO Error: /Users/me/secret/dir/file.db with ${TOKEN}\nsecond`), [TOKEN]), 'IO Error: file.db with [redacted]');
});

test('no runtime file loads kit/fixture code', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'kit/runtime'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter((f) => /\.(c|m)?js$/.test(f) && fs.existsSync(path.join(REPO, f)));
  assert.ok(files.length > 10, 'the scan saw kit/runtime');
  const offenders = files.filter((f) => /require\s*\(\s*['"`][^'"`]*\bfixture\//.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('kit/runtime/data/motherduck.js holds only constants and pure helpers: no DuckDB, no I/O', () => {
  const text = fs.readFileSync(path.join(REPO, 'kit/runtime/data/motherduck.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['../../lib/secrets']);
});
