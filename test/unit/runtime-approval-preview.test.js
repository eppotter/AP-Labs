'use strict';

// Story 10.2: preview and approve before anything is pushed. An
// approval-write module runs the scoped-pull engine (form, query, results,
// "How was this made?") and its result carries "Push to <destination>",
// carrying the run's random id. Push re-checks access and the environment,
// reads the person's own run record, runs the write's dry-run plan (rows the
// tool would refuse show as skipped) and shows the preview in the same view:
// the list name with the pull's UTC run date, the counts, the skips and a
// sample of 5 escaped rows, with Approve and Cancel carrying only an opaque
// token. The approval entry holds its own copy of the rows and the
// idempotency key (sha256 of [listName, sortedIdsAsStrings]). Approve with an
// expired, unknown or someone else's token gets PreviewInvalid; nothing is
// pushed or consumed (the push itself is tested in
// runtime-approval-push.test.js, Story 10.3). Cancel consumes the token. Through
// the hub wiring with the fake Slack client, a stand-in query runner and the
// fixture connector (test/fixtures/runtime/approval), never a client's.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const access = require('../../kit/runtime/access');
const { loadRegistry, createRegistry } = require('../../kit/runtime/registry');
const { registerHubs, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { ACTIONS: FORM_ACTIONS, FORM_CALLBACK } = require('../../kit/runtime/archetypes/scoped-pull');
const { INPUT_BLOCK, VALUE_ACTION } = require('../../kit/runtime/archetypes/scoped-pull/form');
const { createRunner } = require('../../kit/runtime/archetypes/scoped-pull/run');
const approvalWrite = require('../../kit/runtime/archetypes/approval-write');
const entry = require('../../kit/runtime/archetypes/approval-write/entry');
const { runDate, listNameOf } = require('../../kit/runtime/archetypes/approval-write/preview');
const { createConnectors } = require('../../kit/runtime/archetypes/approval-write/connectors');
const provenance = require('../../kit/runtime/slack/provenance');
const { messageFor } = require('../../kit/runtime/messages');
const {
  PreviewInvalid, PushRefused, AccessDenied, KillSwitchOn,
} = require('../../kit/runtime/errors');
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
const BOSS = { id: profile.users.find((u) => u.id === 'boss').identities.slack };
const ADMIN = access.adminContact(profile);
const INVALID = messageFor(new PreviewInvalid());
const MENU = { id: 'VMENU', type: 'modal', private_metadata: 'alpha', title: { type: 'plain_text', text: 'Alpha tools' } };
const HEX32 = /^[0-9a-f]{32}$/;
const HOUR = 60 * 60 * 1000;

// Seven people in rank order (the SQL's ORDER BY), one with no address and
// two names that would ping or format if they weren't escaped.
const ROWS = Object.freeze([
  { person_id: 1, first: 'Ann <b>', address: 'ann@home.invalid' },
  { person_id: 2, first: 'Bo', address: null },
  { person_id: 3, first: 'Cy', address: 'cy@home.invalid' },
  { person_id: 4, first: '<!channel>', address: 'di@home.invalid' },
  { person_id: 5, first: 'Fay', address: 'fay@home.invalid' },
  { person_id: 6, first: 'Gus', address: 'gus@home.invalid' },
  { person_id: 10, first: 'Eve', address: 'eve@home.invalid' },
]);

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function fakeData(answer = () => ROWS.map((r) => ({ ...r }))) {
  return { run: async (sql, params) => (sql === LEADS.sql ? answer(sql, params) : []), describe: () => ({ available: true }) };
}

// The hubs over the fixture app. clock: { t } in ms, read by the store.
// granted: { on } (default true) decides PUSH_LEADS for OWNER and OTHER, so a
// test can take the grant away between clicks. env: the run's environment.
function setup({
  rows, connectorEnv = {}, env = 'dev', granted = { on: true }, mods = registry.modules,
} = {}) {
  const clock = { t: Date.parse('2026-10-25T12:00:00Z') };
  const store = createStore({ now: () => clock.t });
  // A fresh fixture tool and idempotency store for each test: the same rows
  // on the same day would otherwise be "already sent today" (Story 10.3).
  mail.reset();
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  const connectors = createConnectors({ appDir: APP, modules: registry.modules, log: testLog(), env: connectorEnv });
  const canUse = (person, mod) => (access.decide(profile, person.user, mod.resource) === 'allowed' && granted.on ? 'allowed' : 'denied');
  registerHubs(app, {
    registry: createRegistry({ hubs: registry.hubs, modules: mods }), profile, env, log, store, data: fakeData(rows ? () => rows.map((r) => ({ ...r })) : undefined), connectors, canUse,
  });
  return { app, log, store, clock, connectors, granted };
}

const updates = (app) => app.views.filter((v) => v.method === 'update').map((v) => v.args);
const lastView = (app) => updates(app).at(-1).view;
const buttons = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const textOf = (view) => view.blocks.map((b) => (b.text && b.text.text) || (b.elements && b.elements.map((e) => e.text && (e.text.text || e.text)).join(' ')) || '').join('\n');

// Runs the list as user (zone north) and returns the result view, the Push
// button and where the result is shown.
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
  const view = lastView(ctx.app);
  const push = buttons(view).find((b) => b.action_id === approvalWrite.ACTIONS.push);
  return { view, push, from: { ...from, hash: `h${ctx.app.viewSeq}` } };
}

async function click(ctx, action, value, { user = OWNER, from } = {}) {
  const at = from || { id: 'VRESULT', hash: `h${ctx.app.viewSeq}`, title: { type: 'plain_text', text: 'Leads list' }, private_metadata: JSON.stringify({ hubId: 'alpha' }) };
  const before = updates(ctx.app).length;
  await ctx.app.dispatchAction(action, { user, view: at, value });
  const after = updates(ctx.app);
  assert.equal(after.length, before + 1, 'each click updates the view it came from once');
  return after.at(-1);
}

// Runs the list, presses Push and returns the preview and its token.
async function preview(ctx) {
  const run = await runList(ctx);
  const update = await click(ctx, approvalWrite.ACTIONS.push, run.push.value, { from: run.from });
  const view = update.view;
  const approve = buttons(view).find((b) => b.action_id === approvalWrite.ACTIONS.approve);
  const cancel = buttons(view).find((b) => b.action_id === approvalWrite.ACTIONS.cancel);
  return { run, update, view, approve, cancel, token: approve && approve.value };
}

test('an approval-write result carries "Push to <destination>" with the run\'s random id; its record keeps a copy of the push fields', async () => {
  const ctx = setup();
  const { view, push } = await runList(ctx);
  assert.match(view.blocks[0].text.text, /^\*Leads list: 7 rows\.\*/);
  assert.ok(push, 'the result has a Push button');
  assert.equal(push.text.text, 'Push to mail tool');
  assert.match(push.value, HEX32, 'a random 128-bit run id, never a guessable one');
  const record = ctx.store.get('provenance', push.value);
  assert.equal(record.person, OWNER.id);
  assert.deepEqual(record.rowIds, [1, 2, 3, 4, 5, 6, 10]);
  assert.deepEqual(record.rows, ROWS.map(({ person_id, first, address }) => ({ person_id, first, address })));
  // "How was this made?" still works on it (the scoped-pull engine runs it).
  assert.equal(view.blocks[0].accessory.action_id, provenance.ACTION);
  assert.equal(view.blocks[0].accessory.value, push.value);
});

test('Push shows the preview in the same view: the list name with the UTC run date, the counts, the skipped rows and why, a sample of 5 escaped rows, Approve and Cancel', async () => {
  const ctx = setup();
  const sentBefore = mail.state.sent.length;
  const { run, update, view, approve, cancel, token } = await preview(ctx);
  assert.equal(update.view_id, run.from.id, 'the module view is updated, never a new view');
  assert.equal(ctx.app.views.filter((v) => v.method === 'push').length, 1, 'only the module view was ever pushed');
  const record = ctx.store.get('provenance', run.push.value);
  const listName = `leads-north-${record.ranAt.slice(0, 10)}`;
  const text = textOf(view);
  assert.match(text, new RegExp(`\\*List name:\\* ${listName}`));
  assert.match(text, /\*Rows to send:\* 6 of 7 rows/);
  assert.match(text, /\*Skipped:\* 1: no address \(1\)/, 'the dry-run plan\'s skips, before approval');
  const sample = view.blocks.find((b) => b.text && b.text.text.startsWith('*A sample of 5:*')).text.text;
  assert.equal(sample.split('\n').length, 1 + 1 + 1 + 5 + 1, 'heading, fence, header row, 5 rows, fence');
  assert.ok(sample.includes('&lt;!channel&gt;') && sample.includes('Ann &lt;b&gt;'), 'cells are escaped');
  assert.ok(!sample.includes('<!channel>'));
  assert.ok(!sample.includes('Gus'), 'only the first 5 rows');
  assert.equal(approve.text.text, 'Approve');
  assert.equal(cancel.text.text, 'Cancel');
  assert.match(token, HEX32);
  assert.equal(cancel.value, token);
  // The dry run sent nothing.
  assert.equal(mail.state.sent.length, sentBefore);
});

test('the approval entry: the person, the run, the list, its own copy of the rows and the idempotency key; the buttons carry only the token', async () => {
  const ctx = setup();
  const { run, view, token } = await preview(ctx);
  const stored = ctx.store.get('approval', token);
  assert.deepEqual(Object.keys(stored).sort(), [...entry.ENTRY_KEYS].sort());
  const record = ctx.store.get('provenance', run.push.value);
  const listName = `leads-north-${record.ranAt.slice(0, 10)}`;
  assert.deepEqual({ ...stored, rows: [...stored.rows], skipped: [...stored.skipped] }, {
    person: OWNER.id,
    module: 'leads',
    runId: run.push.value,
    destination: 'mail tool',
    listName,
    rows: record.rows,
    skipped: ['no address'],
    idempotencyKey: crypto.createHash('sha256').update(JSON.stringify([listName, ['1', '10', '2', '3', '4', '5', '6']])).digest('hex'),
  });
  assert.notEqual(stored.rows, record.rows, 'a copy, not the record\'s array');
  assert.notEqual(stored.rows[0], record.rows[0]);
  // The Approve and Cancel buttons carry the token and nothing else.
  for (const b of buttons(view)) {
    assert.deepEqual(Object.keys(b).sort(), b.style ? ['action_id', 'style', 'text', 'type', 'value'] : ['action_id', 'text', 'type', 'value']);
    assert.equal(b.value, token);
  }
  assert.ok(!JSON.stringify(buttons(view)).includes('home.invalid'));
});

test('the idempotency key is sha256 of the canonical JSON [listName, sortedIdsAsStrings]; the run date is the pull\'s UTC date', () => {
  const key = entry.idempotencyKey('win-back-north-2026-10-24', [931, 730, 1222]);
  assert.equal(key, crypto.createHash('sha256').update('["win-back-north-2026-10-24",["1222","730","931"]]').digest('hex'));
  assert.equal(entry.idempotencyKey('l', ['730', 931, 1222]), entry.idempotencyKey('l', [1222, 931, 730]), 'order and type of the ids do not matter');
  assert.notEqual(entry.idempotencyKey('l', [1]), entry.idempotencyKey('m', [1]));
  // 23:30 in New York on the 24th is the 25th in UTC.
  assert.equal(runDate('2026-10-25T03:30:00.000Z'), '2026-10-25');
  assert.equal(runDate(new Date('2026-10-24T23:30:00-05:00').toISOString()), '2026-10-25');
  assert.equal(listNameOf(LEADS, { ranAt: '2026-10-24T23:59:59.999Z', parameters: { zone: 'south' } }), 'leads-south-2026-10-24');
  assert.throws(() => runDate('not a time'), /no valid time/);
});

test('the entry still holds its own rows after the run record has expired', async () => {
  const ctx = setup();
  const run = await runList(ctx);
  // Push just before the record's 24 hours run out.
  ctx.clock.t += 24 * HOUR - 60 * 1000;
  const { view } = await click(ctx, approvalWrite.ACTIONS.push, run.push.value, { from: run.from });
  const token = buttons(view).find((b) => b.action_id === approvalWrite.ACTIONS.approve).value;
  ctx.clock.t += 2 * 60 * 1000;
  assert.equal(ctx.store.get('provenance', run.push.value), undefined, 'the run record has expired');
  const stored = ctx.store.get('approval', token);
  assert.equal(stored.rows.length, 7);
  assert.deepEqual(stored.rows[0], { person_id: 1, first: 'Ann <b>', address: 'ann@home.invalid' });
  // Approve still finds it, and pushes the entry's own rows (Story 10.3).
  const approved = await click(ctx, approvalWrite.ACTIONS.approve, token);
  assert.match(textOf(approved.view), /^\*Pushed 6 to mail tool\*, skipped 1, failed 0\./);
});

test('Push after the run record expired: the person is told the results expired; no token is made', async () => {
  const ctx = setup();
  const run = await runList(ctx);
  ctx.clock.t += 24 * HOUR + 1;
  const { view } = await click(ctx, approvalWrite.ACTIONS.push, run.push.value, { from: run.from });
  assert.equal(view.blocks[0].text.text, messageFor(new PushRefused('expired')));
  assert.deepEqual(buttons(view), []);
});

test('a different person\'s Push gets the generic reply, and no token is made', async () => {
  const ctx = setup();
  const run = await runList(ctx);
  const { view } = await click(ctx, approvalWrite.ACTIONS.push, run.push.value, { user: OTHER, from: run.from });
  assert.equal(view.blocks[0].text.text, INVALID);
  assert.deepEqual(buttons(view), []);
  for (const bad of ['', 'nope', 'A'.repeat(32), undefined]) {
    const r = await click(ctx, approvalWrite.ACTIONS.push, bad === undefined ? 'approval-write' : bad);
    assert.equal(r.view.blocks[0].text.text, INVALID, `run id ${JSON.stringify(bad)}`);
  }
});

test('Approve with a token that is expired, unknown, malformed or someone else\'s: the same reply each time, and nothing is consumed', async () => {
  const ctx = setup();
  const { token } = await preview(ctx);
  const replies = [];
  for (const [user, value] of [[OTHER, token], [OWNER, crypto.randomBytes(16).toString('hex')], [OWNER, 'not-a-token'], [OWNER, `${token}0`]]) {
    replies.push((await click(ctx, approvalWrite.ACTIONS.approve, value, { user })).view.blocks[0].text.text);
  }
  assert.deepEqual(replies, [INVALID, INVALID, INVALID, INVALID]);
  assert.ok(ctx.store.get('approval', token), 'someone else\'s click consumed nothing');
  // Someone else's Cancel consumes nothing either.
  assert.equal((await click(ctx, approvalWrite.ACTIONS.cancel, token, { user: OTHER })).view.blocks[0].text.text, INVALID);
  assert.ok(ctx.store.get('approval', token));
  assert.equal(mail.state.sent.length, 0, 'nothing was pushed by the refused clicks');
  // The owner's Approve finds it and pushes (Story 10.3), consuming it.
  assert.match(textOf((await click(ctx, approvalWrite.ACTIONS.approve, token)).view), /^\*Pushed 6 to mail tool\*/);
  assert.equal(ctx.store.get('approval', token), undefined);
  assert.equal(mail.state.sent.length, 6);
  // Once the done marker and the token are gone, it is just invalid.
  ctx.clock.t += 30 * 60 * 1000 + 1;
  assert.equal((await click(ctx, approvalWrite.ACTIONS.approve, token)).view.blocks[0].text.text, INVALID);
});

test('a person who lost the grant between Push and Approve is refused at Approve and Cancel; nothing is consumed', async () => {
  const ctx = setup();
  const { token } = await preview(ctx);
  ctx.granted.on = false;
  const denied = messageFor(new AccessDenied({ label: 'Leads list', admin: ADMIN }));
  assert.equal((await click(ctx, approvalWrite.ACTIONS.approve, token)).view.blocks[0].text.text, denied);
  assert.equal((await click(ctx, approvalWrite.ACTIONS.cancel, token)).view.blocks[0].text.text, denied);
  assert.ok(ctx.store.get('approval', token));
  assert.equal(mail.state.sent.length, 0);
  ctx.granted.on = true;
  assert.match(textOf((await click(ctx, approvalWrite.ACTIONS.approve, token)).view), /^\*Pushed 6 to mail tool\*/);
});

test('Push re-checks the grant the same way: lost between the run and Push, it is refused and no token is made', async () => {
  const ctx = setup();
  const run = await runList(ctx);
  ctx.granted.on = false;
  const { view } = await click(ctx, approvalWrite.ACTIONS.push, run.push.value, { from: run.from });
  assert.equal(view.blocks[0].text.text, messageFor(new AccessDenied({ label: 'Leads list', admin: ADMIN })));
  assert.deepEqual(buttons(view), []);
});

test('an admin without the grant never sees the module: an approval-write resource is owner-only', async () => {
  const ctx = setup();
  await ctx.app.dispatchCommand('/alpha', { user_id: BOSS.id });
  assert.ok(!JSON.stringify(ctx.app.views[0].args.view).includes('leads:open'));
  await ctx.app.dispatchCommand('/alpha', { user_id: OWNER.id });
  assert.ok(JSON.stringify(ctx.app.views[1].args.view).includes('leads:open'));
});

test('every click re-checks the environment, the way dispatch does: hidden in this one, Push and Approve are not available', async () => {
  const ctx = setup({ env: 'prod' });
  const record = provenance.buildRecord({
    person: OWNER.id, module: 'leads', parameters: { zone: 'north' }, sql: LEADS.sql, ranAt: new Date(ctx.clock.t), rowIds: [1], rows: [{ person_id: 1, first: 'Ann', address: 'ann@home.invalid' }],
  });
  provenance.save(ctx.store, record);
  assert.equal((await click(ctx, approvalWrite.ACTIONS.push, record.runId)).view.blocks[0].text.text, NOT_AVAILABLE);
  const token = entry.create(ctx.store, {
    person: OWNER.id, module: 'leads', runId: record.runId, destination: 'mail tool', listName: 'l', rows: record.rows, idempotencyKey: 'k',
  });
  assert.equal((await click(ctx, approvalWrite.ACTIONS.approve, token)).view.blocks[0].text.text, NOT_AVAILABLE);
  assert.equal((await click(ctx, approvalWrite.ACTIONS.cancel, token)).view.blocks[0].text.text, NOT_AVAILABLE);
  assert.ok(ctx.store.get('approval', token));
});

test('Cancel consumes the token and confirms; a second Cancel or an Approve then gets the generic reply', async () => {
  const ctx = setup();
  const { token } = await preview(ctx);
  const cancelled = await click(ctx, approvalWrite.ACTIONS.cancel, token);
  assert.match(cancelled.view.blocks[0].text.text, /^\*Push cancelled\.\* Nothing was sent to mail tool\./);
  assert.equal(ctx.store.get('approval', token), undefined);
  assert.equal((await click(ctx, approvalWrite.ACTIONS.cancel, token)).view.blocks[0].text.text, INVALID);
  assert.equal((await click(ctx, approvalWrite.ACTIONS.approve, token)).view.blocks[0].text.text, INVALID);
});

test('every row skipped by the dry run: nothing to push, and no token', async () => {
  const ctx = setup({ rows: ROWS.map((r) => ({ ...r, address: null })) });
  const run = await runList(ctx);
  const { view } = await click(ctx, approvalWrite.ACTIONS.push, run.push.value, { from: run.from });
  assert.match(view.blocks[0].text.text, /^\*Nothing to push to mail tool\.\* All 7 rows would be skipped: no address \(7\)\./);
  assert.deepEqual(buttons(view), []);
});

test('with a kill switch on, the preview says sending is switched off and makes no token', async () => {
  const ctx = setup({ connectorEnv: { FIXTURE_MAIL_OFF: '1' } });
  const run = await runList(ctx);
  const { view } = await click(ctx, approvalWrite.ACTIONS.push, run.push.value, { from: run.from });
  assert.equal(view.blocks[0].text.text, messageFor(new KillSwitchOn({ system: 'Fixture mail tool', env: 'FIXTURE_MAIL_OFF', connector: 'mail' })));
  assert.deepEqual(buttons(view), []);
});

test('Push is refused when the run\'s CSV did not arrive: its result has no Push button and its record keeps no rows', async () => {
  const ctx = setup();
  ctx.app.filesFail = new Error('upload refused');
  const { view, push } = await runList(ctx);
  assert.match(JSON.stringify(view), /The CSV didn't arrive/);
  assert.equal(push, undefined, 'no Push button');
  const runId = view.blocks[0].accessory.value;
  assert.equal(ctx.store.get('provenance', runId).rows, null);
  const refused = await click(ctx, approvalWrite.ACTIONS.push, runId);
  assert.equal(refused.view.blocks[0].text.text, messageFor(new PushRefused('not_delivered')));
  assert.deepEqual(buttons(refused.view), []);
});

// Moved from the scoped-pull tests (10.1): push-field picking lives in the
// approval-write archetype now, behind the runner's reuse hook.
const SCORED_DIR = path.join(__dirname, '../fixtures/runtime/scored');
const RANKED = Object.freeze({
  ...JSON.parse(fs.readFileSync(path.join(SCORED_DIR, 'manifest.json'), 'utf8')),
  file: 'modules/ranked/manifest.json',
  sql: fs.readFileSync(path.join(SCORED_DIR, 'ranked.sql'), 'utf8'),
});
const RANKED_ROWS = JSON.parse(fs.readFileSync(path.join(SCORED_DIR, 'rows.json'), 'utf8'));
const RANKED_WRITE = Object.freeze({
  ...RANKED,
  archetype: 'approval-write',
  write: {
    connector: 'mail', operation: 'sendList', destination: 'A list', fields: ['person_id', 'name'], send: { ref: 'person_id' }, list_name: 'ranked-{run_date}',
  },
});

test('the run record keeps only the rows after the cut, in rank order, with the score, for an approval-write module; none for a scoped pull', async () => {
  const store = createStore();
  const data = { run: async () => RANKED_ROWS, describe: () => ({ available: true }) };
  const run = createRunner({ data, log: quietLog(), store, hooks: approvalWrite.pushHooks });
  const { client } = new FakeSlackApp({ views: true });
  const res = await run(RANKED_WRITE, { zone: 'north', limit: 3 }, 'U1', { client });
  assert.equal(res.failed, false);
  const runId = res.message.blocks[0].accessory.value;
  const record = store.get('provenance', runId);
  assert.deepEqual(record.rowIds, [1, 2, 10]);
  assert.deepEqual(record.rows, [
    { person_id: 1, name: 'Ann', score: 79 },
    { person_id: 2, name: 'Bo', score: 64 },
    { person_id: 10, name: 'Eve', score: 64 },
  ]);
  assert.equal(buttons(res.message).find((b) => b.action_id === approvalWrite.ACTIONS.push).value, runId);
  const plain = await run(RANKED, { zone: 'north', limit: 3 }, 'U1', { client });
  const r2 = store.get('provenance', plain.message.blocks[0].accessory.value);
  assert.equal(r2.rowIds, null);
  assert.equal(r2.rows, null);
  assert.deepEqual(buttons(plain.message), [], 'no Push on a scoped pull');
  // Without the hook (any runner the hub wiring didn't build), nothing is kept.
  const bare = createRunner({ data, log: quietLog(), store });
  const r3 = store.get('provenance', (await bare(RANKED_WRITE, { zone: 'north', limit: 3 }, 'U1', { client })).message.blocks[0].accessory.value);
  assert.equal(r3.rows, null);
  assert.deepEqual(approvalWrite.pushRowsOf(RANKED_WRITE, { rows: [{ person_id: 4, name: 'Di' }] }), { rowIds: [4], rows: [{ person_id: 4, name: 'Di' }] });
  assert.deepEqual(approvalWrite.pushRowsOf(RANKED_WRITE, { kind: 'empty' }), { rowIds: [], rows: [] });
});

test('a run whose CSV did not reach the DM keeps no push rows in its record: nothing the person didn\'t fully receive can be pushed', async () => {
  const store = createStore();
  const run = createRunner({ data: { run: async () => RANKED_ROWS, describe: () => ({ available: true }) }, log: quietLog(), store, hooks: approvalWrite.pushHooks });
  const failing = new FakeSlackApp({ views: true });
  failing.filesFail = new Error('upload refused');
  for (const opts of [{}, { client: failing.client }]) {
    const res = await run(RANKED_WRITE, { zone: 'north', limit: 3 }, 'U1', opts);
    assert.equal(res.failed, true);
    const record = store.get('provenance', res.message.blocks[0].accessory.value);
    assert.equal(record.rowIds, null);
    assert.equal(record.rows, null);
    assert.deepEqual(buttons(res.message).filter((b) => b.action_id === approvalWrite.ACTIONS.push), []);
  }
  assert.deepEqual(approvalWrite.pushRowsOf(RANKED_WRITE, { rows: [{ person_id: 4, name: 'Di' }] }, { delivered: false }), { rowIds: null, rows: null });
});
