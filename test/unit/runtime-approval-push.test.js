'use strict';

// Story 10.3: push once, report honestly, escalate quietly. Approve looks the
// token up, tells only the person who approved "already running" or "already
// done" (anyone else: "no longer valid"), re-checks access and the kill
// switches without consuming, then consumes the token and sends the approval
// entry's own rows through the connector under the entry's key. A double
// click, a concurrent click or a replay never sends twice; a key already used
// is "already sent today; nothing new sent". A PartialFailure with
// details.retrySafe === true offers "Retry the failed ones" (the same entry
// under a new token: same rows, same key); otherwise the AD-17 message and no
// button. Through the hub wiring with the fake Slack client, a stand-in query
// runner and the fixture connector (test/fixtures/runtime/approval), never a
// client's. The escalation itself: runtime-escalation.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadProfile } = require('../../kit/lib/profile');
const access = require('../../kit/runtime/access');
const { loadRegistry, createRegistry } = require('../../kit/runtime/registry');
const { registerHubs, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { ACTIONS: FORM_ACTIONS, FORM_CALLBACK } = require('../../kit/runtime/archetypes/scoped-pull');
const { INPUT_BLOCK, VALUE_ACTION } = require('../../kit/runtime/archetypes/scoped-pull/form');
const approvalWrite = require('../../kit/runtime/archetypes/approval-write');
const entry = require('../../kit/runtime/archetypes/approval-write/entry');
const { createConnectors } = require('../../kit/runtime/archetypes/approval-write/connectors');
const { messageFor } = require('../../kit/runtime/messages');
const {
  PreviewInvalid, AccessDenied, KillSwitchOn, ConfigFault, PartialFailure, PushRefused,
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
const ADMIN = access.adminContact(profile);
const INVALID = messageFor(new PreviewInvalid());
const MENU = { id: 'VMENU', type: 'modal', private_metadata: 'alpha', title: { type: 'plain_text', text: 'Alpha tools' } };
const HEX32 = /^[0-9a-f]{32}$/;
const MIN = 60 * 1000;

// Seven people in rank order, one with no address: 6 to send in 3 batches of 2.
const ROWS = Object.freeze([
  { person_id: 880101, first: 'Annika', address: 'annika@home.invalid' },
  { person_id: 880102, first: 'Bodhi', address: null },
  { person_id: 880103, first: 'Cyrilla', address: 'cyrilla@home.invalid' },
  { person_id: 880104, first: 'Dorotea', address: 'dorotea@home.invalid' },
  { person_id: 880105, first: 'Fenwick', address: 'fenwick@home.invalid' },
  { person_id: 880106, first: 'Gunnhild', address: 'gunnhild@home.invalid' },
  { person_id: 880110, first: 'Evander', address: 'evander@home.invalid' },
]);
const SENDABLE = ROWS.filter((r) => r.address).map((r) => r.person_id);

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// The hubs over the fixture app with a fresh fixture tool. connectorEnv is
// the object the connector reads its kill switches from: a test may flip one
// at any point. granted.on decides the PUSH_LEADS grant; env the environment.
function setup({ env = 'dev', prof = profile, rows = ROWS } = {}) {
  mail.reset();
  const clock = { t: Date.parse('2026-10-25T12:00:00Z') };
  const store = createStore({ now: () => clock.t });
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  const connectorEnv = {};
  const granted = { on: true };
  const connectors = createConnectors({ appDir: APP, modules: registry.modules, log: testLog(), env: connectorEnv });
  const canUse = (person, mod) => (access.decide(prof, person.user, mod.resource) === 'allowed' && granted.on ? 'allowed' : 'denied');
  const data = { run: async (sql) => (sql === LEADS.sql ? rows.map((r) => ({ ...r })) : []), describe: () => ({ available: true }) };
  registerHubs(app, {
    registry: createRegistry({ hubs: registry.hubs, modules: registry.modules }), profile: prof, env, log, store, data, connectors, canUse,
  });
  return {
    app, log, store, clock, connectors, granted, connectorEnv,
  };
}

const updates = (app) => app.views.filter((v) => v.method === 'update').map((v) => v.args);
const buttons = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const textOf = (view) => view.blocks.map((b) => (b.text && b.text.text) || (b.elements && b.elements.map((e) => e.text && (e.text.text || e.text)).join(' ')) || '').join('\n');
const head = (view) => view.blocks[0].text.text;
const sentRefs = () => mail.state.sent.map((c) => c.ref);
const RESULT_VIEW = { id: 'VRESULT', title: { type: 'plain_text', text: 'Leads list' }, private_metadata: JSON.stringify({ hubId: 'alpha' }) };

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
  const view = updates(ctx.app).at(-1).view;
  return { push: buttons(view).find((b) => b.action_id === approvalWrite.ACTIONS.push), from: { ...from, hash: `h${ctx.app.viewSeq}` } };
}

async function click(ctx, action, value, { user = OWNER } = {}) {
  const before = updates(ctx.app).length;
  await ctx.app.dispatchAction(action, { user, view: { ...RESULT_VIEW, hash: `h${ctx.app.viewSeq}` }, value });
  const after = updates(ctx.app);
  assert.equal(after.length, before + 1, 'each click updates the view it came from once');
  return after.at(-1).view;
}

// Runs the list, presses Push and returns the Approve token.
async function preview(ctx, user = OWNER) {
  const run = await runList(ctx, user);
  const view = await click(ctx, approvalWrite.ACTIONS.push, run.push.value, { user });
  return buttons(view).find((b) => b.action_id === approvalWrite.ACTIONS.approve).value;
}

const approve = (ctx, token, opts) => click(ctx, approvalWrite.ACTIONS.approve, token, opts);

// A promise a test resolves by hand: holds a push in flight.
function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { p, open };
}

test('Approve pushes the entry\'s rows once and reports honest counts: "Pushed 6, skipped 1, failed 0", in the same view, nothing posted', async () => {
  const ctx = setup();
  const token = await preview(ctx);
  const view = await approve(ctx, token);
  assert.equal(head(view), '*Pushed 6 to mail tool*, skipped 1, failed 0. List: leads-north-2026-10-25.');
  assert.match(textOf(view), /Skipped rows were never sent: no address \(1\)\./);
  assert.deepEqual(buttons(view), [], 'no Retry on a push that went');
  assert.deepEqual(sentRefs(), SENDABLE, 'only the rows the person saw, each once, in order');
  assert.deepEqual(mail.state.sent[0], { ref: 880101, first: 'Annika', address: 'annika@home.invalid' }, 'write.send maps the entry\'s fields');
  assert.equal(mail.state.requests, 3, 'three batches of 2');
  assert.equal(ctx.store.get('approval', token), undefined, 'the token is used up');
  const marker = ctx.store.done('approval', token);
  assert.equal(marker.person, OWNER.id, 'the done marker names the person (decision 5)');
  assert.equal(marker.state, 'done');
  assert.deepEqual(marker.result.counts, {
    total: 7, sent: 6, already: 0, skipped: 1, failed: 0,
  });
  assert.deepEqual(ctx.app.posted, [], 'a push that went is not escalated');
  const logged = JSON.stringify(ctx.log.lines);
  assert.ok(!logged.includes('home.invalid') && !logged.includes('Annika') && !logged.includes('880101'), 'the log holds counts, never row data');
});

test('the push reads only the approval entry: never the run record or the button, and never more than the rows approved (Q10)', async () => {
  const ctx = setup();
  const run = await runList(ctx);
  const view = await click(ctx, approvalWrite.ACTIONS.push, run.push.value);
  const token = buttons(view).find((b) => b.action_id === approvalWrite.ACTIONS.approve).value;
  // The run record changes (or expires) after the preview: the push doesn't care.
  const record = ctx.store.get('provenance', run.push.value);
  ctx.store.set('provenance', run.push.value, { ...record, rows: [...record.rows, { person_id: 990001, first: 'Extra', address: 'extra@home.invalid' }] });
  ctx.clock.t += 25 * MIN;
  await approve(ctx, token);
  assert.deepEqual(sentRefs(), SENDABLE);
});

test('rows the preview skipped never reach the connector, even one whose apply re-checks nothing (review R1-1)', async () => {
  const ctx = setup();
  mail.state.trusting = true;
  const token = await preview(ctx);
  assert.deepEqual([...ctx.store.get('approval', token).skippedIds], ['880102']);
  const view = await approve(ctx, token);
  assert.equal(head(view), '*Pushed 6 to mail tool*, skipped 1, failed 0. List: leads-north-2026-10-25.');
  assert.deepEqual(mail.state.received.map((c) => c.ref), SENDABLE, 'apply was given exactly the rows previewed as "will send"');
  assert.deepEqual(sentRefs(), SENDABLE);
  assert.ok(!mail.state.received.some((c) => c.ref === 880102));
  // The retry entry keeps the skipped ids: a retry leaves them out too.
  mail.reset();
  const ctx2 = setup();
  mail.state.trusting = true;
  mail.state.failRefs = new Set(['880104']);
  const first = await approve(ctx2, await preview(ctx2));
  const retry = buttons(first).find((b) => b.action_id === approvalWrite.ACTIONS.retry).value;
  assert.deepEqual(ctx2.store.get('approval', retry).rows.map((r) => r.person_id), [880104], 'the retry holds only the failed row');
  mail.state.failRefs = new Set();
  await click(ctx2, approvalWrite.ACTIONS.retry, retry);
  assert.ok(!mail.state.received.some((c) => c.ref === 880102));
  assert.deepEqual([...sentRefs()].sort(), [...SENDABLE].sort());
});

test('a skip the preview cannot match to exactly one row by its row id refuses the preview: no token, nothing sent', async () => {
  const ctx = setup();
  mail.state.skipRef = () => 'no-such-row-1';
  const run = await runList(ctx);
  const view = await click(ctx, approvalWrite.ACTIONS.push, run.push.value);
  assert.equal(head(view), messageFor(new ConfigFault({ admin: ADMIN })));
  assert.deepEqual(buttons(view), []);
  assert.equal(mail.state.requests, 0);
  assert.notEqual(head(view), messageFor(new PushRefused('empty')));
});

test('an approval entry over the 5,000-row cap is refused before anything is consumed or sent (Q10)', async () => {
  const ctx = setup();
  const rows = Array.from({ length: 5001 }, (_, i) => ({ person_id: i + 1, first: 'P', address: `p${i}@home.invalid` }));
  const token = entry.create(ctx.store, {
    person: OWNER.id, module: 'leads', runId: 'r', destination: 'mail tool', listName: 'big', rows, idempotencyKey: entry.idempotencyKey('big', rows.map((r) => r.person_id)),
  });
  assert.equal(head(await approve(ctx, token)), messageFor(new ConfigFault({ admin: ADMIN })));
  assert.ok(ctx.store.get('approval', token), 'not consumed');
  assert.equal(mail.state.requests, 0);
});

test('two Approve clicks in the same tick push once: one reports the counts, the other "already running"', async () => {
  const ctx = setup();
  const token = await preview(ctx);
  const view = { ...RESULT_VIEW, hash: 'hx' };
  await Promise.all([
    ctx.app.dispatchAction(approvalWrite.ACTIONS.approve, { user: OWNER, view, value: token }),
    ctx.app.dispatchAction(approvalWrite.ACTIONS.approve, { user: OWNER, view, value: token }),
  ]);
  assert.deepEqual(sentRefs(), SENDABLE, 'each contact sent exactly once');
  const heads = updates(ctx.app).slice(-2).map((u) => head(u.view)).sort();
  assert.deepEqual(heads, ['*Pushed 6 to mail tool*, skipped 1, failed 0. List: leads-north-2026-10-25.', "You already approved this push and it's still running, so I won't send it twice."]);
});

test('a second click while the push is running: the pusher hears "already running", anyone else "no longer valid"; after it, the pusher hears "already done" with the counts', async () => {
  const ctx = setup();
  const token = await preview(ctx);
  const hold = gate();
  const started = gate();
  mail.state.beforeSend = async ({ index }) => { if (index === 0) { started.open(); await hold.p; } };
  const first = ctx.app.dispatchAction(approvalWrite.ACTIONS.approve, { user: OWNER, view: { ...RESULT_VIEW, hash: 'h1' }, value: token });
  await started.p;
  assert.equal(head(await approve(ctx, token)), "You already approved this push and it's still running, so I won't send it twice.");
  assert.equal(head(await approve(ctx, token, { user: OTHER })), INVALID, 'someone else learns nothing about it');
  hold.open();
  await first;
  assert.deepEqual(sentRefs(), SENDABLE);
  const again = head(await approve(ctx, token));
  assert.equal(again, "You already approved this push, so it ran once and I won't send it again. *Pushed 6 to mail tool*, skipped 1, failed 0. List: leads-north-2026-10-25.");
  assert.equal(head(await approve(ctx, token, { user: OTHER })), INVALID);
  // A replayed payload (the same token, any number of times) sends nothing more.
  for (let i = 0; i < 3; i += 1) await approve(ctx, token);
  assert.deepEqual(sentRefs(), SENDABLE);
  // Once the done marker has gone (10 minutes), it is simply invalid.
  ctx.clock.t += 10 * MIN;
  assert.equal(head(await approve(ctx, token)), INVALID);
  assert.deepEqual(sentRefs(), SENDABLE);
});

test('a key already used (the same rows to the same list today) is "already sent today; nothing new sent", never "Pushed 6" (N6)', async () => {
  const ctx = setup();
  await approve(ctx, await preview(ctx));
  assert.equal(mail.state.sent.length, 6);
  // A new pull of the same rows the same day: a new token, the same key.
  const second = await preview(ctx);
  const view = await approve(ctx, second);
  assert.equal(head(view), "*Already sent today; nothing new sent.* mail tool already has this list with these rows, so I didn't send it again (skipped 1). List: leads-north-2026-10-25.");
  assert.ok(!textOf(view).includes('Pushed'));
  assert.equal(mail.state.sent.length, 6, 'nothing sent twice');
  assert.equal(mail.state.requests, 3, 'the tool was not even called');
  assert.equal(ctx.store.done('approval', second).result.outcome, 'replayed');
  assert.deepEqual(ctx.app.posted, []);
});

test('Cancel then Approve: "no longer valid", never "already done"', async () => {
  const ctx = setup();
  const token = await preview(ctx);
  await click(ctx, approvalWrite.ACTIONS.cancel, token);
  assert.equal(head(await approve(ctx, token)), INVALID);
  assert.equal(mail.state.requests, 0);
});

test('a partial failure that is safe to retry offers "Retry the failed ones": the same entry under a new token; the retry sends only the failed contacts, each once (DEP-013)', async () => {
  const ctx = setup();
  const token = await preview(ctx);
  const stored = ctx.store.get('approval', token);
  mail.state.failRefs = new Set(['880104']);
  const view = await approve(ctx, token);
  const words = messageFor(new PartialFailure('x', {
    system: 'Fixture mail tool', succeeded: 5, failed: 1, retrySafe: true,
  }), { admin: ADMIN });
  assert.equal(head(view), `${words} Skipped 1.`);
  const retry = buttons(view).find((b) => b.action_id === approvalWrite.ACTIONS.retry);
  assert.ok(retry, 'Retry the failed ones is offered');
  assert.equal(retry.text.text, 'Retry the failed ones');
  assert.match(retry.value, HEX32);
  assert.notEqual(retry.value, token);
  // The retry entry: same person, list and first key; only the failed row,
  // under the derived key (review R2-1).
  const again = ctx.store.get('approval', retry.value);
  assert.deepEqual({ ...again, rows: [...again.rows], skipped: [...again.skipped], skippedIds: [...again.skippedIds] }, {
    ...stored,
    rows: stored.rows.filter((r) => r.person_id === 880104),
    skipped: [],
    skippedIds: [],
    idempotencyKey: crypto.createHash('sha256').update(JSON.stringify([stored.idempotencyKey, 'retry', ['880104']])).digest('hex'),
    originalKey: stored.idempotencyKey,
    retry: true,
  });
  assert.equal(entry.retryKey(stored.idempotencyKey, [880104]), again.idempotencyKey);
  assert.deepEqual(sentRefs(), SENDABLE.filter((id) => id !== 880104));
  // The tool takes it now; Retry sends the failed one only.
  mail.state.failRefs = new Set();
  const done = await click(ctx, approvalWrite.ACTIONS.retry, retry.value);
  assert.equal(head(done), '*Retried 1 that failed: sent 1, failed 0.* List: leads-north-2026-10-25.');
  assert.ok(!textOf(done).includes('Pushed'));
  assert.deepEqual([...sentRefs()].sort(), [...SENDABLE].sort(), 'every contact once, none twice');
  assert.equal(new Set(sentRefs()).size, sentRefs().length);
  // The retry token is used up too, and tied to the person.
  assert.equal(head(await click(ctx, approvalWrite.ACTIONS.retry, retry.value, { user: OTHER })), INVALID);
  assert.match(head(await click(ctx, approvalWrite.ACTIONS.retry, retry.value)), /^You already approved this push, so it ran once/);
  assert.equal(new Set(sentRefs()).size, 6);
});

test('the first token after a partial failure: its pusher hears "already done" with the counts, and the live Retry is offered again', async () => {
  const ctx = setup();
  const token = await preview(ctx);
  mail.state.failRefs = new Set(['880104']);
  const first = await approve(ctx, token);
  const retry = buttons(first).find((b) => b.action_id === approvalWrite.ACTIONS.retry).value;
  const view = await approve(ctx, token);
  assert.match(head(view), /^You already approved this push, so it ran once and I won't send it again\. Sent 5 of 6 to mail tool; 1 failed, skipped 1\. Nothing was sent twice/);
  assert.equal(buttons(view).find((b) => b.action_id === approvalWrite.ACTIONS.retry).value, retry);
});

test('Retry re-checks the grant and the environment the way dispatch does (N12)', async () => {
  const ctx = setup();
  const token = await preview(ctx);
  mail.state.failRefs = new Set(['880104']);
  const retry = buttons(await approve(ctx, token)).find((b) => b.action_id === approvalWrite.ACTIONS.retry).value;
  ctx.granted.on = false;
  assert.equal(head(await click(ctx, approvalWrite.ACTIONS.retry, retry)), messageFor(new AccessDenied({ label: 'Leads list', admin: ADMIN })));
  assert.ok(ctx.store.get('approval', retry), 'nothing consumed');
  ctx.granted.on = true;
  // Hidden in this environment: not available.
  const prod = setup({ env: 'prod' });
  const t = entry.create(prod.store, {
    person: OWNER.id, module: 'leads', runId: 'r', destination: 'mail tool', listName: 'l', rows: [{ person_id: 1, first: 'A', address: 'a@home.invalid' }], idempotencyKey: 'k',
  });
  assert.equal(head(await click(prod, approvalWrite.ACTIONS.retry, t)), NOT_AVAILABLE);
  assert.ok(prod.store.get('approval', t));
  assert.equal(mail.state.requests, 0);
});

test('a partial failure that is not safe to retry (details.retrySafe not true): the AD-17 admin message and no button', async () => {
  const store = createStore();
  const log = quietLog();
  const shown = [];
  const stub = {
    id: 'mail',
    system: 'Fixture mail tool',
    killSwitch: () => null,
    write: {
      sendList: async () => {
        throw new PartialFailure('3 of 6', {
          connector: 'mail', system: 'Fixture mail tool', operation: 'sendList', succeeded: 5, failed: 1, failedRefs: ['880104'], retrySafe: false,
        });
      },
    },
  };
  const aw = approvalWrite.createApprovalWrite({
    store, log, connectors: { get: () => stub }, admin: ADMIN,
  });
  const token = entry.create(store, {
    person: OWNER.id, module: 'leads', runId: 'r', destination: 'mail tool', listName: 'l', rows: ROWS, skipped: [{ reason: 'no address' }], idempotencyKey: 'k',
  });
  await aw.click({
    verb: 'approve', value: token, person: OWNER.id, resolve: () => ({ mod: LEADS }), show: async (m) => { shown.push(m); },
  });
  const view = shown.at(-1);
  assert.equal(head(view), `Sent 5 of 6 to Fixture mail tool; 1 failed. Please tell ${ADMIN} before trying again. Skipped 1.`);
  assert.deepEqual(buttons(view), [], 'no Retry button');
  assert.equal(store.done('approval', token).result.retryToken, null);
});

test('a kill switch on before Approve refuses without consuming, and is not escalated: the connector\'s own and the global one', async () => {
  for (const name of ['FIXTURE_MAIL_OFF', 'APLABS_WRITES_OFF']) {
    const ctx = setup({ prof: loadProfile(path.join(FIX, 'profile-ops.yml')) });
    const token = await preview(ctx);
    ctx.connectorEnv[name] = '1';
    const view = await approve(ctx, token);
    assert.equal(head(view), messageFor(new KillSwitchOn({ system: 'Fixture mail tool', env: name, connector: 'mail' })), name);
    assert.ok(ctx.store.get('approval', token), `${name}: the token is not consumed`);
    assert.equal(mail.state.requests, 0);
    assert.deepEqual(ctx.app.posted, [], `${name}: not escalated`);
    // Switched back on, the same token pushes.
    delete ctx.connectorEnv[name];
    assert.match(head(await approve(ctx, token)), /^\*Pushed 6 to mail tool\*/);
  }
});

test('a kill switch flipped mid-push stops the rest and says honestly what went: 2 sent, the rest not; escalated', async () => {
  for (const name of ['FIXTURE_MAIL_OFF', 'APLABS_WRITES_OFF']) {
    const ctx = setup({ prof: loadProfile(path.join(FIX, 'profile-ops.yml')) });
    const token = await preview(ctx);
    mail.state.beforeSend = async ({ index }) => { if (index === 0) ctx.connectorEnv[name] = '1'; };
    const view = await approve(ctx, token);
    const words = messageFor(new KillSwitchOn({
      system: 'Fixture mail tool', env: name, connector: 'mail', sent: { batches: 1, items: 2, recorded: true },
    }), { admin: ADMIN });
    assert.equal(head(view), `${words} Skipped 1.`, name);
    assert.ok(!head(view).includes('Pushed'));
    assert.deepEqual(sentRefs(), SENDABLE.slice(0, 2));
    assert.deepEqual(buttons(view), []);
    assert.deepEqual(ctx.store.done('approval', token).result.counts, {
      total: 7, sent: 2, already: 0, skipped: 1, failed: 4,
    });
    assert.equal(ctx.app.posted.length, 1, `${name}: escalated once`);
    assert.match(ctx.app.posted[0].text, /sending was switched off partway through/);
  }
});

test('an outage, a rejected sign-in and a reused key with other rows: honest words, no Retry, each escalated', async () => {
  const ctx = setup({ prof: loadProfile(path.join(FIX, 'profile-ops.yml')) });
  // An outage on the second batch.
  let token = await preview(ctx);
  mail.state.beforeSend = async ({ index }) => { if (index === 1) throw new Error('tool down'); };
  let view = await approve(ctx, token);
  assert.match(head(view), /^I couldn't finish sending to Fixture mail tool: 2 items were sent before it stopped/);
  assert.deepEqual(buttons(view), []);
  assert.match(ctx.app.posted.at(-1).text, /module leads, the push failed\. Counts: 7 rows approved, 2 sent, 0 already there, 1 skipped, 4 failed or not sent\./);
  // A rejected sign-in, before anything went: never offered a retry.
  mail.reset();
  token = await preview(ctx);
  mail.state.beforeSend = async () => { throw Object.assign(new Error('nope'), { status: 401 }); };
  view = await approve(ctx, token);
  assert.match(head(view), /turned down my sign-in/);
  assert.deepEqual(buttons(view), []);
  assert.match(ctx.app.posted.at(-1).text, /the tool turned down the sign-in/);
  // The same key with different rows: IdempotencyConflict, escalated (N7).
  mail.reset();
  mail.state.beforeSend = null;
  token = await preview(ctx);
  const stored = ctx.store.get('approval', token);
  await approve(ctx, token);
  const forged = entry.create(ctx.store, { ...stored, rows: stored.rows.slice(0, 3) });
  view = await approve(ctx, forged);
  assert.match(head(view), /already sent to Fixture mail tool with different contents/);
  assert.match(ctx.app.posted.at(-1).text, /the same list key was already used with different rows/);
  assert.equal(new Set(sentRefs()).size, sentRefs().length, 'nothing sent twice');
  assert.equal(ctx.app.posted.length, 3);
});

// Review R2-1: a connector that declares perItemIdempotency (so the contract
// says retrySafe) but whose apply ignores the per-item keys and whose system
// never dedupes. The archetype must not depend on that promise: a retry
// holds only the failed rows, under its own derived key, so nothing goes twice.
const { defineConnector } = require('../../kit/runtime/connectors/contract');

function lyingTool() {
  const system = { received: [], refuse: new Set(), badRef: null };
  const lying = defineConnector({
    id: 'lying',
    system: 'Lying tool',
    auth: { env: [] },
    killSwitchEnv: 'LYING_TOOL_OFF',
    rateLimit: { perSecond: 1000, batchSize: 2 },
    connect: () => ({
      // Takes every contact it is given, every time; refuses the refuse set.
      send(batch) {
        const failedRefs = [];
        for (const c of batch) {
          if (system.refuse.has(String(c.ref))) failedRefs.push(system.badRef ? system.badRef(c) : String(c.ref));
          else system.received.push(c.ref);
        }
        return { taken: batch.length - failedRefs.length, failedRefs };
      },
    }),
    write: {
      sendList: {
        perItemIdempotency: true, // the promise it does not keep
        plan: ({ contacts }) => ({ skipped: contacts.filter((c) => !c.address).map((c) => ({ ref: String(c.ref), reason: 'no address' })) }),
        async apply({ contacts }, ctx) {
          let taken = 0;
          const failedRefs = [];
          // No filtering, no keys: whatever it is given goes.
          for (const batch of ctx.batches(contacts)) {
            const res = await ctx.request(() => ctx.client.send(batch), { size: batch.length });
            taken += res.taken;
            failedRefs.push(...res.failedRefs);
          }
          if (failedRefs.length) throw new PartialFailure('some failed', { succeeded: taken, failed: failedRefs.length, failedRefs });
          return { added: taken, alreadyAdded: 0 };
        },
      },
    },
  });
  const m = new Map();
  const instance = lying.create({ log: testLog(), env: {}, idempotency: { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } } });
  return { system, instance };
}

// The archetype over the lying tool, with a preview-shaped entry for ROWS.
function lyingSetup() {
  const store = createStore();
  const log = quietLog();
  const { system, instance } = lyingTool();
  const aw = approvalWrite.createApprovalWrite({
    store, log, connectors: { get: () => instance }, admin: ADMIN,
  });
  const ids = ROWS.map((r) => r.person_id);
  const token = entry.create(store, {
    person: OWNER.id,
    module: 'leads',
    runId: 'r',
    destination: 'mail tool',
    listName: 'leads-north-2026-10-25',
    rows: ROWS,
    skipped: [{ ref: '880102', reason: 'no address' }],
    skippedIds: ['880102'],
    idempotencyKey: entry.idempotencyKey('leads-north-2026-10-25', ids),
  });
  const shown = [];
  const press = async (verb, value, person = OWNER.id) => {
    await aw.click({
      verb, value, person, resolve: () => ({ mod: LEADS }), show: async (msg) => { shown.push(msg); },
    });
    return shown.at(-1);
  };
  return {
    store, log, system, token, press,
  };
}

test('R2-1: through a connector that ignores its per-item keys, the retry sends only the failed row and nothing goes twice', async () => {
  const ctx = lyingSetup();
  ctx.system.refuse = new Set(['880104']);
  const first = await ctx.press('approve', ctx.token);
  assert.match(head(first), /^Sent 5 of 6 to Lying tool; 1 failed\. Nothing was sent twice/);
  const retry = buttons(first).find((b) => b.action_id === approvalWrite.ACTIONS.retry).value;
  const stored = ctx.store.get('approval', retry);
  assert.deepEqual(stored.rows.map((r) => r.person_id), [880104], 'the retry entry holds only the failed row');
  assert.equal(stored.idempotencyKey, entry.retryKey(stored.originalKey, ['880104']));
  assert.equal(stored.retry, true);
  ctx.system.refuse = new Set();
  const done = await ctx.press('retry', retry);
  assert.equal(head(done), '*Retried 1 that failed: sent 1, failed 0.* List: leads-north-2026-10-25.');
  assert.ok(!JSON.stringify(done).includes('Pushed'), 'never "Pushed 6"');
  assert.deepEqual([...ctx.system.received].sort(), [...SENDABLE].sort(), 'every row once');
  assert.equal(ctx.system.received.length, 6, 'nothing twice');
  assert.deepEqual(buttons(done), []);
});

test('R2-1: a retry that fails again offers a retry of the rows still failing; the same failed set reuses the same derived key, and nothing goes twice', async () => {
  const ctx = lyingSetup();
  ctx.system.refuse = new Set(['880104', '880106']);
  const first = await ctx.press('approve', ctx.token);
  const r1 = buttons(first).find((b) => b.action_id === approvalWrite.ACTIONS.retry).value;
  const key1 = ctx.store.get('approval', r1).idempotencyKey;
  // Both fail again: the same failed set, so the same derived key.
  const second = await ctx.press('retry', r1);
  assert.equal(head(second), 'Retried 2 that failed: sent 0, failed 2. Nothing was sent twice, so trying again is safe: it sends only the ones that still failed. List: leads-north-2026-10-25.');
  const r2 = buttons(second).find((b) => b.action_id === approvalWrite.ACTIONS.retry).value;
  assert.notEqual(r2, r1);
  assert.equal(ctx.store.get('approval', r2).idempotencyKey, key1, 'replay-safe: the same failed set, the same key');
  // One of them goes: the next retry holds only the other, under its own key.
  ctx.system.refuse = new Set(['880106']);
  const third = await ctx.press('retry', r2);
  assert.match(head(third), /^Retried 2 that failed: sent 1, failed 1\./);
  const r3 = buttons(third).find((b) => b.action_id === approvalWrite.ACTIONS.retry).value;
  const s3 = ctx.store.get('approval', r3);
  assert.deepEqual(s3.rows.map((r) => r.person_id), [880106]);
  assert.equal(s3.idempotencyKey, entry.retryKey(s3.originalKey, ['880106']));
  ctx.system.refuse = new Set();
  assert.equal(head(await ctx.press('retry', r3)), '*Retried 1 that failed: sent 1, failed 0.* List: leads-north-2026-10-25.');
  assert.deepEqual([...ctx.system.received].sort(), [...SENDABLE].sort());
  assert.equal(ctx.system.received.length, 6, 'nothing twice across four tries');
  // Used retry tokens: "already done" for the person, invalid for anyone else
  // (the archetype shows these as plain text; the hub puts them in a section).
  assert.match(await ctx.press('retry', r3), /^You already approved this push, so it ran once and I won't send it again\. \*Retried 1 that failed/);
  assert.equal(await ctx.press('retry', r3, OTHER.id), INVALID);
  assert.equal(ctx.system.received.length, 6);
});

test('R2-1: a failed ref that can\'t be matched to exactly one row offers no Retry: the admin message, no button', async () => {
  // A ref naming no row, and an email (the contract masks it: never id-shaped).
  for (const badRef of [() => '990999', (c) => `${c.address}`]) {
    const ctx = lyingSetup();
    ctx.system.refuse = new Set(['880104']);
    ctx.system.badRef = badRef;
    const view = await ctx.press('approve', ctx.token);
    assert.equal(head(view), `Sent 5 of 6 to Lying tool; 1 failed. Please tell ${ADMIN} before trying again. Skipped 1.`);
    assert.deepEqual(buttons(view), [], 'no Retry');
    assert.equal(ctx.store.done('approval', ctx.token).result.retryToken, null);
    assert.ok(ctx.log.lines.some((l) => l.msg.startsWith('push retry not offered')));
  }
});
