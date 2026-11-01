'use strict';

// The demo flow, end to end (Story 10.4, CAP-14): every step of
// docs/planning/specs/spec-runtime/demo-flow.md, driven through fake Slack
// with the template configured the way the live demo is: a fixture copy of
// the Brightside profile (APLABS_PROFILE), the example app dir (APLABS_APP_DIR), a
// temporary APLABS_VAR_DIR (so var/outbox/email.jsonl starts empty) and a
// temporary build of the local fixture (APLABS_DATA_PATH), with every kill
// switch cleared. No copy of the repo is made. Offline: fake Slack, a
// stand-in model reply, the local fixture file.
//
//   1  /brightside: the menu shows only what Ely's profile grants
//   2  Win-back list, "clients in the North zone whose plan lapsed in the
//      last 90 days, top 25", Read my request
//   3  the values understood (north, 90, 25) with Confirm / Change; Change
//      opens the typed form, prefilled
//   4  Confirm: the top 25 by score with a reason each, "How was this
//      made?", and the CSV in Ely's DM
//   5  How was this made?: the values and the exact SQL, then Back to the
//      list: the same result again, with its buttons
//   6  Push to email tool: the list name, the count, a sample, Approve / Cancel
//   7  Approve: pushed, skipped and failed counts; a second click sends nothing
//   8  the Outbox entry shows the list the mock email tool received
//
// At the end: the outbox holds exactly the approved, scored list, once;
// every message went privately to Ely (a modal or an ephemeral reply,
// nothing posted to a channel); exactly one CSV went, only to her DM.
//
// A second pass runs with APLABS_LLM_OFF set: step 2 says the AI helper is
// switched off and shows the typed form, which completes the same flow.
//
// Step 5 replaces the result in the window (Story 9.6); "Back to the list"
// on the details puts the same result back, Push included, without running
// the query or sending the CSV again (docs/runtime/demo-script.md).
//
// An example test (architecture carve-out, plan epic-10 Q7): it reads
// Brightside's app dir and fixture, and a copy of its profile in
// fixtures/demo-profile.yml, and is deleted with the example in a fork.

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
const { escapeText } = require('../../../kit/runtime/messages');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const { checkRequest } = require('../../../test/fixtures/fake-anthropic');

const ROOT = path.join(__dirname, '../../..');
// A fixture copy of the demo profile (fake Slack ids), never profiles/brightside (#161).
const PROFILE_PATH = path.join(__dirname, 'fixtures/demo-profile.yml');
const APP_DIR = path.join(ROOT, 'examples/brightside/app');
const profile = loadProfile(PROFILE_PATH);
const { registry } = loadRegistry({ appDir: APP_DIR, profile });
const winBack = registry.module('win-back');
const ELY = profile.users.find((u) => u.id === 'ely').identities.slack;
const ELY_DM = `D${ELY.slice(1)}`;
const REQUEST = 'clients in the North zone whose plan lapsed in the last 90 days, top 25';
const today = () => new Date().toISOString().slice(0, 10);
const LIST_NAME = () => `win-back-north-${today()}`;

// Every kill switch the engine and Brightside's connectors read. Cleared from
// the app's env and from this process's env for the run.
const KILL_SWITCHES = ['APLABS_WRITES_OFF', 'APLABS_LLM_OFF', 'APLABS_JOBS_OFF', 'BRIGHTSIDE_EMAIL_OFF', 'BRIGHTSIDE_CRM_OFF'];
const isKillSwitch = (name) => KILL_SWITCHES.includes(name) || /_OFF$/.test(name);

let tmp;
let FIXTURE;
const saved = {};
before(async () => {
  for (const name of Object.keys(process.env).filter(isKillSwitch)) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  // The Outbox entry reads var/outbox/email.jsonl under APLABS_VAR_DIR from
  // the process env (each pass sets it to its own temporary dir).
  saved.APLABS_VAR_DIR = process.env.APLABS_VAR_DIR;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-demo-flow-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
});
after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

class ViewsSlackApp extends FakeSlackApp {
  constructor(options) { super({ ...options, views: true }); }
}

// A stand-in model that fills the form from the request (Story 9.4),
// recording every request it is sent. Like the real API, it refuses a
// tool_choice of type "tool" or "any" (checkRequest).
function standInModel() {
  const calls = [];
  const reply = {
    content: [{ type: 'tool_use', id: 'toolu_demo', name: 'fill_parameters', input: { zone: 'north', lapsed_days: 90, limit: 25 } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 400, output_tokens: 30 },
  };
  return { calls, created: 0, client: { messages: { create: async (params) => { calls.push(params); checkRequest(params); return reply; } } } };
}

let seq = 0;
// Boots the app as the live demo runs it, on its own var dir.
async function boot(t, { llmOff }) {
  seq += 1;
  const varDir = path.join(tmp, `var-${seq}`);
  process.env.APLABS_VAR_DIR = varDir;
  const model = standInModel();
  const env = {
    APLABS_PROFILE: PROFILE_PATH,
    APLABS_APP_DIR: APP_DIR,
    APLABS_VAR_DIR: varDir,
    APLABS_DATA_PATH: FIXTURE,
    APLABS_NO_KEYCHAIN: '1',
    // Fake values, shaped like the real ones; nothing here is a credential.
    SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
    SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
    ANTHROPIC_API_KEY: 'sk-ant-api00-fake-demo-flow-key-value',
    ...(llmOff ? { APLABS_LLM_OFF: '1' } : {}),
  };
  assert.deepEqual(Object.keys(env).filter((n) => isKillSwitch(n) && !(llmOff && n === 'APLABS_LLM_OFF')), [], 'no kill switch set');
  const lines = [];
  const res = await main({
    env,
    cwd: os.tmpdir(),
    deps: {
      App: ViewsSlackApp,
      write: (line) => lines.push(line),
      readKeychain: () => assert.fail('no Keychain'),
      llm: { createClient: () => { model.created += 1; return model.client; } },
    },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => res.data.close());
  assert.equal(res.llm.status().on, !llmOff);
  return { app: res.app, model, reads: 0, outbox: path.join(varDir, 'outbox', 'email.jsonl') };
}

const last = (app) => app.views.at(-1).args.view;
const actionsOf = (view) => view.blocks.flatMap((b) => [...(b.type === 'actions' ? b.elements : []), ...(b.accessory ? [b.accessory] : [])]);
const button = (view, actionId) => actionsOf(view).find((b) => b.action_id === actionId);
const texts = (view) => view.blocks.map((b) => (b.text && b.text.text) || '').join('\n');
const values = (view) => view.blocks.filter((b) => b.fields).map((b) => b.fields[1].text);
// The view a click came from, as Slack sends it back.
const from = (app, view, state = { values: {} }) => ({
  id: app.views.at(-1).method === 'update' ? app.views.at(-1).args.view_id : `V${app.viewSeq}`,
  hash: `h${app.viewSeq}`,
  title: view.title,
  private_metadata: view.private_metadata,
  state,
});
const typed = { values: {
  'sp-input:zone': { value: { type: 'static_select', selected_option: { value: 'north' } } },
  'sp-input:lapsed_days': { value: { type: 'number_input', value: '90' } },
  'sp-input:limit': { value: { type: 'number_input', value: '25' } },
} };

function records(file, type) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === type);
}

// The CSV's rows: [{ score, client_id, first_name, email }] in rank order.
function csvRows(upload) {
  const [header, ...rows] = upload.content.replace(/^﻿/, '').trimEnd().split('\r\n');
  const cols = header.split(',');
  return rows.map((r) => {
    const cells = r.split(',');
    const at = (c) => cells[cols.indexOf(c)];
    return { score: Number(at('score')), client_id: at('client_id'), first_name: at('first_name'), email: at('email') };
  });
}

// Steps 2 and 3 up to the Confirm screen. AI on: the request is read from
// plain English. AI off: Read my request says so plainly and the typed form
// is filled instead. Returns the Confirm screen.
async function askForTheList(ctx, { llmOff }) {
  const { app } = ctx;
  await app.dispatchAction('win-back:open', { user: { id: ELY }, view: ctx.menu });
  const form = last(app);
  assert.equal(form.title.text, 'Win-back list');
  const read = button(form, 'scoped-pull:read');
  assert.equal(read.text.text, 'Read my request');
  const request = { values: { 'sp-request': { value: { type: 'plain_text_input', value: REQUEST } } } };
  await app.dispatchAction('scoped-pull:read', { user: { id: ELY }, view: from(app, form, request), value: read.value });
  let shown = last(app);
  if (llmOff) {
    // Step 2 with the AI off: said plainly, above the typed form.
    assert.equal(shown.blocks[0].text.text, "The AI helper is switched off right now, so I can't read your request. Please use the form instead.");
    assert.equal(shown.submit.text, 'Check values');
    assert.equal(ctx.model.created, 0, 'no model client is built when the AI is off');
    await app.dispatchView('scoped-pull:form', { user: { id: ELY }, view: from(app, shown, typed) });
    shown = app.viewAcks.at(-1).view;
  } else {
    ctx.reads += 1;
    assert.equal(ctx.model.calls.length, ctx.reads, 'one model call per Read');
    assert.equal(ctx.model.calls.at(-1).messages[0].content, `<request>\n${REQUEST}\n</request>`);
  }
  // Step 3: the values understood, with Confirm and Change.
  assert.match(texts(shown), /Nothing runs until you press \*Confirm\*/);
  assert.deepEqual(values(shown), ['north', '90', '25']);
  assert.deepEqual(actionsOf(shown).map((b) => b.text.text), ['Confirm', 'Change']);
  return shown;
}

// Confirm on the Confirm screen (step 4). Returns the result view.
async function confirm(ctx, confirmView) {
  const { app } = ctx;
  await app.dispatchAction('scoped-pull:confirm', { user: { id: ELY }, view: from(app, confirmView), value: button(confirmView, 'scoped-pull:confirm').value });
  return last(app);
}

async function demo(t, { llmOff }) {
  const ctx = await boot(t, { llmOff });
  const { app } = ctx;

  // Step 1: the hub menu shows only what Ely's profile grants.
  await app.dispatchCommand('/brightside', { user_id: ELY });
  const menuArgs = app.views[0].args;
  assert.equal(app.views[0].method, 'open');
  // A row's button sends <id>:open, or <id>:why while the tool waits (Story 17.3).
  const entries = (view) => view.blocks.filter((b) => b.accessory && /:(open|why)$/.test(b.accessory.action_id)).map((b) => b.accessory.action_id.replace(/:(open|why)$/, ''));
  // routing is the dev-only Routing map (Story 15.5) and route-planner the dev-only Plan a
  // route (Story 15.15), on the same resource: Ely holds ROUTING_ALL_CREWS by name.
  assert.deepEqual(entries(menuArgs.view).sort(), ['dataset', 'hello-world', 'labour-cost', 'outbox', 'route-planner', 'routing', 'unpaid-invoices', 'win-back']);
  // Plan a route can't open in this boot (its editor is unready: the
  // dispatcher refuses it), so its status is waiting for map setup and its
  // button is Why? (plan hub-status-menu, D7).
  const waiting = menuArgs.view.blocks.filter((b) => b.accessory && /:why$/.test(b.accessory.action_id)).map((b) => b.accessory.action_id);
  assert.deepEqual(waiting, ['route-planner:why']);
  ctx.menu = { id: 'V1', type: 'modal', private_metadata: menuArgs.view.private_metadata, title: menuArgs.view.title };
  // Someone the profile doesn't know sees only the open-access entries.
  await app.dispatchCommand('/brightside', { user_id: 'U0NOTINPROFILE' });
  assert.deepEqual(entries(app.views.at(-1).args.view).sort(), ['dataset', 'hello-world']);

  // Steps 2 and 3, then Change: the typed form, prefilled with the values.
  const firstConfirm = await askForTheList(ctx, { llmOff });
  await app.dispatchAction('scoped-pull:change', { user: { id: ELY }, view: from(app, firstConfirm), value: button(firstConfirm, 'scoped-pull:change').value });
  const changed = last(app);
  assert.equal(changed.submit.text, 'Check values');
  const zone = changed.blocks.find((b) => b.block_id === 'sp-input:zone').element.initial_option.value;
  assert.equal(zone, 'north', 'Change keeps the values understood');
  await app.dispatchView('scoped-pull:form', { user: { id: ELY }, view: from(app, changed, typed) });
  const confirmView = app.viewAcks.at(-1).view;
  assert.deepEqual(values(confirmView), ['north', '90', '25']);
  assert.equal(app.uploads.length, 0, 'nothing runs before Confirm');

  // Step 4: the top 25 by score, a reason each, the CSV in Ely's DM.
  const result = await confirm(ctx, confirmView);
  assert.equal(result.blocks[0].text.text, '*Win-back list: the top 25 of 38 rows, by score.*');
  const table = texts(result).split('\n');
  assert.ok(table.some((l) => /^score +client_id +first_name +last_name +email +lapsed_on +reason$/.test(l)));
  assert.match(texts(result), /^86 +730 +.* Lifetime paid spend \(\$\): 21,093; Price rise before lapse$/m);
  assert.equal(button(result, 'provenance:show').text.text, 'How was this made?');
  assert.equal(button(result, 'approval-write:push').text.text, 'Push to email tool');
  assert.equal(app.uploads.length, 1);
  assert.equal(app.uploads[0].channel_id, ELY_DM);
  const scored = csvRows(app.uploads[0]);
  assert.equal(scored.length, 25);
  assert.deepEqual(scored.slice(0, 2).map((r) => [r.score, r.client_id]), [[86, '730'], [74, '931']]);

  // Step 5: How was this made? shows the values and the exact SQL.
  await app.dispatchAction('provenance:show', { user: { id: ELY }, view: from(app, result), value: button(result, 'provenance:show').value });
  const details = last(app);
  assert.equal(details.blocks[0].text.text, '*How Win-back list was made*');
  assert.deepEqual(values(details), ['north', '90', '25']);
  const sql = details.blocks.filter((b) => b.text && /```/.test(b.text.text)).map((b) => b.text.text.replace(/^\*The SQL that ran:\*\n/, '').replace(/^```\n|\n```$/g, '')).join('');
  assert.equal(sql, escapeText(winBack.sql), 'the exact SQL');

  // The details replaced the result in the window: Back to the list puts
  // the same result back, with its buttons, and runs nothing.
  const back = button(details, 'provenance:back');
  assert.equal(back.text.text, 'Back to the list');
  await app.dispatchAction('provenance:back', { user: { id: ELY }, view: from(app, details), value: back.value });
  const again = last(app);
  assert.deepEqual(again.blocks, result.blocks, 'the same result, as it was shown');
  assert.equal(button(again, 'approval-write:push').text.text, 'Push to email tool');
  assert.equal(app.uploads.length, 1, 'Back sends no second CSV');

  // Step 6: the preview names the list, the count and a sample.
  await app.dispatchAction('approval-write:push', { user: { id: ELY }, view: from(app, again), value: button(again, 'approval-write:push').value });
  const preview = last(app);
  assert.ok(texts(preview).includes(`*List name:* ${LIST_NAME()}`), texts(preview));
  assert.match(texts(preview), /\*Rows to send:\* 25 of 25 rows/);
  assert.match(texts(preview), /\*Skipped:\* none/);
  assert.ok(texts(preview).includes('*A sample of 5:*'));
  assert.deepEqual(actionsOf(preview).map((b) => b.text.text), ['Approve', 'Cancel']);
  assert.equal(fs.existsSync(ctx.outbox), false, 'nothing is sent before Approve');

  // Step 7: Approve pushes once; a second click sends nothing new.
  const approve = button(preview, 'approval-write:approve');
  await app.dispatchAction('approval-write:approve', { user: { id: ELY }, view: from(app, preview), value: approve.value });
  const pushed = last(app);
  assert.equal(pushed.blocks[0].text.text, `*Pushed 25 to email tool*, skipped 0, failed 0. List: ${LIST_NAME()}.`);
  await app.dispatchAction('approval-write:approve', { user: { id: ELY }, view: from(app, pushed), value: approve.value });
  assert.match(last(app).blocks[0].text.text, /^You already approved this push, so it ran once and I won't send it again\./);

  // Step 8: the Outbox entry shows what the mock email tool received.
  await app.dispatchAction('outbox:open', { user: { id: ELY }, view: ctx.menu });
  const outboxView = texts(last(app));
  assert.match(outboxView, /^\*Email outbox\*/);
  assert.ok(outboxView.includes(`*${LIST_NAME()}* · 25 contacts · `), outboxView);
  assert.equal(app.views.at(-1).method, 'update');

  // The outbox holds exactly the approved, scored list, once.
  const lists = records(ctx.outbox, 'list');
  assert.equal(lists.length, 1);
  assert.equal(lists[0].payload.name, LIST_NAME());
  const contacts = records(ctx.outbox, 'contact').map((r) => r.payload);
  assert.deepEqual(
    contacts.map((c) => [c.external_ref, c.email, c.first_name]),
    scored.map((r) => [r.client_id, r.email, r.first_name]),
    'the 25 scored rows, in rank order, each once',
  );
  assert.ok(contacts.every((c) => c.listId === lists[0].payload.listId));

  // Every message was private: modals and ephemeral replies only, nothing
  // posted to a channel; exactly one CSV, only to Ely's DM.
  assert.deepEqual(app.posted, [], 'nothing posted to a channel');
  assert.ok(app.said.every((m) => m.ephemeral), 'every said reply is ephemeral');
  assert.ok(app.responded.every((m) => m.response_type === 'ephemeral'), 'every respond is ephemeral');
  assert.ok(app.views.every((v) => ['open', 'push', 'update'].includes(v.method) && (v.args.view.type || 'modal') === 'modal'));
  assert.equal(app.uploads.length, 1, 'exactly one CSV');
  assert.ok(app.uploads.every((u) => u.channel_id === ELY_DM));
  assert.ok(app.dms.every((d) => d.user === ELY && d.channel === ELY_DM));

  // The rows never reached the model.
  const sent = JSON.stringify(ctx.model.calls);
  assert.ok(scored.every((r) => !sent.includes(r.email)));
  assert.equal(ctx.model.calls.length, llmOff ? 0 : 1);
  return contacts;
}

test('the demo flow, steps 1 to 8, with the plain-English step read from a stand-in model reply', async (t) => {
  await demo(t, { llmOff: false });
});

test('with APLABS_LLM_OFF set, step 2 says the AI helper is off and the typed form completes the same flow', async (t) => {
  await demo(t, { llmOff: true });
});
