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
// never reach the AI. Story 10.1: the list is scored in the engine from five
// declared inputs and ranked best first, ties by client_id; the SQL returns
// every candidate (ORDER BY ..., client_id LIMIT 5001) and never names the
// limit, which the engine applies after scoring. North over 90 days gives the
// exact top five below, the same on every run. Story 10.2: Win-back is an
// approval-write module (the same pull, plus a push to the mock email tool);
// its resource is owner-only, so an admin without the grant doesn't see it.
// Its result carries "Push to email tool", which previews the list
// (win-back-north-<UTC run date>) with the real email connector's dry run
// over a temporary outbox, and nothing is sent until Approve (Story 10.3,
// win-back-push.test.js).
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
const { runQuery } = require('../../../kit/runtime/archetypes/scoped-pull/run');
const { checkSql, forbiddenColumnsOf } = require('../../../kit/runtime/sql');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const { checkRequest } = require('../../../test/fixtures/fake-anthropic');

const ROOT = path.join(__dirname, '../../..');
const PROFILE_PATH = path.join(__dirname, 'fixtures/win-back-profile.yml');
const APP_DIR = path.join(ROOT, 'examples/brightside/app');
const profile = loadProfile(PROFILE_PATH);
const { registry, problems } = loadRegistry({ appDir: APP_DIR, profile });
const winBack = registry && registry.module('win-back');
const declared = winBack ? winBack.parameters.map((p) => p.name) : [];
// The inputs the SQL binds: every declared one but the limit (Story 10.1).
const bound = declared.filter((n) => n !== 'limit');
const SCORE_COLUMNS = ['months_as_client', 'paid_dollars', 'days_since_visit', 'plan_price_dollars', 'price_rise'];
// North over 90 days, best first: [score, client_id, reason]. Worked out by
// hand from the pinned formula for the first (730: months 23 of 0-24, paid
// $21,093 clipped to 12,500, 79 of 0-120 days, $255 of 100-450, a rise:
// S = 1.917 + 3 - 0.658 + 0.443 + 2 = 6.701 of 8, floor -1,
// 100 x 7.701 / 9 = 86). 1351 and 1611 tie at 69; 1351 comes first by id.
const NORTH_TOP_5 = [
  [86, 730, 'Lifetime paid spend ($): 21,093; Price rise before lapse'],
  [74, 931, 'Price rise before lapse; Lifetime paid spend ($): 8,056'],
  [74, 1222, 'Lifetime paid spend ($): 10,072; Price rise before lapse'],
  [74, 1956, 'Lifetime paid spend ($): 9,850; Price rise before lapse'],
  [69, 1351, 'Price rise before lapse; Months as a client: 22'],
];
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// One temporary build of the fixture, shared by the tests in this file.
let tmp;
let FIXTURE;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-win-back-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The fixture's admin (granted WIN_BACK by name: it is owner-only) and a member without it.
const ADMIN = profile.users.find((u) => u.role === 'admin').identities.slack;
const MEMBER = profile.users.find((u) => u.role === 'member').identities.slack;

test('Win-back loads as an approval-write module with three bounded inputs, its SQL and a push to the mock email tool', () => {
  assert.deepEqual(problems, []);
  assert.equal(winBack.archetype, 'approval-write');
  // Story 10.2 (decision 3): one write, pushList, with the fields it copies,
  // what each contact holds and the list name.
  assert.deepEqual(winBack.write, {
    connector: 'email',
    operation: 'pushList',
    destination: 'email tool',
    fields: ['client_id', 'email', 'first_name'],
    send: { external_ref: 'client_id', email: 'email', first_name: 'first_name' },
    list_name: 'win-back-{zone}-{run_date}',
  });
  assert.equal(profile.resources.find((r) => r.key === 'WIN_BACK').admin_grantable, false);
  assert.equal(winBack.resource, 'WIN_BACK');
  assert.deepEqual(declared, ['zone', 'lapsed_days', 'limit']);
  assert.deepEqual(winBack.parameters.map((p) => [p.name, p.enum || [p.min, p.max], p.default]), [
    ['zone', ['north', 'south', 'east', 'west', 'central'], undefined],
    ['lapsed_days', [1, 365], 90],
    ['limit', [1, 500], 50],
  ]);
  assert.match(winBack.sql, /^WITH meta AS/m);
  // Story 10.1: scored on the five demo-flow inputs, ties by client_id, the
  // person's number kept after scoring.
  assert.equal(winBack.row_id, 'client_id');
  assert.deepEqual(winBack.scoring.inputs.map((i) => [i.name, i.label, i.weight, i.min, i.max]), [
    ['months_as_client', 'Months as a client', 2, 0, 24],
    ['paid_dollars', 'Lifetime paid spend ($)', 3, 0, 12500],
    ['days_since_visit', 'Days since last completed visit', -1, 0, 120],
    ['plan_price_dollars', 'Lapsed plan price ($)', 1, 100, 450],
    ['price_rise', 'Price rise before lapse', 2, 0, 1],
  ]);
  assert.equal(winBack.scoring.limit_parameter, 'limit');
});

test('the Win-back SQL is fixed: no ${, it names exactly the declared inputs but the limit, ends with ORDER BY ..., client_id LIMIT 5001, and passes the guardrail', () => {
  assert.ok(!winBack.sql.includes('${'));
  const code = winBack.sql.replace(/--[^\n]*/g, '');
  const named = [...new Set([...code.matchAll(/\$([a-z][a-z0-9_]*)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(named, [...bound].sort());
  assert.match(code.trimEnd(), /ORDER BY l\.lapsed_on DESC, c\.client_id\nLIMIT 5001$/);
  assert.deepEqual(checkSql(winBack.sql, { forbiddenColumns: forbiddenColumnsOf(profile) }), { ok: true });
});

test('on the fixture, only the declared inputs but the limit bind and North over 90 days gives the 38 known candidates with their scoring columns', async (t) => {
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  const all = await data.run(winBack.sql, { zone: 'north', lapsed_days: 90 }, { declared: bound });
  assert.equal(all.length, 38);
  // One row per client (the grain): 38 distinct clients.
  assert.equal(new Set(all.map((r) => r.client_id)).size, 38);
  // Whole numbers only: no floating-point dollars or months.
  for (const c of ['months_as_client', 'paid_dollars', 'days_since_visit', 'plan_price_dollars']) {
    assert.ok(all.every((r) => /^\d+$/.test(String(r[c]))), c);
  }
  assert.deepEqual(Object.keys(all[0]), ['client_id', 'first_name', 'last_name', 'email', 'lapsed_on', ...SCORE_COLUMNS]);
  assert.ok(all.every((r) => r.email.endsWith('.invalid')));
  // The SQL's own order (which rows a cap would keep): latest lapse first, then client_id.
  const sorted = [...all].sort((a, b) => (a.lapsed_on === b.lapsed_on ? a.client_id - b.client_id : (a.lapsed_on < b.lapsed_on ? 1 : -1)));
  assert.deepEqual(all.map((r) => r.client_id), sorted.map((r) => r.client_id));
  // No scoring column is ever null (a null would stop the run).
  for (const c of SCORE_COLUMNS) assert.ok(all.every((r) => r[c] !== null), c);
  // The price-rise flag agrees with the known truth winback-north-90d-price-rise (17).
  assert.equal(all.filter((r) => r.price_rise === true).length, 17);
  const shorter = await data.run(winBack.sql, { zone: 'north', lapsed_days: 30 }, { declared: bound });
  assert.ok(shorter.length < all.length);
  // The limit is never a placeholder, so binding it is refused, as is any other name.
  await assert.rejects(data.run(winBack.sql, { zone: 'north', lapsed_days: 90, limit: 25 }, { declared }), QueryRefusedError);
  await assert.rejects(
    data.run(winBack.sql, { zone: 'north', lapsed_days: 90, extra: 1 }, { declared: [...bound, 'extra'] }),
    QueryRefusedError,
  );
});

test('lifetime paid spend does not fan out: all payments up to as_of minus the per-client sums the Win-back SQL uses is 0', async (t) => {
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  // The per-client sum is the Win-back SQL's own "spend" step (payments joined
  // to invoices, one invoice per payment), taken from the module's SQL text.
  const spend = /spend AS \(\n([\s\S]*?)\n\),\nlast_visit AS/.exec(winBack.sql);
  assert.ok(spend, 'the Win-back SQL has a spend step');
  const sql = [
    "WITH meta AS (SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'),",
    `spend AS (\n${spend[1]}\n)`,
    'SELECT (SELECT SUM(pay.amount_cents) FROM payments pay CROSS JOIN meta WHERE pay.paid_on <= meta.as_of)',
    '  - (SELECT SUM(paid_cents) FROM spend) AS gap, (SELECT COUNT(*) FROM spend) AS clients',
  ].join('\n');
  const [row] = await data.run(sql, {}, { declared: [] });
  assert.equal(Number(row.gap), 0);
  assert.ok(Number(row.clients) > 0);
});

test('North over 90 days, top 25: exact scores, reasons and order for the top five, ranked from all 38 and the same on every run', async (t) => {
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  const values = { zone: 'north', lapsed_days: 90, limit: 25 };
  const first = await runQuery({ data, mod: winBack, values, log: quiet });
  assert.equal(first.kind, 'rows');
  assert.equal(first.total, 38);
  assert.equal(first.capped, false);
  assert.equal(first.rows.length, 25);
  assert.deepEqual(first.rows.slice(0, 5).map((r) => [r.score, r.client_id, r.reason]), NORTH_TOP_5);
  // Best first; equal scores by client_id.
  for (let i = 1; i < first.rows.length; i += 1) {
    const [a, b] = [first.rows[i - 1], first.rows[i]];
    assert.ok(a.score > b.score || (a.score === b.score && a.client_id < b.client_id), `rows ${i - 1} and ${i}`);
  }
  // The top 25 by score, not the 25 latest lapses.
  const all = await runQuery({ data, mod: winBack, values: { ...values, limit: 500 }, log: quiet });
  assert.equal(all.rows.length, 38);
  assert.deepEqual(all.rows.slice(0, 25), first.rows);
  const again = await runQuery({ data, mod: winBack, values, log: quiet });
  assert.deepEqual(again.rows, first.rows);
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
// every request it gets. Like the real API, it refuses a tool_choice of type
// "tool" or "any" (checkRequest).
function fillingAi(input) {
  const calls = [];
  const reply = { content: [{ type: 'tool_use', id: 'toolu_1', name: 'fill_parameters', input }], stop_reason: 'tool_use', usage: { input_tokens: 400, output_tokens: 30 } };
  return { calls, client: { messages: { create: async (params) => { calls.push(params); checkRequest(params); return reply; } } } };
}

// Boots the app on the fixture build (or a missing file with noData), with a
// fake AI key so the AI service is on and its stand-in client is watched.
// The mock email tool's outbox goes under a temporary APLABS_VAR_DIR.
async function boot(t, { noData = false, ai = spyAi(), profilePath = PROFILE_PATH } = {}) {
  const lines = [];
  const res = await main({
    env: {
      APLABS_VAR_DIR: path.join(tmp, 'var'),
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      ANTHROPIC_API_KEY: 'sk-ant-api00-fake-win-back-key-value',
      APLABS_PROFILE: profilePath,
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
  assert.equal(result.blocks[0].text.text, '*Win-back list: 38 rows, ranked by score.*');
  assert.deepEqual(result.blocks.filter((b) => b.fields).map((b) => b.fields[1].text), ['north', '90', '50']);
  // The view: score, the identifying columns and the reason, best first.
  const table = result.blocks.find((b) => b.text && b.text.text.startsWith('*The top 10:*')).text.text;
  const tableLines = table.split('\n');
  assert.match(tableLines[2], /^score +client_id +first_name +last_name +email +lapsed_on +reason$/);
  assert.equal(tableLines.length, 2 + 1 + 10 + 1);
  NORTH_TOP_5.forEach(([score, id, reason], i) => {
    assert.match(tableLines[3 + i], new RegExp(`^${score} +${id} +.* ${reason.replace(/[()$]/g, '\\$&')}$`));
  });
  const where = result.blocks.filter((b) => b.type === 'context').at(-1);
  assert.match(where.elements[0].text, /^The ranked list \(38 rows\) is a CSV in your DM with me\. <https:\/\/fake\.slack\.test\/files\/F1\|Open the CSV>$/);
  // Story 10.2: the result ends with "Push to email tool", carrying the run's random id.
  const push = actionsOf(result).find((b) => b.action_id === 'approval-write:push');
  assert.equal(push.text.text, 'Push to email tool');
  assert.match(push.value, /^[0-9a-f]{32}$/);
  // The CSV: all 38, ranked, in the admin's DM, with score first and reason last.
  assert.deepEqual(app.dms, [{ user: ADMIN, channel: `D${ADMIN.slice(1)}` }]);
  assert.equal(app.uploads.length, 1);
  assert.equal(app.uploads[0].channel_id, `D${ADMIN.slice(1)}`);
  const lines = app.uploads[0].content.replace(/^\ufeff/, '').trimEnd().split('\r\n');
  assert.equal(lines[0], `score,client_id,first_name,last_name,email,lapsed_on,${SCORE_COLUMNS.join(',')},reason`);
  assert.equal(lines.length, 1 + 38);
  assert.deepEqual(lines.slice(1, 6).map((l) => l.split(',').slice(0, 2).map(Number)), NORTH_TOP_5.map(([score, id]) => [score, id]));
  assert.ok(lines[1].endsWith(`,"${NORTH_TOP_5[0][2]}"`));
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  const expected = await data.run(winBack.sql, { zone: 'north', lapsed_days: 90 }, { declared: bound });
  assert.deepEqual(lines.slice(1).map((l) => Number(l.split(',')[1])).sort((a, b) => a - b), expected.map((r) => r.client_id).sort((a, b) => a - b));
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

// Runs Win-back as user (North, the given limit) through the hub window.
// Returns the result view, where it is shown and its Push button.
async function runWinBack(app, user, limit = '25') {
  await app.dispatchAction('win-back:open', { user: { id: user }, view: MENU });
  const form = last(app);
  const formId = `V${app.viewSeq}`;
  const state = { values: {
    'sp-input:zone': { value: { type: 'static_select', selected_option: { value: 'north' } } },
    'sp-input:limit': { value: { type: 'plain_text_input', value: limit } },
  } };
  await app.dispatchView('scoped-pull:form', {
    user: { id: user }, view: { id: formId, hash: `h${app.viewSeq}`, title: form.title, private_metadata: form.private_metadata, state },
  });
  const confirm = app.viewAcks.at(-1).view;
  const from = { id: formId, hash: 'hc', title: confirm.title, private_metadata: confirm.private_metadata, state: { values: {} } };
  await app.dispatchAction('scoped-pull:confirm', { user: { id: user }, view: from, value: actionsOf(confirm)[0].value });
  const result = last(app);
  return { result, from: { ...from, hash: `h${app.viewSeq}` }, push: actionsOf(result).find((b) => b.action_id === 'approval-write:push') };
}

test('Story 10.2: Push previews the top 25 for the email tool: win-back-north-<UTC run date>, 25 rows, none skipped, a sample of 5; Cancel sends nothing', async (t) => {
  const app = await boot(t);
  const { result, from, push } = await runWinBack(app, ADMIN);
  assert.equal(result.blocks[0].text.text, '*Win-back list: the top 25 of 38 rows, by score.*');
  await app.dispatchAction('approval-write:push', { user: { id: ADMIN }, view: from, value: push.value });
  const preview = last(app);
  assert.equal(app.views.at(-1).method, 'update', 'the module view is updated in place');
  const texts = preview.blocks.map((b) => (b.text && b.text.text) || '').join('\n');
  const today = new Date().toISOString().slice(0, 10);
  // The run date is the pull's UTC date (the fixture's as_of is 2026-09-30).
  assert.ok(texts.includes(`*List name:* win-back-north-${today}`), texts);
  assert.ok(!texts.includes('2026-09-30'));
  assert.match(texts, /\*Rows to send:\* 25 of 25 rows/);
  assert.match(texts, /\*Skipped:\* none/);
  const sample = preview.blocks.find((b) => b.text && b.text.text.startsWith('*A sample of 5:*')).text.text.split('\n');
  assert.match(sample[2], /^score +client_id +email +first_name$/);
  NORTH_TOP_5.forEach(([score, id], i) => assert.match(sample[3 + i], new RegExp(`^${score} +${id} +\\S+@\\S+ +\\S`)));
  const [approve, cancel] = actionsOf(preview);
  assert.deepEqual([approve.text.text, cancel.text.text], ['Approve', 'Cancel']);
  assert.match(approve.value, /^[0-9a-f]{32}$/);
  // Cancel ends it, and nothing reaches the email tool (the push itself,
  // Story 10.3, is in win-back-push.test.js).
  await app.dispatchAction('approval-write:cancel', { user: { id: ADMIN }, view: { ...from, hash: `h${app.viewSeq}` }, value: approve.value });
  assert.match(last(app).blocks[0].text.text, /^\*Push cancelled\.\*/);
  assert.equal(fs.existsSync(path.join(tmp, 'var', 'outbox', 'email.jsonl')), false, 'nothing was sent to the email tool');
  await app.dispatchAction('approval-write:approve', { user: { id: ADMIN }, view: { ...from, hash: `h${app.viewSeq}` }, value: approve.value });
  assert.match(last(app).blocks[0].text.text, /^This preview is no longer valid/, 'a cancelled preview can\'t be approved');
  assert.equal(fs.existsSync(path.join(tmp, 'var', 'outbox', 'email.jsonl')), false);
  assert.deepEqual(app.posted, [], 'nothing was posted to a channel');
});

test('Story 10.2 (Q6): Win-back is owner-only: an admin without the WIN_BACK grant never sees it', async (t) => {
  const file = path.join(tmp, 'no-grant-profile.yml');
  fs.writeFileSync(file, fs.readFileSync(PROFILE_PATH, 'utf8').replace(', grants: [WIN_BACK]', ''));
  const app = await boot(t, { profilePath: file });
  await app.dispatchCommand('/brightside', { user_id: ADMIN });
  assert.ok(!app.views[0].args.view.blocks.some((b) => b.accessory && b.accessory.action_id === 'win-back:open'));
  await app.dispatchAction('win-back:open', { user: { id: ADMIN }, view: MENU });
  assert.match(last(app).blocks[0].text.text, /You don't have access to Win-back list/);
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

test('Story 9.4: "North zone, lapsed in the last 90 days, top 25" fills zone north, 90 days, limit 25 from a stand-in reply, and Confirm gives the top 25 by score', async (t) => {
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
  assert.equal(last(app).blocks[0].text.text, '*Win-back list: the top 25 of 38 rows, by score.*');
  assert.equal(app.uploads.length, 1);
  // The rows went to the DM, never to the AI.
  assert.equal(ai.calls.length, 1);
  const sentToAi = JSON.stringify(ai.calls);
  const rows = app.uploads[0].content.replace(/^\ufeff/, '').trimEnd().split('\r\n').slice(1);
  assert.equal(rows.length, 25);
  for (const row of rows) {
    const email = row.split(',')[4];
    assert.ok(email.endsWith('.invalid'));
    assert.ok(!sentToAi.includes(email), 'an email from the rows reached the AI');
  }
});
