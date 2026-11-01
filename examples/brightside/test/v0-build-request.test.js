'use strict';

// Brightside v0's Request a tool entry (plan brightside-v0, Story 16.6), end
// to end through the booted engine with the fake Slack client. An example
// test (architecture carve-out): it reads Brightside's app dir and the demo
// profile fixture (its fake channel id; never profiles/brightside/), and is
// deleted with the example in a fork. The AI is off (no key), so the preview
// shows the person's own words, not summarised. Nothing reaches the real
// Slack: the fake records the post.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const br = require('../../../kit/runtime/archetypes/build-request');

const ROOT = path.join(__dirname, '../../..');
const PROFILE = path.join(__dirname, 'fixtures/demo-profile.yml');
const ADMIN = { id: 'U0FIXTUREELY', name: 'ely' }; // Ely, the fixture's admin
const CHANNEL = 'C0FIXTUREREQ'; // the fixture's build-request channel

// The fake Slack app, a member of the fixture's build-request channel.
class MemberApp extends FakeSlackApp {
  constructor(options) {
    super({ ...options, views: true, channels: [CHANNEL] });
  }
}

async function boot(t) {
  const lines = [];
  const varDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-v0br-var-')));
  t.after(() => fs.rmSync(varDir, { recursive: true, force: true }));
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      APLABS_PROFILE: PROFILE,
      APLABS_APP_DIR: path.join(ROOT, 'examples/brightside/app'),
      APLABS_DATA_PATH: path.join(os.tmpdir(), 'aplabs-no-such-v0br-data.duckdb'),
      APLABS_VAR_DIR: varDir,
    },
    cwd: os.tmpdir(),
    deps: { App: MemberApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => {
    res.engineJobs.stop();
    res.jobs.stop();
    res.data.close();
  });
  return res.app;
}

test('/brightside-v0: Request a tool opens its form, previews the person\'s own words (AI off), and Post puts one message in the channel naming them', async (t) => {
  const app = await boot(t);
  const menu = { id: 'VMENU', type: 'modal', private_metadata: 'brightside-v0', hash: 'h0' };
  await app.dispatchAction('v0-build-request:open', { user: ADMIN, view: menu });
  const form = app.views.filter((v) => v.method === 'push').at(-1).args.view;
  assert.equal(form.callback_id, br.FORM_CALLBACK);
  const view = {
    ...form,
    id: 'VFORM',
    state: { values: { [br.NEED_BLOCK]: { [br.NEED_ACTION]: { type: 'plain_text_input', value: 'A list of clients who skipped two visits.' } } } },
  };
  await app.dispatchView(br.FORM_CALLBACK, { user: ADMIN, view });
  const preview = app.views.filter((v) => v.method === 'update').at(-1).args.view;
  const shown = preview.blocks.map((b) => (b.text && b.text.text) || '').join('\n');
  assert.match(shown, /not summarised/);
  assert.match(shown, /From <@U0FIXTUREELY> on the Brightside v0 hub/);
  const post = preview.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === br.ACTIONS.post);
  await app.dispatchAction(br.ACTIONS.post, { user: ADMIN, value: post.value, view: { id: 'VFORM', type: 'modal', private_metadata: 'brightside-v0' } });
  assert.equal(app.posted.length, 1);
  assert.equal(app.posted[0].channel, CHANNEL);
  assert.match(app.posted[0].text, /> A list of clients who skipped two visits\./);
});
