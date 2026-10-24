#!/usr/bin/env node
'use strict';

// Runs the write-path check (kit/verify/write-path.js, DEP-012, AD-15) for
// `npm run check`:
//
//   node scripts/check-write-path.js [--root <repo>]
//
// The engine also runs it in every `npm run verify` as the built-in check
// engine:write-path, so editing this shim or package.json's check line does
// not switch it off. The template repo's example app dirs come from
// package.json ("aplabs": { "appDirs": [...] }); a fork relies on <repo>/app
// or APLABS_APP_DIR. Exit codes: 0 pass, 1 problems found.

const path = require('node:path');
const engine = require('../kit/verify/write-path');

const { ALLOWED } = engine;
const writePathProblems = (root, env = process.env) => engine.writePathProblems(root, { env });
const scannedDirs = (root, env = process.env) => engine.scannedDirs(root, { env });

function main(argv) {
  const at = argv.indexOf('--root');
  const root = at >= 0 ? path.resolve(argv[at + 1]) : path.resolve(__dirname, '..');
  const problems = writePathProblems(root);
  if (problems.length) {
    process.stderr.write(`check-write-path: ${problems.length} problem(s); live writes are allowed only in ${ALLOWED.join(', ')}:\n`);
    for (const p of problems) process.stderr.write(`  ${p}\n`);
    return 1;
  }
  process.stdout.write(`check-write-path: ok (${scannedDirs(root).length} dirs scanned)\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { ALLOWED, writePathProblems, scannedDirs };
