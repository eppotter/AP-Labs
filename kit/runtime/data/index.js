'use strict';

// The query runner (Story 7.5, AD-9, AD-10): the only way SQL runs.
//
// Only this file and the offline fixture builder (kit/fixture/build.js) may
// import @duckdb/node-api; a test fails on any other importer.
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
// V1 reads the local fixture file only (APLABS_DATA_PATH, else
// <var>/fixture/<client id>.duckdb). Reading MotherDuck is deferred (DEP-011).
// A missing or unreadable file never stops the app: open() and run() reject
// with a DataUnavailableError, and the next run() tries to open it again.

const fs = require('node:fs');
const path = require('node:path');
const { DuckDBInstance } = require('@duckdb/node-api');
const sqlGuard = require('../sql');

const REPO = path.resolve(__dirname, '../../..');
const SOURCE = 'local fixture';

// Applied when the instance is created, in this order; lock_configuration is
// set after them with SET, once the instance is up.
const LOCKDOWN = Object.freeze({
  access_mode: 'READ_ONLY',
  enable_external_access: 'false',
  autoinstall_known_extensions: 'false',
  autoload_known_extensions: 'false',
});

const DATA_UNAVAILABLE = "The data isn't available right now, so I can't answer that. "
  + 'The app is still running; please tell your admin.';

class DataUnavailableError extends Error {
  constructor(reason) {
    super(`data unavailable: ${reason}`);
    this.name = 'DataUnavailableError';
    this.code = 'DATA_UNAVAILABLE';
    this.reason = reason;
  }
}

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
    throw new DataUnavailableError(`the data file could not be opened (${firstLine(err.message)})`);
  }
}

function firstLine(s) {
  return String(s).split('\n')[0];
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

// The data source. file: the DuckDB file; profile: for its forbidden columns.
// Returns { open, run, describe, close }.
function createData({ file, profile }) {
  const forbiddenColumns = sqlGuard.forbiddenColumnsOf(profile);
  let instance = null;
  let opening = null;
  let lastProblem = null;

  async function open() {
    if (instance) return;
    if (!opening) {
      opening = openLocked(file).then((inst) => {
        instance = inst;
        lastProblem = null;
      }, (err) => {
        lastProblem = err.reason;
        throw err;
      }).finally(() => { opening = null; });
    }
    await opening;
  }

  // Runs one read-only query. Returns rows as JSON-safe objects (BIGINT as a
  // string). Rejects with QueryRefusedError (guardrail or parameters),
  // DataUnavailableError, or DuckDB's own error.
  async function run(sql, params = {}, { declared = [] } = {}) {
    const verdict = sqlGuard.checkSql(sql, { forbiddenColumns });
    if (!verdict.ok) throw new QueryRefusedError(verdict.rule, verdict.detail);
    if (!isPlainObject(params)) throw new QueryRefusedError(PARAM_RULES.BAD_VALUE, 'params must be a plain object of named values');
    await open();
    const conn = await instance.connect();
    try {
      const prepared = await conn.prepare(sql);
      checkParams(prepared, params, new Set(declared));
      if (prepared.parameterCount) prepared.bind(params);
      return (await prepared.runAndReadAll()).getRowObjectsJson();
    } finally {
      conn.closeSync();
    }
  }

  // What the person is told about the data source. Never the full path.
  function describe() {
    return { source: SOURCE, file: path.basename(file), available: Boolean(instance), problem: instance ? null : lastProblem };
  }

  function close() {
    if (instance) instance.closeSync();
    instance = null;
  }

  return Object.freeze({ open, run, describe, close });
}

module.exports = {
  createData,
  openLocked,
  dataPathFor,
  DataUnavailableError,
  QueryRefusedError,
  PARAM_RULES,
  LOCKDOWN,
  DATA_UNAVAILABLE,
  SOURCE,
};
