'use strict';

// Brightside's Slack app manifest matches the runtime's allowed scopes and
// events (AD-5), runs in Socket Mode, and is exactly what `npm run
// slack:manifest` generates from the hub files. An example test (architecture
// carve-out): deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BOT_SCOPES, BOT_EVENTS } = require('../../../kit/runtime/slack/scopes');
const { run } = require('../../../kit/runtime/slack/manifest');

const APP_DIR = path.join(__dirname, '../app');
const manifest = require(path.join(APP_DIR, 'slack-manifest.json'));

test('the committed manifest is what npm run slack:manifest generates from the hub files', () => {
  const r = run({ argv: ['--check'], env: { APLABS_APP_DIR: APP_DIR } });
  assert.equal(r.code, 0, `${r.out}\nRun: APLABS_APP_DIR=$PWD/examples/brightside/app npm run slack:manifest`);
});

test('the slash commands are the hub commands', () => {
  assert.deepEqual(manifest.features.slash_commands.map((c) => c.command), ['/brightside']);
});

test('bot scopes are exactly the runtime\'s allowed set', () => {
  assert.deepEqual([...manifest.oauth_config.scopes.bot].sort(), [...BOT_SCOPES].sort());
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
