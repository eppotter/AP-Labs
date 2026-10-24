'use strict';

// Brightside's /brightside hub and its hello-world module, end to end through
// the engine with the fake Slack client. An example test (architecture
// carve-out): it reads Brightside's profile and app dir, and is deleted with
// the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');

const ROOT = path.join(__dirname, '../../..');

async function boot() {
  const lines = [];
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      APLABS_PROFILE: path.join(ROOT, 'profiles/brightside/profile.yml'),
      APLABS_APP_DIR: path.join(ROOT, 'examples/brightside/app'),
    },
    cwd: os.tmpdir(),
    deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  return res.app;
}

test('/brightside shows a private menu with the hello-world entry', async () => {
  const app = await boot();
  await app.dispatchCommand('/brightside', { user_id: 'U1' });
  const [menu] = app.responded;
  assert.equal(menu.response_type, 'ephemeral');
  const entries = menu.blocks.filter((b) => b.accessory);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].accessory.action_id, 'hello-world:open');
  assert.match(entries[0].text.text, /\*Say hello\*\nCheck the bot knows who you are/);
});

test('Say hello replies privately with the person\'s name and the client\'s name', async () => {
  const app = await boot();
  app.users.U1 = { real_name: 'Dana Reyes', profile: { display_name: 'Dana', real_name: 'Dana Reyes' } };
  await app.dispatchAction('hello-world:open', { user: { id: 'U1', name: 'dana' } });
  assert.equal(app.acks, 1);
  assert.equal(app.responded.length, 1);
  const [reply] = app.responded;
  assert.equal(reply.response_type, 'ephemeral');
  assert.match(reply.text, /^Hello Dana!/);
  assert.match(reply.text, /Brightside Home Cleaning bot/);
});
