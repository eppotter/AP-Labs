'use strict';

// The routing engine (Epic 12): a pure function library. Input contract in,
// plain object out; no I/O, clock, randomness or async. It may require only
// kit/runtime/scoring, kit/runtime/errors and its own files (the dependency
// rule, enforced by test/unit/engine-boundary.test.js). App code reaches it
// through kit/runtime/sdk. Entry points land with their stories (12.3 to 12.5):
// optimizeDay (12.3). The rule registry (12.2) is rules.

const { validateInput } = require('./contract');
const travel = require('./travel');
const rules = require('./rules');
const { optimizeDay } = require('./optimize');

module.exports = { validateInput, optimizeDay, travel: Object.freeze({ ...travel }), rules: Object.freeze({ ...rules }) };
