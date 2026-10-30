#!/usr/bin/env node
'use strict';

// Runs the hub-imports check (kit/verify/hub-imports.js, Story 16.1) for
// `npm run check`:
//
//   node scripts/check-hub-imports.js [--root <repo>]
//
// Fails any module file on a hub that does not see data that imports
// kit/runtime/data, kit/runtime/llm or kit/runtime/knowledge, or names a
// .aplabs or context/ path, naming the file and line. Exit codes: 0 pass,
// 1 problems.

const path = require('node:path');
const { hubImportProblems } = require('../kit/verify/hub-imports');

function main(argv, env = process.env) {
  const at = argv.indexOf('--root');
  const root = at >= 0 ? path.resolve(argv[at + 1]) : path.resolve(__dirname, '..');
  const problems = hubImportProblems(root, { env });
  if (problems.length) {
    process.stderr.write(`check-hub-imports: ${problems.length} problem(s):\n`);
    for (const p of problems) process.stderr.write(`  ${p}\n`);
    return 1;
  }
  process.stdout.write('check-hub-imports: ok\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
