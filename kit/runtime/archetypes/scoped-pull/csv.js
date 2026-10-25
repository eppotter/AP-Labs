'use strict';

// A scoped pull's rows as a CSV file (Story 9.5), RFC 4180: a header row of
// the query's column names, then one line per row, CRLF line ends, a field
// quoted when it holds a comma, a quote, a line break or edge spaces (quotes
// doubled). It starts with a UTF-8 byte order mark so a spreadsheet reads
// accented names correctly.
//
// The values are the data as the query returned it, never Slack-escaped (the
// file is not Slack text). One change, for spreadsheet safety: a text cell
// that starts with =, +, -, @, a tab or a carriage return gets a leading
// apostrophe, so opening the file can't run it as a formula. A plain number
// ("-125", "42.50") is left as it is. Null is an empty field; a list or
// struct value is written as JSON.

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  if (typeof v === 'string' && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) return `'${s}`;
  return s;
}

function field(v) {
  const s = cellText(v);
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// columns: the names, in order; rows: objects keyed by them.
function toCsv(columns, rows) {
  const lines = [columns.map(field).join(',')];
  for (const row of rows) lines.push(columns.map((c) => field(row[c])).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

module.exports = { toCsv, cellText, BOM };
