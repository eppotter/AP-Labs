'use strict';

// kit/runtime/archetypes/scoped-pull/params (Story 9.3): declarations are
// bounded and possible, or startup stops naming the module and the input; form
// text becomes typed values or plain problems. Declarations are fixtures here,
// never a client's manifest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkDeclarations, checkValues, displayValue } = require('../../kit/runtime/archetypes/scoped-pull/params');
const { loadModules } = require('../../kit/runtime/registry');

const ZONE = { name: 'zone', label: 'Zone', type: 'string', enum: ['north', 'south'], required: true };
const DAYS = { name: 'days', label: 'Days', type: 'integer', min: 1, max: 365, default: 90, required: true };
const LIMIT = { name: 'limit', type: 'integer', min: 1, max: 500, default: 25 };
const CODE = { name: 'code', label: 'Code', type: 'string', pattern: '[A-Z]{2}-\\d{3}', max_length: 6 };
const PARAMS = [ZONE, DAYS, LIMIT, CODE];

test('a bounded set of declarations has no problems', () => {
  assert.deepEqual(checkDeclarations(PARAMS), []);
  assert.deepEqual(checkDeclarations([
    { name: 'on', type: 'boolean', default: false },
    { name: 'from', type: 'date', default: '2026-09-30' },
    { name: 'ratio', type: 'number', min: 0, max: 1.5 },
    { name: 'size', type: 'integer', enum: [10, 20] },
  ]), []);
  assert.deepEqual(checkDeclarations(undefined), []);
});

test('a string input with neither allowed values nor a pattern and max_length is refused', () => {
  assert.deepEqual(checkDeclarations([{ name: 'note', type: 'string' }]), [
    'input "note" is a string with neither allowed values nor a pattern and max_length; declare one or the other',
  ]);
  assert.match(checkDeclarations([{ name: 'note', type: 'string', pattern: '.*' }])[0], /neither allowed values nor a pattern and max_length/);
  assert.match(checkDeclarations([{ name: 'note', type: 'string', max_length: 10 }])[0], /neither allowed values nor a pattern and max_length/);
});

test('every number input declares a max', () => {
  assert.deepEqual(checkDeclarations([{ name: 'n', type: 'integer', min: 1 }]), ['input "n" is an integer with no max; every number input declares one']);
  assert.match(checkDeclarations([{ name: 'x', type: 'number' }])[0], /no max/);
});

test('an impossible range, a bad default, a bad pattern and a duplicate are each refused, naming the input', () => {
  assert.deepEqual(checkDeclarations([{ name: 'n', type: 'integer', min: 10, max: 5 }]), ['input "n" has an impossible range (min 10 is above max 5)']);
  assert.deepEqual(checkDeclarations([{ ...DAYS, default: 400 }]), ['input "days" has a default that breaks its own declaration']);
  assert.deepEqual(checkDeclarations([{ ...ZONE, default: 'east' }]), ['input "zone" has a default that breaks its own declaration']);
  assert.deepEqual(checkDeclarations([{ ...CODE, pattern: '([' }]), ['input "code" has a pattern that is not a valid regular expression']);
  assert.deepEqual(checkDeclarations([ZONE, ZONE]), ['input "zone" is declared twice']);
});

test('bounds that do not fit the type are refused', () => {
  const p = (extra) => checkDeclarations([{ name: 'v', ...extra }]);
  assert.match(p({ type: 'boolean', min: 0 })[0], /min or max, which only an integer or number input can/);
  assert.match(p({ type: 'integer', max: 5, pattern: 'x' })[0], /pattern or max_length, which only a string input can/);
  assert.match(p({ type: 'date', enum: ['2026-01-01'] })[0], /boolean or date input cannot/);
  assert.match(p({ type: 'string', enum: ['a', 2] })[0], /allowed value that is not a string/);
  assert.match(p({ type: 'integer', enum: [1, 2], max: 3 })[0], /both allowed values and min or max/);
  assert.match(p({ type: 'string', enum: ['a'], pattern: 'a', max_length: 1 })[0], /both allowed values and a pattern/);
  assert.match(p({ type: 'integer', min: 0.5, max: 3 })[0], /not a whole number/);
  assert.match(p({ type: 'string', pattern: 'a', max_length: 0 })[0], /max_length that is not a whole number from 1 to 500/);
  assert.match(p({ type: 'string', enum: Array.from({ length: 101 }, (_, i) => `v${i}`) })[0], /101 allowed values \(at most 100\)/);
});

test('startup refuses a module with a bad declaration, naming the module file and the input', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-params-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (manifest) => {
    fs.mkdirSync(path.join(dir, 'modules/pull'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'modules/pull/manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'modules/pull/pull.sql'), 'SELECT 1 AS one\n');
  };
  const base = {
    id: 'pull', hub: 'h', label: 'Pull', description: 'd', resource: 'R', archetype: 'scoped-pull', environments: ['dev'], query: 'pull.sql',
  };
  const load = () => loadModules(dir, { hubs: [{ id: 'h' }], profile: { resources: [{ key: 'R' }] } });

  write({ ...base, parameters: [ZONE] });
  const ok = load();
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.modules[0].sql, 'SELECT 1 AS one\n');
  assert.equal(ok.modules[0].run, undefined);

  write({ ...base, parameters: [{ name: 'zone', type: 'text' }] });
  assert.deepEqual(load().problems, ['modules/pull/manifest.json: field "parameters[0].type" (input "zone") must be equal to one of the allowed values']);

  write({ ...base, parameters: [{ name: 'days', type: 'integer', min: 9, max: 1 }] });
  assert.deepEqual(load().problems, ['modules/pull/manifest.json: input "days" has an impossible range (min 9 is above max 1)']);

  write({ ...base, parameters: [{ name: 'note', type: 'string' }] });
  assert.match(load().problems[0], /^modules\/pull\/manifest\.json: input "note" is a string with neither/);

  write({ ...base, parameters: [ZONE], query: 'missing.sql' });
  assert.deepEqual(load().problems, ['modules/pull/manifest.json: field "query" names a file that does not exist']);

  write({ ...base, parameters: [ZONE], handler: 'h.js' });
  assert.deepEqual(load().problems, ['modules/pull/manifest.json: field "handler" is not used by a scoped-pull module (the engine runs its form)']);
});

test('checkValues: a full form becomes typed values', () => {
  const r = checkValues(PARAMS, { zone: 'north', days: '30', limit: '10', code: 'AB-123' });
  assert.deepEqual(r, { values: { zone: 'north', days: 30, limit: 10, code: 'AB-123' }, problems: [] });
});

test('checkValues: an empty input takes its default; an empty optional one is left out; a missing required one is a problem', () => {
  const r = checkValues(PARAMS, { zone: 'south', days: '', limit: '  ' });
  assert.deepEqual(r.values, { zone: 'south', days: 90, limit: 25 });
  assert.deepEqual(r.problems, []);
  const missing = checkValues(PARAMS, {});
  assert.deepEqual(missing.problems, [{ name: 'zone', label: 'Zone', message: 'Zone is needed.' }]);
});

test('checkValues: bad values are problems worded from the label, never from what was typed', () => {
  const r = checkValues(PARAMS, { zone: '<!channel>', days: '0', limit: '2.5', code: 'AB-1234' });
  assert.deepEqual(r.problems.map((p) => p.message), [
    'Zone is not one of the allowed values.',
    'Days is below 1.',
    'limit must be a whole number.',
    'Code is longer than 6 characters.',
  ]);
  assert.deepEqual(r.values, {});
  assert.ok(!JSON.stringify(r.problems).includes('channel'));
  assert.deepEqual(checkValues([CODE], { code: 'ab-123' }).problems.map((p) => p.message), ['Code is not in the expected format.']);
  // The pattern matches the whole value, never a part of it.
  assert.equal(checkValues([CODE], { code: 'AB-12' }).problems.length, 1);
  assert.equal(checkValues([{ ...CODE, max_length: 20 }], { code: 'xxAB-123xx' }).problems.length, 1);
  assert.deepEqual(checkValues([DAYS], { days: '366' }).problems.map((p) => p.message), ['Days is above 365.']);
  assert.deepEqual(checkValues([DAYS], { days: '1e3' }).problems.map((p) => p.message), ['Days must be a whole number.']);
});

test('checkValues: booleans, dates and numbers parse strictly', () => {
  const params = [
    { name: 'on', label: 'On', type: 'boolean', required: true },
    { name: 'from', label: 'From', type: 'date', required: true },
    { name: 'ratio', label: 'Ratio', type: 'number', min: 0, max: 2, required: true },
  ];
  assert.deepEqual(checkValues(params, { on: 'false', from: '2026-02-28', ratio: '1.25' }).values, { on: false, from: '2026-02-28', ratio: 1.25 });
  assert.deepEqual(checkValues(params, { on: 'yes', from: '2026-02-30', ratio: 'NaN' }).problems.map((p) => p.message), [
    'On must be Yes or No.', 'From must be a date.', 'Ratio must be a number.',
  ]);
  assert.equal(displayValue(params[0], true), 'Yes');
  assert.equal(displayValue(DAYS, 90), '90');
});
