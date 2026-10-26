#!/usr/bin/env node
'use strict';

// The ledger check (Story 5.1; plan ledger-rows), run by CI on every pull
// request:
//
//   node scripts/ledger-check.js --base origin/main [--head <branch>]
//
// Run from the repo root. The PR's branch names its own build file,
// docs/ledger/builds/<slug>.md (kit/lib/ledger buildFileName): --head, else
// GITHUB_HEAD_REF (set by CI on a pull request), else the checked-out branch.
//
// Passes when the PR (base...HEAD) adds its own build file, touches
// docs/ledger.md or is docs-only, and the whole ledger (docs/ledger.md and
// every build file, kit/lib/ledger parseLedgerSet) is well formed. Fails when
// the PR deletes a build file, adds or edits another branch's, adds its own
// when that name is already on the base (a reused branch name), adds a row in
// both places, or adds two pending rows. A fork with no docs/ledger/ passes
// with its rows in docs/ledger.md. A revert is not exempt here: verifying
// that a commit is an exact revert costs a diff per commit, so a revert PR
// adds a ledger row like any other.
// Exit codes: 0 pass, 1 fail, 2 usage or git error.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseNumstat, revertedCommit } = require('../kit/lib/review');
const { LEDGER_PATH, BUILDS_DIR, parseLedger, parseLedgerSet, checkPr } = require('../kit/lib/ledger');

const USAGE = 'Usage: node scripts/ledger-check.js --base <ref> [--head <branch>]';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--base' && argv[i + 1] && !argv[i + 1].startsWith('-')) args.base = argv[++i];
    else if (argv[i] === '--head' && argv[i + 1] && !argv[i + 1].startsWith('-')) args.head = argv[++i];
    else return { error: `unknown or incomplete argument: ${argv[i]}` };
  }
  if (!args.help && !args.base) return { error: 'missing --base <ref>' };
  return args;
}

// `git diff --name-status -z` -> [{ status, file }] (no renames: --no-renames).
function parseNameStatus(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i]) break;
    files.push({ status: parts[i][0], file: parts[i + 1] });
  }
  return files;
}

// docs/ledger.md and every entry in docs/ledger/builds/ under root, for
// parseLedgerSet. A missing builds/ folder counts as empty; an entry that is
// not a file (a folder) is listed with a trailing / so its name fails.
function readLedgerSet(root) {
  const ledgerFile = path.join(root, LEDGER_PATH);
  const ledger = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : null;
  const dir = path.join(root, BUILDS_DIR);
  const builds = [];
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) builds.push({ name: entry.name, text: fs.readFileSync(path.join(dir, entry.name), 'utf8') });
      else builds.push({ name: `${entry.name}/`, text: '' });
    }
  }
  return { ledger, builds };
}

function main(argv, cwd = process.cwd(), env = process.env) {
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
  let files;
  let messages;
  let before = '';
  try {
    changes = parseNumstat(git('diff', '--numstat', '-z', '--no-renames', '--no-textconv', `${args.base}...HEAD`));
    files = parseNameStatus(git('diff', '--name-status', '-z', '--no-renames', `${args.base}...HEAD`));
    messages = git('log', '-z', '--format=%B', `${args.base}..HEAD`).split('\0');
    const mergeBase = git('merge-base', args.base, 'HEAD').trim();
    try {
      before = git('show', `${mergeBase}:${LEDGER_PATH}`);
    } catch {
      before = ''; // no ledger at the base
    }
  } catch (error) {
    console.error(`ledger-check: git failed for base ${args.base}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    return 2;
  }
  let branch = args.head || env.GITHUB_HEAD_REF || null;
  if (!branch) {
    try {
      branch = git('symbolic-ref', '--short', '-q', 'HEAD').trim() || null;
    } catch {
      branch = null; // a detached HEAD
    }
  }

  const set = readLedgerSet(cwd);
  let failed = false;
  const result = checkPr({
    changes,
    files,
    branch,
    ledgerRows: { before: parseLedger(before).builds, after: set.ledger === null ? [] : parseLedger(set.ledger).builds },
  });
  if (result.ok) {
    console.log(`ledger-check: ${result.message}`);
  } else {
    failed = true;
    console.error(`ledger-check: ${result.message}`);
    if (result.reason === 'no ledger row' && messages.some((m) => revertedCommit(m))) {
      console.error('ledger-check: reverts are not exempt in CI (they cannot be verified cheaply here); add a row for the revert.');
    }
  }

  const { errors } = parseLedgerSet(set);
  for (const e of errors) console.error(`ledger-check: ${e}`);
  return failed || errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs, parseNameStatus, readLedgerSet };
