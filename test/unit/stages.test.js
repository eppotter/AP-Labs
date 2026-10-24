'use strict';

// Add-on stages (Story 2.6): the schema accepts each add-on and rejects unknown
// or duplicate ones, and resolveStages slots add-ons between core stages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { validateProfile, ProfileError } = require('../../kit/lib/profile');
const { CORE, ADDONS, resolveStages } = require('../../kit/lib/stages');

const minimal = () => YAML.parse(fs.readFileSync(path.join(__dirname, '../fixtures/profiles/minimal.yml'), 'utf8'));
const withAddons = (addons) => validateProfile({ ...minimal(), stages: { addons } });
const names = (profile) => resolveStages(profile).map((s) => s.name);
const rejects = (stages, pattern) => assert.throws(() => validateProfile({ ...minimal(), stages }), (err) => {
  assert.ok(err instanceof ProfileError);
  assert.match(err.message, /refusing to start/);
  assert.match(err.message, pattern);
  return true;
});

test('loader defaults stages to no add-ons', () => {
  assert.deepEqual(validateProfile(minimal()).stages, { addons: [] });
  assert.deepEqual(validateProfile({ ...minimal(), stages: {} }).stages, { addons: [] });
});

test('schema accepts each add-on, alone and all together', () => {
  for (const { id } of ADDONS) assert.deepEqual(withAddons([id]).stages.addons, [id]);
  assert.equal(withAddons(['dark_launch', 'dev_test', 'review_queue']).stages.addons.length, 3);
});

test('schema rejects unknown and duplicate add-ons, and unknown keys under stages', () => {
  rejects({ addons: ['canary'] }, /\/stages\/addons\/0 must be equal to one of the allowed values/);
  rejects({ addons: ['dev_test', 'dev_test'] }, /\/stages\/addons must NOT have duplicate items/);
  rejects({ addons: 'dev_test' }, /\/stages\/addons must be array/);
  rejects({ addons: [], core: ['Intake'] }, /\/stages has unknown key "core"/);
});

test('resolveStages: no add-ons gives the 8 core stages', () => {
  assert.deepEqual(names(validateProfile(minimal())), CORE);
  assert.deepEqual(names({}), CORE);
  assert.deepEqual(resolveStages(validateProfile(minimal()))[2], { id: 'plan_approval', name: 'Plan approval', core: true });
});

test('resolveStages: each single add-on lands in its slot', () => {
  assert.deepEqual(names(withAddons(['dev_test'])),
    ['Intake', 'Spec', 'Plan approval', 'Build', 'Verify', 'Review', 'Dev environment test', 'Ship', 'Retro']);
  assert.deepEqual(names(withAddons(['dark_launch'])),
    ['Intake', 'Spec', 'Plan approval', 'Build', 'Verify', 'Review', 'Ship', 'Dark launch + flag flip', 'Retro']);
  assert.deepEqual(names(withAddons(['review_queue'])),
    ['Intake', 'Spec', 'Plan approval', 'Build', 'Verify', 'Review', 'Batch review queue', 'Ship', 'Retro']);
});

test('resolveStages: all three, in any profile order, give one fixed order', () => {
  const expected = [
    { id: 'intake', name: 'Intake', core: true },
    { id: 'spec', name: 'Spec', core: true },
    { id: 'plan_approval', name: 'Plan approval', core: true },
    { id: 'build', name: 'Build', core: true },
    { id: 'verify', name: 'Verify', core: true },
    { id: 'review', name: 'Review', core: true },
    { id: 'review_queue', name: 'Batch review queue', core: false },
    { id: 'dev_test', name: 'Dev environment test', core: false },
    { id: 'ship', name: 'Ship', core: true },
    { id: 'dark_launch', name: 'Dark launch + flag flip', core: false },
    { id: 'retro', name: 'Retro', core: true },
  ];
  assert.deepEqual(resolveStages(withAddons(['dark_launch', 'dev_test', 'review_queue'])), expected);
  assert.deepEqual(resolveStages(withAddons(['review_queue', 'dark_launch', 'dev_test'])), expected);
});

test('resolveStages never removes or reorders a core stage', () => {
  const core = resolveStages(withAddons(ADDONS.map((a) => a.id))).filter((s) => s.core).map((s) => s.name);
  assert.deepEqual(core, CORE);
});

test('resolveStages refuses an unvalidated unknown add-on rather than dropping it', () => {
  assert.throws(() => resolveStages({ stages: { addons: ['canary'] } }), /unknown add-on stage\(s\): canary/);
});
