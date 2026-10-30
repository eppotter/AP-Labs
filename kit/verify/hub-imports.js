'use strict';

// The hub-imports check (plan brightside-v0, D1, Story 16.1, review A8), run
// by `npm run check` through scripts/check-hub-imports.js. A module gets the
// runner and the AI service only through its hub's view
// (kit/runtime/slack/hub-view). This check fails a JS file in a module's
// folder that would go around the view, per value of its hub's sees:
//   - no "data": an import of kit/runtime/data (a relative path resolving
//     into it, or a path naming it);
//   - no "context": an import of kit/runtime/llm or kit/runtime/knowledge, or
//     a string naming the profile's context files: a .aplabs/context path, or
//     org.md, data.md, guardrails.md or connectors.md under a context/ folder
//     (a URL that merely has /context/ in it is not one);
//   - either missing: a require() or import() whose argument is not a
//     literal: its target can't be checked, so the check fails closed (as the
//     job-imports check).
// A module whose manifest or hub file can't be read, or whose hub has no
// valid sees, counts as on a hub that sees nothing (fail closed).
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
// Which sees value each engine folder needs.
const NEEDS = Object.freeze({ data: 'data', llm: 'context', knowledge: 'context' });
const STRING = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
// The profile's context files: anything under .aplabs/context, or one of the
// four onboarding files in a context/ folder. Not any /context/ in a URL.
const CONTEXT_PATH = /(^|[\\/])\.aplabs[\\/]+context([\\/]|$)|(^|[\\/])context[\\/]+(org|data|guardrails|connectors)\.md$/i;
const SLUG = /^[a-z][a-z0-9-]*$/;
const WHY = 'a module reaches data, the AI and context only through its hub\'s view, as its hub\'s sees allows (plan brightside-v0, D1)';

const slash = (p) => p.split(path.sep).join('/');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// The module's hub's sees; [] when the manifest, the hub file or its sees
// can't be read (fail closed).
function seesOf(appDir, folder) {
  const manifest = readJson(path.join(folder, 'manifest.json'));
  const hubId = manifest && manifest.hub;
  if (typeof hubId !== 'string' || !SLUG.test(hubId)) return [];
  const hub = readJson(path.join(appDir, 'hubs', `${hubId}.json`));
  return hub && Array.isArray(hub.sees) ? hub.sees : [];
}

// [file, sees] for every JS file in a module folder whose hub lacks data or context.
function filesToCheck(appDir) {
  const modules = path.join(appDir, 'modules');
  if (!isDir(modules)) return [];
  return fs.readdirSync(modules).sort()
    .map((name) => path.join(modules, name))
    .filter(isDir)
    .map((folder) => [folder, seesOf(appDir, folder)])
    .filter(([, sees]) => !sees.includes('data') || !sees.includes('context'))
    .flatMap(([folder, sees]) => jsFiles(folder).map((f) => [f, sees]));
}

// Every problem as "<file>:<line>: <what> (<why>)", file relative to root,
// after any setup problem.
function hubImportProblems(root, { env = process.env } = {}) {
  const { dirs, problems } = appDirs(root, env);
  const files = new Map(dirs.flatMap(filesToCheck));
  const rel = (f) => slash(path.relative(root, f));
  for (const file of [...files.keys()].sort((a, b) => rel(a).localeCompare(rel(b)))) {
    const sees = files.get(file);
    codeLines(fs.readFileSync(file, 'utf8')).forEach((code, i) => {
      const at = `${rel(file)}:${i + 1}`;
      for (const m of code.matchAll(IMPORT)) {
        const spec = m[2] || m[4] || m[6] || m[8];
        const hit = ENGINE.exec(spec.startsWith('.') ? rel(path.resolve(path.dirname(file), spec)) : spec);
        if (hit && !sees.includes(NEEDS[hit[2]])) problems.push(`${at}: imports ${spec} on a hub that does not see ${NEEDS[hit[2]]} (${WHY})`);
      }
      for (const m of code.matchAll(CALL)) {
        if (!LITERAL_ARG.test(code.slice(m.index + m[0].length))) problems.push(`${at}: a non-literal ${m[1]}, whose target can't be checked (${WHY})`);
      }
      if (sees.includes('context')) return;
      for (const m of code.matchAll(STRING)) {
        if (CONTEXT_PATH.test(m[2])) problems.push(`${at}: names a context path ("${m[2]}") on a hub that does not see context (${WHY})`);
      }
    });
  }
  return problems;
}

module.exports = { hubImportProblems, ENGINE, CONTEXT_PATH, NEEDS };
