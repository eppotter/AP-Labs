'use strict';

// "How was this made?" (Story 9.6, AD-7, AD-15). Every scoped-pull result
// that ran its query (rows, or zero rows) carries a button; the run record
// behind it sits in the store's `provenance` namespace for 24 hours, keyed by
// a 128-bit random run id carried in the button. The record has exactly the
// AD-15 shape (RECORD_KEYS):
//
//   { runId, person, module, parameters, sql, source, fixtureVersion, ranAt,
//     rowIds, rows }
//
//   parameters      the confirmed values, one per declared input (null for
//                   an optional input left empty): exactly what was bound
//                   into the query, plus a scored module's limit input, which
//                   is never bound (the scoring line says so)
//   sql             the module's SQL, exactly the text the runner was given
//   source          the data source and its label from the runner's
//                   describe() ("MotherDuck (brightside)"), nothing more:
//                   never a path, a token or a connection string
//   fixtureVersion  the data version read from fixture_meta through the
//                   runner ("3, as of 2026-09-30"), or null when unreadable
//   ranAt           when the query started (ISO 8601, UTC)
//   rowIds, rows    null for a module that pushes nowhere. For a module with
//                   a write (Story 10.1): the row ids and the declared push
//                   fields (plus the score, when scored) of only the rows the
//                   person saw, after a scored module's cut, in rank order
//
// The record serves this button and the Epic 10 preview only; a push never
// reads it. A click shows the details by updating the module view the button
// is in. Only the person who ran it may open it; another person, an unknown
// or malformed run id and an expired record each get a plain message from
// kit/runtime/messages, never an error. Reading a record changes nothing, so
// a replayed click just shows the same details again.
//
// Everything that reaches Slack is escaped (kit/runtime/messages escapeText),
// and the SQL sits in code blocks a backtick in it can't close. A scored
// module's details carry its scoring line (Story 10.1, kit/runtime/scoring
// scoringBlocks: the inputs, weights and ranges, the tie rule and the limit
// kept). More lines can be passed in `extra` to detailsMessage: each entry is
// a block, placed before the SQL.

const crypto = require('node:crypto');
const { escapeText, messageFor } = require('../messages');
const { ProvenanceGone, ProvenanceNotYours } = require('../errors');
const { scoringBlocks } = require('../scoring');

const NS = 'provenance';
const ACTION = 'provenance:show';
const BUTTON = 'How was this made?';
const RUN_ID = /^[0-9a-f]{32}$/;
const RECORD_KEYS = Object.freeze(['runId', 'person', 'module', 'parameters', 'sql', 'source', 'fixtureVersion', 'ranAt', 'rowIds', 'rows']);
// The data version, read through the query runner. Names its columns (a
// wildcard is refused while a forbidden column is configured).
const VERSION_SQL = "SELECT key, value FROM fixture_meta WHERE key IN ('generator_version', 'as_of')";
// A mrkdwn section holds at most 3,000 characters; the SQL is split below that.
const SQL_CHUNK = 2800;

const STATUS = Object.freeze({ OK: 'ok', GONE: 'gone', NOT_YOURS: 'not-yours' });

const plain = (text) => ({ type: 'plain_text', text: String(text), emoji: false });
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });

function newRunId() {
  return crypto.randomBytes(16).toString('hex');
}

// "MotherDuck (brightside)" from describe(), or null when it says nothing.
function sourceOf(data) {
  let d;
  try {
    d = data && typeof data.describe === 'function' ? data.describe() : null;
  } catch {
    d = null;
  }
  if (!d || typeof d.source !== 'string' || !d.source) return null;
  return typeof d.label === 'string' && d.label ? `${d.source} (${d.label})` : d.source;
}

// The data version from fixture_meta, or null. Never throws: a run whose
// version can't be read still delivers, and its details say "unknown".
async function readVersion(data, log) {
  if (!data || typeof data.run !== 'function') return null;
  try {
    const rows = await data.run(VERSION_SQL, {}, { declared: [] });
    const meta = new Map((Array.isArray(rows) ? rows : []).map((r) => [r && r.key, r && r.value]));
    const given = (v) => v !== undefined && v !== null && v !== '';
    const generator = meta.get('generator_version');
    const asOf = meta.get('as_of');
    const parts = [given(generator) ? String(generator) : null, given(asOf) ? `as of ${asOf}` : null].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  } catch (err) {
    if (log) log.warn('data version unavailable', { reason: err && (err.reason || err.code || err.name) });
    return null;
  }
}

// A run record in exactly the AD-15 shape.
function buildRecord({
  runId = newRunId(), person, module, parameters, sql, source = null, fixtureVersion = null, ranAt, rowIds = null, rows = null,
}) {
  const when = ranAt instanceof Date ? ranAt.toISOString() : String(ranAt);
  return {
    runId, person, module, parameters: { ...parameters }, sql, source, fixtureVersion, ranAt: when, rowIds, rows,
  };
}

function save(store, record) {
  store.set(NS, record.runId, record);
  return record.runId;
}

// What a click on runId by person finds: { status, record }.
function lookup(store, runId, person) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) return { status: STATUS.GONE };
  const record = store.get(NS, runId);
  if (record === undefined) return { status: STATUS.GONE };
  if (record.person !== person) return { status: STATUS.NOT_YOURS };
  return { status: STATUS.OK, record };
}

function refusalFor(status) {
  return messageFor(status === STATUS.NOT_YOURS ? new ProvenanceNotYours() : new ProvenanceGone());
}

const buttonFor = (runId) => ({ type: 'button', action_id: ACTION, value: runId, text: plain(BUTTON) });

// The result message with the button beside its headline (its first
// section), so the rest of the result keeps its order. A message without a
// section gets the button in its own block at the end.
function withButton(message, runId) {
  const blocks = Array.isArray(message.blocks) ? message.blocks.slice() : [];
  const i = blocks.findIndex((b) => b && b.type === 'section' && b.text && !b.accessory);
  if (i === -1) blocks.push({ type: 'actions', block_id: 'provenance', elements: [buttonFor(runId)] });
  else blocks[i] = { ...blocks[i], accessory: buttonFor(runId) };
  return { ...message, blocks };
}

// The SQL as code blocks, escaped, each under the section limit. Three
// backticks in a row would close the block, so a zero-width space goes
// between them (shown the same, never run).
function sqlBlocks(sql) {
  const tokens = Array.from(String(sql).replace(/```/g, '`​`​`')).map((c) => escapeText(c));
  const chunks = [];
  let cur = '';
  for (const t of tokens) {
    if (cur.length + t.length > SQL_CHUNK) {
      chunks.push(cur);
      cur = '';
    }
    cur += t;
  }
  chunks.push(cur);
  return chunks.map((c, i) => section(`${i === 0 ? '*The SQL that ran:*\n' : ''}\`\`\`\n${c}\n\`\`\``));
}

function displayParam(p, v) {
  if (v === null || v === undefined || v === '') return '(left empty)';
  if (p && p.type === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

// The confirmed values, one section each, labelled from the manifest when the
// module still declares the input. Values are plain_text.
function paramBlocks(mod, parameters) {
  const declared = new Map(((mod && mod.parameters) || []).map((p) => [p.name, p]));
  return Object.keys(parameters).map((name) => {
    const p = declared.get(name);
    return {
      type: 'section',
      fields: [{ type: 'mrkdwn', text: `*${escapeText((p && p.label) || name)}*` }, plain(displayParam(p, parameters[name]))],
    };
  });
}

// The time, shown in the reader's own time zone by Slack, with the UTC time
// as the fallback text.
function timeText(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return escapeText(iso);
  const utc = `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return `<!date^${Math.floor(t / 1000)}^{date_short_pretty} at {time}|${utc}>`;
}

// The details view: a scored module's scoring line, then extra (blocks to
// add), both before the SQL.
function detailsMessage(record, { mod, extra = [] } = {}) {
  const label = escapeText((mod && mod.label) || record.module);
  const params = paramBlocks(mod, record.parameters || {});
  const blocks = [
    section(`*How ${label} was made*`),
    section(params.length ? '*The values you confirmed:*' : '*The values you confirmed:* none (this list takes no inputs).'),
    ...params,
    section([
      `*Data source:* ${record.source ? escapeText(record.source) : 'unknown'}`,
      `*Data version:* ${record.fixtureVersion ? escapeText(record.fixtureVersion) : 'unknown'}`,
      `*Ran:* ${timeText(record.ranAt)}`,
    ].join('\n')),
    ...scoringBlocks(mod, record),
    ...extra,
    ...sqlBlocks(record.sql),
  ];
  return { text: `How ${(mod && mod.label) || record.module} was made.`, blocks };
}

module.exports = {
  newRunId, sourceOf, readVersion, buildRecord, save, lookup, refusalFor, withButton, detailsMessage, sqlBlocks,
  NS, ACTION, BUTTON, RUN_ID, RECORD_KEYS, VERSION_SQL, STATUS,
};
