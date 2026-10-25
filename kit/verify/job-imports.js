'use strict';

// The job-imports check (Story 11.1, N2, Q3): a scheduled job gets only its
// ctx (log, data, now, name). `npm run check` runs it through
// scripts/check-job-imports.js and fails any JS file under <app dir>/jobs/
// that imports:
//   - @slack/... (a job never posts to Slack);
//   - #sdk (the module SDK; a job needs nothing beyond ctx);
//   - a connectors path (`connectors/...` or `connectors` itself): a job never
//     reaches a connector. The write-path check (kit/verify/write-path.js)
//     separately fails a job that reaches a connector's write.
//
// App dirs are the write-path check's: <repo>/app, APLABS_APP_DIR when set
// (it must exist), and package.json "aplabs": { "appDirs": [...] }. Imports are
// read from each line's code with leading comments stripped (codeLines), so a
// comment that mentions an import is not a finding. A tripwire for honest
// mistakes, not a sandbox: job code is trusted, reviewed app code (AD-1).

const fs = require('node:fs');
const path = require('node:path');
const { configuredAppDirs, codeLines } = require('./write-path');

const JOBS_DIR = 'jobs';
const JS = /\.(c|m)?js$/;
const IMPORT = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)|\bimport\s*\(\s*(['"`])([^'"`]+)\3\s*\)|\bfrom\s*(['"])([^'"]+)\5|^\s*import\s+(['"])([^'"]+)\7/gm;
const FORBIDDEN = Object.freeze([
  { test: /^@slack\//, what: 'Slack' },
  { test: /^#sdk(\/|$)/, what: 'the module SDK (#sdk)' },
  { test: /(^|\/)connectors(\/|$)/, what: 'a connector' },
]);
const WHY = 'a job gets only ctx: log, data, now and name (Story 11.1); no Slack, SDK or connector imports';

const slash = (p) => p.split(path.sep).join('/');
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

function jsFiles(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'node_modules') continue;
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...jsFiles(abs));
    else if (d.isFile() && JS.test(d.name)) out.push(abs);
  }
  return out;
}

// { dirs, problems }: every app dir that exists.
function appDirs(root, env) {
  const configured = configuredAppDirs(root);
  const problems = [...configured.problems];
  const dirs = [path.join(root, 'app')];
  if (env.APLABS_APP_DIR) {
    const dir = path.resolve(root, env.APLABS_APP_DIR);
    if (isDir(dir)) dirs.push(dir);
    else problems.push(`APLABS_APP_DIR ${env.APLABS_APP_DIR} is not a directory: its jobs can't be checked`);
  }
  dirs.push(...configured.dirs.map((d) => path.resolve(root, d)));
  return { dirs: [...new Set(dirs)].filter(isDir), problems };
}

// Every problem as "<file>:<line>: imports <what> ("<spec>") (<why>)", file
// relative to root, after any setup problem.
function jobImportProblems(root, { env = process.env } = {}) {
  const { dirs, problems } = appDirs(root, env);
  const files = new Set();
  for (const dir of dirs) {
    const jobs = path.join(dir, JOBS_DIR);
    if (isDir(jobs)) for (const f of jsFiles(jobs)) files.add(f);
  }
  const rel = (f) => slash(path.relative(root, f));
  for (const file of [...files].sort((a, b) => rel(a).localeCompare(rel(b)))) {
    const lines = codeLines(fs.readFileSync(file, 'utf8'));
    lines.forEach((code, i) => {
      for (const m of code.matchAll(IMPORT)) {
        const spec = m[2] || m[4] || m[6] || m[8];
        const hit = FORBIDDEN.find((f) => f.test.test(spec));
        if (hit) problems.push(`${rel(file)}:${i + 1}: imports ${hit.what} ("${spec}") (${WHY})`);
      }
    });
  }
  return problems;
}

module.exports = { jobImportProblems, FORBIDDEN, JOBS_DIR };
