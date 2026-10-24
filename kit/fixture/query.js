'use strict';

// One SQL file through the query runner, printing one number (Story 7.6, AD-18).
//
//   node kit/fixture/query.js [--profile <file>] <sql-file>
//
// The bridge a known truth's `run` uses (kit/lib/truths), so a truth's SQL
// goes through the same guardrail and locked, read-only DuckDB as the app
// (kit/runtime/data), never a separate connection. The profile is --profile
// (relative to cwd), else APLABS_PROFILE, else .aplabs/profile.yml above cwd;
// its forbidden columns apply in full. The data file is the runtime's
// (APLABS_DATA_PATH, else <var>/fixture/<client id>.duckdb).
//
// The query must return exactly one row with one non-null value, which is
// printed alone on stdout for the truth to judge.
// Exit codes: 0 printed, 1 the query failed or the fixture is not built,
// 2 usage or profile error.

const fs = require('node:fs');
const path = require('node:path');
const { findProfilePath, loadProfile, PROFILE_REL } = require('../lib/profile');
const { createData, dataPathFor } = require('../runtime/data');
const { notBuilt, shownPath } = require('./validate');

const USAGE = 'usage: node kit/fixture/query.js [--profile <file>] <sql-file>';

function parseArgs(argv) {
  const args = { profile: null, file: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--profile') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) return { error: '--profile needs a value' };
      args.profile = v;
      i += 1;
    } else if (a.startsWith('--')) {
      return { error: `unknown option ${a}` };
    } else if (args.file) {
      return { error: 'expected one <sql-file>' };
    } else {
      args.file = a;
    }
  }
  if (!args.file) return { error: 'missing <sql-file>' };
  return args;
}

// The single value of a one-row, one-column result, or { error }.
function singleValue(rows) {
  if (rows.length !== 1) return { error: `expected 1 row, got ${rows.length}` };
  const values = Object.values(rows[0]);
  if (values.length !== 1) return { error: `expected 1 column, got ${values.length}` };
  if (values[0] === null || values[0] === undefined) return { error: 'the value is NULL' };
  return { value: String(values[0]) };
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
  let profile;
  try {
    const profileFile = args.profile ? path.resolve(cwd, args.profile) : findProfilePath(cwd, env);
    if (!profileFile) {
      console.error(`query: no profile (pass --profile, set APLABS_PROFILE or add ${PROFILE_REL})`);
      return 2;
    }
    profile = loadProfile(profileFile);
  } catch (err) {
    if (err.code !== 'PROFILE_INVALID') throw err;
    console.error(`query: ${err.message}`);
    return 2;
  }
  const sqlFile = path.resolve(cwd, args.file);
  let sql;
  try {
    sql = fs.readFileSync(sqlFile, 'utf8');
  } catch (err) {
    console.error(`query: cannot read ${args.file}: ${err.code || err.message}`);
    return 1;
  }
  const where = dataPathFor(profile, env);
  if (where.problem) {
    console.error(`query: ${where.problem}`);
    return 2;
  }
  if (!fs.existsSync(where.path)) {
    console.error(`query: ${notBuilt(shownPath(cwd, where.path))}`);
    return 1;
  }
  const data = createData({ file: where.path, profile });
  try {
    const got = singleValue(await data.run(sql));
    if (got.error) {
      console.error(`query: ${args.file}: ${got.error}`);
      return 1;
    }
    console.log(got.value);
    return 0;
  } catch (err) {
    console.error(`query: ${args.file}: ${String(err.message).split('\n')[0]}`);
    return 1;
  } finally {
    data.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(err.stack || String(err));
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, singleValue, USAGE };
