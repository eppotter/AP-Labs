'use strict';

// Ask's connection (plan brightside-v1, D10, Story 19.7): the only way an
// Ask query runs. Story 19.8 calls it; nothing else may.
//
// Its own DuckDB instance on the local data file, opened by ./index
// openLocked: read-only, external access and extension loading off, and
// memory_limit 512MB and threads 2 set before lock_configuration, so Ask's
// queries can't starve the tools' runner (kit/runtime/data createData).
//
// open() is boot's check (kit/runtime/app): it reads the data's columns and
// refuses (AskConfigError, naming each) an ask.tables table or column the
// data doesn't have, or an allowed column whose bare name a hidden one
// shares (kit/runtime/sql/ask askTablesProblems). The first open that passes
// fixes Ask's forbidden columns: the profile's sql.forbidden_columns plus
// every column of an allowed table that ask.tables doesn't list.
//
// run(sql, params, { declared }) runs one query, one at a time: a second
// while one runs is refused (busy), never queued. In order:
//   1. kit/runtime/sql checkSql with the forbidden columns and allowedTables;
//   2. the trailing `;` stripped (withoutTrailingSemicolon);
//   3. the data's columns read again and DuckDB's own parse of the SQL
//      (json_serialize_sql, as kit/query-rules reads it) checked by
//      kit/runtime/sql/ask checkParsed, which also catches a column added
//      after boot;
//   4. the SQL prepared as it is (never wrapped in other text), its
//      parameters bound by name ($name, as createData's run), and streamed:
//      at most 51 rows are read, then the result is closed;
//   5. a 10-second limit: the connection is interrupted and run() rejects at
//      once; the next query waits until the interrupted one has stopped.
// Any refusal or failure rejects with an AskQueryRefused (kit/runtime/errors)
// holding a fixed rule or error class only. DuckDB's error text never leaves
// this file, not even to the log (architect P2-5): it can name a hidden
// column or hold a value. Resolves { rows, columns, tables, ordered }.
//
// Local data only: with data.source: motherduck, open() refuses (data
// unavailable) and Ask's queries stay off. The instance factory, the clock's
// timers (default: the global ones, so node:test mock.timers freezes them)
// and the limits are injectable for tests.

const { RuntimeRefusal, DataUnavailable: DataUnavailableError, AskQueryRefused } = require('../errors');
const sqlGuard = require('../sql');
const { askTablesProblems, askForbiddenColumns, checkParsed } = require('../sql/ask');
const { openLocked, sourceOf } = require('./index');
const { checkParams, isPlainObject } = require('./params');

function closeQuietly(target) {
  try { target.closeSync(); } catch { /* already closed or broken: nothing to keep */ }
}

// Every table's columns in the data, and DuckDB's parse of a SQL text (it
// parses only: nothing runs). The same reads kit/query-rules uses.
const COLUMNS_SQL = [
  'SELECT table_name, column_name',
  'FROM information_schema.columns',
  'WHERE table_catalog = current_database() AND table_schema = current_schema()',
].join('\n');
const PARSE_SQL = 'SELECT json_serialize_sql(CAST($sql AS VARCHAR)) AS parsed';

const ASK_SETTINGS = Object.freeze({ memory_limit: '512MB', threads: '2' });
const ASK_LIMITS = Object.freeze({ timeoutMs: 10000, maxRows: 51 });

// DuckDB's error kinds, by the words its messages start with. Anything else
// is 'other'. Only the kind is ever logged.
const ERROR_CLASSES = Object.freeze([
  ['Binder Error', 'binder'], ['Catalog Error', 'catalog'], ['Parser Error', 'parser'],
  ['Conversion Error', 'conversion'], ['Out of Memory Error', 'out_of_memory'], ['Out of Range Error', 'out_of_range'],
  ['INTERRUPT Error', 'interrupt'], ['Interrupt Error', 'interrupt'], ['Invalid Input Error', 'invalid_input'],
  ['Permission Error', 'permission'], ['Not implemented Error', 'not_implemented'], ['Invalid Error', 'invalid'],
]);
function errorClassOf(err) {
  const text = String((err && err.message) || '');
  const hit = ERROR_CLASSES.find(([prefix]) => text.startsWith(prefix));
  return hit ? hit[1] : 'other';
}

// Boot's refusal: the profile's ask block doesn't fit the data.
class AskConfigError extends Error {
  constructor(problems) {
    super(`Ask's tables don't fit the data: ${problems.join('; ')}`);
    this.name = 'AskConfigError';
    this.code = 'ASK_CONFIG';
    this.problems = problems;
  }
}

const QUIET = Object.freeze({ info() {}, warn() {}, error() {} });

async function readColumns(conn) {
  const out = new Map();
  for (const r of (await conn.runAndReadAll(COLUMNS_SQL)).getRowObjectsJson()) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Set());
    out.get(r.table_name).add(r.column_name);
  }
  return out;
}

async function parseOf(conn, sql) {
  const reader = await conn.runAndReadAll(PARSE_SQL, { sql });
  const [row] = reader.getRowObjectsJson();
  try {
    return JSON.parse(row.parsed);
  } catch {
    return null; // checkParsed refuses it
  }
}

function createAskData({
  file = null,
  profile,
  log = QUIET,
  openInstance = (where, settings) => openLocked(where, settings),
  timeoutMs = ASK_LIMITS.timeoutMs,
  maxRows = ASK_LIMITS.maxRows,
  timers = null, // { setTimeout, clearTimeout }; default: the global ones, read at each use
} = {}) {
  if (!profile || !profile.ask || !profile.ask.tables) throw new TypeError('Ask\'s connection needs the profile\'s ask block');
  const allowed = profile.ask.tables;
  const allowedTables = Object.keys(allowed);
  const profileForbidden = sqlGuard.forbiddenColumnsOf(profile);
  const remote = sourceOf(profile) === 'motherduck';
  let instance = null;
  let opening = null;
  let forbidden = null; // fixed by the first open that passes (boot)
  let knownTables = [];
  let busy = false;
  let lastProblem = null;

  async function openOnce() {
    if (remote) throw new DataUnavailableError('Ask\'s queries read the local data file only');
    if (typeof file !== 'string' || !file) throw new DataUnavailableError('no data file');
    const inst = await openInstance(file, { ...ASK_SETTINGS });
    try {
      const conn = await inst.connect();
      let columns;
      try {
        columns = await readColumns(conn);
      } finally {
        closeQuietly(conn);
      }
      const problems = askTablesProblems(allowed, columns, profileForbidden);
      if (problems.length) throw new AskConfigError(problems);
      if (!forbidden) forbidden = askForbiddenColumns(allowed, columns, profileForbidden);
      knownTables = [...columns.keys()].filter((t) => /^[a-z_][a-z0-9_]*$/.test(t));
      instance = inst;
      lastProblem = null;
    } catch (err) {
      closeQuietly(inst);
      if (err instanceof AskConfigError || err instanceof DataUnavailableError) throw err;
      throw new DataUnavailableError(`Ask's connection could not read the data (${errorClassOf(err)})`);
    }
  }

  // Opens Ask's instance and runs boot's check. Rejects with
  // DataUnavailableError (try again later) or AskConfigError (the profile
  // must change).
  async function open() {
    if (instance) return;
    if (!opening) {
      opening = openOnce().catch((err) => {
        lastProblem = err.code === 'ASK_CONFIG' ? 'ask.tables does not fit the data' : err.reason;
        throw err;
      }).finally(() => { opening = null; });
    }
    await opening;
  }

  function refuse(reason, extra = {}) {
    log.warn('ask query refused', { reason, ...extra });
    return new AskQueryRefused(reason, extra);
  }

  // Why a run couldn't open the data, as a fixed class (PR #323 review): a
  // DataUnavailableError's reason or an AskConfigError's problems never
  // reach the person or the log through run().
  const OPEN_CLASSES = Object.freeze({ DATA_UNAVAILABLE: 'data_unavailable', ASK_CONFIG: 'ask_config' });

  async function guarded(sql, params, declared, state) {
    try {
      await open();
    } catch (err) {
      throw refuse('failed', { errorClass: OPEN_CLASSES[err && err.code] || errorClassOf(err) });
    }
    const verdict = sqlGuard.checkSql(sql, { forbiddenColumns: forbidden, allowedTables, knownTables });
    if (!verdict.ok) throw refuse('guard', { rule: verdict.rule });
    if (!isPlainObject(params)) throw refuse('guard', { rule: 'bad_parameter_value' });
    const text = sqlGuard.withoutTrailingSemicolon(sql);
    let conn;
    try {
      conn = await instance.connect();
    } catch (err) {
      throw refuse('failed', { errorClass: errorClassOf(err) });
    }
    let settle = null; // set once the query starts: closes after it settles
    try {
      const parsed = checkParsed(await parseOf(conn, text), { allowedTables: allowed, dataColumns: await readColumns(conn) });
      if (!parsed.ok) throw refuse('guard', { rule: parsed.rule });
      const prepared = await conn.prepare(text);
      try {
        checkParams(prepared, params, new Set(declared));
      } catch (err) {
        throw refuse('guard', { rule: err.rule || 'bad_parameter_value' });
      }
      if (prepared.parameterCount) await prepared.bind(params);
      const query = Promise.resolve().then(() => prepared.streamAndReadUntil(maxRows));
      let expired = false;
      settle = query.then((reader) => { if (expired) closeQuietly(reader); }, () => {});
      const reader = await new Promise((resolve, reject) => {
        const timer = (timers || globalThis).setTimeout(() => {
          expired = true;
          try { conn.interrupt(); } catch { /* the rejection below still stands */ }
          reject(refuse('timeout'));
        }, timeoutMs);
        query.then((r) => { (timers || globalThis).clearTimeout(timer); if (!expired) resolve(r); }, (e) => { (timers || globalThis).clearTimeout(timer); if (!expired) reject(e); });
      });
      try {
        const rows = reader.getRowObjectsJson().slice(0, maxRows);
        return {
          rows, columns: reader.columnNames(), tables: parsed.tables, ordered: parsed.ordered,
        };
      } finally {
        closeQuietly(reader);
      }
    } catch (err) {
      if (err instanceof RuntimeRefusal) throw err;
      throw refuse('failed', { errorClass: errorClassOf(err) });
    } finally {
      // A query past its limit may still be stopping: the connection closes,
      // and the next query may start, only once it has.
      state.cleanup = (settle || Promise.resolve()).then(() => closeQuietly(conn));
    }
  }

  // One read-only Ask query. See the header for the steps. The caller hears
  // of a timeout at once; busy clears only once the connection has closed.
  async function run(sql, params = {}, { declared = [] } = {}) {
    if (busy) throw refuse('busy');
    busy = true;
    const state = { cleanup: Promise.resolve() };
    try {
      return await guarded(sql, params, declared, state);
    } finally {
      state.cleanup.finally(() => { busy = false; });
    }
  }

  function describe() {
    return { available: Boolean(instance), problem: instance ? null : lastProblem };
  }

  function close() {
    if (instance) closeQuietly(instance);
    instance = null;
  }

  return Object.freeze({ open, run, describe, close });
}

module.exports = {
  createAskData, AskConfigError, errorClassOf, COLUMNS_SQL, PARSE_SQL, ASK_SETTINGS, ASK_LIMITS,
};
