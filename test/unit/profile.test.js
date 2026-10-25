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
  assert.deepEqual(p.verify, { checks: [], env_allow: [] });
  assert.deepEqual(p.sql, { forbidden_columns: [] });
  assert.deepEqual(p.users[0], { id: 'solo', name: 'Solo', role: 'admin', identities: {}, grants: [], deny: [] });
});

test('defaults a verify check timeout to 300 seconds', () => {
  const p = loadProfile(fixture('full'));
  assert.equal(p.verify.checks[0].timeout_seconds, 300);
  const q = validateProfile({ ...parsed('minimal'), verify: { checks: [{ id: 'u', run: ['x'], timeout_seconds: 5 }], env_allow: ['DB_URL'] } });
  assert.equal(q.verify.checks[0].timeout_seconds, 5);
  assert.deepEqual(q.verify.env_allow, ['DB_URL']);
});

test('defaults admin_grantable to true and open_access to false', () => {
  const p = validateProfile({ ...parsed('minimal'), resources: [{ key: 'X', label: 'X' }] });
  assert.equal(p.resources[0].admin_grantable, true);
  assert.equal(p.resources[0].open_access, false);
});

test('accepts sql.forbidden_columns as unique lower-case "table.column" strings', () => {
  const p = validateProfile({ ...parsed('minimal'), sql: { forbidden_columns: ['people.phone', 'sites.postal_code'] } });
  assert.deepEqual(p.sql.forbidden_columns, ['people.phone', 'sites.postal_code']);
  rejects({ ...parsed('minimal'), sql: { forbidden_columns: ['phone'] } }, /\/sql\/forbidden_columns\/0/);
  rejects({ ...parsed('minimal'), sql: { forbidden_columns: ['People.Phone'] } }, /\/sql\/forbidden_columns\/0/);
  rejects({ ...parsed('minimal'), sql: { forbidden_columns: ['a.b.c'] } }, /\/sql\/forbidden_columns\/0/);
  rejects({ ...parsed('minimal'), sql: { forbidden_columns: ['a.b', 'a.b'] } }, /\/sql\/forbidden_columns/);
  rejects({ ...parsed('minimal'), sql: { forbidden: [] } }, /\/sql has unknown key "forbidden"/);
});

test('data.source defaults to local; motherduck needs data.database, and local refuses it', () => {
  assert.deepEqual(loadProfile(fixture('minimal')).data, { source: 'local' });
  assert.deepEqual(validateProfile({ ...parsed('minimal'), data: { source: 'local' } }).data, { source: 'local' });
  assert.deepEqual(
    validateProfile({ ...parsed('minimal'), data: { source: 'motherduck', database: 'acme_fixture' } }).data,
    { source: 'motherduck', database: 'acme_fixture' },
  );
  rejects({ ...parsed('minimal'), data: { source: 'motherduck' } }, /^\[profile\] refusing to start: \/data\/database is required with data\.source: motherduck$/);
  rejects({ ...parsed('minimal'), data: { source: 'local', database: 'acme_fixture' } }, /\/data\/database is only allowed with data\.source: motherduck/);
  rejects({ ...parsed('minimal'), data: { database: 'acme_fixture' } }, /\/data\/database is only allowed with data\.source: motherduck/);
  rejects({ ...parsed('minimal'), data: { source: 'warehouse' } }, /\/data\/source must be equal to one of the allowed values/);
  rejects({ ...parsed('minimal'), data: { source: 'local', path: '/x' } }, /\/data has unknown key "path"/);
});

test('data.database must be a plain name, not my_db, sample_data or a *__publishing staging copy', () => {
  const md = (database) => ({ ...parsed('minimal'), data: { source: 'motherduck', database } });
  for (const bad of ['my_db', 'sample_data', 'acme__publishing']) {
    rejects(md(bad), /\/data\/database must not be my_db or sample_data \(MotherDuck's own\) or end in __publishing/);
  }
  for (const bad of ['Acme', '9lives', 'a-b', 'a"b', 'x'.repeat(64), '']) rejects(md(bad), /\/data\/database must match pattern/);
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
  rejects({ ...parsed('minimal'), verify: { checks: [{ id: 'unit', run: ['x'], timeout_seconds: 0 }] } }, /timeout_seconds/);
  rejects({ ...parsed('minimal'), verify: { checks: [{ id: 'unit', run: ['x'], timeout_seconds: 3601 }] } }, /timeout_seconds/);
  rejects({ ...parsed('minimal'), verify: { env_allow: ['lower'] } }, /\/verify\/env_allow\/0/);
  rejects({ ...parsed('minimal'), verify: { env_allow: ['A', 'A'] } }, /\/verify\/env_allow/);
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

test('rejects two users with the same Slack id; distinct or absent ids are fine', () => {
  const p = parsed('full');
  p.users[0].identities = { slack: 'U0SAME' };
  p.users[1].identities = { slack: 'U0SAME' };
  rejects(p, /users ada, \S+ share identities.slack "U0SAME"/);
  p.users[1].identities = { slack: 'U0OTHER' };
  assert.equal(validateProfile(p).users[1].identities.slack, 'U0OTHER');
  delete p.users[1].identities;
  assert.doesNotThrow(() => validateProfile(p));
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
