'use strict';

// Running a scoped pull (Story 9.5, AD-9, AD-10). Two halves:
//
//   checkQuery   at startup, for every scoped-pull module, without connecting
//                to the data: the SQL checker (kit/runtime/sql, with the
//                profile's forbidden columns), no "${" anywhere, and a scan
//                that matches each $name in the SQL to a declared input, both
//                ways (an undeclared $name, or an input the SQL never uses,
//                would only fail when someone ran it). A problem stops
//                startup, naming the module (kit/runtime/registry).
//   createRunner what a consumed Confirm does: binds ONLY the declared inputs
//                (each declared name, null when an optional input was left
//                empty) as named parameters into the module's fixed SQL, runs
//                it through the query runner (kit/runtime/data, which checks
//                the SQL again and refuses an undeclared parameter), caps the
//                rows at ROW_CAP, sends the CSV to the person's DM
//                (./deliver) and builds the summary for the module's view
//                (./results). With a store, a run that reached the data
//                (rows, or zero rows) also keeps its run record and gets the
//                "How was this made?" button (Story 9.6,
//                kit/runtime/slack/provenance).
//
// A scored module (Story 10.1, kit/runtime/scoring) ranks every candidate
// before it cuts to the person's number (plan epic-10, decision 2). Its SQL
// ends with an ORDER BY whose last key is the row id, then a literal
// LIMIT 5001 (ROW_CAP + 1), so the rows kept at the cap are the same every
// time and the engine can tell there were more. The limit input
// (scoring.limit_parameter) is never bound: checkQuery exempts it from
// "declared but never used" and refuses SQL that names it, and bindValues
// leaves it out. The engine scores the first ROW_CAP rows, ranks them and
// keeps the top `limit`; when ROW_CAP + 1 came back the person is told the
// ranking covers only the first 5,000.
//
// Every outcome is one of: rows, empty (zero rows), blocked (the SQL checker
// or the parameter rules refused it), failed (any other query error),
// scoring (a scored module's rows could not be scored: ScoringFault) or
// unavailable (no data source, MotherDuck down, or the 30s query limit). Only
// rows that were delivered in full count as a complete run; a run whose CSV
// did not arrive says so and records the session as failed.
//
// Rows never reach the AI: nothing here imports kit/runtime/llm, and the
// runner is not given the AI service (a test checks both).

const sqlGuard = require('../../sql');
const { DataUnavailable, ScoringFault } = require('../../errors');
const scoring = require('../../scoring');
const { toCsv } = require('./csv');
const { deliverCsv } = require('./deliver');
const { resultMessage, failureMessage, csvComment, csvFilename } = require('./results');
const provenance = require('../../slack/provenance');

// The engine stops at this many rows and says "first 5,000 of N".
const ROW_CAP = 5000;
// What a scored module's SQL ends with: the cap plus one.
const SCORED_LIMIT = ROW_CAP + 1;

// The parameters a SQL text names, outside strings, quoted identifiers and
// comments: { names: Set, positional: boolean }. Run only on SQL the checker
// passed, so the forms it refuses (E'', $$ strings, unterminated text) never
// reach here.
function placeholders(sql) {
  const s = String(sql);
  const names = new Set();
  let positional = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i += 1;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = sqlGuard.blockCommentEnd(s, i);
      i = end === -1 ? s.length : end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === c && s[j + 1] === c) { j += 2; continue; }
        if (s[j] === c) break;
        j += 1;
      }
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*|\d+)/.exec(s.slice(i));
      if (m && /^\d/.test(m[1])) positional = true;
      else if (m) names.add(m[1]);
      i += m ? m[0].length : 1;
    } else if (c === '?') {
      positional = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  return { names, positional };
}

// The SQL with its comments blanked, its strings emptied ('') and its quoted
// identifiers unquoted, for the scored-SQL checks below. Run only on SQL the
// checker passed.
function codeText(sql) {
  const s = String(sql);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i += 1;
      out += ' ';
    } else if (c === '/' && s[i + 1] === '*') {
      const end = sqlGuard.blockCommentEnd(s, i);
      i = end === -1 ? s.length : end;
      out += ' ';
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let inner = '';
      while (j < s.length) {
        if (s[j] === c && s[j + 1] === c) { inner += c; j += 2; continue; }
        if (s[j] === c) break;
        inner += s[j];
        j += 1;
      }
      out += c === "'" ? "''" : inner;
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

// Splits text on the commas outside parentheses. null when the parentheses
// don't balance (the ORDER BY found was inside a subquery).
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (depth < 0) return null;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (depth !== 0) return null;
  parts.push(cur);
  return parts.map((p) => p.trim());
}

// Whether name appears in code as a whole identifier (names are checked
// against ^[a-z][a-z0-9_]*$ by the schema, so they are safe in a pattern).
const identifierIn = (code, name) => new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_]|$)`, 'i').test(code);

// The startup problems with a scored module's SQL (decision 2): the row id
// and every input appear in it, and it ends with ORDER BY ..., <row id>
// LIMIT 5001.
function checkScoredSql(sql, { rowId, inputs }) {
  const problems = [];
  const code = codeText(sql).replace(/[\s;]+$/, '');
  for (const name of [rowId, ...inputs.map((i) => i.name)]) {
    if (!identifierIn(code, name)) problems.push(`its SQL never returns "${name}", which the scoring needs (a scoring input or the row id)`);
  }
  const limit = /\bLIMIT\s+(\S+)$/i.exec(code);
  if (!limit || limit[1] !== String(SCORED_LIMIT)) {
    problems.push(`a scored module's SQL must end with LIMIT ${SCORED_LIMIT} (the ${ROW_CAP.toLocaleString('en-US')}-row cap plus one), as a literal; the engine keeps the person's number after scoring`);
    return problems;
  }
  const head = code.slice(0, limit.index);
  const orders = [...head.matchAll(/\bORDER\s+BY\b/gi)];
  const last = orders.at(-1);
  const keys = last ? topLevelParts(head.slice(last.index + last[0].length)) : null;
  const lastKey = keys ? keys.at(-1).replace(/\s+NULLS\s+(FIRST|LAST)$/i, '').replace(/\s+(ASC|DESC)$/i, '') : '';
  if (!new RegExp(`^(?:[A-Za-z_][A-Za-z0-9_]*\\.)?${rowId}$`, 'i').test(lastKey)) {
    problems.push(`a scored module's SQL must end with an ORDER BY whose last key is the row id (ORDER BY ..., ${rowId}) just before LIMIT ${SCORED_LIMIT}, so the rows kept at the cap are the same every time`);
  }
  return problems;
}

// Every startup problem with a scoped pull's SQL, as plain sentences (the
// registry prefixes the module's file). Never connects to the data. A scored
// module passes its row id and scoring: its limit input must never appear in
// the SQL, and its SQL must end as checkScoredSql says.
function checkQuery(sql, parameters = [], { forbiddenColumns = [], scoring: scored = null, rowId = null } = {}) {
  const problems = [];
  if (String(sql).includes('${')) problems.push('its SQL contains "${"; the SQL is a fixed file with $name parameters, never built from text');
  const verdict = sqlGuard.checkSql(sql, { forbiddenColumns });
  if (!verdict.ok) {
    problems.push(`its SQL is refused by the SQL checker (${verdict.rule}: ${verdict.detail})`);
    return problems;
  }
  const { names, positional } = placeholders(sql);
  const limitName = scored ? scored.limit_parameter : undefined;
  if (positional) problems.push('its SQL uses a positional parameter ($1 or ?); name each one after a declared input ($zone)');
  const declared = new Set(parameters.map((p) => p.name));
  for (const name of [...names].sort()) {
    if (name === limitName) problems.push(`its SQL names $${name}, the scoring limit; the engine keeps the top $${name} after scoring, so the SQL must never use it`);
    else if (!declared.has(name)) problems.push(`its SQL names $${name}, which is not a declared input`);
  }
  for (const p of parameters) {
    if (p.name !== limitName && !names.has(p.name)) problems.push(`input "${p.name}" is declared but its SQL never uses $${p.name}`);
  }
  if (scored) problems.push(...checkScoredSql(sql, { rowId, inputs: scored.inputs }));
  return problems;
}

// The names a run binds: each declared input except a scored module's limit.
function boundNames(mod) {
  const limitName = mod.scoring ? mod.scoring.limit_parameter : undefined;
  return (mod.parameters || []).map((p) => p.name).filter((name) => name !== limitName);
}

// The parameters a run binds: each declared input and nothing else, null for
// an optional input left empty. omit: a name never bound (a scored module's
// limit input).
function bindValues(parameters, values = {}, { omit = null } = {}) {
  const params = {};
  for (const p of parameters) {
    if (p.name === omit) continue;
    params[p.name] = Object.hasOwn(values, p.name) && values[p.name] !== undefined ? values[p.name] : null;
  }
  return params;
}

const isUnavailable = (err) => err instanceof DataUnavailable || (err && err.code === 'DATA_UNAVAILABLE');
const isRefused = (err) => Boolean(err && err.code === 'QUERY_REFUSED');

// A scored module's rows: the first ROW_CAP scored and ranked, then the top
// `limit` kept. Each kept row is the query's row plus score and reason.
function scoredOutcome(mod, values, rows) {
  const capped = rows.length > ROW_CAP;
  const candidates = capped ? rows.slice(0, ROW_CAP) : rows;
  const limitName = mod.scoring.limit_parameter;
  const limit = limitName && Number.isInteger(values[limitName]) ? values[limitName] : null;
  const kept = scoring.rank(candidates, mod, { limit }).map(({ row, score, reason }) => ({ ...row, score, reason }));
  const queryColumns = Object.keys(rows[0]);
  const inputs = new Set(mod.scoring.inputs.map((i) => i.name));
  return {
    kind: 'rows',
    columns: ['score', ...queryColumns, 'reason'],
    // The view leaves out the inputs: the reason names the ones that counted.
    previewColumns: ['score', ...queryColumns.filter((c) => !inputs.has(c)), 'reason'],
    rows: kept,
    total: candidates.length,
    capped,
    scored: true,
  };
}

// Runs mod's SQL with values. Returns the outcome (see the top); never
// throws for a query problem.
async function runQuery({ data, mod, values, log }) {
  const parameters = mod.parameters || [];
  if (!data) return { kind: 'unavailable', error: new DataUnavailable('no data source') };
  const limitName = mod.scoring ? mod.scoring.limit_parameter : undefined;
  let rows;
  try {
    rows = await data.run(mod.sql, bindValues(parameters, values, { omit: limitName }), { declared: boundNames(mod) });
  } catch (err) {
    if (isUnavailable(err)) {
      log.warn('data unavailable', { module: mod.id, reason: err.reason });
      return { kind: 'unavailable', error: err };
    }
    if (isRefused(err)) {
      log.error('list query refused', { module: mod.id, rule: err.rule });
      return { kind: 'blocked', error: err };
    }
    log.error('list query failed', { module: mod.id, err });
    return { kind: 'failed', error: err };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { kind: 'empty', total: 0 };
  if (mod.scoring) {
    try {
      return scoredOutcome(mod, values, rows);
    } catch (err) {
      if (!(err instanceof ScoringFault)) throw err;
      log.error('list scoring failed', { module: mod.id, input: err.details.input, problem: err.details.problem });
      return { kind: 'scoring', error: err };
    }
  }
  const total = rows.length;
  const kept = total > ROW_CAP ? rows.slice(0, ROW_CAP) : rows;
  return { kind: 'rows', columns: Object.keys(kept[0]), rows: kept, total, capped: total > ROW_CAP };
}

// The run record's rowIds and rows (AD-15): only for a module with a write,
// and only the rows the person saw (after a scored module's cut), in rank
// order. rows holds the declared push fields, plus the score when scored.
function pushRowsOf(mod, outcome) {
  // The manifest's write block, read for its push field names only. It is
  // not a connector (this file imports none); the push itself belongs to the
  // approval-write archetype (kit/verify/write-path).
  const block = mod.write;
  if (!block || !mod.row_id || !outcome.rows) return { rowIds: null, rows: null };
  const { fields } = block;
  return {
    rowIds: outcome.rows.map((r) => r[mod.row_id]),
    rows: outcome.rows.map((r) => {
      const picked = Object.fromEntries(fields.map((f) => [f, r[f] === undefined ? null : r[f]]));
      if (outcome.scored) picked.score = r.score;
      return picked;
    }),
  };
}

// Keeps the run record (Story 9.6) and returns message with its button. The
// SQL and parameters are exactly what runQuery gave the runner. A record
// that can't be kept never costs the person the result: it goes without the
// button.
async function keepRecord({ store, data, log, mod, values, person, ranAt, outcome, message }) {
  try {
    // The confirmed values: what was bound, plus a scored module's limit
    // (which the scoring line in the details explains).
    const parameters = bindValues(mod.parameters || [], values);
    const { rowIds, rows } = pushRowsOf(mod, outcome);
    const record = provenance.buildRecord({
      person, module: mod.id, parameters, sql: mod.sql, source: provenance.sourceOf(data), fixtureVersion: await provenance.readVersion(data, log), ranAt, rowIds, rows,
    });
    provenance.save(store, record);
    return provenance.withButton(message, record.runId);
  } catch (err) {
    log.error('run record not kept', { module: mod.id, err });
    return message;
  }
}

// What a consumed Confirm runs: run(mod, values, person, { client }) resolves
// { message, failed }. data: the query runner (null without a data source).
// admin: who the person is told to contact. now: the clock, for the CSV's
// file name and the run record's time. store: where the run record goes (no
// record and no button without one).
function createRunner({
  data, log, admin = 'your admin', now = () => new Date(), store = null,
}) {
  return async function run(mod, values, person, { client } = {}) {
    const ranAt = now();
    const outcome = await runQuery({ data, mod, values, log });
    const recorded = (message) => (store && (outcome.kind === 'rows' || outcome.kind === 'empty')
      ? keepRecord({ store, data, log, mod, values, person, ranAt, outcome, message })
      : message);
    if (outcome.kind !== 'rows') {
      log.info('list ran', { module: mod.id, outcome: outcome.kind });
      return { message: await recorded(failureMessage(mod, values, outcome, { admin })), failed: outcome.kind !== 'empty' };
    }
    let delivery;
    try {
      delivery = await deliverCsv({
        client,
        person,
        filename: csvFilename(mod, now()),
        title: mod.label,
        content: toCsv(outcome.columns, outcome.rows),
        comment: csvComment(mod, values, outcome),
      });
    } catch (err) {
      log.error('list CSV not delivered', { module: mod.id, err });
      delivery = { failed: true };
    }
    log.info('list ran', { module: mod.id, outcome: delivery.failed ? 'not delivered' : 'rows', rows: outcome.rows.length, total: outcome.total });
    return { message: await recorded(resultMessage(mod, values, outcome, delivery, { admin })), failed: Boolean(delivery.failed) };
  };
}

module.exports = {
  checkQuery, checkScoredSql, codeText, placeholders, bindValues, boundNames, runQuery, pushRowsOf, createRunner, ROW_CAP, SCORED_LIMIT,
};
