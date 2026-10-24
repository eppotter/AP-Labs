'use strict';

// Story 6.5: a builder adds a module by copying kit/templates/module into the
// app dir and filling in its manifest. These tests do that in a throwaway fork
// (test/fixtures/temp-fork.js) and check that the module shows on its hub's
// menu with no engine file changed, that a bad manifest fails naming the module
// and the field, and that the template's own test passes where it lands.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main } = require('../../kit/runtime/app');
const { loadRegistry } = require('../../kit/runtime/registry');
const { loadProfile } = require('../../kit/lib/profile');
const { FakeSlackApp } = require('../fixtures/fake-slack');
const { makeFork, addModule, engineDigest, FILLED, TEMPLATE } = require('../fixtures/temp-fork');

// Fake values, shaped like the real ones; nothing here is a credential.
const TOKENS = { SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue', SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue' };

function fork(t) {
  const f = makeFork();
  t.after(f.cleanup);
  return f;
}

function problemsFor(f) {
  const profile = loadProfile(path.join(f.root, '.aplabs/profile.yml'));
  return loadRegistry({ appDir: f.appDir, profile }).problems;
}

// Boots the real runtime in the fork: profile found from cwd (.aplabs/), app
// dir from APLABS_APP_DIR, fake Slack, no data file.
async function boot(t, f) {
  const lines = [];
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      ...TOKENS,
      APLABS_APP_DIR: f.appDir,
      APLABS_DATA_PATH: path.join(f.root, 'no-data', 'stub.duckdb'),
    },
    cwd: f.root,
    deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  if (res.data) t.after(() => res.data.close());
  return { ...res, lines };
}

const entryIds = (menu) => menu.blocks.filter((b) => b.accessory && /^entry:/.test(b.block_id)).map((b) => b.accessory.action_id);

test('the template is exactly a manifest, a handler and a test', () => {
  assert.deepEqual(fs.readdirSync(TEMPLATE).sort(), ['handler.js', 'handler.test.js', 'manifest.json']);
});

test('a filled-in template shows on its hub, opens, and leaves every engine file untouched', async (t) => {
  const before = engineDigest();
  assert.ok(Object.keys(before).length > 50, 'the engine set is listed');
  const f = fork(t);
  addModule(f.appDir);
  assert.deepEqual(problemsFor(f), []);

  const { code, app, lines } = await boot(t, f);
  assert.equal(code, 0, lines.join('\n'));
  await app.dispatchCommand('/ops', { user_id: 'UBO' });
  assert.deepEqual(entryIds(app.responded[0]), [`${FILLED.id}:open`]);
  assert.match(JSON.stringify(app.responded[0].blocks), new RegExp(FILLED.label));

  app.users.UBO = { real_name: 'Bo', profile: { display_name: 'Bo', real_name: 'Bo' } };
  await app.dispatchAction(`${FILLED.id}:open`, { user: { id: 'UBO', name: 'bo' } });
  const reply = app.responded.at(-1);
  assert.equal(reply.response_type, 'ephemeral');
  assert.match(reply.text, /^Hi Bo, this is a new Stub Co tool/);

  assert.deepEqual(engineDigest(), before);
});

test('the template\'s resource is gated: a person without the grant does not see it', async (t) => {
  const f = fork(t);
  addModule(f.appDir);
  const { code, app, lines } = await boot(t, f);
  assert.equal(code, 0, lines.join('\n'));
  await app.dispatchCommand('/ops', { user_id: 'UCY' });
  assert.deepEqual(entryIds(app.responded[0]), []);
});

test('the template\'s own test passes once copied into a fork', (t) => {
  const f = fork(t);
  const dir = addModule(f.appDir);
  const r = spawnSync(process.execPath, ['--test', path.join(dir, 'handler.test.js')], {
    cwd: f.root, env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass 1\n/);
});

test('a template copied in without filling it in fails naming its hub and resource', (t) => {
  const f = fork(t);
  addModule(f.appDir, { folder: 'my-module', fields: {} });
  const problems = problemsFor(f);
  assert.ok(problems.some((p) => /^modules\/my-module\/manifest\.json: field "hub"/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /^modules\/my-module\/manifest\.json: field "resource"/.test(p)), problems.join('\n'));
});

for (const [what, fields, field] of [
  ['a missing field', { ...FILLED, label: undefined }, 'label'],
  ['an unknown archetype', { ...FILLED, archetype: 'magic' }, 'archetype'],
  ['an unknown hub', { ...FILLED, hub: 'nowhere' }, 'hub'],
]) {
  test(`${what} fails naming the module and the field`, (t) => {
    const f = fork(t);
    addModule(f.appDir, { fields });
    const problems = problemsFor(f);
    assert.ok(problems.length > 0);
    for (const p of problems) assert.match(p, /^modules\/weekly-report\/manifest\.json: /);
    assert.ok(problems.some((p) => p.includes(`field "${field}"`)), problems.join('\n'));
  });
}

test('a duplicate id fails naming the second module and the id field', (t) => {
  const f = fork(t);
  addModule(f.appDir);
  addModule(f.appDir, { folder: 'weekly-report-copy' });
  assert.deepEqual(problemsFor(f), [
    'modules/weekly-report-copy/manifest.json: field "id" must equal the folder name ("weekly-report-copy")',
  ]);
});

test('app startup refuses a bad manifest, naming the module and the field', async (t) => {
  const f = fork(t);
  addModule(f.appDir, { fields: { ...FILLED, archetype: 'magic' } });
  const { code, lines } = await boot(t, f);
  assert.equal(code, 1);
  const { problems } = JSON.parse(lines.find((l) => l.includes('refusing to start')));
  assert.ok(problems.some((p) => p.startsWith('app: modules/weekly-report/manifest.json: field "archetype"')), problems.join('\n'));
});
