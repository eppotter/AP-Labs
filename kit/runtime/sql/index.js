'use strict';

// SQL guardrails (AD-9). A pure, dependency-free check of SQL TEXT, run before
// any query reaches DuckDB.
//
// Threat model: in V1 every query is a reviewed static template (AD-10); no
// person and no LLM writes SQL. This check is defence in depth behind that and
// behind the locked DuckDB settings (Story 7.5), not the only line. It fails
// closed on anything it cannot classify.
//
// Why a tokenizer and not a regex (prior art: Varsity's sql-guardrails): a
// regex decides what a character means without knowing whether it is inside a
// string, a comment or code, so `COALESCE(x, '--')` hides the rest of a line
// from the guard while the database runs it. One left-to-right pass that tracks
// context gets that right by construction.
//
// DuckDB lexing this pass mirrors, and the parts it refuses rather than mirror:
// - `--` starts a line comment; `//` does not (it is integer division).
// - '...' strings escape a quote only as ''. A backslash is an ordinary
//   character. E'...' strings (backslash escapes), U&'...' / U&"..." (unicode
//   escapes) and $$...$$ / $tag$...$tag$ strings are refused: no template
//   needs them, and each is a place for this pass and DuckDB to disagree.
// - "..." is an identifier, case-insensitive like an unquoted one.
// - Block comments nest: each /* opens a level and each */ closes one, read
//   left to right two characters at a time, so `/* /* */ x */` is one comment
//   and `/*/` opens without closing. A parity test checks this against DuckDB.
// - Any non-ASCII character outside a string, comment or quoted identifier is
//   refused (DuckDB reads it as part of an identifier; unicode whitespace in
//   particular is not whitespace to DuckDB).

// Each verdict names one of these.
const RULES = Object.freeze({
  EMPTY: 'empty',
  UNTERMINATED: 'unterminated',
  UNSUPPORTED_SYNTAX: 'unsupported_syntax',
  NOT_A_QUERY: 'not_a_query',
  MULTIPLE_STATEMENTS: 'multiple_statements',
  WRITE_OR_DDL: 'write_or_ddl',
  BLOCKED_STATEMENT: 'blocked_statement',
  BLOCKED_FUNCTION: 'blocked_function',
  COLUMNS_EXPRESSION: 'columns_expression',
  TABLE_FUNCTION: 'table_function',
  PATH_AS_TABLE: 'path_as_table',
  URL_LITERAL: 'url_literal',
  FORBIDDEN_COLUMN: 'forbidden_column',
  WILDCARD: 'wildcard',
  POSITIONAL_COLUMN: 'positional_column',
  WHOLE_ROW: 'whole_row',
  COLUMN_ALIAS_LIST: 'column_alias_list',
});

// Table functions allowed in a FROM clause. V1: none.
const TABLE_FUNCTION_ALLOWLIST = new Set();

// Writes and DDL, refused anywhere as an unquoted keyword.
const WRITE_OR_DDL = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE',
  'GRANT', 'REVOKE', 'COMMENT', 'VACUUM', 'CHECKPOINT', 'EXPORT', 'IMPORT', 'RETURNING',
]);

// Statements that reach files, extensions, settings or session state, or that
// return a table's data without naming its columns. Refused anywhere.
const BLOCKED_STATEMENTS = new Set([
  'ATTACH', 'DETACH', 'SET', 'RESET', 'PRAGMA', 'INSTALL', 'LOAD', 'FORCE', 'COPY', 'USE',
  'CALL', 'EXECUTE', 'PREPARE', 'DEALLOCATE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'ABORT',
  'TRANSACTION', 'EXPLAIN', 'ANALYZE', 'SECRET', 'SUMMARIZE', 'DESCRIBE', 'SHOW', 'TABLE',
  'PIVOT', 'UNPIVOT', 'PIVOT_WIDER', 'PIVOT_LONGER',
]);

// Functions refused wherever they are called: file, network and env readers,
// and anything that runs SQL held in a string (which this check cannot see).
const BLOCKED_FUNCTIONS = new Set([
  'read_csv', 'read_csv_auto', 'read_parquet', 'parquet_scan', 'read_json', 'read_json_auto',
  'read_json_objects', 'read_ndjson', 'read_ndjson_auto', 'read_text', 'read_blob', 'glob',
  'getenv', 'current_setting', 'getvariable', 'query', 'query_table', 'json_execute_serialized_sql',
  'sniff_csv', 'iceberg_scan', 'delta_scan', 'st_read', 'which_secret',
]);
const BLOCKED_FUNCTION_PREFIXES = ['read_', 'parquet_', 'duckdb_', 'pragma_'];

// Functions whose argument syntax uses FROM without being a query.
const FROM_ARG_FUNCTIONS = new Set(['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY']);

// Keywords that end a FROM clause (or a relation's alias position).
const FROM_CLAUSE_END = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'QUALIFY', 'WINDOW', 'FETCH',
  'UNION', 'EXCEPT', 'INTERSECT', 'SELECT',
]);

// Words that can follow a relation but are not its alias.
const NOT_AN_ALIAS = new Set([
  ...FROM_CLAUSE_END, 'AS', 'ON', 'USING', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL',
  'CROSS', 'NATURAL', 'POSITIONAL', 'ASOF', 'ANTI', 'SEMI', 'LATERAL', 'SAMPLE', 'TABLESAMPLE',
  'REPEATABLE', 'WITH', 'VALUES', 'FROM',
]);

// Keywords after which a `*` has no left operand, so it selects columns.
const NON_OPERAND_KEYWORDS = new Set([
  'SELECT', 'ALL', 'DISTINCT', 'TOP', 'BY', 'ON', 'AS', 'AND', 'OR', 'NOT', 'WHERE', 'HAVING',
  'THEN', 'ELSE', 'WHEN', 'CASE', 'IN', 'IS', 'LIKE', 'ILIKE', 'BETWEEN', 'FROM', 'JOIN',
  'RETURNING', 'QUALIFY', 'WITH', 'UNION', 'EXCEPT', 'INTERSECT', 'VALUES', 'USING',
]);

const ASCII_SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const isIdentStart = (c) => /[A-Za-z_]/.test(c);
const isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c) => /[0-9]/.test(c);

class Refusal {
  constructor(rule, detail) { this.rule = rule; this.detail = detail; }
}

// The index just past the block comment that opens at s[start] ('/*'), with
// nesting as DuckDB reads it; -1 if it never closes.
function blockCommentEnd(s, start) {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    if (s[i] === '/' && s[i + 1] === '*') { depth += 1; i += 2; continue; }
    if (s[i] === '*' && s[i + 1] === '/') {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return -1;
}

// Token kinds: IDENT (v = upper-cased word, name = lower-cased; quoted = true
// for "..."), STRING (text = contents), NUMBER, PARAM ($name, $1, ?), PUNCT (v).
function tokenize(sql) {
  const s = sql;
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (ASCII_SPACE.has(c)) { i += 1; continue; }
    if (c.charCodeAt(0) > 0x7f) {
      throw new Refusal(RULES.UNSUPPORTED_SYNTAX, `non-ASCII character U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} outside a string`);
    }

    if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }

    if (c === '/' && s[i + 1] === '*') {
      i = blockCommentEnd(s, i);
      if (i === -1) throw new Refusal(RULES.UNTERMINATED, 'block comment never closes');
      continue;
    }

    if (c === "'") {
      let j = i + 1;
      let text = '';
      for (;;) {
        if (j >= s.length) throw new Refusal(RULES.UNTERMINATED, 'string never closes');
        if (s[j] === "'" && s[j + 1] === "'") { text += "'"; j += 2; continue; }
        if (s[j] === "'") { j += 1; break; }
        text += s[j];
        j += 1;
      }
      out.push({ t: 'STRING', text });
      i = j;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let text = '';
      for (;;) {
        if (j >= s.length) throw new Refusal(RULES.UNTERMINATED, 'quoted identifier never closes');
        if (s[j] === '"' && s[j + 1] === '"') { text += '"'; j += 2; continue; }
        if (s[j] === '"') { j += 1; break; }
        text += s[j];
        j += 1;
      }
      out.push({ t: 'IDENT', v: text.toUpperCase(), name: text.toLowerCase(), quoted: true });
      i = j;
      continue;
    }

    if (c === '$') {
      let j = i + 1;
      if (s[j] === '$') throw new Refusal(RULES.UNSUPPORTED_SYNTAX, 'dollar-quoted string');
      if (isDigit(s[j] || '')) {
        while (j < s.length && isDigit(s[j])) j += 1;
      } else if (isIdentStart(s[j] || '')) {
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
        if (s[j] === '$') throw new Refusal(RULES.UNSUPPORTED_SYNTAX, 'dollar-quoted string');
      } else {
        throw new Refusal(RULES.UNSUPPORTED_SYNTAX, 'stray $');
      }
      out.push({ t: 'PARAM' });
      i = j;
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(s[i + 1] || ''))) {
      let j = i;
      while (j < s.length && (isDigit(s[j]) || s[j] === '_')) j += 1;
      if (s[j] === '.') { j += 1; while (j < s.length && (isDigit(s[j]) || s[j] === '_')) j += 1; }
      if (/[eE]/.test(s[j] || '') && /[0-9+-]/.test(s[j + 1] || '')) {
        j += 1;
        if (/[+-]/.test(s[j])) j += 1;
        while (j < s.length && isDigit(s[j])) j += 1;
      }
      if (j === i) j += 1; // always make progress
      out.push({ t: 'NUMBER' });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < s.length && isIdentChar(s[j])) j += 1;
      const word = s.slice(i, j);
      const upper = word.toUpperCase();
      if (upper === 'E' && s[j] === "'") throw new Refusal(RULES.UNSUPPORTED_SYNTAX, "escape string E'...'");
      if (upper === 'U' && s[j] === '&') throw new Refusal(RULES.UNSUPPORTED_SYNTAX, 'unicode escape U&');
      out.push({ t: 'IDENT', v: upper, name: word.toLowerCase(), quoted: false });
      i = j;
      continue;
    }

    out.push(c === '?' ? { t: 'PARAM' } : { t: 'PUNCT', v: c });
    i += 1;
  }
  return out;
}

const isPunct = (tok, v) => Boolean(tok) && tok.t === 'PUNCT' && tok.v === v;
const isWord = (tok, v) => Boolean(tok) && tok.t === 'IDENT' && !tok.quoted && tok.v === v;
const isKeyword = (tok, set) => Boolean(tok) && tok.t === 'IDENT' && !tok.quoted && set.has(tok.v);

function blockedFunction(name) {
  return BLOCKED_FUNCTIONS.has(name) || BLOCKED_FUNCTION_PREFIXES.some((p) => name.startsWith(p));
}

// Matching parens, so `DISTINCT ON (x) *` can be told from `(a + b) * c`.
function matchParens(toks) {
  const open = [];
  const match = new Array(toks.length).fill(-1);
  toks.forEach((tok, k) => {
    if (isPunct(tok, '(')) open.push(k);
    else if (isPunct(tok, ')')) {
      if (!open.length) throw new Refusal(RULES.UNSUPPORTED_SYNTAX, 'unbalanced parentheses');
      const o = open.pop();
      match[k] = o;
      match[o] = k;
    }
  });
  if (open.length) throw new Refusal(RULES.UNSUPPORTED_SYNTAX, 'unbalanced parentheses');
  return match;
}

// Rules that hold whatever the profile says.
function checkStatementShape(toks) {
  if (!toks.length) throw new Refusal(RULES.EMPTY, 'no SQL');
  const semi = toks.findIndex((tok) => isPunct(tok, ';'));
  if (semi !== -1 && semi < toks.length - 1) throw new Refusal(RULES.MULTIPLE_STATEMENTS, 'more than one statement');

  toks.forEach((tok, k) => {
    if (tok.t !== 'IDENT' || tok.quoted || isPunct(toks[k - 1], '.')) return;
    if (WRITE_OR_DDL.has(tok.v)) throw new Refusal(RULES.WRITE_OR_DDL, `${tok.v} is not read-only`);
    if (BLOCKED_STATEMENTS.has(tok.v)) throw new Refusal(RULES.BLOCKED_STATEMENT, `${tok.v} is not allowed`);
  });

  const first = toks[0];
  if (!(isWord(first, 'SELECT') || isWord(first, 'WITH') || isPunct(first, '('))) {
    throw new Refusal(RULES.NOT_A_QUERY, 'a query starts with SELECT or WITH');
  }

  toks.forEach((tok, k) => {
    if (tok.t === 'STRING' && tok.text.includes('://')) throw new Refusal(RULES.URL_LITERAL, 'a URL in a string literal');
    if (tok.t !== 'IDENT' || !isPunct(toks[k + 1], '(')) return;
    if (tok.v === 'COLUMNS') throw new Refusal(RULES.COLUMNS_EXPRESSION, 'COLUMNS( selects columns by pattern');
    if (blockedFunction(tok.name)) throw new Refusal(RULES.BLOCKED_FUNCTION, `${tok.name}( is not allowed`);
  });
}

// Walks the statement with a frame per paren level, finding relation names and
// aliases (the FROM clause), table functions, strings used as tables and
// FROM-first queries (DuckDB's `FROM t`, an implicit SELECT *).
function analyseRelations(toks) {
  const relations = new Set();
  const defining = new Set();
  const fromFirst = [];
  const aliasLists = [];

  const frame = (kind, name) => ({ kind, name, selectSeen: false, inFrom: false, expect: null });
  const stack = [frame('query', null)];
  const top = () => stack[stack.length - 1];

  for (let k = 0; k < toks.length; k += 1) {
    const tok = toks[k];
    const f = top();

    // A relation item or its alias is expected at this position.
    if (f.expect === 'relation') {
      if (isWord(tok, 'LATERAL')) continue;
      f.expect = null;
      if (tok.t === 'STRING') throw new Refusal(RULES.PATH_AS_TABLE, 'a string used as a table');
      if (tok.t === 'PARAM') throw new Refusal(RULES.PATH_AS_TABLE, 'a parameter used as a table');
      if (tok.t === 'IDENT' && !isKeyword(tok, NOT_AN_ALIAS)) {
        // Dotted chain: db.schema.table. Every part is a defining position.
        let j = k;
        for (;;) {
          const part = toks[j];
          if (part.quoted && /[./\\:~]/.test(part.name)) throw new Refusal(RULES.PATH_AS_TABLE, 'a path-like name used as a table');
          defining.add(j);
          if (isPunct(toks[j + 1], '.') && toks[j + 2] && toks[j + 2].t === 'IDENT') { j += 2; continue; }
          break;
        }
        if (isPunct(toks[j + 1], '(')) {
          const fn = toks[j].name;
          if (!TABLE_FUNCTION_ALLOWLIST.has(fn)) throw new Refusal(RULES.TABLE_FUNCTION, `table function ${fn}( is not on the allowlist`);
        }
        relations.add(toks[j].name);
        k = j;
        f.expect = 'alias';
        continue;
      }
      // `(`: a subquery or a parenthesised join in relation position; its
      // alias follows the `)`. A join's first relation comes straight after.
      if (isPunct(tok, '(')) {
        stack.push({ ...frame('query', null), relationItem: true, inFrom: true, expect: 'relation' });
        continue;
      }
    }

    if (f.expect === 'alias' || f.expect === 'alias-after-as') {
      if (isWord(tok, 'AS')) { f.expect = 'alias-after-as'; continue; }
      if (tok.t === 'IDENT' && (tok.quoted || !NOT_AN_ALIAS.has(tok.v))) {
        relations.add(tok.name);
        defining.add(k);
        f.expect = null;
        if (isPunct(toks[k + 1], '(')) aliasLists.push(tok.name);
        continue;
      }
      f.expect = null;
    }

    if (isPunct(tok, '(')) {
      const prev = toks[k - 1];
      const callName = prev && prev.t === 'IDENT' ? prev.v : null;
      stack.push(frame(callName ? 'call' : 'query', callName));
      continue;
    }
    if (isPunct(tok, ')')) {
      const closed = stack.pop();
      if (closed.relationItem) top().expect = 'alias';
      continue;
    }

    if (tok.t !== 'IDENT' || tok.quoted || isPunct(toks[k - 1], '.')) {
      if (isPunct(tok, ',') && f.inFrom) f.expect = 'relation';
      continue;
    }

    if (tok.v === 'SELECT') { f.selectSeen = true; f.inFrom = false; continue; }
    if (tok.v === 'UNION' || tok.v === 'EXCEPT' || tok.v === 'INTERSECT') { f.selectSeen = false; f.inFrom = false; continue; }
    if (FROM_CLAUSE_END.has(tok.v)) { f.inFrom = false; continue; }
    if (tok.v === 'FROM') {
      if (f.kind === 'call' && FROM_ARG_FUNCTIONS.has(f.name)) continue;
      const p1 = toks[k - 1];
      const p2 = isWord(toks[k - 2], 'NOT') ? toks[k - 3] : toks[k - 2];
      if (isWord(p1, 'DISTINCT') && isWord(p2, 'IS')) continue;
      if (!f.selectSeen) fromFirst.push(k);
      f.inFrom = true;
      f.expect = 'relation';
      continue;
    }
    if (tok.v === 'JOIN' && f.inFrom) { f.expect = 'relation'; continue; }
    // CTE name: `name AS (`, `name AS [NOT] MATERIALIZED (`.
    if (isWord(toks[k + 1], 'AS')) {
      let j = k + 2;
      if (isWord(toks[j], 'NOT')) j += 1;
      if (isWord(toks[j], 'MATERIALIZED')) j += 1;
      if (isPunct(toks[j], '(')) defining.add(k);
    }
  }
  return { relations, defining, fromFirst, aliasLists };
}

// A `*` with no left operand selects columns; with one, it multiplies.
// COUNT(*) is the one column-less star.
function findWildcard(toks, match) {
  for (let k = 0; k < toks.length; k += 1) {
    if (!isPunct(toks[k], '*')) continue;
    const prev = toks[k - 1];
    if (!prev) return k;
    if (prev.t === 'PUNCT') {
      if (prev.v === '(') {
        if (isWord(toks[k - 2], 'COUNT') && isPunct(toks[k + 1], ')')) continue;
        return k;
      }
      if (prev.v === ']') continue;
      if (prev.v === ')') {
        // `DISTINCT ON (x) *` still selects every column.
        const open = match[k - 1];
        if (isWord(toks[open - 1], 'ON') && isWord(toks[open - 2], 'DISTINCT')) return k;
        continue;
      }
      return k; // `,` `.` and any other punctuation: no operand
    }
    if (prev.t === 'IDENT' && !prev.quoted && NON_OPERAND_KEYWORDS.has(prev.v)) return k;
    if (prev.t === 'NUMBER' && isWord(toks[k - 2], 'TOP')) return k;
  }
  return -1;
}

// Rules that hold while the profile names any forbidden column.
function checkForbidden(toks, match, forbidden) {
  const names = new Set(forbidden.map((fc) => fc.split('.')[1]));
  for (const tok of toks) {
    if (tok.t === 'IDENT' && names.has(tok.name)) throw new Refusal(RULES.FORBIDDEN_COLUMN, `"${tok.name}" is a forbidden column`);
  }

  if (findWildcard(toks, match) !== -1) throw new Refusal(RULES.WILDCARD, 'a wildcard selects forbidden columns');
  if (toks.some((tok) => isPunct(tok, '#'))) throw new Refusal(RULES.POSITIONAL_COLUMN, 'a positional column reference (#n)');

  const { relations, defining, fromFirst, aliasLists } = analyseRelations(toks);
  if (fromFirst.length) throw new Refusal(RULES.WILDCARD, 'FROM without SELECT selects every column');
  if (aliasLists.length) throw new Refusal(RULES.COLUMN_ALIAS_LIST, `a column alias list on "${aliasLists[0]}" renames columns by position`);

  toks.forEach((tok, k) => {
    if (tok.t !== 'IDENT' || defining.has(k) || !relations.has(tok.name)) return;
    if (isPunct(toks[k + 1], '.') || isPunct(toks[k + 1], '(')) return; // qualifier or call
    if (isWord(toks[k - 1], 'AS')) return; // a name being defined, never a value
    throw new Refusal(RULES.WHOLE_ROW, `"${tok.name}" used as a value returns the whole row`);
  });
}

function validateForbidden(forbiddenColumns) {
  if (!Array.isArray(forbiddenColumns)) throw new TypeError('forbiddenColumns must be an array of "table.column" strings');
  for (const fc of forbiddenColumns) {
    if (typeof fc !== 'string' || !/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(fc)) {
      throw new TypeError('forbiddenColumns entries must be lower-case "table.column" strings');
    }
  }
}

// Checks one SQL text. Returns { ok: true } or { ok: false, rule, detail }:
// `rule` is one of RULES; `detail` is a short plain reason. Never throws on
// SQL; throws TypeError on a malformed forbiddenColumns option.
function checkSql(sql, { forbiddenColumns = [] } = {}) {
  validateForbidden(forbiddenColumns);
  if (typeof sql !== 'string') return { ok: false, rule: RULES.EMPTY, detail: 'SQL must be a string' };
  try {
    const toks = tokenize(sql);
    const match = matchParens(toks);
    checkStatementShape(toks);
    // Table functions and strings used as tables are refused in every mode.
    if (forbiddenColumns.length) checkForbidden(toks, match, forbiddenColumns);
    else analyseRelations(toks);
    return { ok: true };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, rule: err.rule, detail: err.detail };
    throw err;
  }
}

// The forbidden columns a profile declares (AD-16 default: none).
function forbiddenColumnsOf(profile) {
  return (profile && profile.sql && profile.sql.forbidden_columns) || [];
}

module.exports = { checkSql, forbiddenColumnsOf, blockCommentEnd, RULES, TABLE_FUNCTION_ALLOWLIST };
