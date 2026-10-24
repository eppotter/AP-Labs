'use strict';

// Story 7.7: kit/fixture/publish replaces the shared MotherDuck database with
// the local build, and kit/fixture/status compares the two. Both are run by
// Ely only: every test here injects a fake connection (an in-memory model of
// MotherDuck below) and a fake token, and the Keychain reader is always a
// stub, so no test reaches the network or a real secret. Engine tests: the
// fixture is the minimal one in test/fixtures/fixture-build/mini with the
// checks and profile in test/fixtures/fixture-validate, never a client's.

const test = require('node:test');
const assert = require('node:assert/strict');
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

const MINI = path.join(__dirname, '..', 'fixtures', 'fixture-build', 'mini');
const CHECKS = path.join(__dirname, '..', 'fixtures', 'fixture-validate', 'checks');
const PROFILE = path.join(__dirname, '..', 'fixtures', 'fixture-validate', 'profile.yml');
const TOKEN = 'md-fake-token-7f3a9c'; // not a real token: tests only

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-fixture-publish-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fixture dir <tmp>/acme/fixture (schema, seeds, checks) built into <tmp>/acme.duckdb.
async function fixture(t, { meta } = {}) {
  const root = tmpDir(t);
  const dir = path.join(root, 'acme', 'fixture');
  fs.cpSync(MINI, dir, { recursive: true });
  fs.cpSync(CHECKS, path.join(dir, 'checks'), { recursive: true });
  if (meta) fs.writeFileSync(path.join(dir, 'seeds', 'fixture_meta.csv'), meta);
  const db = path.join(root, 'acme.duckdb');
  await build({ fixtureDir: dir, out: db });
  return { root, dir, db };
}

const META_V3 = 'key,value\nas_of,2026-09-30\ngenerator_version,3\nrows_regions,2\nrows_shops,3\n';

// An in-memory MotherDuck: databases by name, each a map of table -> row
// count plus the fixture_publish rows. It answers exactly the statements
// kit/fixture/remote issues and fails the test on anything else.
function fakeMotherDuck({ fail = {}, connectError } = {}) {
  const dbs = new Map();
  const statements = [];
  const tokens = [];
  const closed = [];
  const copy = (d) => ({ tables: new Map(d.tables), publish: d.publish && new Map(d.publish) });

  async function run(sql) {
    statements.push(sql);
    for (const [re, message] of Object.entries(fail)) if (new RegExp(re).test(sql)) throw new Error(message);
    let m;
    if ((m = /^SELECT count\(\*\)::VARCHAR AS n FROM duckdb_databases\(\) WHERE database_name = '(\w+)'$/.exec(sql))) {
      return [{ n: dbs.has(m[1]) ? '1' : '0' }];
    }
    if ((m = /^DROP DATABASE IF EXISTS "(\w+)"$/.exec(sql))) { dbs.delete(m[1]); return []; }
    if ((m = /^CREATE DATABASE "(\w+)" FROM '(.+)'$/.exec(sql))) {
      if (dbs.has(m[1])) throw new Error(`database ${m[1]} already exists`);
      const file = m[2].replace(/''/g, "'");
      const tables = new Map();
      for (const { table_name: name } of await readRows(file, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'")) {
        tables.set(name, Number((await readRows(file, `SELECT count(*)::VARCHAR AS n FROM "${name}"`))[0].n));
      }
      dbs.set(m[1], { tables, publish: null });
      return [];
    }
    if ((m = /^CREATE TABLE "(\w+)"\.main\.fixture_publish \(key VARCHAR, value VARCHAR\)$/.exec(sql))) {
      const d = dbs.get(m[1]);
      d.publish = new Map();
      d.tables.set('fixture_publish', 0);
      return [];
    }
    if ((m = /^INSERT INTO "(\w+)"\.main\.fixture_publish VALUES (.+)$/.exec(sql))) {
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
    if ((m = /^CREATE OR REPLACE DATABASE "(\w+)" FROM "(\w+)"$/.exec(sql))) {
      dbs.set(m[1], copy(dbs.get(m[2])));
      return [];
    }
    if ((m = /^DROP DATABASE "(\w+)"$/.exec(sql))) {
      if (!dbs.delete(m[1])) throw new Error(`no database ${m[1]}`);
      return [];
    }
    throw new Error(`fake MotherDuck: unexpected statement: ${sql}`);
  }

  async function connect({ token }) {
    tokens.push(token);
    if (connectError) throw new Error(connectError);
    return { run, close: () => closed.push(true) };
  }
  return { connect, dbs, statements, tokens, closed };
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

test('publish: uploads to a staging database, records the version, checks it, then replaces the shared one', async (t) => {
  const f = await fixture(t, { meta: META_V3 });
  const md = fakeMotherDuck();
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(md.tokens, [TOKEN]);
  assert.equal(md.closed.length, 1);

  const snap = await remote.localSnapshot({ fixtureDir: f.dir, db: f.db });
  const order = md.statements.map((s) => s.split(' FROM ')[0].split(' VALUES ')[0]);
  assert.deepEqual(order.filter((s) => /^(DROP|CREATE|INSERT)/.test(s)), [
    'DROP DATABASE IF EXISTS "acme_fixture__publishing"',
    'CREATE DATABASE "acme_fixture__publishing"',
    'CREATE TABLE "acme_fixture__publishing".main.fixture_publish (key VARCHAR, value VARCHAR)',
    'INSERT INTO "acme_fixture__publishing".main.fixture_publish',
    'CREATE OR REPLACE DATABASE "acme_fixture"',
    'DROP DATABASE "acme_fixture__publishing"',
  ]);
  assert.ok(md.statements.includes(`CREATE DATABASE "acme_fixture__publishing" FROM '${f.db}'`));

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

test('publish: replaces an existing shared database whole', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck();
  md.dbs.set('acme_fixture', { tables: new Map([['old_table', 99]]), publish: null });
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual([...md.dbs.get('acme_fixture').tables.keys()].sort(), ['fixture_meta', 'fixture_publish', 'regions', 'shops']);
});

test('publish: a failure before the swap leaves the shared database untouched and removes staging', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck({ fail: { '^INSERT INTO': 'quota exceeded' } });
  const before = { tables: new Map([['old_table', 99]]), publish: new Map([['fixture_version', 'old']]) };
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
  const md = fakeMotherDuck({ fail: { '^CREATE OR REPLACE': `catalog error near ${TOKEN}` } });
  const r = await pub(f, [], { env: withToken, connect: md.connect });
  assert.equal(r.code, 1);
  assert.ok(!r.all.includes(TOKEN));
  assert.match(r.stderr, /catalog error near \[redacted\]/);
  assert.ok(!md.statements.some((s) => s.includes(TOKEN)), 'no statement carries the token');
});

test('publish: the token is never written to the fixture dir or the build', async (t) => {
  const f = await fixture(t);
  const md = fakeMotherDuck();
  assert.equal((await pub(f, [], { env: withToken, connect: md.connect })).code, 0);
  const files = fs.readdirSync(f.root, { recursive: true }).map((p) => path.join(f.root, p)).filter((p) => fs.statSync(p).isFile());
  for (const file of files) assert.ok(!fs.readFileSync(file).includes(TOKEN), `${file} does not hold the token`);
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
