'use strict';

// Query rules (plan brightside-v1, D11, Story 19.6): SQLsmith's signed canon.
//
//   npm run query-rules -- --status
//   npm run query-rules -- --queue
//   npm run query-rules -- --new QR-NNN --from <queue id>
//   npm run query-rules -- --done <queue id>
//   npm run query-rules -- --check QR-NNN [--rows]
//
// --status   every rule in data.md: kind, status, who signed it and when, and
//            its last check on this machine (kit/lib/verify/last).
// --queue    the questions Ask declined (kit/runtime/knowledge/ask-queue),
//            oldest first: id, date, hub, reason and the question. No figures:
//            the queue never holds one.
// --new      adds a draft rule to data.md's "## Query rules" section with the
//            queued question as its first pattern (status draft, signed_off
//            pending). SQLsmith fills it in on a branch; it fails its check
//            until then.
// --done     clears a queued question once its rule has merged.
// --check    the verify check `query-rule:<id>` (npm run verify and the Stop
//            hook spawn it): validates the rule, checks its reads against the
//            allow-list (the profile's ask.tables) and DuckDB's own parse of
//            its SQL, checks the SQL with Ask's own guard (kit/runtime/sql
//            checkSql with allowedTables, then checkParsed: Story 19.7, so a
//            signed rule is one Ask's connection runs), runs the SQL with
//            check.params through the query runner (kit/runtime/data, with the
//            profile's forbidden columns), and compares the figure with the
//            linked signed truth or the stated figure. --rows also prints the
//            result rows for the Verifier's PR evidence, aggregates only
//            (kit/lib/query-rules printableRows): a COUNT, SUM or AVG column
//            keeps its number; group keys, ids and text print as [hidden];
//            more than 10 rows print nothing. A PR never holds row-level
//            client data.
//
// The profile is the governing one (kit/lib/profile governingProfilePath:
// the one verify names, else APLABS_PROFILE, else .aplabs/profile.yml above
// cwd). The queue lives under the var dir (APLABS_VAR_DIR, else <repo>/var),
// so --queue, --new and --done run on the machine the bot runs on.
// Exit codes: 0 done (or the check passed), 1 the check failed or the
// command could not finish, 2 usage or profile error.

const fs = require('node:fs');
const path = require('node:path');
const { governingProfilePath, loadProfile, PROFILE_REL } = require('../lib/profile');
const { contextDirFor } = require('../lib/onboard');
const { loadTruths } = require('../lib/truths');
const { gitDirOf, readLastResult } = require('../lib/verify/last');
const rules = require('../lib/query-rules');
const { createData, dataPathFor } = require('../runtime/data');
const { COLUMNS_SQL, PARSE_SQL } = require('../runtime/data/ask');
const sqlGuard = require('../runtime/sql');
const { askForbiddenColumns, checkParsed } = require('../runtime/sql/ask');
const { createAskQueue } = require('../runtime/knowledge/ask-queue');
const { varDirFor } = require('../runtime/knowledge/store');

const USAGE = `usage: npm run query-rules -- --status | --queue | --new QR-NNN --from <queue id> | --done <queue id> | --check QR-NNN [--rows]`;
const RULE_ID = /^QR-\d{3}$/;
const QUEUE_ID = /^[0-9a-f]{16}$/;
const PROFILE_ERRORS = new Set(['PROFILE_INVALID', 'PROFILE_NOT_GOVERNING']);

// Every table's columns in the data, and DuckDB's own parse of a SQL text
// (it parses only: nothing runs): COLUMNS_SQL and PARSE_SQL, shared with
// Ask's connection (kit/runtime/data/ask).

// Ask's guard on a rule's SQL (Story 19.7): the tokenizer with Ask's
// forbidden columns and allowed tables, then DuckDB's parse. A list of
// problems, empty when both pass.
function askGuardProblems(sql, tree, allowed, dataColumns, profile) {
  const verdict = sqlGuard.checkSql(sql, {
    forbiddenColumns: askForbiddenColumns(allowed, dataColumns, sqlGuard.forbiddenColumnsOf(profile)),
    allowedTables: Object.keys(allowed),
    knownTables: [...dataColumns.keys()].filter((t) => /^[a-z_][a-z0-9_]*$/.test(t)),
  });
  if (!verdict.ok) return [`Ask's guard refuses the SQL (${verdict.rule}): ${verdict.detail}`];
  const parsed = checkParsed(tree, { allowedTables: allowed, dataColumns });
  return parsed.ok ? [] : [`Ask's guard refuses DuckDB's parse of the SQL (${parsed.rule}): ${parsed.detail}`];
}

function parseArgs(argv) {
  const args = { cmd: null, id: null, from: null, rows: false };
  const setCmd = (cmd) => {
    if (args.cmd) return `use one of --status, --queue, --new, --done, --check (got ${args.cmd} and ${cmd})`;
    args.cmd = cmd;
    return null;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) return null;
      i += 1;
      return v;
    };
    let err = null;
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--status' || a === '--queue') err = setCmd(a.slice(2));
    else if (a === '--new' || a === '--done' || a === '--check') {
      err = setCmd(a.slice(2));
      args.id = value();
      if (!args.id) return { error: `${a} needs a value` };
    } else if (a === '--from') {
      args.from = value();
      if (!args.from) return { error: '--from needs a queue id' };
    } else if (a === '--rows') args.rows = true;
    else return { error: `unknown argument "${a}"` };
    if (err) return { error: err };
  }
  if (!args.cmd) return { error: 'missing a command' };
  if ((args.cmd === 'new' || args.cmd === 'check') && !RULE_ID.test(args.id)) return { error: `--${args.cmd} needs a rule id, QR-NNN` };
  if (args.cmd === 'done' && !QUEUE_ID.test(args.id)) return { error: '--done needs a queue id (16 hex characters)' };
  if (args.cmd === 'new' && !(args.from && QUEUE_ID.test(args.from))) return { error: '--new needs --from <queue id> (16 hex characters)' };
  if (args.cmd !== 'new' && args.from) return { error: '--from goes with --new only' };
  if (args.cmd !== 'check' && args.rows) return { error: '--rows goes with --check only' };
  return args;
}

// The governing profile: { profile, file } or { code, message }.
function profileOf(cwd, env) {
  try {
    const file = governingProfilePath(null, cwd, env);
    if (!file) return { code: 2, message: `no profile (set APLABS_PROFILE or add ${PROFILE_REL})` };
    return { profile: loadProfile(file), file };
  } catch (err) {
    if (!PROFILE_ERRORS.has(err.code)) throw err;
    return { code: 2, message: err.message };
  }
}

const quietLog = (err) => Object.freeze({
  info() {}, warn: (msg, f = {}) => err(`query-rules: ${msg}${f.id ? ` (${f.id})` : ''}`), error: (msg) => err(`query-rules: ${msg}`),
});

function queueFor(profile, env, err) {
  return createAskQueue({ clientId: profile.client.id, varDir: varDirFor(env), log: quietLog(err) });
}

// --check: { outcome: 'pass' | 'fail', lines }.
async function checkRule(id, { profile, file, env, rows: showRows }) {
  const fail = (reason) => ({ outcome: 'fail', lines: [`FAIL query-rule:${id}: ${reason}`] });
  const contextDir = contextDirFor(path.resolve(file));
  const entries = rules.loadRules(contextDir);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return fail('no such rule in data.md');
  if (entry.problems.length) return fail(entry.problems.join('; '));
  const { rule } = entry;
  if (rule.kind === 'traps') {
    return { outcome: 'pass', lines: [`PASS query-rule:${id}: traps entry with ${rule.traps.length} traps`] };
  }
  const target = rules.targetOf(rule, loadTruths(contextDir));
  if (target.error) return fail(target.error);
  const allow = rules.allowListFor(profile);
  if (!allow.tables) return fail(allow.problem);

  const where = dataPathFor(profile, env);
  if (where.problem) return fail(where.problem);
  if (!fs.existsSync(where.path)) {
    return fail('no built fixture. Run npm run fixture:build first.');
  }
  const data = createData({ file: where.path, profile });
  try {
    const dataColumns = new Map();
    for (const r of await data.run(COLUMNS_SQL)) {
      if (!dataColumns.has(r.table_name)) dataColumns.set(r.table_name, new Set());
      dataColumns.get(r.table_name).add(r.column_name);
    }
    const [{ parsed }] = await data.run(PARSE_SQL, { sql: rule.sql }, { declared: ['sql'] });
    let tree;
    try {
      tree = JSON.parse(parsed);
    } catch {
      return fail('DuckDB could not parse the SQL');
    }
    const problems = rules.readsProblems(rule, tree, allow.tables, dataColumns);
    if (!problems.length) problems.push(...askGuardProblems(rule.sql, tree, allow.tables, dataColumns, profile));
    if (problems.length) return fail(problems.join('; '));
    const result = await data.run(rule.sql, { ...rule.check.params }, { declared: Object.keys(rule.params) });
    const figure = rules.figureOf(rule, result);
    if (figure.error) return fail(figure.error);
    const verdict = rules.judgeFigure(figure.value, target);
    const lines = [`${verdict.outcome === 'pass' ? 'PASS' : 'FAIL'} query-rule:${id}: ${verdict.reason}`];
    if (showRows) {
      const printed = rules.printableRows(result, rules.aggregateColumns(tree));
      lines.push(...printed.lines);
      if (printed.note) lines.push(`(${printed.note})`);
    }
    return { outcome: verdict.outcome, lines };
  } catch (err) {
    return fail(`the query failed: ${String((err && err.message) || err).split('\n')[0]}`);
  } finally {
    data.close();
  }
}

function statusLines(entries, last) {
  if (!entries.length) return ['No query rules in data.md.'];
  const outcomes = new Map(((last && last.results) || []).map((r) => [r.id, r.outcome]));
  return entries.map((e) => {
    if (e.problems.length || !e.rule) return `${e.id}  needs fixing in data.md (line ${e.line}): ${e.problems.join('; ')}`;
    const r = e.rule;
    const signed = r.signedOff && r.signedOff !== 'pending' ? `signed ${r.signedOff} by ${r.signedOffBy}` : 'not signed';
    const lastCheck = outcomes.get(`query-rule:${e.id}`);
    const when = last && typeof last.at === 'string' ? ` (${last.at.slice(0, 10)})` : '';
    const checked = lastCheck ? `last check: ${lastCheck}${when}` : 'not checked on this machine';
    const what = r.kind === 'traps' ? `${r.traps.length} traps` : r.metric;
    return `${e.id}  ${r.kind}  ${r.status}  ${signed}  ${checked}${rules.isSigned(e, last) ? '  SIGNED' : ''}  ${what}`;
  });
}

const queueLine = (e) => `${e.id}  ${String(e.at || '').slice(0, 10)}  ${e.hub}  ${e.reason}  ${e.question}`;

async function main(argv, { env = process.env, cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.error) {
    err(`${args.error}\n${USAGE}`);
    return 2;
  }
  const got = profileOf(cwd, env);
  if (!got.profile) {
    err(`query-rules: ${got.message}`);
    return got.code;
  }
  const { profile, file } = got;
  const contextDir = contextDirFor(path.resolve(file));

  if (args.cmd === 'check') {
    const verdict = await checkRule(args.id, {
      profile, file, env, rows: args.rows,
    });
    verdict.lines.forEach((l) => out(l));
    return verdict.outcome === 'pass' ? 0 : 1;
  }
  if (args.cmd === 'status') {
    const last = readLastResult(gitDirOf(path.dirname(contextDir)));
    statusLines(rules.loadRules(contextDir), last).forEach((l) => out(l));
    return 0;
  }
  const queue = queueFor(profile, env, err);
  if (args.cmd === 'queue') {
    const entries = await queue.list();
    if (!entries.length) out('The review queue is empty.');
    entries.forEach((e) => out(queueLine(e)));
    return 0;
  }
  if (args.cmd === 'done') {
    const removed = await queue.remove(args.id);
    out(removed ? `Cleared ${args.id} from the review queue.` : `${args.id} is not in the review queue.`);
    return removed ? 0 : 1;
  }
  // --new
  const entry = await queue.get(args.from);
  if (!entry) {
    err(`query-rules: ${args.from} is not in the review queue`);
    return 1;
  }
  const dataMd = path.join(contextDir, 'data.md');
  let text;
  try {
    text = fs.readFileSync(dataMd, 'utf8');
  } catch (e) {
    err(`query-rules: cannot read data.md: ${e.code || e.message}`);
    return 1;
  }
  if (rules.parseRules(text).some((e) => e.id === args.id)) {
    err(`query-rules: ${args.id} is already in data.md; pick the next free id`);
    return 1;
  }
  fs.writeFileSync(dataMd, rules.insertBlock(text, rules.scaffold(args.id, entry.question)));
  out(`Added draft ${args.id} to ${path.relative(cwd, dataMd) || dataMd} from ${args.from}. SQLsmith fills in every TODO; the Verifier runs npm run verify; its owner signs it in the PR; then run --done ${args.from}.`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e.stack || String(e));
    process.exitCode = 1;
  });
}

module.exports = {
  main, parseArgs, checkRule, statusLines, USAGE, COLUMNS_SQL, PARSE_SQL,
};
