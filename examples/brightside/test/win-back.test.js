'use strict';

// Brightside's Win-back list (Story 9.3): the first scoped-pull module. Its
// manifest declares three bounded inputs and its SQL is a fixed template in
// which only those inputs bind. Checked here: the declarations load, the SQL
// names exactly the declared inputs and passes the guardrail, it binds and
// runs on a temporary build of the fixture (38 North candidates over 90 days,
// the known truth winback-north-90d), and the typed form runs end to end
// through the engine with the fake Slack client. Running the list for the
// person arrives with Story 9.5.
//
// An example test (architecture carve-out): it reads Brightside's profile,
// app dir and fixture, and is deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { loadRegistry } = require('../../../kit/runtime/registry');
const { createData, QueryRefusedError } = require('../../../kit/runtime/data');
const { checkSql, forbiddenColumnsOf } = require('../../../kit/runtime/sql');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');

const ROOT = path.join(__dirname, '../../..');
const PROFILE_PATH = path.join(ROOT, 'profiles/brightside/profile.yml');
const APP_DIR = path.join(ROOT, 'examples/brightside/app');
const profile = loadProfile(PROFILE_PATH);
const { registry, problems } = loadRegistry({ appDir: APP_DIR, profile });
const winBack = registry && registry.module('win-back');
const declared = winBack ? winBack.parameters.map((p) => p.name) : [];

// Dana is Brightside's admin; her Slack id is in the profile.
const DANA = profile.users.find((u) => u.id === 'dana').identities.slack;

test('Win-back loads as a scoped pull with three bounded inputs and its SQL', () => {
  assert.deepEqual(problems, []);
  assert.equal(winBack.archetype, 'scoped-pull');
  assert.equal(winBack.resource, 'WIN_BACK');
  assert.deepEqual(declared, ['zone', 'lapsed_days', 'limit']);
  assert.deepEqual(winBack.parameters.map((p) => [p.name, p.enum || [p.min, p.max], p.default]), [
    ['zone', ['north', 'south', 'east', 'west', 'central'], undefined],
    ['lapsed_days', [1, 365], 90],
    ['limit', [1, 500], 25],
  ]);
  assert.match(winBack.sql, /^WITH meta AS/m);
});

test('the Win-back SQL is fixed: no ${, it names exactly the declared inputs, and it passes the guardrail', () => {
  assert.ok(!winBack.sql.includes('${'));
  const code = winBack.sql.replace(/--[^\n]*/g, '');
  const named = [...new Set([...code.matchAll(/\$([a-z][a-z0-9_]*)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(named, [...declared].sort());
  assert.deepEqual(checkSql(winBack.sql, { forbiddenColumns: forbiddenColumnsOf(profile) }), { ok: true });
});

test('the Win-back profile row gates it: not open to everyone', () => {
  const row = profile.resources.find((r) => r.key === 'WIN_BACK');
  assert.ok(row);
  assert.notEqual(row.open_access, true);
});

test('on the fixture, only the declared inputs bind and North over 90 days gives the 38 known candidates', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-win-back-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: file });
  const data = createData({ file, profile });
  t.after(() => data.close());
  const all = await data.run(winBack.sql, { zone: 'north', lapsed_days: 90, limit: 500 }, { declared });
  assert.equal(all.length, 38);
  assert.deepEqual(Object.keys(all[0]), ['client_id', 'first_name', 'last_name', 'email', 'lapsed_on']);
  assert.ok(all.every((r) => r.email.endsWith('.invalid')));
  const sorted = [...all].sort((a, b) => (a.lapsed_on === b.lapsed_on ? String(a.client_id).localeCompare(String(b.client_id), 'en', { numeric: true }) : (a.lapsed_on < b.lapsed_on ? 1 : -1)));
  assert.deepEqual(all.map((r) => r.client_id), sorted.map((r) => r.client_id));
  const top = await data.run(winBack.sql, { zone: 'north', lapsed_days: 90, limit: 25 }, { declared });
  assert.deepEqual(top, all.slice(0, 25));
  const shorter = await data.run(winBack.sql, { zone: 'north', lapsed_days: 30, limit: 500 }, { declared });
  assert.ok(shorter.length < all.length);
  await assert.rejects(
    data.run(winBack.sql, { zone: 'north', lapsed_days: 90, limit: 25, extra: 1 }, { declared }),
    QueryRefusedError,
  );
});

// The fake Slack app with a views client, as the runtime builds it.
class ViewsSlackApp extends FakeSlackApp {
  constructor(options) { super({ ...options, views: true }); }
}

async function boot(t) {
  const lines = [];
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      APLABS_PROFILE: PROFILE_PATH,
      APLABS_APP_DIR: APP_DIR,
      APLABS_DATA_PATH: path.join(os.tmpdir(), 'aplabs-no-data', 'none.duckdb'),
    },
    cwd: os.tmpdir(),
    deps: { App: ViewsSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => res.data.close());
  return res.app;
}

const MENU = { id: 'VMENU', type: 'modal', private_metadata: 'brightside', title: { type: 'plain_text', text: 'Brightside' } };
const last = (app) => app.views.at(-1).args.view;
const actionsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);

test('the Win-back form end to end: Dana opens it, checks North with the defaults, and confirms once', async (t) => {
  const app = await boot(t);
  await app.dispatchCommand('/brightside', { user_id: DANA });
  const menu = app.views[0].args.view;
  assert.ok(menu.blocks.some((b) => b.accessory && b.accessory.action_id === 'win-back:open'));

  await app.dispatchAction('win-back:open', { user: { id: DANA }, view: MENU });
  const form = last(app);
  assert.equal(form.title.text, 'Win-back list');
  assert.deepEqual(form.blocks.filter((b) => b.type === 'input').map((b) => b.label.text), ['Zone', 'Lapsed within (days)', 'How many clients']);
  const session = actionsOf(form)[0].value;

  const view = (state) => ({ id: `V${app.viewSeq}`, hash: `h${app.viewSeq}`, title: form.title, private_metadata: 'brightside', state });
  const pick = { values: { 'sp-input:zone': { value: { type: 'static_select', selected_option: { value: 'north' } } } } };
  await app.dispatchAction('scoped-pull:check', { user: { id: DANA }, view: view(pick), value: session });
  const confirm = last(app);
  assert.deepEqual(confirm.blocks.filter((b) => b.fields).map((b) => b.fields[1].text), ['north', '90', '25']);

  await app.dispatchAction('scoped-pull:confirm', { user: { id: DANA }, view: view({ values: {} }), value: session });
  assert.match(last(app).blocks[0].text.text, /Confirmed/);
  await app.dispatchAction('scoped-pull:confirm', { user: { id: DANA }, view: view({ values: {} }), value: session });
  assert.match(last(app).blocks[0].text.text, /already confirmed/);
  assert.deepEqual(app.views.map((v) => v.method), ['open', 'push', 'update', 'update', 'update']);
});

test('someone not set up never sees Win-back and is refused if they click it', async (t) => {
  const app = await boot(t);
  await app.dispatchCommand('/brightside', { user_id: 'UNOBODY' });
  assert.ok(!app.views[0].args.view.blocks.some((b) => b.accessory && b.accessory.action_id === 'win-back:open'));
  await app.dispatchAction('win-back:open', { user: { id: 'UNOBODY' }, view: MENU });
  assert.equal(last(app).blocks.filter((b) => b.type === 'input').length, 0);
});
