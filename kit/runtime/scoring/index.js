'use strict';

// Deterministic scoring with a reason per row (Story 10.1, plan epic-10
// decisions 1 and 2). A module's manifest declares
//
//   "row_id": "client_id",
//   "scoring": {
//     "inputs": [{ "name", "label", "weight", "min", "max" }, ...],
//     "limit_parameter": "limit"
//   }
//
// and the engine scores the rows its query returned. Nothing here calls the
// AI or reads anything but the rows and the manifest.
//
// The formula is pinned: each input's value is clipped to [min, max] and
// scaled to 0-1 (x); S is the sum of weight x x; Σpos is the sum of the
// positive weights and Σneg the sum of the negative ones; then
//
//   score = round-half-up(100 x (S - Σneg) / (Σpos - Σneg))
//
// so 0 is the worst possible row and 100 the best. A negative weight means
// lower is better. Ranges are fixed in the manifest, never taken from the
// result, so a row's score doesn't depend on who else came back. Rows are
// ranked by score, high first, ties by the row id (numerically when both ids
// are numbers or integer strings, else by text), so the same data and weights
// give the same scores and order every time.
//
// The reason names the row's top two contributing inputs, in plain words
// from their labels. An input's contribution is how far it lifted the row
// above the worst: weight x x for a positive weight, |weight| x (1 - x) for a
// negative one. Ties between inputs go to the one declared first; an input
// that lifted nothing is left out.
//
// Values: a JavaScript number, a strict numeric string (BIGINT, HUGEINT and
// DECIMAL come back from the query runner as strings) or a boolean (0/1).
// Anything else stops the run with a ScoringFault naming the module and the
// input, and so does a null (a nullable input must be COALESCEd in the SQL)
// or a declared input missing from the rows. A value is never scored as 0 in
// place of an error.

const { ScoringFault } = require('../errors');
const { escapeText } = require('../messages');

// Columns the engine adds to every scored row.
const ADDED = Object.freeze(['score', 'reason']);
const NOTHING_STOOD_OUT = 'No input scored above its lowest';
const NUMERIC = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;

// A value as a number, or undefined when it is not one scoring accepts.
function toNumber(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && NUMERIC.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const count = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// Every startup problem with a module's scoring declaration, as sentences
// (the registry prefixes the module's file). The SQL side (the ORDER BY, the
// LIMIT 5001, the limit parameter never named) is checked by the scoped-pull
// archetype's checkQuery.
function checkScoring(mod) {
  const s = mod.scoring;
  if (!s) return [];
  if (mod.archetype !== 'scoped-pull' && mod.archetype !== 'approval-write') {
    return ['field "scoring" is used only by a module with a query (scoped-pull or approval-write)'];
  }
  const problems = [];
  const seen = new Set();
  s.inputs.forEach((input, i) => {
    const where = `field "scoring.inputs[${i}]" (input "${input.name}")`;
    if (ADDED.includes(input.name)) problems.push(`${where} uses a name the engine adds to every scored row (${ADDED.join(', ')})`);
    else if (seen.has(input.name)) problems.push(`${where} repeats an input name`);
    seen.add(input.name);
    if (input.min >= input.max) problems.push(`${where} has min ${input.min} at or above max ${input.max}; the range must be min < max`);
  });
  if (s.inputs.every((input) => input.weight === 0)) problems.push('field "scoring.inputs" has every weight 0; at least one input must count');
  if (s.limit_parameter !== undefined) {
    const p = (mod.parameters || []).find((x) => x.name === s.limit_parameter);
    if (!p) problems.push(`field "scoring.limit_parameter" names "${s.limit_parameter}", which is not a declared input`);
    else if (p.type !== 'integer') problems.push(`field "scoring.limit_parameter" names "${s.limit_parameter}", which must be an integer input`);
  }
  return problems;
}

function fault(mod, input, label, problem) {
  return new ScoringFault({ module: mod.id, input, label, problem });
}

// The first problem with the rows' shape: a missing input or row id column,
// or a column the engine would overwrite. Checked on every row, so a column
// that only some rows carry is caught too.
function checkColumns(row, mod) {
  if (!Object.hasOwn(row, mod.row_id)) throw fault(mod, mod.row_id, mod.row_id, 'no_row_id');
  for (const name of ADDED) if (Object.hasOwn(row, name)) throw fault(mod, name, name, 'column_taken');
  for (const input of mod.scoring.inputs) {
    if (!Object.hasOwn(row, input.name)) throw fault(mod, input.name, input.label, 'missing');
  }
}

// How a value reads in a reason: "Label: 4,120", or the label alone for a
// true boolean ("Price rise before lapse").
function reasonPart(input, raw, n) {
  if (raw === true) return input.label;
  if (raw === false) return `${input.label}: no`;
  return `${input.label}: ${count(n)}`;
}

// Orders two row ids: numerically when both are numbers or integer strings,
// else by text (code units, so no locale can change it).
function compareIds(a, b) {
  const intLike = (v) => (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && INTEGER.test(v));
  if (intLike(a) && intLike(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// Scores every row and ranks them. Returns [{ row, score, reason }], best
// first; the rows are the query's own objects, never changed. Throws a
// ScoringFault for the first bad row.
function scoreRows(rows, mod) {
  const { inputs } = mod.scoring;
  const pos = inputs.reduce((sum, i) => sum + (i.weight > 0 ? i.weight : 0), 0);
  const neg = inputs.reduce((sum, i) => sum + (i.weight < 0 ? i.weight : 0), 0);
  const scored = rows.map((row) => {
    checkColumns(row, mod);
    let s = 0;
    const lifts = [];
    inputs.forEach((input, order) => {
      const raw = row[input.name];
      if (raw === null || raw === undefined) throw fault(mod, input.name, input.label, 'null');
      const n = toNumber(raw);
      if (n === undefined) throw fault(mod, input.name, input.label, 'not_number');
      const x = (Math.min(Math.max(n, input.min), input.max) - input.min) / (input.max - input.min);
      s += input.weight * x;
      const lift = input.weight > 0 ? input.weight * x : -input.weight * (1 - x);
      if (lift > 0) lifts.push({ lift, order, part: reasonPart(input, raw, n) });
    });
    // toFixed(9) drops binary noise first, so an exact half always rounds up.
    const exact = Number(((100 * (s - neg)) / (pos - neg)).toFixed(9));
    const score = Math.min(100, Math.max(0, Math.floor(exact + 0.5)));
    lifts.sort((a, b) => b.lift - a.lift || a.order - b.order);
    const reason = lifts.length ? lifts.slice(0, 2).map((l) => l.part).join('; ') : NOTHING_STOOD_OUT;
    return { row, score, reason };
  });
  return scored.sort((a, b) => b.score - a.score || compareIds(a.row[mod.row_id], b.row[mod.row_id]));
}

// Scores, ranks, then keeps the top `limit` (every row when limit is null).
function rank(rows, mod, { limit = null } = {}) {
  const ranked = scoreRows(rows, mod);
  return Number.isInteger(limit) && limit >= 0 ? ranked.slice(0, limit) : ranked;
}

// The scoring line for "How was this made?" (Story 9.6's extra blocks).
// record.parameters holds the confirmed values, including the limit.
function scoringBlocks(mod, record) {
  const s = mod && mod.scoring;
  if (!s) return [];
  const inputs = s.inputs.map((i) => `${escapeText(i.label)} (weight ${count(i.weight)}, ${count(i.min)} to ${count(i.max)}${i.weight < 0 ? ': lower is better' : ''})`).join('; ');
  const lines = [
    `*Scoring:* each row got a score from 0 to 100, worked out by the app from the returned rows with fixed weights (no AI). ${inputs}.`,
  ];
  let tail = `Rows are ranked by score, ties by ${escapeText(mod.row_id)}.`;
  if (s.limit_parameter) {
    const p = (mod.parameters || []).find((x) => x.name === s.limit_parameter);
    const value = record && record.parameters ? record.parameters[s.limit_parameter] : undefined;
    const label = escapeText((p && p.label) || s.limit_parameter);
    tail += Number.isInteger(value)
      ? ` The app kept the top ${count(value)} (${label}); the SQL never uses that value.`
      : ` The app keeps the top rows set by ${label}; the SQL never uses that value.`;
  }
  lines.push(tail);
  return [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
}

module.exports = {
  checkScoring, scoreRows, rank, toNumber, compareIds, scoringBlocks, ADDED, NOTHING_STOOD_OUT,
};
