'use strict';

// Brightside's demo profile is valid against the engine's schema. An example
// test (architecture carve-out, moved here from test/unit in Story 6.5): it
// reads profiles/brightside/ and is deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../../kit/lib/profile');

test('the Brightside demo profile is valid', () => {
  const p = loadProfile(path.join(__dirname, '../../../profiles/brightside/profile.yml'));
  assert.equal(p.client.id, 'brightside');
});

// Story 10.2 (Q6): Win-back pushes to the email tool (approval-write), so its
// resource is owner-only and granted to Dana by name; the admin role alone
// does not confer it.
test('WIN_BACK is admin_grantable: false and granted to Dana by name', () => {
  const p = loadProfile(path.join(__dirname, '../../../profiles/brightside/profile.yml'));
  assert.equal(p.resources.find((r) => r.key === 'WIN_BACK').admin_grantable, false);
  const holders = p.users.filter((u) => (u.grants || []).includes('WIN_BACK')).map((u) => u.name);
  assert.deepEqual(holders, ['Dana Reyes']);
});

// Story 10.3: slack.ops_channel stays unset until Ely creates #brightside-ops
// in aplabs-demo and gives its id (DEP ledger), so a failed push is logged
// only. Setting it is a reviewed profile change: update this test with it.
test('slack.ops_channel is not set yet: a failed push is logged only', () => {
  const p = loadProfile(path.join(__dirname, '../../../profiles/brightside/profile.yml'));
  assert.equal(p.slack, undefined);
});
