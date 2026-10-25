'use strict';

// The Dataset module: tells the person, privately, which data the bot reads:
// the source (local fixture or MotherDuck), the file or database name, the
// fixture version, the as-of date, when it was published and each table's
// row count. It reads its facts through the query runner (ctx.data.run) with
// one static template and no parameters, picked by the source: locally
// fixture_meta.sql; on MotherDuck fixture_meta_remote.sql, which adds what
// fixture:publish recorded. The build checked every rows_<table> against the
// table it names, and the runtime opens the data read-only.
// When the data is unavailable, the dispatcher tells the person so.

const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const SQL = Object.freeze({ local: read('fixture_meta.sql'), motherduck: read('fixture_meta_remote.sql') });
// describe().source when the bot reads MotherDuck (kit/runtime/data).
const MOTHERDUCK = 'MotherDuck';
const ROWS_PREFIX = 'rows_';

// Brightside demo default: the profile has no timezone setting (and the
// handler is not given the profile), so Published shows US Eastern time.
const TIME_ZONE = 'America/New_York';
const PUBLISHED_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

// fixture:publish records an ISO timestamp in UTC: "Oct 24, 2026, 9:56 PM EDT".
// A value that is not a date is shown as recorded.
function formatPublished(value) {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : PUBLISHED_FORMAT.format(at);
}

function formatCount(value) {
  return /^\d+$/.test(value) ? Number(value).toLocaleString('en-US') : value;
}

// Local rows have no src column: they are all fixture_meta.
const isMeta = (r) => (r.src || 'meta') === 'meta';

module.exports = async function dataset({ data, reply }) {
  const { source, label } = data.describe();
  const remote = source === MOTHERDUCK;
  const rows = await data.run(remote ? SQL.motherduck : SQL.local);
  const meta = new Map(rows.filter(isMeta).map((r) => [r.key, r.value]));
  const published = new Map(rows.filter((r) => r.src === 'publish').map((r) => [r.key, r.value]));
  const tables = rows
    .filter((r) => isMeta(r) && r.key.startsWith(ROWS_PREFIX))
    .map((r) => `• ${r.key.slice(ROWS_PREFIX.length)}: ${formatCount(r.value)}`);
  const version = (remote && published.get('fixture_version')) || meta.get('generator_version') || 'not recorded';
  const publishedAt = published.get('published_at');
  await reply([
    '*Dataset*',
    `Source: ${source}${label ? ` (${label})` : ''}`,
    `Fixture version: ${version}`,
    `As of: ${meta.get('as_of') || 'not recorded'}`,
    `Published: ${remote ? (publishedAt ? formatPublished(publishedAt) : 'not recorded') : 'local build'}`,
    `Tables (${tables.length}):`,
    ...tables,
  ].join('\n'));
};
