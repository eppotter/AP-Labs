'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSql, forbiddenColumnsOf, RULES } = require('../../kit/runtime/sql');

// Fixture columns, not a client's: the engine is tested on its own names.
const FORBIDDEN = ['people.phone', 'sites.street_address', 'sites.postal_code'];
const guarded = (sql) => checkSql(sql, { forbiddenColumns: FORBIDDEN });
const open = (sql) => checkSql(sql);

function blocked(verdict, rule, sql) {
  assert.equal(verdict.ok, false, `expected ${rule} for: ${sql}`);
  assert.equal(verdict.rule, rule, `wrong rule for: ${sql} (${verdict.detail})`);
  assert.equal(typeof verdict.detail, 'string');
}
const blocks = (rule, sql, check = guarded) => blocked(check(sql), rule, sql);
const allows = (sql, check = guarded) => {
  const v = check(sql);
  assert.deepEqual(v, { ok: true }, `expected allowed: ${sql} (${v.rule}: ${v.detail})`);
};

test('allows ordinary read-only templates', () => {
  allows('SELECT first_name, email FROM people WHERE zone_id = $zone LIMIT $limit');
  allows('SELECT p.first_name, s.city FROM people p JOIN sites AS s ON s.person_id = p.person_id;');
  allows(`WITH lapsed AS (
            SELECT person_id, max(end_date) AS lapsed_on FROM plans WHERE status = 'cancelled' GROUP BY person_id
          )
          SELECT l.person_id, l.lapsed_on FROM lapsed l ORDER BY l.lapsed_on DESC`);
  allows('SELECT count(*) AS n, count(*) * 100.0 / 7 AS pct FROM people');
  allows('SELECT (a + b) * c, qty * price, 2 * 3 FROM t');
  allows("SELECT extract(year FROM created_on), substring(email FROM 1 FOR 3), trim(both ' ' FROM email) FROM people");
  allows('SELECT a FROM t WHERE a IS NOT DISTINCT FROM b AND c IS DISTINCT FROM d');
  allows('SELECT x FROM (SELECT first_name AS x FROM people) sub');
  allows('(SELECT 1) UNION ALL (SELECT 2)');
  allows("SELECT 'St. Mary''s -- not a comment /* nor this */' AS label, first_name FROM people");
  allows('SELECT first_name FROM people WHERE person_id = ?');
});

test('returns the rule list it names', () => {
  assert.ok(Object.values(RULES).includes('forbidden_column'));
  assert.ok(Object.isFrozen(RULES));
});

// --- one read-only statement -------------------------------------------------

test('blocks DML', () => {
  blocks(RULES.WRITE_OR_DDL, "INSERT INTO people (first_name) VALUES ('x')");
  blocks(RULES.WRITE_OR_DDL, "UPDATE people SET email = 'x'");
  blocks(RULES.WRITE_OR_DDL, 'DELETE FROM people');
  blocks(RULES.WRITE_OR_DDL, 'MERGE INTO people USING x ON true WHEN MATCHED THEN DELETE');
  blocks(RULES.WRITE_OR_DDL, 'WITH gone AS (DELETE FROM people RETURNING person_id) SELECT person_id FROM gone');
  blocks(RULES.WRITE_OR_DDL, 'insert into people values (1)', open);
});

test('blocks DDL', () => {
  blocks(RULES.WRITE_OR_DDL, 'CREATE TABLE x AS SELECT 1');
  blocks(RULES.WRITE_OR_DDL, 'DROP TABLE people', open);
  blocks(RULES.WRITE_OR_DDL, 'ALTER TABLE people ADD COLUMN x INT');
  blocks(RULES.WRITE_OR_DDL, 'TRUNCATE people');
  blocks(RULES.WRITE_OR_DDL, 'CREATE MACRO m(x) AS x');
});

test('blocks stacked statements', () => {
  blocks(RULES.MULTIPLE_STATEMENTS, 'SELECT 1; SELECT 2', open);
  blocks(RULES.MULTIPLE_STATEMENTS, 'SELECT 1; DROP TABLE people', open);
  blocks(RULES.MULTIPLE_STATEMENTS, 'SELECT 1;;', open);
  allows('SELECT 1;', open);
});

test('blocks ATTACH, SET, PRAGMA, INSTALL, LOAD and COPY', () => {
  blocks(RULES.BLOCKED_STATEMENT, "ATTACH 'other.duckdb' AS other", open);
  blocks(RULES.BLOCKED_STATEMENT, 'SET enable_external_access = true', open);
  blocks(RULES.BLOCKED_STATEMENT, 'PRAGMA database_list', open);
  blocks(RULES.BLOCKED_STATEMENT, 'INSTALL httpfs', open);
  blocks(RULES.BLOCKED_STATEMENT, 'LOAD httpfs', open);
  blocks(RULES.BLOCKED_STATEMENT, 'FORCE INSTALL httpfs', open);
  blocks(RULES.BLOCKED_STATEMENT, "COPY people TO '/tmp/out.csv'", open);
  blocks(RULES.BLOCKED_STATEMENT, 'CALL pragma_version()', open);
  blocks(RULES.BLOCKED_STATEMENT, 'SELECT 1 FROM (SUMMARIZE people)', open);
  blocks(RULES.BLOCKED_STATEMENT, 'SELECT 1 FROM (DESCRIBE people)', open);
  blocks(RULES.BLOCKED_STATEMENT, 'SELECT x FROM (TABLE people) t', open);
  blocks(RULES.BLOCKED_STATEMENT, 'SELECT x FROM (PIVOT people ON zone_id) p', open);
});

test('blocks anything that is not a query', () => {
  blocks(RULES.NOT_A_QUERY, 'VALUES (1)', open);
  blocks(RULES.NOT_A_QUERY, 'FROM people', open);
  blocks(RULES.EMPTY, '', open);
  blocks(RULES.EMPTY, '  -- only a comment\n /* and this */ ', open);
  blocked(checkSql(null), RULES.EMPTY, 'null');
});

// --- files, network, env -----------------------------------------------------

test('blocks the file, network and env readers', () => {
  for (const fn of ['read_csv', 'read_csv_auto', 'read_parquet', 'read_json', 'read_text', 'read_blob', 'glob']) {
    blocks(RULES.BLOCKED_FUNCTION, `SELECT name FROM ${fn}('/etc/x')`, open);
  }
  blocks(RULES.BLOCKED_FUNCTION, "SELECT getenv('HOME')", open);
  blocks(RULES.BLOCKED_FUNCTION, "SELECT 'HOME'.getenv()", open);
  blocks(RULES.BLOCKED_FUNCTION, 'SELECT "GETENV"(\'HOME\')', open);
  blocks(RULES.BLOCKED_FUNCTION, "SELECT main.getenv('HOME')", open);
  blocks(RULES.BLOCKED_FUNCTION, "SELECT current_setting('home_directory')", open);
  blocks(RULES.BLOCKED_FUNCTION, 'SELECT name FROM duckdb_secrets()', open);
});

test('bypass: query( is blocked', () => {
  blocks(RULES.BLOCKED_FUNCTION, "SELECT x FROM query('SELECT phone AS x FROM people')", open);
});

test('bypass: query_table( is blocked', () => {
  blocks(RULES.BLOCKED_FUNCTION, "SELECT first_name FROM query_table('people')", open);
});

test('bypass: json_execute_serialized_sql is blocked', () => {
  blocks(RULES.BLOCKED_FUNCTION, "SELECT x FROM json_execute_serialized_sql('{}')", open);
  blocks(RULES.BLOCKED_FUNCTION, "SELECT json_execute_serialized_sql('{}')", open);
});

test('blocks every table function not on the allowlist (V1: empty)', () => {
  blocks(RULES.TABLE_FUNCTION, 'SELECT range FROM range(10)', open);
  blocks(RULES.TABLE_FUNCTION, 'SELECT x FROM people p, LATERAL unnest(p.tags) AS u(x)', open);
  blocks(RULES.TABLE_FUNCTION, 'SELECT x FROM people p JOIN generate_series(1, 3) g ON true', open);
  blocks(RULES.TABLE_FUNCTION, 'SELECT x FROM main.my_macro(1)', open);
});

test('blocks a quoted path or URL used as a table', () => {
  blocks(RULES.PATH_AS_TABLE, "SELECT a FROM 'data/people.csv'", open);
  blocks(RULES.PATH_AS_TABLE, "SELECT a FROM people JOIN '/etc/passwd' ON true", open);
  blocks(RULES.PATH_AS_TABLE, "SELECT a FROM people, '~/x.parquet'", open);
  blocks(RULES.PATH_AS_TABLE, 'SELECT a FROM "data/people.csv"', open);
  blocks(RULES.PATH_AS_TABLE, 'SELECT a FROM "people.parquet"', open);
  blocks(RULES.PATH_AS_TABLE, 'SELECT a FROM $tbl', open);
  blocks(RULES.URL_LITERAL, "SELECT a FROM 'https://example.invalid/x.csv'", open);
  blocks(RULES.URL_LITERAL, "SELECT a FROM 's3://bucket/x.parquet'", open);
  blocks(RULES.URL_LITERAL, "SELECT 'http://x' AS u", open);
});

// --- forbidden columns -------------------------------------------------------

test('blocks a forbidden column by name, qualified or not, in any case or quoting', () => {
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT phone FROM people');
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT p.phone FROM people p');
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT PHONE FROM people');
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT "phone" FROM people');
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT "PhOnE" FROM people');
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT "people"."phone" FROM people');
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT first_name FROM people WHERE phone LIKE \'555%\'');
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT city FROM sites ORDER BY postal_code');
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT upper(street_address) AS a FROM sites');
});

test('a forbidden column is only checked when configured', () => {
  allows('SELECT phone FROM people', open);
  assert.deepEqual(forbiddenColumnsOf({ sql: { forbidden_columns: FORBIDDEN } }), FORBIDDEN);
  assert.deepEqual(forbiddenColumnsOf({}), []);
});

test('rejects a malformed forbiddenColumns option', () => {
  assert.throws(() => checkSql('SELECT 1', { forbiddenColumns: 'people.phone' }), TypeError);
  assert.throws(() => checkSql('SELECT 1', { forbiddenColumns: ['phone'] }), TypeError);
  assert.throws(() => checkSql('SELECT 1', { forbiddenColumns: ['People.Phone'] }), TypeError);
});

test('blocks a wildcard select while a forbidden column is configured', () => {
  allows('SELECT * FROM people', open);
  blocks(RULES.WILDCARD, 'SELECT * FROM people');
  blocks(RULES.WILDCARD, 'select * from people');
  blocks(RULES.WILDCARD, 'SELECT p.* FROM people p');
  blocks(RULES.WILDCARD, 'SELECT "p".* FROM people p');
  blocks(RULES.WILDCARD, 'SELECT first_name, * FROM people');
  blocks(RULES.WILDCARD, 'SELECT DISTINCT * FROM people');
  blocks(RULES.WILDCARD, 'SELECT DISTINCT ON (zone_id) * FROM people');
  blocks(RULES.WILDCARD, 'SELECT TOP 10 * FROM people');
  blocks(RULES.WILDCARD, 'WITH x AS (SELECT * FROM people) SELECT first_name FROM x');
  blocks(RULES.WILDCARD, 'SELECT first_name FROM (SELECT * FROM people) s');
  blocks(RULES.WILDCARD, 'SELECT to_json(struct_pack(*)) FROM people');
  blocks(RULES.WILDCARD, 'SELECT * LIKE \'p%\' FROM people');
});

test('bypass: * EXCLUDE and * REPLACE are blocked', () => {
  blocks(RULES.WILDCARD, 'SELECT * EXCLUDE (email) FROM people');
  blocks(RULES.WILDCARD, 'SELECT p.* EXCLUDE (email) FROM people p');
  blocks(RULES.WILDCARD, "SELECT * REPLACE (upper(first_name) AS first_name) FROM people");
});

test('bypass: COLUMNS( is blocked', () => {
  blocks(RULES.COLUMNS_EXPRESSION, "SELECT COLUMNS('ph.*') FROM people");
  blocks(RULES.COLUMNS_EXPRESSION, "SELECT columns(c -> c LIKE '%one') FROM people", open);
  blocks(RULES.COLUMNS_EXPRESSION, 'SELECT max(COLUMNS(*)) FROM people');
  blocks(RULES.COLUMNS_EXPRESSION, 'SELECT *COLUMNS(*) FROM people', open);
});

test('bypass: a whole-row struct by table name is blocked', () => {
  blocks(RULES.WHOLE_ROW, 'SELECT people FROM people');
  blocks(RULES.WHOLE_ROW, 'SELECT to_json(people) FROM people');
  blocks(RULES.WHOLE_ROW, 'SELECT "PEOPLE" FROM main.people');
  blocks(RULES.WHOLE_ROW, 'SELECT people FROM (people JOIN sites USING (person_id))');
  allows('SELECT people FROM people', open);
});

test('bypass: a whole-row struct by alias is blocked', () => {
  blocks(RULES.WHOLE_ROW, 'SELECT c FROM people c');
  blocks(RULES.WHOLE_ROW, 'SELECT list(c) FROM people AS c');
  blocks(RULES.WHOLE_ROW, 'SELECT c[4] FROM people c');
  blocks(RULES.WHOLE_ROW, 'SELECT s FROM (SELECT first_name FROM people) s, sites');
  blocks(RULES.WHOLE_ROW, 'WITH x AS (SELECT first_name FROM people) SELECT x FROM x');
});

test('blocks other ways to select every column without naming one', () => {
  blocks(RULES.WILDCARD, 'SELECT x FROM (FROM people) s');
  blocks(RULES.WILDCARD, 'WITH x AS (FROM people) SELECT first_name FROM x');
  blocks(RULES.WILDCARD, 'SELECT ARRAY(FROM people)');
  blocks(RULES.WILDCARD, 'SELECT 1 UNION ALL FROM people');
  blocks(RULES.POSITIONAL_COLUMN, 'SELECT #6 FROM people');
  blocks(RULES.COLUMN_ALIAS_LIST, 'SELECT f FROM people p(a, b, c, d, e, f)');
});

// --- comment, string and quoting evasions -----------------------------------

test('a comment marker inside a string literal hides nothing', () => {
  blocks(RULES.WILDCARD, "SELECT coalesce(zone_id, '--'), * FROM people");
  blocks(RULES.WILDCARD, "SELECT '/*', * FROM people -- */");
  blocks(RULES.FORBIDDEN_COLUMN, "SELECT '--' AS a, phone FROM people");
});

test('comments do not hide code that follows them', () => {
  blocks(RULES.WILDCARD, 'SELECT /* note */ * FROM people');
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT first_name, -- why\n phone FROM people');
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT first_name, /**/phone FROM people');
  blocks(RULES.MULTIPLE_STATEMENTS, 'SELECT 1 /* x */; DELETE FROM people', open);
});

test('// is not a comment in DuckDB, so it hides nothing', () => {
  blocks(RULES.WILDCARD, 'SELECT 7 // 2, * FROM people');
});

test('a backslash does not escape a quote in a DuckDB string', () => {
  // DuckDB reads 'a\' as one string, so the star after it is code.
  blocks(RULES.WILDCARD, "SELECT 'a\\', * FROM people --'");
});

test('quoted identifiers are case-insensitive and read whole', () => {
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT "Phone" FROM people');
  allows('SELECT "pho""ne" FROM people');
  blocks(RULES.BLOCKED_FUNCTION, 'SELECT x FROM "Read_Csv"(\'f\')', open);
});

test('unterminated strings, identifiers and comments fail closed', () => {
  blocks(RULES.UNTERMINATED, "SELECT 'abc", open);
  blocks(RULES.UNTERMINATED, 'SELECT "abc', open);
  blocks(RULES.UNTERMINATED, 'SELECT 1 /* never closed', open);
  blocks(RULES.UNTERMINATED, "SELECT first_name FROM people WHERE x = 'it''s", open);
});

test('block comments nest, as in DuckDB: a comment ends only at its matching */', () => {
  // The `/* /* */ ... */` trick: an inner /* means the first */ does not close.
  allows('SELECT first_name FROM people /* outer /* inner */ , phone */');
  allows('SELECT first_name /* a /* b /* c */ d */ e */ FROM people');
  allows('SELECT first_name /*/ */ FROM people');
  allows('SELECT first_name /* /*/ */ */ FROM people');
  // Code after the matching */ is still checked.
  blocks(RULES.FORBIDDEN_COLUMN, 'SELECT first_name /* outer /* inner */ */ , phone FROM people');
  blocks(RULES.WILDCARD, 'SELECT 1 /* /* */ x */ , * FROM people');
  blocks(RULES.BLOCKED_STATEMENT, 'SELECT 1 /* /**/ */ ATTACH', open);
  // One */ too few fails closed.
  blocks(RULES.UNTERMINATED, 'SELECT 1 /* outer /* inner */', open);
  blocks(RULES.UNTERMINATED, 'SELECT 1 /* /* /* */ */', open);
});

test('syntax this check does not mirror fails closed', () => {
  blocks(RULES.UNSUPPORTED_SYNTAX, "SELECT E'a\\'', * FROM people", open);
  blocks(RULES.UNSUPPORTED_SYNTAX, 'SELECT U&"\\0070hone" FROM people', open);
  blocks(RULES.UNSUPPORTED_SYNTAX, 'SELECT $$ x $$', open);
  blocks(RULES.UNSUPPORTED_SYNTAX, 'SELECT $tag$ x $tag$', open);
  blocks(RULES.UNSUPPORTED_SYNTAX, 'SELECT (1', open);
  blocks(RULES.UNSUPPORTED_SYNTAX, 'SELECT 1)', open);
});

test('unicode whitespace and look-alikes outside strings fail closed', () => {
  blocks(RULES.UNSUPPORTED_SYNTAX, 'SELECT phone FROM people');
  blocks(RULES.UNSUPPORTED_SYNTAX, 'SELECT * FROM people');
  blocks(RULES.UNSUPPORTED_SYNTAX, 'SELECT ph​one FROM people');
  blocks(RULES.UNSUPPORTED_SYNTAX, 'SELECT　*　FROM people', open);
  allows("SELECT first_name FROM people WHERE city = 'Zürich'");
  allows('SELECT first_name FROM people -- café\n');
});
