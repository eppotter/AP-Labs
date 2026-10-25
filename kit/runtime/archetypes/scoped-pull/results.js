'use strict';

// What a scoped pull's run shows in the module's view, and the message that
// goes with its CSV in the person's DM (Story 9.5).
//
// The view: the row count (or "the first 5,000 of N"), the values it ran
// with, the first rows in a code block, and where the CSV is. Every cell
// value goes through escapeText (kit/runtime/messages, the 9.2 escaping), so
// data can't create a mention, a link or a channel ping; backticks and line
// breaks in a cell are replaced, so a cell can't close the code block either.
// The words for a failure come from kit/runtime/messages (AD-17). The CSV
// itself is raw data (./csv).
//
// A scored list (Story 10.1) says it is ranked ("the top 25 of 38 rows, by
// score"). Its view shows the score, the query's columns other than the
// scoring inputs and the reason (not cut short like other cells); its CSV
// has every column with score first and reason last. When the query hit the
// cap, the view says the ranking covers only the first 5,000 rows. The
// preview drops rows from the end, if it must, to stay under Slack's
// section limit.

const { messageFor, escapeText } = require('../../messages');
const { QueryBlocked, QueryFailed, CsvNotDelivered } = require('../../errors');
const { valueBlocks } = require('./form');
const { displayValue, labelOf } = require('./params');

// Rows shown in the view; the CSV holds the rest.
const PREVIEW_ROWS = 10;
// A cell in the preview is cut to this many characters; a reason to this many.
const PREVIEW_CELL = 24;
const REASON_CELL = 120;
// A mrkdwn section holds at most 3,000 characters; the preview stays below.
const PREVIEW_LIMIT = 2800;

const count = (n) => Number(n).toLocaleString('en-US');
const rowsWord = (n) => `${count(n)} ${n === 1 ? 'row' : 'rows'}`;
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

// "38 rows", or "the first 5,000 of 6,200 rows" when capped. A scored list:
// "38 rows, ranked by score", "the top 25 of 38 rows, by score", or "the top
// 25 by score, of the first 5,000 rows" when capped.
function sizeWords(outcome) {
  const n = outcome.rows.length;
  if (outcome.scored) {
    if (outcome.capped) return `the top ${count(n)} by score, of the first ${rowsWord(outcome.total)}`;
    return n < outcome.total ? `the top ${count(n)} of ${rowsWord(outcome.total)}, by score` : `${rowsWord(outcome.total)}, ranked by score`;
  }
  return outcome.capped ? `the first ${count(n)} of ${rowsWord(outcome.total)}` : rowsWord(outcome.total);
}

// One preview cell: text, one line, no backticks, cut to max characters.
function previewCell(v, max = PREVIEW_CELL) {
  let s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/`/g, "'");
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

// The first rows as an aligned table in a code block, escaped. full: the
// columns cut at REASON_CELL instead of PREVIEW_CELL (a scored list's reason).
function previewText(columns, rows, { full = [] } = {}) {
  const cell = (c, v) => previewCell(v, full.includes(c) ? REASON_CELL : PREVIEW_CELL);
  const table = [columns.map((c) => cell(c, c)), ...rows.slice(0, PREVIEW_ROWS).map((r) => columns.map((c) => cell(c, r[c])))];
  const widths = columns.map((_, i) => Math.max(...table.map((line) => Array.from(line[i]).length)));
  const lines = table.map((line) => line.map((c, i) => c + ' '.repeat(widths[i] - Array.from(c).length)).join('  ').trimEnd());
  return `\`\`\`\n${escapeText(lines.join('\n'))}\n\`\`\``;
}

// The preview that fits a section: the first rows, dropping rows from the
// end until the table is under PREVIEW_LIMIT. Returns { text, shown }.
function previewFit(columns, rows, opts) {
  let shown = Math.min(PREVIEW_ROWS, rows.length);
  let text = previewText(columns, rows.slice(0, shown), opts);
  while (shown > 1 && text.length > PREVIEW_LIMIT) {
    shown -= 1;
    text = previewText(columns, rows.slice(0, shown), opts);
  }
  return { text, shown };
}

// The CSV's file name: the module id and the run time (UTC), never values.
function csvFilename(mod, when) {
  const stamp = when.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `${mod.id}-${stamp}.csv`;
}

// The DM message that carries the file. Each value is worded by its
// declared type, the same as the view (params displayValue): a number 0
// reads 0, and only a declared boolean reads Yes or No (#142).
function csvComment(mod, values, outcome) {
  const vals = (mod.parameters || [])
    .filter((p) => values[p.name] !== undefined && values[p.name] !== null)
    .map((p) => `${labelOf(p)}: ${displayValue(p, values[p.name])}`)
    .join(', ');
  let size = outcome.scored ? sizeWords(outcome) : rowsWord(outcome.total);
  if (outcome.capped) size = `${sizeWords(outcome)} (${outcome.scored ? `the ranking covers only the first ${count(outcome.total)}` : `the engine stops at ${count(outcome.rows.length)}`})`;
  return escapeText(`${mod.label}: ${size}${vals ? `, for ${vals}` : ''}.`);
}

// Where the CSV went, as a context line.
function deliveryLine(outcome, delivery) {
  let what;
  if (outcome.scored) what = outcome.capped ? `The CSV in your DM with me holds ${sizeWords(outcome)}.` : `The ranked list (${rowsWord(outcome.rows.length)}) is a CSV in your DM with me.`;
  else what = outcome.capped ? `The CSV in your DM with me holds ${sizeWords(outcome)}. Narrow the values to see the rest.` : `The full list (${rowsWord(outcome.total)}) is a CSV in your DM with me.`;
  return delivery.permalink ? `${what} <${delivery.permalink}|Open the CSV>` : what;
}

// The view after a run with rows. delivery: { permalink } or { failed: true }.
function resultMessage(mod, values, outcome, delivery, { admin } = {}) {
  const label = escapeText(mod.label);
  const columns = outcome.previewColumns || outcome.columns;
  const { text, shown } = previewFit(columns, outcome.rows, { full: outcome.scored ? ['reason'] : [] });
  const all = shown === outcome.total && !outcome.capped;
  const heading = all ? 'The rows' : `${outcome.scored ? 'The top' : 'The first'} ${count(shown)}`;
  const blocks = [section(`*${label}: ${sizeWords(outcome)}.*`)];
  if (outcome.scored && outcome.capped) {
    blocks.push(context(`The ranking covers only the first ${count(outcome.total)} rows the query returned; more matched. Narrow the values to rank them all.`));
  }
  blocks.push(...valueBlocks(mod, values), section(`*${heading}:*\n${text}`));
  if (delivery.failed) blocks.push(section(messageFor(new CsvNotDelivered(), { admin })));
  else blocks.push(context(deliveryLine(outcome, delivery)));
  return { text: `${mod.label}: ${sizeWords(outcome)}.`, blocks };
}

// The view when there are no rows to show: zero rows, or the query did not
// run (blocked, failed, unavailable).
function failureMessage(mod, values, outcome, { admin } = {}) {
  const label = escapeText(mod.label);
  let headline;
  switch (outcome.kind) {
    case 'empty': headline = `*${label}: no rows matched these values.* Nothing was sent to your DM.`; break;
    case 'blocked': headline = messageFor(new QueryBlocked(outcome.error && outcome.error.rule), { admin }); break;
    case 'unavailable': headline = messageFor(outcome.error, { admin }); break;
    case 'scoring': headline = messageFor(outcome.error, { admin }); break;
    default: headline = messageFor(new QueryFailed(), { admin });
  }
  const blocks = [section(headline), ...valueBlocks(mod, values)];
  if (outcome.kind !== 'empty') blocks.push(context('Open it again from the menu to try again.'));
  return { text: `${mod.label}: ${outcome.kind === 'empty' ? 'no rows' : 'no results'}.`, blocks };
}

// Shown in the view while the query runs.
function runningMessage(mod, values) {
  return {
    text: `${mod.label}: running…`,
    blocks: [section(`*Running ${escapeText(mod.label)}…* This can take up to a minute.`), ...valueBlocks(mod, values)],
  };
}

module.exports = {
  resultMessage, failureMessage, runningMessage, csvComment, csvFilename, previewText, previewFit, previewCell, sizeWords, PREVIEW_ROWS, PREVIEW_LIMIT,
};
