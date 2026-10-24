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

const { writePathCheck } = require('./write-path');

const BUILTINS = Object.freeze([writePathCheck]);

// Every built-in's result for the repo at root. env supplies APLABS_APP_DIR.
function runBuiltins(root, env = process.env) {
  return BUILTINS.map((check) => {
    try {
      return check(root, env);
    } catch (err) {
      return { id: check.name, seconds: 0, outcome: 'fail', reason: `the check could not run (${err && err.message}): failing closed`, stdout: '', stderr: '' };
    }
  });
}

module.exports = { BUILTINS, runBuiltins };
