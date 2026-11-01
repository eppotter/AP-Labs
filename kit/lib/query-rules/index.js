'use strict';

// Query rules (plan brightside-v1, D11, Story 19.6): SQLsmith's signed canon
// of reviewed queries. The pure half: parsing, validation, the allow-list,
// the DuckDB-parse reads check and the judge. kit/query-rules/cli.js is the
// I/O half (the verify check and `npm run query-rules`).
//
// A query rule is a fenced block with the info string `query-rule`, under the
// "## Query rules" heading of data.md (in a fork, .aplabs/context/data.md),
// holding YAML. Blocks inside HTML comments are ignored, as for truths.
//
//   id             QR-NNN, unique in the file
//   kind           metric | traps
//   owner          who owns the rule
//   status         draft | approved | retired
//   signed_off     pending, or the ISO date it was signed
//   signed_off_by  pending, or who signed it (a named client person in a fork)
//
// A metric rule also has:
//
//   metric             the signed MET rule or Terminology term it implements
//   question_patterns  the questions it answers (a list of text)
//   definition         what the number means, in plain language
//   sql                the reviewed, read-only SQL; parameters as $name
//   params             name -> { type: date | integer | zone | enum, values? }
//   grain              the result's grain
//   unit               cents | count | number
//   traps              optional: the traps it avoids (a list of text)
//   reads              table -> [columns]: every table and column the SQL reads
//   check              what proves it: { truth | expect, tolerance?, params,
//                      rows?, sum? } (below)
//
// A traps rule (QR-000) holds `traps`, a list of text, and no SQL.
//
// The check. `truth` names a known truth in the same data.md (kit/lib/truths)
// that is signed off; a pending truth can never pass. Or `expect` states the
// figure (SQLsmith states it; the Verifier's output proves it in the PR),
// with an optional `tolerance` like a truth's. `params` gives a value for
// every declared parameter. By default the result must be exactly one row
// with one numeric column. `sum: <column>` adds that column over every row
// instead, and `rows: N` requires exactly N rows (QR-006: five zones whose
// counts sum to the active-plans truth).
//
// Signed means: valid, status approved, signed_off a date, signed_off_by
// named, and the rule's last verify result (query-rule:<id>) is pass. Only
// signed rules may ever be used by Ask (Stories 19.7, 19.8).
//
// The allow-list. The tables and columns a rule may read come from the
// profile's ask.tables (Story 19.7). Until that block exists, the bridge is
// ask-tables.yml beside data.md (`tables: { table: [columns] }`); with
// neither, every metric rule fails its check (fail closed). Every rule's
// `reads` must sit inside the allow-list, and every table and column its SQL
// names (read from DuckDB's own parse, json_serialize_sql) must sit inside
// `reads`. See readsProblems.

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { isIsoDate } = require('../dates');
const { extractBlocks, parseTolerance, allowance } = require('../truths');
const { contextDirFor } = require('../onboard');

const SECTION = /^##\s+Query rules\s*#*\s*$/i;
const INFO = 'query-rule';
const ID = /^QR-\d{3}$/;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ZONE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KINDS = Object.freeze(['metric', 'traps']);
const STATUSES = Object.freeze(['draft', 'approved', 'retired']);
const UNITS = Object.freeze(['cents', 'count', 'number']);
const PARAM_TYPES = Object.freeze(['date', 'integer', 'zone', 'enum']);
const COMMON_KEYS = ['id', 'kind', 'owner', 'status', 'signed_off', 'signed_off_by'];
const KEYS = Object.freeze({
  metric: [...COMMON_KEYS, 'metric', 'question_patterns', 'definition', 'sql', 'params', 'grain', 'unit', 'traps', 'reads', 'check'],
  traps: [...COMMON_KEYS, 'traps'],
});
const REQUIRED = Object.freeze({
  metric: [...COMMON_KEYS, 'metric', 'question_patterns', 'definition', 'sql', 'params', 'grain', 'unit', 'reads', 'check'],
  traps: [...COMMON_KEYS, 'traps'],
});
const CHECK_KEYS = Object.freeze(['truth', 'expect', 'tolerance', 'params', 'rows', 'sum']);
const ALLOW_FILE = 'ask-tables.yml';
const MAX_PATTERN_CHARS = 200;
// The most rows check.rows may require.
const MAX_SHOWN_ROWS = 50;

const filled = (v) => typeof v === 'string' && /\S/.test(v);
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textList = (v) => Array.isArray(v) && v.length > 0 && v.every(filled);

// A parameter value against its spec: null when it fits, else the problem.
// date: a real ISO date string; integer: a safe integer; zone: a zone id's
// shape (Ask checks it is in `zones`, Story 19.8); enum: one of `values`.
function paramValueProblem(spec, value) {
  switch (spec && spec.type) {
    case 'date': return typeof value === 'string' && isIsoDate(value) ? null : 'must be a real ISO date (YYYY-MM-DD)';
    case 'integer': return Number.isSafeInteger(value) ? null : 'must be an integer';
    case 'zone': return typeof value === 'string' && ZONE.test(value) ? null : 'must be a zone id';
    case 'enum': return spec.values.includes(value) ? null : `must be one of ${spec.values.join(', ')}`;
    default: return 'has no valid type';
  }
}

function validateParams(params, problems) {
  if (!isMap(params)) {
    problems.push('params must be a mapping of name to { type } (use {} for none)');
    return {};
  }
  const out = {};
  for (const [name, spec] of Object.entries(params)) {
    if (!IDENT.test(name)) { problems.push(`param "${name}" must be a lower-case name`); continue; }
    if (!isMap(spec)) { problems.push(`param ${name} must be { type: ... }`); continue; }
    for (const k of Object.keys(spec)) if (!['type', 'values'].includes(k)) problems.push(`param ${name}: unknown key "${k}"`);
    if (!PARAM_TYPES.includes(spec.type)) { problems.push(`param ${name}: type must be one of ${PARAM_TYPES.join(', ')}`); continue; }
    if (spec.type === 'enum') {
      if (!Array.isArray(spec.values) || !spec.values.length || !spec.values.every((v) => typeof v === 'string' || Number.isFinite(v))) {
        problems.push(`param ${name}: an enum needs values, a list of text or numbers`);
        continue;
      }
    } else if (spec.values !== undefined) problems.push(`param ${name}: only an enum has values`);
    out[name] = Object.freeze({ type: spec.type, ...(spec.type === 'enum' ? { values: Object.freeze([...spec.values]) } : {}) });
  }
  return out;
}

// The $name placeholders in a SQL text (outside '...' strings and comments).
function placeholders(sql) {
  const bare = String(sql)
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set();
  for (const m of bare.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*|\d+)/g)) names.add(m[1]);
  return names;
}

function validateReads(reads, problems) {
  if (!isMap(reads) || !Object.keys(reads).length) {
    problems.push('reads must map each table the SQL reads to its columns');
    return {};
  }
  const out = {};
  for (const [table, cols] of Object.entries(reads)) {
    if (!IDENT.test(table)) { problems.push(`reads: "${table}" is not a table name`); continue; }
    if (!Array.isArray(cols) || !cols.length || !cols.every((c) => typeof c === 'string' && IDENT.test(c))) {
      problems.push(`reads.${table} must be a list of column names`);
      continue;
    }
    out[table] = Object.freeze([...new Set(cols)]);
  }
  return out;
}

function validateCheck(check, params, problems) {
  if (!isMap(check)) {
    problems.push('check must be a mapping: { truth | expect, params }');
    return null;
  }
  for (const k of Object.keys(check)) if (!CHECK_KEYS.includes(k)) problems.push(`check: unknown key "${k}"`);
  const hasTruth = check.truth !== undefined;
  const hasExpect = check.expect !== undefined;
  if (hasTruth === hasExpect) problems.push('check must name exactly one of truth (a signed known truth) or expect (a stated figure)');
  if (hasTruth && !(typeof check.truth === 'string' && /^[a-z][a-z0-9-]*$/.test(check.truth))) problems.push('check.truth must be a known truth\'s id');
  if (hasExpect && !(typeof check.expect === 'number' && Number.isFinite(check.expect))) problems.push('check.expect must be a number');
  let tolerance = { kind: 'abs', value: 0 };
  if (check.tolerance !== undefined) {
    if (!hasExpect) problems.push('check.tolerance goes with expect only (a truth has its own)');
    tolerance = parseTolerance(check.tolerance);
    if (!tolerance) problems.push('check.tolerance must be a number >= 0 or a percent such as "0.5%"');
  }
  const values = check.params === undefined ? {} : check.params;
  if (!isMap(values)) problems.push('check.params must be a mapping of parameter values');
  else {
    for (const name of Object.keys(params)) if (!Object.hasOwn(values, name)) problems.push(`check.params has no value for ${name}`);
    for (const [name, v] of Object.entries(values)) {
      if (!params[name]) { problems.push(`check.params.${name} is not a declared parameter`); continue; }
      const bad = paramValueProblem(params[name], v);
      if (bad) problems.push(`check.params.${name} ${bad}`);
    }
  }
  if (check.rows !== undefined && !(Number.isInteger(check.rows) && check.rows >= 1 && check.rows <= MAX_SHOWN_ROWS)) {
    problems.push(`check.rows must be an integer from 1 to ${MAX_SHOWN_ROWS}`);
  }
  if (check.sum !== undefined && !(typeof check.sum === 'string' && IDENT.test(check.sum))) problems.push('check.sum must be a result column name');
  return Object.freeze({
    truth: hasTruth ? check.truth : null,
    expect: hasExpect ? check.expect : null,
    tolerance: tolerance || { kind: 'abs', value: 0 },
    params: Object.freeze(isMap(values) ? { ...values } : {}),
    rows: check.rows === undefined ? null : check.rows,
    sum: check.sum === undefined ? null : check.sum,
  });
}

// Validates one parsed YAML body. Returns { rule, problems }.
function validate(data) {
  const problems = [];
  if (!isMap(data)) return { rule: null, problems: ['block is not a YAML mapping'] };
  const kind = KINDS.includes(data.kind) ? data.kind : null;
  if (!kind) problems.push(`kind must be one of ${KINDS.join(', ')}`);
  const keys = KEYS[kind || 'metric'];
  for (const k of Object.keys(data)) if (!keys.includes(k)) problems.push(`unknown key "${k}"`);
  for (const k of REQUIRED[kind || 'metric']) if (data[k] === undefined || data[k] === null || data[k] === '') problems.push(`missing ${k}`);

  if (data.id != null && !(typeof data.id === 'string' && ID.test(data.id))) problems.push('id must be QR-NNN (three digits)');
  if (data.owner != null && !filled(data.owner)) problems.push('owner must name a person');
  if (data.status != null && !STATUSES.includes(data.status)) problems.push(`status must be one of ${STATUSES.join(', ')}`);
  const signedOff = data.signed_off === 'pending' || isIsoDate(data.signed_off) ? data.signed_off : null;
  if (data.signed_off != null && !signedOff) problems.push('signed_off must be pending or a real ISO date (YYYY-MM-DD)');
  const signedBy = filled(data.signed_off_by) ? data.signed_off_by.trim() : null;
  if (data.signed_off_by != null && !signedBy) problems.push('signed_off_by must be pending or name who signed it');
  if (signedOff && signedOff !== 'pending' && signedBy === 'pending') problems.push('signed_off is a date, so signed_off_by must name who signed it');
  if (signedOff === 'pending' && signedBy && signedBy !== 'pending') problems.push('signed_off_by names a signer, so signed_off must be the date they signed');
  if (data.status === 'approved' && (signedOff === 'pending' || signedBy === 'pending')) problems.push('an approved rule needs signed_off (a date) and signed_off_by (a name)');
  if (data.traps !== undefined && !textList(data.traps)) problems.push('traps must be a non-empty list of text');

  const base = {
    id: typeof data.id === 'string' ? data.id : null,
    kind,
    owner: filled(data.owner) ? data.owner.trim() : null,
    status: STATUSES.includes(data.status) ? data.status : null,
    signedOff,
    signedOffBy: signedBy,
    traps: textList(data.traps) ? Object.freeze(data.traps.map((t) => t.trim())) : Object.freeze([]),
  };
  if (kind !== 'metric') return { rule: Object.freeze(base), problems };

  if (data.metric != null && !filled(data.metric)) problems.push('metric must name the MET rule or term it implements');
  if (data.question_patterns != null) {
    if (!textList(data.question_patterns)) problems.push('question_patterns must be a non-empty list of text');
    else if (data.question_patterns.some((q) => q.length > MAX_PATTERN_CHARS)) problems.push(`a question pattern is over ${MAX_PATTERN_CHARS} characters`);
  }
  for (const k of ['definition', 'sql', 'grain']) if (data[k] != null && !filled(data[k])) problems.push(`${k} must be text`);
  if (data.unit != null && !UNITS.includes(data.unit)) problems.push(`unit must be one of ${UNITS.join(', ')}`);
  const params = data.params === undefined ? {} : validateParams(data.params, problems);
  const reads = data.reads === undefined ? {} : validateReads(data.reads, problems);
  const check = data.check === undefined ? null : validateCheck(data.check, params, problems);
  if (filled(data.sql)) {
    const used = placeholders(data.sql);
    for (const name of used) {
      if (/^\d+$/.test(name)) problems.push('sql binds parameters by name ($name), never by position');
      else if (!params[name]) problems.push(`sql uses $${name}, which params does not declare`);
    }
    for (const name of Object.keys(params)) if (!used.has(name)) problems.push(`param ${name} is not used in sql`);
  }
  return {
    rule: Object.freeze({
      ...base,
      metric: filled(data.metric) ? data.metric.trim() : null,
      questionPatterns: textList(data.question_patterns) ? Object.freeze([...data.question_patterns]) : Object.freeze([]),
      definition: filled(data.definition) ? data.definition.trim() : null,
      sql: filled(data.sql) ? data.sql.trim() : null,
      params: Object.freeze(params),
      grain: filled(data.grain) ? data.grain.trim() : null,
      unit: UNITS.includes(data.unit) ? data.unit : null,
      reads: Object.freeze(reads),
      check,
    }),
    problems,
  };
}

// Parses data.md text into [{ index, line, id, rule, problems }]: one entry
// per `query-rule` block, valid or not. `id` is the rule's own id when usable
// and unique, else `block-<index>`.
function parseRules(text) {
  const seen = new Set();
  return extractBlocks(text, { section: SECTION, info: INFO }).map((b) => {
    let entry;
    if (b.unclosed) entry = { rule: null, problems: ['block is not closed (no closing ```)'] };
    else {
      try {
        entry = validate(YAML.parse(b.body));
      } catch (err) {
        entry = { rule: null, problems: [`block is not valid YAML: ${err.message.split('\n')[0]}`] };
      }
    }
    const own = entry.rule && entry.rule.id && ID.test(entry.rule.id) ? entry.rule.id : null;
    if (own && seen.has(own)) entry.problems.push(`duplicate id "${own}"`);
    const id = own && !seen.has(own) ? own : `block-${b.index}`;
    if (own) seen.add(own);
    return { index: b.index, line: b.line, id, ...entry };
  });
}

// Reads <contextDir>/data.md. A missing file is no rules; an unreadable one
// is a single malformed entry (index 0), so it fails verify.
function loadRules(contextDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(contextDir, 'data.md'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    return [{ index: 0, line: 0, id: 'data-md', rule: null, problems: [`cannot read data.md: ${err.code || err.message}`] }];
  }
  return parseRules(text);
}

// Validates an allow-list: { table: [columns] }. Returns { tables, problem }.
function validateAllowList(tables) {
  if (!isMap(tables) || !Object.keys(tables).length) return { tables: null, problem: 'the allow-list must map tables to their allowed columns' };
  const out = {};
  for (const [t, cols] of Object.entries(tables)) {
    if (!IDENT.test(t) || !Array.isArray(cols) || !cols.length || !cols.every((c) => typeof c === 'string' && IDENT.test(c))) {
      return { tables: null, problem: `the allow-list entry "${t}" must be a table name with a list of column names` };
    }
    out[t] = Object.freeze([...new Set(cols)]);
  }
  return { tables: Object.freeze(out), problem: null };
}

// The tables and columns rules may read: the profile's ask.tables (Story
// 19.7) when present, else ask-tables.yml beside data.md (the bridge until
// then). Returns { tables, source, problem }; with neither, tables is null.
function allowListFor(profile, contextDir, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  if (profile && isMap(profile.ask) && profile.ask.tables !== undefined) {
    return { ...validateAllowList(profile.ask.tables), source: 'profile ask.tables' };
  }
  let raw;
  try {
    raw = readFile(path.join(contextDir, ALLOW_FILE));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { tables: null, source: null, problem: `no allow-list: the profile has no ask.tables and there is no ${ALLOW_FILE}` };
    return { tables: null, source: ALLOW_FILE, problem: `cannot read ${ALLOW_FILE}: ${(err && err.code) || 'error'}` };
  }
  let doc;
  try {
    doc = YAML.parse(raw);
  } catch {
    return { tables: null, source: ALLOW_FILE, problem: `${ALLOW_FILE} is not valid YAML` };
  }
  if (!isMap(doc) || Object.keys(doc).some((k) => k !== 'tables')) return { tables: null, source: ALLOW_FILE, problem: `${ALLOW_FILE} must hold only tables: { table: [columns] }` };
  return { ...validateAllowList(doc.tables), source: ALLOW_FILE };
}

// A rule's declared reads outside the allow-list: a list of problems.
function readsOutside(rule, allowed) {
  const problems = [];
  for (const [table, cols] of Object.entries(rule.reads)) {
    if (!allowed[table]) { problems.push(`reads table ${table}, which the allow-list does not allow`); continue; }
    for (const c of cols) if (!allowed[table].includes(c)) problems.push(`reads ${table}.${c}, which the allow-list does not allow`);
  }
  return problems;
}

// What DuckDB's parse (json_serialize_sql) names: { tables: Map<alias or
// name, Set<table>>, baseTables: Set, derived: Set (CTE and subquery names),
// refs: [[...parts]], aliases: Set, problems }. Walks every node, so a
// subquery, a CTE or a join anywhere is seen. Anything it can't place is a
// problem (fail closed): a qualified table name, a table function, a
// wildcard, more than one statement, a parse error.
function scanParse(parsed) {
  const out = {
    qualifiers: new Map(), baseTables: new Set(), derived: new Set(), refs: [], aliases: new Set(), problems: [],
  };
  if (!isMap(parsed) || parsed.error !== false || !Array.isArray(parsed.statements)) {
    out.problems.push('DuckDB could not parse the SQL');
    return out;
  }
  if (parsed.statements.length !== 1) out.problems.push('the SQL must be exactly one statement');
  const addQualifier = (name, target) => {
    if (!out.qualifiers.has(name)) out.qualifiers.set(name, new Set());
    out.qualifiers.get(name).add(target);
  };
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isMap(node)) return;
    if (node.type === 'BASE_TABLE') {
      if (filled(node.schema_name) || filled(node.catalog_name)) out.problems.push(`a qualified table name (${[node.catalog_name, node.schema_name, node.table_name].filter(filled).join('.')})`);
      const name = String(node.table_name || '');
      out.baseTables.add(name);
      addQualifier(name, `table:${name}`);
      if (filled(node.alias)) addQualifier(node.alias, `table:${name}`);
      if (Array.isArray(node.column_name_alias) && node.column_name_alias.length) out.problems.push(`a column alias list on ${name}`);
    } else if (node.type === 'TABLE_FUNCTION') {
      out.problems.push('a table function');
    } else if (node.type === 'SUBQUERY' && filled(node.alias)) {
      out.derived.add(node.alias);
      addQualifier(node.alias, `derived:${node.alias}`);
    }
    if (node.class === 'STAR' || node.type === 'STAR') out.problems.push('a wildcard (*) selects every column');
    if (node.class === 'COLUMN_REF' && Array.isArray(node.column_names)) out.refs.push(node.column_names.map(String));
    if (node.class && filled(node.alias)) out.aliases.add(node.alias);
    if (isMap(node.cte_map) && Array.isArray(node.cte_map.map)) {
      for (const entry of node.cte_map.map) {
        if (!entry || !filled(entry.key)) continue;
        out.derived.add(entry.key);
        addQualifier(entry.key, `derived:${entry.key}`);
        if (entry.value && Array.isArray(entry.value.aliases)) entry.value.aliases.forEach((a) => out.aliases.add(String(a)));
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(parsed.statements);
  // A CTE's name in FROM parses as a BASE_TABLE; it is not a data table.
  for (const name of out.derived) {
    if (out.baseTables.has(name)) {
      out.baseTables.delete(name);
      for (const set of out.qualifiers.values()) if (set.delete(`table:${name}`)) set.add(`derived:${name}`);
    }
  }
  return out;
}

// The reads check (D11): every table and column the parsed SQL names must sit
// inside the rule's `reads`, `reads` inside the allow-list, and no derived
// name (a CTE) may shadow a data table. dataColumns: table -> Set of every
// column the data has (information_schema), so a hidden column is named as
// one. Returns a list of problems; empty means the check passed this step.
function readsProblems(rule, parsed, allowed, dataColumns) {
  const problems = [...readsOutside(rule, allowed)];
  const scan = scanParse(parsed);
  problems.push(...scan.problems);
  if (scan.problems.length) return problems;
  for (const name of scan.derived) if (dataColumns.has(name)) problems.push(`the name ${name} is a data table; a CTE or subquery may not reuse it`);
  for (const t of scan.baseTables) {
    if (!rule.reads[t]) problems.push(`the SQL reads table ${t}, which reads does not list`);
    if (!dataColumns.has(t)) problems.push(`the SQL reads ${t}, which the data does not have`);
  }
  for (const t of Object.keys(rule.reads)) if (!scan.baseTables.has(t)) problems.push(`reads lists ${t}, which the SQL does not read`);
  const readCols = (t) => rule.reads[t] || [];
  const hiddenIn = (t, c) => Boolean(dataColumns.get(t) && dataColumns.get(t).has(c)) && !readCols(t).includes(c);
  const scanned = [...scan.baseTables];
  for (const parts of scan.refs) {
    if (parts.length > 2) { problems.push(`a column named with ${parts.length} parts (${parts.join('.')})`); continue; }
    const col = parts[parts.length - 1];
    if (parts.length === 2) {
      const targets = scan.qualifiers.get(parts[0]);
      if (!targets) { problems.push(`${parts.join('.')} names no table in the SQL`); continue; }
      const tables = [...targets].filter((x) => x.startsWith('table:')).map((x) => x.slice(6));
      const hidden = tables.filter((t) => hiddenIn(t, col));
      if (hidden.length) { problems.push(`the SQL reads ${hidden[0]}.${col}, which reads does not list`); continue; }
      if (tables.some((t) => readCols(t).includes(col))) continue;
      const viaDerived = [...targets].some((x) => x.startsWith('derived:'));
      if (viaDerived && (scan.aliases.has(col) || scanned.some((t) => readCols(t).includes(col)))) continue;
      problems.push(`the SQL reads ${parts.join('.')}, which reads does not list`);
      continue;
    }
    // A bare name. DuckDB binds a bare table or alias name (`SELECT s FROM
    // shops s`) to the whole row, hidden columns included, so a bare name
    // that is any table, alias, CTE or subquery name is refused, even when an
    // output alias shares it. Otherwise it must be a column the rule's reads
    // list for a table the SQL reads: never an output alias (qualify those).
    if (scan.qualifiers.has(col)) { problems.push(`"${col}" names a table or alias, not a column: a whole-row reference`); continue; }
    const hidden = scanned.filter((t) => hiddenIn(t, col));
    if (hidden.length) { problems.push(`the SQL reads ${hidden[0]}.${col}, which reads does not list`); continue; }
    if (scanned.some((t) => readCols(t).includes(col))) continue;
    if (scan.aliases.has(col)) { problems.push(`the bare name ${col} is an output alias, not a column the rule reads; qualify it`); continue; }
    problems.push(`the SQL reads ${col}, which reads does not list`);
  }
  return [...new Set(problems)];
}

// What --rows may print (PR #321 review): aggregates only, so a PR, which in
// a fork is the client's GitHub, never holds a row of client data. A result
// column is printable only when DuckDB's parse shows it is a COUNT, SUM or
// AVG (or an expression whose every column sits inside one: COALESCE(SUM(x),
// 0)), it has an output alias, and its name is not an id. MIN and MAX are
// not aggregates here: they return one row's value. Everything else (group
// keys, names, ids, text) prints as [hidden], and more than MAX_PRINTED_ROWS
// rows print nothing.
const AGGREGATES = new Set(['count', 'count_star', 'sum', 'avg', 'mean']);
const MAX_PRINTED_ROWS = 10;
const HIDDEN = '[hidden]';
const ID_NAME = /(^|_)id$/i;

// True when every column under node sits inside an aggregate, and at least
// one aggregate (or COUNT(*)) is there.
function isAggregateExpr(node) {
  let found = false;
  let bare = false;
  const walk = (n, inside) => {
    if (Array.isArray(n)) { n.forEach((x) => walk(x, inside)); return; }
    if (!isMap(n)) return;
    if (n.class === 'COLUMN_REF' || n.class === 'STAR' || n.class === 'SUBQUERY') { if (!inside) bare = true; return; }
    const agg = n.class === 'FUNCTION' && AGGREGATES.has(String(n.function_name).toLowerCase());
    if (agg) found = true;
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, inside || agg);
  };
  walk(node, false);
  return found && !bare;
}

// The output columns of the statement's top SELECT that are aggregates:
// a Set of names. A set operation, or anything not a plain SELECT, gives none.
function aggregateColumns(parsed) {
  const out = new Set();
  const node = isMap(parsed) && Array.isArray(parsed.statements) && parsed.statements.length === 1 ? parsed.statements[0].node : null;
  if (!isMap(node) || node.type !== 'SELECT_NODE' || !Array.isArray(node.select_list)) return out;
  for (const item of node.select_list) {
    if (filled(item.alias) && !ID_NAME.test(item.alias) && isAggregateExpr(item)) out.add(item.alias);
  }
  return out;
}

const NUMERIC = /^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i;

// The rows as --rows prints them: { lines, note }. Aggregate columns keep a
// numeric value; every other value is [hidden]. Over MAX_PRINTED_ROWS rows:
// no row at all, only the note.
function printableRows(rows, aggregates) {
  if (!Array.isArray(rows)) return { lines: [], note: 'no rows' };
  if (rows.length > MAX_PRINTED_ROWS) return { lines: [], note: `${rows.length} rows: not printed (more than ${MAX_PRINTED_ROWS}; aggregates only)` };
  const lines = rows.map((r) => {
    const shown = {};
    for (const [k, v] of Object.entries(r)) {
      const ok = aggregates.has(k) && (typeof v === 'number' || (typeof v === 'string' && NUMERIC.test(v)));
      shown[k] = ok ? v : HIDDEN;
    }
    return JSON.stringify(shown);
  });
  const hiddenAny = lines.some((l) => l.includes(HIDDEN));
  return { lines, note: hiddenAny ? `${HIDDEN}: not an aggregate (group keys, ids and text are never printed)` : null };
}

// The figure a rule's result gives: { value } or { error }. Rows are the
// runner's JSON rows (BIGINT as a string). With check.sum, that column is
// added over every row; else exactly one row with one column.
function figureOf(rule, rows) {
  const { check } = rule;
  if (!Array.isArray(rows)) return { error: 'no result' };
  if (check.rows !== null && rows.length !== check.rows) return { error: `expected ${check.rows} rows, got ${rows.length}` };
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && /^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(String(v)) ? n : null;
  };
  if (check.sum) {
    if (!rows.length) return { error: 'no rows to sum' };
    let total = 0;
    for (const r of rows) {
      if (!Object.hasOwn(r, check.sum)) return { error: `the result has no column ${check.sum}` };
      const n = num(r[check.sum]);
      if (n === null) return { error: `${check.sum} is not a number in every row` };
      total += n;
    }
    return { value: total };
  }
  if (rows.length !== 1) return { error: `expected 1 row, got ${rows.length}` };
  const values = Object.values(rows[0]);
  if (values.length !== 1) return { error: `expected 1 column, got ${values.length}` };
  const n = num(values[0]);
  return n === null ? { error: 'the value is not a number' } : { value: n };
}

// The figure the check wants: { expect, tolerance, from } or { error }.
// truths: parseTruths entries from the same data.md. A truth that is missing,
// malformed or not signed off can't be a check (fail closed).
function targetOf(rule, truths) {
  const { check } = rule;
  if (check.truth === null) return { expect: check.expect, tolerance: check.tolerance, from: 'its stated figure' };
  const t = truths.find((e) => e.id === check.truth);
  if (!t) return { error: `the linked truth ${check.truth} is not in data.md` };
  if (t.problems.length) return { error: `the linked truth ${check.truth} has problems in data.md` };
  if (!t.truth.owner || !t.truth.signedOff || t.truth.signedOff === 'pending') return { error: `the linked truth ${check.truth} is not signed off` };
  return { expect: t.truth.expect, tolerance: t.truth.tolerance, from: `truth ${check.truth}` };
}

// Pass or fail for a figure against the target: { outcome, reason }.
function judgeFigure(value, target) {
  const diff = Math.abs(value - target.expect);
  const slack = Number.EPSILON * Math.max(Math.abs(value), Math.abs(target.expect)) * 4;
  const tol = target.tolerance.kind === 'pct' ? `${target.tolerance.value}%` : String(target.tolerance.value);
  if (diff <= allowance(target.tolerance, target.expect) + slack) return { outcome: 'pass', reason: `${value} matches ${target.from} (${target.expect} ± ${tol})` };
  return { outcome: 'fail', reason: `${value}, but ${target.from} expects ${target.expect} ± ${tol}` };
}

// The verify checks (`query-rule:<id>`), one per rule that is not retired.
// A malformed one carries its problem and fails without spawning; the rest
// run `node <cli> --check <id>`, which exits 0 only on a pass.
function queryRuleChecks(entries, cli = 'kit/query-rules/cli.js') {
  return entries
    .filter((e) => !(e.rule && e.rule.status === 'retired' && !e.problems.length))
    .map((e) => {
      const id = `query-rule:${e.id}`;
      if (e.problems.length) return { id, problem: `line ${e.line}: ${e.problems.join('; ')}` };
      return { id, run: ['node', cli, '--check', e.id], timeout_seconds: 120 };
    });
}

// The query-rule checks for the repo governed by `profileFile` (its data.md
// sits in the context folder beside it, kit/lib/onboard).
function queryRuleChecksFor(profileFile) {
  return queryRuleChecks(loadRules(contextDirFor(path.resolve(profileFile))));
}

// Whether a rule is signed (D11): valid, approved, dated, named, and its last
// verify outcome (`last`, from kit/lib/verify/last) for query-rule:<id> pass.
function isSigned(entry, last) {
  if (!entry || entry.problems.length || !entry.rule) return false;
  const r = entry.rule;
  if (r.status !== 'approved' || !r.signedOff || r.signedOff === 'pending' || !r.signedOffBy || r.signedOffBy === 'pending') return false;
  const outcomes = new Map(((last && last.results) || []).map((x) => [x.id, x.outcome]));
  return outcomes.get(`query-rule:${entry.id}`) === 'pass';
}

const countSigned = (entries, last) => entries.filter((e) => isSigned(e, last)).length;

// The draft block `npm run query-rules -- --new QR-NNN --from <queue id>`
// adds: status draft, signed_off pending, the question as its first pattern,
// and every field SQLsmith must fill marked TODO (it fails verify until then).
function scaffold(id, question) {
  if (!ID.test(id)) throw new TypeError('a rule id is QR-NNN');
  const pattern = String(question || '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PATTERN_CHARS);
  const body = YAML.stringify({
    id,
    kind: 'metric',
    metric: 'TODO: the MET rule or Terminology term',
    question_patterns: [pattern || 'TODO'],
    definition: 'TODO',
    sql: 'TODO',
    params: {},
    grain: 'TODO',
    unit: 'count',
    reads: { TODO: ['TODO'] },
    check: { expect: 0, params: {} },
    owner: 'TODO',
    status: 'draft',
    signed_off: 'pending',
    signed_off_by: 'pending',
  }, { lineWidth: 0 });
  return `\`\`\`${INFO}\n${body}\`\`\`\n`;
}

// data.md text with `block` added at the end of the "## Query rules" section
// (before the next ## heading), creating the section at the end when absent.
function insertBlock(text, block) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => SECTION.test(l));
  if (start === -1) {
    const trimmed = String(text).replace(/\s*$/, '');
    return `${trimmed}\n\n## Query rules\n\n${block}`;
  }
  let end = lines.length;
  let fence = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && !lines[i].trim().slice(f[1].length)) fence = null;
      continue;
    }
    if (!fence && /^#{1,2}\s/.test(lines[i])) { end = i; break; }
  }
  const before = lines.slice(0, end).join('\n').replace(/\s*$/, '');
  const after = lines.slice(end).join('\n');
  return `${before}\n\n${block}${after ? `\n${after}` : ''}`;
}

module.exports = {
  SECTION,
  INFO,
  ALLOW_FILE,
  KINDS,
  STATUSES,
  UNITS,
  PARAM_TYPES,
  MAX_SHOWN_ROWS,
  MAX_PRINTED_ROWS,
  validate,
  parseRules,
  loadRules,
  paramValueProblem,
  placeholders,
  allowListFor,
  validateAllowList,
  readsOutside,
  scanParse,
  readsProblems,
  aggregateColumns,
  printableRows,
  figureOf,
  targetOf,
  judgeFigure,
  queryRuleChecks,
  queryRuleChecksFor,
  isSigned,
  countSigned,
  scaffold,
  insertBlock,
};
