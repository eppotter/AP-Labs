'use strict';

// The module's own test: runs the handler against a test ctx from the SDK (no
// Slack, no data file). Replace these with tests of what the module does.

const test = require('node:test');
const assert = require('node:assert/strict');
const { testContext } = require('#sdk');
const handler = require('./handler');

test('replies once, privately, naming the person', async () => {
  const ctx = testContext({ person: { id: 'U1', name: 'Ada' } });
  await handler(ctx);
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0], /Ada/);
});
