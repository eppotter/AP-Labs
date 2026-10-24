'use strict';

// The mock CRM's own test: the shared contract suite, then what lookupClient
// returns and never touches. The query runner here is a stand-in that answers
// from a few in-memory clients and records every query; the real runner over
// the built fixture is exercised in examples/brightside/test/crm-connector.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  connectorContract, testLog, ConnectorAuthFailed, ConnectorFailed,
} = require('#sdk');
const connector = require('./connector');

// Not a credential: any non-empty value stands in for the API key.
const ENV = Object.freeze({ BRIGHTSIDE_CRM_KEY: 'mock-crm-key-not-a-secret' });

const CLIENTS = Object.freeze([
  { client_id: 1, zone_id: 'central', first_name: 'Briar', last_name: 'Redley', email: 'briar.redley.1@home.invalid', phone: '555-0139' },
  { client_id: 2, zone_id: 'north', first_name: 'Laurel', last_name: 'Deepton', email: 'laurel.deepton.2@home.invalid', phone: '555-0189' },
]);

// A stand-in for the runner: run(sql, params, { declared }) answers by the one
// bound parameter and returns only the columns the SQL selects.
function fakeData() {
  const queries = [];
  return {
    queries,
    async run(sql, params = {}, { declared = [] } = {}) {
      queries.push({ sql, params, declared });
      const cols = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s/i.exec(sql)[1].split(',').map((c) => c.trim());
      const match = Object.hasOwn(params, 'client_id')
        ? (c) => c.client_id === params.client_id
        : (c) => c.email.toLowerCase() === params.email;
      return CLIENTS.filter(match).map((c) => Object.fromEntries(cols.map((k) => [k, c[k]])));
    },
  };
}

function crm({ simulate, data = fakeData(), now, sleep } = {}) {
  const requests = [];
  const instance = connector.create({ log: testLog(), env: { ...ENV }, data, simulate, now, sleep, onRequest: (r) => requests.push(r) });
  return { instance, data, requests };
}

connectorContract(connector, { read: { lookupClient: { clientId: 1 } } }, { deps: { data: fakeData() } });

test('crm: it is the read path only, with a stand-in API key and its own kill switch', () => {
  const d = connector.describe ? connector.describe() : connector.declaration;
  assert.deepEqual([...d.read], ['lookupClient']);
  assert.deepEqual([...d.write], [], 'no write operations');
  assert.deepEqual([...d.auth.env], ['BRIGHTSIDE_CRM_KEY']);
  assert.equal(d.killSwitchEnv, 'BRIGHTSIDE_CRM_OFF');
});

test('crm: looks a client up by id, returning only the allowed fields, through the runner with a bound parameter', async () => {
  const { instance, data } = crm();
  assert.deepEqual(await instance.read.lookupClient({ clientId: 2 }), {
    client_id: 2, first_name: 'Laurel', last_name: 'Deepton', email: 'laurel.deepton.2@home.invalid', zone_id: 'north',
  });
  assert.equal(data.queries.length, 1);
  assert.deepEqual(data.queries[0].params, { client_id: 2 });
  assert.deepEqual(data.queries[0].declared, ['client_id']);
  assert.match(data.queries[0].sql, /\$client_id/);
  assert.ok(!data.queries[0].sql.includes('2'), 'the id is bound, never spliced in');
});

test('crm: an id given as a string of digits is the same client', async () => {
  const { instance, data } = crm();
  assert.equal((await instance.read.lookupClient({ clientId: ' 1 ' })).client_id, 1);
  assert.deepEqual(data.queries[0].params, { client_id: 1 });
});

test('crm: looks a client up by email, trimmed and case-insensitive', async () => {
  const { instance, data } = crm();
  const got = await instance.read.lookupClient({ email: '  Briar.Redley.1@HOME.invalid ' });
  assert.equal(got.client_id, 1);
  assert.deepEqual(data.queries[0].params, { email: 'briar.redley.1@home.invalid' });
  assert.deepEqual(data.queries[0].declared, ['email']);
});

test('crm: an unknown client is a clean null, not an error', async () => {
  const { instance } = crm();
  assert.equal(await instance.read.lookupClient({ clientId: 999 }), null);
  assert.equal(await instance.read.lookupClient({ email: 'nobody@home.invalid' }), null);
});

test('crm: fields narrows what is fetched; phone and address are never fetched or returned', async () => {
  const { instance, data } = crm();
  assert.deepEqual(await instance.read.lookupClient({ clientId: 1, fields: ['email'] }), { email: 'briar.redley.1@home.invalid' });
  assert.match(data.queries[0].sql, /^SELECT email FROM/);
  for (const field of ['phone', 'street_address', 'postal_code', 'address', '*']) {
    await assert.rejects(instance.read.lookupClient({ clientId: 1, fields: [field] }), (e) => e instanceof ConnectorFailed && e.reason.includes(field));
  }
  await instance.read.lookupClient({ clientId: 1 });
  await instance.read.lookupClient({ email: 'briar.redley.1@home.invalid' });
  assert.equal(data.queries.length, 3, 'a refused field never reached the runner');
  for (const { sql } of data.queries) assert.doesNotMatch(sql, /phone|address|postal|\*/i);
  const all = await instance.read.lookupClient({ clientId: 1 });
  assert.deepEqual(Object.keys(all).sort(), [...connector.FIELDS].sort());
  assert.deepEqual([...connector.FIELDS], ['client_id', 'first_name', 'last_name', 'email', 'zone_id']);
});

test('crm: a lookup needs exactly one of a whole-number clientId or an email', async () => {
  const { instance, data } = crm();
  for (const input of [{}, { clientId: 1, email: 'a@b.invalid' }, { clientId: 1.5 }, { clientId: '1; DROP' }, { clientId: -1 },
    { email: '' }, { email: '   ' }, { email: 42 }, { clientId: 1, fields: 'email' }, { clientId: 1, fields: [] }]) {
    await assert.rejects(instance.read.lookupClient(input), ConnectorFailed, JSON.stringify(input));
  }
  assert.equal(data.queries.length, 0);
});

test('crm: without a query runner it fails with a plain reason, never a result', async () => {
  const c = connector.create({ log: testLog(), env: { ...ENV } });
  await assert.rejects(c.read.lookupClient({ clientId: 1 }), (e) => e instanceof ConnectorFailed && /query runner/.test(e.reason));
});

test('crm: a missing API key fails closed before the runner is called', async () => {
  const data = fakeData();
  const c = connector.create({ log: testLog(), env: {}, data });
  await assert.rejects(c.read.lookupClient({ clientId: 1 }), (e) => e instanceof ConnectorAuthFailed && /BRIGHTSIDE_CRM_KEY/.test(e.reason));
  assert.equal(data.queries.length, 0);
});

test('crm: the simulated auth failure fails closed and never queries', async () => {
  const { instance, data } = crm({ simulate: { authFailure: true } });
  await assert.rejects(instance.read.lookupClient({ clientId: 1 }), ConnectorAuthFailed);
  await assert.rejects(instance.read.lookupClient({ email: 'briar.redley.1@home.invalid' }), ConnectorAuthFailed);
  assert.equal(data.queries.length, 0);
});

test('crm: a simulated rate limit is waited out and retried, spaced by the rate limit; never dropped', async () => {
  let t = 0;
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const { instance, data, requests } = crm({ simulate: { rateLimited: 2 }, now, sleep });
  assert.equal((await instance.read.lookupClient({ clientId: 1 })).client_id, 1);
  assert.equal(requests.length, 3, 'two refused calls, then one answered');
  assert.equal(data.queries.length, 1, 'the refused calls never reached the data');
  const interval = 1000 / connector.declaration.rateLimit.perSecond;
  for (let i = 1; i < requests.length; i += 1) assert.ok(requests[i].at - requests[i - 1].at >= interval);
});

test('crm: a rate limit that outlasts the retries fails, it never returns empty', async () => {
  const { instance, data } = crm({ simulate: { rateLimited: 100 }, now: () => 0, sleep: async () => {} });
  await assert.rejects(instance.read.lookupClient({ clientId: 1 }), (e) => e instanceof ConnectorFailed && /rate limit/i.test(e.reason));
  assert.equal(data.queries.length, 0);
});

test('crm: a malformed email is a clean refusal, never a query (#84)', async () => {
  const { instance, data } = crm();
  for (const email of ['not-an-email', 'a@b', '@home.invalid', 'a@', 'a b@home.invalid', 'a@@home.invalid', 'a@home .invalid',
    'a@home..invalid', '.a@home.invalid', `${'a'.repeat(250)}@home.invalid`]) {
    await assert.rejects(instance.read.lookupClient({ email }), (e) => e instanceof ConnectorFailed && /email/.test(e.reason), email);
  }
  assert.equal(data.queries.length, 0, 'no malformed email reached the runner');
  assert.equal((await instance.read.lookupClient({ email: 'Briar.Redley.1+x@home.invalid' })), null, 'a plus address is well formed');
});
