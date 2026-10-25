'use strict';

// Story A (plan motherduck-read): kit/fixture/md-probe checks that MotherDuck
// can be locked down as a reader as tightly as the local fixture. Ely runs it;
// every test here injects a fake reader, a fake token and a stub Keychain, so
// no test reaches MotherDuck, the network or a real secret. The local DuckDB
// tests run the probe's own statements on an in-memory DuckDB (with the
// minimal engine fixture, never a client's) to prove the statements are real
// and the lockdown is what refuses them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const probe = require('../../kit/fixture/md-probe');
const { build } = require('../../kit/fixture/build');

const TOKEN = 'md-fake-read-token-41c9e2'; // not a real token: tests only
const PUBLISH = 'md-fake-publish-token-9b07aa'; // not a real token: tests only
const DB = 'acme_fixture';
const MINI = path.join(__dirname, '..', 'fixtures', 'fixture-build', 'mini');
const FIXTURE_DIR = 'test/fixtures/fixture-build/mini';
const ARGS = [FIXTURE_DIR, '--database', DB];

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-md-probe-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- A fake MotherDuck reader ---------------------------------------------------

const REFUSED = new Error(`Permission Error: refused for ${TOKEN}\nsecond line ${TOKEN}`);
const SETTINGS = {
  autoinstall: 'false', autoload: 'false', external_access: 'false', locked: 'true', current_db: DB,
  db_readonly: 'true', duckdb: probe.pinnedDuckdb(),
};
const EXTENSION_ROW = { installed: 'true', loaded: 'true', version: 'v1.5.6-fake', duckdb: probe.pinnedDuckdb() };

// A well-locked reader. over: [[test(sql), (sql, ctx) => rows | throws]] tried
// first; settings: fields that differ. calls records every statement.
function fakeMotherDuck({ over = [], settings = {}, extension = {}, published = '2026-10-24T10:00:00.000Z' } = {}) {
  const calls = [];
  const state = { opened: 0, closed: 0 };
  const rules = [
    ...over,
    [(s) => s.startsWith('SELECT\n  current_setting'), () => [{ ...SETTINGS, ...settings }]],
    [(s) => s.startsWith('SELECT table_name FROM duckdb_tables()'), () => [{ table_name: 'fixture_publish' }, { table_name: 'regions' }]],
    [(s) => /^SELECT count\(\*\)::VARCHAR AS n FROM "fixture_publish"$/.test(s), () => [{ n: '4' }]],
    [(s) => s === 'BEGIN TRANSACTION' || s === 'ROLLBACK', () => []],
    [(s) => probe.LOOSEN.includes(s), () => { throw new Error('Invalid Input Error: the configuration has been locked'); }],
    [(s) => s.startsWith('SELECT database_name FROM duckdb_databases()'), () => [{ database_name: DB }, { database_name: 'md_information_schema' }, { database_name: 'memory' }]],
    [(s) => s.startsWith('SELECT count(*)::VARCHAR AS n FROM duckdb_databases()'), () => [{ n: '1' }]],
    [(s) => s.startsWith('SELECT table_name FROM information_schema.tables'), () => [{ table_name: 'fixture_publish' }, { table_name: 'regions' }]],
    [(s) => /^SELECT count\(\*\)::VARCHAR AS n FROM "acme_fixture"\.main\."regions"$/.test(s), () => [{ n: '2' }]],
    [(s) => s.startsWith('SELECT key, value FROM "acme_fixture".main.fixture_publish'), () => [
      { key: 'fixture_version', value: '3+abc' }, { key: 'published_at', value: published },
    ]],
    [(s) => s === probe.SLOW_SQL, (s, ctx) => new Promise((resolve, reject) => { ctx.onInterrupt = () => reject(new Error('INTERRUPT Error: Interrupted!')); })],
    [() => true, () => { throw REFUSED; }], // every forbidden operation
  ];
  const makeConn = () => {
    const ctx = { onInterrupt: null };
    return {
      async run(sql) {
        calls.push(sql);
        for (const [match, act] of rules) if (match(sql)) return act(sql, ctx);
        throw new Error('unreachable');
      },
      interrupt() { if (ctx.onInterrupt) ctx.onInterrupt(); },
      close() { state.closed += 1; },
    };
  };
  const openReader = async (opts) => {
    state.opened += 1;
    state.opts = opts;
    return { ...makeConn(), captured: { extension: { ...EXTENSION_ROW, ...extension } }, connect: async () => makeConn() };
  };
  return { openReader, calls, state };
}

const PATH_FORM_ERROR = 'Permission Error: Loading external extensions is disabled through configuration';

// main with every outside effect injected. Returns { code, out, err, all }.
async function runMain(argv = ARGS, deps = {}) {
  const out = [];
  const err = [];
  const md = deps.md || fakeMotherDuck();
  const code = await probe.main(argv, {
    platform: 'linux',
    open: md.openReader,
    openPath: async () => { throw new Error(PATH_FORM_ERROR); },
    inspect: async () => ({ installed: 'true', loaded: 'false', version: 'v1.5.6-fake', duckdb: probe.pinnedDuckdb() }),
    readLocal: async () => null,
    install: async () => { throw new Error('not in tests'); },
    slow: { limitMs: 20, graceMs: 2000 },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ...deps,
    // rawEnv: the very object main reads (and scrubs); else the defaults plus env.
    env: deps.rawEnv || { APLABS_NO_KEYCHAIN: '1', [probe.READ_TOKEN_ENV]: TOKEN, MOTHERDUCK_TOKEN: PUBLISH, ...deps.env },
  });
  return { code, out, err, all: [...out, ...err].join('\n'), md };
}

const lineFor = (all, status, id) => all.split('\n').filter((l) => l.startsWith(`${status.padEnd(4)}  ${id}  `));

// --- Check logic, output and exit codes ------------------------------------------

test('a well-locked reader passes every required check and exits 0', async () => {
  const { code, all, md } = await runMain();
  assert.equal(code, 0, all);
  for (const id of probe.REQUIRED) assert.ok(lineFor(all, 'PASS', id).length, `check ${id} passes:\n${all}`);
  for (const id of [3, 8, 9]) assert.equal(lineFor(all, 'INFO', id).length, 1, `check ${id} is INFO`);
  assert.equal(lineFor(all, 'FAIL', '\\d').length, 0);
  assert.equal(lineFor(all, 'PASS', 5).length, probe.forbiddenOps({ database: DB, tmp: '/t', url: 'http://x' }).length, 'one line per forbidden operation');
  assert.match(all, /all 6 required checks passed/);
  assert.match(lineFor(all, 'INFO', 3)[0], /attach_mode=single&saas_mode=true with enable_external_access=false at startup: it fails \(Permission Error: Loading external extensions/);
  assert.match(lineFor(all, 'INFO', 3)[0], /enable_external_access is false, and MotherDuck still reads/);
  assert.match(lineFor(all, 'PASS', 2)[0], /a new connection after USE: it sees 2 tables; fixture_publish has 4 rows/);
  assert.match(lineFor(all, 'INFO', 9)[0], /version 3\+abc, published 2026-10-24T10:00:00.000Z/);
  assert.deepEqual(md.state.opts, { database: DB, token: TOKEN }, 'the default database, the read token');
  assert.equal(md.calls.filter((s) => s === probe.SLOW_SQL).length, 1);
  // Writes are only ever attempted inside a transaction that is rolled back.
  const writes = md.calls.map((s, i) => [s, i]).filter(([s]) => /^(CREATE|INSERT)/.test(s));
  assert.equal(writes.length, 2);
  for (const [, i] of writes) {
    assert.equal(md.calls[i - 1], 'BEGIN TRANSACTION');
    assert.equal(md.calls[i + 1], 'ROLLBACK');
  }
});

test('a forbidden operation that runs fails check 5 and the probe exits 1', async () => {
  const md = fakeMotherDuck({ over: [[(s) => s.startsWith('COPY'), () => []]] });
  const { code, all } = await runMain(undefined, { md });
  assert.equal(code, 1);
  assert.match(lineFor(all, 'FAIL', 5).join('\n'), /COPY to a local file \(it ran: NOT refused\)/);
  assert.match(all, /failed: 5\. Stop: do not start Story B/);
});

test('a parser error or a missing table is not counted as a refusal', async () => {
  const md = fakeMotherDuck({
    over: [
      [(s) => s.startsWith('INSTALL'), () => { throw new Error('Parser Error: syntax error'); }],
      [(s) => s.startsWith('INSERT'), () => { throw new Error('Catalog Error: Table fixture_publish does not exist'); }],
    ],
  });
  const { code, all } = await runMain(undefined, { md });
  assert.equal(code, 1);
  const fails = lineFor(all, 'FAIL', 5).join('\n');
  assert.match(fails, /INSTALL httpfs \(the statement did not parse/);
  assert.match(fails, /INSERT INTO acme_fixture\.fixture_publish \(inconclusive/);
});

test('an extra attached database fails check 5', async () => {
  const md = fakeMotherDuck({ over: [[(s) => s.startsWith('SELECT database_name FROM duckdb_databases()'), () => [{ database_name: DB }, { database_name: 'my_db' }, { database_name: 'memory' }]]] });
  const { code, all } = await runMain(undefined, { md });
  assert.equal(code, 1);
  assert.match(lineFor(all, 'FAIL', 5)[0], /also attached: my_db/);
});

test('an http read that reaches the local listener fails, even if it then errors', async () => {
  const md = fakeMotherDuck({
    over: [[(s) => /read_csv\('http:/.test(s), async (s) => {
      await fetch(s.match(/'(http:[^']+)'/)[1]);
      throw new Error('IO Error: bad csv');
    }]],
  });
  const { code, all } = await runMain(undefined, { md });
  assert.equal(code, 1);
  assert.match(lineFor(all, 'FAIL', 5)[0], /read_csv on an http URL \(IO Error: bad csv; the local listener had 1 hits\)/);
});

test('settings that loosen after the SETs, or a lock that is off, fail check 4', async () => {
  const md = fakeMotherDuck({ settings: { locked: 'false' } });
  const { code, all } = await runMain(undefined, { md });
  assert.equal(code, 1);
  assert.match(lineFor(all, 'FAIL', 4)[0], /settings now lock false/);
  const ran = fakeMotherDuck({ over: [[(s) => s === 'SET enable_external_access = true', () => []]] });
  const second = await runMain(undefined, { md: ran });
  assert.match(lineFor(second.all, 'FAIL', 4)[0], /SET enable_external_access = true ran/);
});

test('a slow query that is not interrupted fails check 6', async () => {
  const md = fakeMotherDuck({ over: [[(s) => s === probe.SLOW_SQL, () => [{ n: '1' }]]] });
  const { code, all } = await runMain(undefined, { md });
  assert.equal(code, 1);
  assert.match(lineFor(all, 'FAIL', 6)[0], /finished .* instead of being interrupted/);
});

test('a slow query still running after the grace period fails 6 and leaves the rest not run', async () => {
  const md = fakeMotherDuck({ over: [[(s) => s === probe.SLOW_SQL, () => new Promise(() => {})]] });
  const { code, all } = await runMain(undefined, { md, slow: { limitMs: 5, graceMs: 30 } });
  assert.equal(code, 1);
  assert.match(lineFor(all, 'FAIL', 6)[0], /still running/);
  assert.match(lineFor(all, 'FAIL', 7)[0], /not run/);
  assert.equal(md.state.closed, 1, 'only the second connection was closed: closing the busy one would wait on it');
});

test('a DuckDB version other than the pin, or an unloaded extension, fails check 7', async () => {
  const md = fakeMotherDuck({ settings: { duckdb: 'v1.4.0' } });
  const { code, all } = await runMain(undefined, { md });
  assert.equal(code, 1);
  assert.match(lineFor(all, 'FAIL', 7)[0], /DuckDB v1\.4\.0 \(pinned v\d.*extension v1\.5\.6-fake, loaded true/);
  const unloaded = await runMain(undefined, { md: fakeMotherDuck({ extension: { loaded: 'false' } }) });
  assert.match(lineFor(unloaded.all, 'FAIL', 7)[0], /loaded false/);
  assert.match(lineFor(unloaded.all, 'FAIL', 1)[0], /loaded by LOAD motherduck: false/);
});

test('check 9 compares the read copy with the local build', async () => {
  const now = () => new Date('2026-10-24T10:00:30.000Z');
  const match = await runMain(undefined, { readLocal: async () => ({ version: '3+abc' }), now });
  assert.match(lineFor(match.all, 'INFO', 9)[0], /\(30 s ago\); it matches the local build, so the lag was at most 30 s/);
  const behind = await runMain(undefined, { readLocal: async () => ({ version: '4+def' }), now });
  assert.match(lineFor(behind.all, 'INFO', 9)[0], /the local build is 4\+def, so the read copy is behind/);
  assert.equal(behind.code, 0, 'a lag is a finding, not a failure');
});

test('a missing extension fails check 1 with the install step, before any connection', async () => {
  const md = fakeMotherDuck();
  const { code, all } = await runMain(undefined, { md, inspect: async () => ({ installed: 'false', loaded: 'false', duckdb: 'v1.5.6' }) });
  assert.equal(code, 1);
  assert.match(lineFor(all, 'FAIL', 1)[0], /not installed .* npm run fixture:probe -- --install/);
  assert.equal(md.state.opened, 0);
  for (const id of [2, 4, 5, 6, 7]) assert.match(lineFor(all, 'FAIL', id)[0], /not run/);
  for (const id of [3, 8, 9]) assert.match(lineFor(all, 'INFO', id)[0], /not run/);
});

test('an extension auto-loaded by a plain local DuckDB fails check 1', async () => {
  const { code, all } = await runMain(undefined, { inspect: async () => ({ installed: 'true', loaded: 'true', version: 'v1' }) });
  assert.equal(code, 1);
  assert.match(lineFor(all, 'FAIL', 1)[0], /loaded by a plain local DuckDB: true/);
});

test('a reader that does not open fails 2, redacted and first line only', async () => {
  const md = {
    openReader: async () => { throw new Error(`SET motherduck_token: Invalid token ${TOKEN}\nstack ${TOKEN}`); },
  };
  const { code, all } = await runMain(undefined, { md });
  assert.equal(code, 1);
  assert.match(lineFor(all, 'FAIL', 2)[0], /the reader did not open: SET motherduck_token: Invalid token \[redacted\]$/);
  assert.ok(!all.includes(TOKEN));
  assert.ok(!all.includes('stack'));
});

// --- Tokens -------------------------------------------------------------------------

test('no token ever appears in the output, including in MotherDuck errors', async () => {
  const { all } = await runMain();
  assert.match(all, /refused: COPY to a local file \(Permission Error: refused for \[redacted\]\)/);
  assert.ok(!all.includes(TOKEN));
  assert.ok(!all.includes(PUBLISH));
  assert.ok(!all.includes('second line'), 'errors are first line only');
});

test('a missing read token is refused before anything opens', async () => {
  const md = fakeMotherDuck();
  const { code, err } = await runMain(undefined, { md, env: { [probe.READ_TOKEN_ENV]: '' } });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /no MotherDuck read token[\s\S]*MOTHERDUCK_READ_TOKEN[\s\S]*aplabs-motherduck-read-token/);
  assert.equal(md.state.opened, 0);
});

test('a read token equal to the publish token is refused and never printed', async () => {
  const md = fakeMotherDuck();
  const { code, all } = await runMain(undefined, { md, env: { MOTHERDUCK_TOKEN: TOKEN } });
  assert.equal(code, 1);
  assert.match(all, /the read token is the publish token/);
  assert.ok(!all.includes(TOKEN));
  assert.equal(md.state.opened, 0);
});

test('tokens come from the Keychain items when the env is empty, and the same-token refusal holds there too', async () => {
  const asked = [];
  const keychain = (items) => (service) => { asked.push(service); return items[service] ?? null; };
  const env = { [probe.READ_TOKEN_ENV]: '', MOTHERDUCK_TOKEN: '', APLABS_NO_KEYCHAIN: '' };
  const ok = await runMain(undefined, {
    env, platform: 'darwin',
    readKeychain: keychain({ 'aplabs-motherduck-read-token': `${TOKEN}\n`, 'aplabs-motherduck-token': PUBLISH }),
  });
  assert.equal(ok.code, 0, ok.all);
  assert.deepEqual(asked, ['aplabs-motherduck-read-token', 'aplabs-motherduck-token']);
  assert.equal(ok.md.state.opts.token, TOKEN, 'trimmed');
  assert.match(ok.all, /token from the Keychain \(aplabs-motherduck-read-token\)/);
  const same = await runMain(undefined, {
    env, platform: 'darwin',
    readKeychain: keychain({ 'aplabs-motherduck-read-token': TOKEN, 'aplabs-motherduck-token': TOKEN }),
  });
  assert.equal(same.code, 1);
  assert.equal(same.md.state.opened, 0);
});

test('both MotherDuck token env vars are removed before connecting', async () => {
  const env = { APLABS_NO_KEYCHAIN: '1', [probe.READ_TOKEN_ENV]: TOKEN, MOTHERDUCK_TOKEN: PUBLISH, motherduck_token: PUBLISH };
  let seen;
  const md = fakeMotherDuck();
  const open = md.openReader;
  md.openReader = async (opts) => { seen = { ...env }; return open(opts); };
  const { code, all } = await runMain(undefined, { md, rawEnv: env });
  assert.equal(code, 0, all);
  assert.equal(seen.MOTHERDUCK_TOKEN, undefined);
  assert.equal(seen.motherduck_token, undefined);
  assert.equal(seen[probe.READ_TOKEN_ENV], TOKEN);
});

test('reportUncaught masks every token read in this process', async () => {
  await runMain();
  const lines = [];
  assert.equal(probe.reportUncaught(new Error(`boom ${TOKEN} ${PUBLISH}`), { err: (s) => lines.push(s) }), 1);
  assert.ok(!lines.join('\n').includes(TOKEN));
  assert.ok(!lines.join('\n').includes(PUBLISH));
  assert.match(lines[0], /boom \[redacted\] \[redacted\]/);
});

test('the token is passed as a setting, never in a path or a step label', () => {
  const tricky = "tok'en";
  const steps = probe.readerSteps(DB, tricky);
  assert.deepEqual(steps.map((s) => s.label), [
    'LOAD motherduck', 'SET motherduck_token', "ATTACH 'md:acme_fixture' AS acme_fixture (READ_ONLY)",
    "read the motherduck extension's version", 'SET enable_external_access = false', 'SET lock_configuration = true',
  ]);
  assert.equal(steps[1].sql, "SET motherduck_token = 'tok''en'");
  assert.ok(steps.every((s, i) => i === 1 || !s.sql.includes(tricky)));
  assert.equal(probe.useStatement(DB), 'USE "acme_fixture"');
  assert.ok(!probe.pathForm(DB).includes(tricky));
  assert.deepEqual(probe.pathFormOptions(tricky), {
    autoinstall_known_extensions: 'false', autoload_known_extensions: 'false', access_mode: 'READ_ONLY',
    enable_external_access: 'false', motherduck_token: tricky,
  });
});

// --- Arguments ------------------------------------------------------------------------

test('usage errors and bad database names exit 2; --install runs only the install', async () => {
  assert.equal((await runMain([])).code, 2);
  const byDefault = fakeMotherDuck();
  await runMain([FIXTURE_DIR], { md: byDefault });
  assert.equal(byDefault.state.opts.database, probe.DEFAULT_DATABASE);
  assert.equal((await runMain([FIXTURE_DIR, '--nope'])).code, 2);
  for (const bad of ['Bad-Name', 'my_db', 'x__publishing']) {
    const r = await runMain([FIXTURE_DIR, '--database', bad]);
    assert.equal(r.code, 2, bad);
    assert.match(r.err.join('\n'), /--database/);
  }
  const md = fakeMotherDuck();
  const other = await runMain([FIXTURE_DIR, '--database', 'other_fixture'], { md });
  assert.equal(md.state.opts.database, 'other_fixture');
  assert.match(other.all, /probing md:other_fixture/);
  const installed = await runMain([FIXTURE_DIR, '--install'], { md: fakeMotherDuck(), install: async () => ({ version: 'v9', duckdb: 'v1.5.6' }) });
  assert.equal(installed.code, 0);
  assert.match(installed.all, /motherduck extension is installed \(v9\)/);
  assert.equal((await runMain(['--help'])).code, 0);
});

// --- The probe's statements on a local DuckDB -------------------------------------------

// The mini fixture built into a file, plus a fixture_publish table, as the
// read-only database the probe attaches.
async function localTarget(t) {
  const dir = tmpDir(t);
  const file = path.join(dir, 'target.duckdb');
  await build({ fixtureDir: MINI, out: file, stamp: false });
  const rw = await probe.openLocked({ steps: [{ label: 'attach', sql: `ATTACH '${file}' AS t` }] });
  await rw.run("CREATE TABLE t.main.fixture_publish (key VARCHAR, value VARCHAR); INSERT INTO t.main.fixture_publish VALUES ('fixture_version', '1')");
  rw.close();
  fs.writeFileSync(path.join(dir, probe.READ_FILE), 'n\n1\n');
  return { dir, file };
}

test('locally, the reader lockdown refuses every forbidden operation, with no http request', async (t) => {
  const { dir, file } = await localTarget(t);
  const listener = await probe.startListener();
  t.after(() => listener.close());
  const conn = await probe.openLocked({
    steps: [{ label: 'attach', sql: `ATTACH '${file}' AS ${DB} (READ_ONLY)` }, probe.EXTENSION_STEP, ...probe.LOCK_STEPS],
    use: probe.useStatement(DB),
  });
  t.after(() => conn.close());
  // Read before the lock: once external access is off, duckdb_extensions() is refused.
  assert.equal(conn.captured.extension.duckdb, probe.pinnedDuckdb());
  await assert.rejects(conn.run(probe.EXTENSION_STEP.sql), /Permission Error/);

  const settings = (await conn.run(probe.settingsSql(DB)))[0];
  assert.equal(settings.locked, 'true');
  assert.equal(settings.external_access, 'false');
  assert.equal(settings.current_db, DB);
  assert.equal(settings.db_readonly, 'true');
  assert.equal(settings.duckdb, probe.pinnedDuckdb(), 'the pin in package.json is the DuckDB the bindings run');
  for (const sql of probe.LOOSEN) await assert.rejects(conn.run(sql), /locked/, sql);

  for (const op of probe.forbiddenOps({ database: DB, tmp: dir, url: listener.url })) {
    const r = await probe.attempt(conn, op, { database: DB, listener });
    assert.ok(r.ok, `${op.label}: ${r.evidence}`);
  }
  assert.equal(listener.hits(), 0);
  assert.ok(!fs.existsSync(path.join(dir, 'probe-copy.csv')));
  assert.ok(!fs.existsSync(path.join(dir, 'probe-attach.duckdb')));

  const second = await conn.connect();
  const seen = await probe.seesTables(second);
  assert.ok(seen.ok, seen.evidence);
  assert.match(seen.evidence, /sees 4 tables; fixture_publish has 1 rows/);
  second.close();

  const slow = await probe.slowQuery(conn, { limitMs: 100, graceMs: 10000 });
  assert.ok(slow.ok, slow.evidence);
});

test('locally and unlocked, every statement the suite checks runs: only the lockdown refuses them', async (t) => {
  const { dir } = await localTarget(t);
  const conn = await probe.openLocked({
    steps: ['acme_fixture', 'my_db', 'sample_data'].map((n) => ({ label: n, sql: `ATTACH ':memory:' AS ${n}` }))
      .concat([{ label: 'table', sql: 'CREATE TABLE acme_fixture.main.fixture_publish (key VARCHAR, value VARCHAR)' }]),
  });
  t.after(() => conn.close());
  const ops = probe.forbiddenOps({ database: DB, tmp: dir, url: 'http://127.0.0.1:9/x' }).filter((op) => op.localCheck);
  assert.equal(ops.length, 5);
  for (const op of ops) {
    if (op.write) await conn.run('BEGIN TRANSACTION');
    await conn.run(op.sql);
    if (op.write) await conn.run('ROLLBACK');
  }
  assert.ok(fs.existsSync(path.join(dir, 'probe-copy.csv')), 'COPY really wrote unlocked');
  // A reachable my_db or sample_data is caught, not taken for a refusal.
  for (const op of probe.forbiddenOps({ database: DB, tmp: dir, url: 'http://127.0.0.1:9/x' }).filter((o) => o.absentDb)) {
    const r = await probe.attempt(conn, op, { database: DB });
    assert.ok(!r.ok, `${op.label}: ${r.evidence}`);
    assert.match(r.evidence, /not shown to be out of reach/);
  }
});

test('a plain local DuckDB with auto-load off reports the extension without loading it', async () => {
  const c = await probe.openLocked();
  try {
    const rows = await c.run("SELECT current_setting('autoload_known_extensions')::VARCHAR AS a, current_setting('autoinstall_known_extensions')::VARCHAR AS i, (SELECT loaded::VARCHAR FROM duckdb_extensions() WHERE extension_name = 'motherduck') AS loaded");
    assert.deepEqual(rows, [{ a: 'false', i: 'false', loaded: rows[0].loaded }]);
    assert.notEqual(rows[0].loaded, 'true');
  } finally {
    c.close();
  }
});
