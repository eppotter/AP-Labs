'use strict';

// Ask's query guard, the tokenizer half (plan brightside-v1, D10, Story 19.7):
// kit/runtime/sql checkSql with allowedTables. Every table reference is an
// allowed table or a top-level CTE; CTEs only at the top and never named like
// a data table; no clock; at least one allowed table read. The tables here are
// made up (test/fixtures/ask-guard), never a client's. The DuckDB-parse half
// is in runtime-data-ask.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSql, withoutTrailingSemicolon, RULES } = require('../../kit/runtime/sql');

const ALLOWED = ['zones', 'clients', 'properties', 'visits', 'fixture_meta'];
const KNOWN = [...ALLOWED, 'staff', 'pay_rates'];
const FORBIDDEN = ['clients.first_name', 'clients.email', 'properties.street_address', 'visits.labour_minutes'];
const ask = (sql, over = {}) => checkSql(sql, {
  forbiddenColumns: FORBIDDEN, allowedTables: ALLOWED, knownTables: KNOWN, ...over,
});

const refused = (sql, rule, over) => {
  const v = ask(sql, over);
  assert.equal(v.ok, false, sql);
  if (rule) assert.equal(v.rule, rule, `${sql}: ${v.detail}`);
};

// The story's list (19.7): each refused by the tokenizer.
const REFUSED = [
  ['SELECT c.column_name FROM information_schema.columns c', RULES.TABLE_NOT_ALLOWED],
  ['SELECT t.table_name FROM duckdb_tables() t', null],
  ['SELECT t.table_name FROM duckdb_tables t', RULES.TABLE_NOT_ALLOWED],
  ['SELECT COUNT(*) AS n FROM main.staff', RULES.TABLE_NOT_ALLOWED],
  ['SELECT COUNT(*) AS n FROM "staff"', RULES.TABLE_NOT_ALLOWED],
  ['SELECT s.n FROM (SELECT COUNT(*) AS n FROM staff) s', RULES.TABLE_NOT_ALLOWED],
  ['SELECT c.client_id FROM clients c JOIN pay_rates p ON p.staff_id = c.client_id', RULES.TABLE_NOT_ALLOWED],
  ['SELECT c.client_id FROM clients c WHERE EXISTS (SELECT 1 FROM staff)', RULES.TABLE_NOT_ALLOWED],
  // A nested WITH staff inside a subquery over an outer FROM staff (architect P1-2a).
  ['SELECT (SELECT x.y FROM (WITH staff AS (SELECT 1 AS y) SELECT staff.y FROM staff) x) AS v FROM staff', RULES.CTE_NOT_TOP_LEVEL],
  ['SELECT (SELECT x.y FROM (WITH staff AS (SELECT 1 AS y) SELECT staff.y FROM staff) x) AS v FROM zones', RULES.CTE_NOT_TOP_LEVEL],
  ['WITH clients AS (SELECT z.zone_id FROM zones z) SELECT clients.zone_id FROM clients', RULES.CTE_SHADOWS_TABLE],
  ['WITH staff AS (SELECT z.zone_id FROM zones z) SELECT staff.zone_id FROM staff', RULES.CTE_SHADOWS_TABLE],
];

test('every table reference outside the allowed tables is refused, however it is written', () => {
  for (const [sql, rule] of REFUSED) refused(sql, rule);
});

test('the clock is refused: "today" is fixture_meta\'s as_of (SQLsmith P2-8)', () => {
  for (const sql of [
    'SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date <= current_date',
    'SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date <= CURRENT_DATE',
    'SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date <= now()',
    'SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date <= today()',
    'SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date <= current_timestamp',
    'SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date <= get_current_timestamp()',
    'SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date <= localtimestamp',
    'SELECT epoch_ms(now()) AS t FROM zones z',
  ]) refused(sql, RULES.CLOCK_FUNCTION);
});

test('a query that reads no allowed table is refused, a constant or a CTE of constants (SQLsmith P1-3)', () => {
  refused('SELECT 815', RULES.NO_ALLOWED_TABLE);
  refused('SELECT 815 AS n;', RULES.NO_ALLOWED_TABLE);
  refused('WITH m AS (SELECT 1 AS x) SELECT m.x FROM m', RULES.NO_ALLOWED_TABLE);
});

test('Ask\'s guard always refuses wildcards and whole-row references, even with no forbidden columns', () => {
  refused('SELECT * FROM zones', RULES.WILDCARD, { forbiddenColumns: [] });
  refused('SELECT to_json(z) AS j FROM zones z', RULES.WHOLE_ROW, { forbiddenColumns: [] });
  refused('SELECT c.email FROM clients c', RULES.FORBIDDEN_COLUMN);
  refused('SELECT labour_minutes FROM visits', RULES.FORBIDDEN_COLUMN);
});

test('allowed queries pass: top-level CTEs, joins, as_of from fixture_meta, ORDER BY an alias, a trailing ;', () => {
  for (const sql of [
    'SELECT z.zone_id, z.name FROM zones z',
    "WITH meta AS (SELECT CAST(m.value AS DATE) AS as_of FROM fixture_meta m WHERE m.key = 'as_of') "
      + 'SELECT COUNT(v.visit_id) AS n FROM visits v, meta WHERE v.visit_date <= meta.as_of;',
    'SELECT c.zone_id, COUNT(DISTINCT c.client_id) AS n FROM clients c JOIN properties p ON p.client_id = c.client_id GROUP BY c.zone_id ORDER BY n DESC',
    'SELECT v.visit_id FROM visits v WHERE v.property_id IN (SELECT p.property_id FROM properties p) -- a comment',
    'SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date >= CAST($start AS DATE)',
  ]) assert.deepEqual(ask(sql), { ok: true }, sql);
});

test('without allowedTables nothing changes: the tools\' reviewed queries keep their rules', () => {
  assert.deepEqual(checkSql('SELECT COUNT(*) AS n FROM staff'), { ok: true });
  assert.deepEqual(checkSql('SELECT 815'), { ok: true });
  assert.deepEqual(checkSql('SELECT current_date AS d'), { ok: true });
});

test('malformed options throw a TypeError; SQL never does', () => {
  assert.throws(() => checkSql('SELECT 1', { allowedTables: 'zones' }), TypeError);
  assert.throws(() => checkSql('SELECT 1', { allowedTables: ['Zones'] }), TypeError);
  assert.throws(() => checkSql('SELECT 1', { allowedTables: ['zones'], knownTables: [1] }), TypeError);
  assert.equal(ask(42).ok, false);
});

test('withoutTrailingSemicolon cuts the one trailing ; and what follows it, and nothing else', () => {
  assert.equal(withoutTrailingSemicolon('SELECT 1;'), 'SELECT 1');
  assert.equal(withoutTrailingSemicolon('SELECT 1 ;  -- done\n'), 'SELECT 1');
  assert.equal(withoutTrailingSemicolon("SELECT ';' AS s"), "SELECT ';' AS s");
  assert.equal(withoutTrailingSemicolon('SELECT 1 -- ;'), 'SELECT 1 -- ;');
});
