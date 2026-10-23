'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProfile, validateProfile, findProfilePath, ProfileError, PROFILE_REL } = require('../../kit/lib/profile');

const fixture = (name) => path.join(__dirname, '../fixtures/profiles', `${name}.yml`);
const parsed = (name) => YAML.parse(fs.readFileSync(fixture(name), 'utf8'));
const rejects = (profile, pattern) => assert.throws(() => validateProfile(profile), (err) => {
  assert.ok(err instanceof ProfileError);
  assert.equal(err.code, 'PROFILE_INVALID');
  assert.match(err.message, pattern);
  return true;
});

test('loads a full profile as declared', () => {
  const p = loadProfile(fixture('full'));
  assert.equal(p.client.id, 'fixture-co');
  assert.deepEqual(p.tiers.T3, ['pay/**']);
  assert.equal(p.gate.engagement_ttl_minutes, 30);
  assert.equal(p.resources.find((r) => r.key === 'OWNER_ONLY').admin_grantable, false);
  assert.deepEqual(p.users[1].deny, ['OWNER_ONLY']);
});

test('fills defaults on a minimal profile', () => {
  const p = loadProfile(fixture('minimal'));
  assert.deepEqual(p.tiers, {});
  assert.deepEqual(p.inert, []);
  assert.deepEqual(p.gate, { exempt: [], engagement_ttl_minutes: 60 });
  assert.deepEqual(p.resources, []);
  assert.deepEqual(p.verify, { checks: [] });
  assert.deepEqual(p.users[0], { id: 'solo', name: 'Solo', role: 'admin', identities: {}, grants: [], deny: [] });
});

test('defaults admin_grantable to true', () => {
  const p = validateProfile({ ...parsed('minimal'), resources: [{ key: 'X', label: 'X' }] });
  assert.equal(p.resources[0].admin_grantable, true);
});

test('result is deep-frozen and the input is not mutated', () => {
  const input = parsed('full');
  const before = JSON.stringify(input);
  const p = validateProfile(input);
  assert.ok(Object.isFrozen(p.users[0].grants));
  assert.throws(() => { p.users[0].grants.push('SHARED'); }, TypeError);
  assert.equal(JSON.stringify(input), before);
});

test('rejects unknown keys at every level', () => {
  rejects({ ...parsed('minimal'), extra: 1 }, /unknown key "extra"/);
  rejects({ ...parsed('minimal'), tiers: { T4: [] } }, /\/tiers has unknown key "T4"/);
  rejects({ ...parsed('minimal'), users: [{ id: 'a', name: 'A', role: 'admin', slack_id: 'U1' }] }, /unknown key "slack_id"/);
});

test('rejects schema violations', () => {
  rejects({ ...parsed('minimal'), schema_version: 2 }, /schema_version/);
  rejects({ ...parsed('minimal'), users: [] }, /\/users/);
  rejects({ ...parsed('minimal'), users: [{ id: 'a', name: 'A', role: 'owner' }] }, /\/users\/0\/role/);
  rejects({ ...parsed('minimal'), client: { id: 'Bad Id', name: 'x' } }, /\/client\/id/);
  rejects({ ...parsed('minimal'), client: { id: 'ok', name: '   ' } }, /\/client\/name/);
  rejects({ ...parsed('minimal'), gate: { engagement_ttl_minutes: 0 } }, /engagement_ttl_minutes/);
  rejects({ ...parsed('minimal'), verify: { checks: [{ id: 'unit', run: 'npm test' }] } }, /\/verify\/checks\/0\/run must be array/);
  rejects({ ...parsed('minimal'), verify: { checks: [{ id: 'unit', run: [] }] } }, /\/verify\/checks\/0\/run/);
  rejects([], /must be a YAML mapping/);
  rejects(null, /must be a YAML mapping/);
});

test('reports every schema error, not just the first', () => {
  const bad = { schema_version: 1, client: { id: 'ok', name: 'Ok' }, users: [{ id: 'a', name: 'A', role: 'x' }], extra: 1 };
  rejects(bad, /unknown key "extra"/);
  rejects(bad, /\/users\/0\/role/);
});

test('rejects grants and denies naming undeclared resources', () => {
  const p = parsed('full');
  p.users[1].grants = ['NOPE'];
  rejects(p, /\/users\/1\/grants names unknown resource "NOPE"/);
});

test('rejects duplicates', () => {
  const p = parsed('full');
  p.users[1].id = 'ada';
  p.resources[1].key = 'OWNER_ONLY';
  p.verify.checks.push({ id: 'unit', run: ['x'] });
  rejects(p, /duplicate resource key "OWNER_ONLY".*duplicate user id "ada".*duplicate verify check id "unit"/);
});

test('requires at least one admin', () => {
  rejects({ ...parsed('minimal'), users: [{ id: 'a', name: 'A', role: 'member' }] }, /at least one admin/);
});

test('refuses to start on unreadable, missing or non-YAML files', () => {
  assert.throws(() => loadProfile(null), /no \.aplabs\/profile\.yml found/);
  assert.throws(() => loadProfile('/nonexistent/profile.yml'), /cannot read profile/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-'));
  const bad = path.join(dir, 'p.yml');
  fs.writeFileSync(bad, 'a: 1\na: 2\n');
  assert.throws(() => loadProfile(bad), /not valid YAML/);
});

test('findProfilePath walks up to .aplabs/profile.yml, and APLABS_PROFILE overrides', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-'));
  fs.mkdirSync(path.join(root, '.aplabs'));
  fs.writeFileSync(path.join(root, PROFILE_REL), '');
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });

  const saved = process.env.APLABS_PROFILE;
  t.after(() => { if (saved === undefined) delete process.env.APLABS_PROFILE; else process.env.APLABS_PROFILE = saved; });
  delete process.env.APLABS_PROFILE;
  assert.equal(findProfilePath(deep), path.join(root, PROFILE_REL));
  assert.equal(findProfilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'none-'))), null);
  process.env.APLABS_PROFILE = '/elsewhere/profile.yml';
  assert.equal(findProfilePath(deep), '/elsewhere/profile.yml');
  process.env.APLABS_PROFILE = 'relative/profile.yml';
  assert.throws(() => findProfilePath(deep), /APLABS_PROFILE must be an absolute path/);
});

test('the Brightside demo profile is valid', () => {
  const p = loadProfile(path.join(__dirname, '../../profiles/brightside/profile.yml'));
  assert.equal(p.client.id, 'brightside');
});
