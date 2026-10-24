#!/usr/bin/env node
'use strict';

// Runs the write-path check (kit/verify/write-path.js, DEP-012, AD-15) for
// `npm run check`:
//
//   node scripts/check-write-path.js [--root <repo>]
//
// The engine check scans kit/runtime, kit/templates, <repo>/app and
// APLABS_APP_DIR; this shim adds the template repo's example clients'
// app dirs (examples/*/app), which the engine never names.
// Exit codes: 0 pass, 1 problems found.

const fs = require('node:fs');
const path = require('node:path');
const engine = require('../kit/verify/write-path');

const { ALLOWED } = engine;

function exampleAppDirs(root) {
  const examples = path.join(root, 'examples');
  if (!fs.existsSync(examples)) return [];
  return fs.readdirSync(examples).sort().map((d) => path.join(examples, d, 'app'));
}

const writePathProblems = (root, env = process.env) => engine.writePathProblems(root, { env, appDirs: exampleAppDirs(root) });
const scannedDirs = (root, env = process.env) => engine.scannedDirs(root, { env, appDirs: exampleAppDirs(root) });

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

module.exports = { ALLOWED, writePathProblems, scannedDirs, exampleAppDirs };
