'use strict';

// What fixture:publish and fixture:status share (Story 7.7, AD-12, AD-18):
// the MotherDuck token, the shared database's name, the fixture version, and
// a snapshot of a local build or a remote copy (version and row counts).
//
// Publishing is a human-run path, separate from the runtime: the app never
// loads this file and never reads MotherDuck (DEP-011). The only code here
// that opens a network connection is ./motherduck's connect(), and callers
// inject their own (tests pass a fake), so nothing in this file needs DuckDB.
//
// The token is read through kit/lib/secrets (MOTHERDUCK_TOKEN, else the
// Keychain item aplabs-motherduck-token) and registered with kit/runtime/log's
// redactor before any connection opens, so every line a caller prints, a
// DuckDB error included, has it masked.
//
// The fixture version is <generator_version>+<first 12 hex of seedsHash>:
// the generator's own number, plus a hash of schema.sql and seeds/*.csv, so a
// hand edit or a generator change without a version bump still shows.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readSecret } = require('../lib/secrets');
const { createLog } = require('../runtime/log');
const { createData } = require('../runtime/data');
const { schemaTables } = require('./build');

const TOKEN_ENV = 'MOTHERDUCK_TOKEN';
const TOKEN_KEYCHAIN = 'aplabs-motherduck-token';
const DOC = 'docs/runtime/motherduck-publish.md';
const TOKEN_HELP = [
  'no MotherDuck token. Set it one of two ways:',
  `  export ${TOKEN_ENV}=...    (this shell only)`,
  `  security add-generic-password -s ${TOKEN_KEYCHAIN} -a aplabs -w    (macOS Keychain; prompts for it)`,
  `See ${DOC}.`,
].join('\n');

// The table publish adds to the remote copy: key/value rows recording what
// was published. It is never part of the local build.
const PUBLISH_TABLE = 'fixture_publish';
const META_TABLE = 'fixture_meta';
const STAGING_SUFFIX = '__publishing';
// MotherDuck's default database, which the connection opens on: never a target.
const RESERVED = new Set(['my_db']);
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

// The shared database: --database, else <client>_fixture, where <client> is
// --name or the folder holding the fixture dir (as kit/fixture/build names
// the local file).
function databaseNameFor(fixtureDir, { name = null, database = null } = {}) {
  if (database) return database;
  const client = name || path.basename(path.dirname(path.resolve(fixtureDir)));
  return `${client.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_fixture`;
}

// Why a database name can't be used, or null. Names are spliced into SQL as
// quoted identifiers, so only plain lower-case identifiers are allowed.
function databaseNameProblem(name) {
  if (!NAME.test(name)) return `"${name}" is not a plain name (lower-case letters, digits and _, up to 63, not starting with a digit)`;
  if (RESERVED.has(name)) return `"${name}" is MotherDuck's default database`;
  if (name.endsWith(STAGING_SUFFIX)) return `"${name}" ends with ${STAGING_SUFFIX}, which publish uses for its staging copy`;
  return null;
}

const stagingNameFor = (database) => `${database}${STAGING_SUFFIX}`;

// sha256 over schema.sql and seeds/*.csv in name order, each framed by its
// name and length so moving bytes between files changes the hash.
function seedsHash(fixtureDir) {
  const dir = path.resolve(fixtureDir);
  const files = ['schema.sql', ...fs.readdirSync(path.join(dir, 'seeds')).filter((f) => f.endsWith('.csv')).sort().map((f) => `seeds/${f}`)];
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const body = fs.readFileSync(path.join(dir, rel));
    h.update(`${rel}\0${body.length}\0`);
    h.update(body);
  }
  return h.digest('hex');
}

const versionOf = (generatorVersion, sha) => `${generatorVersion || 'unknown'}+${sha.slice(0, 12)}`;

// seeds/fixture_meta.csv as a map. Its values are plain (no quoted commas).
function seedMeta(fixtureDir) {
  const lines = fs.readFileSync(path.join(path.resolve(fixtureDir), 'seeds', `${META_TABLE}.csv`), 'utf8').split(/\r?\n/).slice(1);
  const meta = new Map();
  for (const line of lines) {
    if (!line) continue;
    const i = line.indexOf(',');
    meta.set(line.slice(0, i), line.slice(i + 1));
  }
  return meta;
}

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The local build, read through the read-only query runner (kit/runtime/data).
// stale lists every fixture_meta key where the build and the seeds disagree:
// the seeds changed after the last build.
async function localSnapshot({ fixtureDir, db }) {
  const tables = schemaTables(fs.readFileSync(path.join(path.resolve(fixtureDir), 'schema.sql'), 'utf8'));
  const data = createData({ file: db, profile: { sql: { forbidden_columns: [] } } });
  try {
    const built = new Map((await data.run(`SELECT key, value FROM ${META_TABLE}`)).map((r) => [r.key, r.value]));
    const counts = {};
    for (const t of tables) counts[t] = Number((await data.run(`SELECT count(*) AS n FROM ${ident(t)}`))[0].n);
    const seeds = seedMeta(fixtureDir);
    const stale = [];
    for (const key of [...new Set([...built.keys(), ...seeds.keys()])].sort()) {
      if (built.get(key) !== seeds.get(key)) {
        stale.push(`${key}: the build has ${built.get(key) ?? '(none)'}, seeds/${META_TABLE}.csv has ${seeds.get(key) ?? '(none)'}`);
      }
    }
    const generatorVersion = built.get('generator_version') || null;
    const seedsSha256 = seedsHash(fixtureDir);
    return { generatorVersion, asOf: built.get('as_of') || null, seedsSha256, version: versionOf(generatorVersion, seedsSha256), counts, stale };
  } finally {
    data.close();
  }
}

// A database on the connection: null when it doesn't exist. published says
// whether it has a fixture_publish table (this tool published it); version
// and the other recorded values are null when it has none. counts never
// include fixture_publish.
async function remoteSnapshot(conn, database) {
  const exists = await conn.run(`SELECT count(*)::VARCHAR AS n FROM duckdb_databases() WHERE database_name = ${sqlString(database)}`);
  if (exists[0].n === '0') return null;
  const tables = (await conn.run(
    `SELECT table_name FROM information_schema.tables WHERE table_catalog = ${sqlString(database)} AND table_schema = 'main' ORDER BY table_name`,
  )).map((r) => r.table_name);
  const counts = {};
  for (const t of tables) {
    if (t === PUBLISH_TABLE) continue;
    counts[t] = Number((await conn.run(`SELECT count(*)::VARCHAR AS n FROM ${ident(database)}.main.${ident(t)}`))[0].n);
  }
  const recorded = tables.includes(PUBLISH_TABLE)
    ? new Map((await conn.run(`SELECT key, value FROM ${ident(database)}.main.${PUBLISH_TABLE}`)).map((r) => [r.key, r.value]))
    : new Map();
  return {
    published: tables.includes(PUBLISH_TABLE),
    version: recorded.get('fixture_version') || null,
    generatorVersion: recorded.get('generator_version') || null,
    seedsSha256: recorded.get('seeds_sha256') || null,
    publishedAt: recorded.get('published_at') || null,
    counts,
  };
}

// Local against remote: the version, then every table on either side.
function compare(local, remote) {
  const differences = [];
  if (local.version !== remote.version) differences.push(`version: local ${local.version}, remote ${remote.version || '(none recorded)'}`);
  const tables = [...new Set([...Object.keys(local.counts), ...Object.keys(remote.counts)])];
  for (const t of tables) {
    const l = local.counts[t];
    const r = remote.counts[t];
    if (l !== r) differences.push(`${t}: local ${l ?? '(missing)'}, remote ${r ?? '(missing)'}`);
  }
  return { match: differences.length === 0, differences };
}

// The token and a redacting printer. Returns { token, say, warn } with
// token null when none is configured; say/warn mask the token in every line.
// deps: env, platform, readKeychain (tests stub the Keychain), out, err.
// Every token read in this process is also registered with `known`, so the
// CLIs' top-level handlers (reportUncaught) can mask it too.
const known = createLog({ write: () => {} });

function openSecrets({ env, platform, readKeychain, out, err }) {
  const log = createLog({ write: () => {} });
  const token = readSecret(TOKEN_ENV, TOKEN_KEYCHAIN, { env, platform, readKeychain });
  log.registerSecret(token);
  known.registerSecret(token);
  return { token, say: (s) => out(log.redact(s)), warn: (s) => err(log.redact(s)) };
}

const firstLine = (s) => String(s).split('\n')[0];

// Closes a connection without letting a close error escape: it goes through
// the redacting warn instead. Returns false when close failed; callers then
// exit non-zero, keeping an earlier non-zero code (see publish and status).
function closeConnection(conn, warn, label) {
  if (!conn) return true;
  try {
    conn.close();
    return true;
  } catch (e) {
    warn(`${label}: closing the MotherDuck connection failed: ${firstLine(e?.message ?? e)}`);
    return false;
  }
}

// The CLIs' top-level handler: prints an error main did not catch, with every
// token read in this process (and the log's token patterns) masked, never a
// raw stack. Returns the exit code, 1.
function reportUncaught(e, { err = (s) => console.error(s) } = {}) {
  err(known.redact(e?.stack || String(e)));
  return 1;
}

// The default connection (./motherduck, the only DuckDB importer here), loaded
// only when a command really connects.
const defaultConnect = (opts) => require('./motherduck').connect(opts);

module.exports = {
  TOKEN_ENV,
  TOKEN_KEYCHAIN,
  TOKEN_HELP,
  PUBLISH_TABLE,
  STAGING_SUFFIX,
  databaseNameFor,
  databaseNameProblem,
  stagingNameFor,
  seedsHash,
  localSnapshot,
  remoteSnapshot,
  compare,
  openSecrets,
  firstLine,
  closeConnection,
  reportUncaught,
  ident,
  sqlString,
  defaultConnect,
};
