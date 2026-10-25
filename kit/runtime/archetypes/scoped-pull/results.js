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

const { messageFor, escapeText } = require('../../messages');
const { QueryBlocked, QueryFailed, CsvNotDelivered } = require('../../errors');
const { valueBlocks } = require('./form');

// Rows shown in the view; the CSV holds the rest.
const PREVIEW_ROWS = 10;
// A cell in the preview is cut to this many characters.
const PREVIEW_CELL = 24;

const count = (n) => Number(n).toLocaleString('en-US');
const rowsWord = (n) => `${count(n)} ${n === 1 ? 'row' : 'rows'}`;
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

// "38 rows", or "the first 5,000 of 6,200 rows" when capped.
function sizeWords(outcome) {
  return outcome.capped ? `the first ${count(outcome.rows.length)} of ${rowsWord(outcome.total)}` : rowsWord(outcome.total);
}

// One preview cell: text, one line, no backticks, cut to PREVIEW_CELL.
function previewCell(v) {
  let s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/`/g, "'");
  const chars = Array.from(s);
  return chars.length > PREVIEW_CELL ? `${chars.slice(0, PREVIEW_CELL - 1).join('')}…` : s;
}

// The first rows as an aligned table in a code block, escaped.
function previewText(columns, rows) {
  const table = [columns.map(previewCell), ...rows.slice(0, PREVIEW_ROWS).map((r) => columns.map((c) => previewCell(r[c])))];
  const widths = columns.map((_, i) => Math.max(...table.map((line) => Array.from(line[i]).length)));
  const lines = table.map((line) => line.map((cell, i) => cell + ' '.repeat(widths[i] - Array.from(cell).length)).join('  ').trimEnd());
  return `\`\`\`\n${escapeText(lines.join('\n'))}\n\`\`\``;
}

// The CSV's file name: the module id and the run time (UTC), never values.
function csvFilename(mod, when) {
  const stamp = when.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `${mod.id}-${stamp}.csv`;
}

// The DM message that carries the file.
function csvComment(mod, values, outcome) {
  const vals = (mod.parameters || [])
    .filter((p) => values[p.name] !== undefined && values[p.name] !== null)
    .map((p) => `${p.label || p.name}: ${p.type === 'boolean' ? (values[p.name] ? 'Yes' : 'No') : values[p.name]}`)
    .join(', ');
  const size = outcome.capped ? `${sizeWords(outcome)} (the engine stops at ${count(outcome.rows.length)})` : rowsWord(outcome.total);
  return escapeText(`${mod.label}: ${size}${vals ? `, for ${vals}` : ''}.`);
}

// Where the CSV went, as a context line.
function deliveryLine(outcome, delivery) {
  const what = outcome.capped ? `The CSV in your DM with me holds ${sizeWords(outcome)}. Narrow the values to see the rest.` : `The full list (${rowsWord(outcome.total)}) is a CSV in your DM with me.`;
  return delivery.permalink ? `${what} <${delivery.permalink}|Open the CSV>` : what;
}

// The view after a run with rows. delivery: { permalink } or { failed: true }.
function resultMessage(mod, values, outcome, delivery, { admin } = {}) {
  const shown = Math.min(PREVIEW_ROWS, outcome.rows.length);
  const label = escapeText(mod.label);
  const blocks = [
    section(`*${label}: ${sizeWords(outcome)}.*`),
    ...valueBlocks(mod, values),
    section(`*${shown === outcome.total ? 'The rows' : `The first ${count(shown)}`}:*\n${previewText(outcome.columns, outcome.rows)}`),
  ];
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
  resultMessage, failureMessage, runningMessage, csvComment, csvFilename, previewText, previewCell, PREVIEW_ROWS,
};
