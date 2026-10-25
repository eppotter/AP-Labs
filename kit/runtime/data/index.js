'use strict';

// The query runner (Story 7.5, AD-9, AD-10): the only way SQL runs.
//
// Only this file, the offline fixture builder (kit/fixture/build.js) and the
// human-run MotherDuck connection (kit/fixture/motherduck.js) may import
// @duckdb/node-api; a test fails on any other importer.
//
// Every call to run(sql, params) passes the kit/runtime/sql guardrail first,
// with the profile's forbidden columns. Parameters are bound as prepared-
// statement parameters by name ($zone), never spliced into the text: a key the
// caller did not declare is refused, and so is a placeholder with no value or
// a positional one ($1, ?).
//
// DuckDB opens the file with access_mode=READ_ONLY, enable_external_access=
// false and both extension auto-install/auto-load settings off, then
// lock_configuration=true, so no later SET can loosen it. The lockdown blocks
// files, the network and extensions on its own, even if the guardrail were
// bypassed; the guardrail is defence in depth in front of it.
//
// The source is the local fixture file (APLABS_DATA_PATH, else
// <var>/fixture/<client id>.duckdb) unless the profile says data.source:
// motherduck (plan motherduck-read; DEP-011 closed). Then it reads the one
// MotherDuck database data.database with the read key passed in as token,
// opened by the locked sequence in ./motherduck (MD_LOCKDOWN), with USE <db>
// on every connection. A missing or unreadable source never stops the app:
// open() and run() reject with a DataUnavailableError (kit/runtime/errors
// DataUnavailable; the words are in kit/runtime/messages), and a later run()
// tries to open it again.
//
// MotherDuck mode: connecting has a time limit (10s); one attempt runs at a
// time, and an attempt that finishes after its limit has its instance closed
// at once. Every DuckDB error from run() becomes a DataUnavailableError with a
// redacted reason; on anything but a catalog or binder error the instance is
// dropped and the next connect waits 30s. In both modes every query has a
// time limit (30s): a timer calls conn.interrupt() and run() rejects with a
// DataUnavailableError ("query timed out"). connect, the DuckDB instance
// factory, is injectable: tests pass a fake and never reach the network.

const fs = require('node:fs');
const path = require('node:path');
const { DuckDBInstance } = require('@duckdb/node-api');
const sqlGuard = require('../sql');
const { DataUnavailable: DataUnavailableError } = require('../errors');
const md = require('./motherduck');

const REPO = path.resolve(__dirname, '../../..');
const SOURCE = 'local fixture';
// describe().source by profile data.source.
const SOURCES = Object.freeze({ local: SOURCE, motherduck: md.SOURCE });

// Applied when the instance is created, in this order; lock_configuration is
// set after them with SET, once the instance is up.
const LOCKDOWN = Object.freeze({
  access_mode: 'READ_ONLY',
  enable_external_access: 'false',
  autoinstall_known_extensions: 'false',
  autoload_known_extensions: 'false',
});

// A query the runner refused before it reached DuckDB. rule is a guardrail
// rule (kit/runtime/sql RULES) or one of the parameter rules below.
class QueryRefusedError extends Error {
  constructor(rule, detail) {
    super(`query refused (${rule}): ${detail}`);
    this.name = 'QueryRefusedError';
    this.code = 'QUERY_REFUSED';
    this.rule = rule;
    this.detail = detail;
  }
}

const PARAM_RULES = Object.freeze({
  UNDECLARED: 'undeclared_parameter',
  MISSING: 'missing_parameter',
  POSITIONAL: 'positional_parameter',
  BAD_VALUE: 'bad_parameter_value',
});

// The profile's data source: 'local' (the default) or 'motherduck'.
const sourceOf = (profile) => (profile && profile.data && profile.data.source) || 'local';

// The data file for this client: APLABS_DATA_PATH (absolute), else the file
// `npm run fixture:build` writes. Returns { path } or { problem }.
function dataPathFor(profile, env = process.env) {
  if (env.APLABS_DATA_PATH) {
    if (!path.isAbsolute(env.APLABS_DATA_PATH)) return { problem: 'APLABS_DATA_PATH must be an absolute path' };
    return { path: env.APLABS_DATA_PATH };
  }
  const varDir = env.APLABS_VAR_DIR ? path.resolve(env.APLABS_VAR_DIR) : path.join(REPO, 'var');
  return { path: path.join(varDir, 'fixture', `${profile.client.id}.duckdb`) };
}

// Opens a file read-only and locked. Returns the instance; throws
// DataUnavailableError when the file is missing or DuckDB cannot open it.
async function openLocked(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new DataUnavailableError('the data file does not exist');
  let instance;
  try {
    instance = await DuckDBInstance.create(file, { ...LOCKDOWN });
    const conn = await instance.connect();
    try {
      await conn.run('SET lock_configuration = true');
    } finally {
      conn.closeSync();
    }
    return instance;
  } catch (err) {
    if (instance) instance.closeSync();
    throw new DataUnavailableError(`the data file could not be opened (${withoutPaths(firstLine(err.message), file)})`);
  }
}

// The default MotherDuck instance factory: DuckDB itself. Tests inject a fake
// with the same shape (create(path, options) -> instance).
const createInstance = (where, options) => DuckDBInstance.create(where, options);

function closeQuietly(target) {
  try { target.closeSync(); } catch { /* already closed or broken: nothing to keep */ }
}

// A DuckDB error as a DataUnavailableError with a redacted reason.
function mdUnavailable(err, token, what) {
  if (err instanceof DataUnavailableError) return err;
  if (md.classifyError(err) === 'missing_extension') return new DataUnavailableError(md.MISSING_EXTENSION);
  return new DataUnavailableError(`${what} (${md.reasonFor(err, [token])})`);
}

// Opens MotherDuck the locked way (./motherduck MD_LOCKDOWN) through create.
// Returns the instance, or throws DataUnavailableError (never the token).
// Never creates a database: a missing one fails the ATTACH.
async function openMotherDuck({ database, token, create }) {
  let instance;
  try {
    instance = await create(md.MD_LOCKDOWN.path, { ...md.MD_LOCKDOWN.instance });
  } catch (err) {
    throw mdUnavailable(err, token, 'DuckDB could not start');
  }
  try {
    const conn = await instance.connect();
    try {
      for (const sql of md.setupStatements(database, token)) await conn.run(sql);
      for (const sql of md.perConnectionStatements(database)) await conn.run(sql);
      const [row] = (await conn.runAndReadAll(md.OPEN_CHECK)).getRowObjectsJson();
      if (!row || row.db !== database) {
        throw new DataUnavailableError(`the connection is on ${md.reasonFor(String(row ? row.db : 'no database'), [token])}, not ${database}`);
      }
      if (!Number(row.meta)) throw new DataUnavailableError(`${database} has no fixture_meta table`);
    } finally {
      closeQuietly(conn);
    }
    return instance;
  } catch (err) {
    closeQuietly(instance);
    throw mdUnavailable(err, token, `MotherDuck database ${database} could not be opened`);
  }
}

function firstLine(s) {
  return String(s).split('\n')[0];
}

// DuckDB's error names the file by its full (often resolved) path. Keep only
// file names: first every spelling of this file's directory, then any other
// absolute path left (a WAL file, another directory).
function withoutPaths(text, file) {
  const dirs = new Set([path.dirname(file), path.dirname(path.resolve(file))]);
  try { dirs.add(path.dirname(fs.realpathSync(file))); } catch { /* gone: the spellings above remain */ }
  let out = text;
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) out = out.split(dir + path.sep).join('');
  return out.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s"'\\/]+[\\/])+([^\s"'\\/]+)/g, '$1');
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

function checkValue(name, v) {
  const ok = v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'bigint'
    || (typeof v === 'number' && Number.isFinite(v));
  if (!ok) throw new QueryRefusedError(PARAM_RULES.BAD_VALUE, `$${name} must be a string, finite number, boolean, bigint or null`);
}

// The template's placeholders, as DuckDB parsed them, against what the caller
// declared and passed.
function checkParams(prepared, params, declared) {
  const names = [];
  for (let i = 1; i <= prepared.parameterCount; i += 1) {
    const name = prepared.parameterName(i);
    if (/^\d+$/.test(name)) throw new QueryRefusedError(PARAM_RULES.POSITIONAL, 'parameters are bound by name ($name), never by position');
    names.push(name);
  }
  for (const key of Object.keys(params)) {
    if (!declared.has(key)) throw new QueryRefusedError(PARAM_RULES.UNDECLARED, `$${key} was not declared`);
    if (!names.includes(key)) throw new QueryRefusedError(PARAM_RULES.UNDECLARED, `$${key} is not a placeholder in the query`);
    checkValue(key, params[key]);
  }
  for (const name of names) {
    if (!declared.has(name)) throw new QueryRefusedError(PARAM_RULES.UNDECLARED, `$${name} was not declared`);
    if (!Object.hasOwn(params, name)) throw new QueryRefusedError(PARAM_RULES.MISSING, `$${name} has no value`);
  }
}

const seconds = (ms) => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);

// The data source. profile: its forbidden columns and data.source.
// Local: file, the DuckDB file. MotherDuck: token, the read key (the caller
// has registered it with the redactor), and connect, the instance factory
// (default DuckDB). Time limits (ms) and the clock are injectable for tests.
// Returns { open, run, describe, close }.
function createData({
  file = null,
  profile,
  token = null,
  connect = createInstance,
  connectTimeoutMs = md.CONNECT_TIMEOUT_MS,
  queryTimeoutMs = md.QUERY_TIMEOUT_MS,
  retryAfterMs = md.RETRY_AFTER_MS,
  now = Date.now,
} = {}) {
  const forbiddenColumns = sqlGuard.forbiddenColumnsOf(profile);
  const remote = sourceOf(profile) === 'motherduck';
  const database = remote ? profile.data.database : null;
  if (remote) {
    const bad = md.databaseNameProblem(database);
    if (bad) throw new TypeError(`data.database: ${bad}`);
    if (typeof token !== 'string' || !token) throw new TypeError(`MotherDuck mode needs the read key (${md.READ_TOKEN_ENV})`);
  }
  let instance = null;
  let opening = null; // the open() every caller waits on
  let inflight = false; // a MotherDuck attempt is still running, even past its limit
  let lastProblem = null;
  let retryAt = 0;
  let generation = 0; // close() bumps it: an attempt started before is never adopted

  function failed(err) {
    lastProblem = err.reason;
    if (remote) retryAt = now() + retryAfterMs;
    return err;
  }

  function openRemote() {
    const gen = generation;
    let timedOut = false;
    inflight = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(failed(new DataUnavailableError(`connecting to MotherDuck timed out after ${seconds(connectTimeoutMs)}`)));
      }, connectTimeoutMs);
      openMotherDuck({ database, token, create: connect }).then((inst) => {
        inflight = false;
        if (timedOut || gen !== generation) {
          closeQuietly(inst); // too late, or closed meanwhile: never adopted
          if (!timedOut) {
            clearTimeout(timer);
            reject(new DataUnavailableError('the data source was closed while connecting'));
          }
          return;
        }
        clearTimeout(timer);
        instance = inst;
        lastProblem = null;
        retryAt = 0;
        resolve();
      }, (err) => {
        inflight = false;
        if (timedOut) return; // already reported as timed out
        clearTimeout(timer);
        reject(failed(err));
      });
    });
  }

  async function open() {
    if (instance) return;
    if (!opening) {
      if (remote && inflight) throw new DataUnavailableError('a MotherDuck connect attempt is still running');
      if (remote && now() < retryAt) throw new DataUnavailableError(`waiting to reconnect to MotherDuck (${lastProblem})`);
      opening = (remote ? openRemote() : openLocked(file).then((inst) => {
        instance = inst;
        lastProblem = null;
      }, (err) => { throw failed(err); })).finally(() => { opening = null; });
    }
    await opening;
  }

  // Drops a MotherDuck instance after a failure. It is closed once after
  // (the query that failed) has settled.
  function drop(inst, reason, after = Promise.resolve()) {
    if (instance === inst) instance = null;
    lastProblem = reason;
    retryAt = now() + retryAfterMs;
    after.catch(() => {}).finally(() => closeQuietly(inst));
  }

  // A DuckDB error from run(): passed through locally; in MotherDuck mode a
  // DataUnavailableError, dropping the instance unless the query itself was
  // at fault (a catalog or binder error).
  async function duck(inst, fn) {
    try {
      return await fn();
    } catch (err) {
      if (!remote || err instanceof DataUnavailableError) throw err;
      const kind = md.classifyError(err);
      const reason = kind === 'missing_extension' ? md.MISSING_EXTENSION : `the MotherDuck query failed (${md.reasonFor(err, [token])})`;
      if (!md.keepsInstance(kind)) drop(inst, reason);
      throw new DataUnavailableError(reason);
    }
  }

  // Runs query with the time limit. On expiry the timer interrupts the
  // connection and the result rejects at once; the query may still settle
  // later (expired() then says so, and the caller closes after it).
  function timed(conn, inst, query) {
    let expired = false;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        expired = true;
        try { conn.interrupt(); } catch { /* the rejection below still stands */ }
        const reason = `query timed out after ${seconds(queryTimeoutMs)}`;
        if (remote) drop(inst, reason, query);
        reject(new DataUnavailableError(reason));
      }, queryTimeoutMs);
      query.then((v) => {
        clearTimeout(timer);
        if (!expired) resolve(v);
      }, (e) => {
        clearTimeout(timer);
        if (!expired) reject(e);
      });
    });
    return { result, query, expired: () => expired };
  }

  // Runs one read-only query. Returns rows as JSON-safe objects (BIGINT as a
  // string). Rejects with QueryRefusedError (guardrail or parameters),
  // DataUnavailableError, or (local only) DuckDB's own error.
  async function run(sql, params = {}, { declared = [] } = {}) {
    const verdict = sqlGuard.checkSql(sql, { forbiddenColumns });
    if (!verdict.ok) throw new QueryRefusedError(verdict.rule, verdict.detail);
    if (!isPlainObject(params)) throw new QueryRefusedError(PARAM_RULES.BAD_VALUE, 'params must be a plain object of named values');
    await open();
    const inst = instance;
    const conn = await duck(inst, () => inst.connect());
    let pending = null;
    try {
      if (remote) {
        for (const stmt of md.perConnectionStatements(database)) await duck(inst, () => conn.run(stmt));
      }
      const prepared = await duck(inst, () => conn.prepare(sql));
      checkParams(prepared, params, new Set(declared));
      if (prepared.parameterCount) await duck(inst, () => prepared.bind(params));
      pending = timed(conn, inst, Promise.resolve().then(() => prepared.runAndReadAll()));
      const reader = await duck(inst, () => pending.result);
      return reader.getRowObjectsJson();
    } finally {
      // A query that outlived its limit may still be running: close after it.
      if (pending && pending.expired()) pending.query.catch(() => {}).finally(() => closeQuietly(conn));
      else closeQuietly(conn);
    }
  }

  // What the person is told about the data source: its kind, and the file
  // name (never the full path) or the database name.
  function describe() {
    return {
      source: SOURCES[remote ? 'motherduck' : 'local'],
      label: remote ? database : path.basename(file),
      available: Boolean(instance),
      problem: instance ? null : lastProblem,
    };
  }

  function close() {
    generation += 1;
    if (instance) instance.closeSync();
    instance = null;
  }

  return Object.freeze({ open, run, describe, close });
}

module.exports = {
  createData,
  openLocked,
  openMotherDuck,
  dataPathFor,
  sourceOf,
  DataUnavailableError,
  QueryRefusedError,
  PARAM_RULES,
  LOCKDOWN,
  SOURCE,
  SOURCES,
};
