'use strict';

// Fixture validation (Story 7.6, AD-18).
//
//   npm run fixture:validate
//   node kit/fixture/validate.js <fixture-dir> [--db <file>] [--name <client>] [--profile <file>]
//
// Runs every <fixture-dir>/checks/*.sql, in name order, against a built
// fixture through the query runner (kit/runtime/data): the SQL guardrail plus
// the read-only, locked DuckDB. A check is a query for violations, so it
// passes when it returns zero rows. The default file is the one
// `npm run fixture:build` writes (kit/fixture/build defaultOut).
//
// Forbidden columns come from the profile (--profile, relative to cwd, else
// APLABS_PROFILE, else .aplabs/profile.yml above cwd). No profile is a profile
// error: the validator never runs with no forbidden columns known (issue #77).
// A check that must read one (a synthetic-only check on phones, say) names it
// in its leading comment:
//
//   -- protected-columns: clients.phone
//
// and only that check runs without it. Output never shows a row's values, only
// how many rows a check returned, so a protected value is never printed.
//
// A check that cannot run (refused, or a DuckDB error) fails. No checks, or no
// built fixture, fails too: an empty run is never a pass.
// Exit codes: 0 every check passed, 1 a check failed or nothing could run,
// 2 usage or profile error.

const fs = require('node:fs');
const path = require('node:path');
const { defaultOut } = require('./build');
const { findProfilePath, loadProfile, PROFILE_REL } = require('../lib/profile');
const { createData } = require('../runtime/data');
const { forbiddenColumnsOf } = require('../runtime/sql');

const USAGE = 'usage: node kit/fixture/validate.js <fixture-dir> [--db <file>] [--name <client>] [--profile <file>]';
const PROTECTED = /^--\s*protected-columns:\s*(.*)$/i;

// A path relative to cwd when it is inside it, else absolute.
function shownPath(cwd, file) {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

const notBuilt = (shown) => `no built fixture at ${shown}. Run npm run fixture:build first.`;

function parseArgs(argv) {
  const args = { fixtureDir: null, db: null, name: null, profile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--db' || a === '--name' || a === '--profile') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) return { error: `${a} needs a value` };
      args[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) {
      return { error: `unknown option ${a}` };
    } else if (args.fixtureDir) {
      return { error: `unexpected argument ${a}` };
    } else {
      args.fixtureDir = a;
    }
  }
  if (!args.fixtureDir) return { error: 'missing <fixture-dir>' };
  return args;
}

// The leading `--` comment block of a check: its first line is the check's
// description, and a protected-columns line lists the columns it may name.
function readHeader(sql) {
  const comments = [];
  for (const line of sql.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('--')) break;
    comments.push(t);
  }
  const protectedColumns = [];
  for (const c of comments) {
    const m = PROTECTED.exec(c);
    if (m) protectedColumns.push(...m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  }
  const first = comments.find((c) => !PROTECTED.test(c));
  return { description: first ? first.replace(/^--\s*/, '') : '', protectedColumns };
}

// The checks in <fixtureDir>/checks: [{ id, file, sql, description, protectedColumns }].
function loadChecks(fixtureDir) {
  const dir = path.join(path.resolve(fixtureDir), 'checks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    return { id: f.slice(0, -4), file: path.join(dir, f), sql, ...readHeader(sql) };
  });
}

// Runs each check against `db`. forbiddenColumns: the profile's list.
// Returns [{ id, description, outcome: 'pass' | 'fail', rows?, error? }].
async function validate({ checks, db, forbiddenColumns = [] }) {
  const sources = new Map();
  const sourceFor = (lifted) => {
    const cols = forbiddenColumns.filter((c) => !lifted.includes(String(c).toLowerCase()));
    const key = cols.join(',');
    if (!sources.has(key)) sources.set(key, createData({ file: db, profile: { sql: { forbidden_columns: cols } } }));
    return sources.get(key);
  };
  const results = [];
  try {
    for (const check of checks) {
      const base = { id: check.id, description: check.description };
      try {
        const rows = await sourceFor(check.protectedColumns).run(check.sql);
        results.push({ ...base, outcome: rows.length === 0 ? 'pass' : 'fail', rows: rows.length });
      } catch (err) {
        results.push({ ...base, outcome: 'fail', error: String(err.message).split('\n')[0] });
      }
    }
  } finally {
    for (const s of sources.values()) s.close();
  }
  return results;
}

function resultLine(r) {
  if (r.outcome === 'pass') return `PASS ${r.id}`;
  const why = r.error ? `could not run: ${r.error}` : `${r.rows} ${r.rows === 1 ? 'row' : 'rows'}`;
  return `FAIL ${r.id}: ${why}${r.description ? ` (${r.description})` : ''}`;
}

async function main(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    return 2;
  }
  let forbiddenColumns;
  try {
    const profileFile = args.profile ? path.resolve(cwd, args.profile) : findProfilePath(cwd, env);
    if (!profileFile) {
      console.error(`fixture:validate: no profile (pass --profile, set APLABS_PROFILE or add ${PROFILE_REL})`);
      return 2;
    }
    forbiddenColumns = forbiddenColumnsOf(loadProfile(profileFile));
  } catch (err) {
    if (err.code !== 'PROFILE_INVALID') throw err;
    console.error(`fixture:validate: ${err.message}`);
    return 2;
  }
  const fixtureDir = path.resolve(cwd, args.fixtureDir);
  const db = args.db ? path.resolve(cwd, args.db) : defaultOut(fixtureDir, args.name, env);
  const shown = shownPath(cwd, db);
  if (!fs.existsSync(db)) {
    console.error(`fixture:validate: ${notBuilt(shown)}`);
    return 1;
  }
  const checks = loadChecks(fixtureDir);
  if (!checks.length) {
    console.error(`fixture:validate: no checks/*.sql in ${shownPath(cwd, fixtureDir)}`);
    return 1;
  }
  const results = await validate({ checks, db, forbiddenColumns });
  for (const r of results) console.log(resultLine(r));
  const failed = results.filter((r) => r.outcome !== 'pass').length;
  console.log(`fixture:validate: ${shown}: ${results.length} checks, ${results.length - failed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(err.stack || String(err));
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, readHeader, loadChecks, validate, resultLine, notBuilt, shownPath, USAGE };
