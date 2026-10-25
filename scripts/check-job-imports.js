#!/usr/bin/env node
'use strict';

// Runs the job-imports check (kit/verify/job-imports.js, Story 11.1) for
// `npm run check`:
//
//   node scripts/check-job-imports.js [--root <repo>]
//
// Fails any file under <app dir>/jobs/ that imports @slack/, #sdk or a
// connectors path, naming the file and line. Exit codes: 0 pass, 1 problems.

const path = require('node:path');
const { jobImportProblems } = require('../kit/verify/job-imports');

function main(argv, env = process.env) {
  const at = argv.indexOf('--root');
  const root = at >= 0 ? path.resolve(argv[at + 1]) : path.resolve(__dirname, '..');
  const problems = jobImportProblems(root, { env });
  if (problems.length) {
    process.stderr.write(`check-job-imports: ${problems.length} problem(s):\n`);
    for (const p of problems) process.stderr.write(`  ${p}\n`);
    return 1;
  }
  process.stdout.write('check-job-imports: ok\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
