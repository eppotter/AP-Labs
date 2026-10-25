'use strict';

// Brightside's Win-back list (Story 9.3): the first scoped-pull module. Its
// manifest declares three bounded inputs and its SQL is a fixed template in
// which only those inputs bind. Checked here: the declarations load, the SQL
// names exactly the declared inputs and passes the guardrail, it binds and
// runs on a temporary build of the fixture (38 North candidates over 90 days,
// the known truth winback-north-90d), and the typed form runs end to end
// through the engine with the fake Slack client. Story 9.5: Confirm returns
// the real list from a temporary build of the fixture (North over 90 days:
// the 38 known candidates), summarised in the view with the CSV in the
// admin's DM, and the AI service (a stand-in client) is never called. Story
// 9.4: a typed request fills the form from a stand-in AI reply, and the rows
// never reach the AI.
//
// An example test (architecture carve-out): it reads Brightside's app dir and
// fixture data, and is deleted with the example in a fork. Its profile and
// Slack ids come from a test fixture (fixtures/win-back-profile.yml), never
// from profiles/brightside/.

const test = require('node:test');
const { before, after } = require('node:test');
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
const PROFILE_PATH = path.join(__dirname, 'fixtures/win-back-profile.yml');
const APP_DIR = path.join(ROOT, 'examples/brightside/app');
const profile = loadProfile(PROFILE_PATH);
const { registry, problems } = loadRegistry({ appDir: APP_DIR, profile });
const winBack = registry && registry.module('win-back');
const declared = winBack ? winBack.parameters.map((p) => p.name) : [];

// One temporary build of the fixture, shared by the tests in this file.
let tmp;
let FIXTURE;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-win-back-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The fixture's admin (WIN_BACK through the admin role) and a member without it.
const ADMIN = profile.users.find((u) => u.role === 'admin').identities.slack;
const MEMBER = profile.users.find((u) => u.role === 'member').identities.slack;

test('Win-back loads as a scoped pull with three bounded inputs and its SQL', () => {
  assert.deepEqual(problems, []);
  assert.equal(winBack.archetype, 'scoped-pull');
  assert.equal(winBack.resource, 'WIN_BACK');
  assert.deepEqual(declared, ['zone', 'lapsed_days', 'limit']);
  assert.deepEqual(winBack.parameters.map((p) => [p.name, p.enum || [p.min, p.max], p.default]), [
    ['zone', ['north', 'south', 'east', 'west', 'central'], undefined],
    ['lapsed_days', [1, 365], 90],
    ['limit', [1, 500], 50],
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

test('on the fixture, only the declared inputs bind and North over 90 days gives the 38 known candidates', async (t) => {
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  const all = await data.run(winBack.sql, { zone: 'north', lapsed_days: 90, limit: 500 }, { declared });
  assert.equal(all.length, 38);
  assert.deepEqual(Object.keys(all[0]), ['client_id', 'first_name', 'last_name', 'email', 'lapsed_on']);
  assert.ok(all.every((r) => r.email.endsWith('.invalid')));
  const sorted = [...all].sort((a, b) => (a.lapsed_on === b.lapsed_on ? String(a.client_id).localeCompare(String(b.client_id), 'en', { numeric: true }) : (a.lapsed_on < b.lapsed_on ? 1 : -1)));
  assert.deepEqual(all.map((r) => r.client_id), sorted.map((r) => r.client_id));
  // The default limit (50) shows all 38.
  const byDefault = await data.run(winBack.sql, { zone: 'north', lapsed_days: 90, limit: 50 }, { declared });
  assert.deepEqual(byDefault, all);
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

// A stand-in AI client that records every call (none is expected).
function spyAi() {
  const calls = [];
  return { calls, client: { messages: { create: async (params) => { calls.push(params); throw new Error('no AI call expected'); } } } };
}

// A stand-in AI client that fills the form with input (Story 9.4), recording
// every request it gets.
function fillingAi(input) {
  const calls = [];
  const reply = { content: [{ type: 'tool_use', id: 'toolu_1', name: 'fill_parameters', input }], stop_reason: 'tool_use', usage: { input_tokens: 400, output_tokens: 30 } };
  return { calls, client: { messages: { create: async (params) => { calls.push(params); return reply; } } } };
}

// Boots the app on the fixture build (or a missing file with noData), with a
// fake AI key so the AI service is on and its stand-in client is watched.
async function boot(t, { noData = false, ai = spyAi() } = {}) {
  const lines = [];
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      ANTHROPIC_API_KEY: 'sk-ant-api00-fake-win-back-key-value',
      APLABS_PROFILE: PROFILE_PATH,
      APLABS_APP_DIR: APP_DIR,
      APLABS_DATA_PATH: noData ? path.join(os.tmpdir(), 'aplabs-no-data', 'none.duckdb') : FIXTURE,
    },
    cwd: os.tmpdir(),
    deps: {
      App: ViewsSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain'),
      llm: { createClient: () => ai.client },
    },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => res.data.close());
  res.app.ai = ai;
  res.app.llmStatus = res.llm.status();
  return res.app;
}

const MENU = { id: 'VMENU', type: 'modal', private_metadata: 'brightside', title: { type: 'plain_text', text: 'Brightside' } };
const last = (app) => app.views.at(-1).args.view;
const actionsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);

test('the Win-back list end to end: the admin checks North with the defaults, confirms once, and gets the 38 candidates privately', async (t) => {
  const app = await boot(t);
  await app.dispatchCommand('/brightside', { user_id: ADMIN });
  const menu = app.views[0].args.view;
  assert.ok(menu.blocks.some((b) => b.accessory && b.accessory.action_id === 'win-back:open'));

  await app.dispatchAction('win-back:open', { user: { id: ADMIN }, view: MENU });
  const form = last(app);
  const formId = `V${app.viewSeq}`;
  assert.equal(form.title.text, 'Win-back list');
  assert.equal(form.submit.text, 'Check values');
  assert.deepEqual(form.blocks.filter((b) => b.type === 'input' && b.block_id.startsWith('sp-input:')).map((b) => b.label.text), ['Zone', 'Lapsed within (days)', 'How many clients']);

  const pick = { values: { 'sp-input:zone': { value: { type: 'static_select', selected_option: { value: 'north' } } } } };
  await app.dispatchView('scoped-pull:form', {
    user: { id: ADMIN },
    view: { id: formId, hash: `h${app.viewSeq}`, title: form.title, private_metadata: form.private_metadata, state: pick },
  });
  const ack = app.viewAcks.at(-1);
  assert.equal(ack.response_action, 'update');
  const confirm = ack.view;
  assert.deepEqual(confirm.blocks.filter((b) => b.fields).map((b) => b.fields[1].text), ['north', '90', '50']);
  const session = actionsOf(confirm)[0].value;

  const shown = (hash) => ({ id: formId, hash, title: confirm.title, private_metadata: confirm.private_metadata, state: { values: {} } });
  await app.dispatchAction('scoped-pull:confirm', { user: { id: ADMIN }, view: shown('hs1'), value: session });
  // The view: the count (the known truth), the values, the first 10 rows.
  const result = last(app);
  assert.equal(result.blocks[0].text.text, '*Win-back list: 38 rows.*');
  assert.deepEqual(result.blocks.filter((b) => b.fields).map((b) => b.fields[1].text), ['north', '90', '50']);
  const table = result.blocks.find((b) => b.text && b.text.text.startsWith('*The first 10:*')).text.text;
  assert.match(table.split('\n')[2], /^client_id +first_name +last_name +email +lapsed_on$/);
  assert.equal(table.split('\n').length, 2 + 1 + 10 + 1);
  assert.match(result.blocks.at(-1).elements[0].text, /^The full list \(38 rows\) is a CSV in your DM with me\. <https:\/\/fake\.slack\.test\/files\/F1\|Open the CSV>$/);
  // The CSV: all 38, in the admin's DM, the same rows the runner gives.
  assert.deepEqual(app.dms, [{ user: ADMIN, channel: `D${ADMIN.slice(1)}` }]);
  assert.equal(app.uploads.length, 1);
  assert.equal(app.uploads[0].channel_id, `D${ADMIN.slice(1)}`);
  const lines = app.uploads[0].content.replace(/^\ufeff/, '').trimEnd().split('\r\n');
  assert.equal(lines[0], 'client_id,first_name,last_name,email,lapsed_on');
  assert.equal(lines.length, 1 + 38);
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  const expected = await data.run(winBack.sql, { zone: 'north', lapsed_days: 90, limit: 50 }, { declared });
  assert.deepEqual(lines.slice(1), expected.map((r) => [r.client_id, r.first_name, r.last_name, r.email, r.lapsed_on].join(',')));
  assert.deepEqual(app.posted, []);
  // A replay runs nothing more.
  await app.dispatchAction('scoped-pull:confirm', { user: { id: ADMIN }, view: shown(`h${app.viewSeq}`), value: session });
  assert.match(last(app).blocks[0].text.text, /already confirmed/);
  assert.equal(app.uploads.length, 1);
  assert.deepEqual(app.views.map((v) => v.method), ['open', 'push', 'update', 'update', 'update']);
  // The AI service was on, and the rows never reached it.
  assert.equal(app.llmStatus.on, true);
  assert.deepEqual(app.ai.calls, []);
});

test('with the data unavailable, Confirm shows the standard message in the view and sends nothing', async (t) => {
  const app = await boot(t, { noData: true });
  await app.dispatchAction('win-back:open', { user: { id: ADMIN }, view: MENU });
  const form = last(app);
  const pick = { values: { 'sp-input:zone': { value: { type: 'static_select', selected_option: { value: 'south' } } } } };
  await app.dispatchView('scoped-pull:form', {
    user: { id: ADMIN }, view: { id: `V${app.viewSeq}`, hash: 'h', title: form.title, private_metadata: form.private_metadata, state: pick },
  });
  const confirm = app.viewAcks.at(-1).view;
  const session = actionsOf(confirm)[0].value;
  await app.dispatchAction('scoped-pull:confirm', { user: { id: ADMIN }, view: { id: `V${app.viewSeq}`, hash: 'hs', title: confirm.title, private_metadata: confirm.private_metadata }, value: session });
  assert.match(last(app).blocks[0].text.text, /^The data isn't available right now/);
  assert.deepEqual(app.uploads, []);
});

test('a member without WIN_BACK, or someone not set up, never sees Win-back and is refused if they click it', async (t) => {
  const app = await boot(t);
  for (const who of [MEMBER, 'UNOBODY']) {
    const before = app.views.length;
    await app.dispatchCommand('/brightside', { user_id: who });
    assert.ok(!app.views[before].args.view.blocks.some((b) => b.accessory && b.accessory.action_id === 'win-back:open'));
    await app.dispatchAction('win-back:open', { user: { id: who }, view: MENU });
    assert.equal(last(app).blocks.filter((b) => b.type === 'input').length, 0);
  }
});

test('Story 9.4: "North zone, lapsed in the last 90 days, top 25" fills zone north, 90 days, limit 25 from a stand-in reply, and Confirm gives the first 25', async (t) => {
  const ai = fillingAi({ zone: 'north', lapsed_days: 90, limit: 25 });
  const app = await boot(t, { ai });
  await app.dispatchAction('win-back:open', { user: { id: ADMIN }, view: MENU });
  const form = last(app);
  const formId = `V${app.viewSeq}`;
  const read = actionsOf(form).find((b) => b.action_id === 'scoped-pull:read');
  assert.equal(read.text.text, 'Read my request');
  const request = 'North zone, lapsed in the last 90 days, top 25';
  await app.dispatchAction('scoped-pull:read', {
    user: { id: ADMIN },
    view: { id: formId, hash: `h${app.viewSeq}`, title: form.title, private_metadata: form.private_metadata, state: { values: { 'sp-request': { value: { type: 'plain_text_input', value: request } } } } },
    value: read.value,
  });
  // "Reading your request…", then the values to confirm.
  assert.equal(app.views.at(-2).args.view.blocks[0].text.text, 'Reading your request…');
  const confirm = last(app);
  assert.deepEqual(confirm.blocks.filter((b) => b.fields).map((b) => [b.fields[0].text, b.fields[1].text]), [
    ['*Zone*', 'north'], ['*Lapsed within (days)*', '90'], ['*How many clients*', '25'],
  ]);
  // One call, holding the request and the declarations only.
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].messages[0].content, `<request>\n${request}\n</request>`);
  assert.deepEqual(Object.keys(ai.calls[0].tools[0].input_schema.properties), declared);
  assert.equal(app.uploads.length, 0, 'nothing runs before Confirm');

  const session = actionsOf(confirm)[0].value;
  await app.dispatchAction('scoped-pull:confirm', {
    user: { id: ADMIN }, view: { id: formId, hash: `h${app.viewSeq}`, title: confirm.title, private_metadata: confirm.private_metadata, state: { values: {} } }, value: session,
  });
  assert.equal(last(app).blocks[0].text.text, '*Win-back list: 25 rows.*');
  assert.equal(app.uploads.length, 1);
  // The rows went to the DM, never to the AI.
  assert.equal(ai.calls.length, 1);
  const sentToAi = JSON.stringify(ai.calls);
  const rows = app.uploads[0].content.replace(/^\ufeff/, '').trimEnd().split('\r\n').slice(1);
  for (const row of rows) assert.ok(!sentToAi.includes(row.split(',')[3]), 'an email from the rows reached the AI');
});
