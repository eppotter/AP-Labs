'use strict';

// Brightside v0's Add context entry (plan brightside-v0, Story 16.5), end to
// end through the engine with the fake Slack client: boot builds the
// knowledge store in the var dir, an admin adds a typed note, and Data
// sources lists it. An example test (architecture carve-out): it reads
// Brightside's app dir and the demo profile fixture (never
// profiles/brightside/), and is deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');

const ROOT = path.join(__dirname, '../../..');
const PROFILE = path.join(__dirname, 'fixtures/demo-profile.yml');
const ELY = { id: 'U0FIXTUREELY', name: 'ely' }; // the fixture's admin

// The fake with views on, as the live app has them.
class ViewsApp extends FakeSlackApp {
  constructor(options) { super({ ...options, views: true }); }
}

async function boot(t) {
  const lines = [];
  const varDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-v0-add-var-')));
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
    deps: { App: ViewsApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => {
    res.engineJobs.stop();
    res.jobs.stop();
    res.data.close();
  });
  return { app: res.app, varDir };
}

test('/brightside-v0: Ely adds a typed note in Add context; it is stored under the var dir and Data sources lists it', async (t) => {
  const { app, varDir } = await boot(t);
  const menu = { id: 'VMENU', type: 'modal', private_metadata: 'brightside-v0', hash: 'h0' };
  await app.dispatchAction('v0-add-context:open', { user: ELY, view: menu });
  const form = app.views.at(-1).args.view;
  assert.equal(form.submit.text, 'Add');
  assert.match(JSON.stringify(form.blocks), /Everyone who can use Ask here can read this\./);
  await app.dispatchView('add-context:submit', {
    user: ELY,
    view: {
      ...form,
      id: 'VFORM',
      state: { values: { 'ac-title': { value: { value: 'Saturdays' } }, 'ac-text': { value: { value: 'We clean on Saturdays too.' } } } },
    },
  });
  const added = app.views.at(-1).args;
  assert.equal(added.view_id, 'VFORM');
  assert.equal(added.view.blocks[0].text.text, 'Added. Ask can use it now.');
  const files = fs.readdirSync(path.join(varDir, 'context', 'brightside', 'brightside-v0'));
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 1);
  await app.dispatchAction('v0-data-sources:open', { user: ELY, view: menu });
  const sources = app.views.at(-1).args.view.blocks.map((b) => b.text.text).join('\n');
  assert.match(sources, /\*Added context\*\n• Saturdays by <@U0FIXTUREELY>/);
});
