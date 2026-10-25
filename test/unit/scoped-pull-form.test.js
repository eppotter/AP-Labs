'use strict';

// Story 9.3: a scoped-pull module's typed form, through the hub wiring with
// the fake Slack client. Open pushes the form as the module's view, with
// "Check values" as its submit (Slack rejects a modal with an input block and
// no submit; the fake does too). The submission is answered in the ack:
// errors beside the inputs, or an update to the Confirm screen. Confirm and
// Change are buttons that update the view in place with views.update on its
// id and hash, and never push. Sessions are bound to the person, close after
// 30 idle minutes, and Confirm runs once. The module is a fixture, never a
// client's manifest. Confirm runs the list (Story 9.5) against a stand-in
// data source that answers two rows; running and delivery are tested in
// scoped-pull-run.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { createRegistry, loadRegistry } = require('../../kit/runtime/registry');
const { registerHubs, FORM_NEEDS_WINDOW, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const { updatedView } = require('../../kit/runtime/slack/modal');
const { createScopedPull, ACTIONS, FORM_CALLBACK } = require('../../kit/runtime/archetypes/scoped-pull');
const { INPUT_BLOCK, VALUE_ACTION } = require('../../kit/runtime/archetypes/scoped-pull/form');
const { SessionExpired, SessionNotYours, AlreadyConfirmed } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');
const { handleView, PLAIN_ERROR } = require('../../kit/runtime/slack/handle');
const { createStore } = require('../../kit/runtime/store');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime');
const profile = loadProfile(path.join(FIX, 'profile.yml'));
const { registry: base } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });

const PULL = Object.freeze({
  id: 'lapsed',
  hub: 'alpha',
  label: 'Lapsed list',
  description: 'People who left & <came back>.',
  resource: 'R',
  archetype: 'scoped-pull',
  environments: ['dev'],
  parameters: [
    { name: 'zone', label: 'Zone', type: 'string', enum: ['north', 'south'], required: true },
    { name: 'days', label: 'Days', type: 'integer', min: 1, max: 365, default: 90, required: true },
    { name: 'code', label: 'Code', type: 'string', pattern: '[A-Z]{2}', max_length: 2, description: 'Two capitals.' },
  ],
  query: 'lapsed.sql',
  sql: 'SELECT 1 AS one',
});

const EXPIRED = messageFor(new SessionExpired());
const NOT_YOURS = messageFor(new SessionNotYours());
const RUNNING = messageFor(new AlreadyConfirmed({ done: false }));
const DONE = messageFor(new AlreadyConfirmed({ done: true }));
const SESSION = /^[0-9a-f]{32}$/;

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// What the person sees: the latest successful views call or view_submission
// update, with the id and hash Slack would send back in the next click.
function screenOf(app) {
  let current = null;
  let acks = 0;
  return {
    get: () => current,
    afterCall(seqBefore) {
      if (app.viewSeq === seqBefore) return;
      const last = app.views.at(-1);
      current = { id: last.method === 'update' ? last.args.view_id : `V${app.viewSeq}`, hash: `h${app.viewSeq}`, view: last.args.view };
    },
    afterSubmit() {
      const ack = app.viewAcks.at(-1);
      acks += 1;
      if (ack && ack.response_action === 'update') current = { id: current.id, hash: `hs${acks}`, view: ack.view };
    },
  };
}

// A stand-in query runner: two rows for any query, each call recorded.
function fakeData(rows = [{ name: 'Ann', zone: 'north' }, { name: 'Bo', zone: 'north' }]) {
  const runs = [];
  return { runs, run: async (sql, params, opts) => { runs.push({ sql, params, opts }); return rows; }, describe: () => ({ available: true }) };
}

function setup({ canUse = () => true, views = true, modules = [PULL], data = fakeData() } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const store = createStore({ now: clock.now });
  const app = new FakeSlackApp({ views });
  const log = quietLog();
  const registry = createRegistry({ hubs: base.hubs, modules: [...base.modules, ...modules] });
  registerHubs(app, { registry, profile, env: 'dev', log, store, data, canUse: (person, mod) => canUse(person, mod) });
  return { app, log, store, clock, data, screen: screenOf(app) };
}

const MENU_VIEW = { id: 'VMENU', type: 'modal', private_metadata: 'alpha', title: { type: 'plain_text', text: 'Alpha tools' } };
const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const blockTexts = (view) => view.blocks.map((b) => (b.text && b.text.text) || (b.elements && b.elements[0] && b.elements[0].text) || null);
const inputs = (view) => view.blocks.filter((b) => b.type === 'input');
const buttonsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const fieldsOf = (view) => view.blocks.filter((b) => b.fields).map((b) => [b.fields[0].text, b.fields[1].text]);

// What the person typed, keyed the way the form names its inputs.
function stateOf(typed = {}) {
  const values = {};
  for (const [name, v] of Object.entries(typed)) {
    const p = PULL.parameters.find((x) => x.name === name);
    let entry;
    if (p.enum) entry = { type: 'static_select', selected_option: v === null ? null : { value: v } };
    else if (p.type === 'integer') entry = { type: 'number_input', value: v };
    else entry = { type: 'plain_text_input', value: v };
    values[`${INPUT_BLOCK}${name}`] = { [VALUE_ACTION]: entry };
  }
  return { values };
}

// The view as Slack sends it back in a click or submission.
const sent = (s, state) => ({
  id: s.id, hash: s.hash, type: 'modal', private_metadata: s.view.private_metadata, title: s.view.title, callback_id: s.view.callback_id, state,
});

async function openForm(ctx, user = { id: 'U1' }) {
  const before = ctx.app.viewSeq;
  await ctx.app.dispatchAction('lapsed:open', { user, view: MENU_VIEW });
  ctx.screen.afterCall(before);
  return ctx.screen.get();
}

// Submits the form on the screen (or the one given). Returns the ack payload.
async function submit(ctx, typed, { user = { id: 'U1' }, form = ctx.screen.get() } = {}) {
  await ctx.app.dispatchView(FORM_CALLBACK, { user, view: sent(form, stateOf(typed)) });
  ctx.screen.afterSubmit();
  return ctx.app.viewAcks.at(-1);
}

// Clicks Confirm or Change on the screen (or the one given).
async function click(ctx, verb, { user = { id: 'U1' }, session, from = ctx.screen.get() } = {}) {
  const before = ctx.app.viewSeq;
  const value = session || buttonsOf(from.view)[0].value;
  await ctx.app.dispatchAction(ACTIONS[verb], { user, view: sent(from, { values: {} }), value });
  ctx.screen.afterCall(before);
  return ctx.screen.get();
}

const sessionOfForm = (s) => s.view.private_metadata.split(':')[1];

test('the fake rejects a modal with an input block and no submit, as Slack does', async () => {
  const app = new FakeSlackApp({ views: true });
  await assert.rejects(
    app.client.views.push({ trigger_id: 'T', view: { type: 'modal', blocks: [{ type: 'input', label: { type: 'plain_text', text: 'x' }, element: {} }] } }),
    (err) => err.data.error === 'invalid_arguments',
  );
});

test('Open pushes the typed form: one input per parameter, defaults filled, submit "Check values"', async () => {
  const ctx = setup();
  const { app, log } = ctx;
  const form = await openForm(ctx);
  assert.deepEqual(app.views.map((v) => v.method), ['push']);
  const { view } = form;
  assert.equal(view.title.text, 'Lapsed list');
  assert.deepEqual(view.submit, { type: 'plain_text', text: 'Check values', emoji: false });
  assert.equal(view.callback_id, FORM_CALLBACK);
  assert.equal(view.close.text, 'Back');
  // The hub id and the session id, nothing else.
  assert.match(view.private_metadata, /^alpha:[0-9a-f]{32}$/);
  assert.equal(view.blocks[0].text.text, 'People who left &amp; &lt;came back&gt;.');
  const [zone, days, code] = inputs(view);
  assert.equal(zone.block_id, 'sp-input:zone');
  assert.equal(zone.element.type, 'static_select');
  assert.deepEqual(zone.element.options.map((o) => o.value), ['north', 'south']);
  assert.equal(zone.optional, false);
  assert.equal(zone.element.initial_option, undefined);
  assert.deepEqual(
    { type: days.element.type, min: days.element.min_value, max: days.element.max_value, initial: days.element.initial_value, decimal: days.element.is_decimal_allowed },
    { type: 'number_input', min: '1', max: '365', initial: '90', decimal: false },
  );
  assert.deepEqual({ type: code.element.type, max: code.element.max_length, optional: code.optional, hint: code.hint.text }, { type: 'plain_text_input', max: 2, optional: true, hint: 'Two capitals.' });
  // No buttons on the form: no "Read my request" until Story 9.4.
  assert.deepEqual(buttonsOf(view), []);
  assert.ok(!JSON.stringify(view).includes('U1'));
  assert.ok(log.lines.some((l) => l.msg === 'form opened' && l.fields.module === 'lapsed'));
});

test('a full form: the submission is acked with an update to the Confirm screen, values as plain text', async () => {
  const ctx = setup();
  const form = await openForm(ctx);
  const session = sessionOfForm(form);
  const ack = await submit(ctx, { zone: 'north', days: '30', code: 'AB' });
  assert.equal(ack.response_action, 'update');
  const { view } = ack;
  assert.equal(view.title.text, 'Lapsed list');
  assert.equal(view.callback_id, 'hub:module');
  assert.equal(view.private_metadata, 'alpha');
  assert.equal(view.submit, undefined);
  assert.deepEqual(inputs(view), []);
  assert.deepEqual(fieldsOf(view), [['*Zone*', 'north'], ['*Days*', '30'], ['*Code*', 'AB']]);
  assert.ok(view.blocks.every((b) => !b.fields || b.fields[1].type === 'plain_text'));
  assert.deepEqual(buttonsOf(view).map((b) => [b.action_id, b.value]), [['scoped-pull:confirm', session], ['scoped-pull:change', session]]);
  // Answered in the ack: no views call.
  assert.deepEqual(ctx.app.views.map((v) => v.method), ['push']);
});

test('invalid values are acked as errors beside their inputs, worded from the label, never the typed text', async () => {
  const ctx = setup();
  await openForm(ctx);
  const ack = await submit(ctx, { zone: 'north', days: '999', code: '<!channel>' });
  assert.deepEqual(ack, {
    response_action: 'errors',
    errors: { 'sp-input:days': 'Days is above 365.', 'sp-input:code': 'Code is longer than 2 characters.' },
  });
  const missing = await submit(ctx, {});
  assert.deepEqual(missing.errors, { 'sp-input:zone': 'Zone is needed.' });
  // The form stays (an errors ack changes nothing else), and a fixed submit goes through.
  const ok = await submit(ctx, { zone: 'south' });
  assert.equal(ok.response_action, 'update');
  assert.deepEqual(fieldsOf(ok.view), [['*Zone*', 'south'], ['*Days*', '90']]);
});

test('Change updates the view in place to the form (with its submit), prefilled; a stale Confirm then shows the form', async () => {
  const ctx = setup();
  const form = await openForm(ctx);
  await submit(ctx, { zone: 'south', days: '45' });
  const confirmScreen = ctx.screen.get();
  const back = await click(ctx, 'change');
  const [update] = calls(ctx.app, 'update');
  assert.equal(update.view_id, confirmScreen.id);
  assert.equal(update.hash, confirmScreen.hash);
  assert.equal(back.view.submit.text, 'Check values');
  assert.equal(back.view.callback_id, FORM_CALLBACK);
  assert.equal(back.view.private_metadata, form.view.private_metadata);
  const [zone, days] = inputs(back.view);
  assert.equal(zone.element.initial_option.value, 'south');
  assert.equal(days.element.initial_value, '45');
  // The old Confirm screen's button no longer runs anything: Change cleared the checked values.
  const again = await click(ctx, 'confirm', { from: { ...confirmScreen, hash: ctx.screen.get().hash } });
  assert.equal(again.view.callback_id, FORM_CALLBACK);
  assert.equal(ctx.app.views.filter((v) => v.method === 'push').length, 1);
});

test('Confirm consumes the session, runs the list and shows the result with its values; a double Confirm is told it already ran', async () => {
  const ctx = setup();
  const form = await openForm(ctx);
  await submit(ctx, { zone: 'north', days: '90' });
  const confirmScreen = ctx.screen.get();
  const done = await click(ctx, 'confirm');
  assert.equal(done.view.blocks[0].text.text, '*Lapsed list: 2 rows.*');
  // The list's SQL ran once (the other run reads the data version, Story 9.6).
  assert.equal(ctx.data.runs.filter((r) => !r.sql.includes('fixture_meta')).length, 1);
  assert.deepEqual(fieldsOf(done.view), [['*Zone*', 'north'], ['*Days*', '90']]);
  assert.deepEqual(buttonsOf(done.view), []);
  // The replay carries the same session.
  const replay = await click(ctx, 'confirm', { from: { ...confirmScreen, hash: ctx.screen.get().hash } });
  assert.equal(blockTexts(replay.view)[0], DONE);
  // A resubmitted form on the consumed session is told the same.
  const resubmit = await submit(ctx, { zone: 'north' }, { form });
  assert.equal(blockTexts(resubmit.view)[0], DONE);
});

test('a double Confirm while the first is still running runs once and is told it is running', async () => {
  const runs = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = createStore();
  const sp = createScopedPull({ store, log: quietLog(), run: async (mod, values) => { runs.push(values); await gate; return { message: 'ran', failed: false }; } });
  const form = sp.open(PULL, 'U1');
  const id = form.modal.privateMetadata.split(':')[1];
  const shown = [];
  const show = async (m) => { shown.push(m); return 'updated'; };
  const resolve = () => ({ mod: PULL });
  assert.equal(sp.submit({ sessionId: id, person: 'U1', state: stateOf({ zone: 'north' }), resolve }).errors, undefined);
  const first = sp.click({ verb: 'confirm', sessionId: id, person: 'U1', resolve, show });
  await sp.click({ verb: 'confirm', sessionId: id, person: 'U1', resolve, show });
  assert.equal(shown.at(-1), RUNNING);
  assert.match(shown[0].text, /running/);
  release();
  await first;
  assert.equal(shown.at(-1), 'ran');
  assert.deepEqual(runs, [{ zone: 'north', days: 90 }]);
});

test('a submission or click by a different person is refused and leaves the owner\'s session intact', async () => {
  const ctx = setup();
  const form = await openForm(ctx, { id: 'U1' });
  const session = sessionOfForm(form);
  const theirs = await submit(ctx, { zone: 'north' }, { user: { id: 'U2' } });
  assert.equal(theirs.response_action, 'update');
  assert.equal(blockTexts(theirs.view)[0], NOT_YOURS);
  await submit(ctx, { zone: 'north' }, { form });
  const confirmScreen = ctx.screen.get();
  const refused = await click(ctx, 'confirm', { user: { id: 'U2' }, session });
  assert.equal(blockTexts(refused.view)[0], NOT_YOURS);
  const mine = await click(ctx, 'confirm', { session, from: { ...confirmScreen, hash: ctx.screen.get().hash } });
  assert.match(mine.view.blocks[0].text.text, /2 rows/);
  // After the owner's Confirm, a replay by someone else is still refused, not told about the run.
  const replay = await click(ctx, 'confirm', { user: { id: 'U2' }, session });
  assert.equal(blockTexts(replay.view)[0], NOT_YOURS);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'form click refused' && l.fields.reason === 'not-yours'));
});

test('two open sessions for one person do not collide', async () => {
  const ctx = setup();
  const a = await openForm(ctx);
  const b = await openForm(ctx);
  assert.notEqual(sessionOfForm(a), sessionOfForm(b));
  const ackA = await submit(ctx, { zone: 'north' }, { form: a });
  const ackB = await submit(ctx, { zone: 'south' }, { form: b });
  assert.deepEqual(fieldsOf(ackB.view)[0], ['*Zone*', 'south']);
  const doneA = await click(ctx, 'confirm', { from: { id: a.id, hash: 'x', view: ackA.view } });
  assert.deepEqual(fieldsOf(doneA.view)[0], ['*Zone*', 'north']);
  const doneB = await click(ctx, 'confirm', { from: { id: b.id, hash: 'y', view: ackB.view } });
  assert.deepEqual(fieldsOf(doneB.view)[0], ['*Zone*', 'south']);
});

test('a session closes after 30 idle minutes; activity restarts the clock; a later submit or click is told it expired', async () => {
  const ctx = setup();
  const form = await openForm(ctx);
  ctx.clock.advance(29 * 60 * 1000);
  assert.equal((await submit(ctx, { zone: 'north', days: 'x' })).response_action, 'errors');
  ctx.clock.advance(29 * 60 * 1000);
  assert.equal((await submit(ctx, { zone: 'north' })).response_action, 'update');
  ctx.clock.advance(30 * 60 * 1000);
  const late = await click(ctx, 'confirm');
  assert.equal(blockTexts(late.view)[0], EXPIRED);
  const lateSubmit = await submit(ctx, { zone: 'north' }, { form });
  assert.equal(blockTexts(lateSubmit.view)[0], EXPIRED);
  // A made-up or malformed session reads as expired too.
  const forged = await submit(ctx, { zone: 'north' }, { form: { ...form, view: { ...form.view, private_metadata: 'alpha:nope' } } });
  assert.equal(blockTexts(forged.view)[0], EXPIRED);
});

test('a hash_conflict on a click drops the out-of-date result and logs it, without pushing or retrying', async () => {
  const ctx = setup();
  await openForm(ctx);
  await submit(ctx, { zone: 'north' });
  ctx.app.viewsFail.update = Object.assign(new Error('An API error occurred: hash_conflict'), { data: { ok: false, error: 'hash_conflict' } });
  await click(ctx, 'change');
  assert.deepEqual(ctx.app.views.map((v) => v.method), ['push', 'update']);
  const dropped = ctx.log.lines.filter((l) => l.msg === 'stale view result dropped');
  assert.deepEqual(dropped.map((l) => l.fields), [{ action: 'change', reason: 'hash_conflict' }]);
  assert.ok(!ctx.log.lines.some((l) => l.level === 'error'));
  assert.ok(!JSON.stringify(ctx.log.lines).includes('north'));
});

test('a confirmed result beaten to the view by a "still running" notice is re-sent once without the hash', async () => {
  const ctx = setup();
  await openForm(ctx);
  await submit(ctx, { zone: 'north' });
  const real = ctx.app.client.views.update;
  // The "Running…" notice and the result's first try both meet a conflict.
  let conflicts = 2;
  ctx.app.client.views.update = async (args) => {
    if (conflicts > 0) {
      conflicts -= 1;
      ctx.app.views.push({ method: 'update', args });
      throw Object.assign(new Error('hash_conflict'), { data: { error: 'hash_conflict' } });
    }
    return real(args);
  };
  await click(ctx, 'confirm');
  const updates = calls(ctx.app, 'update');
  assert.equal(updates.length, 3);
  assert.match(updates[0].view.blocks[0].text.text, /Running/);
  assert.equal(typeof updates[1].hash, 'string');
  assert.equal(updates[2].hash, undefined);
  assert.match(updates[2].view.blocks[0].text.text, /2 rows/);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'stale view result dropped' && l.fields.action === 'confirm'));
  assert.ok(ctx.log.lines.some((l) => l.msg === 'stale view replaced by a confirmed result'));
});

test('another views.update failure on a click is logged and the person is told plainly in the view', async () => {
  const ctx = setup();
  await openForm(ctx);
  await submit(ctx, { zone: 'north' });
  const real = ctx.app.client.views.update;
  let first = true;
  ctx.app.client.views.update = async (args) => {
    if (first) { first = false; throw Object.assign(new Error('boom'), { data: { error: 'internal_error' } }); }
    return real(args);
  };
  const shown = await click(ctx, 'change');
  assert.equal(blockTexts(shown.view)[0], PLAIN_ERROR);
  assert.ok(ctx.log.lines.some((l) => l.level === 'error' && l.fields.handler === 'hub:form'));
});

test('every submission and click re-checks access: a person who lost access is refused before anything changes', async () => {
  let allowed = true;
  const ctx = setup({ canUse: () => (allowed ? 'allowed' : 'denied') });
  await openForm(ctx);
  allowed = false;
  const refusedSubmit = await submit(ctx, { zone: 'north' });
  assert.match(blockTexts(refusedSubmit.view)[0], /not set up|don't have access/);
  allowed = true;
  const form = await openForm(ctx);
  await submit(ctx, { zone: 'north' }, { form });
  allowed = false;
  const refused = await click(ctx, 'confirm');
  assert.match(blockTexts(refused.view)[0], /not set up|don't have access/);
});

test('a module the person may not open never shows its form', async () => {
  const ctx = setup({ canUse: () => 'denied' });
  const shown = await openForm(ctx);
  assert.equal(inputs(shown.view).length, 0);
  assert.match(blockTexts(shown.view)[0], /not set up|don't have access/);
});

test('a session for a module that is gone or not a scoped pull is not available, and the refusal log names the user', async () => {
  const ctx = setup();
  const form = await openForm(ctx);
  const session = sessionOfForm(form);
  ctx.store.set('session', session, { ...ctx.store.get('session', session), module: 'echo' });
  const ack = await submit(ctx, { zone: 'north' });
  assert.equal(blockTexts(ack.view)[0], NOT_AVAILABLE);
  const warn = ctx.log.lines.find((l) => l.msg === 'hub action refused' && l.fields.reason === 'not available');
  assert.ok(warn);
  assert.ok(Object.hasOwn(warn.fields, 'user'));
});

test('a form needs the hub window: from a message menu, the person is told to open it there', async () => {
  const { app } = setup();
  await app.dispatchAction('lapsed:open', { user: { id: 'U1' } });
  assert.deepEqual(app.responded.map((r) => r.text), [FORM_NEEDS_WINDOW]);
  await app.dispatchAction(ACTIONS.confirm, { user: { id: 'U1' }, value: 'x' });
  assert.deepEqual(app.responded.map((r) => r.text), [FORM_NEEDS_WINDOW, FORM_NEEDS_WINDOW]);
  assert.deepEqual(app.views, []);
});

test('if pushing the form fails, the fallback reply says to open it in the hub window, not a broken form', async () => {
  const { app } = setup();
  app.viewsFail.push = Object.assign(new Error('expired_trigger_id'), { data: { error: 'expired_trigger_id' } });
  const responded = [];
  const fn = app.actionListeners.find((l) => l.pattern.test('lapsed:open')).fn;
  await fn({
    action: { action_id: 'lapsed:open', value: 'lapsed' },
    body: { user: { id: 'U1' }, view: MENU_VIEW, container: { type: 'view' }, trigger_id: 'T' },
    ack: async () => {},
    respond: async (m) => { responded.push(m); },
    client: app.client,
  });
  assert.deepEqual(responded.map((r) => r.text), [FORM_NEEDS_WINDOW]);
  assert.ok(responded.every((r) => !r.blocks));
});

test('modal.updatedView: updates by id with the latest hash, never pushes, and carries a message\'s modal options', async () => {
  const sentArgs = [];
  const client = { views: { update: async (args) => { sentArgs.push(args); return { view: { hash: `n${sentArgs.length}` } }; } } };
  const v = updatedView({ client, view: { id: 'V9', hash: 'h0' }, title: 'A title that is far too long for Slack', hubId: 'alpha' });
  assert.equal(await v.show('one'), 'updated');
  assert.equal(await v.show({ text: 'two', blocks: [{ type: 'divider' }], modal: { submit: 'Go', callbackId: 'cb', privateMetadata: 'alpha:x' } }), 'updated');
  assert.deepEqual(sentArgs.map((s) => [s.view_id, s.hash]), [['V9', 'h0'], ['V9', 'n1']]);
  assert.equal(sentArgs[0].view.title.text.length, 24);
  assert.equal(sentArgs[0].view.close.text, 'Back');
  assert.equal(sentArgs[0].view.submit, undefined);
  assert.equal(sentArgs[0].view.private_metadata, 'alpha');
  assert.deepEqual(sentArgs[1].view.blocks, [{ type: 'divider' }]);
  assert.deepEqual([sentArgs[1].view.submit.text, sentArgs[1].view.callback_id, sentArgs[1].view.private_metadata], ['Go', 'cb', 'alpha:x']);
});

test('handleView acks with the work\'s payload; if the work throws, it logs and acks with onError\'s payload', async () => {
  const log = quietLog();
  const acked = [];
  const ack = async (p) => { acked.push(p); };
  await handleView('v', () => ({ response_action: 'clear' }), { log, onError: () => 'never' })({ ack });
  await handleView('v', () => { throw new Error('boom'); }, { log, onError: () => ({ response_action: 'update', view: 'x' }) })({ ack });
  assert.deepEqual(acked, [{ response_action: 'clear' }, { response_action: 'update', view: 'x' }]);
  assert.ok(log.lines.some((l) => l.level === 'error' && l.msg === 'handler failed' && l.fields.handler === 'v'));
});

test('a submission whose work fails is acked with the plain error in the view, never left hanging', async () => {
  const ctx = setup();
  const form = await openForm(ctx);
  // A broken view state makes reading the values throw.
  await ctx.app.dispatchView(FORM_CALLBACK, { user: { id: 'U1' }, view: { ...sent(form), state: { get values() { throw new Error('bad state'); } } } });
  const ack = ctx.app.viewAcks.at(-1);
  assert.equal(ack.response_action, 'update');
  assert.equal(blockTexts(ack.view)[0], PLAIN_ERROR);
  assert.ok(SESSION.test(sessionOfForm(form)));
});
