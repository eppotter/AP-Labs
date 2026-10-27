'use strict';

// Brightside's Dataset entry, end to end through the engine with the fake
// Slack client and the real Brightside fixture, built into a temporary
// directory. An example test (architecture carve-out): it reads Brightside's
// profile, app dir and fixture, and is deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { build } = require('../../../kit/fixture/build');
const { DataUnavailable } = require('../../../kit/runtime/errors');
const { messageFor } = require('../../../kit/runtime/messages');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');

// The reply a person sees when the data is unavailable.
const DATA_UNAVAILABLE = messageFor(new DataUnavailable('test'));

const ROOT = path.join(__dirname, '../../..');

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-brightside-data-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function boot(t, dataPath) {
  const lines = [];
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      APLABS_PROFILE: path.join(ROOT, 'profiles/brightside/profile.yml'),
      APLABS_APP_DIR: path.join(ROOT, 'examples/brightside/app'),
      APLABS_DATA_PATH: dataPath,
    },
    cwd: os.tmpdir(),
    deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => res.data.close());
  return { app: res.app, entries: lines.map((l) => JSON.parse(l)) };
}

test('Dataset replies privately with the local fixture, its version, as-of date and every table\'s row count', async (t) => {
  const file = path.join(tmpDir(t), 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: file });
  const { app, entries } = await boot(t, file);
  assert.equal(entries.at(-1).data, 'available');
  await app.dispatchAction('dataset:open', { user: { id: 'U1', name: 'dana' } });
  assert.equal(app.responded.length, 1);
  const [reply] = app.responded;
  assert.equal(reply.response_type, 'ephemeral');
  const lines = reply.text.split('\n');
  assert.deepEqual(lines.slice(0, 6), [
    '*Dataset*',
    'Source: local fixture (brightside.duckdb)',
    'Fixture version: 5',
    'As of: 2026-09-30',
    'Published: local build',
    'Tables (19):',
  ]);
  assert.ok(lines.includes('• visits: 40,895'));
  assert.ok(lines.includes('• zones: 5'));
  assert.ok(lines.includes('• timesheets: 115,302'));
  assert.ok(lines.includes('• scheduled_visits: 1,720'));
  assert.ok(lines.includes('• service_rules: 781'));
  assert.ok(lines.includes('• staff_absences: 5'));
});

test('with no data file, the app still starts and Dataset says plainly the data is unavailable', async (t) => {
  const { app, entries } = await boot(t, path.join(tmpDir(t), 'brightside.duckdb'));
  assert.equal(entries[0].msg, 'data unavailable; starting anyway');
  await app.dispatchAction('dataset:open', { user: { id: 'U1', name: 'dana' } });
  assert.deepEqual(app.responded.map((r) => r.text), [DATA_UNAVAILABLE]);
  // The rest of the hub still works.
  await app.dispatchAction('hello-world:open', { user: { id: 'U1', name: 'dana' } });
  assert.match(app.responded[1].text, /^Hello /);
});
