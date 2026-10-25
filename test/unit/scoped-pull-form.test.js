'use strict';

// Story 9.3: a scoped-pull module's typed form, through the hub wiring with
// the fake Slack client. Open pushes the form as the module's view; every
// button (Check values, Change, Confirm, Read my request) updates that view in
// place with views.update on its id and hash, and never pushes. Sessions are
// bound to the person, close after 30 idle minutes, and Confirm runs once.
// The module is a fixture, never a client's manifest.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { createRegistry, loadRegistry } = require('../../kit/runtime/registry');
const { registerHubs, FORM_NEEDS_WINDOW, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const { updatedView } = require('../../kit/runtime/slack/modal');
const { ACTIONS, READ_NOT_YET } = require('../../kit/runtime/archetypes/scoped-pull');
const { INPUT_BLOCK, VALUE_ACTION } = require('../../kit/runtime/archetypes/scoped-pull/form');
const { SessionExpired, SessionNotYours, AlreadyConfirmed } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');
const { PLAIN_ERROR } = require('../../kit/runtime/slack/handle');
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
const RUNNING_OR_DONE = [messageFor(new AlreadyConfirmed({ done: false })), messageFor(new AlreadyConfirmed({ done: true }))];

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function setup({ canUse = () => true, views = true, modules = [PULL] } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const store = createStore({ now: clock.now });
  const app = new FakeSlackApp({ views });
  const log = quietLog();
  const registry = createRegistry({ hubs: base.hubs, modules: [...base.modules, ...modules] });
  registerHubs(app, { registry, profile, env: 'dev', log, store, canUse: (person, mod) => canUse(person, mod) });
  return { app, log, store, clock };
}

const MENU_VIEW = { id: 'VMENU', type: 'modal', private_metadata: 'alpha', title: { type: 'plain_text', text: 'Alpha tools' } };
const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const lastView = (app) => app.views.at(-1).args.view;
const blockTexts = (view) => view.blocks.map((b) => (b.text && b.text.text) || (b.elements && b.elements[0] && b.elements[0].text) || null);
const inputs = (view) => view.blocks.filter((b) => b.type === 'input');
const buttonsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const fieldsOf = (view) => view.blocks.filter((b) => b.fields).map((b) => [b.fields[0].text, b.fields[1].text]);

// The module view as Slack sends it back in a click: its id, hash, title and
// what the person typed (state), keyed the way the form names its inputs.
function moduleView(app, typed = {}) {
  const shown = app.views.at(-1);
  // The fake numbers each successful call; the last one shown is the latest.
  const id = shown.method === 'push' ? `V${app.viewSeq}` : shown.args.view_id;
  const values = {};
  for (const [name, v] of Object.entries(typed)) {
    const p = PULL.parameters.find((x) => x.name === name);
    let entry;
    if (p.enum) entry = { type: 'static_select', selected_option: v === null ? null : { value: v } };
    else if (p.type === 'integer') entry = { type: 'number_input', value: v };
    else entry = { type: 'plain_text_input', value: v };
    values[`${INPUT_BLOCK}${name}`] = { [VALUE_ACTION]: entry };
  }
  return { id, hash: `h${app.viewSeq}`, type: 'modal', private_metadata: shown.args.view.private_metadata, title: shown.args.view.title, state: { values } };
}

const sessionOf = (view) => buttonsOf(view)[0].value;

async function openForm(app, user = { id: 'U1' }) {
  await app.dispatchAction('lapsed:open', { user, view: MENU_VIEW });
  return sessionOf(lastView(app));
}

async function click(app, verb, { user = { id: 'U1' }, typed, session, view } = {}) {
  const from = view || moduleView(app, typed);
  await app.dispatchAction(ACTIONS[verb], { user, view: from, value: session || sessionOf(lastView(app)) });
  return from;
}

test('Open pushes the typed form as the module view: one input per parameter, defaults filled, no Submit', async () => {
  const { app, log } = setup();
  await app.dispatchAction('lapsed:open', { user: { id: 'U1' }, view: MENU_VIEW });
  assert.deepEqual(app.views.map((v) => v.method), ['push']);
  const { view } = calls(app, 'push')[0];
  assert.equal(view.title.text, 'Lapsed list');
  assert.equal(view.submit, undefined);
  assert.equal(view.close.text, 'Back');
  assert.equal(view.private_metadata, 'alpha');
  assert.equal(view.blocks[0].text.text, 'People who left &amp; &lt;came back&gt;.');
  const [zone, days, code] = inputs(view);
  assert.equal(zone.element.type, 'static_select');
  assert.deepEqual(zone.element.options.map((o) => o.value), ['north', 'south']);
  assert.equal(zone.optional, false);
  assert.equal(zone.element.initial_option, undefined);
  assert.deepEqual(
    { type: days.element.type, min: days.element.min_value, max: days.element.max_value, initial: days.element.initial_value, decimal: days.element.is_decimal_allowed },
    { type: 'number_input', min: '1', max: '365', initial: '90', decimal: false },
  );
  assert.deepEqual({ type: code.element.type, max: code.element.max_length, optional: code.optional, hint: code.hint.text }, { type: 'plain_text_input', max: 2, optional: true, hint: 'Two capitals.' });
  const [check] = buttonsOf(view);
  assert.equal(check.action_id, 'scoped-pull:check');
  assert.match(check.value, /^[0-9a-f]{32}$/);
  // The session id is in the button only; the view keeps the hub id and nothing else.
  assert.ok(!JSON.stringify(view).includes('U1'));
  assert.ok(log.lines.some((l) => l.msg === 'form opened' && l.fields.module === 'lapsed'));
});

test('a full form: Check values updates the same view in place to the Confirm screen, values as plain text', async () => {
  const { app } = setup();
  const session = await openForm(app);
  const from = await click(app, 'check', { typed: { zone: 'north', days: '30', code: 'AB' } });
  assert.deepEqual(app.views.map((v) => v.method), ['push', 'update']);
  const [update] = calls(app, 'update');
  assert.equal(update.view_id, from.id);
  assert.equal(update.hash, from.hash);
  assert.equal(update.view.title.text, 'Lapsed list');
  assert.equal(update.view.callback_id, 'hub:module');
  assert.equal(update.view.private_metadata, 'alpha');
  assert.deepEqual(fieldsOf(update.view), [['*Zone*', 'north'], ['*Days*', '30'], ['*Code*', 'AB']]);
  assert.ok(update.view.blocks.every((b) => !b.fields || b.fields[1].type === 'plain_text'));
  assert.deepEqual(buttonsOf(update.view).map((b) => [b.action_id, b.value]), [['scoped-pull:confirm', session], ['scoped-pull:change', session]]);
});

test('an invalid value re-renders the form with the problem, keeping the valid values', async () => {
  const { app } = setup();
  await openForm(app);
  await click(app, 'check', { typed: { zone: 'south', days: '999', code: 'ab' } });
  const view = lastView(app);
  const problems = view.blocks.find((b) => b.block_id === 'sp-problems').text.text;
  assert.equal(problems, '*Please check:*\n• Days is above 365.\n• Code is not in the expected format.');
  const [zone, days, code] = inputs(view);
  assert.equal(zone.element.initial_option.value, 'south');
  // An invalid value is never sent back as an initial value (Slack keeps what was typed).
  assert.equal(days.element.initial_value, '90');
  assert.equal(code.element.initial_value, undefined);
  assert.equal(buttonsOf(view)[0].action_id, 'scoped-pull:check');
  assert.deepEqual(app.views.map((v) => v.method), ['push', 'update']);
});

test('Change goes back to the form prefilled with the checked values; a stale Confirm then shows the form', async () => {
  const { app } = setup();
  const session = await openForm(app);
  await click(app, 'check', { typed: { zone: 'south', days: '45' } });
  const confirmView = moduleView(app);
  await click(app, 'change');
  const form = lastView(app);
  const [zone, days] = inputs(form);
  assert.equal(zone.element.initial_option.value, 'south');
  assert.equal(days.element.initial_value, '45');
  // The old Confirm screen's button no longer runs anything: Change cleared the checked values.
  await click(app, 'confirm', { view: confirmView, session });
  assert.equal(buttonsOf(lastView(app))[0].action_id, 'scoped-pull:check');
  assert.deepEqual(app.views.filter((v) => v.method === 'push').length, 1);
});

test('Confirm consumes the session and shows the confirmed values; a double Confirm is told it already ran', async () => {
  const { app } = setup();
  const session = await openForm(app);
  await click(app, 'check', { typed: { zone: 'north', days: '90' } });
  const confirmView = moduleView(app);
  await click(app, 'confirm', { view: confirmView });
  const done = lastView(app);
  assert.match(done.blocks[0].text.text, /Confirmed/);
  assert.deepEqual(fieldsOf(done), [['*Zone*', 'north'], ['*Days*', '90']]);
  assert.deepEqual(buttonsOf(done), []);
  // The replay carries the same session and the hash it was sent with.
  await click(app, 'confirm', { view: { ...confirmView, hash: `h${app.viewSeq}` }, session });
  assert.ok(RUNNING_OR_DONE.includes(blockTexts(lastView(app))[0]));
  assert.equal(blockTexts(lastView(app))[0], RUNNING_OR_DONE[1]);
  // Any other click on the consumed session is told the same.
  await click(app, 'check', { session, typed: { zone: 'north' } });
  assert.equal(blockTexts(lastView(app))[0], RUNNING_OR_DONE[1]);
});

test('a double Confirm while the first is still running runs once and is told it is running', async () => {
  const runs = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const { createScopedPull } = require('../../kit/runtime/archetypes/scoped-pull');
  const store = createStore();
  const log = quietLog();
  const sp = createScopedPull({ store, log, run: async (mod, values) => { runs.push(values); await gate; return 'ran'; } });
  const form = sp.open(PULL, 'U1');
  const id = form.blocks.find((b) => b.type === 'actions').elements[0].value;
  const shown = [];
  const show = async (m) => { shown.push(m); return 'updated'; };
  const resolve = () => ({ mod: PULL });
  await sp.click({ verb: 'check', sessionId: id, person: 'U1', state: moduleViewState({ zone: 'north' }), resolve, show });
  const first = sp.click({ verb: 'confirm', sessionId: id, person: 'U1', resolve, show });
  await sp.click({ verb: 'confirm', sessionId: id, person: 'U1', resolve, show });
  assert.equal(shown.at(-1), RUNNING_OR_DONE[0]);
  release();
  await first;
  assert.equal(shown.at(-1), 'ran');
  assert.deepEqual(runs, [{ zone: 'north', days: 90 }]);
});

function moduleViewState(typed) {
  const values = {};
  for (const [name, v] of Object.entries(typed)) values[`${INPUT_BLOCK}${name}`] = { [VALUE_ACTION]: { selected_option: { value: v } } };
  return { values };
}

test('a click by a different person is refused and leaves the owner\'s session intact', async () => {
  const { app, log } = setup();
  const session = await openForm(app, { id: 'U1' });
  await click(app, 'check', { user: { id: 'U2' }, session, typed: { zone: 'north' } });
  assert.equal(blockTexts(lastView(app))[0], NOT_YOURS);
  await click(app, 'check', { session, typed: { zone: 'north' } });
  await click(app, 'confirm', { user: { id: 'U2' }, session });
  assert.equal(blockTexts(lastView(app))[0], NOT_YOURS);
  await click(app, 'confirm', { session });
  assert.match(lastView(app).blocks[0].text.text, /Confirmed/);
  // After the owner's Confirm, a replay by someone else is still refused, not told about the run.
  await click(app, 'confirm', { user: { id: 'U2' }, session });
  assert.equal(blockTexts(lastView(app))[0], NOT_YOURS);
  assert.ok(log.lines.some((l) => l.msg === 'form click refused' && l.fields.reason === 'not-yours'));
});

test('two open sessions for one person do not collide', async () => {
  const { app } = setup();
  const a = await openForm(app);
  const viewA = moduleView(app);
  const b = await openForm(app);
  const viewB = moduleView(app);
  assert.notEqual(a, b);
  await click(app, 'check', { session: a, view: { ...viewA, state: moduleViewState({ zone: 'north' }) } });
  const confirmA = moduleView(app);
  await click(app, 'check', { session: b, view: { ...viewB, state: moduleViewState({ zone: 'south' }) } });
  assert.deepEqual(fieldsOf(lastView(app))[0], ['*Zone*', 'south']);
  await click(app, 'confirm', { session: a, view: confirmA });
  assert.deepEqual(fieldsOf(lastView(app))[0], ['*Zone*', 'north']);
  await click(app, 'confirm', { session: b });
  assert.deepEqual(fieldsOf(lastView(app))[0], ['*Zone*', 'south']);
});

test('a session closes after 30 idle minutes; activity restarts the clock; a later click is told it expired', async () => {
  const { app, clock } = setup();
  const session = await openForm(app);
  clock.advance(29 * 60 * 1000);
  await click(app, 'check', { session, typed: { zone: 'north', days: 'x' } });
  assert.ok(lastView(app).blocks.some((b) => b.block_id === 'sp-problems'));
  clock.advance(29 * 60 * 1000);
  await click(app, 'check', { session, typed: { zone: 'north' } });
  assert.equal(buttonsOf(lastView(app))[0].action_id, 'scoped-pull:confirm');
  clock.advance(30 * 60 * 1000);
  await click(app, 'confirm', { session });
  assert.equal(blockTexts(lastView(app))[0], EXPIRED);
  // A made-up or malformed session id reads as expired too.
  await click(app, 'check', { session: 'not-a-session' });
  assert.equal(blockTexts(lastView(app))[0], EXPIRED);
});

test('a hash_conflict drops the out-of-date result and logs it, without pushing or retrying', async () => {
  const { app, log } = setup();
  await openForm(app);
  const conflict = Object.assign(new Error('An API error occurred: hash_conflict'), { data: { ok: false, error: 'hash_conflict' } });
  app.viewsFail.update = conflict;
  await click(app, 'check', { typed: { zone: 'north' } });
  assert.deepEqual(app.views.map((v) => v.method), ['push', 'update']);
  const dropped = log.lines.filter((l) => l.msg === 'stale view result dropped');
  assert.deepEqual(dropped.map((l) => l.fields), [{ action: 'check', reason: 'hash_conflict' }]);
  assert.ok(!log.lines.some((l) => l.level === 'error'));
  assert.ok(!JSON.stringify(log.lines).includes('north'));
});

test('a confirmed result beaten to the view by a "still running" notice is re-sent once without the hash', async () => {
  const { app, log } = setup();
  await openForm(app);
  await click(app, 'check', { typed: { zone: 'north' } });
  const real = app.client.views.update;
  let first = true;
  app.client.views.update = async (args) => {
    if (first) {
      first = false;
      app.views.push({ method: 'update', args });
      throw Object.assign(new Error('hash_conflict'), { data: { error: 'hash_conflict' } });
    }
    return real(args);
  };
  await click(app, 'confirm');
  const updates = calls(app, 'update').slice(-2);
  assert.equal(typeof updates[0].hash, 'string');
  assert.equal(updates[1].hash, undefined);
  assert.match(updates[1].view.blocks[0].text.text, /Confirmed/);
  assert.ok(log.lines.some((l) => l.msg === 'stale view replaced by a confirmed result'));
});

test('another views.update failure is logged and the person is told plainly in the view', async () => {
  const { app, log } = setup();
  await openForm(app);
  const real = app.client.views.update;
  let first = true;
  app.client.views.update = async (args) => {
    if (first) { first = false; throw Object.assign(new Error('boom'), { data: { error: 'internal_error' } }); }
    return real(args);
  };
  await click(app, 'check', { typed: { zone: 'north' } });
  assert.equal(blockTexts(lastView(app))[0], PLAIN_ERROR);
  assert.ok(log.lines.some((l) => l.level === 'error' && l.fields.handler === 'hub:form'));
});

test('every click re-checks access: a person who lost access is refused before anything changes', async () => {
  let allowed = true;
  const { app } = setup({ canUse: () => (allowed ? 'allowed' : 'denied') });
  const session = await openForm(app);
  await click(app, 'check', { typed: { zone: 'north' } });
  allowed = false;
  await click(app, 'confirm', { session });
  assert.match(blockTexts(lastView(app))[0], /not set up|don't have access/);
  allowed = true;
  await click(app, 'confirm', { session });
  assert.match(lastView(app).blocks[0].text.text, /Confirmed/);
});

test('a module the person may not open never shows its form', async () => {
  const { app } = setup({ canUse: () => 'denied' });
  await app.dispatchAction('lapsed:open', { user: { id: 'U1' }, view: MENU_VIEW });
  assert.equal(inputs(lastView(app)).length, 0);
  assert.match(blockTexts(lastView(app))[0], /not set up|don't have access/);
});

test('a session for a module that is gone or not a scoped pull is not available', async () => {
  const { app, store } = setup();
  const session = await openForm(app);
  const s = store.get('session', session);
  store.set('session', session, { ...s, module: 'echo' });
  await click(app, 'check', { session, typed: { zone: 'north' } });
  assert.equal(blockTexts(lastView(app))[0], NOT_AVAILABLE);
});

test('Read my request says plain English is not on yet and shows the form', async () => {
  const { app } = setup();
  await openForm(app);
  await click(app, 'read');
  const view = lastView(app);
  assert.equal(view.blocks[1].elements[0].text, READ_NOT_YET);
  assert.equal(inputs(view).length, 3);
});

test('a form needs the hub window: from a message menu, the person is told to open it there', async () => {
  const { app } = setup();
  await app.dispatchAction('lapsed:open', { user: { id: 'U1' } });
  assert.deepEqual(app.responded.map((r) => r.text), [FORM_NEEDS_WINDOW]);
  await app.dispatchAction(ACTIONS.check, { user: { id: 'U1' }, value: 'x' });
  assert.deepEqual(app.responded.map((r) => r.text), [FORM_NEEDS_WINDOW, FORM_NEEDS_WINDOW]);
  assert.deepEqual(app.views, []);
});

test('if pushing the form fails, the fallback reply says to open it in the hub window, not a broken form', async () => {
  const { app } = setup();
  app.viewsFail.push = Object.assign(new Error('expired_trigger_id'), { data: { error: 'expired_trigger_id' } });
  // A click with a response_url (the fake gives none in a modal, so add one).
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

test('modal.updatedView: updates by id with the latest hash, never pushes', async () => {
  const sent = [];
  const client = { views: { update: async (args) => { sent.push(args); return { view: { hash: `n${sent.length}` } }; } } };
  const v = updatedView({ client, view: { id: 'V9', hash: 'h0' }, title: 'A title that is far too long for Slack', hubId: 'alpha' });
  assert.equal(await v.show('one'), 'updated');
  assert.equal(await v.show({ text: 'two', blocks: [{ type: 'divider' }] }), 'updated');
  assert.deepEqual(sent.map((s) => [s.view_id, s.hash]), [['V9', 'h0'], ['V9', 'n1']]);
  assert.equal(sent[0].view.title.text.length, 24);
  assert.equal(sent[0].view.close.text, 'Back');
  assert.deepEqual(sent[1].view.blocks, [{ type: 'divider' }]);
});
