'use strict';

// Story 19.4 (plan brightside-v1 D8): Customer cancellation and Crew out,
// the two what-if screens of the routing-map archetype
// (kit/runtime/archetypes/routing-map/whatif.js), through the hub on the
// fake Slack app. The synthetic day (test/fixtures/routing-map/day.json:
// crews v1 and v2 in zone north, v1's 12:00 visit x1 cancelled in the data,
// v2 out in the data, v3 in zone south) read by the fixture adapter's
// visits(), gapFor(), crewOut() and route({ fill }). mapPoints is the
// fixture's stand-in; the renderer is the real one.
//
// Every way out has a test: Back and the X (view_closed), closing while the
// gap is being worked out, Change crew or day from each stage, Pick another
// visit, an expired session, an expired trigger, no visits, a crew not
// working, the data unavailable, the map not ready (not available, and the
// menu's Why?), access withdrawn, and a click from someone else's view.
// The scope (AD-R17): a crew lead's select lists only their crew's visits,
// their Fill buttons only their own crew's candidates, and their Crew out
// only their crew, whatever the click says.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { createRegistry } = require('../../kit/runtime/registry');
const { registerHubs, NOT_AVAILABLE, MAP_NEEDS_WINDOW } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { createMapFiles } = require('../../kit/runtime/slack/image');
const { renderPng } = require('../../kit/runtime/routing-map');
const { DataUnavailable } = require('../../kit/runtime/errors');
const {
  MAP_WORDS, ROUTE_WORDS, WHATIF_WORDS, WHY_WORDS,
} = require('../../kit/runtime/messages');
const { parsePick } = require('../../kit/runtime/archetypes/routing-map/whatif');
const { LISTEN_PATTERN, SCREEN_ACTIONS } = require('../../kit/runtime/archetypes/routing-map');
const { WHY } = require('../../kit/runtime/registry/vocabulary');
const { FakeSlackApp } = require('../fixtures/fake-slack');
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

const moduleOf = (screen, over = {}) => Object.freeze({
  id: screen === 'cancellation' ? 'route-cancellation' : `route-${screen}`,
  hub: 'ops',
  label: screen === 'cancellation' ? 'Customer cancellation' : screen === 'crew-out' ? 'Crew out' : 'Add a stop',
  description: 'A what-if',
  resource: 'ROUTING_ALL_CREWS',
  archetype: 'routing-map',
  screen,
  environments: ['dev'],
  adapter: 'adapter.js',
  createAdapter: fx.createAdapter,
  ...over,
});
const CANCEL = moduleOf('cancellation');
const OUT = moduleOf('crew-out');

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function setup({
  data = fx.fakeData(), mapPoints = fx.fakeMapPoints(), store = createStore(), canUse, mods = [CANCEL, OUT], profile: withProfile = profile, client,
} = {}) {
  const app = new FakeSlackApp({ views: true });
  app.checkHashes = true;
  const log = quietLog();
  const mapFiles = createMapFiles({
    store, client: client === undefined ? app.client : client, log, sweeping: () => true, sleep: async () => {},
  });
  const models = [];
  const render = (view, model, ...opts) => {
    models.push({ view, model });
    return renderPng(view, model, ...opts);
  };
  registerHubs(app, {
    registry: createRegistry({ hubs: [HUB], modules: mods }), profile: withProfile, env: 'dev', log, store, data,
    mapFiles, ...(canUse ? { canUse } : {}),
    routingMap: { mapPoints, render, editor: { mapDelayMs: 0 } },
  });
  return {
    app, log, store, data, mapPoints, models,
  };
}

const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const lastView = (app) => app.views.at(-1).args.view;
const blocksOf = (view, type) => view.blocks.filter((b) => b.type === type);
const texts = (view) => blocksOf(view, 'section').filter((b) => b.text).map((b) => b.text.text);
const allText = (view) => view.blocks.map((b) => [
  b.text ? b.text.text : '', ...(b.elements || []).map((e) => (e.text && typeof e.text === 'object' ? e.text.text : e.text || '')),
].join('\n')).join('\n');
const elements = (view) => blocksOf(view, 'actions').flatMap((b) => b.elements);
const buttons = (view) => elements(view).filter((e) => e.type === 'button');
const buttonText = (view) => buttons(view).map((b) => b.text.text);
const visitSelect = (view) => elements(view).find((e) => e.action_id === 'routing-map:visit');
const imageOf = (view) => blocksOf(view, 'image')[0];
const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => { setImmediate(r); }); };
const open = (ctx, mod = CANCEL, user = U.dispatch) => ctx.app.dispatchAction(`${mod.id}:open`, { user, view: MENU });
const pickOpt = (value) => ({ type: 'static_select', selected_option: { value, text: { type: 'plain_text', text: value } } });

function fromView(ctx, view) {
  const v = lastView(ctx.app);
  return view || {
    id: 'V1', type: 'modal', hash: ctx.app.hashes.get('V1'), private_metadata: v.private_metadata, title: v.title,
  };
}
function tap(ctx, which, value, { user = U.dispatch, view } = {}) {
  return ctx.app.dispatchAction(`routing-map:${which}`, { user, view: fromView(ctx, view), value });
}
function choose(ctx, which, action, { user = U.dispatch, view } = {}) {
  return ctx.app.dispatchAction(`routing-map:${which}`, { user, view: fromView(ctx, view), action });
}
// Picks the visit whose option text starts with prefix (its time).
async function pickVisit(ctx, prefix, opts) {
  const sel = visitSelect(lastView(ctx.app));
  const option = sel.options.find((o) => o.text.text.startsWith(prefix));
  assert.ok(option, `a visit at ${prefix}`);
  await choose(ctx, 'visit', { type: 'static_select', selected_option: option }, opts);
  await settle();
  return lastView(ctx.app);
}
// Opens Customer cancellation and shows crew's visits.
async function visitsOf(ctx, { user = U.dispatch, crew } = {}) {
  await open(ctx, CANCEL, user);
  if (crew) await choose(ctx, 'crew', pickOpt(crew), { user });
  await tap(ctx, 'show', 'show', { user });
  return lastView(ctx.app);
}
const fillButtons = (view) => buttons(view).filter((b) => /^routing-map:fill-[1-5]$/.test(b.action_id));

// --- the screens in the registry and the hub's listener ------------------------------------

test('the schema takes screen cancellation, crew-out and add-stop; the hub hears visit, fill, again and out; each screen takes only its own actions', () => {
  for (const id of ['visit', 'fill', 'again', 'out']) assert.ok(LISTEN_PATTERN.test(`routing-map:${id}`), id);
  assert.deepEqual([...SCREEN_ACTIONS.cancellation].sort(), ['again', 'change', 'crew', 'day', 'fill', 'move', 'optimize', 'reset', 'show', 'visit']);
  assert.deepEqual([...SCREEN_ACTIONS['crew-out']].sort(), ['change', 'crew', 'day', 'out']);
  for (const a of ['visit', 'fill', 'again', 'out']) {
    assert.ok(!SCREEN_ACTIONS.views.has(a), `views refuses ${a}`);
    assert.ok(!SCREEN_ACTIONS['route-editor'].has(a), `the editor refuses ${a}`);
  }
  const schema = require('../../kit/runtime/schema/module.schema.json');
  assert.deepEqual(schema.properties.screen.enum, ['views', 'route-editor', 'cancellation', 'crew-out', 'add-stop']);
});

test('parsePick reads "<seq>:<index>" and nothing else', () => {
  assert.deepEqual(parsePick('3:0'), { seq: 3, index: 0 });
  assert.deepEqual(parsePick('12:4'), { seq: 12, index: 4 });
  for (const bad of ['0:1', '3', '3:', ':1', '3:01', '3:1:2', 'a:1', '3:1000', `${'9'.repeat(10)}:1`, 3, null, undefined, '3:1 ']) {
    assert.equal(parsePick(bad), null, String(bad));
  }
});

// --- not ready (fail closed) -----------------------------------------------------------------

test('exit, the map not ready: Customer cancellation with no Office, Crew out whose adapter has no crewOut(), and Add a stop (not built) show "not available"; nothing is read', async () => {
  const noCrewOut = moduleOf('crew-out', {
    createAdapter: (args) => { const { crewOut, ...rest } = fx.createAdapter(args); return rest; },
  });
  const noGap = moduleOf('cancellation', {
    createAdapter: (args) => { const { gapFor, ...rest } = fx.createAdapter(args); return rest; },
  });
  const addStop = moduleOf('add-stop');
  const cases = [
    ['no Office', { profile: noDepot, mods: [CANCEL] }, CANCEL, 'no routing.depot in the profile'],
    ['no gapFor()', { mods: [noGap] }, noGap, 'the adapter has no visits or gapFor()'],
    ['no crewOut()', { mods: [noCrewOut] }, noCrewOut, 'the adapter has no crewOut()'],
    ['add-stop', { mods: [addStop] }, addStop, 'the add-stop screen is not built yet'],
  ];
  for (const [what, opts, mod, reason] of cases) {
    const ctx = setup(opts);
    await open(ctx, mod);
    const [pushed] = calls(ctx.app, 'push');
    assert.deepEqual(texts(pushed.view), [NOT_AVAILABLE], what);
    assert.equal(ctx.app.views.length, 1, `${what}: no other view`);
    assert.deepEqual(ctx.data.calls, [], `${what}: nothing read`);
    assert.ok(ctx.log.lines.some((l) => l.msg === 'hub action refused' && l.fields.reason === reason), what);
  }
  // Crew out needs no Office.
  const ctx = setup({ profile: noDepot, mods: [OUT] });
  await open(ctx, OUT);
  assert.deepEqual(texts(lastView(ctx.app)), [WHATIF_WORDS.pickOut()]);
});

test('exit, the map not ready: the menu row shows Why?, and Why? says the map isn\'t set up', async () => {
  const ctx = setup({ profile: noDepot, mods: [CANCEL, OUT] });
  await ctx.app.dispatchCommand('/ops', { user_id: U.dispatch.id });
  const menu = calls(ctx.app, 'open').at(-1).view;
  const row = (id) => menu.blocks.find((b) => b.block_id === `entry:${id}`);
  assert.equal(row(CANCEL.id).accessory.text.text, WHY);
  assert.notEqual(row(OUT.id).accessory.text.text, WHY, 'Crew out is ready with no Office');
  await ctx.app.dispatchAction(`${CANCEL.id}:why`, { user: U.dispatch, view: { ...menu, id: 'VMENU', hash: 'h1' } });
  const why = calls(ctx.app, 'push').at(-1).view;
  assert.ok(why.blocks.some((b) => b.text && b.text.text === WHY_WORDS.noMap(ADMIN)));
});

// --- Customer cancellation -------------------------------------------------------------------

test('Customer cancellation, open: step one is a crew select, the date picker and Show visits; nothing but the crews is read', async () => {
  const ctx = setup();
  await open(ctx);
  const view = lastView(ctx.app);
  assert.deepEqual(texts(view), [WHATIF_WORDS.pickVisits()]);
  assert.deepEqual(elements(view).map((e) => e.action_id), ['routing-map:crew', 'routing-map:day', 'routing-map:show']);
  assert.equal(buttons(view)[0].text.text, 'Show visits');
  assert.deepEqual(ctx.mapPoints.asked, [], 'no positions read');
});

test('Show visits: one select of the crew\'s visits, "hh:mm · client", the data\'s own cancellation marked; never a city, an address or a position', async () => {
  const ctx = setup();
  const view = await visitsOf(ctx);
  assert.equal(texts(view)[0], WHATIF_WORDS.whichVisit('Maple crew', 'Monday 2026-11-02'));
  const sel = visitSelect(view);
  const own = [...DAY.stops.filter((s) => s.currentCrewId === 'v1'), ...DAY.cancelled].sort((a, b) => a.start - b.start);
  assert.equal(sel.options.length, own.length);
  sel.options.forEach((o, i) => {
    const place = DAY.places[own[i].node];
    const time = `${String(Math.floor(own[i].start / 60)).padStart(2, '0')}:${String(own[i].start % 60).padStart(2, '0')}`;
    assert.equal(o.text.text, `${time} · ${place.client_name}${own[i].stopId === 'x1' ? ' (cancelled)' : ''}`);
    assert.ok(!o.text.text.includes(place.city), 'no city');
    assert.match(o.value, /^\d+:\d+$/, 'an index, never a stop id');
  });
  assert.deepEqual(buttonText(view), ['Change crew or day']);
  const out = JSON.stringify(ctx.app.views) + JSON.stringify(ctx.log.lines);
  for (const p of Object.values(DAY.places)) {
    if (p.address) assert.ok(!out.includes(p.address), 'no address');
    if (Number.isInteger(p.lat_e6)) assert.ok(!out.includes(String(p.lat_e6)), 'no position');
  }
  assert.deepEqual(ctx.mapPoints.asked, [], 'no positions read for the select');
});

test('a visit cancels: the Gap fill view for the gap it leaves, the top candidates with reasons, and Fill with #1..#n', async () => {
  const ctx = setup();
  await visitsOf(ctx);
  const view = await pickVisit(ctx, '14:30');
  assert.match(texts(view)[0], /^\*What if .+'s visit at 14:30 cancels\?\*\nPress \*Fill with #n\*/);
  assert.ok(imageOf(view), 'the map is drawn');
  assert.match(imageOf(view).alt_text, /^Route map: Gap fill, Maple crew, \d+ stops$/);
  const list = allText(view);
  assert.match(list, /\*Gap fill: Maple crew, Monday 2026-11-02\*/);
  assert.match(list, /Gap: 11:45 to /, 'the gap runs from s2\'s end, across x1 and s3');
  const fills = fillButtons(view);
  assert.ok(fills.length >= 1 && fills.length <= 5);
  fills.forEach((b, i) => {
    assert.equal(b.text.text, `Fill with #${i + 1}`);
    assert.match(b.value, new RegExp(`^\\d+:${i + 1}$`));
    assert.match(list, new RegExp(`\\n${i + 1}\\. \\d\\d:\\d\\d · `), `candidate ${i + 1} listed with a reason`);
  });
  assert.deepEqual(buttonText(view).slice(-2), ['Pick another visit', 'Change crew or day']);
  assert.equal(ctx.models.at(-1).view, 'gap');
});

test('a visit the data already shows cancelled: says so, and shows the data\'s own gap', async () => {
  const ctx = setup();
  await visitsOf(ctx);
  const view = await pickVisit(ctx, '12:00');
  assert.match(texts(view)[0], /is cancelled in the data\.\* These could fill its gap\./);
  assert.match(allText(view), /Gap: 11:45 to 14:30/);
});

test('a day with no candidate says so, with no Fill button', async () => {
  const day = JSON.parse(JSON.stringify(DAY));
  day.candidates = [];
  const ctx = setup({ data: fx.fakeData({ day }) });
  await visitsOf(ctx);
  const view = await pickVisit(ctx, '14:30');
  assert.match(allText(view), /No visit can be moved up into this gap\./);
  assert.deepEqual(fillButtons(view), []);
  assert.deepEqual(buttonText(view), ['Pick another visit', 'Change crew or day']);
});

test('Fill with #1: Plan a route\'s list for the day with that visit moved up into the gap and marked; the cancelled visit is gone; Optimize works there', async () => {
  const ctx = setup();
  await visitsOf(ctx);
  const result = await pickVisit(ctx, '14:30');
  const [first] = fillButtons(result);
  await tap(ctx, first.action_id.slice('routing-map:'.length), first.value);
  await settle();
  const view = lastView(ctx.app);
  const rows = texts(view).filter((t) => /^\S+ \*\d\d:\d\d /.test(t));
  const marked = rows.filter((t) => t.includes('↩️ Moved up from 2026-11-'));
  assert.equal(marked.length, 1, 'one stop marked as moved up');
  assert.match(marked[0], /; call to confirm$/);
  const s3 = DAY.places['property:s3'].client_name;
  assert.ok(!rows.some((t) => t.includes(s3)), 'the cancelled visit is not on the day');
  assert.equal(rows.length, 4, 's1, s2, the fill and s4');
  assert.ok(imageOf(view), 'the day\'s map');
  assert.ok(buttonText(view).includes('Optimize'));
  // The editor's own clicks work on it.
  const version = Number(blocksOf(view, 'actions').find((b) => /^routing-map:actions:/.test(b.block_id)).block_id.split(':').at(-1));
  await tap(ctx, 'optimize', `${version}:optimize`);
  await settle();
  assert.ok(texts(lastView(ctx.app)).some((t) => t.includes('↩️ Moved up from')), 'still marked after Optimize');
  // Change crew or day goes back to Customer cancellation's first step.
  await tap(ctx, 'change', 'change');
  assert.deepEqual(texts(lastView(ctx.app)), [WHATIF_WORDS.pickVisits()]);
});

test('Fill with a stale seq, a rank not shown, or a value that does not parse is refused and changes nothing', async () => {
  const ctx = setup();
  await visitsOf(ctx);
  const result = await pickVisit(ctx, '14:30');
  const [first] = fillButtons(result);
  const seq = Number(first.value.split(':')[0]);
  const n = ctx.app.views.length;
  for (const [value, reason] of [[`${seq + 5}:1`, 'stale version'], [`${seq}:9`, 'out of range'], ['x', 'malformed'], [`${seq}:0`, 'out of range']]) {
    await tap(ctx, 'fill', value);
    assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.action === 'fill' && l.fields.reason === reason), value);
  }
  assert.equal(ctx.app.views.length, n, 'the view is not touched');
});

test('a visit select click with a stale seq or an index out of range is refused; Pick another visit goes back to the select with no read', async () => {
  const ctx = setup();
  const view = await visitsOf(ctx);
  const sel = visitSelect(view);
  const seq = Number(sel.options[0].value.split(':')[0]);
  await choose(ctx, 'visit', pickOpt(`${seq}:99`));
  await choose(ctx, 'visit', pickOpt(`${seq + 1}:0`));
  const reasons = ctx.log.lines.filter((l) => l.msg === 'routing map click refused' && l.fields.action === 'visit').map((l) => l.fields.reason);
  assert.deepEqual(reasons, ['out of range', 'stale version']);
  await pickVisit(ctx, '08:00');
  const reads = ctx.data.calls.length;
  await tap(ctx, 'again', 'again');
  const back = lastView(ctx.app);
  assert.ok(visitSelect(back), 'the visit select again');
  assert.equal(ctx.data.calls.length, reads, 'nothing read');
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), [], 'the gap map\'s file deleted');
});

test('exit, Change crew or day: from the visit select and from the result, back to step one with the picks kept', async () => {
  const ctx = setup();
  await visitsOf(ctx, { crew: 'v3' });
  await tap(ctx, 'change', 'change');
  let view = lastView(ctx.app);
  assert.deepEqual(texts(view), [WHATIF_WORDS.pickVisits()]);
  assert.equal(elements(view)[0].initial_option.value, 'v3');
  await tap(ctx, 'show', 'show');
  await pickVisit(ctx, '08:00');
  await tap(ctx, 'change', 'change');
  view = lastView(ctx.app);
  assert.deepEqual(texts(view), [WHATIF_WORDS.pickVisits()]);
  assert.equal(blocksOf(view, 'image').length, 0);
  assert.equal(ctx.store.mapFileCount(), 0, 'the map file deleted');
  // A button from the old result is refused now.
  await tap(ctx, 'again', 'again');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.action === 'again' && l.fields.reason === 'another step'));
});

test('exit, no visits: a crew with none that day says so, with Change crew or day; nothing drawn', async () => {
  const ctx = setup();
  await open(ctx);
  await choose(ctx, 'day', { type: 'datepicker', selected_date: '2026-11-03' });
  await tap(ctx, 'show', 'show');
  const view = lastView(ctx.app);
  assert.deepEqual(texts(view), [WHATIF_WORDS.noVisits('Maple crew', 'Tuesday 2026-11-03')]);
  assert.deepEqual(buttonText(view), ['Change crew or day']);
  assert.deepEqual(ctx.app.uploads, []);
});

test('exit, a crew not working that day (a lead whose crew is not in the data): "isn\'t working", with Change crew or day', async () => {
  const day = JSON.parse(JSON.stringify(DAY));
  day.crews = day.crews.filter((c) => c.crewId !== 'v1');
  day.stops = day.stops.filter((s) => s.currentCrewId !== 'v1');
  day.cancelled = [];
  const ctx = setup({ data: fx.fakeData({ day }) });
  await open(ctx, CANCEL, U.leadA);
  await tap(ctx, 'show', 'show', { user: U.leadA });
  assert.deepEqual(texts(lastView(ctx.app)), [ROUTE_WORDS.notWorking('Maple crew', 'Monday 2026-11-02')]);
});

test('exit, no crew picked: Show visits says pick a crew first and reads nothing', async () => {
  const day = JSON.parse(JSON.stringify(DAY));
  day.crews = [];
  day.stops = [];
  day.cancelled = [];
  const ctx = setup({ data: fx.fakeData({ day }) });
  await open(ctx);
  const reads = ctx.data.calls.length;
  await tap(ctx, 'show', 'show');
  assert.deepEqual(texts(lastView(ctx.app)), [WHATIF_WORDS.pickCrew('Show visits')]);
  assert.equal(ctx.data.calls.length, reads);
});

test('exit, the data unavailable: on Show visits and on a visit picked, the error exit with Back', async () => {
  const ctx = setup();
  await open(ctx);
  ctx.data.failWith = new DataUnavailable('fixture down');
  await tap(ctx, 'show', 'show');
  let view = lastView(ctx.app);
  assert.deepEqual(texts(view), [DATA_DOWN]);
  assert.equal(view.close.text, 'Back');

  const two = setup();
  await visitsOf(two);
  two.data.failWith = new DataUnavailable('fixture down');
  view = await pickVisit(two, '14:30');
  assert.ok(texts(view).includes(DATA_DOWN));
  assert.equal(view.close.text, 'Back');
  assert.equal(blocksOf(view, 'image').length, 0);
  assert.deepEqual(two.app.uploads, []);
});

for (const cleared of [false, true]) {
  test(`exit, ${cleared ? 'the X' : 'Back'}: view_closed deletes the map files; a later click is told the map has expired`, async () => {
    const ctx = setup();
    await visitsOf(ctx);
    const result = await pickVisit(ctx, '14:30');
    assert.equal(ctx.store.mapFilesOf('UDISPATCH:V1').length, 1);
    assert.equal(await ctx.app.dispatchViewClosed('hub:map', { user: U.dispatch, view: { id: 'V1' }, is_cleared: cleared }), 1);
    assert.equal(ctx.store.mapFileCount(), 0);
    await tap(ctx, 'fill-1', fillButtons(result)[0].value, { view: { id: 'V1', type: 'modal', private_metadata: result.private_metadata, title: result.title } });
    assert.deepEqual(texts(lastView(ctx.app)), [MAP_WORDS.expired('Customer cancellation')]);
  });
}

test('exit, closing while the gap is worked out: the draw finds its session gone, uploads nothing and shows nothing', async () => {
  const data = fx.fakeData();
  let release;
  const held = new Promise((r) => { release = r; });
  const run = data.run.bind(data);
  let hold = false;
  data.run = async (...args) => {
    if (hold) await held;
    return run(...args);
  };
  const ctx = setup({ data });
  await visitsOf(ctx);
  hold = true;
  const sel = visitSelect(lastView(ctx.app));
  const pending = choose(ctx, 'visit', { type: 'static_select', selected_option: sel.options[0] });
  await settle();
  const shownBefore = ctx.app.views.length;
  await ctx.app.dispatchViewClosed('hub:map', { user: U.dispatch, view: { id: 'V1' }, is_cleared: true });
  release();
  await pending;
  await settle();
  assert.deepEqual(ctx.app.uploads, [], 'nothing uploaded');
  assert.equal(ctx.app.views.length, shownBefore, 'nothing shown after the close');
});

test('exit, an expired session (15 minutes without use): the expired words (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const ctx = setup();
  await visitsOf(ctx);
  t.mock.timers.tick(15 * MIN + 1);
  const sel = visitSelect(lastView(ctx.app));
  await choose(ctx, 'visit', { type: 'static_select', selected_option: sel.options[0] });
  const view = lastView(ctx.app);
  assert.deepEqual(texts(view), [MAP_WORDS.expired('Customer cancellation')]);
  assert.equal(view.close.text, 'Back');
});

test('exit, an expired trigger on Open: the hub\'s existing path; no modal, nothing read', async () => {
  const ctx = setup();
  ctx.app.viewsFail.push = Object.assign(new Error('An API error occurred: expired_trigger_id'), { data: { ok: false, error: 'expired_trigger_id' } });
  await ctx.app.dispatchAction(`${CANCEL.id}:open`, { user: U.dispatch, view: { ...MENU, hash: 'hmenu' } });
  const [update] = calls(ctx.app, 'update');
  assert.deepEqual(texts(update.view), [MAP_NEEDS_WINDOW]);
  assert.deepEqual(ctx.data.calls, []);
});

test('exit, access withdrawn: the next click shows the refusal and reads nothing', async () => {
  let withdrawn = false;
  const ctx = setup({ canUse: () => (withdrawn ? 'denied' : 'allowed') });
  await visitsOf(ctx);
  withdrawn = true;
  const reads = ctx.data.calls.length;
  const sel = visitSelect(lastView(ctx.app));
  await choose(ctx, 'visit', { type: 'static_select', selected_option: sel.options[0] });
  assert.deepEqual(texts(lastView(ctx.app)), [`You don't have access to Customer cancellation; ask ${ADMIN}.`]);
  assert.equal(ctx.data.calls.length, reads);
});

test('exit, a click from someone else\'s view: another user is refused silently; the same user\'s other view is told so', async () => {
  const ctx = setup();
  const view = await visitsOf(ctx);
  const n = ctx.app.views.length;
  const sel = visitSelect(view);
  await choose(ctx, 'visit', { type: 'static_select', selected_option: sel.options[0] }, { user: U.leadB });
  assert.equal(ctx.app.views.length, n, 'not touched');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.reason === 'another user'));
  await choose(ctx, 'visit', { type: 'static_select', selected_option: sel.options[0] }, {
    view: {
      id: 'V9', type: 'modal', private_metadata: view.private_metadata, title: view.title,
    },
  });
  const other = calls(ctx.app, 'update').at(-1);
  assert.equal(other.view_id, 'V9');
  assert.deepEqual(texts(other.view), [MAP_WORDS.notYours()]);
});

test('scope (AD-R17): a crew lead\'s select lists only their crew\'s visits, whatever crew the click names; their gap shows only their own crew\'s candidates', async () => {
  const ctx = setup();
  await open(ctx, CANCEL, U.leadA);
  assert.deepEqual(elements(lastView(ctx.app))[0].options.map((o) => o.value), ['v1'], 'only their crew offered');
  await choose(ctx, 'crew', pickOpt('v3'), { user: U.leadA });
  await tap(ctx, 'show', 'show', { user: U.leadA });
  const sel = visitSelect(lastView(ctx.app));
  const own = [...DAY.stops.filter((s) => s.currentCrewId === 'v1'), ...DAY.cancelled];
  assert.equal(sel.options.length, own.length, 'v1\'s visits only');
  const v3 = DAY.stops.filter((s) => s.currentCrewId === 'v3').map((s) => DAY.places[s.node].client_name);
  for (const o of sel.options) assert.ok(!v3.some((name) => o.text.text.includes(name)), 'no other crew\'s client');
  const view = await pickVisit(ctx, '14:30', { user: U.leadA });
  const candidates = DAY.candidates.filter((c) => c.currentCrewId === 'v1').length;
  assert.ok(fillButtons(view).length <= candidates, 'Fill buttons only for their own crew\'s candidates');
  const others = DAY.candidates.filter((c) => c.currentCrewId !== 'v1').map((c) => DAY.places[c.node].client_name);
  for (const name of others) assert.ok(!allText(view).includes(name), 'another crew\'s candidate is not named');
});

// --- Crew out ----------------------------------------------------------------------------------

test('Crew out, open: a crew select, the date picker and Mark out for the day', async () => {
  const ctx = setup();
  await open(ctx, OUT);
  const view = lastView(ctx.app);
  assert.deepEqual(texts(view), [WHATIF_WORDS.pickOut()]);
  assert.deepEqual(elements(view).map((e) => e.action_id), ['routing-map:crew', 'routing-map:day', 'routing-map:out']);
  assert.equal(buttons(view)[0].text.text, 'Mark out for the day');
});

test('Mark out for the day: the Route change view for the crew\'s zone with that crew out; Change crew or day', async () => {
  const ctx = setup();
  await open(ctx, OUT);
  await choose(ctx, 'crew', pickOpt('v3'));
  await tap(ctx, 'out', 'out');
  await settle();
  const view = lastView(ctx.app);
  assert.equal(texts(view)[0], WHATIF_WORDS.out('Cedar crew', 'Monday 2026-11-02'));
  assert.ok(imageOf(view));
  assert.equal(ctx.models.at(-1).view, 'change');
  const list = allText(view);
  assert.match(list, /\*Route change: Zone south, Monday 2026-11-02\*/);
  assert.match(list, /Not working: .*Cedar crew/);
  assert.deepEqual(buttonText(view), ['Change crew or day']);
  await tap(ctx, 'change', 'change');
  assert.deepEqual(texts(lastView(ctx.app)), [WHATIF_WORDS.pickOut()]);
  assert.equal(ctx.store.mapFileCount(), 0);
});

test('a crew the data already shows out says so, and shows its plan directly', async () => {
  const ctx = setup();
  await open(ctx, OUT);
  await choose(ctx, 'crew', pickOpt('v2'));
  await tap(ctx, 'out', 'out');
  await settle();
  const view = lastView(ctx.app);
  assert.equal(texts(view)[0], WHATIF_WORDS.alreadyOut('Birch crew', 'Monday 2026-11-02'));
  assert.match(allText(view), /\*Route change: Zone north, /);
});

test('Crew out scope (AD-R17): a crew lead marks only their own crew out, whatever the click names, and sees only their crew', async () => {
  const ctx = setup();
  await open(ctx, OUT, U.leadA);
  await choose(ctx, 'crew', pickOpt('v3'), { user: U.leadA });
  await tap(ctx, 'out', 'out', { user: U.leadA });
  await settle();
  const view = lastView(ctx.app);
  assert.equal(texts(view)[0], WHATIF_WORDS.out('Maple crew', 'Monday 2026-11-02'));
  assert.match(allText(view), /\*Route change: Maple crew, /);
  assert.ok(!allText(view).includes('Cedar crew'), 'no other crew named');
});

test('Crew out exits: the data unavailable (the error exit), an expired session, a click from another user', async (t) => {
  const ctx = setup();
  await open(ctx, OUT);
  ctx.data.failWith = new DataUnavailable('fixture down');
  await tap(ctx, 'out', 'out');
  await settle();
  assert.ok(texts(lastView(ctx.app)).includes(DATA_DOWN));
  assert.equal(lastView(ctx.app).close.text, 'Back');

  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const two = setup();
  await open(two, OUT);
  const n = two.app.views.length;
  await tap(two, 'out', 'out', { user: U.leadB });
  assert.equal(two.app.views.length, n, 'another user: not touched');
  t.mock.timers.tick(15 * MIN + 1);
  await tap(two, 'out', 'out');
  assert.deepEqual(texts(lastView(two.app)), [MAP_WORDS.expired('Crew out')]);
});

test('a screen refuses another screen\'s actions: Crew out refuses visit and fill, Customer cancellation refuses out', async () => {
  const ctx = setup();
  await open(ctx, OUT);
  await choose(ctx, 'visit', pickOpt('1:0'));
  await tap(ctx, 'fill', '1:1');
  const two = setup();
  await open(two, CANCEL);
  await tap(two, 'out', 'out');
  for (const c of [ctx, two]) {
    assert.ok(c.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.reason === 'another screen'));
  }
  assert.ok(!ctx.models.length && !two.models.length, 'nothing drawn');
});
