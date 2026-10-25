'use strict';

// Story 10.1: deterministic scoring with a reason per row
// (kit/runtime/scoring). The formula is pinned (plan epic-10, decision 1):
// each input is clipped to [min, max] and scaled to 0-1, S is the sum of
// weight x scaled value, and score = round-half-up(100 x (S - neg) / (pos -
// neg)). Rows are ranked by score, ties by the row id. Values may be numbers,
// strict numeric strings (BIGINT, HUGEINT and DECIMAL come back as strings)
// or booleans (0/1); anything else, a null or a missing column stops the run
// naming the module and the input. The module is a fixture
// (test/fixtures/runtime/scored), never a client's manifest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const scoring = require('../../kit/runtime/scoring');
const { ScoringFault } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');

const FIX = path.join(__dirname, '../fixtures/runtime/scored');
const MOD = Object.freeze({ ...JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8')), sql: fs.readFileSync(path.join(FIX, 'ranked.sql'), 'utf8') });
const ROWS = JSON.parse(fs.readFileSync(path.join(FIX, 'rows.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const withInputs = (inputs, extra = {}) => ({ ...MOD, scoring: { ...MOD.scoring, inputs }, ...extra });

test('exact scores, reasons and order on the fixture rows; a tie is broken by the row id (numerically: 2 before 10)', () => {
  const ranked = scoring.scoreRows(ROWS, MOD);
  assert.deepEqual(ranked.map((r) => [r.row.person_id, r.score, r.reason]), [
    [1, 79, 'Months as a client: 24; Paid to date ($): 5,000'],
    [2, 64, 'Paid to date ($): 10,000; Months as a client: 12'],
    [10, 64, 'Paid to date ($): 10,000; Months as a client: 12'],
    [3, 29, 'Months as a client: 30'],
    [5, 0, scoring.NOTHING_STOOD_OUT],
  ]);
  // The rows are the query's own objects, unchanged.
  assert.equal(ranked[0].row, ROWS[0]);
  assert.deepEqual(ROWS, JSON.parse(fs.readFileSync(path.join(FIX, 'rows.json'), 'utf8')));
});

test('two identical runs give identical scores and order, whatever order the rows arrive in', () => {
  const first = scoring.scoreRows(clone(ROWS), MOD);
  const second = scoring.scoreRows(clone(ROWS), MOD);
  const reversed = scoring.scoreRows(clone(ROWS).reverse(), MOD);
  const shape = (rs) => rs.map((r) => [r.row.person_id, r.score, r.reason]);
  assert.deepEqual(shape(second), shape(first));
  assert.deepEqual(shape(reversed), shape(first));
});

test('the formula: clip, scale, weight, then round half up; a negative weight means lower is better', () => {
  const one = (input, value) => scoring.scoreRows([{ person_id: 1, v: value }], withInputs([{ name: 'v', label: 'V', ...input }]))[0].score;
  // 100 x 0.005 = 0.5 rounds up to 1; 0.004 rounds down.
  assert.equal(one({ weight: 1, min: 0, max: 200 }, 1), 1);
  assert.equal(one({ weight: 1, min: 0, max: 250 }, 1), 0);
  // 2.5 rounds up to 3 (never to the even 2).
  assert.equal(one({ weight: 1, min: 0, max: 1000 }, 25), 3);
  // Clipped to the range.
  assert.equal(one({ weight: 1, min: 10, max: 20 }, 5), 0);
  assert.equal(one({ weight: 1, min: 10, max: 20 }, 25), 100);
  // Lower is better.
  assert.equal(one({ weight: -4, min: 0, max: 10 }, 0), 100);
  assert.equal(one({ weight: -4, min: 0, max: 10 }, 10), 0);
  assert.equal(one({ weight: -4, min: 0, max: 10 }, 7), 30);
  // A zero weight never counts and never appears in a reason.
  const mixed = withInputs([
    { name: 'a', label: 'A', weight: 1, min: 0, max: 10 },
    { name: 'b', label: 'B', weight: 0, min: 0, max: 10 },
  ]);
  assert.deepEqual(scoring.scoreRows([{ person_id: 1, a: 5, b: 10 }], mixed).map((r) => [r.score, r.reason]), [[50, 'A: 5']]);
});

test('numbers: JavaScript numbers, strict numeric strings and booleans as 0/1', () => {
  assert.equal(scoring.toNumber(42), 42);
  assert.equal(scoring.toNumber('170141183460469231731687303715884105727'), 170141183460469231731687303715884105727);
  assert.equal(scoring.toNumber('-12.50'), -12.5);
  assert.equal(scoring.toNumber(true), 1);
  assert.equal(scoring.toNumber(false), 0);
  for (const bad of ['', ' 1', '1e3', '0x10', '1,000', '12abc', 'NaN', 'Infinity', NaN, Infinity, null, undefined, {}, [], '.5', '5.']) {
    assert.equal(scoring.toNumber(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
  const ranked = scoring.scoreRows([{ person_id: '7', tenure: '24', spend: '10000', idle: '0', rise: true }], MOD);
  assert.equal(ranked[0].score, 100);
  assert.equal(ranked[0].reason, 'Paid to date ($): 10,000; Months as a client: 24');
  // A boolean that counts reads as its label.
  const flag = withInputs([{ name: 'rise', label: 'Price rise before lapse', weight: 5, min: 0, max: 1 }, { name: 'tenure', label: 'Months', weight: 1, min: 0, max: 10 }]);
  assert.equal(scoring.scoreRows([{ person_id: 1, rise: true, tenure: 1 }], flag)[0].reason, 'Price rise before lapse; Months: 1');
});

test('a null value, a non-numeric value and a missing input column each stop the run, naming the module and the input; never scored as 0', () => {
  const fault = (rows, mod = MOD) => {
    try {
      scoring.scoreRows(rows, mod);
    } catch (err) {
      assert.ok(err instanceof ScoringFault);
      return err.details;
    }
    return assert.fail('expected a ScoringFault');
  };
  const base = { person_id: 1, tenure: 1, spend: 1, idle: 1, rise: false };
  assert.deepEqual(fault([base, { ...base, person_id: 2, spend: null }]), { module: 'ranked', input: 'spend', label: 'Paid to date ($)', problem: 'null' });
  assert.deepEqual(fault([{ ...base, idle: 'lots' }]), { module: 'ranked', input: 'idle', label: 'Days since last visit', problem: 'not_number' });
  const { tenure, ...noTenure } = base;
  assert.equal(tenure, 1);
  assert.deepEqual(fault([noTenure]), { module: 'ranked', input: 'tenure', label: 'Months as a client', problem: 'missing' });
  const { person_id: id, ...noId } = base;
  assert.equal(id, 1);
  assert.deepEqual(fault([noId]), { module: 'ranked', input: 'person_id', label: 'person_id', problem: 'no_row_id' });
  assert.deepEqual(fault([{ ...base, score: 3 }]), { module: 'ranked', input: 'score', label: 'score', problem: 'column_taken' });
  // The words: plain, the input's label, the COALESCE fix; never the value.
  const words = messageFor(new ScoringFault({ module: 'ranked', input: 'spend', label: 'Paid to date ($)', problem: 'null' }), { admin: 'Sam' });
  assert.match(words, /Paid to date \(\$\)/);
  assert.match(words, /COALESCE/);
  assert.match(words, /please tell Sam/);
});

test('startup checks: min >= max, all-zero weights, duplicate or reserved input names, a handler with scoring, and the limit parameter', () => {
  assert.deepEqual(scoring.checkScoring(MOD), []);
  assert.deepEqual(scoring.checkScoring({ ...MOD, scoring: undefined }), []);
  const inputs = MOD.scoring.inputs;
  assert.deepEqual(scoring.checkScoring(withInputs([{ ...inputs[0], min: 24, max: 24 }, inputs[1]])), [
    'field "scoring.inputs[0]" (input "tenure") has min 24 at or above max 24; the range must be min < max',
  ]);
  assert.deepEqual(scoring.checkScoring(withInputs([{ ...inputs[0], min: 30 }, inputs[1]])), [
    'field "scoring.inputs[0]" (input "tenure") has min 30 at or above max 24; the range must be min < max',
  ]);
  assert.deepEqual(scoring.checkScoring(withInputs(inputs.map((i) => ({ ...i, weight: 0 })))), [
    'field "scoring.inputs" has every weight 0; at least one input must count',
  ]);
  assert.deepEqual(scoring.checkScoring(withInputs([inputs[0], { ...inputs[1], name: 'tenure' }])), [
    'field "scoring.inputs[1]" (input "tenure") repeats an input name',
  ]);
  assert.deepEqual(scoring.checkScoring(withInputs([{ ...inputs[0], name: 'score' }, { ...inputs[1], name: 'reason' }])), [
    'field "scoring.inputs[0]" (input "score") uses a name the engine adds to every scored row (score, reason)',
    'field "scoring.inputs[1]" (input "reason") uses a name the engine adds to every scored row (score, reason)',
  ]);
  assert.deepEqual(scoring.checkScoring({ ...MOD, archetype: 'handler' }), [
    'field "scoring" is used only by a module with a query (scoped-pull or approval-write)',
  ]);
  assert.deepEqual(scoring.checkScoring({ ...MOD, scoring: { ...MOD.scoring, limit_parameter: 'count' } }), [
    'field "scoring.limit_parameter" names "count", which is not a declared input',
  ]);
  assert.deepEqual(scoring.checkScoring({ ...MOD, scoring: { ...MOD.scoring, limit_parameter: 'zone' } }), [
    'field "scoring.limit_parameter" names "zone", which must be an integer input',
  ]);
});

test('rank() scores then keeps the top limit; without a limit it keeps every row; the limit is never more than the rows', () => {
  const top3 = scoring.rank(ROWS, MOD, { limit: 3 });
  assert.deepEqual(top3.map((r) => [r.row.person_id, r.score]), [[1, 79], [2, 64], [10, 64]]);
  assert.equal(scoring.rank(ROWS, MOD, { limit: null }).length, 5);
  assert.equal(scoring.rank(ROWS, MOD, { limit: 50 }).length, 5);
});

test('scoringBlocks describes the scoring for "How was this made?": inputs, weights, ranges, the tie rule and the limit', () => {
  const [block] = scoring.scoringBlocks(MOD, { parameters: { zone: 'north', limit: 3 } });
  assert.equal(block.type, 'section');
  assert.equal(block.text.text, [
    '*Scoring:* each row got a score from 0 to 100, worked out by the app from the returned rows with fixed weights (no AI). '
      + 'Months as a client (weight 2, 0 to 24); Paid to date ($) (weight 3, 0 to 10,000); Days since last visit (weight -1, 0 to 100: lower is better); Price rise before lapse (weight 1, 0 to 1).',
    'Rows are ranked by score, ties by person_id. The app kept the top 3 (How many); the SQL never uses that value.',
  ].join('\n'));
  assert.deepEqual(scoring.scoringBlocks({ ...MOD, scoring: undefined }, {}), []);
  // Labels are escaped.
  const sneaky = withInputs([{ name: 'v', label: '<!here> & co', weight: 1, min: 0, max: 1 }]);
  assert.match(scoring.scoringBlocks(sneaky, { parameters: {} })[0].text.text, /&lt;!here&gt; &amp; co/);
});
