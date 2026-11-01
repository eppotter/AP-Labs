'use strict';

// Ask's query guard, the half that needs the data (plan brightside-v1, D10,
// Story 19.7). Pure: the caller (kit/runtime/data/ask) reads the data's
// columns and DuckDB's parse and passes them in.
//
// - askTablesProblems: what boot refuses about the profile's ask.tables
//   against the data. An allowed table or column the data doesn't have (the
//   plan once listed properties.zone_id, which never existed: SQLsmith P1-2),
//   and an allowed column whose bare name a hidden column shares in another
//   allowed table, or a forbidden column anywhere (the tokenizer matches
//   forbidden names bare, so it would refuse the allowed one too; allowing it
//   needs qualified-name resolution, a DEP row).
// - askForbiddenColumns: sql.forbidden_columns plus every column of an
//   allowed table that ask.tables doesn't list (bare-name match in checkSql).
// - checkParsed: the second check, on DuckDB's own parse of the SQL
//   (json_serialize_sql: it lists every table and every column reference as
//   written; EXPLAIN's plan drops columns the optimiser folds away, so it
//   can't be the list). Every scanned table must be allowed and unqualified,
//   every column it names allowed (or an alias the query defines that no
//   scanned table has as a column), CTEs only at the top level and never
//   named like a data table, no clock, no table function, no wildcard, and
//   at least one allowed table read. Any node, expression or table shape it
//   does not know refuses (fail closed). The columns are read from the data
//   on every query, so a column added after boot (a republish) is refused
//   even though boot's forbidden list never named it.

const {
  RULES, blockedFunction, CLOCK_KEYWORDS, CLOCK_FUNCTIONS,
} = require('./index');

const IDENT = /^[a-z_][a-z0-9_]*$/;
const QUERY_NODES = new Set(['SELECT_NODE', 'SET_OPERATION_NODE']);
const TABLE_REFS = new Set(['BASE_TABLE', 'JOIN', 'SUBQUERY', 'EMPTY']);
const EXPRESSIONS = new Set([
  'BETWEEN', 'CASE', 'CAST', 'COLLATE', 'COLUMN_REF', 'COMPARISON', 'CONJUNCTION', 'CONSTANT', 'FUNCTION',
  'OPERATOR', 'PARAMETER', 'SUBQUERY', 'WINDOW',
]);
const MODIFIERS = new Set(['ORDER_MODIFIER', 'LIMIT_MODIFIER', 'DISTINCT_MODIFIER', 'LIMIT_PERCENT_MODIFIER']);

const filled = (v) => typeof v === 'string' && v.length > 0;
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cols = (allowed, t) => (Object.hasOwn(allowed, t) ? allowed[t] : []);

class Refusal {
  constructor(rule, detail) { this.rule = rule; this.detail = detail; }
}

// What boot refuses. allowed: { table: [columns] }; dataColumns: Map of
// table -> Set of its columns; forbiddenColumns: the profile's "table.column"
// list. Returns a list of problems, each naming the table or column.
function askTablesProblems(allowed, dataColumns, forbiddenColumns = []) {
  const problems = [];
  const forbiddenNames = new Map(forbiddenColumns.map((fc) => [fc.split('.')[1], fc]));
  const hiddenIn = new Map(); // bare name -> the first table.column hiding it
  for (const [t, list] of Object.entries(allowed)) {
    const have = dataColumns.get(t);
    if (!have) { problems.push(`ask.tables names table ${t}, which the data does not have`); continue; }
    for (const c of list) if (!have.has(c)) problems.push(`ask.tables names ${t}.${c}, which the data does not have`);
    for (const c of have) {
      if (!IDENT.test(c)) problems.push(`the data's column ${t}.${c} has a name the guard can't match (lower-case letters, digits and _ only)`);
      else if (!list.includes(c) && !hiddenIn.has(c)) hiddenIn.set(c, `${t}.${c}`);
    }
  }
  for (const [t, list] of Object.entries(allowed)) {
    for (const c of list) {
      const hidden = hiddenIn.get(c) || forbiddenNames.get(c);
      if (hidden && hidden !== `${t}.${c}`) {
        problems.push(`ask.tables allows ${t}.${c}, but ${hidden} is hidden and the guard matches column names bare, so it would refuse both`);
      }
    }
  }
  return problems;
}

// Ask's forbidden columns: the profile's, plus every column of an allowed
// table that ask.tables doesn't list. A sorted "table.column" list.
function askForbiddenColumns(allowed, dataColumns, forbiddenColumns = []) {
  const out = new Set(forbiddenColumns);
  for (const [t, list] of Object.entries(allowed)) {
    for (const c of dataColumns.get(t) || []) if (!list.includes(c) && IDENT.test(c)) out.add(`${t}.${c}`);
  }
  return [...out].sort();
}

// Walks DuckDB's parse. Returns what it names; throws Refusal on any shape
// it refuses.
function scan(parsed) {
  if (!isMap(parsed) || parsed.error !== false || !Array.isArray(parsed.statements)) {
    throw new Refusal(RULES.PARSE_REFUSED, 'DuckDB could not parse the SQL');
  }
  if (parsed.statements.length !== 1) throw new Refusal(RULES.MULTIPLE_STATEMENTS, 'more than one statement');
  const statement = parsed.statements[0];
  const top = isMap(statement) ? statement.node : null;
  if (!isMap(top) || !QUERY_NODES.has(top.type)) throw new Refusal(RULES.PARSE_REFUSED, 'not a query DuckDB parses as SELECT');

  const out = {
    ctes: [], baseTables: [], refs: [], aliases: new Set(), qualifiers: [], ordered: false,
  };
  out.ordered = Array.isArray(top.modifiers)
    && top.modifiers.some((m) => isMap(m) && m.type === 'ORDER_MODIFIER' && Array.isArray(m.orders) && m.orders.length > 0);

  const tableRef = (node) => {
    if (!isMap(node) || !TABLE_REFS.has(node.type)) {
      const type = isMap(node) ? String(node.type) : typeof node;
      if (type === 'TABLE_FUNCTION') throw new Refusal(RULES.TABLE_FUNCTION, 'a table function');
      throw new Refusal(RULES.PARSE_REFUSED, `a table reference of a kind the guard doesn't know (${type})`);
    }
  };

  const walk = (node, key, parent) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, key, parent)); return; }
    if (!isMap(node)) return;
    if (key === 'from_table' || ((key === 'left' || key === 'right') && parent && parent.type === 'JOIN')) tableRef(node);
    const queryKey = key === 'node' || ((key === 'left' || key === 'right') && parent && parent.type === 'SET_OPERATION_NODE');
    if (queryKey && !QUERY_NODES.has(node.type)) throw new Refusal(RULES.PARSE_REFUSED, `a query of a kind the guard doesn't know (${String(node.type)})`);
    if (key === 'modifiers' && !MODIFIERS.has(node.type)) {
      throw new Refusal(RULES.PARSE_REFUSED, `a query modifier the guard doesn't know (${String(node.type)})`);
    }

    if (typeof node.class === 'string') {
      if (node.class === 'STAR') throw new Refusal(RULES.WILDCARD, 'a wildcard selects every column');
      if (node.class === 'POSITIONAL_REFERENCE') throw new Refusal(RULES.POSITIONAL_COLUMN, 'a positional column reference (#n)');
      if (!EXPRESSIONS.has(node.class)) throw new Refusal(RULES.PARSE_REFUSED, `an expression the guard doesn't know (${node.class})`);
      if (filled(node.alias)) out.aliases.add(node.alias.toLowerCase());
      if (node.class === 'FUNCTION') {
        const name = String(node.function_name || '').toLowerCase();
        if (filled(node.schema) || filled(node.catalog)) throw new Refusal(RULES.BLOCKED_FUNCTION, `a qualified function (${name})`);
        if (CLOCK_FUNCTIONS.has(name)) throw new Refusal(RULES.CLOCK_FUNCTION, `${name} reads the clock`);
        if (name === 'columns') throw new Refusal(RULES.COLUMNS_EXPRESSION, 'COLUMNS( selects columns by pattern');
        if (blockedFunction(name)) throw new Refusal(RULES.BLOCKED_FUNCTION, `${name}( is not allowed`);
      }
      if (node.class === 'COLUMN_REF') {
        if (!Array.isArray(node.column_names) || !node.column_names.every(filled)) throw new Refusal(RULES.PARSE_REFUSED, 'a column reference the guard can\'t read');
        out.refs.push(node.column_names.map((n) => String(n).toLowerCase()));
      }
    } else if (typeof node.type === 'string' && (Object.hasOwn(node, 'select_list') || Object.hasOwn(node, 'setop_type') || Object.hasOwn(node, 'cte_map'))) {
      if (!QUERY_NODES.has(node.type)) throw new Refusal(RULES.PARSE_REFUSED, `a query of a kind the guard doesn't know (${node.type})`);
      const map = isMap(node.cte_map) && Array.isArray(node.cte_map.map) ? node.cte_map.map : null;
      if (!map) throw new Refusal(RULES.PARSE_REFUSED, 'a query with no CTE list');
      if (map.length && node !== top) throw new Refusal(RULES.CTE_NOT_TOP_LEVEL, 'a CTE that is not at the top level');
      for (const entry of map) {
        if (!isMap(entry) || !filled(entry.key) || !isMap(entry.value)) throw new Refusal(RULES.PARSE_REFUSED, 'a CTE the guard can\'t read');
        if (Array.isArray(entry.value.aliases) && entry.value.aliases.length) throw new Refusal(RULES.COLUMN_ALIAS_LIST, `a column alias list on the CTE ${entry.key}`);
        out.ctes.push(entry.key.toLowerCase());
      }
    } else if (node.type === 'JOIN') {
      // USING (col) names its columns as plain strings, not COLUMN_REF nodes,
      // so each is checked as a bare column (PR #323 review). A NATURAL join
      // matches every shared column, hidden ones too, without naming any.
      if (node.ref_type === 'NATURAL') throw new Refusal(RULES.COLUMN_NOT_ALLOWED, 'a NATURAL join matches columns it does not name');
      const using = node.using_columns === undefined ? [] : node.using_columns;
      if (!Array.isArray(using) || !using.every(filled)) throw new Refusal(RULES.PARSE_REFUSED, 'a USING list the guard can\'t read');
      for (const c of using) out.refs.push([c.toLowerCase()]);
    } else if (node.type === 'BASE_TABLE') {
      const name = String(node.table_name || '').toLowerCase();
      if (filled(node.schema_name) || filled(node.catalog_name)) {
        throw new Refusal(RULES.TABLE_NOT_ALLOWED, `a qualified table name (${[node.catalog_name, node.schema_name, name].filter(filled).join('.')})`);
      }
      if (!filled(name)) throw new Refusal(RULES.PARSE_REFUSED, 'a table with no name');
      if (node.at_clause !== null && node.at_clause !== undefined) throw new Refusal(RULES.PARSE_REFUSED, `an AT clause on ${name}`);
      if (Array.isArray(node.column_name_alias) && node.column_name_alias.length) throw new Refusal(RULES.COLUMN_ALIAS_LIST, `a column alias list on ${name}`);
      out.baseTables.push(name);
      out.qualifiers.push([name, name, 'table']);
      if (filled(node.alias)) out.qualifiers.push([node.alias.toLowerCase(), name, 'table']);
    } else if (node.type === 'SUBQUERY' && Object.hasOwn(node, 'subquery')) {
      if (Array.isArray(node.column_name_alias) && node.column_name_alias.length) throw new Refusal(RULES.COLUMN_ALIAS_LIST, `a column alias list on ${String(node.alias)}`);
      if (filled(node.alias)) out.qualifiers.push([node.alias.toLowerCase(), node.alias.toLowerCase(), 'derived']);
    }
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walk(v, k, node);
  };
  walk(statement, null, null);
  return out;
}

// The second check. parsed: JSON.parse of json_serialize_sql's output.
// allowed: { table: [columns] }; dataColumns: Map of table -> Set of columns,
// read from the data for this query. Returns { ok: true, tables, ordered }
// (tables: the allowed tables read, sorted; ordered: the outermost query has
// ORDER BY) or { ok: false, rule, detail }. Never throws on a parse.
function checkParsed(parsed, { allowedTables, dataColumns }) {
  try {
    const s = scan(parsed);
    const ctes = new Set(s.ctes);
    for (const name of ctes) {
      if (dataColumns.has(name) || Object.hasOwn(allowedTables, name)) throw new Refusal(RULES.CTE_SHADOWS_TABLE, `the CTE "${name}" has a data table's name`);
    }
    const scanned = new Set();
    for (const t of s.baseTables) {
      if (ctes.has(t)) continue;
      if (!Object.hasOwn(allowedTables, t)) throw new Refusal(RULES.TABLE_NOT_ALLOWED, `"${t}" is not an allowed table`);
      scanned.add(t);
    }
    if (!scanned.size) throw new Refusal(RULES.NO_ALLOWED_TABLE, 'the query reads no allowed table');

    // name -> Set of 'table:<t>' | 'derived:<name>'.
    const qualifiers = new Map();
    for (const [name, target, kind] of s.qualifiers) {
      const t = kind === 'table' && !ctes.has(target) ? `table:${target}` : `derived:${target}`;
      if (!qualifiers.has(name)) qualifiers.set(name, new Set());
      qualifiers.get(name).add(t);
    }
    const hiddenIn = (t, c) => Boolean(dataColumns.get(t) && dataColumns.get(t).has(c)) && !cols(allowedTables, t).includes(c);
    const allowedSomewhere = (c) => [...scanned].some((t) => cols(allowedTables, t).includes(c));
    const columnOfScanned = (c) => [...scanned].some((t) => dataColumns.get(t) && dataColumns.get(t).has(c));

    for (const parts of s.refs) {
      if (parts.length > 2) throw new Refusal(RULES.COLUMN_NOT_ALLOWED, `a column named with ${parts.length} parts`);
      const col = parts[parts.length - 1];
      if (parts.length === 2) {
        const targets = qualifiers.get(parts[0]);
        if (!targets) throw new Refusal(RULES.COLUMN_NOT_ALLOWED, `${parts[0]}.${col} names no table in the query`);
        for (const x of targets) {
          if (x.startsWith('table:') && !cols(allowedTables, x.slice(6)).includes(col)) {
            throw new Refusal(RULES.COLUMN_NOT_ALLOWED, `${x.slice(6)}.${col} is not an allowed column`);
          }
          if (x.startsWith('derived:') && !s.aliases.has(col) && !allowedSomewhere(col)) {
            throw new Refusal(RULES.COLUMN_NOT_ALLOWED, `${parts[0]}.${col} is neither an allowed column nor a name the query defines`);
          }
        }
        continue;
      }
      // A bare name. A table, alias or CTE name binds to the whole row; a
      // clock keyword reads the clock; a column hidden in any scanned table
      // is refused even if another scanned table allows it.
      if (qualifiers.has(col)) throw new Refusal(RULES.WHOLE_ROW, `"${col}" used as a value returns the whole row`);
      if (CLOCK_KEYWORDS.has(col.toLowerCase())) throw new Refusal(RULES.CLOCK_FUNCTION, `${col} reads the clock`);
      const hidden = [...scanned].find((t) => hiddenIn(t, col));
      if (hidden) throw new Refusal(RULES.COLUMN_NOT_ALLOWED, `${hidden}.${col} is not an allowed column`);
      if (allowedSomewhere(col)) continue;
      if (s.aliases.has(col) && !columnOfScanned(col)) continue;
      throw new Refusal(RULES.COLUMN_NOT_ALLOWED, `${col} is not an allowed column of a table the query reads`);
    }
    return { ok: true, tables: [...scanned].sort(), ordered: s.ordered };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, rule: err.rule, detail: err.detail };
    throw err;
  }
}

module.exports = { askTablesProblems, askForbiddenColumns, checkParsed };
