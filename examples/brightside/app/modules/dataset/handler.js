'use strict';

// The Dataset module: tells the person, privately, which data the bot reads:
// the source, the fixture version, the as-of date and each table's row count.
// It reads fixture_meta through the query runner (ctx.data.run), with one
// static template and no parameters. The build checked every rows_<table>
// against the table it names, and the runtime opens the file read-only.
// When the data is unavailable, the dispatcher tells the person so.

const fs = require('node:fs');
const path = require('node:path');

const SQL = fs.readFileSync(path.join(__dirname, 'fixture_meta.sql'), 'utf8');
const ROWS_PREFIX = 'rows_';

function formatCount(value) {
  return /^\d+$/.test(value) ? Number(value).toLocaleString('en-US') : value;
}

module.exports = async function dataset({ data, reply }) {
  const rows = await data.run(SQL);
  const meta = new Map(rows.map((r) => [r.key, r.value]));
  const { source, file } = data.describe();
  const tables = rows
    .filter((r) => r.key.startsWith(ROWS_PREFIX))
    .map((r) => `• ${r.key.slice(ROWS_PREFIX.length)}: ${formatCount(r.value)}`);
  await reply([
    '*Dataset*',
    `Source: ${source}${file ? ` (${file})` : ''}`,
    `Fixture version: ${meta.get('generator_version') || 'not recorded'}`,
    `As of: ${meta.get('as_of') || 'not recorded'}`,
    `Tables (${tables.length}):`,
    ...tables,
  ].join('\n'));
};
