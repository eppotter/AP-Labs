'use strict';

// #142: a scoped pull's values are worded by each input's declared type, in
// the view and in the CSV's DM message alike: a number 0 reads 0, and only a
// declared boolean reads Yes or No. The module here is an inline fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const { displayValue } = require('../../kit/runtime/archetypes/scoped-pull/params');
const { csvComment, resultMessage, failureMessage, runningMessage } = require('../../kit/runtime/archetypes/scoped-pull/results');
const { confirmMessage } = require('../../kit/runtime/archetypes/scoped-pull/form');

const MOD = Object.freeze({
  id: 'counts',
  hub: 'alpha',
  label: 'Counts',
  description: 'd',
  parameters: [
    { name: 'min_visits', label: 'Minimum visits', type: 'integer', min: 0, max: 10 },
    { name: 'ratio', label: 'Ratio', type: 'number', min: 0, max: 1 },
    { name: 'active', label: 'Active only', type: 'boolean' },
    { name: 'code', label: 'Code', type: 'string', max_length: 4 },
  ],
});
const VALUES = Object.freeze({
  min_visits: 0, ratio: 0, active: false, code: '0',
});
const fieldsOf = (blocks) => blocks.filter((b) => b.fields).map((b) => [b.fields[0].text, b.fields[1].text]);
const EXPECTED = [['*Minimum visits*', '0'], ['*Ratio*', '0'], ['*Active only*', 'No'], ['*Code*', '0']];

test('displayValue words a value by its declared type: 0 is 0, only a boolean input holding a boolean is Yes or No', () => {
  const [visits, ratio, active, code] = MOD.parameters;
  assert.equal(displayValue(visits, 0), '0');
  assert.equal(displayValue(ratio, 0), '0');
  assert.equal(displayValue(visits, 1), '1');
  assert.equal(displayValue(code, '0'), '0');
  assert.equal(displayValue(code, ''), '');
  assert.equal(displayValue(active, false), 'No');
  assert.equal(displayValue(active, true), 'Yes');
  // A boolean input never holds a number after checkValues; if it did, it
  // reads as the number, never as a guessed Yes or No.
  assert.equal(displayValue(active, 0), '0');
});

test('the CSV\'s DM message shows a numeric 0 as 0 and a declared boolean as Yes or No', () => {
  const outcome = { rows: [{ a: 1 }], total: 1, columns: ['a'] };
  assert.equal(csvComment(MOD, VALUES, outcome), 'Counts: 1 row, for Minimum visits: 0, Ratio: 0, Active only: No, Code: 0.');
  assert.equal(
    csvComment(MOD, { min_visits: 3, ratio: 0.5, active: true }, outcome),
    'Counts: 1 row, for Minimum visits: 3, Ratio: 0.5, Active only: Yes.',
  );
});

test('the Confirm screen, "Running…", the result and a failure all show a numeric 0 as 0', () => {
  const outcome = { rows: [{ a: 1 }], total: 1, columns: ['a'] };
  assert.deepEqual(fieldsOf(confirmMessage(MOD, { sessionId: 's', values: VALUES }).blocks), EXPECTED);
  assert.deepEqual(fieldsOf(runningMessage(MOD, VALUES).blocks), EXPECTED);
  assert.deepEqual(fieldsOf(resultMessage(MOD, VALUES, outcome, { permalink: null }).blocks), EXPECTED);
  assert.deepEqual(fieldsOf(failureMessage(MOD, VALUES, { kind: 'empty' }).blocks), EXPECTED);
});
