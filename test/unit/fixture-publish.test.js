'use strict';

// Story 7.7: kit/fixture/publish publishes the local build to the shared MotherDuck
// database, and kit/fixture/status compares the two. Both are run by
// Ely only: every test here injects a fake connection (an in-memory model of
// MotherDuck over a real in-memory DuckDB, below) and a fake token, and the Keychain reader is always a
// stub, so no test reaches the network or a real secret. Engine tests: the
// fixture is the minimal one in test/fixtures/fixture-build/mini with the
// checks and profile in test/fixtures/fixture-validate, never a client's.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

try {
  require.resolve('@duckdb/node-api');
} catch {
  throw new Error('fixture-publish tests: @duckdb/node-api is not installed. Run npm ci in this worktree, then rerun npm test.');
}

const { build, readRows } = require('../../kit/fixture/build');
const remote = require('../../kit/fixture/remote');
const publish = require('../../kit/fixture/publish');
const status = require('../../kit/fixture/status');
const motherduck = require('../../kit/fixture/motherduck');

const MINI = path.join(__dirname, '..', 'fixtures', 'fixture-build', 'mini');
const CHECKS = path.join(__dirname, '..', 'fixtures', 'fixture-validate', 'checks');
const PROFILE = path.join(__dirname, '..', 'fixtures', 'fixture-validate', 'profile.yml');
// Every child table sorts before its parent: assignments -> crews -> zones.
const FK_ORDER = path.join(__dirname, '..', 'fixtures', 'fixture-publish', 'fk-order');
const TOKEN = 'md-fake-token-7f3a9c'; // not a real token: tests only

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-fixture-publish-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fixture dir <tmp>/acme/fixture (schema, seeds, checks) built into
// <tmp>/acme.duckdb: MINI with the validate checks, or `src` with its own.
async function fixture(t, { meta, src = MINI } = {}) {
  const root = tmpDir(t);
  const dir = path.join(root, 'acme', 'fixture');
  fs.cpSync(src, dir, { recursive: true });
  if (src === MINI) fs.cpSync(CHECKS, path.join(dir, 'checks'), { recursive: true });
  if (meta) fs.writeFileSync(path.join(dir, 'seeds', 'fixture_meta.csv'), meta);
  const db = path.join(root, 'acme.duckdb');
  await build({ fixtureDir: dir, out: db });
  return { root, dir, db };
}

const META_V3 = 'key,value\nas_of,2026-09-30\ngenerator_version,3\nrows_regions,2\nrows_shops,3\n';

// An in-memory MotherDuck in two parts. The model: databases by name, each a
// map of table -> row count plus the fixture_publish rows, which the tests
// read and edit, and which answers the statements kit/fixture/remote issues.
// The engine: a real in-memory DuckDB (kit/fixture/motherduck connectLocal,
// no network), where every database publish creates, and every target a
// test seeds (seed, below), is a real attached database with its foreign
// keys enforced and its fixture_publish table. Every statement the model
// does not answer (the upload's ATTACH, catalog reads, CREATE TABLE, INSERT,
// USE, DETACH, the swap's transaction and DROP TABLE) runs on the engine,
// and the model's row counts and fixture_publish rows are then read back
// from it, so a load order that breaks a foreign key, or a swap that fails
// mid-copy, behaves here as it does on MotherDuck.
//
// `shares` names databases with a share attached: as on MotherDuck
// (2026-10-25), replacing or dropping one is refused.
const engines = [];
test.after(() => { for (const e of engines) e.close(); });

function fakeMotherDuck({ fail = {}, connectError, closeError, shares = [] } = {}) {
  const dbs = new Map();
  const statements = [];
  const tokens = [];
  const closed = [];
  let engine = null;
  async function real() {
    if (!engine) {
      engine = await motherduck.connectLocal();
      engines.push(engine);
    }
    return engine;
  }
  const realDatabases = async () => new Set((await (await real()).run('SELECT database_name FROM duckdb_databases()')).map((r) => r.database_name));
  const foreignKeysOf = async (name) => (await (await real()).run(
    `SELECT table_name, referenced_table FROM duckdb_constraints() WHERE database_name = '${name}' AND constraint_type = 'FOREIGN KEY' ORDER BY ALL`,
  )).map((r) => `${r.table_name} -> ${r.referenced_table}`);

  // Row counts and fixture_publish rows for every model database the engine
  // holds, read from the engine.
  async function sync() {
    const e = await real();
    const present = await realDatabases();
    for (const [name, d] of dbs) {
      if (!present.has(name)) continue;
      d.tables.clear();
      d.publish = null;
      for (const { table_name: t } of await e.run(`SELECT table_name FROM duckdb_tables() WHERE database_name = '${name}' AND schema_name = 'main' ORDER BY table_name`)) {
        d.tables.set(t, Number((await e.run(`SELECT count(*)::VARCHAR AS n FROM "${name}".main."${t}"`))[0].n));
        if (t === 'fixture_publish') d.publish = new Map((await e.run(`SELECT key, value FROM "${name}".main.fixture_publish`)).map((r) => [r.key, r.value]));
      }
    }
  }

  async function drop(name) {
    const had = dbs.delete(name);
    if ((await realDatabases()).has(name)) await (await real()).run(`DETACH DATABASE "${name}"`);
    return had;
  }

  // Copies database `from` into a new attached database `to` on the engine,
  // parents first (DuckDB's own COPY FROM DATABASE ignores foreign keys, as
  // MotherDuck's whole-database copy does), as CREATE DATABASE ... FROM does.
  async function copyDatabase(from, to) {
    const e = await real();
    const tables = await e.run(`SELECT table_name, sql FROM duckdb_tables() WHERE database_name = '${from}' AND schema_name = 'main'`);
    const fks = await e.run(`SELECT table_name, referenced_table FROM duckdb_constraints() WHERE database_name = '${from}' AND constraint_type = 'FOREIGN KEY'`);
    const order = [];
    while (order.length < tables.length) {
      const next = tables.find((t) => !order.includes(t) && fks.every((f) => f.table_name !== t.table_name || f.referenced_table === t.table_name || order.some((o) => o.table_name === f.referenced_table)));
      order.push(next);
    }
    await e.run(`ATTACH ':memory:' AS "${to}"`);
    await e.run(`USE "${to}"`);
    for (const t of order) await e.run(t.sql);
    await e.run('USE "memory"');
    for (const t of order) await e.run(`INSERT INTO "${to}".main."${t.table_name}" SELECT * FROM "${from}".main."${t.table_name}"`);
  }

  // A target this tool published before, as real tables on the engine:
  // `ddl` statements run in order with the target current (so REFERENCES
  // resolve there), then `rows` (table -> VALUES list), then fixture_publish
  // holding `publish` (key -> value).
  async function seed(name, { ddl, rows = {}, publish = { fixture_version: 'old' } }) {
    const e = await real();
    await e.run(`ATTACH ':memory:' AS "${name}"`);
    await e.run(`USE "${name}"`);
    for (const sql of ddl) await e.run(sql);
    for (const [t, values] of Object.entries(rows)) await e.run(`INSERT INTO "${t}" VALUES ${values}`);
    await e.run('CREATE TABLE fixture_publish (key VARCHAR, value VARCHAR)');
    for (const [k, v] of Object.entries(publish)) await e.run(`INSERT INTO fixture_publish VALUES ('${k}', '${v}')`);
    await e.run('USE "memory"');
    dbs.set(name, { tables: new Map(), publish: null });
    await sync();
  }

  async function run(sql) {
    statements.push(sql);
    for (const [re, message] of Object.entries(fail)) {
      if (!new RegExp(re).test(sql)) continue;
      // A failed COMMIT ends the transaction, as on DuckDB.
      if (sql === 'COMMIT') await (await real()).run('ROLLBACK');
      throw new Error(message);
    }
    let m;
    if ((m = /^(?:CREATE OR REPLACE DATABASE|DROP DATABASE(?: IF EXISTS)?) "(\w+)"/.exec(sql)) && shares.includes(m[1]) && dbs.has(m[1])) {
      throw new Error(`Cannot drop or replace database ${m[1]}: it has an attached share`);
    }
    if ((m = /^SELECT count\(\*\)::VARCHAR AS n FROM duckdb_databases\(\) WHERE database_name = '(\w+)'$/.exec(sql))) {
      return [{ n: dbs.has(m[1]) ? '1' : '0' }];
    }
    if ((m = /^DROP DATABASE IF EXISTS "(\w+)"$/.exec(sql))) { await drop(m[1]); return []; }
    if ((m = /^CREATE DATABASE "(\w+)"$/.exec(sql))) {
      if (dbs.has(m[1])) throw new Error(`database ${m[1]} already exists`);
      await (await real()).run(`ATTACH ':memory:' AS "${m[1]}"`);
      dbs.set(m[1], { tables: new Map(), publish: null });
      return [];
    }
    // staging's fixture_publish: written to the engine too (the swap copies
    // it from there), and to the model without re-reading the rest, so a
    // test can still edit staging's model counts before the check.
    if ((m = /^CREATE TABLE "(\w+)"\.main\.fixture_publish \(key VARCHAR, value VARCHAR\)$/.exec(sql))) {
      await (await real()).run(sql);
      const d = dbs.get(m[1]);
      d.publish = new Map();
      d.tables.set('fixture_publish', 0);
      return [];
    }
    if ((m = /^INSERT INTO "(\w+)"\.main\.fixture_publish VALUES (.+)$/.exec(sql))) {
      await (await real()).run(sql);
      const d = dbs.get(m[1]);
      for (const [, k, v] of m[2].matchAll(/\('((?:[^']|'')*)', '((?:[^']|'')*)'\)/g)) d.publish.set(k, v.replace(/''/g, "'"));
      d.tables.set('fixture_publish', d.publish.size);
      return [];
    }
    if ((m = /^SELECT table_name FROM information_schema\.tables WHERE table_catalog = '(\w+)' AND table_schema = 'main' ORDER BY table_name$/.exec(sql))) {
      return [...(dbs.get(m[1])?.tables.keys() || [])].sort().map((table_name) => ({ table_name }));
    }
    if ((m = /^SELECT count\(\*\)::VARCHAR AS n FROM "(\w+)"\.main\."(\w+)"$/.exec(sql))) {
      return [{ n: String(dbs.get(m[1]).tables.get(m[2])) }];
    }
    if ((m = /^SELECT key, value FROM "(\w+)"\.main\.fixture_publish$/.exec(sql))) {
      return [...dbs.get(m[1]).publish].map(([key, value]) => ({ key, value }));
    }
    if ((m = /^CREATE DATABASE "(\w+)" FROM "(\w+)"$/.exec(sql))) {
      if (dbs.has(m[1])) throw new Error(`database ${m[1]} already exists`);
      await copyDatabase(m[2], m[1]);
      dbs.set(m[1], { tables: new Map(), publish: null });
      await sync();
      return [];
    }
    if ((m = /^DROP DATABASE "(\w+)"$/.exec(sql))) {
      if (!(await drop(m[1]))) throw new Error(`no database ${m[1]}`);
      return [];
    }
    const rows = await (await real()).run(sql);
    if (!/^SELECT /.test(sql)) await sync();
    return rows;
  }

  async function connect({ token }) {
    tokens.push(token);
    if (connectError) throw new Error(connectError);
    return { run, close: () => { closed.push(true); if (closeError) throw new Error(closeError); } };
  }
  // The databases attached on the engine right now, the upload's alias for
  // the local build included while it is attached.
  const attached = async () => [...(await realDatabases())].filter((n) => !['memory', 'system', 'temp'].includes(n)).sort();
  // A table's rows on the engine, in a stable order, for before/after checks.
  const rowsOf = async (name, table, schema = 'main') => (await real()).run(`SELECT * FROM "${name}"."${schema}"."${table}" ORDER BY ALL`);
  return { connect, dbs, statements, tokens, closed, attached, seed, rowsOf, foreignKeys: foreignKeysOf };
}

function never(name) {
  return async () => { throw new Error(`${name} must not be called`); };
}

// Runs a CLI main in-process with captured output and injected seams.
async function runMain(mod, argv, { env = {}, connect, readKeychain = () => null, platform = 'linux', cwd } = {}) {
  const out = [];
  const err = [];
  const code = await mod.main(argv, {
    env: { APLABS_NO_KEYCHAIN: '1', ...env },
    cwd: cwd || process.cwd(),
    connect: connect || never('connect'),
    readKeychain,
    platform,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => new Date('2026-10-24T12:00:00Z'),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), all: [...out, ...err].join('\n') };
}

const pub = (f, extra = [], opts = {}) => runMain(publish, [f.dir, '--db', f.db, '--profile', PROFILE, ...extra], opts);
const stat = (f, extra = [], opts = {}) => runMain(status, [f.dir, '--db', f.db, ...extra], opts);
const withToken = { MOTHERDUCK_TOKEN: TOKEN };

// --- Names, version and the local snapshot ---------------------------------

test('databaseNameFor: <client>_fixture from the folder holding the fixture dir, or --name; --database wins', () => {
  assert.equal(remote.databaseNameFor('/x/acme/fixture'), 'acme_fixture');
  assert.equal(remote.databaseNameFor('/x/acme/fixture', { name: 'Big-Co' }), 'big_co_fixture');
  assert.equal(remote.databaseNameFor('/x/acme/fixture', { database: 'shared_copy' }), 'shared_copy');
  assert.equal(remote.databaseNameProblem('shared_copy'), null);
  for (const bad of ['', 'Has"Quote', 'a;drop', '9lives', 'x'.repeat(64), 'my_db', 'acme__publishing']) {
    assert.ok(remote.databaseNameProblem(bad), `${bad} is refused`);
  }
});

test('parseArgs: publish and status take a fixture dir and the same options; status adds --remote', () => {
  assert.deepEqual(publish.parseArgs(['f', '--db', 'x', '--database', 'd']), {
    fixtureDir: 'f', db: 'x', name: null, database: 'd', profile: null,
  });
  assert.deepEqual(status.parseArgs(['f', '--remote']), {
    fixtureDir: 'f', db: null, name: null, database: null, remote: true,
  });
  assert.match(publish.parseArgs([]).error, /missing <fixture-dir>/);
  assert.match(publish.parseArgs(['f', '--remote']).error, /unknown option --remote/);
  assert.match(status.parseArgs(['f', '--db']).error, /--db needs a value/);
});

test('seedsHash: stable for the same files, different when a seed or the schema changes', (t) => {
  const a = path.join(tmpDir(t), 'a');
  fs.cpSync(MINI, a, { recursive: true });
  const h = remote.seedsHash(a);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(remote.seedsHash(a), h);
  fs.appendFileSync(path.join(a, 'seeds', 'regions.csv'), 'r9,Nine\n');
  assert.notEqual(remote.seedsHash(a), h);
  const h2 = remote.seedsHash(a);
  fs.appendFileSync(path.join(a, 'schema.sql'), '\n-- comment\n');
  assert.notEqual(remote.seedsHash(a), h2);
});

test('localSnapshot: version from fixture_meta and the seeds hash, row counts per schema table', async (t) => {
  const f = await fixture(t, { meta: META_V3 });
  const snap = await remote.localSnapshot({ fixtureDir: f.dir, db: f.db });
  assert.equal(snap.generatorVersion, '3');
  assert.equal(snap.asOf, '2026-09-30');
  assert.equal(snap.seedsSha256, remote.seedsHash(f.dir));
  assert.equal(snap.version, `3+${snap.seedsSha256.slice(0, 12)}`);
  assert.deepEqual(snap.counts, { regions: 2, shops: 3, fixture_meta: 4 });
  assert.deepEqual(snap.stale, []);
});

test('localSnapshot: a build older than the seeds is reported stale', async (t) => {
  const f = await fixture(t, { meta: META_V3 });
  fs.writeFileSync(path.join(f.dir, 'seeds', 'fixture_meta.csv'), META_V3.replace('generator_version,3', 'generator_version,4'));
  const snap = await remote.localSnapshot({ fixtureDir: f.dir, db: f.db });
  assert.deepEqual(snap.stale, ['generator_version: the build has 3, seeds/fixture_meta.csv has 4']);
});

// --- fixture:status, local (offline) ---------------------------------------

test('status (local): prints the version and row counts offline, never reads a token or connects', async (t) => {
  const f = await fixture(t, { meta: META_V3 });
  let keychainReads = 0;
  const r = await stat(f, [], { env: withToken, readKeychain: () => { keychainReads += 1; return null; } });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /local fixture version 3\+[0-9a-f]{12}/);
  assert.match(r.stdout, /as of 2026-09-30/);
  assert.match(r.stdout, /regions\s+2/);
  assert.match(r.stdout, /shops\s+3/);
  assert.equal(keychainReads, 0);
});

test('status (local): no build exits 1 and says to build', async (t) => {
  const f = await fixture(t);
  fs.rmSync(f.db);
  const r = await stat(f);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no built fixture .* npm run fixture:build/);
});

// --- fixture:publish refusals -----------------------------------------------

test('publish: refuses when a local check fails, before reading the token or connecting', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dir, 'checks', 'zz-always-fails.sql'), '-- Always fails.\nSELECT 1 AS bad\n');
  let keychainReads = 0;
  const r = await pub(f, [], { env: withToken, readKeychain: () => { keychainReads += 1; return null; } });
  assert.equal(r.code, 1);
  assert.match(r.all, /FAIL zz-always-fails/);
  assert.match(r.stderr, /local validation failed: 1 of 4 checks; nothing was published/);
  assert.equal(keychainReads, 0);
});

test('publish: refuses with no build, no checks, or a stale build', async (t) => {
  const f = await fixture(t, { meta: META_V3 });
  const noBuild = await pub({ ...f, db: path.join(f.root, 'missing.duckdb') }, [], { env: withToken });
  assert.equal(noBuild.code, 1);
  assert.match(noBuild.stderr, /no built fixture/);

  fs.writeFileSync(path.join(f.dir, 'seeds', 'fixture_meta.csv'), META_V3.replace('as_of,2026-09-30', 'as_of,2026-10-31'));
  const stale = await pub(f, [], { env: withToken });
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /the build is older than the seeds.*as_of.*Run npm run fixture:build/s);

  fs.writeFileSync(path.join(f.dir, 'seeds', 'fixture_meta.csv'), META_V3);
  fs.rmSync(path.join(f.dir, 'checks'), { recursive: true });
  const noChecks = await pub(f, [], { env: withToken });
  assert.equal(noChecks.code, 1);
  assert.match(noChecks.stderr, /no checks/);
});

// Issue #85: no profile means no forbidden columns are known, so publish
// refuses with exit 2, exactly like validate and query, before any check runs.
test('publish: no profile fails closed with exit 2, before any check, token read or connection', async (t) => {
  const f = await fixture(t);
  let keychainReads = 0;
  const r = await runMain(publish, [f.dir, '--db', f.db], {
    env: withToken, cwd: f.root, readKeychain: () => { keychainReads += 1; return null; },
  });
  assert.equal(r.code, 2, r.all);
  assert.match(r.stderr, /fixture:publish: no profile \(pass --profile, set APLABS_PROFILE or add \.aplabs\/profile\.yml\); nothing was published/);
  assert.doesNotMatch(r.all, /PASS|FAIL/);
  assert.equal(keychainReads, 0);
});

// Issue #87: --db can name any file. Publish uploads only a build of these
// seeds: a file whose stamp is genuine for other data, or that has no valid
// stamp, is refused before the token is read.
test('publish: refuses a file that is not the build of these seeds, even when validly stamped (issue #87)', async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, 'other', 'fixture');
  fs.cpSync(f.dir, other, { recursive: true });
  const shops = path.join(other, 'seeds', 'shops.csv');
  fs.writeFileSync(shops, fs.readFileSync(shops, 'utf8').replace('00402', '98101'));
  const foreign = path.join(f.root, 'other.duckdb');
  await build({ fixtureDir: other, out: foreign });
  let keychainReads = 0;
  const opts = { env: withToken, readKeychain: () => { keychainReads += 1; return null; } };
  const r = await pub({ ...f, db: foreign }, [], opts);
  assert.equal(r.code, 1, r.all);
  assert.match(r.stderr, /is not the npm run fixture:build output of these seeds.*nothing was published/s);

  const unstamped = path.join(f.root, 'unstamped.duckdb');
  await build({ fixtureDir: f.dir, out: unstamped, stamp: false });
  const u = await pub({ ...f, db: unstamped }, [], opts);
  assert.equal(u.code, 1, u.all);
  assert.match(u.stderr, /has no valid fixture:build stamp.*nothing was published/s);
  assert.equal(keychainReads, 0);
});

test('publish: a missing token exits 1 with how to configure it, after the Keychain is consulted', async (t) => {
  const f = await fixture(t);
  const asked = [];
  const r = await pub(f, [], { env: { APLABS_NO_KEYCHAIN: '' }, platform: 'darwin', readKeychain: (s) => { asked.push(s); return null; } });
  assert.equal(r.code, 1);
  assert.deepEqual(asked, ['aplabs-motherduck-token']);
  assert.match(r.stderr, /no MotherDuck token/);
  assert.match(r.stderr, /MOTHERDUCK_TOKEN/);
  assert.match(r.stderr, /security add-generic-password -s aplabs-motherduck-token -a aplabs -w/);
  assert.match(r.stderr, /docs\/runtime\/motherduck-publish\.md/);
});

test('publish: a bad --database is a usage error before anything runs', async (t) => {
  const f = await fixture(t);
  const r = await pub(f, ['--database', 'x;drop'], { env: withToken });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--database/);
});

// --- fixture:publish, the replace -------------------------------------------

test('publish: uploads to a staging database, records the version, checks it, then copies it whole on a first publish', async (t) => {
  const f = await fixture(t, { meta: META_V3 });
  const md = fakeMotherDuck();
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(md.tokens, [TOKEN]);
  assert.equal(md.closed.length, 1);

  const snap = await remote.localSnapshot({ fixtureDir: f.dir, db: f.db });
  const order = md.statements.map((s) => s.split(' FROM ')[0].split(' VALUES ')[0].split('(')[0]);
  assert.deepEqual(order.filter((s) => /^(ATTACH|USE|DETACH|DROP|CREATE|INSERT)/.test(s)), [
    `ATTACH '${f.db}' AS "aplabs_publish_local" `,
    'DROP DATABASE IF EXISTS "acme_fixture__publishing"',
    'CREATE DATABASE "acme_fixture__publishing"',
    'USE "acme_fixture__publishing"',
    'CREATE TABLE fixture_meta',
    'CREATE TABLE regions',
    'CREATE TABLE shops',
    'USE "memory"',
    'INSERT INTO "acme_fixture__publishing".main."fixture_meta" SELECT *',
    'INSERT INTO "acme_fixture__publishing".main."regions" SELECT *',
    'INSERT INTO "acme_fixture__publishing".main."shops" SELECT *',
    'DETACH "aplabs_publish_local"',
    'CREATE TABLE "acme_fixture__publishing".main.fixture_publish ',
    'INSERT INTO "acme_fixture__publishing".main.fixture_publish',
    'CREATE DATABASE "acme_fixture"',
    'DROP DATABASE "acme_fixture__publishing"',
  ]);
  assert.ok(md.statements.includes(`ATTACH '${f.db}' AS "aplabs_publish_local" (READ_ONLY)`));
  assert.ok(md.statements.includes('INSERT INTO "acme_fixture__publishing".main."shops" SELECT * FROM "aplabs_publish_local".main."shops"'));
  assert.ok(md.statements.includes('CREATE DATABASE "acme_fixture" FROM "acme_fixture__publishing"'), 'a first publish copies staging whole');
  assert.ok(!md.statements.some((s) => /^CREATE OR REPLACE DATABASE/.test(s)), 'nothing is ever replaced whole');

  assert.deepEqual([...md.dbs.keys()], ['acme_fixture']);
  const shared = md.dbs.get('acme_fixture');
  assert.equal(shared.publish.get('fixture_version'), snap.version);
  assert.equal(shared.publish.get('generator_version'), '3');
  assert.equal(shared.publish.get('seeds_sha256'), snap.seedsSha256);
  assert.equal(shared.publish.get('published_at'), '2026-10-24T12:00:00.000Z');
  assert.equal(shared.publish.get('rows_shops'), '3');
  assert.equal(shared.tables.get('shops'), 3);
  assert.match(r.stdout, new RegExp(`published acme_fixture: version ${snap.version.replace('+', '\\+')}, 3 tables, 9 rows`));
});

// A database this tool published: its tables plus fixture_publish.
const published = (tables) => ({
  tables: new Map([...tables, ['fixture_publish', 1]]), publish: new Map([['fixture_version', 'old']]),
});

// --- fixture:publish, a re-publish in place (plan publish-in-place) ----------
//
// The 2026-10-25 live failure: MotherDuck refuses to replace (or drop) a
// database while a share is attached, and the bot reads through one. A
// re-publish now updates the target in place, in one transaction, and the
// share stays attached. The targets below are real tables on the fake's
// engine, foreign keys and fixture_publish included, in an older layout:
// crews has no name column, old_notes is gone from the build and
// assignments is new.
const OLD_LAYOUT = {
  ddl: [
    'CREATE TABLE fixture_meta (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)',
    'CREATE TABLE zones (zone_id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL)',
    'CREATE TABLE crews (crew_id INTEGER PRIMARY KEY, zone_id VARCHAR NOT NULL REFERENCES zones (zone_id))',
    'CREATE TABLE old_notes (note_id INTEGER PRIMARY KEY, crew_id INTEGER REFERENCES crews (crew_id))',
  ],
  rows: {
    fixture_meta: "('generator_version', '0')",
    zones: "('z9', 'Old zone'), ('z8', 'Older zone')",
    crews: "(90, 'z9'), (91, 'z8')",
    old_notes: '(1, 90)',
  },
  publish: { fixture_version: '0+old', rows_crews: '2' },
};
const OLD_TABLES = ['crews', 'fixture_meta', 'fixture_publish', 'old_notes', 'zones'];

// Every table's rows in `name`, for before/after comparisons.
async function contents(md, name, tables) {
  const out = {};
  for (const t of tables) out[t] = await md.rowsOf(name, t);
  return out;
}

// The statements a re-publish sends after the upload, writes and USE only,
// a CREATE TABLE shortened to its name.
function swapStatements(md) {
  const from = md.statements.findIndex((s) => /^INSERT INTO "acme_fixture__publishing"\.main\.fixture_publish VALUES/.test(s));
  return md.statements.slice(from + 1).filter((s) => !/^SELECT /.test(s)).map((s) => (/^CREATE TABLE \w+\(/.test(s) ? s.split('(')[0] : s));
}

test('publish: a re-publish with a share attached updates the target in place, in one transaction', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const md = fakeMotherDuck({ shares: ['acme_fixture'] });
  await md.seed('acme_fixture', OLD_LAYOUT);
  // A staging copy left by an earlier failed publish is cleared first.
  md.dbs.set('acme_fixture__publishing', { tables: new Map([['stale', 1]]), publish: null });
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 0, r.all);

  const s = '"acme_fixture__publishing"';
  assert.deepEqual(swapStatements(md), [
    'USE "acme_fixture"',
    'BEGIN TRANSACTION',
    // Children first, by the target's own foreign keys; fixture_publish stays.
    'DROP TABLE main."old_notes"',
    'DROP TABLE main."crews"',
    'DROP TABLE main."zones"',
    'DROP TABLE main."fixture_meta"',
    // The build's definitions, parents first, then their rows.
    'CREATE TABLE fixture_meta',
    'CREATE TABLE zones',
    'CREATE TABLE crews',
    'CREATE TABLE assignments',
    `INSERT INTO "fixture_meta" SELECT * FROM ${s}.main."fixture_meta"`,
    `INSERT INTO "zones" SELECT * FROM ${s}.main."zones"`,
    `INSERT INTO "crews" SELECT * FROM ${s}.main."crews"`,
    `INSERT INTO "assignments" SELECT * FROM ${s}.main."assignments"`,
    // The version record last, inside the transaction.
    'DROP TABLE main.fixture_publish',
    'CREATE TABLE fixture_publish (key VARCHAR, value VARCHAR)',
    `INSERT INTO fixture_publish SELECT * FROM ${s}.main.fixture_publish`,
    'COMMIT',
    'USE "memory"',
    `DROP DATABASE ${s}`,
  ]);
  assert.ok(!md.statements.some((x) => /^(CREATE OR REPLACE DATABASE|DROP DATABASE "acme_fixture"$|DELETE )/.test(x)), 'never replaced, dropped or row-swapped');

  const snap = await remote.localSnapshot({ fixtureDir: f.dir, db: f.db });
  const shared = md.dbs.get('acme_fixture');
  assert.deepEqual(Object.fromEntries(shared.tables), { assignments: 4, crews: 3, fixture_meta: 5, zones: 2, fixture_publish: 9 });
  assert.equal(shared.publish.get('fixture_version'), snap.version);
  assert.equal(shared.publish.get('rows_crews'), '3');
  assert.deepEqual(await md.foreignKeys('acme_fixture'), ['assignments -> crews', 'assignments -> zones', 'crews -> zones']);
  assert.deepEqual(await md.attached(), ['acme_fixture'], 'the share target stays; the build is detached and staging dropped');
  assert.match(r.stdout, /published acme_fixture: version 1\+[0-9a-f]{12}, 4 tables, 14 rows/);
});

test('publish: a re-publish of the same layout rebuilds every table too (no row-only swap)', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const md = fakeMotherDuck({ shares: ['acme_fixture'] });
  assert.equal((await pub(f, [], { env: withToken, connect: md.connect })).code, 0, 'first publish');
  const first = await contents(md, 'acme_fixture', ['assignments', 'crews', 'zones']);
  md.statements.length = 0;
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 0, r.all);
  const swap = swapStatements(md);
  assert.deepEqual(swap.filter((x) => /^DROP TABLE main\."/.test(x)), ['DROP TABLE main."assignments"', 'DROP TABLE main."crews"', 'DROP TABLE main."zones"', 'DROP TABLE main."fixture_meta"']);
  assert.ok(!swap.some((x) => /^DELETE /.test(x)));
  assert.deepEqual(await contents(md, 'acme_fixture', ['assignments', 'crews', 'zones']), first);
  assert.deepEqual(await md.foreignKeys('acme_fixture'), ['assignments -> crews', 'assignments -> zones', 'crews -> zones']);
});

test('publish: a failure mid-copy rolls back, leaves the old tables, rows and version intact, and drops staging', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const md = fakeMotherDuck({ shares: ['acme_fixture'], fail: { '^INSERT INTO "crews" SELECT': 'copy interrupted' } });
  await md.seed('acme_fixture', OLD_LAYOUT);
  const before = await contents(md, 'acme_fixture', OLD_TABLES);
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1, r.all);
  assert.match(r.stderr, /MotherDuck failed: copy interrupted/);
  assert.match(r.stderr, /the update was rolled back, so the shared database acme_fixture was not changed\./);
  const swap = swapStatements(md);
  assert.deepEqual(swap.slice(swap.indexOf('INSERT INTO "crews" SELECT * FROM "acme_fixture__publishing".main."crews"')), [
    'INSERT INTO "crews" SELECT * FROM "acme_fixture__publishing".main."crews"',
    'ROLLBACK',
    'USE "memory"',
    'DROP DATABASE IF EXISTS "acme_fixture__publishing"',
  ]);
  assert.deepEqual(await contents(md, 'acme_fixture', OLD_TABLES), before);
  assert.deepEqual(await md.foreignKeys('acme_fixture'), ['crews -> zones', 'old_notes -> crews']);
  assert.equal(md.dbs.get('acme_fixture').publish.get('fixture_version'), '0+old');
  assert.deepEqual(await md.attached(), ['acme_fixture']);
  assert.equal(md.closed.length, 1);
});

test('publish: a failed rollback says the shared database may be partly changed, and keeps staging', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const md = fakeMotherDuck({ fail: { '^INSERT INTO "zones" SELECT': 'copy interrupted', '^ROLLBACK$': 'connection lost' } });
  await md.seed('acme_fixture', OLD_LAYOUT);
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1, r.all);
  assert.match(r.stderr, /MotherDuck failed: copy interrupted/);
  assert.match(r.stderr, /the rollback failed too, so the shared database acme_fixture may be partly changed; check with npm run fixture:status -- --remote\./);
  assert.doesNotMatch(r.stderr, /was not changed/);
  assert.deepEqual(md.statements.slice(md.statements.indexOf('ROLLBACK')), ['ROLLBACK', 'USE "memory"'], 'staging is kept for the next publish to clear');
  assert.ok(md.dbs.has('acme_fixture__publishing'));
});

test('publish: a failed COMMIT reports the outcome as unknown, with no rollback or cleanup after it', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const md = fakeMotherDuck({ fail: { '^COMMIT$': 'commit lost' } });
  await md.seed('acme_fixture', OLD_LAYOUT);
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1, r.all);
  assert.match(r.stderr, /MotherDuck failed: commit lost/);
  assert.match(r.stderr, /the commit failed, so it is unknown whether the shared database acme_fixture was updated; check with npm run fixture:status -- --remote\./);
  assert.deepEqual(md.statements.slice(md.statements.indexOf('COMMIT')), ['COMMIT', 'USE "memory"']);
  assert.ok(md.dbs.has('acme_fixture__publishing'), 'staging is kept for the next publish to clear');
});

test('publish: a failure on USE of the target, before the transaction, leaves it unchanged and drops staging', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const md = fakeMotherDuck({ fail: { '^USE "acme_fixture"$': 'catalog busy' } });
  await md.seed('acme_fixture', OLD_LAYOUT);
  const before = await contents(md, 'acme_fixture', OLD_TABLES);
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1, r.all);
  assert.match(r.stderr, /MotherDuck failed: catalog busy\nthe shared database acme_fixture was not changed\./);
  assert.ok(!md.statements.includes('BEGIN TRANSACTION'));
  assert.ok(!md.dbs.has('acme_fixture__publishing'));
  assert.deepEqual(await contents(md, 'acme_fixture', OLD_TABLES), before);
});

// Publish writes only the main schema. A table in another schema of the
// target (here audit.crews, which shares a name with a main table, and
// audit.log, which references it) is something publish never wrote.
const WITH_AUDIT = {
  ...OLD_LAYOUT,
  ddl: [
    ...OLD_LAYOUT.ddl,
    'CREATE SCHEMA audit',
    'CREATE TABLE audit.crews (crew_id INTEGER PRIMARY KEY, note VARCHAR)',
    'CREATE TABLE audit.log (log_id INTEGER PRIMARY KEY, crew_id INTEGER REFERENCES audit.crews (crew_id))',
    "INSERT INTO audit.crews VALUES (1, 'kept'), (2, 'also kept')",
    'INSERT INTO audit.log VALUES (7, 1), (8, 2)',
  ],
};

test('publish: a re-publish never touches tables in other schemas of the target', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const md = fakeMotherDuck({ shares: ['acme_fixture'] });
  await md.seed('acme_fixture', WITH_AUDIT);
  const audit = { crews: await md.rowsOf('acme_fixture', 'crews', 'audit'), log: await md.rowsOf('acme_fixture', 'log', 'audit') };
  assert.equal(audit.log.length, 2);
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(swapStatements(md).filter((x) => /^DROP TABLE/.test(x)), [
    'DROP TABLE main."old_notes"', 'DROP TABLE main."crews"', 'DROP TABLE main."zones"', 'DROP TABLE main."fixture_meta"', 'DROP TABLE main.fixture_publish',
  ]);
  assert.ok(!md.statements.some((x) => /audit/.test(x)), 'no statement names the audit schema');
  assert.deepEqual(await md.rowsOf('acme_fixture', 'crews', 'audit'), audit.crews);
  assert.deepEqual(await md.rowsOf('acme_fixture', 'log', 'audit'), audit.log);
  assert.deepEqual(await md.foreignKeys('acme_fixture'), ['assignments -> crews', 'assignments -> zones', 'crews -> zones', 'log -> crews']);
  assert.deepEqual(Object.fromEntries(md.dbs.get('acme_fixture').tables), { assignments: 4, crews: 3, fixture_meta: 5, zones: 2, fixture_publish: 9 });
});

// DuckDB refuses to create a foreign key across schemas, so the catalog read
// gains one, as a database written elsewhere might hold.
test('publish: a foreign key between main and another schema is refused before the transaction, with no write to the target', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const cases = [
    { row: { schema_name: 'main', table_name: 'crews', referenced_table: 'log' }, shown: 'main.crews -> log' },
    { row: { schema_name: 'audit', table_name: 'log', referenced_table: 'zones' }, shown: 'audit.log -> zones' },
  ];
  for (const { row, shown } of cases) {
    const md = fakeMotherDuck({ shares: ['acme_fixture'] });
    await md.seed('acme_fixture', WITH_AUDIT);
    const before = await contents(md, 'acme_fixture', OLD_TABLES);
    const connect = async (o) => {
      const c = await md.connect(o);
      return { ...c, run: async (sql) => {
        const rows = await c.run(sql);
        return /^SELECT schema_name, table_name, referenced_table FROM duckdb_constraints\(\) WHERE database_name = 'acme_fixture'/.test(sql) ? [...rows, row] : rows;
      } };
    };
    const r = await pub(f, [], { env: withToken, connect });
    assert.equal(r.code, 1, r.all);
    assert.match(r.stderr, new RegExp(`acme_fixture has foreign keys that cross out of their schema \\(${shown.replace('.', '\\.')}\\), so publish cannot rebuild its main tables`));
    assert.match(r.stderr, /\nthe shared database acme_fixture was not changed\./);
    const after = md.statements.slice(md.statements.indexOf('USE "acme_fixture"') + 1).filter((x) => !/^SELECT /.test(x));
    assert.deepEqual(after, ['USE "memory"', 'DROP DATABASE IF EXISTS "acme_fixture__publishing"'], `${shown}: no write reaches the target`);
    assert.deepEqual(await contents(md, 'acme_fixture', OLD_TABLES), before);
    assert.equal(md.dbs.get('acme_fixture').publish.get('fixture_version'), '0+old');
  }
});

test('publish: a target that does not exist yet is created (first publish)', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck();
  const r = await pub(f, ['--database', 'brand_new'], { env: withToken, connect: md.connect });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual([...md.dbs.keys()], ['brand_new']);
  assert.ok(md.dbs.get('brand_new').publish.has('fixture_version'));
});

// --- The upload order (the 2026-10-24 live failure) ---------------------------
//
// The first real publish failed at CREATE DATABASE <staging> FROM '<file>':
// MotherDuck's whole-database copy loaded crews before zones and broke the
// foreign key. These run the real upload SQL on the fake's DuckDB engine,
// foreign keys enforced, with a schema whose every child sorts before its parent.

test('publish: child tables that sort before their parents upload parent-first, foreign keys kept', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const md = fakeMotherDuck();
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 0, r.all);
  assert.ok(!md.statements.some((s) => /^CREATE DATABASE .* FROM '/.test(s)), 'no whole-file database copy');
  const created = md.statements.map((s) => /^CREATE TABLE (\w+)\(/.exec(s)?.[1]).filter(Boolean);
  assert.deepEqual(created, ['fixture_meta', 'zones', 'crews', 'assignments']);
  const loaded = md.statements.map((s) => /^INSERT INTO "acme_fixture__publishing"\.main\."(\w+)" SELECT/.exec(s)?.[1]).filter(Boolean);
  assert.deepEqual(loaded, created);

  const shared = md.dbs.get('acme_fixture');
  assert.deepEqual(Object.fromEntries(shared.tables), { assignments: 4, crews: 3, fixture_meta: 5, zones: 2, fixture_publish: 9 });
  assert.deepEqual(await md.foreignKeys('acme_fixture'), ['assignments -> crews', 'assignments -> zones', 'crews -> zones']);
  assert.deepEqual(await md.attached(), ['acme_fixture'], 'the local build is detached and staging dropped');
  assert.match(r.stdout, /published acme_fixture: version 1\+[0-9a-f]{12}, 4 tables, 14 rows/);
});

test('publish: a failure mid-upload still detaches the local build and drops staging', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const md = fakeMotherDuck({ fail: { '^INSERT INTO "acme_fixture__publishing"\\.main\\."crews"': 'upload interrupted' } });
  const before = published([['old_table', 99]]);
  md.dbs.set('acme_fixture', before);
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1, r.all);
  assert.match(r.stderr, /MotherDuck failed: upload interrupted/);
  assert.match(r.stderr, /the shared database acme_fixture was not changed/);
  assert.equal(md.dbs.get('acme_fixture'), before);
  assert.ok(!md.dbs.has('acme_fixture__publishing'));
  assert.deepEqual(await md.attached(), []);
  const failed = md.statements.findIndex((s) => /^INSERT INTO "acme_fixture__publishing"\.main\."crews"/.test(s));
  assert.ok(md.statements.slice(failed).includes('DETACH "aplabs_publish_local"'), 'DETACH follows the failure');
  assert.equal(md.closed.length, 1);
});

test('publish: foreign keys that form a cycle are refused before staging is created, and the build is detached', async (t) => {
  const f = await fixture(t, { src: FK_ORDER });
  const md = fakeMotherDuck();
  // DuckDB cannot store a cycle (a table can only reference one that exists),
  // so the catalog read gains one: zones -> assignments.
  const connect = async (o) => {
    const c = await md.connect(o);
    return { ...c, run: async (sql) => {
      const rows = await c.run(sql);
      return /duckdb_constraints\(\)/.test(sql) ? [...rows, { table_name: 'zones', referenced_table: 'assignments' }] : rows;
    } };
  };
  const r = await pub(f, [], { env: withToken, connect });
  assert.equal(r.code, 1, r.all);
  assert.match(r.stderr, /the foreign keys among assignments, crews, zones form a cycle, so no load order works/);
  assert.match(r.stderr, /the shared database acme_fixture was not changed/);
  assert.ok(!md.statements.includes('CREATE DATABASE "acme_fixture__publishing"'), 'staging was never created');
  assert.ok(md.statements.includes('DETACH "aplabs_publish_local"'));
  assert.deepEqual(await md.attached(), []);
});

test('publish: a build holding anything besides tables is refused before staging is created', async (t) => {
  const src = path.join(tmpDir(t), 'fk-view');
  fs.cpSync(FK_ORDER, src, { recursive: true });
  fs.appendFileSync(path.join(src, 'schema.sql'), '\nCREATE VIEW crew_zones AS SELECT c.crew_id, z.name FROM crews c JOIN zones z USING (zone_id);\nCREATE SEQUENCE ids;\n');
  const f = await fixture(t, { src });
  const md = fakeMotherDuck();
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1, r.all);
  assert.match(r.stderr, /the local build holds more than tables \(sequence ids, view crew_zones\), and publish uploads tables only/);
  assert.ok(!md.statements.includes('CREATE DATABASE "acme_fixture__publishing"'));
  assert.deepEqual(await md.attached(), []);
});

test('parentFirst: parents before children, ties by name, self-references allowed, cycles refused', () => {
  assert.deepEqual(publish.parentFirst(['b', 'a', 'c'], []), ['a', 'b', 'c']);
  assert.deepEqual(publish.parentFirst(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]), ['c', 'b', 'a']);
  assert.deepEqual(publish.parentFirst(['emp', 'dept'], [['emp', 'emp'], ['emp', 'dept']]), ['dept', 'emp']);
  assert.throws(() => publish.parentFirst(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['c', 'a']]), /the foreign keys among a, b, c form a cycle/);
});

// --database can name any MotherDuck database. Publish replaces only one it
// published (it has a fixture_publish table); anything else is refused with
// no write sent at all, a leftover staging copy included.
test('publish: refuses to replace an existing database it did not publish, and sends no write', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck();
  const prod = { tables: new Map([['customers', 5000]]), publish: null };
  const leftover = published([['shops', 3]]);
  md.dbs.set('prod_crm', prod);
  md.dbs.set('prod_crm__publishing', leftover);
  const r = await pub(f, ['--database', 'prod_crm'], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1, r.all);
  assert.match(r.stderr, /prod_crm already exists and was not published by fixture:publish \(it has no fixture_publish table\)/);
  assert.match(r.stderr, /the shared database prod_crm was not changed/);
  assert.equal(md.dbs.get('prod_crm'), prod);
  assert.equal(md.dbs.get('prod_crm__publishing'), leftover);
  assert.deepEqual(md.statements.filter((s) => !/^SELECT /.test(s)), [], 'only reads were sent');
  assert.equal(md.closed.length, 1);
});

test('publish: a failure before the swap leaves the shared database untouched and removes staging', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck({ fail: { '^INSERT INTO': 'quota exceeded' } });
  const before = published([['old_table', 99]]);
  md.dbs.set('acme_fixture', before);
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /MotherDuck failed: quota exceeded/);
  assert.match(r.stderr, /the shared database acme_fixture was not changed/);
  assert.equal(md.dbs.get('acme_fixture'), before);
  assert.ok(!md.dbs.has('acme_fixture__publishing'));
  assert.equal(md.closed.length, 1);
});

test('publish: a staging copy that does not match the local build is never swapped in', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck();
  const realConnect = md.connect;
  // Corrupt staging between the upload and the check.
  const connect = async (o) => {
    const c = await realConnect(o);
    return { ...c, run: async (sql) => {
      const rows = await c.run(sql);
      if (/^CREATE TABLE/.test(sql)) md.dbs.get('acme_fixture__publishing').tables.set('shops', 2);
      return rows;
    } };
  };
  const r = await pub(f, [], { env: withToken, connect });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the uploaded copy does not match the local build/);
  assert.match(r.stderr, /shops: local 3, remote 2/);
  assert.ok(!md.dbs.has('acme_fixture'));
  assert.ok(!md.dbs.has('acme_fixture__publishing'));
});

// --- The token never reaches output -----------------------------------------

test('publish: a connection error that contains the token is redacted', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck({ connectError: `Invalid token ${TOKEN} (md:?motherduck_token=${TOKEN})` });
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1);
  assert.ok(!r.all.includes(TOKEN), 'the token is not in the output');
  assert.match(r.stderr, /MotherDuck failed: Invalid token \[redacted\]/);
});

test('publish: a statement error that contains the token is redacted too, and the token is never recorded', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck({ fail: { '^CREATE DATABASE "acme_fixture" FROM': `catalog error near ${TOKEN}` } });
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1);
  assert.ok(!r.all.includes(TOKEN));
  assert.match(r.stderr, /catalog error near \[redacted\]/);
  assert.match(r.stderr, /the shared database acme_fixture may not have been created; check with npm run fixture:status -- --remote\./);
  assert.ok(!md.statements.some((s) => s.includes(TOKEN)), 'no statement carries the token');
});

test('publish: the token is never written to the fixture dir or the build', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck();
  assert.equal((await pub(f, [], { env: withToken, connect: md.connect })).code, 0);
  const files = fs.readdirSync(f.root, { recursive: true }).map((p) => path.join(f.root, p)).filter((p) => fs.statSync(p).isFile());
  for (const file of files) assert.ok(!fs.readFileSync(file).includes(TOKEN), `${file} does not hold the token`);
});

// --- Closing the connection and the top-level handler ------------------------

test('publish: a close error after a publish is redacted and exits 1; the publish stands', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck({ closeError: `socket closed for ${TOKEN}` });
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1, 'a close failure is non-zero even after success');
  assert.ok(!r.all.includes(TOKEN));
  assert.match(r.stdout, /published acme_fixture/);
  assert.match(r.stderr, /closing the MotherDuck connection failed: socket closed for \[redacted\]/);
  assert.ok(md.dbs.has('acme_fixture'));
  assert.equal(md.closed.length, 1);
});

test('publish: a close error after a failure keeps exit 1 and both messages, redacted', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck({ fail: { '^CREATE DATABASE "acme_fixture" FROM': 'swap refused' }, closeError: `close ${TOKEN}` });
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1);
  assert.ok(!r.all.includes(TOKEN));
  assert.match(r.stderr, /MotherDuck failed: swap refused/);
  assert.match(r.stderr, /closing the MotherDuck connection failed: close \[redacted\]/);
});

test('status --remote: a close error is redacted and exits 1, even when the copies match', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck();
  assert.equal((await pub(f, [], { env: withToken, connect: md.connect })).code, 0);
  const broken = { connect: async (o) => ({ ...(await md.connect(o)), close: () => { throw new Error(`close ${TOKEN}`); } }) };
  const r = await stat(f, ['--remote'], { env: withToken, connect: broken.connect });
  assert.equal(r.code, 1);
  assert.ok(!r.all.includes(TOKEN));
  assert.match(r.stdout, /match: the shared copy is the local build/);
  assert.match(r.stderr, /closing the MotherDuck connection failed: close \[redacted\]/);
});

test('reportUncaught: masks every token read in this process, prints no raw stack, returns 1', async (t) => {
  const f = await fixture(t);
  await stat(f, ['--remote'], { env: withToken, connect: fakeMotherDuck().connect });
  const lines = [];
  const e = new Error(`late failure ${TOKEN}`);
  assert.equal(remote.reportUncaught(e, { err: (s) => lines.push(s) }), 1);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(TOKEN));
  assert.match(lines[0], /late failure \[redacted\]/);
});

// The real entry points: a preload makes main throw past its own catch with an
// error carrying the token (connect fails, then firstLine throws inside the
// catch). Nothing reaches the network: connect is replaced before main runs.
function crashRun(t, script, args) {
  const dir = tmpDir(t);
  const preload = path.join(dir, 'crash.js');
  fs.writeFileSync(preload, [
    `const remote = require(${JSON.stringify(require.resolve('../../kit/fixture/remote'))});`,
    "remote.defaultConnect = async () => { throw new Error('connect refused'); };",
    'remote.firstLine = () => { throw new Error(`crash with ${process.env.MOTHERDUCK_TOKEN}`); };',
    '',
  ].join('\n'));
  return spawnSync(process.execPath, ['--require', preload, path.join(__dirname, '..', '..', 'kit', 'fixture', script), ...args], {
    env: { PATH: process.env.PATH, APLABS_NO_KEYCHAIN: '1', MOTHERDUCK_TOKEN: TOKEN },
    encoding: 'utf8',
  });
}

test('publish (CLI): an uncaught error after the token is read is redacted and exits 1, not a crash', async (t) => {
  const f = await fixture(t);
  const r = crashRun(t, 'publish.js', [f.dir, '--db', f.db, '--profile', PROFILE]);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN), 'the token is not in the output');
  assert.match(r.stderr, /crash with \[redacted\]/);
});

test('status --remote (CLI): an uncaught error after the token is read is redacted and exits 1', async (t) => {
  const f = await fixture(t);
  const r = crashRun(t, 'status.js', [f.dir, '--db', f.db, '--remote']);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
  assert.match(r.stderr, /crash with \[redacted\]/);
});

// --- fixture:status --remote ------------------------------------------------

test('status --remote: after a publish, versions and row counts match', async (t) => {
  const f = await fixture(t, { meta: META_V3 });
  const md = fakeMotherDuck();
  assert.equal((await pub(f, [], { env: withToken, connect: md.connect })).code, 0);
  const r = await stat(f, ['--remote'], { env: withToken, connect: md.connect });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /remote acme_fixture: version 3\+[0-9a-f]{12}, published 2026-10-24T12:00:00.000Z/);
  assert.match(r.stdout, /match: the shared copy is the local build/);
  assert.ok(!r.all.includes(TOKEN));
});

test('status --remote: a different version or row count says so, table by table, and exits 1', async (t) => {
  const f = await fixture(t, { meta: META_V3 });
  const md = fakeMotherDuck();
  assert.equal((await pub(f, [], { env: withToken, connect: md.connect })).code, 0);
  md.dbs.get('acme_fixture').tables.set('regions', 7);
  md.dbs.get('acme_fixture').publish.set('fixture_version', '2+abc');
  const r = await stat(f, ['--remote'], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /differs/);
  assert.match(r.stdout, /version: local 3\+[0-9a-f]{12}, remote 2\+abc/);
  assert.match(r.stdout, /regions: local 2, remote 7/);
});

test('status --remote: not published yet, a missing token, and a redacted error', async (t) => {
  const f = await fixture(t);
  const none = await stat(f, ['--remote'], { env: withToken, connect: fakeMotherDuck().connect });
  assert.equal(none.code, 1);
  assert.match(none.stdout, /acme_fixture is not on MotherDuck yet/);

  const noToken = await stat(f, ['--remote']);
  assert.equal(noToken.code, 1);
  assert.match(noToken.stderr, /no MotherDuck token.*MOTHERDUCK_TOKEN/s);

  const broken = await stat(f, ['--remote'], { env: withToken, connect: fakeMotherDuck({ connectError: `bad ${TOKEN}` }).connect });
  assert.equal(broken.code, 1);
  assert.ok(!broken.all.includes(TOKEN));
  assert.match(broken.stderr, /bad \[redacted\]/);
});

test('compare: lists every difference; a table on one side only counts as one', () => {
  const local = { version: '1+a', counts: { a: 1, b: 2 } };
  assert.deepEqual(remote.compare(local, { version: '1+a', counts: { a: 1, b: 2 } }), { match: true, differences: [] });
  assert.deepEqual(remote.compare(local, { version: null, counts: { a: 1, c: 3 } }).differences, [
    'version: local 1+a, remote (none recorded)',
    'b: local 2, remote (missing)',
    'c: local (missing), remote 3',
  ]);
});
