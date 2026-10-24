'use strict';

// kit/runtime/app: boot checks, the startup line, the DM greeting. Uses the
// fake Slack App (no network) and a fixture profile; the Keychain is off
// (APLABS_NO_KEYCHAIN=1) and never read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main } = require('../../kit/runtime/app');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const ROOT = path.join(__dirname, '../..');
const PROFILE = path.join(__dirname, '../fixtures/profiles/minimal.yml');
// Fake values, shaped like the real ones; nothing here is a credential.
const BOT = 'xoxb-000-111-faketokenvalue';
const APP = 'xapp-1-A000-222-fakeappvalue';

function env(extra = {}) {
  return { APLABS_NO_KEYCHAIN: '1', SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP, APLABS_PROFILE: PROFILE, ...extra };
}

async function boot(e, deps = {}) {
  const lines = [];
  const noKeychain = () => assert.fail('the Keychain must not be read');
  const res = await main({
    env: e,
    cwd: os.tmpdir(),
    deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: noKeychain, ...deps },
  });
  const entries = lines.map((l) => JSON.parse(l));
  return { ...res, lines, entries, text: lines.join('\n') };
}

test('starts in Socket Mode with both tokens, no signing secret, and the redacting logger', async () => {
  const { code, app } = await boot(env());
  assert.equal(code, 0);
  assert.equal(app.started, true);
  assert.equal(app.options.socketMode, true);
  assert.equal(app.options.token, BOT);
  assert.equal(app.options.appToken, APP);
  assert.equal(app.options.signingSecret, undefined);
  assert.equal(typeof app.options.logger.info, 'function');
});

test('logs one startup line naming the client, the profile path and "single instance"', async () => {
  const { entries, text } = await boot(env());
  assert.equal(entries.length, 1);
  const [line] = entries;
  assert.equal(line.level, 'info');
  assert.equal(line.client, 'Tiny');
  assert.equal(line.profile, PROFILE);
  assert.match(line.msg, /single instance/);
  assert.ok(!text.includes(BOT) && !text.includes(APP));
});

test('a direct message gets a short greeting in the same DM', async () => {
  const { app } = await boot(env());
  await app.dispatchMessage({ channel_type: 'im', channel: 'D123', user: 'U123', text: 'hi' });
  assert.equal(app.said.length, 1);
  assert.equal(app.said[0].channel, 'D123');
  assert.match(app.said[0].text, /Tiny bot/);
  assert.match(app.said[0].text, /<@U123>/);
});

test('channel messages, edits and bot messages get no greeting', async () => {
  const { app } = await boot(env());
  await app.dispatchMessage({ channel_type: 'channel', channel: 'C1', user: 'U1', text: 'hi' });
  await app.dispatchMessage({ channel_type: 'im', channel: 'D1', user: 'U1', subtype: 'message_changed' });
  await app.dispatchMessage({ channel_type: 'im', channel: 'D1', bot_id: 'B1', text: 'hi' });
  assert.deepEqual(app.said, []);
});

test('a greeting that fails sends the person the plain error message', async () => {
  const { app, lines } = await boot(env());
  // say throws once (the greeting), then succeeds (the error reply).
  let first = true;
  const said = [];
  const say = async (arg) => {
    if (first) { first = false; throw new Error('chat.postMessage failed'); }
    said.push(arg.text);
  };
  const message = { channel_type: 'im', channel: 'D9', user: 'U9', text: 'hi' };
  for (const fn of app.messageListeners) await fn({ message, say, client: app.client });
  assert.equal(said.length, 1);
  assert.match(said[0], /something went wrong/);
  assert.match(lines.at(-1), /handler failed/);
});

test('missing tokens and profile: refuses, lists each variable by name', async () => {
  const { code, app, entries } = await boot({ APLABS_NO_KEYCHAIN: '1' });
  assert.equal(code, 1);
  assert.equal(app, undefined);
  const refusal = entries.find((e) => e.msg === 'refusing to start');
  const problems = refusal.problems.join('\n');
  assert.match(problems, /SLACK_BOT_TOKEN is not set/);
  assert.match(problems, /SLACK_APP_TOKEN is not set/);
  assert.match(problems, /APLABS_PROFILE is not set/);
});

test('a token with the wrong shape is refused by name, and its value never appears', async () => {
  const wrong = 'not-a-real-token-value-5555';
  const { code, text } = await boot(env({ SLACK_APP_TOKEN: wrong }));
  assert.equal(code, 1);
  assert.match(text, /SLACK_APP_TOKEN does not look like the app-level token/);
  assert.ok(!text.includes(wrong));
  assert.ok(!text.includes(BOT));
});

test('a relative APLABS_PROFILE is refused', async () => {
  const { code, text } = await boot(env({ APLABS_PROFILE: 'profiles/x.yml' }));
  assert.equal(code, 1);
  assert.match(text, /APLABS_PROFILE must be an absolute path/);
});

test('an invalid profile refuses to start and lists its validation errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-app-'));
  const bad = path.join(dir, 'profile.yml');
  fs.writeFileSync(bad, 'schema_version: 1\nclient: { id: tiny }\nusers: []\nsurprise: true\n');
  try {
    const { code, text } = await boot(env({ APLABS_PROFILE: bad }));
    assert.equal(code, 1);
    assert.match(text, /refusing to start/);
    assert.match(text, /unknown key \\"surprise\\"/);
    assert.match(text, /name/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed Slack connection exits 1 and the error is redacted', async () => {
  class FailingApp extends FakeSlackApp {
    async start() { throw new Error(`invalid_auth for ${BOT}`); }
  }
  const { code, text } = await boot(env(), { App: FailingApp });
  assert.equal(code, 1);
  assert.match(text, /could not connect to Slack/);
  assert.ok(!text.includes(BOT));
});

test('the real entry point exits non-zero naming the missing variables, with no output to stdout', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'kit/runtime/app')], {
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, APLABS_NO_KEYCHAIN: '1', SLACK_APP_TOKEN: APP },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SLACK_BOT_TOKEN is not set/);
  assert.match(r.stderr, /APLABS_PROFILE is not set/);
  assert.ok(!r.stderr.includes(APP) && !r.stdout.includes(APP));
  assert.equal(r.stdout, '');
});
