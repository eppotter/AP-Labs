'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProfile } = require('../../kit/lib/profile');
const { resolveAccess, hasAccess, accessMatrix } = require('../../kit/lib/permissions');

const profile = validateProfile({
  schema_version: 1,
  client: { id: 'perm-co', name: 'Perm Co' },
  resources: [
    { key: 'SHARED', label: 'Shared' },
    { key: 'OTHER', label: 'Other' },
    { key: 'OWNER_ONLY', label: 'Owner only', admin_grantable: false },
    { key: 'OPEN', label: 'Open', open_access: true },
  ],
  users: [
    { id: 'admin', name: 'Admin', role: 'admin' },
    { id: 'admin-deny', name: 'Admin Deny', role: 'admin', deny: ['SHARED'] },
    { id: 'owner', name: 'Owner', role: 'admin', grants: ['OWNER_ONLY'] },
    { id: 'member', name: 'Member', role: 'member', grants: ['SHARED'] },
    { id: 'conflict', name: 'Conflict', role: 'member', grants: ['OTHER'], deny: ['OTHER'] },
    { id: 'no-open', name: 'No Open', role: 'member', deny: ['OPEN'] },
  ],
});
const check = (user, key) => resolveAccess(profile, user, key);

test('no user id -> denied', () => {
  assert.equal(check(undefined, 'SHARED'), 'denied');
  assert.equal(check('', 'SHARED'), 'denied');
  assert.equal(check(42, 'SHARED'), 'denied');
});

test('undeclared key -> error (a typo, never a revocation), including prototype names', () => {
  for (const key of ['NOT_A_KEY', 'constructor', '__proto__', 'toString', undefined, 7]) {
    assert.equal(check('admin', key), 'error', String(key));
  }
});

test('prototype names never resolve as users', () => {
  for (const user of ['constructor', '__proto__', 'hasOwnProperty']) assert.equal(check(user, 'SHARED'), 'denied');
});

test('open_access is allowed even for someone not in users', () => {
  assert.equal(check('stranger', 'OPEN'), 'allowed');
  assert.equal(check(undefined, 'OPEN'), 'allowed');
});

test('a user deny beats open_access', () => {
  assert.equal(check('no-open', 'OPEN'), 'denied');
});

test('not in users -> denied (default deny)', () => {
  assert.equal(check('stranger', 'SHARED'), 'denied');
});

test('member: granted key allowed, anything else denied', () => {
  assert.equal(check('member', 'SHARED'), 'allowed');
  assert.equal(check('member', 'OTHER'), 'denied');
});

test('admin: every admin_grantable resource allowed', () => {
  for (const r of profile.resources.filter((x) => x.admin_grantable)) assert.equal(check('admin', r.key), 'allowed', r.key);
});

test('admin does NOT confer owner-only resources; an explicit grant does', () => {
  assert.equal(check('admin', 'OWNER_ONLY'), 'denied');
  assert.equal(check('owner', 'OWNER_ONLY'), 'allowed');
});

test('deny wins over admin and over a grant of the same key', () => {
  assert.equal(check('admin-deny', 'SHARED'), 'denied');
  assert.equal(check('admin-deny', 'OTHER'), 'allowed');
  assert.equal(check('conflict', 'OTHER'), 'denied');
});

test('user ids are case-exact', () => {
  assert.equal(check('Member', 'SHARED'), 'denied');
});

test('a malformed profile argument -> error, not a throw', () => {
  assert.equal(resolveAccess(null, 'admin', 'SHARED'), 'error');
  assert.equal(resolveAccess({}, 'admin', 'SHARED'), 'error');
});

test('two profiles resolve independently', () => {
  const other = validateProfile({
    schema_version: 1,
    client: { id: 'other-co', name: 'Other Co' },
    resources: [{ key: 'SHARED', label: 'Shared' }],
    users: [{ id: 'member', name: 'Member', role: 'admin', deny: ['SHARED'] }],
  });
  assert.equal(resolveAccess(other, 'member', 'SHARED'), 'denied');
  assert.equal(check('member', 'SHARED'), 'allowed');
});

test('hasAccess: true only for allowed; denied and error both collapse to false', () => {
  assert.equal(hasAccess(profile, 'member', 'SHARED'), true);
  assert.equal(hasAccess(profile, 'member', 'OTHER'), false);
  assert.equal(hasAccess(profile, 'member', 'NOT_A_KEY'), false);
});

test('accessMatrix: one row per resource, in profile order, agreeing with resolveAccess', () => {
  const m = accessMatrix(profile, 'admin-deny');
  assert.deepEqual([...m.keys()], profile.resources.map((r) => r.key));
  assert.deepEqual(m.get('OPEN'), { allowed: true, label: 'Open' });
  for (const [key, row] of m) assert.equal(row.allowed, check('admin-deny', key) === 'allowed');
});

test('accessMatrix: a stranger gets only open_access rows', () => {
  const allowed = [...accessMatrix(profile, 'stranger')].filter(([, r]) => r.allowed).map(([k]) => k);
  assert.deepEqual(allowed, ['OPEN']);
});
