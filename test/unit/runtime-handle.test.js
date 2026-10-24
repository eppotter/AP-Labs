'use strict';

// kit/runtime/slack/handle.js: ack before any work; an error after the ack
// becomes a plain private message, never the error's own text.

const test = require('node:test');
const assert = require('node:assert/strict');
const { handle, PLAIN_ERROR } = require('../../kit/runtime/slack/handle');

function quietLog() {
  const lines = [];
  return { lines, error: (msg, fields) => lines.push({ msg, fields }) };
}

test('ack is sent before the work starts', async () => {
  const order = [];
  const fn = handle('t', async () => { order.push('work'); }, { log: quietLog() });
  await fn({ ack: async () => { order.push('ack'); } });
  assert.deepEqual(order, ['ack', 'work']);
});

test('a throw after the ack sends the person a plain message via respond, and is logged', async () => {
  const order = [];
  const log = quietLog();
  const fn = handle('cmd', async () => { order.push('work'); throw new Error('db exploded: secret detail'); }, { log });
  const replies = [];
  await fn({
    ack: async () => { order.push('ack'); },
    respond: async (msg) => { replies.push(msg); },
  });
  assert.deepEqual(order, ['ack', 'work']);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, PLAIN_ERROR);
  assert.equal(replies[0].response_type, 'ephemeral');
  assert.ok(!replies[0].text.includes('exploded'));
  assert.equal(log.lines[0].fields.handler, 'cmd');
});

test('a failing DM handler replies in the DM', async () => {
  const said = [];
  const fn = handle('dm', async () => { throw new Error('x'); }, { log: quietLog() });
  await fn({ message: { channel_type: 'im', channel: 'D1', user: 'U1' }, say: async (m) => said.push(m) });
  assert.deepEqual(said, [{ text: PLAIN_ERROR }]);
});

test('a failing channel event replies ephemerally to the same person', async () => {
  const posts = [];
  const client = { chat: { postEphemeral: async (m) => posts.push(m) } };
  const fn = handle('ev', async () => { throw new Error('x'); }, { log: quietLog() });
  await fn({ event: { channel_type: 'channel', channel: 'C1', user: 'U1' }, say: async () => assert.fail('no public say'), client });
  assert.deepEqual(posts, [{ channel: 'C1', user: 'U1', text: PLAIN_ERROR }]);
});

test('when no private reply path exists, both failures are logged and nothing throws', async () => {
  const log = quietLog();
  const fn = handle('lost', async () => { throw new Error('x'); }, { log });
  await fn({});
  assert.equal(log.lines.length, 2);
});

test('a rejected ack is logged, the work is skipped, and the person still gets the plain message', async () => {
  const log = quietLog();
  let worked = false;
  const fn = handle('cmd', async () => { worked = true; }, { log });
  const replies = [];
  await fn({
    ack: async () => { throw new Error('ack timed out'); },
    respond: async (msg) => { replies.push(msg); },
  });
  assert.equal(worked, false);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, PLAIN_ERROR);
  assert.equal(log.lines[0].msg, 'ack failed');
  assert.equal(log.lines[0].fields.handler, 'cmd');
});
