'use strict';

// Fixture publish (Story 7.7, AD-12, AD-18). Run by Ely only; agents never run it.
//
//   npm run fixture:publish
//   node kit/fixture/publish.js <fixture-dir> [--db <file>] [--name <client>] [--database <name>] [--profile <file>]
//
// Publishes the local build to the shared MotherDuck database (default
// <client>_fixture, see kit/fixture/remote databaseNameFor), in this order:
//
//   1. Refuse unless a profile governs (its forbidden columns guard the
//      checks; no profile is exit 2, as in validate and query, issue #85),
//      the build exists, matches seeds/fixture_meta.csv (not stale), carries
//      a valid build stamp, holds exactly what a fresh build of the seeds
//      holds (kit/fixture/build isBuildOf, issue #87: --db can name any
//      file, and only the synthetic seeds are published) and every
//      checks/*.sql passes (kit/fixture/validate).
//   2. Read the token (kit/lib/secrets); a missing one exits 1 saying how to
//      set it. It is registered with the redactor before connecting.
//   3. Refuse unless <database> does not exist yet (first publish) or has a
//      fixture_publish table (this tool published it): --database can name
//      any MotherDuck database, and publish never replaces one it did not
//      write. The refusal sends no write, a staging cleanup included.
//      Then upload the build to <database>__publishing table by table:
//      attach the build read-only, refuse anything in it besides tables and
//      any foreign-key cycle, create each table from its local DDL parents
//      first, copy its rows in the same order, and detach the build on every
//      path (see upload). Then add the fixture_publish
//      table (fixture version, seeds hash, as_of, published_at, rows_<table>),
//      and check its row counts and version against the local build.
//   4. Swap. First publish: CREATE DATABASE <database> FROM <staging> (no
//      share can exist yet). Re-publish: update <database> in place, in one
//      transaction (see swapInPlace): MotherDuck refuses to replace or drop
//      a database while a share is attached, and the bot reads through one.
//      Then check the result against the local build and drop staging.
//
// Every refusal in step 1 or 2 comes before any connection, and step 3's
// target refusal comes before any write, so no refusal changes anything
// remotely. Any failure before step 4 leaves the shared database as it was,
// and so does a failure inside step 4's transaction once it is rolled back.
// A staging copy left behind (after a failed commit, rollback or final drop)
// is removed by the next publish before it uploads.
// Exit codes: 0 published, 1 refused or failed (closing the connection
// failing included, even after a publish), 2 usage or profile error.

const fs = require('node:fs');
const path = require('node:path');
const { defaultOut, isFixtureBuild, isBuildOf, FixtureBuildError } = require('./build');
const { loadChecks, validate, resultLine, notBuilt, shownPath, PROFILE_ERRORS } = require('./validate');
const { governingProfilePath, loadProfile, PROFILE_REL } = require('../lib/profile');
const { forbiddenColumnsOf } = require('../runtime/sql');
const remote = require('./remote');

const USAGE = 'usage: node kit/fixture/publish.js <fixture-dir> [--db <file>] [--name <client>] [--database <name>] [--profile <file>]';
const VALUED = ['--db', '--name', '--database', '--profile'];

// Shared with kit/fixture/status: valued options (each takes a value) and
// boolean flags, plus one <fixture-dir>.
function parseArgs(argv, { valued = VALUED, flags = [] } = {}) {
  const args = { fixtureDir: null };
  for (const v of valued) args[v.slice(2)] = null;
  for (const f of flags) args[f.slice(2)] = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (valued.includes(a)) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) return { error: `${a} needs a value` };
      args[a.slice(2)] = v;
      i += 1;
    } else if (flags.includes(a)) {
      args[a.slice(2)] = true;
    } else if (a.startsWith('--')) {
      return { error: `unknown option ${a}` };
    } else if (args.fixtureDir) {
      return { error: `unexpected argument ${a}` };
    } else {
      args.fixtureDir = a;
    }
  }
  if (!args.fixtureDir) return { error: 'missing <fixture-dir>' };
  return args;
}

class PublishError extends Error {}
// A refusal sent before any write: nothing remote is cleaned up after it.
class TargetRefused extends PublishError {}

// Step 3's refusal: an existing database this tool did not publish is never
// replaced. Only reads are sent. Returns whether the target exists.
async function checkTarget(conn, database) {
  const snap = await remote.remoteSnapshot(conn, database);
  if (snap && !snap.published) {
    throw new TargetRefused(`${database} already exists and was not published by fixture:publish (it has no ${remote.PUBLISH_TABLE} table), so it is never replaced. Pass --database with a new name or one fixture:publish wrote`);
  }
  return Boolean(snap);
}

// Step 3 and 4's check: the copy at `database` is the local build.
async function checkCopy(conn, database, local, what) {
  const snap = await remote.remoteSnapshot(conn, database);
  const diff = snap ? remote.compare(local, snap) : { match: false, differences: [`${database} does not exist`] };
  if (!diff.match) throw new PublishError(`${what} does not match the local build:\n  ${diff.differences.join('\n  ')}`);
}

// The alias the local build is attached under, read-only, during the upload.
const LOCAL = 'aplabs_publish_local';

// Table names ordered so every table comes after the tables its foreign keys
// reference (Kahn's algorithm, ties by name). edges are [child, parent]; a
// table referencing itself, or a parent not in `names`, does not constrain
// the order. A cycle has no such order and is refused; `outcome` ends that
// message.
function parentFirst(names, edges, outcome = 'so no load order works; nothing was uploaded') {
  const parents = new Map(names.map((n) => [n, new Set()]));
  for (const [child, parent] of edges) {
    if (child !== parent && parents.has(child) && parents.has(parent)) parents.get(child).add(parent);
  }
  const order = [];
  const placed = new Set();
  while (order.length < names.length) {
    const ready = [...parents].filter(([n, ps]) => !placed.has(n) && [...ps].every((p) => placed.has(p))).map(([n]) => n).sort();
    if (!ready.length) {
      const stuck = names.filter((n) => !placed.has(n)).sort();
      throw new PublishError(`the foreign keys among ${stuck.join(', ')} form a cycle, ${outcome}`);
    }
    order.push(ready[0]);
    placed.add(ready[0]);
  }
  return order;
}

// What the attached local build holds: its main-schema tables with their DDL
// (keys, NOT NULL, UNIQUE and CHECK rules included) in parent-first order.
// Anything else (a view, index, sequence, macro, type or other schema) is
// refused, since publish uploads tables only. Only reads.
async function localTables(conn) {
  const here = `database_name = ${remote.sqlString(LOCAL)}`;
  const others = await conn.run([
    `SELECT 'schema' AS kind, schema_name AS name FROM duckdb_schemas() WHERE ${here} AND NOT internal`,
    `SELECT 'view', view_name FROM duckdb_views() WHERE ${here} AND NOT internal`,
    `SELECT 'index', index_name FROM duckdb_indexes() WHERE ${here}`,
    `SELECT 'sequence', sequence_name FROM duckdb_sequences() WHERE ${here}`,
    `SELECT 'macro', function_name FROM duckdb_functions() WHERE ${here} AND NOT internal`,
    `SELECT 'type', type_name FROM duckdb_types() WHERE ${here} AND NOT internal`,
  ].join(' UNION ALL ') + ' ORDER BY 1, 2');
  if (others.length) {
    throw new PublishError(`the local build holds more than tables (${others.map((o) => `${o.kind} ${o.name}`).join(', ')}), and publish uploads tables only; nothing was uploaded`);
  }
  const tables = await conn.run(`SELECT table_name, sql FROM duckdb_tables() WHERE ${here} AND schema_name = 'main' ORDER BY table_name`);
  const fks = await conn.run(`SELECT table_name, referenced_table FROM duckdb_constraints() WHERE ${here} AND constraint_type = 'FOREIGN KEY'`);
  const ddl = new Map(tables.map((t) => [t.table_name, t.sql]));
  return parentFirst([...ddl.keys()], fks.map((f) => [f.table_name, f.referenced_table])).map((name) => ({ name, sql: ddl.get(name) }));
}

// Uploads the build to staging table by table, parents first, so every
// foreign key holds as each table loads. MotherDuck's whole-database copy of
// a local file (CREATE DATABASE ... FROM '<file>') loads tables in an order
// that ignores foreign keys, which broke the first live publish (2026-10-24).
// The DDL runs with staging as the current database, so its REFERENCES
// resolve to staging's tables; the connection's own database is current
// again before anything else runs. The local build is detached on every
// path; a cleanup failure is raised only when the upload itself succeeded.
async function upload(conn, { db, database, local, now }) {
  const staging = remote.stagingNameFor(database);
  const s = remote.ident(staging);
  const l = remote.ident(LOCAL);
  await conn.run(`ATTACH ${remote.sqlString(db)} AS ${l} (READ_ONLY)`);
  let home = null;
  let inStaging = false;
  let failure = null;
  let tables;
  try {
    tables = await localTables(conn);
    [{ d: home }] = await conn.run('SELECT current_database() AS d');
    await conn.run(`DROP DATABASE IF EXISTS ${s}`);
    await conn.run(`CREATE DATABASE ${s}`);
    await conn.run(`USE ${s}`);
    inStaging = true;
    for (const t of tables) await conn.run(t.sql);
    await conn.run(`USE ${remote.ident(home)}`);
    inStaging = false;
    for (const t of tables) await conn.run(`INSERT INTO ${s}.main.${remote.ident(t.name)} SELECT * FROM ${l}.main.${remote.ident(t.name)}`);
  } catch (e) {
    failure = e;
  }
  let cleanupError = null;
  for (const sql of [...(inStaging ? [`USE ${remote.ident(home)}`] : []), `DETACH ${l}`]) {
    try { await conn.run(sql); } catch (e) { cleanupError = cleanupError || e; }
  }
  if (failure || cleanupError) throw failure || cleanupError;
  const recorded = [
    ['fixture_version', local.version],
    ['generator_version', local.generatorVersion || 'unknown'],
    ['seeds_sha256', local.seedsSha256],
    ['as_of', local.asOf || 'unknown'],
    ['published_at', now().toISOString()],
    ...Object.entries(local.counts).map(([t, n]) => [`rows_${t}`, String(n)]),
  ];
  await conn.run(`CREATE TABLE ${s}.main.${remote.PUBLISH_TABLE} (key VARCHAR, value VARCHAR)`);
  await conn.run(`INSERT INTO ${s}.main.${remote.PUBLISH_TABLE} VALUES ${recorded.map(([k, v]) => `(${remote.sqlString(k)}, ${remote.sqlString(v)})`).join(', ')}`);
  return { staging, tables };
}

// Step 4 for a re-publish: updates <database> in place from staging, in one
// transaction, so a share attached to it stays attached. With <database> as
// the current database (MotherDuck refuses a REFERENCES that names another
// database):
//
//   BEGIN TRANSACTION
//   DROP TABLE each of the target's tables except fixture_publish, children
//     first by the target's own foreign keys
//   CREATE TABLE each of the build's tables from the DDL the upload ran,
//     parents first, then INSERT INTO it SELECT * FROM <staging>.main.<table>
//   DROP, CREATE and fill fixture_publish from staging, last, so the version
//     commits with the data and is never missing (the next publish refuses a
//     database without it)
//   COMMIT
//
// Every table is rebuilt, never only its rows swapped: DuckDB checks foreign
// keys statement by statement, even inside a transaction, so deleting a
// parent's rows while the old child rows exist is refused (live test on
// MotherDuck, 2026-10-25). On a failure inside the transaction it rolls
// back. setStage records what a failure leaves: 'transaction' once BEGIN
// ran, then 'rolledBack' or 'rollbackFailed'; 'commit' while COMMIT runs (a
// failed COMMIT leaves the outcome unknown, so nothing is rolled back); and
// 'after' once it committed. The connection's own database is current again
// before it returns or throws.
async function swapInPlace(conn, { database, staging, tables }, setStage) {
  const s = remote.ident(staging);
  const here = `database_name = ${remote.sqlString(database)}`;
  const [{ d: home }] = await conn.run('SELECT current_database() AS d');
  await conn.run(`USE ${remote.ident(database)}`);
  let stage = 'before';
  const at = (next) => { stage = next; setStage(next); };
  let failure = null;
  try {
    await conn.run('BEGIN TRANSACTION');
    at('transaction');
    const old = (await conn.run(`SELECT table_name FROM duckdb_tables() WHERE ${here} AND schema_name = 'main' ORDER BY table_name`))
      .map((r) => r.table_name).filter((n) => n !== remote.PUBLISH_TABLE);
    const fks = await conn.run(`SELECT table_name, referenced_table FROM duckdb_constraints() WHERE ${here} AND constraint_type = 'FOREIGN KEY'`);
    const childrenFirst = parentFirst(old, fks.map((f) => [f.table_name, f.referenced_table]), 'so no drop order works').reverse();
    for (const name of childrenFirst) await conn.run(`DROP TABLE ${remote.ident(name)}`);
    for (const t of tables) await conn.run(t.sql);
    for (const t of tables) await conn.run(`INSERT INTO ${remote.ident(t.name)} SELECT * FROM ${s}.main.${remote.ident(t.name)}`);
    await conn.run(`DROP TABLE ${remote.PUBLISH_TABLE}`);
    await conn.run(`CREATE TABLE ${remote.PUBLISH_TABLE} (key VARCHAR, value VARCHAR)`);
    await conn.run(`INSERT INTO ${remote.PUBLISH_TABLE} SELECT * FROM ${s}.main.${remote.PUBLISH_TABLE}`);
    at('commit');
    await conn.run('COMMIT');
    at('after');
  } catch (e) {
    failure = e;
  }
  if (failure && stage === 'transaction') {
    try {
      await conn.run('ROLLBACK');
      at('rolledBack');
    } catch {
      at('rollbackFailed');
    }
  }
  try { await conn.run(`USE ${remote.ident(home)}`); } catch (e) { failure = failure || e; }
  if (failure) throw failure;
}

async function main(argv, deps = {}) {
  const {
    env = process.env, cwd = process.cwd(), connect = remote.defaultConnect, readKeychain, platform,
    out = (s) => console.log(s), err = (s) => console.error(s), now = () => new Date(),
  } = deps;
  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.error) {
    err(`${args.error}\n${USAGE}`);
    return 2;
  }
  const fixtureDir = path.resolve(cwd, args.fixtureDir);
  const database = remote.databaseNameFor(fixtureDir, args);
  const badName = remote.databaseNameProblem(database);
  if (badName) {
    err(`fixture:publish: --database: ${badName}`);
    return 2;
  }
  // No profile means no forbidden columns are known: refuse (issue #85).
  let profile;
  try {
    const profileFile = governingProfilePath(args.profile, cwd, env);
    if (!profileFile) {
      err(`fixture:publish: no profile (pass --profile, set APLABS_PROFILE or add ${PROFILE_REL}); nothing was published`);
      return 2;
    }
    profile = loadProfile(profileFile);
  } catch (e) {
    if (!PROFILE_ERRORS.has(e.code)) throw e;
    err(`fixture:publish: ${e.message}`);
    return 2;
  }

  const forbiddenColumns = forbiddenColumnsOf(profile);

  // 1. Local: built, not stale, the seeds' own build, every check passes.
  // Nothing secret yet.
  const db = args.db ? path.resolve(cwd, args.db) : defaultOut(fixtureDir, args.name, env, profile.client.id);
  if (!fs.existsSync(db)) {
    err(`fixture:publish: ${notBuilt(shownPath(cwd, db))}`);
    return 1;
  }
  const local = await remote.localSnapshot({ fixtureDir, db });
  if (local.stale.length) {
    err(`fixture:publish: the build is older than the seeds:\n  ${local.stale.join('\n  ')}\nRun npm run fixture:build, then publish again.`);
    return 1;
  }
  const shownDb = shownPath(cwd, db);
  if (!(await isFixtureBuild(db))) {
    err(`fixture:publish: ${shownDb} has no valid fixture:build stamp (it was not written by npm run fixture:build, or changed since); nothing was published`);
    return 1;
  }
  let seedsBuild;
  try {
    seedsBuild = await isBuildOf(db, fixtureDir);
  } catch (e) {
    if (!(e instanceof FixtureBuildError)) throw e;
    err(`fixture:publish: the seeds in ${shownPath(cwd, fixtureDir)} do not build: ${e.message}; nothing was published`);
    return 1;
  }
  if (!seedsBuild) {
    err(`fixture:publish: ${shownDb} is not the npm run fixture:build output of these seeds (${shownPath(cwd, fixtureDir)}): its content differs from a fresh build. Run npm run fixture:build, then publish again; nothing was published`);
    return 1;
  }
  const checks = loadChecks(fixtureDir);
  if (!checks.length) {
    err(`fixture:publish: no checks/*.sql in ${shownPath(cwd, fixtureDir)}, so the build can't be validated; nothing was published`);
    return 1;
  }
  const results = await validate({ checks, db, forbiddenColumns });
  for (const r of results) out(resultLine(r));
  const failed = results.filter((r) => r.outcome !== 'pass').length;
  if (failed) {
    err(`fixture:publish: local validation failed: ${failed} of ${results.length} checks; nothing was published`);
    return 1;
  }

  // 2. The token, registered before any connection.
  const { token, say, warn } = remote.openSecrets({ env, platform, readKeychain, out, err });
  if (!token) {
    warn(`fixture:publish: ${remote.TOKEN_HELP}`);
    return 1;
  }

  // 3 and 4. A close failure is reported (redacted) and makes the exit
  // non-zero even after a successful publish; an earlier failure's code stays.
  let conn;
  let stage = 'before';
  let code;
  try {
    conn = await connect({ token });
    const exists = await checkTarget(conn, database);
    const { staging, tables } = await upload(conn, { db, database, local, now });
    await checkCopy(conn, staging, local, 'the uploaded copy');
    if (exists) {
      await swapInPlace(conn, { database, staging, tables }, (s) => { stage = s; });
    } else {
      stage = 'create';
      await conn.run(`CREATE DATABASE ${remote.ident(database)} FROM ${remote.ident(staging)}`);
      stage = 'after';
    }
    await checkCopy(conn, database, local, `the shared database ${database}`);
    await conn.run(`DROP DATABASE ${remote.ident(staging)}`);
    const total = Object.values(local.counts).reduce((n, c) => n + c, 0);
    say(`fixture:publish: published ${database}: version ${local.version}, ${Object.keys(local.counts).length} tables, ${total} rows`);
    code = 0;
  } catch (e) {
    const why = e instanceof PublishError ? e.message : `MotherDuck failed: ${remote.firstLine(e.message)}`;
    // The shared database is as it was, so staging is removed (a refusal
    // sent no write, so it removes nothing). After a failed commit or
    // rollback it is kept; the next publish removes it first.
    if (['before', 'rolledBack'].includes(stage) && conn && !(e instanceof TargetRefused)) {
      try { await conn.run(`DROP DATABASE IF EXISTS ${remote.ident(remote.stagingNameFor(database))}`); } catch { /* reported below */ }
    }
    const check = 'check with npm run fixture:status -- --remote';
    const state = {
      before: `the shared database ${database} was not changed`,
      rolledBack: `the update was rolled back, so the shared database ${database} was not changed`,
      rollbackFailed: `the rollback failed too, so the shared database ${database} may be partly changed; ${check}`,
      commit: `the commit failed, so it is unknown whether the shared database ${database} was updated; ${check}`,
      create: `the shared database ${database} may not have been created; ${check}`,
      after: `the shared database ${database} was published; check it with npm run fixture:status -- --remote`,
    }[stage];
    warn(`fixture:publish: ${why}\n${state}.`);
    code = 1;
  }
  if (!remote.closeConnection(conn, warn, 'fixture:publish')) code = code || 1;
  return code;
}

if (require.main === module) {
  // Anything main did not catch is printed through the redactor, never as a
  // raw stack, so a token read before the failure is still masked.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.exitCode = remote.reportUncaught(e);
  });
}

module.exports = { main, parseArgs, parentFirst, USAGE };
