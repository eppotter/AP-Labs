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

test('resolveStages refuses an unvalidated unknown add-on with a ProfileError rather than dropping it', () => {
  assert.throws(() => resolveStages({ stages: { addons: ['canary'] } }), (err) => {
    assert.ok(err instanceof ProfileError);
    assert.match(err.message, /refusing to start: unknown add-on stage\(s\): canary/);
    return true;
  });
});

test('the schema enum for stages.addons is exactly the ADDONS ids (drift guard)', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../profiles/_schema/profile.schema.json'), 'utf8'));
  const enumIds = schema.properties.stages.properties.addons.items.enum;
  assert.deepEqual([...enumIds].sort(), ADDONS.map((a) => a.id).sort());
  assert.equal(new Set(enumIds).size, enumIds.length);
});

test('every add-on slots after a real core stage, and ids are unique', () => {
  for (const a of ADDONS) assert.ok(CORE.includes(a.after), `${a.id} slots after "${a.after}", which is not a core stage`);
  assert.equal(new Set(ADDONS.map((a) => a.id)).size, ADDONS.length);
  for (const a of ADDONS) assert.ok(!resolveStages({}).some((s) => s.id === a.id), `${a.id} collides with a core stage id`);
});

test('banner: an add-on the schema let through shows the invalid-profile banner, not a crash', () => {
  const os = require('node:os');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-stages-'));
  try {
    fs.mkdirSync(path.join(d, '.aplabs'));
    fs.writeFileSync(path.join(d, '.aplabs/profile.yml'), fs.readFileSync(path.join(__dirname, '../fixtures/profiles/minimal.yml'), 'utf8'));
    // Stand in for schema drift: a resolveStages that meets an add-on it does not know.
    const stagesPath = require.resolve('../../kit/lib/stages');
    const sessionPath = require.resolve('../../kit/lib/session');
    const real = require.cache[stagesPath];
    delete require.cache[sessionPath];
    require.cache[stagesPath] = { ...real, exports: { ...real.exports, resolveStages: () => resolveStages({ stages: { addons: ['canary'] } }) } };
    let out;
    try {
      out = require('../../kit/lib/session').sessionStart(d);
    } finally {
      require.cache[stagesPath] = real;
      delete require.cache[sessionPath];
    }
    assert.match(out.systemMessage, /the profile is invalid and must be fixed before building.*unknown add-on stage\(s\): canary/);
    assert.match(out.hookSpecificOutput.additionalContext, /INVALID/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
