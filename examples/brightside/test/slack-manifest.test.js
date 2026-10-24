'use strict';

// Brightside's Slack app manifest matches the runtime's allowed scopes and
// events (AD-5) and runs in Socket Mode. An example test (architecture
// carve-out): deleted with the example in a fork. Story 6.2's generator will
// build this file; until then this test keeps it honest.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BOT_SCOPES, BOT_EVENTS } = require('../../../kit/runtime/slack/scopes');

const manifest = require(path.join(__dirname, '../app/slack-manifest.json'));

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
