'use strict';

// The slow-test gate (plan ci-split, Story CS.1). The long tests (the ci-fork
// fork copy and the template-update repos) run only through
// `npm run test:slow` (CI's "Slow tests" step and clean-bones), which sets
// APLABS_SLOW_TESTS=1. Anywhere else node:test reports them as skipped, never
// passed. Use it as `test(name, { skip: slowSkip() }, fn)`. A file that does is
// listed in SLOW_FILES (scripts/run-slow-tests.js); a guard test checks it.

const ENV = 'APLABS_SLOW_TESTS';
const REASON = "slow: runs in CI's 'Slow tests' step (npm run test:slow)";

// false (run) only when the variable is exactly "1"; otherwise the skip reason.
function slowSkip(env = process.env) {
  return env[ENV] === '1' ? false : REASON;
}

module.exports = { slowSkip, ENV, REASON };
