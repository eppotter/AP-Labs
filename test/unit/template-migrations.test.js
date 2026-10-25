'use strict';

// Story 11.6 (Q18): profile migrations. The template ships no steps while the
// schema is at version 1. The chain test fails as soon as the schema's
// schema_version is raised without its step, so a bump must ship its
// migration. The runner is tested with injected steps, on fixture text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { STEPS, schemaVersionOf, chainProblems, migrateProfile } = require('../../kit/lib/template/migrations');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '../../profiles/_schema/profile.schema.json'), 'utf8'));
const PROFILE = fs.readFileSync(path.join(__dirname, '../fixtures/fork/profile.yml'), 'utf8');

test('every schema_version the schema can require has a migration chain from 1', () => {
  const target = schemaVersionOf(SCHEMA);
  assert.ok(Number.isInteger(target) && target >= 1, 'the schema names its schema_version');
  assert.deepEqual(chainProblems(target, STEPS), [], 'a schema_version bump ships its migration step in kit/lib/template/migrations');
});

test('the template ships no steps while the schema is at version 1', () => {
  assert.ok(Object.isFrozen(STEPS));
  if (schemaVersionOf(SCHEMA) === 1) assert.deepEqual(Object.keys(STEPS), []);
});

test('chainProblems names each missing step', () => {
  assert.deepEqual(chainProblems(1, {}), []);
  assert.deepEqual(chainProblems(3, { 1: () => {} }), ['no migration step from schema_version 2 to 3']);
  assert.match(chainProblems(0, {})[0], /not a whole number/);
});

test('schemaVersionOf reads const, or the highest enum value', () => {
  assert.equal(schemaVersionOf({ properties: { schema_version: { const: 2 } } }), 2);
  assert.equal(schemaVersionOf({ properties: { schema_version: { enum: [1, 3, 2] } } }), 3);
  assert.equal(schemaVersionOf({ properties: {} }), null);
  assert.equal(schemaVersionOf(null), null);
});

test('migrateProfile runs every step in order and keeps the comments', () => {
  const order = [];
  const steps = {
    1: (doc) => {
      order.push(1);
      doc.set('note', 'from step 1');
    },
    2: (doc) => {
      order.push(2);
      doc.set('note', `${doc.get('note')}, then step 2`);
    },
  };
  const { text, applied } = migrateProfile(PROFILE, { from: 1, to: 3, steps });
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(applied, [1, 2]);
  const doc = YAML.parse(text);
  assert.equal(doc.schema_version, 3);
  assert.equal(doc.note, 'from step 1, then step 2');
  for (const line of PROFILE.split('\n').filter((l) => l.startsWith('#'))) assert.ok(text.includes(line), `kept: ${line}`);
  // Everything else is as it was.
  const before = YAML.parse(PROFILE);
  delete doc.note;
  doc.schema_version = before.schema_version;
  assert.deepEqual(doc, before);
});

test('migrateProfile starts at the fork\'s version, and leaves equal versions byte for byte', () => {
  const steps = { 1: () => assert.fail('step 1 must not run from 2'), 2: (doc) => doc.set('x', 1) };
  const at2 = PROFILE.replace('schema_version: 1', 'schema_version: 2');
  assert.deepEqual(migrateProfile(at2, { from: 2, to: 3, steps }).applied, [2]);
  assert.equal(migrateProfile(PROFILE, { from: 1, to: 1, steps: {} }).text, PROFILE);
});

test('migrateProfile refuses a newer fork, a missing step and bad YAML', () => {
  assert.throws(() => migrateProfile(PROFILE, { from: 2, to: 1 }), /schema_version 2 is newer than the template's 1/);
  assert.throws(() => migrateProfile(PROFILE, { from: 1, to: 2, steps: {} }), /no migration step from schema_version 1 to 2/);
  assert.throws(() => migrateProfile('a: [', { from: 1, to: 2, steps: { 1: () => {} } }), /not valid YAML/);
});
