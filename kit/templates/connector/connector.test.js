'use strict';

// The connector's own test: the shared contract suite from the SDK, which
// checks dry-run, both kill switches, idempotency, the rate limit, fail-closed
// reads and redacted errors. Give it one sample input per operation. Add tests
// of what your operations return below it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { connectorContract, testLog } = require('#sdk');
const connector = require('./connector');

const items = (count) => Array.from({ length: count }, (_, i) => ({ id: `p${i}`, email: `p${i}@example.invalid`, name: `P${i}` }));

connectorContract(connector, {
  read: { getRecord: { id: 'r1', fields: ['id', 'email'] } },
  write: {
    createList: (idempotencyKey) => ({ name: 'example-list', idempotencyKey }),
    addItems: (idempotencyKey) => ({ listId: 'list-1', items: items(3), idempotencyKey }),
  },
  bulk: { operation: 'addItems', input: (count, idempotencyKey) => ({ listId: 'list-1', items: items(count), idempotencyKey }) },
});

test('getRecord returns only the fields asked for', async () => {
  const c = connector.create({ env: { MY_SYSTEM_TOKEN: 'test-token' }, log: testLog() });
  assert.deepEqual(await c.read.getRecord({ id: 'r1', fields: ['id', 'email'] }), { id: 'r1', email: 'example@example.invalid' });
  assert.equal(await c.read.getRecord({ id: 'nope' }), null);
  await assert.rejects(c.read.getRecord({ id: 'r1', fields: ['phone'] }), /unknown fields phone/);
});
