'use strict';

// kit/runtime/slack/hubs + registry/menu: a hub's slash command replies with a
// private menu built from the fixture entries; an Open click is acked, re-checked
// and dispatched to the module's handler, which replies privately.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry } = require('../../kit/runtime/registry');
const { buildMenu, moduleIdFromAction } = require('../../kit/runtime/registry/menu');
const { registerHubs, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const { PLAIN_ERROR } = require('../../kit/runtime/slack/handle');
const { createStore } = require('../../kit/runtime/store');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime');
const profile = loadProfile(path.join(FIX, 'profile.yml'));
const { registry } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function setup({ env = 'dev', canUse } = {}) {
  const app = new FakeSlackApp({});
  const log = quietLog();
  registerHubs(app, { registry, profile, env, log, store: createStore(), ...(canUse ? { canUse } : {}) });
  return { app, log };
}

const buttons = (msg) => msg.blocks.filter((b) => b.accessory).map((b) => b.accessory.action_id);

test('each hub file registers its slash command; one listener handles Open clicks', () => {
  const { app } = setup();
  assert.deepEqual([...app.commandListeners.keys()], ['/alpha', '/beta']);
  assert.equal(app.actionListeners.length, 1);
});

test('the hub command replies privately with the hub\'s visible entries, label and description', async () => {
  const { app } = setup();
  await app.dispatchCommand('/alpha', { user_id: 'U1' });
  assert.equal(app.acks, 1);
  assert.equal(app.responded.length, 1);
  const [menu] = app.responded;
  assert.equal(menu.response_type, 'ephemeral');
  assert.equal(menu.blocks[0].type, 'header');
  assert.equal(menu.blocks[0].text.text, 'Alpha tools');
  // prod-only is hidden in dev; boom belongs to beta.
  assert.deepEqual(buttons(menu), ['echo:open', 'second:open']);
  const echo = menu.blocks.find((b) => b.block_id === 'entry:echo');
  assert.equal(echo.text.text, '*Echo*\nSays who you are &amp; where &lt;you&gt; are.');
  assert.match(menu.text, /Alpha tools: Echo, Second/);
});

test('in prod the prod-only entry shows and the dev-only one does not', async () => {
  const { app } = setup({ env: 'prod' });
  await app.dispatchCommand('/alpha');
  await app.dispatchCommand('/beta');
  assert.deepEqual(buttons(app.responded[0]), ['echo:open', 'prod-only:open', 'second:open']);
  assert.deepEqual(buttons(app.responded[1]), []);
  assert.match(app.responded[1].blocks[1].text.text, /Nothing is available/);
});

test('a click is acked, runs the module handler, and the reply is private with the person and client names', async () => {
  const { app, log } = setup();
  app.users.U7 = { real_name: 'Real Seven', profile: { display_name: 'Sev', real_name: 'Real Seven' } };
  const ran = await app.dispatchAction('echo:open', { user: { id: 'U7', name: 'u7' } });
  assert.equal(ran, 1);
  assert.equal(app.acks, 1);
  assert.deepEqual(app.responded, [{
    response_type: 'ephemeral',
    replace_original: false,
    text: 'echo for Sev (U7) at Tiny from echo',
  }]);
  assert.ok(log.lines.some((l) => l.msg === 'module dispatched' && l.fields.module === 'echo'));
});

test('a handler may reply with blocks', async () => {
  const { app } = setup();
  await app.dispatchAction('second:open');
  assert.equal(app.responded[0].blocks[0].text.text, 'second');
  assert.equal(app.responded[0].response_type, 'ephemeral');
});

test('when users.info fails, the payload name is used; with no name, a mention', async () => {
  const { app, log } = setup();
  await app.dispatchAction('echo:open', { user: { id: 'U8', name: 'eight' } });
  await app.dispatchAction('echo:open', { user: { id: 'U9' } });
  assert.match(app.responded[0].text, /^echo for eight \(U8\)/);
  assert.match(app.responded[1].text, /^echo for <@U9> \(U9\)/);
  assert.ok(log.lines.some((l) => l.level === 'warn' && /users.info failed/.test(l.msg)));
});

test('a hidden entry\'s action is refused at dispatch, and its handler never runs', async () => {
  const { app, log } = setup({ env: 'dev' });
  await app.dispatchAction('prod-only:open');
  assert.equal(app.acks, 1);
  assert.deepEqual(app.responded.map((r) => r.text), [NOT_AVAILABLE]);
  const refused = log.lines.find((l) => l.msg === 'hub action refused');
  assert.equal(refused.fields.reason, 'hidden in this environment');
});

test('an unknown action id is acked and refused plainly', async () => {
  const { app, log } = setup();
  await app.dispatchAction('ghost:open');
  assert.equal(app.acks, 1);
  assert.deepEqual(app.responded.map((r) => r.text), [NOT_AVAILABLE]);
  assert.equal(log.lines.find((l) => l.msg === 'hub action refused').fields.reason, 'unknown module');
  // Not an Open action at all: no hub listener matches it.
  assert.equal(await app.dispatchAction('echo:delete'), 0);
  assert.equal(moduleIdFromAction('Echo:open'), null);
  assert.equal(moduleIdFromAction(undefined), null);
});

test('a handler that throws gives the person the plain error, never its text', async () => {
  const { app, log } = setup();
  await app.dispatchAction('boom:open');
  assert.equal(app.responded.length, 1);
  assert.equal(app.responded[0].text, PLAIN_ERROR);
  assert.ok(!JSON.stringify(app.responded).includes('internal detail'));
  assert.ok(log.lines.some((l) => l.msg === 'handler failed' && l.fields.handler === 'hub:dispatch'));
});

test('the access seam filters the menu and refuses at dispatch', async () => {
  const canUse = (person, mod) => !(person.id === 'U2' && mod.id === 'echo');
  const { app } = setup({ canUse });
  await app.dispatchCommand('/alpha', { user_id: 'U2' });
  assert.deepEqual(buttons(app.responded[0]), ['second:open']);
  await app.dispatchAction('echo:open', { user: { id: 'U2' } });
  assert.equal(app.responded[1].text, NOT_AVAILABLE);
  await app.dispatchAction('echo:open', { user: { id: 'U3', name: 'three' } });
  assert.match(app.responded[2].text, /^echo for three/);
});

test('by default access asks kit/lib/permissions, so open-access modules are allowed for anyone', async () => {
  const { app } = setup();
  await app.dispatchCommand('/alpha', { user_id: 'UNKNOWN' });
  assert.deepEqual(buttons(app.responded[0]), ['echo:open', 'second:open']);
});

test('buildMenu: entries become sections with an Open button each', () => {
  const hub = { name: 'H' };
  const { text, blocks } = buildMenu(hub, [{ id: 'a-b', label: 'A', description: 'd' }]);
  assert.equal(text, 'H: A');
  assert.deepEqual(blocks[1].accessory, {
    type: 'button', action_id: 'a-b:open', value: 'a-b', text: { type: 'plain_text', text: 'Open', emoji: false },
  });
});
