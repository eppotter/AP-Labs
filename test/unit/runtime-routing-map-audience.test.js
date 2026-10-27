'use strict';

// Story 15.4 (AD-R17): who sees which crews on the routing map. A
// dispatcher (all_crews) sees every crew; a crew lead (own_crew and a
// crew_leads row) only their own; own_crew with no row, an undeclared key or
// no audience is the configuration refusal, never a map; a user's deny beats
// every allow. The profile is a synthetic fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile, validateProfile } = require('../../kit/lib/profile');
const audience = require('../../kit/runtime/archetypes/routing-map/audience');

const FIXTURE = path.join(__dirname, '../fixtures/profiles/routing-audience.yml');
const profile = loadProfile(FIXTURE);
const user = (id) => profile.users.find((u) => u.id === id);

// The fixture as plain data, edited, then validated like a loaded profile.
function edited(edit) {
  const raw = JSON.parse(JSON.stringify(profile));
  edit(raw);
  return validateProfile(raw);
}

test('canOpen: the dispatcher, a crew lead and a misconfigured lead see the entry; the rest do not', () => {
  for (const id of ['dispatch', 'lead-a', 'lead-b', 'lead-none', 'lead-ghost']) assert.equal(audience.canOpen(profile, user(id)), 'allowed', id);
  assert.equal(audience.canOpen(profile, user('member')), 'denied');
  assert.equal(audience.canOpen(profile, null), 'denied', 'a person not set up');
});

test('scopeFor: all_crews sees every crew; a crew lead only the crew of their row', () => {
  assert.deepEqual(audience.scopeFor(profile, user('dispatch')), { scope: { all: true } });
  assert.deepEqual(audience.scopeFor(profile, user('lead-a')), { scope: { crewId: 'v1' } });
  assert.deepEqual(audience.scopeFor(profile, user('lead-b')), { scope: { crewId: 'v2' } });
  assert.ok(Object.isFrozen(audience.scopeFor(profile, user('lead-a')).scope));
});

test('scopeFor: own_crew with no crew_leads row is the configuration refusal, never a scope', () => {
  assert.deepEqual(audience.scopeFor(profile, user('lead-none')), { refusal: 'config', reason: 'own_crew with no crew_leads row' });
});

test('scopeFor: no grant, or no person, is denied', () => {
  assert.deepEqual(audience.scopeFor(profile, user('member')), { refusal: 'denied' });
  assert.deepEqual(audience.scopeFor(profile, null), { refusal: 'denied' });
});

test('the admin role counts only where the key is admin_grantable (kit/lib/permissions)', () => {
  // Resources are admin_grantable unless they say otherwise.
  assert.deepEqual(audience.scopeFor(profile, user('admin')), { scope: { all: true } });
  const closed = edited((p) => {
    for (const r of p.resources) if (r.key.startsWith('ROUTING_')) r.admin_grantable = false;
  });
  assert.deepEqual(audience.scopeFor(closed, closed.users.find((u) => u.id === 'admin')), { refusal: 'denied' });
});

test('deny beats allow: a dispatcher denied all_crews falls back to nothing; a lead denied own_crew is refused', () => {
  const p = edited((raw) => {
    raw.users.find((u) => u.id === 'dispatch').deny = ['ROUTING_ALL_CREWS'];
    raw.users.find((u) => u.id === 'lead-a').deny = ['ROUTING_OWN_CREW'];
  });
  assert.deepEqual(audience.scopeFor(p, p.users.find((u) => u.id === 'dispatch')), { refusal: 'denied' });
  assert.deepEqual(audience.scopeFor(p, p.users.find((u) => u.id === 'lead-a')), { refusal: 'denied' });
  assert.equal(audience.canOpen(p, p.users.find((u) => u.id === 'lead-a')), 'denied');
});

test('no routing audience in the profile is the configuration refusal for everyone', () => {
  const p = edited((raw) => { delete raw.routing.audience; });
  assert.equal(audience.canOpen(p, p.users.find((u) => u.id === 'dispatch')), 'error');
  assert.deepEqual(audience.scopeFor(p, p.users.find((u) => u.id === 'dispatch')), { refusal: 'config', reason: 'no routing audience in the profile' });
  assert.deepEqual(audience.scopeFor({}, null), { refusal: 'config', reason: 'no routing audience in the profile' });
});

test('an audience key the resources do not declare is a configuration fault, not a denial', () => {
  // The profile check refuses this at load; the decision still fails closed.
  const p = { ...profile, routing: { ...profile.routing, audience: { ...profile.routing.audience, all_crews: 'NOT_DECLARED' } } };
  assert.equal(audience.canOpen(p, user('dispatch')), 'error');
  assert.deepEqual(audience.scopeFor(p, user('lead-a')), { refusal: 'config', reason: 'an audience key is not declared' });
});

test('checkScope: a crew lead whose crew is not in the day is the configuration refusal; a dispatcher always passes', () => {
  assert.equal(audience.checkScope({ all: true }, []), 'ok');
  assert.equal(audience.checkScope({ crewId: 'v1' }, ['v1', 'v2']), 'ok');
  assert.equal(audience.checkScope({ crewId: 'v1' }, new Set(['v1'])), 'ok');
  assert.equal(audience.checkScope({ crewId: 'v9' }, ['v1', 'v2']), 'config');
  assert.equal(audience.checkScope(null, ['v1']), 'config');
  assert.equal(audience.checkScope({}, ['v1']), 'config');
});

test('visible: a dispatcher sees every crew, a crew lead only their own, and nothing without a scope', () => {
  assert.equal(audience.visible({ all: true }, 'v3'), true);
  assert.equal(audience.visible({ crewId: 'v1' }, 'v1'), true);
  assert.equal(audience.visible({ crewId: 'v1' }, 'v2'), false);
  assert.equal(audience.visible({ crewId: 'v1' }, undefined), false);
  assert.equal(audience.visible(null, 'v1'), false);
});
