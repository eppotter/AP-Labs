'use strict';

// Brightside's dev-only map check (Story 15.1), end to end through the engine
// with the fake Slack client: the module shows the fixed synthetic test
// pattern in its own view as a private file, the sweep runs although the
// profile's jobs are off, and the file goes on view_closed. An example test
// (architecture carve-out): it reads Brightside's profile and app dir, and
// is deleted with the example in a fork. Story 15.5 removes the module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');

const ROOT = path.join(__dirname, '../../..');
const MODULE = path.join(ROOT, 'examples/brightside/app/modules/map-check');

async function boot(t, extraEnv = {}) {
  const lines = [];
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      APLABS_PROFILE: path.join(ROOT, 'profiles/brightside/profile.yml'),
      APLABS_APP_DIR: path.join(ROOT, 'examples/brightside/app'),
      APLABS_DATA_PATH: path.join(os.tmpdir(), 'aplabs-no-such-dir', 'brightside.duckdb'),
      ...extraEnv,
    },
    cwd: os.tmpdir(),
    deps: {
      App: class extends FakeSlackApp { constructor(o) { super({ ...o, views: true }); } },
      write: (line) => lines.push(line),
      readKeychain: () => assert.fail('no Keychain'),
      timers: { set: () => ({}), clear: () => {} },
    },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => {
    res.engineJobs.stop();
    res.data.close();
  });
  const entries = lines.map((l) => JSON.parse(l));
  return { ...res, started: entries.find((e) => /bot started/.test(e.msg)) };
}

test('the map-check manifest is dev-only and its picture is the fixed synthetic test pattern', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(MODULE, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.environments, ['dev']);
  assert.equal(manifest.archetype, 'handler');
  const png = fs.readFileSync(path.join(MODULE, 'test-pattern.png'));
  assert.ok(png.equals(fs.readFileSync(path.join(ROOT, 'test/fixtures/routing-map/test-pattern.png'))));
});

test('in dev, Open on Map check shows the test pattern in its view from a private file; view_closed deletes it; the sweep runs with jobs off', async (t) => {
  const { app, started } = await boot(t);
  assert.equal(started.jobs, 'off (profile)');
  assert.deepEqual(started.engine_jobs, ['sweep-map-files']);
  await app.dispatchAction('map-check:open', { view: { id: 'VMENU', type: 'modal', private_metadata: 'brightside' } });
  const update = app.views.find((v) => v.method === 'update').args;
  const img = update.view.blocks.find((b) => b.type === 'image');
  assert.deepEqual(img, { type: 'image', slack_file: { id: 'F1' }, alt_text: 'Route map: Test pattern, no crew, 0 stops' });
  assert.equal(update.view.notify_on_close, true);
  assert.equal(update.view.close.text, 'Back');
  assert.equal(app.uploads.length, 1);
  assert.ok(app.uploads[0].file.equals(fs.readFileSync(path.join(MODULE, 'test-pattern.png'))));
  assert.ok(!('channel_id' in app.uploads[0]));
  await app.dispatchViewClosed('hub:map', { user: { id: 'U1' }, view: { id: update.view_id } });
  assert.deepEqual(app.deleted, ['F1']);
});

test('in prod, the map check is hidden and no sweep runs', async (t) => {
  const { app, started } = await boot(t, { APLABS_ENV: 'prod' });
  assert.deepEqual(started.engine_jobs, []);
  await app.dispatchAction('map-check:open', { view: { id: 'VMENU', type: 'modal', private_metadata: 'brightside' } });
  assert.deepEqual(app.uploads, []);
});
