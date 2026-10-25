'use strict';

// The engine's built-in verify checks. `npm run verify` (kit/verify/run-all.js)
// and the end-of-turn hook (kit/lib/stop-verify) run them after the profile's
// checks and truths, whatever the profile says: a profile can neither drop nor
// replace them, and their ids (engine:<name>) can't clash with a profile's.
// Each runs in process and returns a verify result
// { id, seconds, outcome, reason?, stdout, stderr }; an error inside one is a
// fail, never a pass.
//
//   engine:write-path  kit/verify/write-path.js (DEP-012, AD-15): app code may
//                      not write live outside the approval-write archetype.
//   engine:job-imports kit/verify/job-imports.js (Story 11.1, N2): a scheduled
//                      job may not import Slack, #sdk or a connector.

const writePath = require('./write-path');
const jobImports = require('./job-imports');

const { writePathCheck } = writePath;
const { jobImportsCheck } = jobImports;
const BUILTINS = Object.freeze([writePathCheck, jobImportsCheck]);
// Each built-in's id, so a check that throws is still reported as
// engine:<name>, never under its function name (#100).
const IDS = new Map([[writePathCheck, writePath.CHECK_ID], [jobImportsCheck, jobImports.CHECK_ID]]);

// Every built-in's result for the repo at root. env supplies APLABS_APP_DIR.
function runBuiltins(root, env = process.env) {
  return BUILTINS.map((check) => {
    try {
      return check(root, env);
    } catch (err) {
      return { id: IDS.get(check), seconds: 0, outcome: 'fail', reason: `the check could not run (${err && err.message}): failing closed`, stdout: '', stderr: '' };
    }
  });
}

module.exports = { BUILTINS, runBuiltins };
