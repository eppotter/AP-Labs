'use strict';

// Fixture build (Story 7.3, AD-9, AD-18).
//
//   npm run fixture:build
//   node kit/fixture/build.js <fixture-dir> [--out <file>] [--name <client>]
//
// Loads <fixture-dir>/schema.sql and every <fixture-dir>/seeds/<table>.csv
// into a local DuckDB file, offline. The default file is
// var/fixture/<name>.duckdb (var/ is APLABS_VAR_DIR, else the repo's
// gitignored var/). <name> defaults to the governing profile's client id, the
// file the runtime reads (kit/runtime/data dataPathFor), else the folder
// holding the fixture dir (for example <client>/fixture -> <client>).
//
// This is the only code that opens DuckDB for writing, and the app never
// loads it: the runtime reads the built file read-only (kit/runtime/data).
// The build writes to a temporary file and renames it into place, so a
// rebuild replaces the old file whole and a failed build leaves it untouched.
// After loading, every table's row count must equal fixture_meta's
// rows_<table>, and every seed file's header must match its table's columns.
// The build stamps fixture_meta with a table comment, so the validator can
// tell its output from any other file (issue #77): a check may read a
// protected column only there. The stamp names a sha256 of the file's whole
// content (contentDigest: every table's columns and rows, every view and
// macro), and isFixtureBuild recomputes it, so a stamp written by hand, or
// copied from a build onto other rows, is not a build (issue #87). Publish
// goes further (isBuildOf): the file must equal a fresh build of the seeds.
// Exit codes: 0 built, 1 build failed, 2 usage or profile error.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DuckDBInstance } = require('@duckdb/node-api');
const { governingProfilePath, loadProfile } = require('../lib/profile');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const META_TABLE = 'fixture_meta';
// A comment, not a row or a table: the data, row counts and published tables
// stay exactly the seeds. The stamp is STAMP_PREFIX plus the content digest.
const STAMP_PREFIX = 'aplabs fixture:build (synthetic seeds)';
const STAMP = /^aplabs fixture:build \(synthetic seeds\) content-sha256:([0-9a-f]{64})$/;
const stampFor = (digest) => `${STAMP_PREFIX} content-sha256:${digest}`;

const USAGE = 'usage: node kit/fixture/build.js <fixture-dir> [--out <file>] [--name <client>]';

class FixtureBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FixtureBuildError';
  }
}

function parseArgs(argv) {
  const args = { fixtureDir: null, out: null, name: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--out' || a === '--name') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) return { error: `${a} needs a value` };
      args[a.slice(2)] = v;
      i += 1;
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

// clientId: the governing profile's client.id, so the default file is the
// one dataPathFor names (issue #77). --name still wins.
function defaultOut(fixtureDir, name, env = process.env, clientId = null) {
  const client = name || clientId || path.basename(path.dirname(path.resolve(fixtureDir)));
  const varDir = env.APLABS_VAR_DIR ? path.resolve(env.APLABS_VAR_DIR) : path.join(REPO_ROOT, 'var');
  return path.join(varDir, 'fixture', `${client}.duckdb`);
}

// The governing profile's client id, or null when no profile governs. A
// profile that can't be loaded throws its ProfileError.
function governingClientId(cwd, env) {
  const file = governingProfilePath(null, cwd, env);
  return file ? loadProfile(file).client.id : null;
}

// Table names in the order schema.sql creates them, so foreign keys load
// parents first.
function schemaTables(schemaSql) {
  const names = [];
  for (const m of schemaSql.matchAll(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gim)) {
    names.push(m[1]);
  }
  return names;
}

function sqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function ident(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0].replace(/\r$/, '');
    return first.split(',');
  } finally {
    fs.closeSync(fd);
  }
}

function removeDb(file) {
  for (const f of [file, `${file}.wal`]) fs.rmSync(f, { force: true });
}

// Plan the build from the files alone, before DuckDB opens: every problem at once.
function plan(fixtureDir) {
  const dir = path.resolve(fixtureDir);
  const schemaFile = path.join(dir, 'schema.sql');
  const seedsDir = path.join(dir, 'seeds');
  if (!fs.existsSync(schemaFile)) throw new FixtureBuildError(`no schema.sql in ${dir}`);
  if (!fs.existsSync(seedsDir)) throw new FixtureBuildError(`no seeds/ folder in ${dir}`);
  const schemaSql = fs.readFileSync(schemaFile, 'utf8');
  const tables = schemaTables(schemaSql);
  if (tables.length === 0) throw new FixtureBuildError(`schema.sql in ${dir} creates no tables`);
  const seeds = fs.readdirSync(seedsDir).filter((f) => f.endsWith('.csv')).map((f) => f.slice(0, -4));
  const problems = [];
  for (const t of tables) if (!seeds.includes(t)) problems.push(`table ${t} has no seeds/${t}.csv`);
  for (const s of seeds) if (!tables.includes(s)) problems.push(`seeds/${s}.csv has no table in schema.sql`);
  if (problems.length) throw new FixtureBuildError(`fixture ${dir} is inconsistent:\n  ${problems.join('\n  ')}`);
  return { dir, schemaSql, tables: tables.map((name) => ({ name, csv: path.join(seedsDir, `${name}.csv`) })) };
}

// Every header is checked before any row loads, so one bad seed reports
// itself instead of surfacing as a foreign-key error in a child table.
async function load(conn, p) {
  await conn.run(p.schemaSql);
  const problems = [];
  for (const t of p.tables) {
    const cols = (await conn.runAndReadAll(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position',
      [t.name],
    )).getRows().map((r) => r[0]);
    const header = readHeader(t.csv);
    if (header.join(',') !== cols.join(',')) {
      problems.push(`seeds/${t.name}.csv header (${header.join(',')}) does not match table columns (${cols.join(',')})`);
    }
  }
  if (problems.length) throw new FixtureBuildError(`seed headers do not match schema.sql:\n  ${problems.join('\n  ')}`);
  for (const t of p.tables) {
    await conn.run(`COPY ${ident(t.name)} FROM ${sqlString(t.csv)} (FORMAT csv, HEADER true)`);
  }
}

async function countRows(conn, p) {
  const counts = {};
  for (const t of p.tables) {
    const reader = await conn.runAndReadAll(`SELECT count(*)::VARCHAR FROM ${ident(t.name)}`);
    counts[t.name] = Number(reader.getRows()[0][0]);
  }
  return counts;
}

// fixture_meta's rows_<table> is the generator's record of each table's size.
// Every loaded table but fixture_meta must have one, and each must match.
async function checkCounts(conn, p, counts) {
  if (!p.tables.some((t) => t.name === META_TABLE)) {
    throw new FixtureBuildError(`schema.sql has no ${META_TABLE} table, so row counts can't be checked`);
  }
  const rows = (await conn.runAndReadAll(
    `SELECT key, value FROM ${META_TABLE} WHERE key LIKE 'rows\\_%' ESCAPE '\\'`,
  )).getRows();
  const expected = Object.fromEntries(rows.map(([k, v]) => [k.slice('rows_'.length), v]));
  const problems = [];
  for (const [table, want] of Object.entries(expected)) {
    if (!(table in counts)) problems.push(`${META_TABLE} has rows_${table} but there is no table ${table}`);
    else if (String(counts[table]) !== want) problems.push(`${table}: ${counts[table]} rows loaded, ${META_TABLE} says ${want}`);
  }
  for (const t of p.tables) {
    if (t.name !== META_TABLE && !(t.name in expected)) problems.push(`${META_TABLE} has no rows_${t.name}`);
  }
  if (problems.length) throw new FixtureBuildError(`row counts do not match ${META_TABLE}:\n  ${problems.join('\n  ')}`);
}

// Opens a file read-only and passes fn a runner (sql -> rows of JSON-safe
// values, BIGINT as a string).
async function withReadOnly(file, fn) {
  const instance = await DuckDBInstance.create(file, { access_mode: 'READ_ONLY' });
  try {
    const conn = await instance.connect();
    try {
      return await fn(async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson());
    } finally {
      conn.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

// Reads a built file read-only. Tests use this rather than importing
// @duckdb/node-api themselves, so the only importers stay kit/runtime/data
// and this file (AD-9).
async function readRows(file, sql) {
  return withReadOnly(file, (run) => run(sql));
}

// sha256 over everything a file holds that publish would upload: every table
// in every schema (its name, column names and types, row count and an
// order-independent digest of its rows as JSON), then every view and macro.
// Table comments are not content, so stamping does not change it.
async function contentDigest(run) {
  const h = crypto.createHash('sha256');
  const add = (part) => h.update(`${JSON.stringify(part)}\n`);
  const here = 'database_name = current_database()';
  const tables = await run(`SELECT schema_name, table_name FROM duckdb_tables() WHERE ${here} ORDER BY schema_name, table_name`);
  for (const { schema_name: schema, table_name: table } of tables) {
    const columns = (await run(
      `SELECT column_name, data_type FROM duckdb_columns() WHERE ${here} AND schema_name = ${sqlString(schema)} AND table_name = ${sqlString(table)} ORDER BY column_index`,
    )).map((c) => [c.column_name, c.data_type]);
    const [rows] = await run(
      `SELECT count(*)::VARCHAR AS n, coalesce(sha256(string_agg(h, ',' ORDER BY h)), '') AS d FROM (SELECT md5(to_json(x)::VARCHAR) AS h FROM ${ident(schema)}.${ident(table)} AS x)`,
    );
    add(['table', schema, table, columns, rows.n, rows.d]);
  }
  for (const v of await run(`SELECT schema_name, view_name, sql FROM duckdb_views() WHERE ${here} AND NOT internal ORDER BY schema_name, view_name`)) {
    add(['view', v.schema_name, v.view_name, v.sql]);
  }
  for (const m of await run(`SELECT schema_name, function_name, function_type, coalesce(macro_definition, '') AS def FROM duckdb_functions() WHERE ${here} AND NOT internal ORDER BY ALL`)) {
    add(['function', m.schema_name, m.function_name, m.function_type, m.def]);
  }
  return h.digest('hex');
}

// True when `file` carries a build stamp naming its own content digest: a
// file this build wrote and nothing has changed since. False for anything
// else, a missing or non-DuckDB file, a fixed stamp, or a stamp carried onto
// other data included (issues #77, #87).
async function isFixtureBuild(file) {
  if (!fs.existsSync(file)) return false;
  try {
    return await withReadOnly(file, async (run) => {
      const rows = await run(`SELECT comment FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main' AND table_name = ${sqlString(META_TABLE)}`);
      const m = rows.length === 1 && STAMP.exec(rows[0].comment || '');
      return Boolean(m) && m[1] === await contentDigest(run);
    });
  } catch {
    return false;
  }
}

// True when `file` holds exactly what building `fixtureDir` holds now: it
// rebuilds the seeds into a temporary directory and compares content
// digests. No stamp can stand in for this, so publish uses it to upload only
// the synthetic seeds (issue #87). A fixture that won't build throws its
// FixtureBuildError; an unreadable file is false.
async function isBuildOf(file, fixtureDir) {
  if (!fs.existsSync(file)) return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-fixture-rebuild-'));
  try {
    const fresh = path.join(dir, 'fresh.duckdb');
    await build({ fixtureDir, out: fresh, stamp: false });
    const want = await withReadOnly(fresh, contentDigest);
    let got;
    try {
      got = await withReadOnly(file, contentDigest);
    } catch {
      return false;
    }
    return got === want;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// stamp: false leaves the stamp off, so a test can stand in for a file the
// build did not write; a string writes that comment instead, so a test can
// stand in for a forged or carried stamp.
async function build({ fixtureDir, out, stamp = true }) {
  const started = Date.now();
  const p = plan(fixtureDir);
  const target = path.resolve(out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.building-${process.pid}`;
  removeDb(tmp);

  let instance;
  let conn;
  let counts;
  try {
    instance = await DuckDBInstance.create(tmp);
    conn = await instance.connect();
    await load(conn, p);
    counts = await countRows(conn, p);
    await checkCounts(conn, p, counts);
    if (stamp) {
      const comment = typeof stamp === 'string'
        ? stamp
        : stampFor(await contentDigest(async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson()));
      await conn.run(`COMMENT ON TABLE ${ident(META_TABLE)} IS ${sqlString(comment)}`);
    }
    await conn.run('CHECKPOINT');
  } catch (err) {
    if (conn) conn.closeSync();
    if (instance) instance.closeSync();
    removeDb(tmp);
    if (err instanceof FixtureBuildError) throw err;
    throw new FixtureBuildError(`DuckDB load failed: ${err.message}`);
  }
  conn.closeSync();
  instance.closeSync();

  removeDb(target);
  fs.renameSync(tmp, target);
  fs.rmSync(`${tmp}.wal`, { force: true });
  return { out: target, tables: p.tables.map((t) => ({ name: t.name, rows: counts[t.name] })), ms: Date.now() - started };
}

async function main(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    return 2;
  }
  const fixtureDir = path.resolve(cwd, args.fixtureDir);
  let clientId = null;
  if (!args.out && !args.name) {
    try {
      clientId = governingClientId(cwd, env);
    } catch (err) {
      if (err.code !== 'PROFILE_INVALID') throw err;
      console.error(`fixture:build: ${err.message}`);
      return 2;
    }
  }
  const out = args.out ? path.resolve(cwd, args.out) : defaultOut(fixtureDir, args.name, env, clientId);
  try {
    const result = await build({ fixtureDir, out });
    const total = result.tables.reduce((n, t) => n + t.rows, 0);
    console.log(`fixture:build: ${path.relative(cwd, result.out) || result.out}: ${result.tables.length} tables, ${total} rows, ${(result.ms / 1000).toFixed(1)}s`);
    return 0;
  } catch (err) {
    if (!(err instanceof FixtureBuildError)) throw err;
    console.error(`fixture:build: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(err.stack || String(err));
    process.exitCode = 1;
  });
}

module.exports = { build, readRows, isFixtureBuild, isBuildOf, STAMP_PREFIX, main, parseArgs, defaultOut, governingClientId, schemaTables, FixtureBuildError, USAGE };
