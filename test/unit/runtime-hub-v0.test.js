'use strict';

// Story 16.2 (plan brightside-v0, D1, D12): a blank hub (`"sees": []`, no
// modules) opens a menu with only Help, and every way out of
// it works: Help then Back, the X, an expired trigger (the ephemeral
// fallback) and a person not in the profile (the "not set up" notice). The
// Slack mirror: files:read is a bot scope, and the example's manifest is the
// generator's output with both commands (checked in the example's own test).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry } = require('../../kit/runtime/registry');
const { registerHubs } = require('../../kit/runtime/slack/hubs');
const { createHubViews } = require('../../kit/runtime/slack/hub-view');
const { buildManifest } = require('../../kit/runtime/slack/manifest');
const { BOT_SCOPES } = require('../../kit/runtime/slack/scopes');
const { createStore } = require('../../kit/runtime/store');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime');
const APP_DIR = path.join(FIX, 'app-blank');
// UADA is set up (an admin); anyone else is not in the profile.
const profile = loadProfile(path.join(FIX, 'access.yml'));
const { registry, problems } = loadRegistry({ appDir: APP_DIR, profile });

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function setup() {
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  // A real-looking runner the blank hub must never be handed.
  const data = Object.freeze({ run: async () => { throw new Error('the blank hub reached the runner'); }, describe: () => ({ available: true }) });
  const { forHub } = createHubViews({ hubs: registry.hubs, data });
  registerHubs(app, { registry, profile, env: 'dev', log, store: createStore(), forHub });
  return { app, log, forHub };
}

const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const openButtons = (blocks) => blocks.filter((b) => b.accessory && /:open$/.test(b.accessory.action_id));
const actionIds = (blocks) => blocks.filter((b) => b.accessory).map((b) => b.accessory.action_id);
const MENU_VIEW = { id: 'VMENU', type: 'modal', private_metadata: 'blank' };
const NOT_SET_UP = /^You're not set up in Tiny &amp; Co's bot yet/;

test('the blank fixture hub loads: it sees nothing, has no usage hint and no modules', () => {
  assert.deepEqual(problems, []);
  const [hub] = registry.hubs;
  assert.equal(registry.hubs.length, 1);
  assert.deepEqual(hub.sees, []);
  assert.equal(hub.usage_hint, undefined);
  assert.deepEqual(registry.entries('blank'), []);
  const { forHub } = setup();
  assert.equal(forHub('blank').data, null, 'a hub that sees no data gets the null runner');
});

test('the blank hub opens a modal with only Help: with no rows there is no summary, so its blank-hub welcome is left out', async () => {
  const { app } = setup();
  await app.dispatchCommand('/blank', { user_id: 'UADA' });
  assert.equal(app.acks, 1);
  assert.deepEqual(app.responded, []);
  const [{ view }] = calls(app, 'open');
  assert.equal(view.title.text, 'Blank tools');
  assert.equal(view.close.text, 'Close');
  assert.equal(view.submit, undefined);
  assert.deepEqual(openButtons(view.blocks), []);
  assert.deepEqual(actionIds(view.blocks), ['blank:help']);
  // A hub that sees nothing shows its welcome only while its summary says
  // it is blank; no rows means no summary is read, so no welcome.
  assert.equal(view.blocks.find((b) => b.block_id === 'welcome'), undefined);
  // No header repeats the modal's title.
  assert.ok(!view.blocks.some((b) => b.type === 'header'), 'the title is not repeated');
  assert.ok(!view.blocks.some((b) => b.type === 'context'), 'a set-up person sees no notice');
});

test('way out, Help then Back: Help pushes a view whose close is Back, listing nothing to use', async () => {
  const { app } = setup();
  await app.dispatchAction('blank:help', { user: { id: 'UADA' }, view: MENU_VIEW });
  assert.deepEqual(app.views.map((v) => v.method), ['push']);
  const [{ view }] = calls(app, 'push');
  assert.equal(view.title.text, 'Help: Blank tools');
  // Back is the pushed view's close button: Slack pops it and shows the menu.
  assert.equal(view.close.text, 'Back');
  assert.equal(view.submit, undefined);
  assert.equal(view.notify_on_close, undefined);
  assert.match(view.blocks.find((b) => b.block_id === 'help:modules').text.text, /Nothing is available to you here yet\./);
  assert.deepEqual(app.responded, []);
});

test('way out, the X: the menu has Close and no Submit, and asks Slack for no view_closed, so nothing runs', async () => {
  const { app } = setup();
  await app.dispatchCommand('/blank', { user_id: 'UADA' });
  const [{ view }] = calls(app, 'open');
  assert.equal(view.close.text, 'Close');
  assert.equal(view.submit, undefined);
  assert.equal(view.notify_on_close, undefined);
  assert.equal(await app.dispatchViewClosed(view.callback_id, { user: { id: 'UADA' }, view: { ...MENU_VIEW, callback_id: view.callback_id } }), 0);
});

test('way out, an expired trigger: the existing ephemeral fallback with only Help, logged without person data', async () => {
  const { app, log } = setup();
  // The trigger ages past Slack's 3 seconds before views.open.
  const open = app.client.views.open;
  app.client.views.open = async (args) => { app.expireTriggers(); return open(args); };
  await app.dispatchCommand('/blank', { user_id: 'UADA' });
  assert.equal(app.responded.length, 1);
  const [reply] = app.responded;
  assert.equal(reply.response_type, 'ephemeral');
  assert.deepEqual(actionIds(reply.blocks), ['blank:help']);
  const fb = log.lines.filter((l) => l.msg === 'hub modal fallback');
  assert.deepEqual(fb.map((l) => l.fields), [{ where: 'command', reason: 'expired_trigger_id', hub: 'blank' }]);
  assert.ok(!JSON.stringify(log.lines).includes('UADA'));
});

test('way out, a person not in the profile: the existing "not set up" notice, on the menu and in Help', async () => {
  const { app } = setup();
  await app.dispatchCommand('/blank', { user_id: 'UNOBODY' });
  const [{ view }] = calls(app, 'open');
  assert.deepEqual(actionIds(view.blocks), ['blank:help']);
  assert.match(view.blocks.find((b) => b.type === 'context').elements[0].text, NOT_SET_UP);
  await app.dispatchAction('blank:help', { user: { id: 'UNOBODY' }, view: MENU_VIEW });
  const [{ view: help }] = calls(app, 'push');
  assert.match(help.blocks.find((b) => b.type === 'context').elements[0].text, NOT_SET_UP);
});

test('the manifest lists a blank hub\'s command with no usage hint', () => {
  const m = buildManifest({ base: {}, hubs: registry.hubs });
  assert.deepEqual(m.features.slash_commands, [
    { command: '/blank', description: 'Open the Blank (blank) menu', should_escape: false },
  ]);
});

test('files:read is a bot scope: the seven scopes Slack shows', () => {
  assert.deepEqual([...BOT_SCOPES].sort(), [
    'chat:write', 'commands', 'files:read', 'files:write', 'im:history', 'im:write', 'users:read',
  ]);
});

// The example's v0 hub and manifest: examples/brightside/test/slack-manifest.test.js.
