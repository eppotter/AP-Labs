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
// Every outcome is one of: rows, empty (zero rows), blocked (the SQL checker
// or the parameter rules refused it), failed (any other query error) or
// unavailable (no data source, MotherDuck down, or the 30s query limit). Only
// rows that were delivered in full count as a complete run; a run whose CSV
// did not arrive says so and records the session as failed.
//
// Rows never reach the AI: nothing here imports kit/runtime/llm, and the
// runner is not given the AI service (a test checks both).

const sqlGuard = require('../../sql');
const { DataUnavailable } = require('../../errors');
const { toCsv } = require('./csv');
const { deliverCsv } = require('./deliver');
const { resultMessage, failureMessage, csvComment, csvFilename } = require('./results');
const provenance = require('../../slack/provenance');

// The engine stops at this many rows and says "first 5,000 of N".
const ROW_CAP = 5000;

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

// Every startup problem with a scoped pull's SQL, as plain sentences (the
// registry prefixes the module's file). Never connects to the data.
function checkQuery(sql, parameters = [], { forbiddenColumns = [] } = {}) {
  const problems = [];
  if (String(sql).includes('${')) problems.push('its SQL contains "${"; the SQL is a fixed file with $name parameters, never built from text');
  const verdict = sqlGuard.checkSql(sql, { forbiddenColumns });
  if (!verdict.ok) {
    problems.push(`its SQL is refused by the SQL checker (${verdict.rule}: ${verdict.detail})`);
    return problems;
  }
  const { names, positional } = placeholders(sql);
  if (positional) problems.push('its SQL uses a positional parameter ($1 or ?); name each one after a declared input ($zone)');
  const declared = new Set(parameters.map((p) => p.name));
  for (const name of [...names].sort()) {
    if (!declared.has(name)) problems.push(`its SQL names $${name}, which is not a declared input`);
  }
  for (const p of parameters) {
    if (!names.has(p.name)) problems.push(`input "${p.name}" is declared but its SQL never uses $${p.name}`);
  }
  return problems;
}

// The parameters a run binds: each declared input and nothing else, null for
// an optional input left empty.
function bindValues(parameters, values = {}) {
  const params = {};
  for (const p of parameters) params[p.name] = Object.hasOwn(values, p.name) && values[p.name] !== undefined ? values[p.name] : null;
  return params;
}

const isUnavailable = (err) => err instanceof DataUnavailable || (err && err.code === 'DATA_UNAVAILABLE');
const isRefused = (err) => Boolean(err && err.code === 'QUERY_REFUSED');

// Runs mod's SQL with values. Returns the outcome (see the top); never
// throws for a query problem.
async function runQuery({ data, mod, values, log }) {
  const parameters = mod.parameters || [];
  if (!data) return { kind: 'unavailable', error: new DataUnavailable('no data source') };
  let rows;
  try {
    rows = await data.run(mod.sql, bindValues(parameters, values), { declared: parameters.map((p) => p.name) });
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
  const total = rows.length;
  const kept = total > ROW_CAP ? rows.slice(0, ROW_CAP) : rows;
  return { kind: 'rows', columns: Object.keys(kept[0]), rows: kept, total, capped: total > ROW_CAP };
}

// Keeps the run record (Story 9.6) and returns message with its button. The
// SQL and parameters are exactly what runQuery gave the runner. A record
// that can't be kept never costs the person the result: it goes without the
// button.
async function keepRecord({ store, data, log, mod, values, person, ranAt, outcome, message }) {
  try {
    const parameters = bindValues(mod.parameters || [], values);
    const rowIds = mod.row_id && outcome.rows ? outcome.rows.map((r) => r[mod.row_id]) : null;
    const record = provenance.buildRecord({
      person, module: mod.id, parameters, sql: mod.sql, source: provenance.sourceOf(data), fixtureVersion: await provenance.readVersion(data, log), ranAt, rowIds,
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
  checkQuery, placeholders, bindValues, runQuery, createRunner, ROW_CAP,
};
