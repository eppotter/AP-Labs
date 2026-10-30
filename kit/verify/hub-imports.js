'use strict';

// The hub-imports check (plan brightside-v0, D1, Story 16.1, review A8), run
// by `npm run check` through scripts/check-hub-imports.js. A module on a hub
// that does not see data gets the null runner and its hub's bound AI service
// through the hub's view (kit/runtime/slack/hub-view). This check fails any
// JS file in such a module's folder that would go around the view:
//   - an import of kit/runtime/data, kit/runtime/llm or kit/runtime/knowledge
//     (a relative path resolving into one, or a path naming one);
//   - a string naming a .aplabs path or a context/ folder (the profile's
//     context files);
//   - a require() or import() whose argument is not a literal: its target
//     can't be checked, so the check fails closed (as the job-imports check).
// A module whose manifest or hub file can't be read, or whose hub has no
// valid sees, counts as on a hub that does not see data (fail closed).
//
// App dirs, file walking and import parsing are the job-imports check's
// (./job-imports): <repo>/app, APLABS_APP_DIR and package.json appDirs. A
// tripwire for honest mistakes, not a sandbox: module code is reviewed.

const fs = require('node:fs');
const path = require('node:path');
const { codeLines } = require('./write-path');
const {
  appDirs, jsFiles, isDir, IMPORT, CALL, LITERAL_ARG,
} = require('./job-imports');

const ENGINE = /(^|\/)kit\/runtime\/(data|llm|knowledge)(\/|\.js$|$)/;
const STRING = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const CONTEXT_PATH = /(^|[\\/])\.aplabs([\\/]|$)|(^|[\\/])context[\\/]/;
const SLUG = /^[a-z][a-z0-9-]*$/;
const WHY = 'a module on a hub that does not see data reaches data, the AI and context only through its hub\'s view (plan brightside-v0, D1)';

const slash = (p) => p.split(path.sep).join('/');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// True only when the module's hub file lists "data" in a valid sees.
function onDataHub(appDir, folder) {
  const manifest = readJson(path.join(folder, 'manifest.json'));
  const hubId = manifest && manifest.hub;
  if (typeof hubId !== 'string' || !SLUG.test(hubId)) return false;
  const hub = readJson(path.join(appDir, 'hubs', `${hubId}.json`));
  return Boolean(hub && Array.isArray(hub.sees) && hub.sees.includes('data'));
}

// The JS files of every module folder on a hub that does not see data.
function filesToCheck(appDir) {
  const modules = path.join(appDir, 'modules');
  if (!isDir(modules)) return [];
  return fs.readdirSync(modules).sort()
    .map((name) => path.join(modules, name))
    .filter((folder) => isDir(folder) && !onDataHub(appDir, folder))
    .flatMap((folder) => jsFiles(folder));
}

// Every problem as "<file>:<line>: <what> (<why>)", file relative to root,
// after any setup problem.
function hubImportProblems(root, { env = process.env } = {}) {
  const { dirs, problems } = appDirs(root, env);
  const files = new Set(dirs.flatMap(filesToCheck));
  const rel = (f) => slash(path.relative(root, f));
  for (const file of [...files].sort((a, b) => rel(a).localeCompare(rel(b)))) {
    codeLines(fs.readFileSync(file, 'utf8')).forEach((code, i) => {
      const at = `${rel(file)}:${i + 1}`;
      for (const m of code.matchAll(IMPORT)) {
        const spec = m[2] || m[4] || m[6] || m[8];
        const target = spec.startsWith('.') ? rel(path.resolve(path.dirname(file), spec)) : spec;
        if (ENGINE.test(target)) problems.push(`${at}: imports ${spec} (${WHY})`);
      }
      for (const m of code.matchAll(CALL)) {
        if (!LITERAL_ARG.test(code.slice(m.index + m[0].length))) problems.push(`${at}: a non-literal ${m[1]}, whose target can't be checked (${WHY})`);
      }
      for (const m of code.matchAll(STRING)) {
        if (CONTEXT_PATH.test(m[2])) problems.push(`${at}: names a context path ("${m[2]}") (${WHY})`);
      }
    });
  }
  return problems;
}

module.exports = { hubImportProblems, ENGINE, CONTEXT_PATH };
