'use strict';

// The MotherDuck lockdown probe (plan motherduck-read, Story A). Run by Ely
// only; no test opens MotherDuck (they inject a fake reader).
//
//   npm run fixture:probe                    probe brightside_fixture as the reader
//   npm run fixture:probe -- --install       install the motherduck extension ahead of time
//   node kit/fixture/md-probe.js <fixture-dir> [--database <name>] [--db <file>] [--name <client>] [--install]
//
// It opens MotherDuck as a READER the way Story B's runtime will, and prints
// one PASS / FAIL / INFO line per check (ACCEPTED for the one known
// exception Ely accepted, which does not fail the run), then a summary. Exit
// codes: 0 every
// required check passed; 1 a required check failed, or the probe refused to
// start (no read token, or it is the publish token); 2 usage, a bad
// --database or a profile error.
//
// The reader connection (the sequence Story B uses):
//   1. an in-memory DuckDB with extension auto-install and auto-load off;
//   2. LOAD motherduck (installed ahead of time: --install, or the container
//      build), SET motherduck_token (the token is a setting, never in a path),
//      SET motherduck_attach_mode = 'single' (it narrows what can be attached),
//      ATTACH 'md:<db>' AS <db> (READ_ONLY), SET enable_external_access =
//      false, SET lock_configuration = true;
//   3. every new connection runs USE <db>.
// The plan's first form, md:<db>?attach_mode=single&saas_mode=true with
// enable_external_access=false, cannot work: DuckDB loads the extension for
// an md: path while the instance starts, and with external access off that
// load is refused ("Loading external extensions is disabled through
// configuration"; checked offline with @duckdb/node-api 1.5.6-r.2 and live by
// the Orchestrator). Check 3 shows both.
//
// The read token: MOTHERDUCK_READ_TOKEN, else the Keychain item
// aplabs-motherduck-read-token (kit/lib/secrets). It and the publish token
// (read only to compare) are registered with a redactor before anything
// connects, so every line printed, MotherDuck's errors included, has them
// masked. Both MotherDuck token env vars are then removed from this process's
// environment, so the extension can only use the token it is given.
//
// This is the only reader of MotherDuck in the repo, and the app never loads
// it. It imports @duckdb/node-api, so it is on the runtime's allow-list
// (kit/runtime/data/index.js).

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DuckDBInstance } = require('@duckdb/node-api');
const { readSecret } = require('../lib/secrets');
const { createLog } = require('../runtime/log');
const remote = require('./remote');
const { defaultOut, governingClientId } = require('./build');
const { parseArgs: parsePublishArgs } = require('./publish');

const READ_TOKEN_ENV = 'MOTHERDUCK_READ_TOKEN';
const READ_TOKEN_KEYCHAIN = 'aplabs-motherduck-read-token';
const DEFAULT_DATABASE = 'brightside_fixture';
const DOC = 'docs/runtime/motherduck-publish.md';
const EXTENSION = 'motherduck';
const USAGE = 'usage: node kit/fixture/md-probe.js <fixture-dir> [--database <name>] [--db <file>] [--name <client>] [--install]';
const READ_TOKEN_HELP = [
  'no MotherDuck read token. Set it one of two ways:',
  `  export ${READ_TOKEN_ENV}=...    (this shell only)`,
  `  security add-generic-password -s ${READ_TOKEN_KEYCHAIN} -a aplabs -w    (macOS Keychain; prompts for it)`,
  `It is the read-only service account's read-scaling token, never the publish token. See ${DOC}.`,
].join('\n');
const SAME_TOKEN = `refusing to probe: the read token is the publish token (${remote.TOKEN_ENV} / ${remote.TOKEN_KEYCHAIN}). Make a read-scaling token for the read-only service account and store it as ${READ_TOKEN_ENV} / ${READ_TOKEN_KEYCHAIN}. See ${DOC}.`;

// Checks whose failure stops the plan. 3, 8 and 9 are findings (INFO).
const REQUIRED = Object.freeze([1, 2, 4, 5, 6, 7]);
const TOTAL = 9;

// Besides <db>: the attached databases a reader may see. memory is the
// instance's own in-memory database; system and temp are internal.
const ALSO_ATTACHED = Object.freeze(['md_information_schema', 'memory']);

// How long the slow query may run before it is interrupted, and how long
// after that it must have stopped.
const SLOW_LIMIT_MS = 2000;
const SLOW_GRACE_MS = 10000;
// Finite, so a broken interrupt can't run forever, but far longer than the limit.
const SLOW_SQL = 'SELECT count(*)::VARCHAR AS n FROM range(1000000000000) a';

// The pinned DuckDB, from this repo's package.json (1.5.6-r.2 -> v1.5.6).
function pinnedDuckdb() {
  const pin = require('../../package.json').dependencies['@duckdb/node-api'];
  return `v${String(pin).split('-')[0]}`;
}

// The instance options: nothing installed or loaded behind our back.
const INSTANCE_OPTIONS = Object.freeze({
  autoinstall_known_extensions: 'false',
  autoload_known_extensions: 'false',
});

// After the database is attached, in this order; the lock comes last.
const LOCK_STEPS = Object.freeze([
  Object.freeze({ label: 'SET enable_external_access = false', sql: 'SET enable_external_access = false' }),
  Object.freeze({ label: 'SET lock_configuration = true', sql: 'SET lock_configuration = true' }),
]);

// duckdb_extensions() lists the extension directory, which external access
// off refuses ("Cannot access directory"), so the extension is read before
// the lock. Its row is kept as captured.extension.
const EXTENSION_SQL = `SELECT installed::VARCHAR AS installed, loaded::VARCHAR AS loaded, extension_version AS version, version() AS duckdb FROM duckdb_extensions() WHERE extension_name = '${EXTENSION}'`;
const EXTENSION_STEP = Object.freeze({ label: `read the ${EXTENSION} extension's version`, sql: EXTENSION_SQL, capture: 'extension' });

// Set before ATTACH. Live (2026-10-24) it refuses ATTACH 'md:' and
// 'md:sample_data' after the lock, but not 'md:my_db'; see MY_DB_EXCEPTION.
const ATTACH_MODE_SQL = "SET motherduck_attach_mode = 'single'";

// The known exception Ely accepted on 2026-10-24: under the reader sequence
// the reader's own my_db can still be attached after the lock (neither
// motherduck_attach_mode nor saas_mode stops it, and DROP DATABASE my_db is
// refused). The barrier is the SQL checker (kit/runtime/sql), which refuses
// ATTACH, writes and multiple statements. Reported as ACCEPTED, never PASS.
const MY_DB_EXCEPTION = `the reader's own my_db can be attached; the SQL checker refuses ATTACH (accepted by Ely, 2026-10-24, see ${DOC})`;

// The reader's setup, in order. A label never holds the token.
function readerSteps(database, token) {
  return [
    { label: `LOAD ${EXTENSION}`, sql: `LOAD ${EXTENSION}` },
    { label: 'SET motherduck_token', sql: `SET motherduck_token = ${remote.sqlString(token)}` },
    { label: ATTACH_MODE_SQL, sql: ATTACH_MODE_SQL },
    { label: `ATTACH 'md:${database}' AS ${database} (READ_ONLY)`, sql: `ATTACH ${remote.sqlString(`md:${database}`)} AS ${remote.ident(database)} (READ_ONLY)` },
    EXTENSION_STEP,
    ...LOCK_STEPS,
  ];
}

const useStatement = (database) => `USE ${remote.ident(database)}`;

// The plan's first form, kept only for check 3.
const pathForm = (database) => `md:${database}?attach_mode=single&saas_mode=true`;
const pathFormOptions = (token) => ({
  ...INSTANCE_OPTIONS, access_mode: 'READ_ONLY', enable_external_access: 'false', motherduck_token: token,
});

const settingsSql = (database) => [
  'SELECT',
  "  current_setting('autoinstall_known_extensions')::VARCHAR AS autoinstall,",
  "  current_setting('autoload_known_extensions')::VARCHAR AS autoload,",
  "  current_setting('enable_external_access')::VARCHAR AS external_access,",
  "  current_setting('lock_configuration')::VARCHAR AS locked,",
  '  current_database() AS current_db,',
  `  (SELECT readonly::VARCHAR FROM duckdb_databases() WHERE database_name = ${remote.sqlString(database)}) AS db_readonly,`,
  '  version() AS duckdb',
].join('\n');

// What a new connection sees after USE: its tables, and an unqualified read.
const TABLES_SQL = "SELECT table_name FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main' ORDER BY table_name";

// Check 4: each must be refused once the configuration is locked.
const LOOSEN = Object.freeze([
  'SET lock_configuration = false',
  'SET enable_external_access = true',
  'SET autoload_known_extensions = true',
  'SET autoinstall_known_extensions = true',
]);

// Check 5: each must be refused. A refusal is an error, but a parser error
// never counts (the statement was wrong, not refused), nor a catalog error
// where needsCatalog (the write never reached a real table). absentDb: the
// read names a table that does not exist, so only "Catalog "<absentDb>" does
// not exist" or a Permission Error proves the database is out of reach (a
// missing-table error means it is reachable). write: run
// inside a transaction that is always rolled back. http: the local listener
// must also have had no request. permissionOnly: a local-file operation on a
// file that exists (prepareScratch makes them), so only a Permission Error
// (file system operations disabled) is a refusal; "not found" or any other
// error proves nothing and is a FAIL. detach: an ATTACH that ran is detached
// again at once. accepted: that ATTACH running is the accepted exception
// (MY_DB_EXCEPTION), reported ACCEPTED rather than FAIL. kind 'attached':
// passes when only <db> and ALSO_ATTACHED are attached; it runs first, before
// any ATTACH is tried. localCheck: the test suite proves the statement
// runs on an unlocked local DuckDB, so only the lockdown can refuse it.
function forbiddenOps({ database, tmp, url }) {
  const db = remote.ident(database);
  const file = (name) => remote.sqlString(path.join(tmp, name));
  return [
    {
      label: `only ${database}, ${ALSO_ATTACHED.join(' and ')} are attached`,
      sql: 'SELECT database_name FROM duckdb_databases() WHERE NOT internal ORDER BY 1',
      kind: 'attached',
    },
    { label: 'ATTACH a local database file', sql: `ATTACH ${file(ATTACH_FILE)} AS aplabs_probe_attach`, detach: 'aplabs_probe_attach', permissionOnly: true, localCheck: true },
    { label: 'ATTACH the MotherDuck database sample_data', sql: "ATTACH 'md:sample_data' AS aplabs_probe_md", detach: 'aplabs_probe_md' },
    { label: "ATTACH the reader's own MotherDuck database my_db", sql: "ATTACH 'md:my_db' AS aplabs_probe_my_db", detach: 'aplabs_probe_my_db', accepted: MY_DB_EXCEPTION },
    { label: 'COPY to a local file', sql: `COPY (SELECT 1 AS n) TO ${file('probe-copy.csv')}`, permissionOnly: true, localCheck: true },
    { label: 'read_csv on a local file', sql: `SELECT count(*)::VARCHAR AS n FROM read_csv(${file(READ_FILE)})`, permissionOnly: true, localCheck: true },
    { label: 'read_csv on an http URL', sql: `SELECT count(*)::VARCHAR AS n FROM read_csv(${remote.sqlString(url)})`, http: true },
    { label: 'INSTALL httpfs', sql: 'INSTALL httpfs' },
    { label: 'LOAD httpfs', sql: 'LOAD httpfs' },
    { label: `CREATE TABLE in ${database}`, sql: `CREATE TABLE ${db}.main.aplabs_probe_write AS SELECT 1 AS n`, write: true, localCheck: true },
    { label: `INSERT INTO ${database}.${remote.PUBLISH_TABLE}`, sql: `INSERT INTO ${db}.main.${remote.PUBLISH_TABLE} (key, value) VALUES ('aplabs_probe', 'x')`, write: true, needsCatalog: true, localCheck: true },
    { label: 'read the default database my_db', sql: 'SELECT count(*)::VARCHAR AS n FROM my_db.main.aplabs_probe_absent', absentDb: 'my_db' },
    { label: 'read the sample_data database', sql: 'SELECT count(*)::VARCHAR AS n FROM sample_data.main.aplabs_probe_absent', absentDb: 'sample_data' },
  ];
}

// The file read_csv is pointed at: it exists, so only the lockdown can refuse it.
const READ_FILE = 'probe-read.csv';
// The DuckDB file ATTACH is pointed at: it exists too (prepareScratch).
const ATTACH_FILE = 'probe-attach.duckdb';

const firstLine = remote.firstLine;
const errText = (e) => firstLine(e?.message ?? e);

// One forbidden operation. listener: { hits() } for http ops. Returns
// { ok, accepted, evidence }: accepted is true only for the accepted
// exception, which then has ok false.
async function attempt(conn, op, { database, listener } = {}) {
  if (op.kind === 'attached') {
    try {
      const names = (await conn.run(op.sql)).map((r) => r.database_name);
      const extra = names.filter((n) => n !== database && !ALSO_ATTACHED.includes(n));
      if (extra.length) return { ok: false, evidence: `also attached: ${extra.join(', ')}` };
      if (!names.includes(database)) return { ok: false, evidence: `${database} is not attached (${names.join(', ') || 'none'})` };
      return { ok: true, evidence: names.join(', ') };
    } catch (e) {
      return { ok: false, evidence: `could not list databases: ${errText(e)}` };
    }
  }
  if (op.write) {
    try {
      await conn.run('BEGIN TRANSACTION');
    } catch (e) {
      return { ok: false, evidence: `not attempted: no transaction to roll it back in (${errText(e)})` };
    }
  }
  const before = op.http ? listener.hits() : 0;
  let outcome;
  try {
    await conn.run(op.sql);
    outcome = op.accepted ? { ok: false, accepted: true, evidence: op.accepted } : { ok: false, evidence: 'it ran: NOT refused' };
    if (op.detach) {
      try {
        await conn.run(`DETACH ${remote.ident(op.detach)}`);
        outcome.evidence += '; detached again';
      } catch (e) {
        outcome.evidence += `; DETACH failed (${errText(e)})`;
      }
    }
  } catch (e) {
    const msg = errText(e);
    if (/^Parser Error/i.test(msg)) outcome = { ok: false, evidence: `the statement did not parse, so nothing was proved: ${msg}` };
    else if (op.permissionOnly && !/^Permission Error/i.test(msg)) outcome = { ok: false, evidence: `not shown to be refused by the lockdown (only a Permission Error is): ${msg}` };
    else if (op.needsCatalog && /^Catalog Error/i.test(msg)) outcome = { ok: false, evidence: `inconclusive, the table was not found: ${msg}` };
    else if (op.absentDb && !msg.includes(`Catalog "${op.absentDb}" does not exist`) && !/^Permission Error/i.test(msg)) outcome = { ok: false, evidence: `not shown to be out of reach: ${msg}` };
    else outcome = { ok: true, evidence: msg };
  }
  if (op.write) {
    try {
      await conn.run('ROLLBACK');
    } catch (e) {
      if (!outcome.ok) outcome.evidence += `; ROLLBACK failed too, check ${database} by hand (${errText(e)})`;
    }
  }
  if (op.http) {
    const hits = listener.hits() - before;
    outcome.evidence += `; the local listener had ${hits} hits`;
    if (hits) outcome.ok = false;
  }
  return outcome;
}

// Check 6. Starts the slow query, interrupts it after limitMs and waits up to
// graceMs more. Returns { ok, stuck, evidence }.
async function slowQuery(conn, { limitMs = SLOW_LIMIT_MS, graceMs = SLOW_GRACE_MS, clock = Date.now } = {}) {
  const started = clock();
  const query = conn.run(SLOW_SQL).then(() => ({ finished: true }), (error) => ({ error }));
  const interrupter = setTimeout(() => {
    try { conn.interrupt(); } catch { /* reported below as not stopped */ }
  }, limitMs);
  let guard;
  const timedOut = new Promise((resolve) => { guard = setTimeout(() => resolve({ stuck: true }), limitMs + graceMs); });
  const outcome = await Promise.race([query, timedOut]);
  clearTimeout(interrupter);
  clearTimeout(guard);
  const took = clock() - started;
  if (outcome.stuck) return { ok: false, stuck: true, evidence: `still running ${limitMs + graceMs} ms after it started, though interrupted at ${limitMs} ms` };
  if (outcome.finished) return { ok: false, evidence: `it finished (${took} ms) instead of being interrupted` };
  const msg = errText(outcome.error);
  if (/interrupt/i.test(msg)) return { ok: true, evidence: `interrupted at ${limitMs} ms, stopped after ${took} ms (${msg})` };
  return { ok: false, evidence: `it failed for another reason: ${msg}` };
}

// What a connection sees after USE: its tables, and a read with no database
// named. Returns { ok, evidence }.
async function seesTables(conn) {
  try {
    const tables = (await conn.run(TABLES_SQL)).map((r) => r.table_name);
    if (!tables.length) return { ok: false, evidence: 'it sees no tables' };
    const table = tables.includes(remote.PUBLISH_TABLE) ? remote.PUBLISH_TABLE : tables[0];
    const n = (await conn.run(`SELECT count(*)::VARCHAR AS n FROM ${remote.ident(table)}`))[0].n;
    return { ok: true, evidence: `it sees ${tables.length} tables; ${table} has ${n} rows` };
  } catch (e) {
    return { ok: false, evidence: errText(e) };
  }
}

const isTrue = (v) => String(v).toLowerCase() === 'true';
const isFalse = (v) => String(v).toLowerCase() === 'false';

function ago(publishedAt, now) {
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((now().getTime() - t) / 1000));
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

// The probe itself. deps:
//   openReader({ database, token }) -> { run, interrupt, connect(), close,
//     captured: { extension } }: the reader after its setup and USE;
//     connect() is one more connection (it runs USE too); captured.extension
//     is the motherduck row read before the lock. Rejects with the failed
//     step's label in its message.
//   openPathForm({ database, token }) -> a connection, or rejects (check 3).
//   inspectLocal() -> the motherduck row of a plain local DuckDB, or null.
//   readLocal() -> the local build's snapshot (kit/fixture/remote), or null.
//   tmp: a scratch dir prepareScratch filled; listener: { url, hits() }.
//   say(line): a redacting printer.
// Returns [{ id, status, text }], printing each line as it is decided.
async function runProbe({
  database, token, openReader, openPathForm, inspectLocal, readLocal, tmp, listener, say,
  now = () => new Date(), slow = {},
}) {
  const results = [];
  const report = (id, status, text) => {
    results.push({ id, status, text });
    say(`${status.padEnd(8)}  ${id}  ${text}`);
  };
  const notRun = (from, why) => {
    for (let id = from; id <= TOTAL; id += 1) {
      if (!results.some((r) => r.id === id)) report(id, REQUIRED.includes(id) ? 'FAIL' : 'INFO', `not run: ${why}`);
    }
  };
  const closeQuietly = (c) => {
    try { c.close(); } catch (e) { say(`fixture:probe: closing a MotherDuck connection failed: ${errText(e)}`); }
  };

  // 1 (first half): installed ahead of time, and not loaded by a plain local
  // DuckDB with auto-load off.
  let ext;
  try {
    ext = await inspectLocal();
  } catch (e) {
    report(1, 'FAIL', `could not inspect the local extensions: ${errText(e)}`);
    notRun(2, 'the extension check failed');
    return results;
  }
  if (!ext || !isTrue(ext.installed)) {
    report(1, 'FAIL', `the ${EXTENSION} extension is not installed for DuckDB ${ext?.duckdb || pinnedDuckdb()}. Install it ahead of time: npm run fixture:probe -- --install`);
    notRun(2, `the ${EXTENSION} extension is not installed`);
    return results;
  }

  // 3 (first half): the plan's md: path form with external access off.
  let pathResult;
  try {
    closeQuietly(await openPathForm({ database, token }));
    pathResult = 'it opened';
  } catch (e) {
    pathResult = `it fails (${errText(e)})`;
  }

  let conn;
  try {
    conn = await openReader({ database, token });
  } catch (e) {
    report(1, 'FAIL', `installed (${ext.version || 'version unknown'}), but the reader setup failed, so LOAD ${EXTENSION} is unconfirmed`);
    report(2, 'FAIL', `the reader did not open: ${errText(e)}`);
    report(3, 'INFO', `${pathForm(database)} with enable_external_access=false at startup: ${pathResult}. The reader sequence did not open, so it is unknown whether it keeps external access off.`);
    notRun(4, 'the reader did not open');
    return results;
  }
  let stuck = false;
  try {
    let settings;
    try {
      settings = (await conn.run(settingsSql(database)))[0];
    } catch (e) {
      report(1, 'FAIL', `could not read the reader's settings: ${errText(e)}`);
      notRun(2, 'the reader\'s settings could not be read');
      return results;
    }

    // 1 and 2: the extension and the connection.
    const autoOff = isFalse(settings.autoinstall) && isFalse(settings.autoload);
    const readerExt = conn.captured?.extension || {};
    const loaded = isTrue(readerExt.loaded);
    report(1, autoOff && loaded && !isTrue(ext.loaded) ? 'PASS' : 'FAIL',
      `installed ahead (${ext.version || 'version unknown'}); loaded by a plain local DuckDB: ${isTrue(ext.loaded)}; loaded by LOAD ${EXTENSION}: ${loaded}; autoinstall ${settings.autoinstall}, autoload ${settings.autoload}`);
    let second;
    let fresh = { ok: false, evidence: 'not tried' };
    try {
      second = await conn.connect();
      fresh = await seesTables(second);
    } catch (e) {
      fresh = { ok: false, evidence: errText(e) };
    } finally {
      if (second) closeQuietly(second);
    }
    const readOnly = isTrue(settings.db_readonly);
    const onTarget = settings.current_db === database;
    report(2, readOnly && onTarget && fresh.ok ? 'PASS' : 'FAIL',
      `ATTACH 'md:${database}' (READ_ONLY) with the token as a setting; ${database} read-only: ${settings.db_readonly}; after USE the current database is ${settings.current_db}; a new connection after USE: ${fresh.evidence}`);

    // 3: enable_external_access=false, both ways.
    const offNow = isFalse(settings.external_access);
    report(3, 'INFO', `${pathForm(database)} with enable_external_access=false at startup: ${pathResult}. The reader sequence (SET after ATTACH): enable_external_access is ${settings.external_access}${offNow ? ', and MotherDuck still reads' : ''}.`);

    // 4: the lock holds.
    const loosened = [];
    for (const sql of LOOSEN) {
      try {
        await conn.run(sql);
        loosened.push(`${sql} ran`);
      } catch { /* refused, as it must be */ }
    }
    let after;
    try {
      after = (await conn.run(settingsSql(database)))[0];
    } catch (e) {
      loosened.push(`could not read the settings back: ${errText(e)}`);
    }
    if (after && !(isTrue(after.locked) && isFalse(after.external_access) && isFalse(after.autoload) && isFalse(after.autoinstall))) {
      loosened.push(`settings now lock ${after.locked}, external access ${after.external_access}, autoload ${after.autoload}, autoinstall ${after.autoinstall}`);
    }
    report(4, loosened.length ? 'FAIL' : 'PASS', loosened.length
      ? `lock_configuration did not hold: ${loosened.join('; ')}`
      : `lock_configuration is on, external access stays off, and all ${LOOSEN.length} SETs that would loosen it were refused`);

    // 5: forbidden operations, one line each.
    for (const op of forbiddenOps({ database, tmp, url: listener.url })) {
      const { ok, accepted, evidence } = await attempt(conn, op, { database, listener });
      if (accepted) report(5, 'ACCEPTED', `${op.label}: ${evidence}`);
      else report(5, ok ? 'PASS' : 'FAIL', `${op.kind === 'attached' ? '' : 'refused: '}${op.label} (${evidence})`);
    }

    // 6: a slow query is interrupted.
    const slowResult = await slowQuery(conn, slow);
    report(6, slowResult.ok ? 'PASS' : 'FAIL', `a slow query: ${slowResult.evidence}`);
    if (slowResult.stuck) {
      stuck = true; // closing it would wait on the query
      notRun(7, 'the slow query is still running');
      return results;
    }

    // 7: versions.
    const pinned = pinnedDuckdb();
    const v = after || settings;
    report(7, v.duckdb === pinned && loaded ? 'PASS' : 'FAIL',
      `DuckDB ${v.duckdb} (pinned ${pinned}), ${EXTENSION} extension ${readerExt.version || 'unknown'}, loaded ${readerExt.loaded ?? 'unknown'}`);

    // 8 and 9 need a re-publish or a second account; run what runs alone.
    let snap = null;
    let snapError = null;
    try {
      snap = await remote.remoteSnapshot(conn, database);
      if (!snap) snapError = `${database} is not attached`;
    } catch (e) {
      snapError = errText(e);
    }
    const publishedAt = snap?.publishedAt || null;
    report(8, 'INFO', [
      snapError ? `could not read ${database}: ${snapError}.` : `the reader reads ${database} through its share; last published ${publishedAt || 'unknown'}.`,
      'To decide: run npm run fixture:publish, then this probe again. If it still reads and shows a newer publish time, the reader\'s share survived.',
      `Ask Steven to run SELECT value FROM ${database}.main.${remote.PUBLISH_TABLE} WHERE key = 'published_at' from his account and check he sees the same time.`,
    ].join(' '));

    let local = null;
    let localError = null;
    try {
      local = await readLocal();
    } catch (e) {
      localError = errText(e);
    }
    const age = publishedAt ? ago(publishedAt, now) : null;
    const seen = snap
      ? `the read copy has version ${snap.version || '(none recorded)'}, published ${publishedAt || 'unknown'}${age ? ` (${age} ago)` : ''}`
      : `the read copy could not be read (${snapError})`;
    let compared;
    if (!local) compared = `no local build to compare with${localError ? ` (${localError})` : ' (run npm run fixture:build)'}`;
    else if (!snap) compared = `the local build is ${local.version}`;
    else if (snap.version === local.version) compared = `it matches the local build, so the lag was at most ${age || 'the time since publishing'}`;
    else compared = `the local build is ${local.version}, so the read copy is behind or from another build`;
    report(9, 'INFO', `${seen}; ${compared}. After a publish, re-run this probe until the versions match: the lag is the time from the publish to the first matching run.`);
    return results;
  } finally {
    if (!stuck) closeQuietly(conn);
  }
}

// --- The real DuckDB side (Ely's machine only) ---------------------------------

function wrap(conn) {
  return {
    run: async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson(),
    interrupt: () => conn.interrupt(),
    close: () => conn.closeSync(),
  };
}

// An in-memory DuckDB with INSTANCE_OPTIONS (plus options), steps run in
// order on a setup connection, then a query connection that runs `use`
// first. A failed step rejects naming its label, never its SQL; a step with
// capture keeps its first row as captured[capture]. Returns the query
// connection plus captured, connect() (another one, with `use`) and close(),
// which closes them all.
async function openLocked({ steps = [], use = null, options = {} } = {}) {
  const instance = await DuckDBInstance.create(':memory:', { ...INSTANCE_OPTIONS, ...options });
  const conns = [];
  const connect = async () => {
    const c = await instance.connect();
    conns.push(c);
    if (use) await c.run(use);
    return c;
  };
  const closeAll = () => {
    for (const c of conns) {
      try { c.closeSync(); } catch { /* the instance close below is what matters */ }
    }
    instance.closeSync();
  };
  try {
    const setup = await instance.connect();
    conns.push(setup);
    const captured = {};
    for (const step of steps) {
      try {
        const rows = (await setup.runAndReadAll(step.sql)).getRowObjectsJson();
        if (step.capture) captured[step.capture] = rows[0] || null;
      } catch (e) {
        throw new Error(`${step.label}: ${errText(e)}`);
      }
    }
    const main = wrap(await connect());
    return {
      ...main,
      captured,
      connect: async () => wrap(await connect()),
      close: closeAll,
    };
  } catch (err) {
    closeAll();
    throw err;
  }
}

const openReader = ({ database, token }) => openLocked({ steps: readerSteps(database, token), use: useStatement(database) });

// Fills the scratch dir before the reader opens: READ_FILE, and ATTACH_FILE
// as a real DuckDB file with one table, made on its own local instance and
// closed again, so a refusal can't be a "not found".
async function prepareScratch(tmp) {
  fs.writeFileSync(path.join(tmp, READ_FILE), 'n\n1\n');
  const instance = await DuckDBInstance.create(path.join(tmp, ATTACH_FILE), {});
  try {
    const c = await instance.connect();
    try {
      await c.run('CREATE TABLE probe AS SELECT 1 AS n');
    } finally {
      c.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

async function openPathForm({ database, token }) {
  const instance = await DuckDBInstance.create(pathForm(database), pathFormOptions(token));
  instance.closeSync();
  return { close() {} };
}

async function inspectLocal() {
  const c = await openLocked();
  try {
    return (await c.run(EXTENSION_SQL))[0] || null;
  } finally {
    c.close();
  }
}

// --install: the one step that downloads (from DuckDB's extension site; no token).
async function installExtension() {
  const instance = await DuckDBInstance.create(':memory:', {});
  const c = await instance.connect();
  try {
    await c.run(`INSTALL ${EXTENSION}`);
    return (await c.runAndReadAll(EXTENSION_SQL)).getRowObjectsJson()[0] || null;
  } finally {
    c.closeSync();
    instance.closeSync();
  }
}

// The local http listener check 5 points read_csv at. Counts every request.
function startListener() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.end('n\n1\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/${READ_FILE}`,
        hits: () => hits,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// --- The CLI -------------------------------------------------------------------

const parseArgs = (argv) => parsePublishArgs(argv, { valued: ['--database', '--db', '--name'], flags: ['--install'] });

// Every token read in this process, for reportUncaught.
const known = createLog({ write: () => {} });

async function main(argv, deps = {}) {
  const {
    env = process.env, cwd = process.cwd(), platform, readKeychain,
    open = openReader, openPath = openPathForm, inspect = inspectLocal, install = installExtension,
    listen = startListener, readLocal: readLocalDep, now = () => new Date(), slow = {},
    out = (s) => console.log(s), err = (s) => console.error(s),
  } = deps;
  const log = createLog({ write: () => {} });
  const say = (s) => out(log.redact(s));
  const warn = (s) => err(log.redact(s));

  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.error) {
    err(`${args.error}\n${USAGE}`);
    return 2;
  }
  if (args.install) {
    try {
      const ext = await install();
      say(`fixture:probe: the ${EXTENSION} extension is installed (${ext?.version || 'version unknown'}) for DuckDB ${ext?.duckdb || pinnedDuckdb()}`);
      return 0;
    } catch (e) {
      warn(`fixture:probe: installing the ${EXTENSION} extension failed: ${errText(e)}`);
      return 1;
    }
  }
  const database = args.database || DEFAULT_DATABASE;
  const badName = remote.databaseNameProblem(database);
  if (badName) {
    err(`fixture:probe: --database: ${badName}`);
    return 2;
  }
  const fixtureDir = path.resolve(cwd, args.fixtureDir);
  let clientId = null;
  if (!args.db && !args.name) {
    try {
      clientId = governingClientId(cwd, env);
    } catch (e) {
      if (e.code !== 'PROFILE_INVALID') throw e;
      err(`fixture:probe: ${e.message}`);
      return 2;
    }
  }
  const localDb = args.db ? path.resolve(cwd, args.db) : defaultOut(fixtureDir, args.name, env, clientId);
  const readLocal = readLocalDep || (async () => (fs.existsSync(localDb) ? remote.localSnapshot({ fixtureDir, db: localDb }) : null));

  // Both tokens are masked before anything can print them.
  const token = readSecret(READ_TOKEN_ENV, READ_TOKEN_KEYCHAIN, { env, platform, readKeychain });
  const publishToken = readSecret(remote.TOKEN_ENV, remote.TOKEN_KEYCHAIN, { env, platform, readKeychain });
  for (const t of [token, publishToken]) {
    log.registerSecret(t);
    known.registerSecret(t);
  }
  if (!token) {
    warn(`fixture:probe: ${READ_TOKEN_HELP}`);
    return 1;
  }
  if (publishToken && publishToken === token) {
    warn(`fixture:probe: ${SAME_TOKEN}`);
    return 1;
  }
  const from = env[READ_TOKEN_ENV] ? READ_TOKEN_ENV : `the Keychain (${READ_TOKEN_KEYCHAIN})`;
  // The extension could otherwise fall back to a token in the environment.
  delete env[remote.TOKEN_ENV];
  delete env.motherduck_token;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-md-probe-'));
  let listener;
  try {
    await prepareScratch(tmp);
    listener = await listen();
    say(`fixture:probe: probing md:${database} as the reader (token from ${from})`);
    let results;
    try {
      results = await runProbe({
        database, token, openReader: open, openPathForm: openPath, inspectLocal: inspect, readLocal, tmp, listener, say, now, slow,
      });
    } catch (e) {
      warn(`fixture:probe: the probe stopped: ${errText(e)}`);
      return 1;
    }
    return summarise(results, say);
  } finally {
    if (listener) await listener.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The summary line; returns the exit code.
function summarise(results, say) {
  const failed = [...new Set(results.filter((r) => r.status === 'FAIL').map((r) => r.id))];
  const passed = REQUIRED.filter((id) => results.some((r) => r.id === id) && !failed.includes(id));
  const accepted = results.filter((r) => r.status === 'ACCEPTED').length;
  const exceptions = accepted ? `, with ${accepted} accepted exception${accepted === 1 ? '' : 's'} (ACCEPTED above)` : '';
  if (!failed.length && passed.length === REQUIRED.length) {
    say(`fixture:probe: all ${REQUIRED.length} required checks passed (${REQUIRED.join(', ')})${exceptions}; 3, 8 and 9 are findings above. The lockdown holds.`);
    return 0;
  }
  say(`fixture:probe: ${passed.length} of ${REQUIRED.length} required checks passed; failed: ${failed.join(', ')}. Stop: do not start Story B. The lockdown is never loosened quietly.`);
  return 1;
}

// The top-level handler: an error main did not catch, every token read in
// this process masked, never a raw stack with a token in it.
function reportUncaught(e, { err = (s) => console.error(s) } = {}) {
  err(known.redact(`fixture:probe: ${e?.stack || String(e)}`));
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.exitCode = reportUncaught(e);
  }).finally(() => {
    // A slow query that ignored its interrupt keeps the process alive: leave anyway.
    setTimeout(() => process.exit(process.exitCode), 1000).unref();
  });
}

module.exports = {
  main,
  runProbe,
  parseArgs,
  attempt,
  slowQuery,
  seesTables,
  forbiddenOps,
  readerSteps,
  useStatement,
  pathForm,
  pathFormOptions,
  settingsSql,
  openLocked,
  startListener,
  pinnedDuckdb,
  reportUncaught,
  INSTANCE_OPTIONS,
  EXTENSION_STEP,
  LOCK_STEPS,
  ATTACH_MODE_SQL,
  MY_DB_EXCEPTION,
  LOOSEN,
  ALSO_ATTACHED,
  READ_TOKEN_ENV,
  READ_TOKEN_KEYCHAIN,
  DEFAULT_DATABASE,
  REQUIRED,
  READ_FILE,
  ATTACH_FILE,
  prepareScratch,
  SLOW_SQL,
  USAGE,
};
