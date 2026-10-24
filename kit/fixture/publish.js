'use strict';

// Fixture publish (Story 7.7, AD-12, AD-18). Run by Ely only; agents never run it.
//
//   npm run fixture:publish
//   node kit/fixture/publish.js <fixture-dir> [--db <file>] [--name <client>] [--database <name>] [--profile <file>]
//
// Replaces the shared MotherDuck database (default <client>_fixture, see
// kit/fixture/remote databaseNameFor) with the local build, in this order:
//
//   1. Refuse unless the build exists, matches seeds/fixture_meta.csv (not
//      stale) and every checks/*.sql passes (kit/fixture/validate).
//   2. Read the token (kit/lib/secrets); a missing one exits 1 saying how to
//      set it. It is registered with the redactor before connecting.
//   3. Upload the build to <database>__publishing, add the fixture_publish
//      table (fixture version, seeds hash, as_of, published_at, rows_<table>),
//      and check its row counts and version against the local build.
//   4. Swap: CREATE OR REPLACE DATABASE <database> FROM <staging> (a
//      MotherDuck copy), check the result, then drop staging.
//
// Any failure before step 4 leaves the shared database as it was. The swap
// itself is one statement but not a transaction with the drop: if the drop
// fails, the next publish removes the leftover staging copy first.
// Exit codes: 0 published, 1 refused or failed (closing the connection
// failing included, even after a publish), 2 usage or profile error.

const fs = require('node:fs');
const path = require('node:path');
const { defaultOut } = require('./build');
const { loadChecks, validate, resultLine, notBuilt, shownPath, PROFILE_ERRORS } = require('./validate');
const { governingProfilePath, loadProfile } = require('../lib/profile');
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

// Step 3 and 4's check: the copy at `database` is the local build.
async function checkCopy(conn, database, local, what) {
  const snap = await remote.remoteSnapshot(conn, database);
  const diff = snap ? remote.compare(local, snap) : { match: false, differences: [`${database} does not exist`] };
  if (!diff.match) throw new PublishError(`${what} does not match the local build:\n  ${diff.differences.join('\n  ')}`);
}

async function upload(conn, { db, database, local, now }) {
  const staging = remote.stagingNameFor(database);
  const s = remote.ident(staging);
  await conn.run(`DROP DATABASE IF EXISTS ${s}`);
  await conn.run(`CREATE DATABASE ${s} FROM ${remote.sqlString(db)}`);
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
  return staging;
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
  let forbiddenColumns = [];
  let clientId = null;
  try {
    const profileFile = governingProfilePath(args.profile, cwd, env);
    if (profileFile) {
      const profile = loadProfile(profileFile);
      forbiddenColumns = forbiddenColumnsOf(profile);
      clientId = profile.client.id;
    }
  } catch (e) {
    if (!PROFILE_ERRORS.has(e.code)) throw e;
    err(`fixture:publish: ${e.message}`);
    return 2;
  }

  // 1. Local: built, not stale, every check passes. Nothing secret yet.
  const db = args.db ? path.resolve(cwd, args.db) : defaultOut(fixtureDir, args.name, env, clientId);
  if (!fs.existsSync(db)) {
    err(`fixture:publish: ${notBuilt(shownPath(cwd, db))}`);
    return 1;
  }
  const local = await remote.localSnapshot({ fixtureDir, db });
  if (local.stale.length) {
    err(`fixture:publish: the build is older than the seeds:\n  ${local.stale.join('\n  ')}\nRun npm run fixture:build, then publish again.`);
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
    const staging = await upload(conn, { db, database, local, now });
    await checkCopy(conn, staging, local, 'the uploaded copy');
    stage = 'swap';
    await conn.run(`CREATE OR REPLACE DATABASE ${remote.ident(database)} FROM ${remote.ident(staging)}`);
    stage = 'after';
    await checkCopy(conn, database, local, `the shared database ${database}`);
    await conn.run(`DROP DATABASE ${remote.ident(staging)}`);
    const total = Object.values(local.counts).reduce((n, c) => n + c, 0);
    say(`fixture:publish: published ${database}: version ${local.version}, ${Object.keys(local.counts).length} tables, ${total} rows`);
    code = 0;
  } catch (e) {
    const why = e instanceof PublishError ? e.message : `MotherDuck failed: ${remote.firstLine(e.message)}`;
    if (stage === 'before' && conn) {
      try { await conn.run(`DROP DATABASE IF EXISTS ${remote.ident(remote.stagingNameFor(database))}`); } catch { /* reported below */ }
    }
    const state = {
      before: `the shared database ${database} was not changed`,
      swap: `the shared database ${database} may not have been replaced; check with npm run fixture:status -- --remote`,
      after: `the shared database ${database} was replaced; check it with npm run fixture:status -- --remote`,
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

module.exports = { main, parseArgs, USAGE };
