'use strict';

// Story 15.14 (AD-R26, AD-R27, AD-R12 amended, AD-R16 amended) and Story
// 15.16 (AD-R29: one section per stop with a ⋯ overflow menu): Plan a route,
// the route-editor screen of the routing-map archetype, through the hub on
// the fake Slack app. A synthetic day (test/fixtures/routing-map/day.json,
// with its made-up Office depot:hq) read by the fixture adapter's route();
// mapPoints is the fixture's stand-in (a spy); the renderer is the real one
// (a spy keeps each model). Every way out of the screen has a test: Change
// crew or day, Back, Close, the sweep, an expired trigger, an expired
// session, access withdrawn, a click from another user or view, the error
// exits, a map failure, and a reused file that expired or was deleted.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { createRegistry } = require('../../kit/runtime/registry');
const { registerHubs, NOT_AVAILABLE, MAP_NEEDS_WINDOW } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { createMapFiles, REUSE_MS } = require('../../kit/runtime/slack/image');
const { createEngineJobs } = require('../../kit/runtime/jobs');
const { renderPng } = require('../../kit/runtime/routing-map');
const { RoutingFault, DataUnavailable } = require('../../kit/runtime/errors');
const { MAP_WORDS, ROUTE_WORDS } = require('../../kit/runtime/messages');
const { ID_PATTERN } = require('../../kit/runtime/archetypes/routing-map/session');
const { parseMove, movesAt, MAX_STOPS } = require('../../kit/runtime/archetypes/routing-map/editor');
const routing = require('../../kit/runtime/routing');
const { FakeSlackApp } = require('../fixtures/fake-slack');
const fx = require('../fixtures/routing-map/adapter');
const { createFakeTiles } = require('../fixtures/fake-tiles');
const { createBasemap } = require('../../kit/runtime/basemap');

const profile = loadProfile(path.join(__dirname, '../fixtures/profiles/routing-editor.yml'));
const noDepot = loadProfile(path.join(__dirname, '../fixtures/profiles/routing-audience.yml'));
const SOURCE = loadProfile(path.join(__dirname, '../fixtures/profiles/routing-basemap.yml')).routing.basemap;
const DAY = fx.DAY;
const HUB = Object.freeze({ id: 'ops', command: '/ops', name: 'Ops', description: 'Ops tools' });
const MENU = Object.freeze({ id: 'VMENU', type: 'modal', private_metadata: 'ops' });
const ADMIN = '<@UADMIN>';
const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-02T15:00:00Z');
const U = Object.freeze({
  dispatch: { id: 'UDISPATCH', name: 'dispatch' },
  leadA: { id: 'ULEADA', name: 'lead a' },
  leadB: { id: 'ULEADB', name: 'lead b' },
  ghost: { id: 'ULEADGHOST', name: 'lead ghost' },
  member: { id: 'UMEMBER', name: 'member' },
});
const NOTE = "Times and driving are from the Office at 08:00. Routing's other views start from each crew's base.";
const UPDATING = 'Map updating…';
const NOT_UPDATED = 'Map not updated; the list is current.';
const DATA_DOWN = "The data isn't available right now, so I can't answer that. The app is still running; please tell your admin.";
const PLAN_FAILED = MAP_WORDS.planFailed(ADMIN);
const OFFICE = 'depot:hq';
const V1_NODES = ['property:s1', 'property:s2', 'property:s3', 'property:s4'];

const editorModule = (over = {}) => Object.freeze({
  id: 'route-planner', hub: 'ops', label: 'Plan a route', description: 'One crew\'s day from the Office', resource: 'ROUTING_ALL_CREWS',
  archetype: 'routing-map', screen: 'route-editor', environments: ['dev'], adapter: 'adapter.js', createAdapter: fx.createAdapter, ...over,
});
const viewsModule = () => editorModule({ id: 'routing', label: 'Routing', screen: undefined });

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// An adapter spy: every route() and labels() call, then the real answer
// (or edit(answer) of it).
function spyAdapter({ editRoute, editLabels } = {}) {
  const seen = { route: [], labels: [] };
  const createAdapter = (args) => {
    const real = fx.createAdapter(args);
    return {
      ...real,
      route: async (q) => {
        seen.route.push(JSON.parse(JSON.stringify(q)));
        const got = await real.route(q);
        return editRoute ? editRoute(got) : got;
      },
      labels: async (q) => {
        seen.labels.push([...q.nodeIds]);
        const got = await real.labels(q);
        return editLabels ? editLabels(got) : got;
      },
    };
  };
  return { seen, createAdapter };
}

// The hub with a Plan a route module (and Routing's, for the cross-screen
// tests). wait: the map's delay (ms; the real setTimeout, so mock.timers
// moves it), 0 by default here.
function setup({
  data = fx.fakeData(), mapPoints = fx.fakeMapPoints(), render = renderPng, store = createStore(), sweeping = () => true,
  canUse, mod = editorModule(), profile: withProfile = profile, wait = 0, fetchMosaic, client,
} = {}) {
  const app = new FakeSlackApp({ views: true });
  app.checkHashes = true;
  const log = quietLog();
  const mapFiles = createMapFiles({
    store, client: client === undefined ? app.client : client, log, sweeping, sleep: async () => {},
  });
  const models = [];
  const spyRender = (view, model, ...opts) => {
    models.push({ view, model, opts });
    return render(view, model, ...opts);
  };
  registerHubs(app, {
    registry: createRegistry({ hubs: [HUB], modules: [mod, viewsModule()] }), profile: withProfile, env: 'dev', log, store, data,
    mapFiles, ...(canUse ? { canUse } : {}),
    routingMap: {
      mapPoints, render: spyRender, editor: { mapDelayMs: wait }, ...(fetchMosaic ? { fetchMosaic } : {}),
    },
  });
  return {
    app, log, store, data, mapPoints, models, mapFiles,
  };
}

const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const lastView = (app) => app.views.at(-1).args.view;
const blocksOf = (view, type) => view.blocks.filter((b) => b.type === type);
const texts = (view) => blocksOf(view, 'section').map((b) => b.text.text);
const contexts = (view) => blocksOf(view, 'context').map((b) => b.elements.map((e) => e.text).join(''));
const open = (ctx, user = U.dispatch, id = 'route-planner') => ctx.app.dispatchAction(`${id}:open`, { user, view: MENU });
const pick = (value) => ({ type: 'static_select', selected_option: { value, text: { type: 'plain_text', text: value } } });
const date = (day) => ({ type: 'datepicker', selected_date: day });
const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => { setImmediate(r); }); };

// The view as it now stands (V1, its latest hash), as a click carries it.
function fromView(ctx, { view } = {}) {
  const v = lastView(ctx.app);
  return view || {
    id: 'V1', type: 'modal', hash: ctx.app.hashes.get('V1'), private_metadata: v.private_metadata, title: v.title,
  };
}
function tap(ctx, which, value, { user = U.dispatch, view } = {}) {
  return ctx.app.dispatchAction(`routing-map:${which}`, { user, view: fromView(ctx, { view }), value });
}
function choose(ctx, which, action, { user = U.dispatch, view } = {}) {
  return ctx.app.dispatchAction(`routing-map:${which}`, { user, view: fromView(ctx, { view }), action });
}
const show = (ctx, opts) => tap(ctx, 'show', 'show', opts);
// A ⋯ menu option chosen, sent as Slack sends an overflow click (the value
// in selected_option only). option: one of the view's options, or a crafted
// { value }.
function menu(ctx, option, { user = U.dispatch, view } = {}) {
  return ctx.app.dispatchAction('routing-map:move', { user, view: fromView(ctx, { view }), option });
}

// The stop rows of a step-2 view: { text, options } per stop, in order
// (options: the ⋯ menu's, [] with no menu).
function rows(view) {
  return view.blocks.filter((b) => b.type === 'section' && /^routing-map:stop:/.test(b.block_id)).map((b) => ({
    text: b.text.text, options: b.accessory ? b.accessory.options : [], accessory: b.accessory,
  }));
}
// Stop k's (1-based) menu option for target (up, down, first, last), or undefined.
const moveOf = (view, k, target) => rows(view)[k - 1].options.find((o) => o.value.endsWith(`:${target}`));
const topButtons = (view) => blocksOf(view, 'actions').find((b) => /^routing-map:actions:/.test(b.block_id));
const versionOf = (view) => Number(topButtons(view).block_id.split(':').at(-1));
// "Client, Area" per row, from its first line "<n> *hh:mm Client* · Area".
const orderOf = (view) => rows(view).map((r) => r.text.split('\n')[0].replace(/^\S+ \*\d\d:\d\d (\(next day\) )?/, '').replace('* · ', ', '));
const header = (view) => texts(view)[0];
const imageOf = (view) => blocksOf(view, 'image')[0];

// Opens Plan a route and shows a crew's stops (v1 by default).
async function shown(ctx, { user = U.dispatch, crew } = {}) {
  await open(ctx, user);
  if (crew) await choose(ctx, 'crew', pick(crew), { user });
  await show(ctx, { user });
  return lastView(ctx.app);
}

// --- not available (fail closed, AD-R26) -----------------------------------------------

test('a route-editor module with no routing.depot, or an adapter with no route(), shows "not available" and opens no modal; nothing is read', async () => {
  const noRoute = editorModule({
    createAdapter: (args) => { const { route, ...rest } = fx.createAdapter(args); return rest; },
  });
  for (const [what, opts] of [['no depot', { profile: noDepot }], ['no route()', { mod: noRoute }]]) {
    const ctx = setup(opts);
    await open(ctx);
    const [pushed] = calls(ctx.app, 'push');
    assert.deepEqual(texts(pushed.view), [NOT_AVAILABLE], what);
    assert.equal(pushed.view.title.text, 'Not available', what);
    assert.ok(!('notify_on_close' in pushed.view), what);
    assert.equal(ctx.app.views.length, 1, `${what}: no other view`);
    assert.deepEqual(ctx.data.calls, [], `${what}: nothing read`);
    assert.ok(ctx.log.lines.some((l) => l.msg === 'hub action refused'
      && l.fields.reason === (what === 'no depot' ? 'no routing.depot in the profile' : 'the adapter has no route()')), what);
  }
  // Routing's views open as before on a profile with no Office.
  const views = setup({ profile: noDepot });
  await open(views, U.dispatch, 'routing');
  assert.equal(imageOf(lastView(views.app)).slack_file.id, 'F1');
});

// --- step 1 ---------------------------------------------------------------------

test('Open: "Loading…" pushed first, then step 1: a crew select, the date picker and Show stops; no map, no positions read', async () => {
  const ctx = setup();
  await open(ctx);
  const [pushed] = calls(ctx.app, 'push');
  assert.deepEqual(texts(pushed.view), ['Loading…']);
  assert.equal(pushed.view.callback_id, 'hub:map');
  assert.equal(pushed.view.notify_on_close, true);
  assert.equal(pushed.view.title.text, 'Plan a route');
  const view = lastView(ctx.app);
  assert.match(view.private_metadata, ID_PATTERN);
  assert.deepEqual(view.blocks.map((b) => b.type), ['section', 'actions', 'context']);
  assert.deepEqual(texts(view), [ROUTE_WORDS.pick()]);
  const [actions] = blocksOf(view, 'actions');
  assert.deepEqual(actions.elements.map((e) => [e.type, e.action_id]), [
    ['static_select', 'routing-map:crew'], ['datepicker', 'routing-map:day'], ['button', 'routing-map:show'],
  ]);
  assert.deepEqual(actions.elements[0].options.map((o) => [o.value, o.text.text]), [['v1', 'Maple crew'], ['v2', 'Birch crew'], ['v3', 'Cedar crew']]);
  assert.equal(actions.elements[0].initial_option.value, 'v1');
  assert.equal(actions.elements[1].initial_date, DAY.asOf);
  assert.deepEqual(contexts(view), ['Days from 2026-10-26 to 2026-11-16. Suggestions only: nothing is changed.']);
  assert.deepEqual(ctx.app.uploads, []);
  assert.deepEqual(ctx.mapPoints.asked, []);
});

test('step 1: a crew is kept with no redraw, a day in range redraws step 1 with that day\'s crews; a day out of range is refused plainly; a crew not offered is refused', async () => {
  const ctx = setup();
  await open(ctx);
  const updates = calls(ctx.app, 'update').length;
  await choose(ctx, 'crew', pick('v3'));
  assert.equal(calls(ctx.app, 'update').length, updates, 'no redraw for a crew');
  await choose(ctx, 'day', date('2026-11-03'));
  assert.equal(calls(ctx.app, 'update').length, updates + 1, 'one redraw for a day (its crews)');
  await choose(ctx, 'crew', pick('v9'));
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.reason === 'unknown crew'));
  await choose(ctx, 'day', date('2026-12-25'));
  assert.deepEqual(texts(lastView(ctx.app)), [MAP_WORDS.badDate('2026-10-26', '2026-11-16')]);
  const [actions] = blocksOf(lastView(ctx.app), 'actions');
  assert.equal(actions.elements[0].initial_option.value, 'v3', 'the crew picked is kept');
  assert.equal(actions.elements[1].initial_date, '2026-11-03', 'the day picked is kept');
});

// --- step 2 ---------------------------------------------------------------------

test('Show stops: the header totals, the image, the fixed note, the actions row, the Office first and last and one section per stop with a ⋯ menu; no up or first on the first, no down or last on the last; no actions row per stop', async () => {
  const ctx = setup();
  const view = await shown(ctx);
  // First the list at once with "Map updating…", then the map.
  const [list, map] = calls(ctx.app, 'update').slice(-2).map((u) => u.view);
  assert.equal(blocksOf(list, 'image').length, 0, 'the list first, no image yet');
  assert.deepEqual(contexts(list)[0], UPDATING);
  assert.equal(map, view);
  assert.deepEqual(view.blocks.map((b) => b.type), [
    'section', 'image', 'context', 'actions', 'section',
    'section', 'section', 'section', 'section', 'section',
  ]);
  assert.equal(header(view), '*Maple crew, Monday 2026-11-02*\nDrive 28 min · about 17 km · last stop done 14:25 · back at Office 14:31 · no rule breaks');
  assert.deepEqual(imageOf(view), { type: 'image', slack_file: { id: 'F1' }, alt_text: 'Route map: Planned route, Maple crew, 4 stops' });
  assert.deepEqual(contexts(view), [NOTE], 'no street map in this profile: no caption; the note');
  assert.deepEqual(topButtons(view).elements.map((e) => [e.action_id, e.text.text, e.accessibility_label]), [
    ['routing-map:optimize', 'Optimize', 'Optimize the order from the Office'],
    ['routing-map:reset', 'Reset to booked', 'Put the stops back in the booked order'],
    ['routing-map:change', 'Change crew or day', 'Change the crew or the day'],
  ]);
  assert.deepEqual(texts(view), [
    header(view),
    'Office · leave 07:55',
    '1️⃣ *08:00 Ana Ruiz* · Riverton\n🚐 5 min',
    '2️⃣ *10:10 Ben Ode* · Riverton\n🚐 6 min',
    '3️⃣ *11:45 Cara Lind* · Lakeside\n🚐 5 min',
    '4️⃣ *12:55 Dev Patel* · Lakeside\n🚐 6 min',
    'Office · back 14:31',
  ]);
  const r = rows(view);
  for (const x of r) {
    assert.equal(x.accessory.type, 'overflow');
    assert.equal(x.accessory.action_id, 'routing-map:move');
    assert.ok(!('accessibility_label' in x.accessory), 'an overflow carries no accessibility_label');
    for (const o of x.options) assert.ok(!('accessibility_label' in o));
  }
  assert.deepEqual(r.map((x) => x.options.map((o) => [o.text.type, o.text.text, o.value])), [
    [['plain_text', 'Move stop 1 down', '1:0:down'], ['plain_text', 'Move stop 1 to last', '1:0:last']],
    [['plain_text', 'Move stop 2 up', '1:1:up'], ['plain_text', 'Move stop 2 down', '1:1:down'], ['plain_text', 'Move stop 2 to first', '1:1:first'], ['plain_text', 'Move stop 2 to last', '1:1:last']],
    [['plain_text', 'Move stop 3 up', '1:2:up'], ['plain_text', 'Move stop 3 down', '1:2:down'], ['plain_text', 'Move stop 3 to first', '1:2:first'], ['plain_text', 'Move stop 3 to last', '1:2:last']],
    [['plain_text', 'Move stop 4 up', '1:3:up'], ['plain_text', 'Move stop 4 to first', '1:3:first']],
  ]);
  assert.ok(rows(view).every((x) => !x.text.includes('(est.)')), '"(est.)" appears nowhere in the rows');
  assert.ok(!view.blocks.some((b) => b.type === 'actions' && /^routing-map:move:/.test(b.block_id)), 'no ↑/↓ actions row');
  const ids = view.blocks.map((b) => b.block_id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'every block_id unique');
  // The engine's own numbers: evaluateOrder from the Office in booked order.
  const out = DAY.crews.find((c) => c.crewId === 'v1');
  const input = {
    day: DAY.day, asOf: DAY.asOf, limits: DAY.limits, crews: [{ ...out, baseNode: OFFICE }], stops: DAY.stops.filter((s) => s.currentCrewId === 'v1'),
  };
  const ev = routing.evaluateOrder(input, {
    travel: routing.travel.fromMatrix(DAY.matrix), returnToBase: true, crewId: 'v1', order: ['s1', 's2', 's3', 's4'],
  });
  assert.equal(ev.cost.driveMinutes, 28);
  assert.deepEqual([ev.leaveAt, ev.finish, ev.backAt], [475, 865, 871]);
  // The map: the route view, the Office as depot and every crew's base.
  const [{ view: kind, model }] = ctx.models;
  assert.equal(kind, 'route');
  assert.equal(model.depot, OFFICE);
  assert.deepEqual(model.crews, [{ crewId: 'v1', color: 0, baseNode: OFFICE }]);
  assert.deepEqual(model.route, { crewId: 'v1', stops: V1_NODES.map((node) => ({ node, flag: 'none' })) });
  assert.equal(ctx.app.uploads.length, 1);
});

test('the total distance is the route\'s, Office to Office, in whole km; a leg\'s distance is shown nowhere', async () => {
  const ctx = setup();
  const view = await shown(ctx);
  const km = new Map(DAY.matrix.map((r) => [`${r.from_node}>${r.to_node}`, r.km_tenths]));
  const legs = [OFFICE, ...V1_NODES, OFFICE];
  let tenths = 0;
  for (let i = 1; i < legs.length; i += 1) tenths += km.get(`${legs[i - 1]}>${legs[i]}`);
  assert.match(header(view), new RegExp(` about ${Math.round(tenths / 10)} km `));
  const all = JSON.stringify(ctx.app.views);
  assert.equal((all.match(/ km/g) || []).length, calls(ctx.app, 'update').filter((u) => /about \d+ km/.test(JSON.stringify(u))).length, 'only the header says km');
});

test('a row with a rule break shows it shortened on its second line, and the header counts them with the hard ones', async () => {
  const day = JSON.parse(JSON.stringify(DAY));
  day.stops.find((s) => s.stopId === 's1').locked = true;
  const ctx = setup({ data: fx.fakeData({ day }) });
  let view = await shown(ctx);
  assert.match(header(view), /· no rule breaks$/);
  await menu(ctx, moveOf(view, 1, 'down'));
  view = lastView(ctx.app);
  assert.deepEqual(orderOf(view), ['Ben Ode, Riverton', 'Ana Ruiz, Riverton', 'Cara Lind, Lakeside', 'Dev Patel, Lakeside']);
  assert.match(header(view), /· 1 rule break \(1 hard\)$/);
  assert.equal(rows(view)[1].text, '2️⃣ *09:40 Ana Ruiz* · Riverton\n🚐 6 min · 🔴 missed locked start (starts 09:40)');
});

test('times past 24:00 show as "hh:mm (next day)"', async () => {
  const day = JSON.parse(JSON.stringify(DAY));
  Object.assign(day.stops.find((s) => s.stopId === 's4'), { locked: true, start: 1400 });
  const ctx = setup({ data: fx.fakeData({ day }) });
  const view = await shown(ctx);
  // Two breaks: the hard one (crew day limits) shows, before the soft
  // aim-finish, which is counted.
  assert.equal(rows(view)[3].text, '4️⃣ *23:20 Dev Patel* · Lakeside\n🚐 6 min · 🔴 over crew day (ends 00:50 next day) · +1 more');
  assert.match(header(view), /last stop done 00:50 \(next day\) · back at Office 00:56 \(next day\) · /);
  assert.equal(texts(view).at(-1), 'Office · back 00:56 (next day)\n⚠ crew day limits: back after 19:00');
});

test('a reorder reads nothing: one mapPoints read on Show stops (the Office and the stops), none on a tap', async () => {
  const ctx = setup();
  const view = await shown(ctx);
  const reads = ctx.data.calls.length;
  assert.deepEqual(ctx.mapPoints.asked, [[OFFICE, ...V1_NODES]]);
  await menu(ctx, moveOf(view, 2, 'down'));
  await tap(ctx, 'optimize', `${versionOf(lastView(ctx.app))}:optimize`);
  await tap(ctx, 'reset', `${versionOf(lastView(ctx.app))}:reset`);
  assert.equal(ctx.data.calls.length, reads, 'no database read on a tap');
  assert.equal(ctx.mapPoints.asked.length, 1);
});

// --- taps: two updates, the newest wins (AD-R27, AD-R16) ---------------------------------------

test('↓: the list updates first under the same file with "Map updating…", then one map after 750 ms; the earlier file deleted after the new one shows (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const ctx = setup({ wait: 750 });
  await open(ctx);
  const showing = show(ctx);
  await settle();
  t.mock.timers.tick(0);
  await showing;
  let view = lastView(ctx.app);
  assert.equal(imageOf(view).slack_file.id, 'F1', 'Show stops draws at once');
  const pending = menu(ctx, moveOf(view, 1, 'down'));
  await settle();
  view = lastView(ctx.app);
  assert.equal(imageOf(view).slack_file.id, 'F1', 'the same file, reused');
  assert.equal(contexts(view)[0], UPDATING);
  assert.deepEqual(orderOf(view), ['Ben Ode, Riverton', 'Ana Ruiz, Riverton', 'Cara Lind, Lakeside', 'Dev Patel, Lakeside']);
  assert.equal(ctx.app.uploads.length, 1, 'no upload yet');
  t.mock.timers.tick(749);
  await settle();
  assert.equal(ctx.app.uploads.length, 1, 'still none at 749 ms');
  t.mock.timers.tick(1);
  await pending;
  view = lastView(ctx.app);
  assert.equal(ctx.app.uploads.length, 2);
  assert.equal(imageOf(view).slack_file.id, 'F2');
  assert.deepEqual(contexts(view), [NOTE], '"Map updating…" gone');
  assert.deepEqual(ctx.app.deleted, ['F1']);
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F2']);
  assert.deepEqual(ctx.models.at(-1).model.route.stops.map((s) => s.node), ['property:s2', 'property:s1', 'property:s3', 'property:s4']);
});

test('three taps within 1 s give one upload, for the final order; each list shows at once (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const ctx = setup({ wait: 750 });
  await open(ctx);
  const first = show(ctx);
  await settle();
  t.mock.timers.tick(0);
  await first;
  const taps = [];
  for (let i = 0; i < 3; i += 1) {
    // Each tap moves the stop now first down one place.
    taps.push(menu(ctx, moveOf(lastView(ctx.app), i + 1, 'down')));
    await settle();
    assert.equal(imageOf(lastView(ctx.app)).slack_file.id, 'F1', `tap ${i + 1}: the list under the same file`);
    t.mock.timers.tick(300);
    await settle();
  }
  t.mock.timers.tick(750);
  await Promise.all(taps);
  assert.equal(ctx.app.uploads.length, 2, 'Show stops, then one map for three taps');
  const view = lastView(ctx.app);
  assert.equal(imageOf(view).slack_file.id, 'F2');
  assert.deepEqual(orderOf(view), ['Ben Ode, Riverton', 'Cara Lind, Lakeside', 'Dev Patel, Lakeside', 'Ana Ruiz, Riverton']);
  assert.deepEqual(ctx.models.at(-1).model.route.stops.map((s) => s.node), ['property:s2', 'property:s3', 'property:s4', 'property:s1']);
  assert.equal(versionOf(view), 4);
  assert.equal(ctx.log.lines.filter((l) => l.msg === 'map superseded').length, 2);
});

// --- refusals (AD-R27) ------------------------------------------------------------

test('a menu option with a stale version, an index out of range, a target not offered there, or a value that does not parse: the order is unchanged and the refusal logged by reason only', async () => {
  const ctx = setup();
  const view = await shown(ctx);
  await menu(ctx, moveOf(view, 1, 'down'));
  const now = lastView(ctx.app);
  const v = versionOf(now);
  const before = { order: orderOf(now), updates: ctx.app.views.length, uploads: ctx.app.uploads.length };
  const option = (value) => ({ text: { type: 'plain_text', text: 'Move stop 1 down' }, value });
  const cases = [
    [() => menu(ctx, option('1:0:down')), 'move', 'stale version'],
    [() => menu(ctx, option(`${v}:4:up`)), 'move', 'out of range'],
    [() => menu(ctx, option(`${v}:999:up`)), 'move', 'out of range'],
    [() => menu(ctx, option(`${v}:0:up`)), 'move', 'not offered'],
    [() => menu(ctx, option(`${v}:0:first`)), 'move', 'not offered'],
    [() => menu(ctx, option(`${v}:3:down`)), 'move', 'not offered'],
    [() => menu(ctx, option(`${v}:3:last`)), 'move', 'not offered'],
    [() => menu(ctx, option('not-a-move')), 'move', 'malformed'],
    [() => menu(ctx, option(`${v}:1`)), 'move', 'malformed'],
    [() => menu(ctx, option(`${v}:1:sideways`)), 'move', 'malformed'],
    [() => menu(ctx, option(`${v}:01:up`)), 'move', 'malformed'],
    [() => menu(ctx, option(`0:1:up`)), 'move', 'malformed'],
    [() => menu(ctx, option(`${v}:s2:up`)), 'move', 'malformed', 'a stop id, not an index'],
    [() => menu(ctx, option(`${v}:1:up${'x'.repeat(2000)}`)), 'move', 'malformed'],
    // A button-shaped click: the value is read from selected_option only.
    [() => tap(ctx, 'move', `${v}:1:up`), 'move', 'malformed', 'no selected_option'],
    [() => tap(ctx, 'optimize', '1:optimize'), 'optimize', 'stale version'],
    [() => tap(ctx, 'reset', `${v}:optimize`), 'reset', 'malformed'],
  ];
  for (const [click, which, reason, what] of cases) {
    const lines = ctx.log.lines.length;
    await click();
    const said = ctx.log.lines.slice(lines);
    assert.deepEqual(said, [{ level: 'warn', msg: 'routing map click refused', fields: { action: which, reason } }], what || `${which} ${reason}`);
  }
  assert.deepEqual(orderOf(lastView(ctx.app)), before.order);
  assert.equal(ctx.app.views.length, before.updates, 'the view untouched');
  assert.equal(ctx.app.uploads.length, before.uploads);
});

test('parseMove reads "<version>:<index>:<target>" and nothing else; movesAt offers no up or first on the first stop, no down or last on the last, nothing on a one-stop day', () => {
  assert.deepEqual(parseMove('3:0:down'), { version: 3, index: 0, target: 'down' });
  assert.deepEqual(parseMove('12:39:first'), { version: 12, index: 39, target: 'first' });
  for (const bad of [null, '', '3', '3:1', ':1:up', '03:1:up', 'x:1:up', '3:-1:up', '3:01:up', '3:1:', '3:1:UP', '3:1:up:x', '3:s1:up', `3:1:${'a'.repeat(40)}`, 'x'.repeat(2001)]) {
    assert.equal(parseMove(bad), null, String(bad).slice(0, 20));
  }
  assert.deepEqual(movesAt(0, 1), []);
  assert.deepEqual(movesAt(0, 2), ['down', 'last']);
  assert.deepEqual(movesAt(1, 2), ['up', 'first']);
  assert.deepEqual(movesAt(1, 3), ['up', 'down', 'first', 'last']);
});

test('a screen refuses another screen\'s actions: an editor action sent to a Routing session, and Routing\'s to Plan a route; the order unchanged, logged by reason only', async () => {
  const ctx = setup();
  await open(ctx, U.dispatch, 'routing');
  const routingView = lastView(ctx.app);
  const views = ctx.app.views.length;
  for (const [which, value] of [['show', 'show'], ['move', '1:1:up'], ['optimize', '1:optimize'], ['reset', '1:reset'], ['change', 'change']]) {
    await tap(ctx, which, value, { view: { id: 'V1', type: 'modal', hash: ctx.app.hashes.get('V1'), private_metadata: routingView.private_metadata, title: routingView.title } });
  }
  assert.equal(ctx.app.views.length, views, 'Routing\'s view untouched');
  const refused = ctx.log.lines.filter((l) => l.msg === 'routing map click refused');
  assert.equal(refused.length, 5);
  for (const l of refused) assert.deepEqual(Object.keys(l.fields), ['action', 'reason']);
  assert.ok(refused.every((l) => l.fields.reason === 'another screen'));

  const ed = setup();
  const view = await shown(ed);
  const n = ed.app.views.length;
  await choose(ed, 'view', pick('zone'));
  await choose(ed, 'zone', pick('north'));
  assert.equal(ed.app.views.length, n);
  assert.deepEqual(ed.log.lines.filter((l) => l.msg === 'routing map click refused').map((l) => l.fields), [
    { action: 'view', reason: 'another screen' }, { action: 'zone', reason: 'another screen' },
  ]);
  assert.deepEqual(orderOf(lastView(ed.app)), orderOf(view));
  // And a step's actions on the other step.
  await choose(ed, 'crew', pick('v3'));
  await show(ed);
  assert.deepEqual(ed.log.lines.filter((l) => l.msg === 'routing map click refused').slice(-2).map((l) => l.fields), [
    { action: 'crew', reason: 'another step' }, { action: 'show', reason: 'another step' },
  ]);
});

// --- Optimize and Reset --------------------------------------------------------------

test('Optimize: the order is optimizeDay\'s from the Office; tapped again, "Already the best order found"', async () => {
  const ctx = setup();
  const view = await shown(ctx);
  await tap(ctx, 'optimize', `${versionOf(view)}:optimize`);
  const opt = lastView(ctx.app);
  const input = {
    day: DAY.day, asOf: DAY.asOf, limits: DAY.limits, crews: [{ ...DAY.crews[0], baseNode: OFFICE }], stops: DAY.stops.filter((s) => s.currentCrewId === 'v1'),
  };
  const expected = routing.optimizeDay(input, { travel: routing.travel.fromMatrix(DAY.matrix), returnToBase: true }).plans[0].stops.map((s) => s.stopId);
  assert.deepEqual(expected, ['s1', 's3', 's2', 's4']);
  assert.deepEqual(ctx.models.at(-1).model.route.stops.map((s) => s.node), expected.map((s) => `property:${s}`));
  assert.deepEqual(orderOf(opt), ['Ana Ruiz, Riverton', 'Cara Lind, Lakeside', 'Ben Ode, Riverton', 'Dev Patel, Lakeside']);
  assert.equal(header(opt), '*Maple crew, Monday 2026-11-02*\nDrive 26 min · about 12 km · last stop done 14:15 · back at Office 14:21 · no rule breaks');
  const uploads = ctx.app.uploads.length;
  await tap(ctx, 'optimize', `${versionOf(opt)}:optimize`);
  const again = lastView(ctx.app);
  assert.equal(contexts(again)[0], ROUTE_WORDS.best());
  assert.equal(ROUTE_WORDS.best(), 'Already the best order found.');
  assert.equal(imageOf(again).slack_file.id, imageOf(opt).slack_file.id, 'the map shown already is of this order');
  assert.equal(ctx.app.uploads.length, uploads, 'no new map');
  assert.equal(versionOf(again), versionOf(opt));
});

test('Optimize: stops it cannot place are appended in booked order and flagged; nothing is dropped', async () => {
  const day = JSON.parse(JSON.stringify(DAY));
  for (const s of day.stops.filter((x) => x.stopId === 's1' || x.stopId === 's2')) Object.assign(s, { locked: true, start: 480 });
  const ctx = setup({ data: fx.fakeData({ day }) });
  const view = await shown(ctx);
  await tap(ctx, 'optimize', `${versionOf(view)}:optimize`);
  const opt = lastView(ctx.app);
  assert.equal(rows(opt).length, 4, 'nothing dropped');
  assert.deepEqual(orderOf(opt), ['Ana Ruiz, Riverton', 'Cara Lind, Lakeside', 'Dev Patel, Lakeside', 'Ben Ode, Riverton']);
  const last = rows(opt)[3].text.split('\n');
  assert.equal(last[2], `⚠ ${ROUTE_WORDS.unplaced()}`, 'the "kept at the end" line stays, under the break');
  assert.ok(last[1].includes('🔴 missed locked start'), 'and its break');
  assert.ok(rows(opt).slice(0, 3).every((r) => !r.text.includes(ROUTE_WORDS.unplaced())));
  // Moved up, it is no longer "kept at the end": the flag goes from both
  // stops the move shifted; the rule break evaluateOrder finds stays.
  await menu(ctx, moveOf(opt, 4, 'up'));
  const moved = lastView(ctx.app);
  assert.deepEqual(orderOf(moved), ['Ana Ruiz, Riverton', 'Cara Lind, Lakeside', 'Ben Ode, Riverton', 'Dev Patel, Lakeside']);
  assert.ok(rows(moved).every((r) => !r.text.includes(ROUTE_WORDS.unplaced())), 'no stop claims "at the end" now');
  assert.ok(rows(moved)[2].text.split('\n')[1].includes('🔴 missed locked start'), 'its break still shows');
  // Optimize again flags it again.
  await tap(ctx, 'optimize', `${versionOf(moved)}:optimize`);
  assert.ok(rows(lastView(ctx.app))[3].text.includes(ROUTE_WORDS.unplaced()));
});

test('Reset to booked: the booked order, with times estimated again from the Office', async () => {
  const ctx = setup();
  const booked = await shown(ctx);
  await menu(ctx, moveOf(booked, 1, 'down'));
  await tap(ctx, 'optimize', `${versionOf(lastView(ctx.app))}:optimize`);
  await tap(ctx, 'reset', `${versionOf(lastView(ctx.app))}:reset`);
  const view = lastView(ctx.app);
  assert.deepEqual(texts(view).slice(1), texts(booked).slice(1));
  assert.equal(header(view), header(booked));
  assert.deepEqual(ctx.models.at(-1).model.route.stops.map((s) => s.node), V1_NODES);
});

// --- scope (AD-R17) -------------------------------------------------------------------

test('a crew lead: only their crew is offered; a crafted crewId still gives their own crew; mapPoints gets only the Office and their stops; labels never get the Office', async () => {
  const spy = spyAdapter();
  const ctx = setup({ mod: editorModule({ createAdapter: spy.createAdapter }) });
  await open(ctx, U.leadA);
  const [actions] = blocksOf(lastView(ctx.app), 'actions');
  assert.deepEqual(actions.elements[0].options.map((o) => o.value), ['v1']);
  await choose(ctx, 'crew', pick('v3'), { user: U.leadA });
  await show(ctx, { user: U.leadA });
  const view = lastView(ctx.app);
  assert.match(header(view), /^\*Maple crew, /);
  assert.deepEqual(spy.seen.route, [{
    day: DAY.day, crewId: 'v1', depot: OFFICE, scope: { crewId: 'v1' },
  }]);
  assert.deepEqual(ctx.mapPoints.asked, [[OFFICE, ...V1_NODES]]);
  for (const asked of spy.seen.labels) assert.ok(!asked.some((n) => n.startsWith('depot:')), 'labels never get the Office');
  assert.deepEqual(spy.seen.labels.at(-1), ['crew:v1', ...V1_NODES]);
  // A dispatcher's labels never get it either.
  const d = spyAdapter();
  const dctx = setup({ mod: editorModule({ createAdapter: d.createAdapter }) });
  await shown(dctx, { crew: 'v3' });
  assert.deepEqual(d.seen.route[0].crewId, 'v3');
  for (const asked of d.seen.labels) assert.ok(!asked.includes(OFFICE));
});

test('a crew lead whose crew is not in the data: step 1 with no crew offered, then "not working" on Show stops with Change crew or day; not a refusal; no positions read (PR #248 review)', async () => {
  const spy = spyAdapter();
  const ctx = setup({ mod: editorModule({ createAdapter: spy.createAdapter }) });
  await open(ctx, U.ghost);
  let view = lastView(ctx.app);
  assert.deepEqual(texts(view), [ROUTE_WORDS.pick()]);
  assert.deepEqual(blocksOf(view, 'actions')[0].elements.map((e) => e.action_id), ['routing-map:day', 'routing-map:show'], 'no crew offered');
  await show(ctx, { user: U.ghost });
  view = lastView(ctx.app);
  assert.deepEqual(texts(view), [ROUTE_WORDS.notWorking('Crew v9', 'Monday 2026-11-02')]);
  assert.deepEqual(blocksOf(view, 'actions')[0].elements.map((e) => e.action_id), ['routing-map:change']);
  assert.deepEqual(spy.seen.route.map((q) => q.crewId), ['v9'], 'their own crew, never another');
  assert.deepEqual(ctx.mapPoints.asked, []);
  assert.ok(!ctx.log.lines.some((l) => l.msg === 'routing map refused'));
});

// A data source whose day `day` has only the crews keep() keeps (and their stops).
function dataWithCrews(day, keep) {
  const data = fx.fakeData();
  const run = data.run.bind(data);
  data.run = async (sql, params = {}) => {
    const rows = await run(sql, params);
    if (sql === fx.SQL.day && params.day === day) {
      const p = rows[0].payload;
      p.crews = p.crews.filter((c) => keep(c.crewId));
      p.stops = p.stops.filter((st) => keep(st.currentCrewId));
    }
    return rows;
  };
  return data;
}
const inputReads = (ctx, day) => ctx.data.calls.filter((c) => c.sql === fx.SQL.day && c.params.day === day).length;

test('no crew picked (none working that day): Show stops says "Pick a crew first" and reads nothing (PR #248 review)', async () => {
  const spy = spyAdapter();
  const data = dataWithCrews('2026-11-03', () => false);
  const ctx = setup({ data, mod: editorModule({ createAdapter: spy.createAdapter }) });
  await open(ctx);
  await choose(ctx, 'day', date('2026-11-03'));
  let view = lastView(ctx.app);
  assert.deepEqual(blocksOf(view, 'actions')[0].elements.map((e) => e.action_id), ['routing-map:day', 'routing-map:show'], 'no crew to offer');
  const reads = ctx.data.calls.length;
  await show(ctx);
  view = lastView(ctx.app);
  assert.deepEqual(texts(view), [ROUTE_WORDS.pickCrew()]);
  assert.equal(blocksOf(view, 'actions')[0].elements.at(-1).action_id, 'routing-map:show', 'still step 1');
  assert.deepEqual(spy.seen.route, [], 'route() never called');
  assert.equal(ctx.data.calls.length, reads, 'nothing read');
  assert.deepEqual(ctx.mapPoints.asked, []);
  assert.deepEqual(ctx.app.uploads, []);
});

test('picking another day reads that day\'s crews once and offers them; a lead keeps their own crew, and on a day it is not working is told so plainly (PR #248 review)', async () => {
  const data = dataWithCrews('2026-11-03', (id) => id !== 'v1');
  const ctx = setup({ data });
  await open(ctx);
  await choose(ctx, 'day', date('2026-11-03'));
  assert.equal(inputReads(ctx, '2026-11-03'), 1, 'one read for the day');
  let [actions] = blocksOf(lastView(ctx.app), 'actions');
  assert.deepEqual(actions.elements[0].options.map((o) => o.value), ['v2', 'v3'], 'that day\'s crews');
  assert.equal(actions.elements[0].initial_option.value, 'v2', 'v1 is not offered, so the first that is');
  assert.equal(actions.elements[1].initial_date, '2026-11-03');
  await choose(ctx, 'crew', pick('v1'));
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.reason === 'unknown crew'), 'v1 not offered that day');

  const lead = setup({ data: dataWithCrews('2026-11-03', (id) => id !== 'v1') });
  await open(lead, U.leadA);
  await choose(lead, 'day', date('2026-11-03'), { user: U.leadA });
  [actions] = blocksOf(lastView(lead.app), 'actions');
  assert.deepEqual(actions.elements.map((e) => e.action_id), ['routing-map:day', 'routing-map:show'], 'no other crew is ever offered');
  await show(lead, { user: U.leadA });
  assert.deepEqual(texts(lastView(lead.app)), [ROUTE_WORDS.notWorking('Maple crew', 'Tuesday 2026-11-03')]);
  assert.ok(!lead.log.lines.some((l) => l.msg === 'routing map refused'));
  await tap(lead, 'change', 'change', { user: U.leadA });
  await choose(lead, 'day', date(DAY.day), { user: U.leadA });
  [actions] = blocksOf(lastView(lead.app), 'actions');
  assert.deepEqual(actions.elements[0].options.map((o) => o.value), ['v1'], 'their crew again on a day it works');
  await show(lead, { user: U.leadA });
  assert.match(header(lastView(lead.app)), /^\*Maple crew, Monday 2026-11-02\*/);
});

test('the crew\'s map colour is the one Routing\'s views give it (its place among the day\'s crews), not always 0 (PR #248 review)', async () => {
  const colorOf = (model, crewId) => model.crews.find((c) => c.crewId === crewId).color;
  for (const [crew, want] of [['v1', 0], ['v2', 1], ['v3', 2]]) {
    const ctx = setup();
    await shown(ctx, { crew });
    assert.equal(colorOf(ctx.models.at(-1).model, crew), want, crew);
    // Routing's Booked vs optimized view, same person and day.
    const views = setup();
    await open(views, U.dispatch, 'routing');
    await choose(views, 'crew', pick(crew));
    const drawn = views.models.findLast((m) => m.model.crews.some((c) => c.crewId === crew));
    assert.ok(drawn, `Routing's views drew ${crew}`);
    assert.equal(colorOf(drawn.model, crew), want, `${crew} matches Routing's views`);
  }
});

test('a person outside the audience is refused at Open; nothing is read', async () => {
  const ctx = setup();
  await open(ctx, U.member);
  assert.deepEqual(texts(lastView(ctx.app)), [`You don't have access to Plan a route; ask ${ADMIN}.`]);
  assert.deepEqual(ctx.data.calls, []);
});

// --- read-only, empty and too many --------------------------------------------------------

test('the crew is out that day: a banner, and the list is read-only (no ⋯ menus, no Optimize); a crafted move is refused', async () => {
  const ctx = setup();
  const view = await shown(ctx, { crew: 'v2' });
  assert.equal(texts(view)[1], `*${ROUTE_WORDS.crewOut('Birch crew', 'Monday 2026-11-02')}*`);
  assert.equal(ROUTE_WORDS.crewOut('Birch crew', 'Monday 2026-11-02'), 'Birch crew is marked out on Monday 2026-11-02. The list is read-only.');
  assert.deepEqual(topButtons(view).elements.map((e) => e.action_id), ['routing-map:change']);
  assert.equal(rows(view).length, 3);
  assert.ok(rows(view).every((r) => r.accessory === undefined), 'no menus');
  assert.equal(imageOf(view).alt_text, 'Route map: Planned route, Birch crew, 3 stops');
  const n = ctx.app.views.length;
  await menu(ctx, { value: `${versionOf(view)}:0:down` });
  await tap(ctx, 'optimize', `${versionOf(view)}:optimize`);
  assert.equal(ctx.app.views.length, n);
  assert.deepEqual(ctx.log.lines.filter((l) => l.msg === 'routing map click refused').map((l) => l.fields.reason), ['read only', 'read only']);
});

test('0 stops, or more than 40: a plain message with Change crew or day; no positions read, nothing drawn', async () => {
  const ctx = setup();
  await open(ctx);
  await choose(ctx, 'day', date('2026-11-03'));
  await show(ctx);
  let view = lastView(ctx.app);
  assert.deepEqual(texts(view), [ROUTE_WORDS.noStops('Maple crew', 'Tuesday 2026-11-03')]);
  assert.deepEqual(blocksOf(view, 'actions')[0].elements.map((e) => e.action_id), ['routing-map:change']);
  assert.deepEqual(ctx.mapPoints.asked, []);

  const many = editorModule({
    createAdapter: (args) => {
      const real = fx.createAdapter(args);
      return {
        ...real,
        route: async (q) => {
          const got = await real.route(q);
          const extra = Array.from({ length: MAX_STOPS + 1 - got.input.stops.length }, (_, i) => ({ ...got.input.stops[0], stopId: `m${i}`, routeOrder: 10 + i }));
          return { ...got, input: { ...got.input, stops: [...got.input.stops, ...extra] } };
        },
      };
    },
  });
  const big = setup({ mod: many });
  await shown(big);
  view = lastView(big.app);
  assert.deepEqual(texts(view), [ROUTE_WORDS.tooMany('Maple crew', 41, 40)]);
  assert.equal(ROUTE_WORDS.tooMany('Maple crew', 41, 40), 'Maple crew has too many stops to plan here (41; at most 40).');
  assert.deepEqual(blocksOf(view, 'actions')[0].elements.map((e) => e.action_id), ['routing-map:change']);
  assert.deepEqual(big.mapPoints.asked, []);
  assert.deepEqual(big.app.uploads, []);
});

test('40 stops fit one view in fewer than 60 blocks: every block within Slack\'s limits (the fake checks), every block_id unique; 1 to 10 numbered with keycaps, 11 on with "11."', async () => {
  const nodes = Array.from({ length: 40 }, (_, i) => `property:z${i}`);
  const every = [OFFICE, ...nodes];
  const matrix = [];
  for (const from of every) for (const to of every) if (from !== to) matrix.push({ from_node: from, to_node: to, minutes: 5, km_tenths: 12 });
  const forty = editorModule({
    createAdapter: (args) => {
      const real = fx.createAdapter(args);
      return {
        ...real,
        route: async (q) => {
          const got = await real.route(q);
          const stops = nodes.map((node, i) => ({
            ...got.input.stops[0], stopId: `z${i}`, node, routeOrder: i + 1, serviceMinutes: 10, labourMinutes: 30,
          }));
          return {
            input: { ...got.input, stops },
            travel: routing.travel.fromMatrix(matrix),
            distance: () => 12,
          };
        },
        labels: async () => ({ 'crew:v1': { crewName: 'Maple crew' } }),
      };
    },
  });
  const mapPoints = async (d, ids) => ({ points: ids.map((node, i) => ({ node, x: 40 + (i % 8) * 70, y: 40 + Math.floor(i / 8) * 80 })), mosaic: null });
  const ctx = setup({ mod: forty, mapPoints });
  const view = await shown(ctx);
  assert.equal(rows(view).length, 40);
  assert.ok(view.blocks.length < 60, `${view.blocks.length} blocks`);
  assert.equal(view.blocks.length, 47, 'header, image, the ring legend, note, actions, two Office rows, 40 stop rows');
  const ids = view.blocks.map((b) => b.block_id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(rows(view)[0].text.split(' ')[0], '1️⃣');
  assert.equal(rows(view)[8].text.split(' ')[0], '9️⃣');
  assert.equal(rows(view)[9].text.split(' ')[0], '🔟');
  assert.equal(rows(view)[10].text.split(' ')[0], '11.');
  assert.match(rows(view)[39].text, /^40\. \*\d\d:\d\d( \(next day\))? a stop\*\n🚐 5 min/);
  assert.equal(moveOf(view, 40, 'down'), undefined);
  assert.deepEqual(rows(view)[39].options.map((o) => o.text.text), ['Move stop 40 up', 'Move stop 40 to first']);
  for (const r of rows(view)) for (const o of r.options) assert.ok(Array.from(o.text.text).length <= 75);
});

// --- the Slack fake rejects what Slack rejects (Story 15.14) --------------------------------

test('the fake refuses a duplicate block_id, a duplicate action_id in one block, a button value over 2000, an accessibility_label over 75, and a reused slack_file that was deleted', async () => {
  const app = new FakeSlackApp({ views: true });
  const png = renderPng('route', JSON.parse(JSON.stringify(require('../fixtures/routing-map/route.json').model)));
  const up = await app.client.files.uploadV2({ file: png, filename: 'route-map.png', title: 'Route map' });
  const id = up.files[0].files[0].id;
  const btn = (over = {}) => ({
    type: 'button', action_id: 'routing-map:optimize', text: { type: 'plain_text', text: 'Optimize' }, value: '1:optimize', accessibility_label: 'Optimize the order from the Office', ...over,
  });
  const view = (blocks) => ({ type: 'modal', title: { type: 'plain_text', text: 'Plan a route' }, blocks });
  const section = (blockId) => ({ type: 'section', block_id: blockId, text: { type: 'mrkdwn', text: 'x' } });
  const image = { type: 'image', slack_file: { id }, alt_text: 'Route map: Planned route, Maple crew, 6 stops' };
  const update = (v) => app.client.views.update({ view_id: 'V1', view: v });
  const refused = (v, code, what) => assert.rejects(update(v), (e) => e.data.error === code, what);
  // What the editor sends is accepted.
  await update(view([section('a'), image, { type: 'actions', block_id: 'b', elements: [btn(), btn({ action_id: 'routing-map:reset', text: { type: 'plain_text', text: 'Reset to booked' } })] }]));
  await refused(view([section('a'), section('a')]), 'invalid_blocks', 'duplicate block_id');
  await refused(view([{ type: 'actions', block_id: 'b', elements: [btn(), btn()] }]), 'invalid_blocks', 'duplicate action_id');
  await refused(view([{ type: 'actions', elements: [btn({ value: 'x'.repeat(2001) })] }]), 'invalid_blocks', 'value over 2000');
  await update(view([{ type: 'actions', elements: [btn({ value: 'x'.repeat(2000) })] }]));
  await refused(view([{ type: 'actions', elements: [btn({ accessibility_label: 'x'.repeat(76) })] }]), 'invalid_blocks', 'label over 75');
  await update(view([{ type: 'actions', elements: [btn({ accessibility_label: 'x'.repeat(75) })] }]));
  // The same action_id in two blocks is fine, as in Slack.
  await update(view([{ type: 'actions', block_id: 'b1', elements: [btn()] }, { type: 'actions', block_id: 'b2', elements: [btn()] }]));
  await app.client.files.delete({ file: id });
  await refused(view([image]), 'invalid_arguments', 'a deleted file reused');
});

test('the fake refuses an overflow Slack would refuse: fewer than 2 or more than 5 options, an option text over 75, an option value over 150, an accessibility_label, a duplicate action_id in one block; an overflow click carries selected_option.value only (Story 15.16)', async () => {
  const app = new FakeSlackApp({ views: true });
  const opt = (i, over = {}) => ({ text: { type: 'plain_text', text: `Move stop ${i} up` }, value: `1:${i}:up`, ...over });
  const overflow = (over = {}) => ({
    type: 'overflow', action_id: 'routing-map:move', options: [opt(1), opt(2)], ...over,
  });
  const row = (accessory) => ({
    type: 'section', block_id: 's', text: { type: 'mrkdwn', text: 'x' }, accessory,
  });
  const view = (blocks) => ({ type: 'modal', title: { type: 'plain_text', text: 'Plan a route' }, blocks });
  const update = (v) => app.client.views.update({ view_id: 'V1', view: v });
  const refused = (v, what) => assert.rejects(update(v), (e) => e.data.error === 'invalid_blocks', what);
  await update(view([row(overflow())]));
  await update(view([row(overflow({ options: [1, 2, 3, 4, 5].map((i) => opt(i)) }))]));
  await refused(view([row(overflow({ options: [opt(1)] }))]), 'one option');
  await refused(view([row(overflow({ options: [1, 2, 3, 4, 5, 6].map((i) => opt(i)) }))]), 'six options');
  await refused(view([row(overflow({ options: [opt(1), opt(2, { text: { type: 'plain_text', text: 'x'.repeat(76) } })] }))]), 'option text over 75');
  await update(view([row(overflow({ options: [opt(1), opt(2, { text: { type: 'plain_text', text: 'x'.repeat(75) } })] }))]));
  await refused(view([row(overflow({ options: [opt(1), opt(2, { text: { type: 'mrkdwn', text: 'x' } })] }))]), 'option text not plain_text');
  await refused(view([row(overflow({ options: [opt(1), opt(2, { value: 'x'.repeat(151) })] }))]), 'option value over 150');
  await update(view([row(overflow({ options: [opt(1), opt(2, { value: 'x'.repeat(150) })] }))]));
  await refused(view([row(overflow({ options: [opt(1), opt(2, { value: '' })] }))]), 'option value empty');
  await refused(view([row(overflow({ accessibility_label: 'Move stop 1' }))]), 'an overflow has no accessibility_label');
  await refused(view([{ type: 'actions', block_id: 'a', elements: [overflow(), overflow()] }]), 'duplicate action_id in one block');
  await update(view([row(overflow()), { ...row(overflow()), block_id: 't' }]));

  // The click, as Slack sends it.
  const seen = [];
  app.action(/^routing-map:move$/, async ({ action, ack }) => { await ack(); seen.push(action); });
  await app.dispatchAction('routing-map:move', { view: { id: 'V1', type: 'modal' }, option: opt(3) });
  assert.deepEqual(seen, [{ type: 'overflow', action_id: 'routing-map:move', selected_option: { text: { type: 'plain_text', text: 'Move stop 3 up' }, value: '1:3:up' } }]);
  assert.ok(!('value' in seen[0]));
});

// --- the ⋯ menu (Story 15.16, AD-R29) ------------------------------------------------------

test('⋯ Move to first and Move to last move the stop to the ends; up and down move it one place; each redraws as ↑/↓ did (list first, then one map)', async () => {
  const ctx = setup();
  let view = await shown(ctx);
  const uploads = ctx.app.uploads.length;
  await menu(ctx, moveOf(view, 3, 'first'));
  view = lastView(ctx.app);
  assert.deepEqual(orderOf(view), ['Cara Lind, Lakeside', 'Ana Ruiz, Riverton', 'Ben Ode, Riverton', 'Dev Patel, Lakeside']);
  assert.deepEqual(ctx.models.at(-1).model.route.stops.map((s) => s.node), ['property:s3', 'property:s1', 'property:s2', 'property:s4']);
  assert.equal(ctx.app.uploads.length, uploads + 1, 'one map');
  const [list] = calls(ctx.app, 'update').slice(-2).map((u) => u.view);
  assert.equal(contexts(list)[0], UPDATING, 'the list first, with "Map updating…"');
  await menu(ctx, moveOf(view, 1, 'last'));
  view = lastView(ctx.app);
  assert.deepEqual(orderOf(view), ['Ana Ruiz, Riverton', 'Ben Ode, Riverton', 'Dev Patel, Lakeside', 'Cara Lind, Lakeside']);
  await menu(ctx, moveOf(view, 4, 'up'));
  view = lastView(ctx.app);
  assert.deepEqual(orderOf(view), ['Ana Ruiz, Riverton', 'Ben Ode, Riverton', 'Cara Lind, Lakeside', 'Dev Patel, Lakeside']);
  assert.equal(versionOf(view), 4);
  assert.deepEqual(rows(view)[0].options.map((o) => o.value), ['4:0:down', '4:0:last'], 'the options carry the new version');
  // Logged by action only: no index, target or stop id.
  const moves = ctx.log.lines.filter((l) => l.fields && l.fields.action === 'move');
  assert.equal(moves.length, 3);
  for (const l of moves) assert.deepEqual(l.fields, { module: 'route-planner', action: 'move', view: 'route' });
});

test('a one-stop day has no menu', async () => {
  const one = editorModule({
    createAdapter: (args) => {
      const real = fx.createAdapter(args);
      return {
        ...real,
        route: async (q) => {
          const got = await real.route(q);
          return { ...got, input: { ...got.input, stops: got.input.stops.filter((st) => st.stopId === 's1') } };
        },
      };
    },
  });
  const ctx = setup({ mod: one });
  const view = await shown(ctx);
  assert.equal(rows(view).length, 1);
  assert.equal(rows(view)[0].accessory, undefined);
  assert.equal(rows(view)[0].text, '1️⃣ *08:00 Ana Ruiz* · Riverton\n🚐 5 min');
});

test('a soft break alone shows 🟠, shortened: "past 17:00 (+30 min)"', async () => {
  const day = JSON.parse(JSON.stringify(DAY));
  Object.assign(day.stops.find((s) => s.stopId === 's4'), { locked: true, start: 960 });
  const ctx = setup({ data: fx.fakeData({ day }) });
  const view = await shown(ctx);
  assert.equal(rows(view)[3].text, '4️⃣ *16:00 Dev Patel* · Lakeside\n🚐 6 min · 🟠 past 17:00 (+30 min)');
});

test('a routing-map:up or :down click (a modal opened before the deploy) gives the expired words; on a live session too, which then ends', async () => {
  // Before the deploy: no session in this process.
  const before = setup();
  const view = await shown(before);
  const fresh = setup();
  for (const which of ['up', 'down']) {
    await fresh.app.dispatchAction(`routing-map:${which}`, {
      user: U.dispatch, value: '1:s1', view: { id: 'V1', type: 'modal', private_metadata: view.private_metadata, title: view.title },
    });
    assert.deepEqual(texts(lastView(fresh.app)), [ROUTE_WORDS.expired('Plan a route')], which);
  }
  assert.ok(fresh.log.lines.every((l) => l.msg !== 'routing map click refused' || l.fields.reason === 'expired'));
  // A crafted one on a live session: the same words, the session ends.
  await tap(before, 'up', '1:s2');
  assert.deepEqual(texts(lastView(before.app)), [ROUTE_WORDS.expired('Plan a route')]);
  assert.ok(before.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.action === 'up' && l.fields.reason === 'retired'));
  await menu(before, { value: '1:0:down' });
  assert.deepEqual(texts(lastView(before.app)), [ROUTE_WORDS.expired('Plan a route')], 'nothing works on it after');
});

// --- nothing leaks (AD-R12 amended, AD-R25) ---------------------------------------------------

const MICRO = Object.values(DAY.places).flatMap((p) => [p.lat_e6, p.lon_e6]).filter(Number.isInteger).map(String);
const ADDRESSES = Object.values(DAY.places).flatMap((p) => [p.street_address, p.postal_code]).filter(Boolean);
function holds(v, test, seen = new Set()) {
  if (v === null || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  if (Buffer.isBuffer(v)) return false;
  if (test(v)) return true;
  return Object.values(v).some((x) => holds(x, test, seen));
}
const xy = (o) => Object.hasOwn(o, 'x') || Object.hasOwn(o, 'y');
const mosaicKeys = (o) => ['mosaic', 'tx0', 'ty0', 'ox', 'oy', 'km_tenths'].some((k) => Object.hasOwn(o, k));

test('no log line, Slack call or error holds a position, an x/y key, the mosaic, a leg\'s km_tenths or a fixture coordinate', async () => {
  const errors = [];
  const ctx = setup();
  for (const user of [U.dispatch, U.leadA, U.leadB, U.ghost]) {
    await shown(ctx, { user });
    const view = lastView(ctx.app);
    if (rows(view).length > 1 && moveOf(view, 1, 'down')) {
      await menu(ctx, moveOf(view, 1, 'down'), { user });
      await tap(ctx, 'optimize', `${versionOf(lastView(ctx.app))}:optimize`, { user });
      await tap(ctx, 'reset', `${versionOf(lastView(ctx.app))}:reset`, { user });
      await tap(ctx, 'change', 'change', { user });
    }
  }
  const broken = setup({ mapPoints: async (d, ids, frame) => { const r = await fx.fakeMapPoints()(d, ids, frame); return { ...r, points: r.points.slice(1) }; } });
  await shown(broken);
  const failing = setup({ render: () => { throw new RoutingFault({ field: 'map image', problem: 'renderer_failed' }); } });
  await shown(failing);
  const legs = DAY.matrix.map((r) => r.km_tenths).filter((k) => k >= 100).map((k) => `${(k / 10).toFixed(1)} km`);
  for (const c of [ctx, broken, failing]) {
    for (const l of c.log.lines) if (l.fields && l.fields.err) errors.push(l.fields.err);
    const records = [
      ['log', c.log.lines], ['views', c.app.views], ['uploads', c.app.uploads.map(({ file, ...rest }) => rest)],
      ['deleted', c.app.deleted], ['responded', c.app.responded], ['posted', c.app.posted], ['errors', errors],
    ];
    for (const [name, rec] of records) {
      assert.equal(holds(rec, xy), false, `${name} holds a points object or an x/y key`);
      assert.equal(holds(rec, mosaicKeys), false, `${name} holds the mosaic or a leg's km_tenths`);
      const text = JSON.stringify(rec);
      for (const m of MICRO) assert.ok(!text.includes(m), `${name} holds a micro-degree value`);
      for (const a of ADDRESSES) assert.ok(!text.includes(a), `${name} holds an address or postal code`);
      for (const k of [fx.FAKE_MOSAIC.tx0, fx.FAKE_MOSAIC.ty0].map(String)) assert.ok(!text.includes(k), `${name} holds a tile number`);
      for (const leg of legs) assert.ok(!text.includes(leg), `${name} holds a leg's distance`);
    }
    assert.ok(!JSON.stringify(c.log.lines).includes(' km'), 'no distance in any log line');
  }
  assert.ok(ctx.models.length > 0, 'the renderer did get points');
  for (const { opts } of ctx.models) assert.ok(!holds(opts, (o) => Object.hasOwn(o, 'mosaic')), 'the renderer never gets the mosaic');
});

// --- exits ---------------------------------------------------------------------------

test('exit, Change crew or day: back to step 1 with the picks kept, and the files deleted', async () => {
  const ctx = setup();
  await shown(ctx, { crew: 'v3' });
  assert.equal(ctx.store.mapFilesOf('UDISPATCH:V1').length, 1);
  await tap(ctx, 'change', 'change');
  const view = lastView(ctx.app);
  assert.deepEqual(texts(view), [ROUTE_WORDS.pick()]);
  assert.equal(blocksOf(view, 'image').length, 0);
  assert.equal(blocksOf(view, 'actions')[0].elements[0].initial_option.value, 'v3');
  assert.deepEqual(ctx.app.deleted, ['F1']);
  assert.equal(ctx.store.mapFileCount(), 0);
  // A menu option from the old list is refused now; Show stops works again.
  await menu(ctx, { value: '1:0:down' });
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.reason === 'another step'));
  await show(ctx);
  assert.equal(imageOf(lastView(ctx.app)).slack_file.id, 'F2');
});

for (const cleared of [false, true]) {
  test(`exit, ${cleared ? 'Close (the X)' : 'Back'}: view_closed deletes the files; the session and its positions are gone`, async () => {
    const ctx = setup();
    const view = await shown(ctx);
    await menu(ctx, moveOf(view, 1, 'down'));
    assert.equal(await ctx.app.dispatchViewClosed('hub:map', { user: U.dispatch, view: { id: 'V1' }, is_cleared: cleared }), 1);
    assert.deepEqual(ctx.app.deleted, ['F1', 'F2']);
    assert.equal(ctx.store.mapFileCount(), 0);
    assert.ok(ctx.log.lines.some((l) => l.msg === 'map view closed' && l.fields.cleared === cleared));
    await menu(ctx, { value: '2:1:up' });
    assert.deepEqual(texts(lastView(ctx.app)), [ROUTE_WORDS.expired('Plan a route')]);
  });
}

test('exit, Back with no view_closed: the sweep deletes the files within 20 minutes of upload (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
  const store = createStore();
  let jobs;
  const ctx = setup({ store, sweeping: () => jobs.running('sweep-map-files') });
  jobs = createEngineJobs({ names: ['sweep-map-files'], store, client: ctx.app.client, log: ctx.log });
  jobs.start();
  await shown(ctx);
  const uploaded = Date.now();
  let goneAt = null;
  for (let m = 1; m <= 25 && goneAt === null; m += 1) {
    t.mock.timers.tick(MIN);
    await settle(5);
    if (ctx.app.deleted.includes('F1')) goneAt = Date.now();
  }
  assert.ok(goneAt !== null && goneAt - uploaded <= 20 * MIN, 'deleted within 20 minutes');
  jobs.stop();
});

test('exit, an expired trigger on Open: the hub\'s existing path; no modal, nothing read', async () => {
  const ctx = setup();
  ctx.app.viewsFail.push = Object.assign(new Error('An API error occurred: expired_trigger_id'), { data: { ok: false, error: 'expired_trigger_id' } });
  await ctx.app.dispatchAction('route-planner:open', { user: U.dispatch, view: { ...MENU, hash: 'hmenu' } });
  const [update] = calls(ctx.app, 'update');
  assert.equal(update.view_id, 'VMENU');
  assert.deepEqual(texts(update.view), [MAP_NEEDS_WINDOW]);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'hub modal fallback' && l.fields.reason === 'expired_trigger_id'));
  assert.deepEqual(ctx.data.calls, []);
});

test('exit, an expired session (15 minutes without use): "This plan has expired, go back and open Plan a route again." (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const ctx = setup();
  const view = await shown(ctx);
  t.mock.timers.tick(14 * MIN);
  await menu(ctx, moveOf(view, 1, 'down'));
  assert.equal(versionOf(lastView(ctx.app)), 2, 'a tap within 15 minutes works and renews the session');
  t.mock.timers.tick(15 * MIN + 1);
  const uploads = ctx.app.uploads.length;
  await menu(ctx, moveOf(lastView(ctx.app), 1, 'down'));
  const shownNow = lastView(ctx.app);
  assert.deepEqual(texts(shownNow), ['This plan has expired, go back and open Plan a route again.']);
  assert.equal(shownNow.close.text, 'Back');
  assert.equal(ctx.app.uploads.length, uploads);
  assert.equal(ctx.store.mapFilesOf('UDISPATCH:V1').length, 0, 'its map deleted');
});

test('exit, the session expires while the map waits: the expired words, nothing uploaded (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const ctx = setup({ wait: 750 });
  await open(ctx);
  const first = show(ctx);
  await settle();
  t.mock.timers.tick(0);
  await first;
  const pending = menu(ctx, moveOf(lastView(ctx.app), 1, 'down'));
  await settle();
  t.mock.timers.tick(15 * MIN + 1);
  await pending;
  assert.deepEqual(texts(lastView(ctx.app)), [ROUTE_WORDS.expired('Plan a route')]);
  assert.equal(ctx.app.uploads.length, 1);
});

test('exit, access withdrawn: on a tap, and while the map waits, the refusal shows in the view and the files are deleted', async () => {
  let withdrawn = false;
  const ctx = setup({ canUse: () => (withdrawn ? 'denied' : 'allowed') });
  const view = await shown(ctx);
  withdrawn = true;
  await menu(ctx, moveOf(view, 1, 'down'));
  assert.deepEqual(texts(lastView(ctx.app)), [`You don't have access to Plan a route; ask ${ADMIN}.`]);
  assert.equal(ctx.store.mapFileCount(), 0);
  assert.equal(ctx.app.uploads.length, 1);

  // Withdrawn between the list and the map.
  let gone = false;
  const late = setup({ canUse: () => (gone ? 'denied' : 'allowed') });
  const v2 = await shown(late);
  const update = late.app.client.views.update;
  late.app.client.views.update = async (args) => {
    const res = await update(args);
    if (texts(args.view).some((x) => x.startsWith('1️⃣ *08:00 Ben Ode*'))) gone = true;
    return res;
  };
  await menu(late, moveOf(v2, 1, 'down'));
  assert.deepEqual(texts(lastView(late.app)), [`You don't have access to Plan a route; ask ${ADMIN}.`]);
  assert.equal(late.app.uploads.length, 1, 'no map for it');
  assert.equal(late.store.mapFileCount(), 0);
});

test('exit, a click from another user is refused and changes nothing; from another view it is told so there', async () => {
  const ctx = setup();
  const view = await shown(ctx);
  const n = ctx.app.views.length;
  await menu(ctx, moveOf(view, 1, 'down'), { user: U.leadB });
  assert.equal(ctx.app.views.length, n, 'the view is not touched');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.reason === 'another user'));
  await menu(ctx, moveOf(view, 1, 'down'), {
    view: {
      id: 'V9', type: 'modal', private_metadata: view.private_metadata, title: view.title,
    },
  });
  const other = calls(ctx.app, 'update').at(-1);
  assert.equal(other.view_id, 'V9');
  assert.deepEqual(texts(other.view), [MAP_WORDS.notYours()]);
  assert.deepEqual(orderOf(lastViewOf(ctx, 'V1')), orderOf(view), 'the order unchanged');
});
const lastViewOf = (ctx, id) => calls(ctx.app, 'update').filter((u) => u.view_id === id).at(-1).view;

const errorExit = (ctx, words) => {
  const view = lastView(ctx.app);
  assert.deepEqual(texts(view), [words]);
  assert.equal(view.close.text, 'Back', 'with Back');
  assert.equal(view.callback_id, 'hub:map');
  assert.equal(blocksOf(view, 'image').length, 0);
  assert.deepEqual(ctx.app.uploads, []);
};

test('exit, data unavailable on Show stops: the error exit with Back', async () => {
  const ctx = setup();
  await open(ctx);
  ctx.data.failWith = new DataUnavailable('fixture down');
  await show(ctx);
  errorExit(ctx, DATA_DOWN);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'data unavailable' && l.fields.reason === 'fixture down'));
});

test('exit, an engine fault on Show stops: the error exit with Back; logged by field and problem', async () => {
  const bad = editorModule({
    createAdapter: (args) => {
      const real = fx.createAdapter(args);
      return { ...real, route: async (q) => ({ ...(await real.route(q)), distance: () => -1 }) };
    },
  });
  const ctx = setup({ mod: bad });
  await shown(ctx);
  errorExit(ctx, PLAN_FAILED);
  assert.deepEqual(ctx.log.lines.find((l) => l.msg === 'routing map not drawn').fields, {
    module: 'route-planner', view: 'route', field: 'distance', problem: 'not_integer',
  });
  const noRoute = setup({ data: fx.fakeData({ day: { ...DAY, matrix: DAY.matrix.filter((r) => r.from_node !== OFFICE) } }) });
  await shown(noRoute);
  errorExit(noRoute, PLAN_FAILED);
});

test('exit, a node missing from mapPoints: the error exit', async () => {
  const points = fx.fakeMapPoints();
  const ctx = setup({
    mapPoints: async (d, ids, frame) => { const r = await points(d, ids, frame); return { ...r, points: r.points.filter((p) => p.node !== OFFICE) }; },
  });
  await shown(ctx);
  errorExit(ctx, PLAN_FAILED);
  assert.deepEqual(ctx.log.lines.find((l) => l.msg === 'routing map not drawn').fields, {
    module: 'route-planner', view: 'route', field: 'mapPoints', problem: 'no_position',
  });
});

test('exit, a map failure (render, upload, ratelimited, not accepted) keeps the list with "Map not updated; the list is current."', async () => {
  const failures = {
    render: { render: () => { throw new RoutingFault({ field: 'map image', problem: 'renderer_failed' }); } },
    upload: { fail: (app) => { app.filesFail = new Error('upload broke'); } },
    ratelimited: { fail: (app) => { app.rateLimited.add('files.uploadV2'); } },
    'not accepted': { fail: (app) => { app.filesNotReadyFor = Infinity; } },
  };
  for (const [what, how] of Object.entries(failures)) {
    // On Show stops: the list, no image.
    const ctx = setup(how.render ? { render: how.render } : {});
    if (how.fail) how.fail(ctx.app);
    await shown(ctx);
    let view = lastView(ctx.app);
    assert.equal(contexts(view)[0], NOT_UPDATED, what);
    assert.equal(rows(view).length, 4, `${what}: the list works`);
    assert.equal(blocksOf(view, 'image').length, 0, what);
    assert.equal(ctx.store.mapFileCount(), 0, `${what}: nothing left recorded`);
    // On a tap: the list under the map still shown, which says it is not updated.
    if (how.render) continue; // the next test breaks the renderer after the first map
    const tapped = setup();
    const before = await shown(tapped);
    how.fail(tapped.app);
    await menu(tapped, moveOf(before, 1, 'down'));
    view = lastView(tapped.app);
    assert.equal(contexts(view)[0], NOT_UPDATED, `${what} on a tap`);
    assert.equal(imageOf(view).slack_file.id, 'F1', `${what}: the map shown stays`);
    assert.deepEqual(orderOf(view), ['Ben Ode, Riverton', 'Ana Ruiz, Riverton', 'Cara Lind, Lakeside', 'Dev Patel, Lakeside']);
    assert.deepEqual(tapped.store.mapFilesOf('UDISPATCH:V1'), ['F1']);
  }
});

test('exit, a render failure on a tap keeps the list under the map shown, with "Map not updated; the list is current."', async () => {
  let broken = false;
  const ctx = setup({ render: (...a) => { if (broken) throw new RoutingFault({ field: 'map image', problem: 'renderer_failed' }); return renderPng(...a); } });
  const view = await shown(ctx);
  broken = true;
  await menu(ctx, moveOf(view, 1, 'down'));
  const now = lastView(ctx.app);
  assert.equal(contexts(now)[0], NOT_UPDATED);
  assert.equal(imageOf(now).slack_file.id, 'F1');
  assert.equal(rows(now).length, 4);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'route map not drawn' && l.fields.reason === 'renderer_failed'));
  assert.equal(ctx.app.uploads.length, 1);
});

test('exit, a reused file that expired (10 minutes) or was deleted: the list without the image; the file deleted (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const ctx = setup({ wait: 750 });
  await open(ctx);
  let p = show(ctx);
  await settle();
  t.mock.timers.tick(0);
  await p;
  t.mock.timers.tick(REUSE_MS);
  p = menu(ctx, moveOf(lastView(ctx.app), 1, 'down'));
  await settle();
  let view = lastView(ctx.app);
  assert.equal(blocksOf(view, 'image').length, 0, 'too old: the list with no image');
  assert.equal(contexts(view)[0], UPDATING);
  assert.equal(rows(view).length, 4);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'map image not reused' && l.fields.reason === 'too old'));
  await settle();
  assert.deepEqual(ctx.app.deleted, ['F1'], 'the file no longer shown is deleted');
  t.mock.timers.tick(750);
  await p;
  assert.equal(imageOf(lastView(ctx.app)).slack_file.id, 'F2', 'then the new map');

  // Deleted behind the hub's back (the sweep, or Slack): Slack refuses it.
  await ctx.app.client.files.delete({ file: 'F2' });
  p = menu(ctx, moveOf(lastView(ctx.app), 2, 'down'));
  await settle();
  view = lastView(ctx.app);
  assert.equal(blocksOf(view, 'image').length, 0, 'deleted: the list with no image');
  assert.equal(rows(view).length, 4);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'map image not reused' && l.fields.reason === 'refused by slack'));
  t.mock.timers.tick(750);
  await p;
  assert.equal(imageOf(lastView(ctx.app)).slack_file.id, 'F3');
});

test('a list queued while a newer map is going to Slack reuses that newer file, never the one it replaces and deletes (the view\'s update queue, PR #248 review)', async () => {
  const ctx = setup();
  await shown(ctx);
  // Hold the update that shows F2 in flight, so the next tap's list queues
  // behind it.
  const views = ctx.app.client.views;
  const real = views.update;
  let release;
  const held = new Promise((r) => { release = r; });
  let holding = false;
  views.update = async (args) => {
    if (args.view.blocks.some((b) => b.type === 'image' && b.slack_file.id === 'F2')) {
      holding = true;
      await held;
    }
    return real(args);
  };
  const first = menu(ctx, moveOf(lastView(ctx.app), 1, 'down'));
  await settle();
  assert.equal(holding, true, 'the map with F2 is on its way');
  const listed = lastView(ctx.app);
  assert.equal(imageOf(listed).slack_file.id, 'F1', 'the first tap\'s list under F1');
  const sent = ctx.app.views.length;
  const second = menu(ctx, moveOf(listed, 2, 'down'));
  await settle();
  assert.equal(ctx.app.views.length, sent, 'the second list waits its turn');
  release();
  await Promise.all([first, second]);
  const updates = calls(ctx.app, 'update').slice(-3).map((u) => u.view);
  const [map, list, newer] = updates;
  assert.equal(imageOf(map).slack_file.id, 'F2', 'the first tap\'s map');
  assert.equal(imageOf(list).slack_file.id, 'F2', 'the second list reuses the file shown now, not F1');
  assert.equal(contexts(list)[0], UPDATING);
  assert.equal(imageOf(newer).slack_file.id, 'F3', 'then the second tap\'s map');
  assert.ok(!ctx.log.lines.some((l) => l.msg === 'map image not reused'), 'nothing refused or missed');
  assert.deepEqual(ctx.app.deleted, ['F1', 'F2']);
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F3']);
});

test('a street map (Story 15.10): the attribution straight under the image, kept when the image is reused', async () => {
  const fake = createFakeTiles();
  const { fetchMosaic: real } = createBasemap();
  const tiles = [];
  const fetchMosaic = (mosaic, opts) => { tiles.push(mosaic); return real(mosaic, { ...opts, fetch: fake.fetch, env: {} }); };
  const streets = { ...profile, routing: { ...profile.routing, basemap: SOURCE } };
  const ctx = setup({ profile: streets, fetchMosaic, mapPoints: fx.fakeMapPoints({ mosaic: { ...fx.FAKE_MOSAIC, cols: 4 } }) });
  const view = await shown(ctx);
  const at = view.blocks.findIndex((b) => b.type === 'image');
  const caption = '<https://tiles.example.org/copyright|© Example Map contributors>';
  assert.equal(view.blocks[at + 1].elements[0].text, caption);
  await menu(ctx, moveOf(view, 1, 'down'));
  assert.equal(tiles.length, 2, 'the tiles for each map, from the session\'s mosaic (no new read)');
  assert.deepEqual(ctx.mapPoints.asked.length, 1);
  const list = calls(ctx.app, 'update').at(-2).view;
  const i = list.blocks.findIndex((b) => b.type === 'image');
  assert.equal(list.blocks[i + 1].elements[0].text, caption, 'the reused image keeps its caption');
  assert.equal(list.blocks[i + 2].elements[0].text, UPDATING);
});

test('a click from outside a modal is told to open it in its window', async () => {
  const ctx = setup();
  await ctx.app.dispatchAction('routing-map:show', { user: U.dispatch, value: 'show' });
  assert.deepEqual(ctx.app.responded.map((r) => r.text), [MAP_NEEDS_WINDOW]);
});

// --- Story 15.18: the map's rings and their legend (AD-R29) ---------------------------------

test('Story 15.18: each stop\'s map flag is its hardest rule break from evaluateOrder; the ring legend sits under the image only when a stop has one', async () => {
  const day = JSON.parse(JSON.stringify(DAY));
  // s3 locked at 16:40 ends past the 17:00 aim (soft); s4 then ends past 19:00 (hard as well).
  Object.assign(day.stops.find((s) => s.stopId === 's3'), { locked: true, start: 1000 });
  const ctx = setup({ data: fx.fakeData({ day }) });
  const view = await shown(ctx);
  const { model } = ctx.models.at(-1);
  assert.deepEqual(model.route.stops, [
    { node: 'property:s1', flag: 'none' }, { node: 'property:s2', flag: 'none' },
    { node: 'property:s3', flag: 'soft' }, { node: 'property:s4', flag: 'hard' },
  ]);
  assert.equal(ROUTE_WORDS.legend(), '🟠 ring: soft rule break · 🔴 ring: hard rule break');
  const at = view.blocks.indexOf(imageOf(view));
  assert.deepEqual(view.blocks[at + 1].elements.map((e) => e.text), [ROUTE_WORDS.legend()], 'straight under the image');
  assert.equal(contexts(view).filter((t) => t === ROUTE_WORDS.legend()).length, 1, 'once');
  // No stop flagged: no legend.
  const calm = setup();
  const plain = await shown(calm);
  assert.ok(calm.models.at(-1).model.route.stops.every((s) => s.flag === 'none'));
  assert.ok(!contexts(plain).includes(ROUTE_WORDS.legend()));
});
