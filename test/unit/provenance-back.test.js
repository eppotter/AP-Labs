'use strict';

// "Back to the list" on a run's details (the fix found by Story 10.4's demo
// test). "How was this made?" replaces the result in the same view; its
// details now end with Back, which puts the result back exactly as it was
// shown: the headline, the values, the preview rows, the CSV line, "How was
// this made?" and, when the run has rows to push, Push. Back reads the result
// kept beside the run record; it never runs the query again and never sends
// another CSV. Only the person who ran it may use it, access is re-checked on
// each click, and an expired run says the details are gone. Through the hub
// wiring with the fake Slack client, a stand-in query runner and the fixture
// approval-write app (test/fixtures/runtime/approval), never a client's.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const access = require('../../kit/runtime/access');
const { loadRegistry, createRegistry } = require('../../kit/runtime/registry');
const { registerHubs } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { ACTIONS: FORM_ACTIONS, FORM_CALLBACK } = require('../../kit/runtime/archetypes/scoped-pull');
const { INPUT_BLOCK, VALUE_ACTION } = require('../../kit/runtime/archetypes/scoped-pull/form');
const approvalWrite = require('../../kit/runtime/archetypes/approval-write');
const { createConnectors } = require('../../kit/runtime/archetypes/approval-write/connectors');
const provenance = require('../../kit/runtime/slack/provenance');
const { messageFor } = require('../../kit/runtime/messages');
const { ProvenanceGone, ProvenanceNotYours } = require('../../kit/runtime/errors');
const { testLog } = require('../../kit/runtime/sdk');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime/approval');
const APP = path.join(FIX, 'app');
const profile = loadProfile(path.join(FIX, 'profile.yml'));
const { registry } = loadRegistry({ appDir: APP, profile });
const LEADS = registry.module('leads');
const mail = require(path.join(APP, 'connectors/mail/connector.js'));

const OWNER = { id: profile.users.find((u) => u.id === 'owner').identities.slack };
const OTHER = { id: profile.users.find((u) => u.id === 'other').identities.slack };
const MENU = { id: 'VMENU', type: 'modal', private_metadata: 'alpha', title: { type: 'plain_text', text: 'Alpha tools' } };
const GONE = messageFor(new ProvenanceGone());
const NOT_YOURS = messageFor(new ProvenanceNotYours());
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-25T12:00:00Z');

const ROWS = Object.freeze([
  { person_id: 770101, first: 'Annika', address: 'annika@home.invalid' },
  { person_id: 770102, first: 'Bodhi', address: 'bodhi@home.invalid' },
  { person_id: 770103, first: 'Cyrilla', address: 'cyrilla@home.invalid' },
]);

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// The hubs over the fixture app. queries counts the list query's runs.
function setup() {
  mail.reset();
  const clock = { t: T0 };
  const store = createStore({ now: () => clock.t });
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  const granted = { on: true };
  const queries = { n: 0 };
  const connectors = createConnectors({ appDir: APP, modules: registry.modules, log: testLog(), env: {} });
  const canUse = (person, mod) => (access.decide(profile, person.user, mod.resource) === 'allowed' && granted.on ? 'allowed' : 'denied');
  const data = {
    run: async (sql) => {
      if (sql !== LEADS.sql) return [];
      queries.n += 1;
      return ROWS.map((r) => ({ ...r }));
    },
    describe: () => ({ source: 'MotherDuck', label: 'tinydb', available: true }),
  };
  registerHubs(app, {
    registry: createRegistry({ hubs: registry.hubs, modules: registry.modules }), profile, env: 'dev', log, store, data, connectors, canUse,
  });
  return {
    app, log, store, clock, granted, queries,
  };
}

const updates = (app) => app.views.filter((v) => v.method === 'update').map((v) => v.args);
const actionsOf = (view) => view.blocks.flatMap((b) => [...(b.type === 'actions' ? b.elements : []), ...(b.accessory ? [b.accessory] : [])]);
const button = (view, actionId) => actionsOf(view).find((b) => b.action_id === actionId);
const texts = (view) => view.blocks.map((b) => (b.text && b.text.text) || null);

// Runs the list as user and returns the result view and the view it is in.
async function runList(ctx, user = OWNER) {
  await ctx.app.dispatchAction('leads:open', { user, view: MENU });
  const form = ctx.app.views.at(-1).args.view;
  const formId = `V${ctx.app.viewSeq}`;
  const state = { values: { [`${INPUT_BLOCK}zone`]: { [VALUE_ACTION]: { type: 'static_select', selected_option: { value: 'north' } } } } };
  await ctx.app.dispatchView(FORM_CALLBACK, { user, view: { id: formId, hash: 'hf', title: form.title, private_metadata: form.private_metadata, state } });
  const screen = ctx.app.viewAcks.at(-1).view;
  const session = screen.blocks.find((b) => b.type === 'actions').elements[0].value;
  const from = { id: formId, hash: 'hc', title: screen.title, private_metadata: screen.private_metadata };
  await ctx.app.dispatchAction(FORM_ACTIONS.confirm, { user, view: from, value: session });
  return { result: updates(ctx.app).at(-1).view, from };
}

// A click on the view it came from; returns the view it was updated to.
async function click(ctx, from, actionId, value, user = OWNER) {
  const before = updates(ctx.app).length;
  await ctx.app.dispatchAction(actionId, { user, view: { ...from, hash: `h${ctx.app.viewSeq}` }, value });
  const after = updates(ctx.app);
  assert.equal(after.length, before + 1, 'each click updates the view it came from once');
  return after.at(-1).view;
}

test('Back puts the result back exactly as shown, with How was this made? and Push, without a second query or CSV', async () => {
  const ctx = setup();
  const { result, from } = await runList(ctx);
  const how = button(result, provenance.ACTION);
  const push = button(result, approvalWrite.ACTIONS.push);
  assert.ok(how && push);
  assert.equal(ctx.queries.n, 1);
  assert.equal(ctx.app.uploads.length, 1);

  const details = await click(ctx, from, provenance.ACTION, how.value);
  assert.equal(details.blocks[0].text.text, '*How Leads list was made*');
  assert.equal(button(details, approvalWrite.ACTIONS.push), undefined, 'the details replace the result');
  const back = button(details, provenance.BACK_ACTION);
  assert.equal(back.text.text, 'Back to the list');
  assert.equal(back.value, how.value, 'Back names the same run');
  assert.equal(details.blocks.at(-1).block_id, 'provenance-back', 'Back comes last, after the SQL');

  const restored = await click(ctx, from, provenance.BACK_ACTION, back.value);
  assert.deepEqual(restored.blocks, result.blocks, 'the same headline, values, preview rows, CSV line and buttons');
  assert.equal(button(restored, approvalWrite.ACTIONS.push).value, push.value, 'Push carries the run\'s random id');
  assert.equal(ctx.queries.n, 1, 'Back never runs the query again');
  assert.equal(ctx.app.uploads.length, 1, 'Back never sends the CSV again');
  assert.deepEqual(ctx.app.posted, []);

  // The restored buttons work: details again, and Push gives its preview.
  const again = await click(ctx, from, provenance.ACTION, how.value);
  assert.deepEqual(again.blocks, details.blocks);
  const preview = await click(ctx, from, approvalWrite.ACTIONS.push, push.value);
  assert.ok(button(preview, approvalWrite.ACTIONS.approve), texts(preview).join('\n'));
  assert.equal(ctx.queries.n, 1);
  assert.equal(ctx.app.uploads.length, 1);
});

test('the kept result is what the person was shown, beside the record, with the record\'s 24 hours; the record keeps the AD-15 shape', async () => {
  const ctx = setup();
  const { result } = await runList(ctx);
  const runId = button(result, provenance.ACTION).value;
  const record = ctx.store.get(provenance.NS, runId);
  assert.deepEqual(Object.keys(record), [...provenance.RECORD_KEYS]);
  const kept = ctx.store.get(provenance.NS, provenance.RESULT_KEY(runId));
  assert.deepEqual(Object.keys(kept), ['text', 'blocks']);
  // Without the Push button, which Back rebuilds from the record.
  assert.deepEqual(kept.blocks, result.blocks.filter((b) => !(b.type === 'actions' && b.elements.some((e) => e.action_id === approvalWrite.ACTIONS.push))));
  assert.ok(!provenance.RUN_ID.test(provenance.RESULT_KEY(runId)), 'no button value can name the kept result');
  ctx.clock.t = T0 + 24 * HOUR - 1;
  assert.ok(ctx.store.get(provenance.NS, provenance.RESULT_KEY(runId)));
  ctx.clock.t = T0 + 24 * HOUR;
  assert.equal(ctx.store.get(provenance.NS, provenance.RESULT_KEY(runId)), undefined);
});

test('another person pressing Back is refused and sees nothing of the run', async () => {
  const ctx = setup();
  const { result, from } = await runList(ctx);
  const runId = button(result, provenance.ACTION).value;
  const view = await click(ctx, from, provenance.BACK_ACTION, runId, OTHER);
  assert.deepEqual(texts(view), [NOT_YOURS]);
  assert.ok(!JSON.stringify(view).includes('Annika'));
  assert.equal(button(view, approvalWrite.ACTIONS.push), undefined);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'run result refused' && l.fields.reason === 'not-yours'));
  // The owner still gets the result back.
  assert.deepEqual((await click(ctx, from, provenance.BACK_ACTION, runId)).blocks, result.blocks);
});

test('access is re-checked on each Back click: a person who lost access is refused', async () => {
  const ctx = setup();
  const { result, from } = await runList(ctx);
  const runId = button(result, provenance.ACTION).value;
  ctx.granted.on = false;
  const view = await click(ctx, from, provenance.BACK_ACTION, runId);
  assert.ok(!JSON.stringify(view).includes('Annika'));
  assert.equal(button(view, approvalWrite.ACTIONS.push), undefined);
  assert.match(texts(view)[0], /^You don't have access to Leads list|^You're not set up/);
});

test('after 24 hours, or for an unknown or malformed run id, Back says the details are gone rather than failing', async () => {
  const ctx = setup();
  const { result, from } = await runList(ctx);
  const runId = button(result, provenance.ACTION).value;
  const details = await click(ctx, from, provenance.ACTION, runId);
  ctx.clock.t = T0 + 24 * HOUR + 1;
  assert.deepEqual(texts(await click(ctx, from, provenance.BACK_ACTION, button(details, provenance.BACK_ACTION).value)), [GONE]);
  assert.deepEqual(texts(await click(ctx, from, provenance.BACK_ACTION, 'f'.repeat(32))), [GONE]);
  assert.deepEqual(texts(await click(ctx, from, provenance.BACK_ACTION, `${runId}:result`)), [GONE]);
  assert.deepEqual(texts(await click(ctx, from, provenance.BACK_ACTION, undefined)), [GONE]);
  assert.ok(!ctx.log.lines.some((l) => l.level === 'error'));
  assert.equal(ctx.queries.n, 1);
  assert.equal(ctx.app.uploads.length, 1);
});

test('a run with nothing to push comes back without Push; a record without a kept result offers no Back', async () => {
  const ctx = setup();
  ctx.app.filesFail = new Error('upload failed');
  const { result, from } = await runList(ctx);
  const runId = button(result, provenance.ACTION).value;
  assert.equal(button(result, approvalWrite.ACTIONS.push), undefined, 'a CSV that did not arrive cannot be pushed');
  const details = await click(ctx, from, provenance.ACTION, runId);
  const restored = await click(ctx, from, provenance.BACK_ACTION, button(details, provenance.BACK_ACTION).value);
  assert.deepEqual(restored.blocks, result.blocks);
  assert.equal(button(restored, approvalWrite.ACTIONS.push), undefined);

  // A record kept before Back existed: no Back button, and a Back click is told the details are gone.
  ctx.store.set(provenance.NS, provenance.RESULT_KEY(runId), undefined);
  const plain = await click(ctx, from, provenance.ACTION, runId);
  assert.equal(button(plain, provenance.BACK_ACTION), undefined);
  assert.deepEqual(texts(await click(ctx, from, provenance.BACK_ACTION, runId)), [GONE]);
});

test('keepingResult never costs the person their result, and passes the reuse hook through', () => {
  const failing = { set: () => { throw new Error('store full'); } };
  const log = quietLog();
  const seen = [];
  const hooks = provenance.keepingResult({ pushRows: 'kept', decorate: (mod, m, r) => { seen.push(r.runId); return { ...m, decorated: true }; } }, failing, log);
  const out = hooks.decorate({ id: 'm' }, { text: 't', blocks: [] }, { runId: 'a'.repeat(32) });
  assert.equal(out.decorated, true);
  assert.deepEqual(seen, ['a'.repeat(32)]);
  assert.equal(hooks.pushRows, 'kept');
  assert.ok(log.lines.some((l) => l.level === 'warn' && l.msg === 'result not kept for Back'));
  const bare = provenance.keepingResult({}, createStore(), log);
  const msg = { text: 't', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }] };
  assert.equal(bare.decorate({ id: 'm' }, msg, { runId: 'b'.repeat(32) }), msg);
});
