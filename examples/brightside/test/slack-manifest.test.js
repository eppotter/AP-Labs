'use strict';

// Brightside's Slack app manifest matches the runtime's allowed scopes and
// events (AD-5), runs in Socket Mode, and is exactly what `npm run
// slack:manifest` generates from the hub files. An example test (architecture
// carve-out): deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BOT_SCOPES, BOT_EVENTS } = require('../../../kit/runtime/slack/scopes');
const { run } = require('../../../kit/runtime/slack/manifest');

const APP_DIR = path.join(__dirname, '../app');
const manifest = require(path.join(APP_DIR, 'slack-manifest.json'));

test('the committed manifest is what npm run slack:manifest generates from the hub files', () => {
  const r = run({ argv: ['--check'], env: { APLABS_APP_DIR: APP_DIR } });
  assert.equal(r.code, 0, `${r.out}\nRun: APLABS_APP_DIR=$PWD/examples/brightside/app npm run slack:manifest`);
});

test('the slash commands are the hub commands: /brightside and the blank /brightside-v0 (Story 16.2)', () => {
  assert.deepEqual(manifest.features.slash_commands.map((c) => c.command), ['/brightside-v0', '/brightside']);
  const v0 = manifest.features.slash_commands.find((c) => c.command === '/brightside-v0');
  assert.deepEqual(v0, { command: '/brightside-v0', description: 'Open the Brightside v0 (blank) menu', should_escape: false });
});

test('the v0 hub sees nothing, has no usage hint, and its welcome says it is a blank bot', () => {
  const hub = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'hubs/brightside-v0.json'), 'utf8'));
  assert.equal(hub.command, '/brightside-v0');
  assert.deepEqual(hub.sees, []);
  assert.equal(hub.usage_hint, undefined);
  assert.match(hub.welcome, /no business context and no data yet/);
  assert.match(hub.welcome, /An admin can add context/);
});

test('bot scopes are exactly the runtime\'s allowed set: the seven Slack shows, files:read included', () => {
  assert.deepEqual([...manifest.oauth_config.scopes.bot].sort(), [...BOT_SCOPES].sort());
  assert.deepEqual([...manifest.oauth_config.scopes.bot].sort(), [
    'chat:write', 'commands', 'files:read', 'files:write', 'im:history', 'im:write', 'users:read',
  ]);
});

test('bot events are exactly the runtime\'s', () => {
  assert.deepEqual([...manifest.settings.event_subscriptions.bot_events].sort(), [...BOT_EVENTS].sort());
});

test('Socket Mode is on, so no request URL or signing secret is needed', () => {
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.equal(manifest.settings.event_subscriptions.request_url, undefined);
  assert.equal(manifest.settings.interactivity.request_url, undefined);
});

test('it is the dev bot, separate from the Orchestrator webhook app', () => {
  assert.equal(manifest.display_information.name, 'Brightside Bot (dev)');
  assert.equal(manifest.features.bot_user.display_name, 'Brightside Bot (dev)');
  assert.doesNotMatch(JSON.stringify(manifest), /Orchestrator|incoming-webhook/);
});
