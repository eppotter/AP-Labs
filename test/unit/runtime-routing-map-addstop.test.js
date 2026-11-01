'use strict';

// Story 19.5 (plan brightside-v1 D8): Add a stop, the fifth screen of the
// routing-map archetype (kit/runtime/archetypes/routing-map/addstop.js on
// Plan a route's editor), through the hub on the fake Slack app: its form,
// its client search (an external_select answered by the hub's
// block_suggestion listener), Add (adapter.addStop and the engine's
// insertStop), and Remove. The synthetic day (test/fixtures/routing-map/
// day.json: crews v1 and v2 in zone north, v2 out in the data, v3 in zone
// south), read by the fixture adapter's clients() and addStop().
// mapPoints is the fixture's stand-in; the renderer is the real one.
//
// Every way out has a test: Back to the day, Back and the X (view_closed),
// closing while Add works, no client found, the search failing or too slow,
// a client that can't be added, the day changed, a stop added then removed,
// an expired session (Add and the search), an expired trigger, the data
// unavailable, the map not ready, access withdrawn (a click and a search),
// and a search or click from someone else's view.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { createRegistry } = require('../../kit/runtime/registry');
const { registerHubs, NOT_AVAILABLE, MAP_NEEDS_WINDOW } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { createMapFiles } = require('../../kit/runtime/slack/image');
const { renderPng } = require('../../kit/runtime/routing-map');
const { DataUnavailable, RoutingFault } = require('../../kit/runtime/errors');
const { ROUTE_WORDS, ADD_WORDS } = require('../../kit/runtime/messages');
const {
  parseValue, queryOf, lengthWords, driveDelta, LENGTHS,
} = require('../../kit/runtime/archetypes/routing-map/addstop');
const { LISTEN_PATTERN, SCREEN_ACTIONS, SEARCH_ACTION } = require('../../kit/runtime/archetypes/routing-map');
const { FakeSlackApp, invalidOptionsAck, invalidElements } = require('../fixtures/fake-slack');
const fx = require('../fixtures/routing-map/adapter');

const profile = loadProfile(path.join(__dirname, '../fixtures/profiles/routing-editor.yml'));
const noDepot = loadProfile(path.join(__dirname, '../fixtures/profiles/routing-audience.yml'));
const DAY = fx.DAY;
const HUB = Object.freeze({
  id: 'ops', command: '/ops', name: 'Ops', description: 'Ops tools', sees: ['data'],
});
const MENU = Object.freeze({ id: 'VMENU', type: 'modal', private_metadata: 'ops' });
const ADMIN = '<@UADMIN>';
const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-02T15:00:00Z');
const U = Object.freeze({
  dispatch: { id: 'UDISPATCH', name: 'dispatch' },
  leadA: { id: 'ULEADA', name: 'lead a' },
  leadB: { id: 'ULEADB', name: 'lead b' },
  member: { id: 'UMEMBER', name: 'member' },
});
const DATA_DOWN = "The data isn't available right now, so I can't answer that. The app is still running; please tell your admin.";

const moduleOf = (over = {}) => Object.freeze({
  id: 'route-add-stop',
  hub: 'ops',
  label: 'Add a stop',
  description: 'Add a stop to a crew\'s day',
  resource: 'ROUTING_ALL_CREWS',
  archetype: 'routing-map',
  screen: 'add-stop',
  environments: ['dev'],
  adapter: 'adapter.js',
  createAdapter: fx.createAdapter,
  ...over,
});
const ADD = moduleOf();
// An adapter whose functions a test replaces.
const adapterWith = (over) => moduleOf({ createAdapter: (args) => ({ ...fx.createAdapter(args), ...over(fx.createAdapter(args)) }) });

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function setup({
  data = fx.fakeData(), mapPoints = fx.fakeMapPoints(), store = createStore(), canUse, mods = [ADD], profile: withProfile = profile, searchTimeoutMs,
} = {}) {
  const app = new FakeSlackApp({ views: true });
  app.checkHashes = true;
  const log = quietLog();
  const mapFiles = createMapFiles({
    store, client: app.client, log, sweeping: () => true, sleep: async () => {},
  });
  registerHubs(app, {
    registry: createRegistry({ hubs: [HUB], modules: mods }), profile: withProfile, env: 'dev', log, store, data,
    mapFiles, ...(canUse ? { canUse } : {}),
    routingMap: {
      mapPoints, render: renderPng, editor: { mapDelayMs: 0 }, ...(searchTimeoutMs ? { searchTimeoutMs } : {}),
    },
  });
  return {
    app, log, store, data, mapPoints,
  };
}

const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const lastView = (app) => app.views.at(-1).args.view;
const blocksOf = (view, type) => view.blocks.filter((b) => b.type === type);
const texts = (view) => blocksOf(view, 'section').filter((b) => b.text).map((b) => b.text.text);
const contexts = (view) => blocksOf(view, 'context').flatMap((b) => b.elements.map((e) => e.text));
const elements = (view) => blocksOf(view, 'actions').flatMap((b) => b.elements);
const buttons = (view) => elements(view).filter((e) => e.type === 'button');
const buttonText = (view) => buttons(view).map((b) => b.text.text);
const element = (view, id) => elements(view).find((e) => e.action_id === `routing-map:${id}`);
const imageOf = (view) => blocksOf(view, 'image')[0];
const rows = (view) => texts(view).filter((t) => /^\S+ \*\d\d:\d\d /.test(t));
const menus = (view) => blocksOf(view, 'section').filter((b) => b.accessory && b.accessory.type === 'overflow');
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await new Promise((r) => { setImmediate(r); }); };
const refused = (ctx, action, reason) => ctx.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.action === action && l.fields.reason === reason);
const version = (view) => {
  const btn = buttons(view).find((b) => /^\d+:(add|remove|place|back)$/.test(b.value || ''));
  return Number(btn.value.split(':')[0]);
};

function fromView(ctx) {
  const v = lastView(ctx.app);
  return {
    id: 'V1', type: 'modal', hash: ctx.app.hashes.get('V1'), private_metadata: v.private_metadata, title: v.title,
  };
}
function tap(ctx, which, value, { user = U.dispatch, view } = {}) {
  return ctx.app.dispatchAction(`routing-map:${which}`, { user, view: view || fromView(ctx), value });
}
function choose(ctx, which, action, { user = U.dispatch, view } = {}) {
  return ctx.app.dispatchAction(`routing-map:${which}`, { user, view: view || fromView(ctx), action });
}
async function search(ctx, value, { user = U.dispatch, view } = {}) {
  const before = ctx.app.optionAcks.length;
  assert.equal(await ctx.app.dispatchOptions(SEARCH_ACTION, { user, view: view || fromView(ctx), value }), 1);
  assert.equal(ctx.app.optionAcks.length, before + 1, 'acked once');
  return ctx.app.optionAcks.at(-1).options;
}
// Opens Add a stop and shows v1's day (or the lead's own).
async function dayOf(ctx, { user = U.dispatch } = {}) {
  await ctx.app.dispatchAction(`${ADD.id}:open`, { user, view: MENU });
  await tap(ctx, 'show', 'show', { user });
  await settle();
  return lastView(ctx.app);
}
async function openForm(ctx, opts = {}) {
  const view = await dayOf(ctx, opts);
  await tap(ctx, 'add', `${version(view)}:add`, opts);
  await settle();
  return lastView(ctx.app);
}
// Opens the form, finds the client by search, picks it, a length and a window.
async function filled(ctx, { query = 'kim', minutes = '60', window = 'afternoon', user = U.dispatch } = {}) {
  await openForm(ctx, { user });
  const [option] = await search(ctx, query, { user });
  assert.ok(option, `a client for "${query}"`);
  await choose(ctx, 'client', { type: 'external_select', selected_option: option }, { user });
  await choose(ctx, 'length', { type: 'static_select', selected_option: { value: minutes, text: { type: 'plain_text', text: minutes } } }, { user });
  await choose(ctx, 'window', { type: 'static_select', selected_option: { value: window, text: { type: 'plain_text', text: window } } }, { user });
  return lastView(ctx.app);
}
async function place(ctx, opts = {}) {
  const view = lastView(ctx.app);
  await tap(ctx, 'place', `${version(view)}:place`, opts);
  await settle();
  return lastView(ctx.app);
}

// --- the screen, its actions and the fake ------------------------------------------------------

test('the hub hears add, client, length, window, place, back and remove; Add a stop takes the editor\'s actions and its own, no other screen takes them', () => {
  for (const id of ['add', 'client', 'length', 'window', 'place', 'back', 'remove']) assert.ok(LISTEN_PATTERN.test(`routing-map:${id}`), id);
  assert.equal(SEARCH_ACTION, 'routing-map:client');
  assert.deepEqual([...SCREEN_ACTIONS['add-stop']].sort(), ['add', 'back', 'change', 'client', 'crew', 'day', 'length', 'move', 'optimize', 'place', 'remove', 'reset', 'show', 'window']);
  for (const screen of ['views', 'route-editor', 'cancellation', 'crew-out']) {
    for (const a of ['add', 'client', 'length', 'window', 'place', 'back', 'remove']) assert.ok(!SCREEN_ACTIONS[screen].has(a), `${screen} refuses ${a}`);
  }
});

test('the pure helpers: button values, the search text, lengths and drive words', () => {
  assert.deepEqual(parseValue('3:add'), { version: 3, what: 'add' });
  assert.deepEqual(parseValue('12:remove'), { version: 12, what: 'remove' });
  for (const bad of ['0:add', 'add', '3:', '3:open', '03:add', `${'9'.repeat(10)}:add`, 3, null]) assert.equal(parseValue(bad), null, String(bad));
  assert.equal(queryOf('k'), null);
  assert.equal(queryOf('  '), null);
  assert.equal(queryOf(' Ki  m '), 'Ki m');
  assert.equal(Array.from(queryOf('x'.repeat(80))).length, 50);
  assert.equal(queryOf(42), null);
  assert.deepEqual(LENGTHS, [30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240]);
  // One list: the form's lengths are the engine's, which adapters read through the sdk.
  assert.equal(LENGTHS, require('../../kit/runtime/routing').ADD_STOP_LENGTHS);
  assert.equal(LENGTHS, require('../../kit/runtime/sdk').routing.ADD_STOP_LENGTHS);
  assert.ok(Object.isFrozen(LENGTHS));
  assert.deepEqual([30, 60, 75, 240].map(lengthWords), ['30 min', '1 h', '1 h 15 min', '4 h']);
  assert.deepEqual([9, 0, -3].map(driveDelta), ['+9 min drive', 'no extra drive', '\u22123 min drive']);
});

test('the Slack fake refuses what Slack refuses for an external_select and its options', () => {
  const opt = (text, value = 'v') => ({ text: { type: 'plain_text', text }, value });
  assert.equal(invalidOptionsAck({ options: [opt('Kim Sato')] }), null);
  assert.equal(invalidOptionsAck({ options: [] }), null);
  assert.match(invalidOptionsAck({ options: Array.from({ length: 101 }, (_, i) => opt(`n${i}`, `v${i}`)) }), /at most 100 options/);
  assert.match(invalidOptionsAck({ options: [opt('x'.repeat(76))] }), /1 to 75 characters/);
  assert.match(invalidOptionsAck({ options: [{ text: { type: 'mrkdwn', text: 'a' }, value: 'v' }] }), /plain_text/);
  assert.match(invalidOptionsAck({ options: [opt('a', '')] }), /value/);
  assert.match(invalidOptionsAck({ options: [opt('a', 'v'.repeat(151))] }), /value/);
  assert.match(invalidOptionsAck(undefined), /carries options/);
  assert.match(invalidOptionsAck({ options: [], option_groups: [] }), /exactly one/);
  const view = (e) => ({ type: 'modal', blocks: [{ type: 'actions', elements: [{ type: 'external_select', action_id: 'a', ...e }] }] });
  assert.equal(invalidElements(view({ placeholder: { type: 'plain_text', text: 'Client' }, min_query_length: 2 })), null);
  assert.match(invalidElements(view({ options: [opt('a')] })), /takes no options/);
  assert.match(invalidElements(view({ min_query_length: -1 })), /min_query_length/);
  assert.match(invalidElements(view({ placeholder: { type: 'mrkdwn', text: 'x' } })), /placeholder/);
  assert.match(invalidElements(view({ initial_option: opt('x'.repeat(76)) })), /1 to 75/);
  assert.match(invalidElements({ type: 'modal', blocks: [{ type: 'context', elements: [{ type: 'external_select', action_id: 'a' }] }] }), /cannot hold a select/);
});

// --- not ready ---------------------------------------------------------------------------------

test('exit, the map not ready: no Office, or an adapter with no addStop() or clients(), shows "not available"; nothing is read', async () => {
  const noAdd = moduleOf({ createAdapter: (args) => { const { addStop, ...rest } = fx.createAdapter(args); return rest; } });
  const noSearch = moduleOf({ createAdapter: (args) => { const { clients, ...rest } = fx.createAdapter(args); return rest; } });
  const cases = [
    ['no Office', { profile: noDepot }, ADD, 'no routing.depot in the profile'],
    ['no addStop()', { mods: [noAdd] }, noAdd, 'the adapter has no addStop or clients()'],
    ['no clients()', { mods: [noSearch] }, noSearch, 'the adapter has no addStop or clients()'],
  ];
  for (const [what, opts, mod, reason] of cases) {
    const ctx = setup(opts);
    await ctx.app.dispatchAction(`${mod.id}:open`, { user: U.dispatch, view: MENU });
    const [pushed] = calls(ctx.app, 'push');
    assert.deepEqual(texts(pushed.view), [NOT_AVAILABLE], what);
    assert.equal(ctx.app.views.length, 1, `${what}: no other view`);
    assert.deepEqual(ctx.data.calls, [], `${what}: nothing read`);
    assert.ok(ctx.log.lines.some((l) => l.msg === 'hub action refused' && l.fields.reason === reason), what);
  }
});

// --- the day and the form ------------------------------------------------------------------------

test('Open and Show stops: Plan a route\'s day, with Add a stop between Reset to booked and Change crew or day', async () => {
  const ctx = setup();
  const view = await dayOf(ctx);
  assert.deepEqual(buttonText(view), ['Optimize', 'Reset to booked', 'Add a stop', 'Change crew or day']);
  assert.equal(rows(view).length, 4, 'v1\'s four booked stops');
  assert.ok(imageOf(view), 'the day\'s map');
  assert.ok(menus(view).length > 0, 'the ⋯ menus');
});

test('Add a stop opens the form in place of the buttons: the client search, the length (1 h), the window (Any time), Add and Back to the day; the map stays, nothing is read', async () => {
  const ctx = setup();
  const day = await dayOf(ctx);
  const reads = ctx.data.calls.length;
  const uploads = ctx.app.uploads.length;
  await tap(ctx, 'add', `${version(day)}:add`);
  await settle();
  const view = lastView(ctx.app);
  assert.ok(texts(view).includes(ADD_WORDS.form('Maple crew', 'Monday 2026-11-02')));
  const client = element(view, 'client');
  assert.equal(client.type, 'external_select');
  assert.equal(client.min_query_length, 2);
  assert.equal(client.initial_option, undefined);
  const length = element(view, 'length');
  assert.equal(length.options.length, 15);
  assert.equal(length.initial_option.text.text, '1 h');
  const windows = element(view, 'window');
  assert.deepEqual(windows.options.map((o) => [o.value, o.text.text]), [['any', 'Any time'], ['morning', 'Morning'], ['afternoon', 'Afternoon']]);
  assert.equal(windows.initial_option.value, 'any');
  assert.deepEqual(buttonText(view), ['Add', 'Back to the day']);
  assert.ok(contexts(view).includes(ADD_WORDS.formNote()));
  assert.deepEqual(menus(view), [], 'no ⋯ menu while the form is open');
  assert.ok(imageOf(view), 'the map stays');
  assert.equal(ctx.data.calls.length, reads, 'nothing read');
  assert.equal(ctx.app.uploads.length, uploads, 'nothing uploaded');
});

test('exit, Back to the day: the form closes, the buttons and menus come back; nothing is read', async () => {
  const ctx = setup();
  const form = await openForm(ctx);
  const reads = ctx.data.calls.length;
  await tap(ctx, 'back', `${version(form)}:back`);
  await settle();
  const view = lastView(ctx.app);
  assert.deepEqual(buttonText(view), ['Optimize', 'Reset to booked', 'Add a stop', 'Change crew or day']);
  assert.ok(menus(view).length > 0);
  assert.equal(element(view, 'client'), undefined);
  assert.equal(ctx.data.calls.length, reads);
});

test('the client search: clients of the crew\'s zone whose name holds the text, "name · city", tokens for values; under two letters, no read; never an address or another zone', async () => {
  const ctx = setup();
  await openForm(ctx);
  const reads = ctx.data.calls.length;
  assert.deepEqual(await search(ctx, 'k'), [], 'one letter: no options');
  assert.equal(ctx.data.calls.length, reads, 'and nothing read');
  const kim = await search(ctx, 'kim');
  assert.deepEqual(kim.map((o) => o.text.text), ['Kim Sato · Riverton']);
  assert.match(kim[0].value, /^o\d+$/, 'a token, never a property id');
  assert.ok(!JSON.stringify(kim).includes('property:'), 'no node');
  // Max Ford is zone south: never offered for v1 (zone north).
  assert.deepEqual(await search(ctx, 'max'), []);
  const out = JSON.stringify(ctx.app.optionAcks) + JSON.stringify(ctx.log.lines);
  for (const p of Object.values(DAY.places)) {
    if (p.street_address) assert.ok(!out.includes(p.street_address), 'no address');
    if (p.postal_code) assert.ok(!out.includes(p.postal_code), 'no postal code');
  }
  assert.ok(!JSON.stringify(ctx.log.lines).includes('kim'), 'the search text is never logged');
  const read = ctx.data.calls.at(-1);
  assert.equal(read.sql, fx.SQL.clients);
  assert.equal(read.params.crew_id, 'v1');
});

test('exit, no client found: no options (a client already booked that day is never offered); Back to the day still closes the form', async () => {
  const ctx = setup();
  const form = await openForm(ctx);
  // Ana Ruiz is s1, booked on v1 that day.
  assert.deepEqual(await search(ctx, 'ana'), []);
  assert.deepEqual(await search(ctx, 'zzz'), []);
  await tap(ctx, 'back', `${version(form)}:back`);
  await settle();
  assert.ok(buttonText(lastView(ctx.app)).includes('Add a stop'));
});

test('the search answers at most 20 options, each short enough for Slack', async () => {
  const many = adapterWith(() => ({
    clients: async () => ({ clients: Array.from({ length: 30 }, (_, i) => ({ node: `property:c${i}`, clientName: `Client ${'x'.repeat(90)} ${i}`, city: 'Riverton' })) }),
  }));
  const ctx = setup({ mods: [many] });
  await ctx.app.dispatchAction(`${many.id}:open`, { user: U.dispatch, view: MENU });
  await tap(ctx, 'show', 'show');
  await settle();
  await tap(ctx, 'add', `${version(lastView(ctx.app))}:add`);
  await settle();
  const options = await search(ctx, 'client');
  assert.equal(options.length, 20);
  for (const o of options) assert.ok(Array.from(o.text.text).length <= 75);
});

test('exit, the search failing: no options, logged by reason only; the form is untouched', async () => {
  const failing = adapterWith(() => ({ clients: async () => { throw new DataUnavailable('down'); } }));
  const ctx = setup({ mods: [failing] });
  await ctx.app.dispatchAction(`${failing.id}:open`, { user: U.dispatch, view: MENU });
  await tap(ctx, 'show', 'show');
  await settle();
  await tap(ctx, 'add', `${version(lastView(ctx.app))}:add`);
  await settle();
  const n = ctx.app.views.length;
  assert.deepEqual(await search(ctx, 'kim'), []);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map search failed' && l.fields.reason === 'DataUnavailable'));
  assert.equal(ctx.app.views.length, n, 'the view is not touched');
});

test('exit, the search too slow for Slack: no options, inside the wait; the late answer is dropped', async () => {
  let release;
  const slow = adapterWith((base) => ({
    clients: async (args) => {
      await new Promise((r) => { release = r; });
      return base.clients(args);
    },
  }));
  const ctx = setup({ mods: [slow], searchTimeoutMs: 20 });
  await ctx.app.dispatchAction(`${slow.id}:open`, { user: U.dispatch, view: MENU });
  await tap(ctx, 'show', 'show');
  await settle();
  await tap(ctx, 'add', `${version(lastView(ctx.app))}:add`);
  await settle();
  assert.deepEqual(await search(ctx, 'kim'), []);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'options too slow'));
  release();
  await settle();
  assert.equal(ctx.app.optionAcks.length, 1, 'acked once only');
});

test('exit, a search with no access: another person, the same person\'s other view, a person who lost the grant, an expired session and a session with no form all get no options and read nothing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let withdrawn = false;
  const ctx = setup({ canUse: () => (withdrawn ? 'denied' : 'allowed') });
  const day = await dayOf(ctx);
  const noForm = fromView(ctx);
  assert.deepEqual(await search(ctx, 'kim', { view: noForm }), [], 'no form open');
  await tap(ctx, 'add', `${version(day)}:add`);
  await settle();
  const from = fromView(ctx);
  const reads = ctx.data.calls.length;
  assert.deepEqual(await search(ctx, 'kim', { user: U.member, view: from }), [], 'another person');
  assert.deepEqual(await search(ctx, 'kim', { view: { ...from, id: 'V9' } }), [], 'another view');
  withdrawn = true;
  assert.deepEqual(await search(ctx, 'kim', { view: from }), [], 'the grant withdrawn');
  withdrawn = false;
  assert.equal(ctx.data.calls.length, reads, 'nothing read for any of them');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map search refused' && l.fields.reason === 'no access'));
  t.mock.timers.tick(15 * MIN + 1);
  assert.deepEqual(await search(ctx, 'kim', { view: from }), [], 'expired');
  assert.equal(ctx.data.calls.length, reads);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map search refused' && l.fields.reason === 'expired'));
});

test('exit, a search from a view with no session, or not from a modal: no options', async () => {
  const ctx = setup();
  assert.deepEqual(await search(ctx, 'kim', { view: { id: 'VX', type: 'modal', private_metadata: 'not-a-session' } }), []);
  assert.equal(await ctx.app.dispatchOptions(SEARCH_ACTION, { user: U.dispatch, value: 'kim' }), 1);
  assert.deepEqual(ctx.app.optionAcks.at(-1), { options: [] });
  assert.deepEqual(ctx.data.calls, []);
});

// --- Add, Remove --------------------------------------------------------------------------------------

test('Add: the stop joins the day at its cheapest place, marked ➕; the list and the map follow; the button becomes Remove added stop', async () => {
  const day = JSON.parse(JSON.stringify(DAY));
  day.out = [];
  const ctx = setup({ data: fx.fakeData({ day }) });
  await filled(ctx);
  const asked = ctx.mapPoints.asked.length;
  const view = await place(ctx);
  const list = rows(view);
  assert.equal(list.length, 5, 'the four booked stops and the new one');
  const added = list.filter((r) => r.includes('Kim Sato'));
  assert.equal(added.length, 1);
  assert.match(added[0], new RegExp(`\\n➕ ${ADD_WORDS.added()}$`));
  assert.ok(!added[0].includes(ADD_WORDS.placedLast()), 'it fits');
  // The engine's own answer, on the adapter's own input, is what is shown.
  const a = fx.createAdapter({ data: fx.fakeData({ day }) });
  const got = await a.addStop({
    day: day.day, crewId: 'v1', depot: 'depot:hq', scope: { all: true }, node: 'property:k1', minutes: 60, window: 'afternoon',
  });
  const result = require('../../kit/runtime/routing').insertStop(got.input, got.stop, { travel: got.travel, returnToBase: true, order: ['s1', 's2', 's3', 's4'] });
  assert.equal(list.findIndex((r) => r.includes('Kim Sato')) + 1, result.position);
  assert.ok(list[result.position - 1].includes(`*${String(Math.floor(result.start / 60)).padStart(2, '0')}:${String(result.start % 60).padStart(2, '0')} Kim Sato*`));
  // The other crews line: Birch crew (v2, working in this day) could take it.
  const line = contexts(view).find((c) => c.startsWith('Other crews in the zone'));
  assert.ok(line, 'the other crews line');
  assert.match(line, /^Other crews in the zone that could take it: Birch crew \(stop \d+ at \d\d:\d\d, (\+\d+ min drive|no extra drive|−\d+ min drive)\)$/);
  assert.deepEqual(buttonText(view), ['Optimize', 'Reset to booked', 'Remove added stop', 'Change crew or day']);
  assert.ok(imageOf(view), 'the map is drawn again');
  assert.ok(ctx.mapPoints.asked.slice(asked).some((ids) => ids.includes('property:k1')), 'the new stop is placed on the map');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'route stop added' && l.fields.fits === true));
});

test('Add with the zone\'s other crew out: "No other crew in the zone has room for it."', async () => {
  const ctx = setup();
  await filled(ctx);
  const view = await place(ctx);
  assert.ok(contexts(view).includes(ADD_WORDS.noOthers()));
});

test('a stop that fits nowhere: placed last and flagged', async () => {
  const never = adapterWith((base) => ({
    addStop: async (args) => {
      const got = await base.addStop(args);
      return { ...got, stop: { ...got.stop, rules: [{ ruleId: 'time-of-day', value: { startFrom: 300, startBefore: 330 }, strength: 'hard' }] } };
    },
  }));
  const ctx = setup({ mods: [never] });
  await ctx.app.dispatchAction(`${never.id}:open`, { user: U.dispatch, view: MENU });
  await tap(ctx, 'show', 'show');
  await settle();
  await tap(ctx, 'add', `${version(lastView(ctx.app))}:add`);
  await settle();
  const [option] = await search(ctx, 'kim');
  await choose(ctx, 'client', { type: 'external_select', selected_option: option });
  const view = await place(ctx);
  const list = rows(view);
  assert.ok(list.at(-1).includes('Kim Sato'), 'last');
  assert.ok(list.at(-1).includes(`⚠ ${ADD_WORDS.placedLast()}`));
  assert.match(list.at(-1), /🔴/, 'its hard break is shown');
});

test('exit, a stop added then removed: the day as it was, Add a stop again; nothing is read', async () => {
  const ctx = setup();
  const before = rows(await dayOf(ctx));
  await tap(ctx, 'add', `${version(lastView(ctx.app))}:add`);
  await settle();
  const [option] = await search(ctx, 'kim');
  await choose(ctx, 'client', { type: 'external_select', selected_option: option });
  const added = await place(ctx);
  const reads = ctx.data.calls.length;
  await tap(ctx, 'remove', `${version(added)}:remove`);
  await settle();
  const view = lastView(ctx.app);
  assert.deepEqual(rows(view), before);
  assert.deepEqual(buttonText(view), ['Optimize', 'Reset to booked', 'Add a stop', 'Change crew or day']);
  assert.ok(!contexts(view).some((c) => c.startsWith('Other crews') || c === ADD_WORDS.noOthers()));
  assert.equal(ctx.data.calls.length, reads, 'nothing read');
  // Reset to booked after Remove: the booked day.
  await tap(ctx, 'reset', `${version(view)}:reset`);
  await settle();
  assert.deepEqual(rows(lastView(ctx.app)), before);
});

test('with a stop added, Optimize and Reset to booked keep it; the ⋯ moves work', async () => {
  const ctx = setup();
  await filled(ctx);
  const added = await place(ctx);
  await tap(ctx, 'optimize', `${version(added)}:optimize`);
  await settle();
  let view = lastView(ctx.app);
  assert.equal(rows(view).length, 5);
  assert.ok(rows(view).some((r) => r.includes('Kim Sato') && r.includes('➕')));
  await tap(ctx, 'reset', `${version(view)}:reset`);
  await settle();
  view = lastView(ctx.app);
  assert.equal(rows(view).filter((r) => r.includes('➕')).length, 1);
  const [menu] = menus(view);
  await choose(ctx, 'move', { type: 'overflow', selected_option: menu.accessory.options[0] });
  await settle();
  assert.equal(rows(lastView(ctx.app)).length, 5);
});

test('Add with no client picked: "Pick a client first", in the form; nothing is read', async () => {
  const ctx = setup();
  const form = await openForm(ctx);
  const reads = ctx.data.calls.length;
  await tap(ctx, 'place', `${version(form)}:place`);
  await settle();
  const view = lastView(ctx.app);
  assert.ok(texts(view).some((t) => t.endsWith(`\n${ADD_WORDS.pickClient()}`)));
  assert.ok(element(view, 'client'), 'the form stays');
  assert.equal(ctx.data.calls.length, reads);
});

test('the form keeps what was picked when it is shown again', async () => {
  const ctx = setup();
  await filled(ctx, { minutes: '90', window: 'morning' });
  // A failing Add shows the form again, with the picks.
  ctx.data.failWith = new DataUnavailable('down');
  const view = await place(ctx);
  assert.equal(element(view, 'client').initial_option.text.text, 'Kim Sato · Riverton');
  assert.equal(element(view, 'length').initial_option.value, '90');
  assert.equal(element(view, 'window').initial_option.value, 'morning');
});

test('exit, a client that can\'t be added (booked meanwhile, or not in the zone): the form says so; the day is unchanged', async () => {
  const taken = adapterWith(() => ({ addStop: async () => { throw new RoutingFault({ field: 'node', problem: 'unknown_client' }); } }));
  const ctx = setup({ mods: [taken] });
  await ctx.app.dispatchAction(`${taken.id}:open`, { user: U.dispatch, view: MENU });
  await tap(ctx, 'show', 'show');
  await settle();
  await tap(ctx, 'add', `${version(lastView(ctx.app))}:add`);
  await settle();
  const [option] = await search(ctx, 'kim');
  await choose(ctx, 'client', { type: 'external_select', selected_option: option });
  const view = await place(ctx);
  assert.ok(texts(view).some((t) => t.endsWith(`\n${ADD_WORDS.cannotAdd()}`)));
  assert.equal(rows(view).length, 4);
  assert.ok(element(view, 'client'), 'the form stays, to pick another');
});

test('exit, the day\'s bookings changed under the form: the form says so; nothing is added', async () => {
  const changed = adapterWith((base) => ({
    addStop: async (args) => {
      const got = await base.addStop(args);
      const extra = { ...got.input.stops.find((s) => s.currentCrewId === 'v1'), stopId: 'new-booking', node: 'property:k2' };
      return { ...got, input: { ...got.input, stops: [...got.input.stops, extra] } };
    },
  }));
  const ctx = setup({ mods: [changed] });
  await ctx.app.dispatchAction(`${changed.id}:open`, { user: U.dispatch, view: MENU });
  await tap(ctx, 'show', 'show');
  await settle();
  await tap(ctx, 'add', `${version(lastView(ctx.app))}:add`);
  await settle();
  const [option] = await search(ctx, 'kim');
  await choose(ctx, 'client', { type: 'external_select', selected_option: option });
  const view = await place(ctx);
  assert.ok(texts(view).some((t) => t.endsWith(`\n${ADD_WORDS.dayChanged()}`)));
  assert.equal(rows(view).length, 4);
});

test('exit, the data unavailable on Add: the form says so (with Back to the day); nothing is drawn', async () => {
  const ctx = setup();
  await filled(ctx);
  const uploads = ctx.app.uploads.length;
  ctx.data.failWith = new DataUnavailable('down');
  const view = await place(ctx);
  assert.ok(texts(view).some((t) => t.endsWith(`\n${DATA_DOWN}`)));
  assert.deepEqual(buttonText(view), ['Add', 'Back to the day']);
  assert.equal(ctx.app.uploads.length, uploads);
});

test('exit, closing while Add works: it finds its session gone, uploads nothing and shows nothing', async () => {
  let release;
  let hold = false;
  const slow = adapterWith((base) => ({
    addStop: async (args) => {
      if (hold) await new Promise((r) => { release = r; });
      return base.addStop(args);
    },
  }));
  const ctx = setup({ mods: [slow] });
  await ctx.app.dispatchAction(`${slow.id}:open`, { user: U.dispatch, view: MENU });
  await tap(ctx, 'show', 'show');
  await settle();
  await tap(ctx, 'add', `${version(lastView(ctx.app))}:add`);
  await settle();
  const [option] = await search(ctx, 'kim');
  await choose(ctx, 'client', { type: 'external_select', selected_option: option });
  hold = true;
  const pending = tap(ctx, 'place', `${version(lastView(ctx.app))}:place`);
  await settle();
  const uploads = ctx.app.uploads.length;
  await ctx.app.dispatchViewClosed('hub:map', { user: U.dispatch, view: { id: 'V1' }, is_cleared: true });
  const shown = ctx.app.views.length;
  release();
  await pending;
  await settle();
  assert.equal(ctx.app.uploads.length, uploads, 'nothing uploaded');
  assert.equal(ctx.app.views.length, shown, 'nothing shown after the close');
});

for (const cleared of [false, true]) {
  test(`exit, ${cleared ? 'the X' : 'Back'} with the form open: view_closed deletes the map files; a later Add is told the plan has expired`, async () => {
    const ctx = setup();
    const form = await openForm(ctx);
    assert.equal(await ctx.app.dispatchViewClosed('hub:map', { user: U.dispatch, view: { id: 'V1' }, is_cleared: cleared }), 1);
    assert.equal(ctx.store.mapFileCount(), 0);
    await tap(ctx, 'place', `${version(form)}:place`, {
      view: {
        id: 'V1', type: 'modal', private_metadata: form.private_metadata, title: form.title,
      },
    });
    assert.deepEqual(texts(lastView(ctx.app)), [ROUTE_WORDS.expired('Add a stop')]);
  });
}

test('exit, an expired session (15 minutes without use): Add shows the plan-expired words (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const ctx = setup();
  const form = await openForm(ctx);
  t.mock.timers.tick(15 * MIN + 1);
  await tap(ctx, 'place', `${version(form)}:place`);
  const view = lastView(ctx.app);
  assert.deepEqual(texts(view), [ROUTE_WORDS.expired('Add a stop')]);
  assert.equal(view.close.text, 'Back');
});

test('exit, an expired trigger on Open: the hub\'s existing path; no modal, nothing read', async () => {
  const ctx = setup();
  ctx.app.viewsFail.push = Object.assign(new Error('An API error occurred: expired_trigger_id'), { data: { ok: false, error: 'expired_trigger_id' } });
  await ctx.app.dispatchAction(`${ADD.id}:open`, { user: U.dispatch, view: { ...MENU, hash: 'hmenu' } });
  const [update] = calls(ctx.app, 'update');
  assert.deepEqual(texts(update.view), [MAP_NEEDS_WINDOW]);
  assert.deepEqual(ctx.data.calls, []);
});

test('exit, access withdrawn: Add shows the refusal and reads nothing', async () => {
  let withdrawn = false;
  const ctx = setup({ canUse: () => (withdrawn ? 'denied' : 'allowed') });
  await filled(ctx);
  withdrawn = true;
  const reads = ctx.data.calls.length;
  await tap(ctx, 'place', `${version(lastView(ctx.app))}:place`);
  assert.deepEqual(texts(lastView(ctx.app)), [`You don't have access to Add a stop; ask ${ADMIN}.`]);
  assert.equal(ctx.data.calls.length, reads);
});

test('exit, a click from someone else\'s view: another user is refused silently and nothing changes', async () => {
  const ctx = setup();
  const form = await openForm(ctx);
  const n = ctx.app.views.length;
  await tap(ctx, 'place', `${version(form)}:place`, { user: U.leadB });
  assert.equal(ctx.app.views.length, n);
  assert.ok(refused(ctx, 'place', 'another user'));
});

test('stale, forged or out-of-step clicks are refused and change nothing: a stale version, a token never offered, a length or window not offered, Remove with nothing added, the list\'s buttons while the form is open', async () => {
  const ctx = setup();
  const day = await dayOf(ctx);
  const v = version(day);
  await tap(ctx, 'add', `${v + 3}:add`);
  assert.ok(refused(ctx, 'add', 'stale version'));
  await tap(ctx, 'add', 'add');
  assert.ok(refused(ctx, 'add', 'malformed'));
  await tap(ctx, 'remove', `${v}:remove`);
  assert.ok(refused(ctx, 'remove', 'another step'));
  await tap(ctx, 'place', `${v}:place`);
  assert.ok(refused(ctx, 'place', 'no form'));
  await tap(ctx, 'add', `${v}:add`);
  await settle();
  const n = ctx.app.views.length;
  await choose(ctx, 'client', { type: 'external_select', selected_option: { value: 'o999', text: { type: 'plain_text', text: 'Someone' } } });
  assert.ok(refused(ctx, 'client', 'not offered'));
  await choose(ctx, 'client', { type: 'external_select', selected_option: { value: 'property:k1', text: { type: 'plain_text', text: 'Kim' } } });
  await choose(ctx, 'length', { type: 'static_select', selected_option: { value: '20', text: { type: 'plain_text', text: '20' } } });
  assert.ok(refused(ctx, 'length', 'not offered'));
  await choose(ctx, 'window', { type: 'static_select', selected_option: { value: 'evening', text: { type: 'plain_text', text: 'x' } } });
  assert.ok(refused(ctx, 'window', 'not offered'));
  await tap(ctx, 'optimize', `${v}:optimize`);
  assert.ok(refused(ctx, 'optimize', 'form open'));
  await tap(ctx, 'change', 'change');
  assert.ok(refused(ctx, 'change', 'form open'));
  await tap(ctx, 'add', `${v}:add`);
  assert.ok(refused(ctx, 'add', 'another step'));
  assert.equal(ctx.app.views.length, n, 'the view is not touched');
});

test('scope (AD-R17): a crew lead adds only to their own crew and is shown no other crew; their search is their zone', async () => {
  const ctx = setup();
  await filled(ctx, { user: U.leadA });
  const read = ctx.data.calls.filter((c) => c.sql === fx.SQL.clients).at(-1);
  assert.equal(read.params.crew_id, 'v1');
  const view = await place(ctx, { user: U.leadA });
  assert.equal(rows(view).filter((r) => r.includes('➕')).length, 1);
  assert.ok(!contexts(view).some((c) => c.startsWith('Other crews') || c === ADD_WORDS.noOthers()), 'no other crew line for a lead');
  const names = Object.values(DAY.crewNames).filter((n) => n !== 'Maple crew');
  for (const name of names) assert.ok(!JSON.stringify(view).includes(name), `${name} is not named`);
});
