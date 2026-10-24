#!/usr/bin/env node
'use strict';

// The ledger check (Story 5.1), run by CI on every pull request:
//
//   node scripts/ledger-check.js --base origin/main
//
// Run from the repo root. Passes when the PR (base...HEAD) touches
// docs/ledger.md or is docs-only, and the ledger file is well formed. A
// revert is not exempt here: verifying that a commit is an exact revert costs
// a diff per commit, so a revert PR adds a ledger row like any other.
// Exit codes: 0 pass, 1 fail, 2 usage or git error.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseNumstat, revertedCommit } = require('../kit/lib/review');
const { LEDGER_PATH, parseLedger, checkPr } = require('../kit/lib/ledger');

const USAGE = 'Usage: node scripts/ledger-check.js --base <ref>';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--base' && argv[i + 1] && !argv[i + 1].startsWith('-')) args.base = argv[++i];
    else return { error: `unknown or incomplete argument: ${argv[i]}` };
  }
  if (!args.help && !args.base) return { error: 'missing --base <ref>' };
  return args;
}

function main(argv, cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`ledger-check: ${args.error}\n${USAGE}`);
    return 2;
  }
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  let changes;
  let messages;
  try {
    changes = parseNumstat(git('diff', '--numstat', '-z', '--no-renames', '--no-textconv', `${args.base}...HEAD`));
    messages = git('log', '-z', '--format=%B', `${args.base}..HEAD`).split('\0');
  } catch (error) {
    console.error(`ledger-check: git failed for base ${args.base}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    return 2;
  }

  let failed = false;
  const result = checkPr({ changes });
  if (result.ok) {
    console.log(`ledger-check: ${result.message}`);
  } else {
    failed = true;
    console.error(`ledger-check: ${result.message}`);
    if (messages.some((m) => revertedCommit(m))) {
      console.error('ledger-check: reverts are not exempt in CI (they cannot be verified cheaply here); add a row for the revert.');
    }
  }

  const file = path.join(cwd, LEDGER_PATH);
  if (!fs.existsSync(file)) {
    console.error(`ledger-check: ${LEDGER_PATH} is missing.`);
    return 1;
  }
  const { errors } = parseLedger(fs.readFileSync(file, 'utf8'));
  for (const e of errors) console.error(`ledger-check: ${LEDGER_PATH} ${e}`);
  return failed || errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs };
