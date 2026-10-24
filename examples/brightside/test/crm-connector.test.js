'use strict';

// Story 8.2: Brightside's mock CRM over the real, built fixture, through the
// real query runner with Brightside's profile (so its forbidden columns
// apply). An example test (architecture carve-out): it reads Brightside's
// profile, app dir and fixture, and is deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../../kit/fixture/build');
const { createData, QueryRefusedError } = require('../../../kit/runtime/data');
const { loadProfile } = require('../../../kit/lib/profile');
const { ConnectorAuthFailed } = require('../../../kit/runtime/errors');
const crm = require('../app/connectors/crm/connector');

const ROOT = path.join(__dirname, '../../..');
// Not a credential: the mock checks only that the key is set.
const ENV = Object.freeze({ BRIGHTSIDE_CRM_KEY: 'mock-crm-key-not-a-secret' });

let dir;
let data;

test.before(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-brightside-crm-')));
  const file = path.join(dir, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: file });
  data = createData({ file, profile: loadProfile(path.join(ROOT, 'profiles/brightside/profile.yml')) });
});

test.after(() => {
  if (data) data.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// A client straight from the fixture, by the runner, with allowed columns only.
async function fixtureClient(id) {
  const [row] = await data.run('SELECT client_id, first_name, last_name, email, zone_id FROM clients WHERE client_id = $id', { id }, { declared: ['id'] });
  return row;
}

test('the mock CRM finds a fixture client by id and by email, with only client_id, name, email and zone', async () => {
  const c = crm.create({ env: { ...ENV }, data });
  const expected = await fixtureClient(1);
  assert.ok(expected, 'the fixture has client 1');
  const byId = await c.read.lookupClient({ clientId: 1 });
  assert.deepEqual(byId, expected);
  assert.deepEqual(Object.keys(byId).sort(), ['client_id', 'email', 'first_name', 'last_name', 'zone_id']);
  assert.deepEqual(await c.read.lookupClient({ email: `  ${expected.email.toUpperCase()} ` }), expected);
  assert.equal(await c.read.lookupClient({ clientId: 99999999 }), null);
  assert.equal(await c.read.lookupClient({ email: 'nobody@home.invalid' }), null);
});

test('phone and address never come back, and the runner refuses them for Brightside', async () => {
  const c = crm.create({ env: { ...ENV }, data });
  const got = JSON.stringify(await c.read.lookupClient({ clientId: 2 }));
  const [{ n }] = await data.run('SELECT count(*) AS n FROM clients');
  assert.ok(Number(n) > 0, 'sanity: the fixture has clients');
  assert.doesNotMatch(got, /phone|address|postal|555-/);
  await assert.rejects(data.run('SELECT phone FROM clients'), QueryRefusedError);
  await assert.rejects(data.run('SELECT street_address FROM properties'), QueryRefusedError);
});

test('the simulated auth failure fails closed over the real fixture', async () => {
  const c = crm.create({ env: { ...ENV }, data, simulate: { authFailure: true } });
  await assert.rejects(c.read.lookupClient({ clientId: 1 }), ConnectorAuthFailed);
});
