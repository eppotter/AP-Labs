'use strict';

// Story 10.3: a failed push escalates quietly. One message to the profile's
// slack.ops_channel through the one channel-post function
// (kit/runtime/slack/channel.js), carrying the module id, a fixed reason and
// counts only, never a row value. Repeats of the same module and reason
// within 15 minutes are suppressed. With no ops_channel, or when Slack
// refuses the post, it is logged only and the person's reply is unaffected.
// Not escalated: a kill switch that refused before anything went, an invalid
// or expired preview. The schema refuses a malformed ops_channel. Through the
// hub wiring with the fake Slack client and the fixture connector
// (test/fixtures/runtime/approval), never a client's.

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile, validateProfile } = require('../../kit/lib/profile');
const access = require('../../kit/runtime/access');
const { loadRegistry, createRegistry } = require('../../kit/runtime/registry');
const { registerHubs } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { ACTIONS: FORM_ACTIONS, FORM_CALLBACK } = require('../../kit/runtime/archetypes/scoped-pull');
const { INPUT_BLOCK, VALUE_ACTION } = require('../../kit/runtime/archetypes/scoped-pull/form');
const approvalWrite = require('../../kit/runtime/archetypes/approval-write');
const { createConnectors } = require('../../kit/runtime/archetypes/approval-write/connectors');
const { createEscalator } = require('../../kit/runtime/archetypes/approval-write/escalate');
const channel = require('../../kit/runtime/slack/channel');
const { messageFor } = require('../../kit/runtime/messages');
const { PreviewInvalid } = require('../../kit/runtime/errors');
const { testLog } = require('../../kit/runtime/sdk');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime/approval');
const APP = path.join(FIX, 'app');
const PLAIN = loadProfile(path.join(FIX, 'profile.yml'));
const OPS = loadProfile(path.join(FIX, 'profile-ops.yml'));
const OPS_CHANNEL = OPS.slack.ops_channel;
const { registry } = loadRegistry({ appDir: APP, profile: PLAIN });
const LEADS = registry.module('leads');
const mail = require(path.join(APP, 'connectors/mail/connector.js'));
const OWNER = { id: PLAIN.users.find((u) => u.id === 'owner').identities.slack };
const RESULT_VIEW = { id: 'VRESULT', title: { type: 'plain_text', text: 'Leads list' }, private_metadata: JSON.stringify({ hubId: 'alpha' }) };
const MENU = { id: 'VMENU', type: 'modal', private_metadata: 'alpha', title: { type: 'plain_text', text: 'Alpha tools' } };
const MIN = 60 * 1000;

// Row values chosen so none can be mistaken for a count.
const ROWS = Object.freeze([
  { person_id: 770201, first: 'Ottoline', address: 'ottoline@home.invalid' },
  { person_id: 770202, first: 'Peregrine', address: 'peregrine@home.invalid' },
  { person_id: 770203, first: 'Quillon', address: 'quillon@home.invalid' },
  { person_id: 770204, first: 'Rosalind', address: null },
]);
const ROW_VALUES = ROWS.flatMap((r) => [String(r.person_id), r.first, r.address].filter(Boolean));

// The pull stamps ranAt from the real clock, and the list name carries its UTC
// date: freeze Date at the store's pinned time so the list name is the one the
// "never in the post" check names, on any day. The store keeps its own clock
// (setup's clock.t), which tests advance.
const PINNED = Date.parse('2026-10-25T12:00:00Z');
const LIST_NAME = 'leads-north-2026-10-25';
test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: PINNED }));
test.afterEach(() => mock.timers.reset());

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function setup(prof = OPS) {
  mail.reset();
  const clock = { t: PINNED };
  const store = createStore({ now: () => clock.t });
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  const connectorEnv = {};
  const connectors = createConnectors({ appDir: APP, modules: registry.modules, log: testLog(), env: connectorEnv });
  const data = { run: async (sql) => (sql === LEADS.sql ? ROWS.map((r) => ({ ...r })) : []), describe: () => ({ available: true }) };
  registerHubs(app, {
    registry: createRegistry({ hubs: registry.hubs, modules: registry.modules }), profile: prof, env: 'dev', log, store, data, connectors,
    canUse: (person, mod) => access.decide(prof, person.user, mod.resource),
  });
  return {
    app, log, store, clock, connectorEnv,
  };
}

const updates = (app) => app.views.filter((v) => v.method === 'update').map((v) => v.args);
const buttons = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const head = (view) => view.blocks[0].text.text;

async function click(ctx, action, value) {
  await ctx.app.dispatchAction(action, { user: OWNER, view: { ...RESULT_VIEW, hash: `h${ctx.app.viewSeq}` }, value });
  return updates(ctx.app).at(-1).view;
}

async function preview(ctx) {
  await ctx.app.dispatchAction('leads:open', { user: OWNER, view: MENU });
  const form = ctx.app.views.at(-1).args.view;
  const formId = `V${ctx.app.viewSeq}`;
  const state = { values: { [`${INPUT_BLOCK}zone`]: { [VALUE_ACTION]: { type: 'static_select', selected_option: { value: 'north' } } } } };
  await ctx.app.dispatchView(FORM_CALLBACK, { user: OWNER, view: { id: formId, hash: 'hf', title: form.title, private_metadata: form.private_metadata, state } });
  const screen = ctx.app.viewAcks.at(-1).view;
  const session = screen.blocks.find((b) => b.type === 'actions').elements[0].value;
  await ctx.app.dispatchAction(FORM_ACTIONS.confirm, { user: OWNER, view: { id: formId, hash: 'hc', title: screen.title, private_metadata: screen.private_metadata }, value: session });
  const push = buttons(updates(ctx.app).at(-1).view).find((b) => b.action_id === approvalWrite.ACTIONS.push);
  const view = await click(ctx, approvalWrite.ACTIONS.push, push.value);
  return buttons(view).find((b) => b.action_id === approvalWrite.ACTIONS.approve).value;
}

// A push that partly fails (the tool refuses 770202).
async function partlyFail(ctx) {
  const token = await preview(ctx);
  mail.state.failRefs = new Set(['770202']);
  return click(ctx, approvalWrite.ACTIONS.approve, token);
}

test('a partly failed push posts one message to the ops channel: module, reason and counts only, never a row value', async () => {
  const ctx = setup();
  const view = await partlyFail(ctx);
  assert.match(head(view), /^Sent 2 of 3 to Fixture mail tool; 1 failed\./, 'the person\'s reply is the honest one');
  assert.ok(JSON.stringify(ctx.app.views).includes(`*List name:* ${LIST_NAME}`), 'the preview names the list the post must not hold');
  assert.equal(ctx.app.posted.length, 1);
  const post = ctx.app.posted[0];
  assert.equal(post.channel, OPS_CHANNEL);
  assert.equal(post.text, 'Push needs a look: module leads, some contacts failed. Counts: 4 rows approved, 2 sent, 0 already there, 1 skipped, 1 failed or not sent. No client data is in this message; the bot\'s log has the details.');
  assert.deepEqual(Object.keys(post).sort(), ['channel', 'text', 'unfurl_links', 'unfurl_media'], 'no blocks, no attachments');
  const all = JSON.stringify(post);
  for (const value of [...ROW_VALUES, LIST_NAME, 'Leads list']) assert.ok(!all.includes(value), `the post holds no "${value}"`);
  const logged = JSON.stringify(ctx.log.lines);
  for (const value of ROW_VALUES) assert.ok(!logged.includes(value), `the log holds no "${value}"`);
});

test('the same module and reason within 15 minutes is suppressed; after that it posts again', async () => {
  const ctx = setup();
  await partlyFail(ctx);
  mail.reset();
  await partlyFail(ctx);
  assert.equal(ctx.app.posted.length, 1, 'the repeat was suppressed');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'push escalation suppressed' && l.fields.module === 'leads' && l.fields.reason === 'PartialFailure'));
  // Another reason is its own window.
  mail.reset();
  const token = await preview(ctx);
  mail.state.beforeSend = async () => { throw new Error('down'); };
  await click(ctx, approvalWrite.ACTIONS.approve, token);
  assert.equal(ctx.app.posted.length, 2);
  // 15 minutes on, the first reason posts again.
  ctx.clock.t += 15 * MIN;
  mail.reset();
  await partlyFail(ctx);
  assert.equal(ctx.app.posted.length, 3);
});

test('with no ops_channel set the escalation is logged only, and the person\'s reply is the same', async () => {
  const ctx = setup(PLAIN);
  const view = await partlyFail(ctx);
  assert.match(head(view), /^Sent 2 of 3 to Fixture mail tool; 1 failed\./);
  assert.ok(buttons(view).some((b) => b.action_id === approvalWrite.ACTIONS.retry));
  assert.deepEqual(ctx.app.posted, []);
  const line = ctx.log.lines.find((l) => l.msg.startsWith('push escalated (logged only'));
  assert.ok(line, 'logged');
  assert.deepEqual(line.fields, {
    module: 'leads', reason: 'PartialFailure', total: 4, sent: 2, already: 0, skipped: 1, failed: 1,
  });
});

test('Slack refusing the post (the bot is not in the channel) is logged only; the person\'s reply is unaffected', async () => {
  const ctx = setup();
  const tries = [];
  ctx.app.client.chat.postMessage = async (args) => {
    tries.push(args);
    throw Object.assign(new Error('An API error occurred: not_in_channel'), { data: { ok: false, error: 'not_in_channel' } });
  };
  const view = await partlyFail(ctx);
  assert.match(head(view), /^Sent 2 of 3 to Fixture mail tool; 1 failed\./);
  assert.ok(buttons(view).some((b) => b.action_id === approvalWrite.ACTIONS.retry));
  assert.equal(tries.length, 1);
  const line = ctx.log.lines.find((l) => l.msg === 'push escalation not posted (logged only)');
  assert.equal(line.fields.error, 'not_in_channel');
  assert.equal(line.level, 'warn');
});

test('not escalated: a kill switch that refused before anything went, an invalid or expired preview, and a push that went', async () => {
  const ctx = setup();
  const token = await preview(ctx);
  ctx.connectorEnv.FIXTURE_MAIL_OFF = '1';
  await click(ctx, approvalWrite.ACTIONS.approve, token);
  delete ctx.connectorEnv.FIXTURE_MAIL_OFF;
  assert.equal(head(await click(ctx, approvalWrite.ACTIONS.approve, 'f'.repeat(32))), messageFor(new PreviewInvalid()));
  ctx.clock.t += 31 * MIN;
  assert.equal(head(await click(ctx, approvalWrite.ACTIONS.approve, token)), messageFor(new PreviewInvalid()));
  const fresh = await preview(ctx);
  assert.match(head(await click(ctx, approvalWrite.ACTIONS.approve, fresh)), /^\*Pushed 3 to mail tool\*/);
  assert.deepEqual(ctx.app.posted, []);
});

test('the escalator never throws, and refuses an undeclared reason by logging it', async () => {
  const log = quietLog();
  const { escalate } = createEscalator({ store: createStore(), log, opsChannel: 'C0OPS12345' });
  assert.equal(await escalate({ client: null, module: 'leads', reason: 'Whatever', counts: {} }), 'refused');
  assert.equal(await escalate({ client: null, module: 'leads', reason: 'ConnectorFailed', counts: { total: 1 } }), 'refused', 'no client: logged');
  assert.equal(log.lines.filter((l) => l.msg === 'push escalation not posted (logged only)').length, 2);
});

test('slack.ops_channel is optional and must be a channel id (^[CG][A-Z0-9]{8,}$): the schema refuses anything else', () => {
  const base = { schema_version: 1, client: { id: 'x', name: 'X' }, users: [{ id: 'a', name: 'A', role: 'admin' }] };
  assert.equal(validateProfile(base, 't').slack, undefined, 'no default');
  assert.equal(validateProfile({ ...base, slack: {} }, 't').slack.ops_channel, undefined);
  for (const ok of ['C0OPS12345', 'G12345678', 'C0123456789AB']) assert.equal(validateProfile({ ...base, slack: { ops_channel: ok } }, 't').slack.ops_channel, ok);
  for (const bad of ['D12345678', 'U0OWNER01', 'C1234567', 'c12345678', 'C1234567#', '#brightside-ops', '', 7]) {
    assert.throws(() => validateProfile({ ...base, slack: { ops_channel: bad } }, 't'), /ops_channel/, JSON.stringify(bad));
  }
  assert.throws(() => validateProfile({ ...base, slack: { ops_channel: 'C0OPS12345', webhook: 'x' } }, 't'), /slack has unknown key "webhook"/);
  // A profile file with a malformed one refuses to load.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-ops-'));
  const file = path.join(dir, 'profile.yml');
  fs.writeFileSync(file, fs.readFileSync(path.join(FIX, 'profile.yml'), 'utf8') + 'slack: { ops_channel: "#ops" }\n');
  try {
    assert.throws(() => loadProfile(file), /ops_channel/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('channel.js posts only declared exceptions, to a channel id, with text it builds from fixed words, a module id and whole-number counts', async () => {
  const posted = [];
  const client = { chat: { postMessage: async (a) => { posted.push(a); return { ok: true }; } } };
  const fields = { module: 'leads', reason: 'PartialFailure', counts: { total: 3, failed: 1 } };
  await channel.postToChannel({ client, exception: 'write-escalation', channel: 'C0OPS12345', fields });
  assert.equal(posted[0].text, 'Push needs a look: module leads, some contacts failed. Counts: 3 rows approved, 1 failed or not sent. No client data is in this message; the bot\'s log has the details.');
  assert.deepEqual(Object.keys(channel.EXCEPTIONS), ['write-escalation'], 'V1 has one declared exception (AD-14)');
  const refused = [
    { exception: 'anything', channel: 'C0OPS12345', fields },
    { exception: 'write-escalation', channel: 'D0DMCHAN12', fields },
    { exception: 'write-escalation', channel: 'U0OWNER01', fields },
    { exception: 'write-escalation', channel: '#ops', fields },
    { exception: 'write-escalation', channel: 'C0OPS12345', fields: { ...fields, module: 'Ann <ann@home.invalid>' } },
    { exception: 'write-escalation', channel: 'C0OPS12345', fields: { ...fields, reason: 'ann@home.invalid failed' } },
    { exception: 'write-escalation', channel: 'C0OPS12345', fields: { ...fields, counts: { total: 'ann@home.invalid' } } },
    { exception: 'write-escalation', channel: 'C0OPS12345', fields: { ...fields, counts: { email: 1 } } },
    { exception: 'write-escalation', channel: 'C0OPS12345', fields: { ...fields, counts: { failed: -1 } } },
    { exception: 'write-escalation', channel: 'C0OPS12345', fields: { ...fields, counts: { failed: 1.5 } } },
  ];
  for (const args of refused) {
    await assert.rejects(channel.postToChannel({ client, ...args }), channel.ChannelPostRefused, JSON.stringify(args));
  }
  assert.equal(posted.length, 1, 'nothing refused reached Slack');
});
