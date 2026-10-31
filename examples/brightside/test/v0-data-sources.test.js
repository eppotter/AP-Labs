'use strict';

// Brightside v0's Data sources entry (plan brightside-v0, Story 16.3), end to
// end through the engine with the fake Slack client. An example test
// (architecture carve-out): it reads Brightside's app dir and the demo
// profile fixture (never profiles/brightside/), and is deleted with the
// example in a fork. No data file is needed: the v0 hub sees
// no data, so the runner is never asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');

const ROOT = path.join(__dirname, '../../..');
const PROFILE = path.join(__dirname, 'fixtures/demo-profile.yml');
const ADMIN_SLACK = 'U0FIXTUREDANA'; // Dana, the fixture's admin

async function boot(t) {
  const lines = [];
  // An empty var dir: the added-context store reads nothing a local run left.
  const varDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-v0-var-')));
  t.after(() => fs.rmSync(varDir, { recursive: true, force: true }));
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      APLABS_PROFILE: PROFILE,
      APLABS_APP_DIR: path.join(ROOT, 'examples/brightside/app'),
      APLABS_DATA_PATH: path.join(os.tmpdir(), 'aplabs-no-such-v0-data.duckdb'),
      APLABS_VAR_DIR: varDir,
    },
    cwd: os.tmpdir(),
    deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => {
    res.engineJobs.stop();
    res.jobs.stop();
    res.data.close();
  });
  return res.app;
}

test('/brightside-v0 lists Ask (Story 16.7) and Request a tool (Story 16.6), then Add context and Data sources in the Setup group, for an admin only, and it reads "No data connected yet. No known truths or rules yet."', async (t) => {
  const app = await boot(t);
  await app.dispatchCommand('/brightside-v0', { user_id: ADMIN_SLACK });
  await app.dispatchCommand('/brightside-v0', { user_id: 'UNOBODY' });
  // The rows (block entry:<id>); the next-step line's button is checked below.
  const openIds = (m) => m.blocks.filter((b) => /^entry:/.test(b.block_id || '') && /:open$/.test(b.accessory.action_id)).map((b) => b.accessory.action_id);
  const [admin, stranger] = app.responded;
  // Tools first, then the Setup group (plan hub-status-menu, D5).
  assert.deepEqual(openIds(admin), ['v0-ask:open', 'v0-build-request:open', 'v0-add-context:open', 'v0-data-sources:open']);
  assert.ok(admin.blocks.some((b) => b.type === 'header' && /Setup · admins$/.test(b.text.text)));
  assert.deepEqual(openIds(stranger), []);
  // The blank hub's next step (plan hub-status-menu, D6): teach it the business.
  const next = admin.blocks.find((b) => b.block_id === 'next');
  assert.equal(next.text.text, '*Next:* teach it the business');
  assert.equal(next.accessory.action_id, 'v0-add-context:open');
  assert.equal(stranger.blocks.find((b) => b.block_id === 'next'), undefined);
  await app.dispatchAction('v0-data-sources:open', { user: { id: ADMIN_SLACK, name: 'dana' } });
  const reply = app.responded.at(-1);
  assert.equal(reply.response_type, 'ephemeral');
  assert.deepEqual(reply.blocks.map((b) => b.text.text), ['No data connected yet. No known truths or rules yet.', '*Added context*\nNone yet.']);
});
