'use strict';

// Fixture status (Story 7.7, AD-18).
//
//   npm run fixture:status                 local only, offline
//   npm run fixture:status -- --remote     also the shared MotherDuck copy (Ely only)
//   node kit/fixture/status.js <fixture-dir> [--db <file>] [--name <client>] [--database <name>] [--remote]
//
// Local: the build's fixture version (kit/fixture/remote), as_of and row
// count per table, and whether the build is older than the seeds. Never reads
// a token or opens a connection.
//
// --remote: reads the MotherDuck token (kit/lib/secrets), then compares the
// shared database's recorded version and row counts with the local build and
// says whether they match. Agents never run it; tests inject a fake connection.
// Exit codes: 0 shown (and, with --remote, they match), 1 no build, a
// difference, not published or a failure (closing the connection failing
// included), 2 usage.

const fs = require('node:fs');
const path = require('node:path');
const { defaultOut } = require('./build');
const { notBuilt, shownPath } = require('./validate');
const { parseArgs: parsePublishArgs } = require('./publish');
const remote = require('./remote');

const USAGE = 'usage: node kit/fixture/status.js <fixture-dir> [--db <file>] [--name <client>] [--database <name>] [--remote]';

const parseArgs = (argv) => parsePublishArgs(argv, { valued: ['--db', '--name', '--database'], flags: ['--remote'] });

async function main(argv, deps = {}) {
  const {
    env = process.env, cwd = process.cwd(), connect = remote.defaultConnect, readKeychain, platform,
    out = (s) => console.log(s), err = (s) => console.error(s),
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
    err(`fixture:status: --database: ${badName}`);
    return 2;
  }
  const db = args.db ? path.resolve(cwd, args.db) : defaultOut(fixtureDir, args.name, env);
  if (!fs.existsSync(db)) {
    err(`fixture:status: ${notBuilt(shownPath(cwd, db))}`);
    return 1;
  }
  const local = await remote.localSnapshot({ fixtureDir, db });
  out(`fixture:status: ${shownPath(cwd, db)}: local fixture version ${local.version}, as of ${local.asOf || 'unknown'}`);
  for (const [t, n] of Object.entries(local.counts)) out(`  ${t.padEnd(24)} ${n}`);
  if (local.stale.length) out(`  the build is older than the seeds (run npm run fixture:build):\n    ${local.stale.join('\n    ')}`);
  if (!args.remote) return 0;

  const { token, say, warn } = remote.openSecrets({ env, platform, readKeychain, out, err });
  if (!token) {
    warn(`fixture:status: ${remote.TOKEN_HELP}`);
    return 1;
  }
  // A close failure is reported (redacted) and makes the exit non-zero; an
  // earlier non-zero code stays.
  let conn;
  let code;
  try {
    conn = await connect({ token });
    code = await compareRemote(conn, { database, local, say });
  } catch (e) {
    warn(`fixture:status: MotherDuck failed: ${remote.firstLine(e.message)}`);
    code = 1;
  }
  if (!remote.closeConnection(conn, warn, 'fixture:status')) code = code || 1;
  return code;
}

async function compareRemote(conn, { database, local, say }) {
  const snap = await remote.remoteSnapshot(conn, database);
  if (!snap) {
    say(`fixture:status: ${database} is not on MotherDuck yet. Run npm run fixture:publish.`);
    return 1;
  }
  say(`fixture:status: remote ${database}: version ${snap.version || '(none recorded)'}, published ${snap.publishedAt || 'unknown'}`);
  const diff = remote.compare(local, snap);
  if (diff.match) {
    say('fixture:status: match: the shared copy is the local build');
    return 0;
  }
  say(`fixture:status: differs: the shared copy is not the local build:\n  ${diff.differences.join('\n  ')}`);
  return 1;
}

if (require.main === module) {
  // Anything main did not catch goes through the redactor, never a raw stack.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.exitCode = remote.reportUncaught(e);
  });
}

module.exports = { main, parseArgs, USAGE };
