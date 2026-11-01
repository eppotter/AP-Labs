'use strict';

// Story 15.4 (AD-R12, R15, R16, R17): the routing-map archetype through the
// hub, on the fake Slack app. A synthetic day (test/fixtures/routing-map/
// day.json) read by the fixture adapter; mapPoints is the fixture's stand-in
// (a spy); the renderer is the real one (a spy keeps each model). Every way
// out of the modal has a test: Back, Close, each error, an expired trigger,
// an expired session, access withdrawn. Story 15.10 adds the street map
// (the real tile fetcher on test/fixtures/fake-tiles.js, the source from
// test/fixtures/profiles/routing-basemap.yml) and its exits: a newer click,
// Back or Close, an expired session or withdrawn access while tiles load,
// and a failed draw with tiles.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { createRegistry } = require('../../kit/runtime/registry');
const { registerHubs, NOT_AVAILABLE, MAP_NOT_SHOWN, MAP_NEEDS_WINDOW } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { createMapFiles } = require('../../kit/runtime/slack/image');
const { createEngineJobs } = require('../../kit/runtime/jobs');
const { renderPng, renderSvg } = require('../../kit/runtime/routing-map');
const { RoutingFault, DataUnavailable } = require('../../kit/runtime/errors');
const { PLAIN_ERROR } = require('../../kit/runtime/slack/handle');
const { MAP_WORDS } = require('../../kit/runtime/messages');
const { ID_PATTERN } = require('../../kit/runtime/archetypes/routing-map/session');
const { FRAME, SUGGEST_ONLY, hiddenLine } = require('../../kit/runtime/archetypes/routing-map/views');
const { FakeSlackApp } = require('../fixtures/fake-slack');
const fx = require('../fixtures/routing-map/adapter');

const profile = loadProfile(path.join(__dirname, '../fixtures/profiles/routing-audience.yml'));
const DAY = fx.DAY;
const HUB = Object.freeze({ id: 'ops', command: '/ops', name: 'Ops', description: 'Ops tools' });
const MENU = Object.freeze({ id: 'VMENU', type: 'modal', private_metadata: 'ops' });
const ADMIN = '<@UADMIN>';
const MIN = 60 * 1000;
const U = Object.freeze({
  dispatch: { id: 'UDISPATCH', name: 'dispatch' },
  leadA: { id: 'ULEADA', name: 'lead a' },
  leadB: { id: 'ULEADB', name: 'lead b' },
  none: { id: 'ULEADNONE', name: 'lead none' },
  ghost: { id: 'ULEADGHOST', name: 'lead ghost' },
  member: { id: 'UMEMBER', name: 'member' },
});

const routingModule = (over = {}) => Object.freeze({
  id: 'routing', hub: 'ops', label: 'Routing', description: 'Routes on a map', resource: 'ROUTING_ALL_CREWS',
  archetype: 'routing-map', environments: ['dev'], adapter: 'adapter.js', createAdapter: fx.createAdapter, ...over,
});

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// The hub with one routing-map module. Waits between show tries are
// recorded in slept, never slept.
function setup({
  data = fx.fakeData(), mapPoints = fx.fakeMapPoints(), render = renderPng, store = createStore(), sweeping = () => true,
  canUse, llm, client, noMapFiles = false, mod = routingModule(), profile: withProfile = profile, fetchMosaic,
} = {}) {
  const app = new FakeSlackApp({ views: true });
  app.checkHashes = true;
  const log = quietLog();
  const slept = [];
  const mapFiles = noMapFiles ? undefined : createMapFiles({
    store, client: client === undefined ? app.client : client, log, sweeping, sleep: async (ms) => { slept.push(ms); },
  });
  const models = [];
  const spyRender = (view, model, ...opts) => {
    models.push({ view, model, opts });
    return render(view, model, ...opts);
  };
  registerHubs(app, {
    registry: createRegistry({ hubs: [HUB], modules: [mod] }), profile: withProfile, env: 'dev', log, store, data, llm,
    ...(mapFiles ? { mapFiles } : {}), ...(canUse ? { canUse } : {}),
    routingMap: { mapPoints, render: spyRender, ...(fetchMosaic ? { fetchMosaic } : {}) },
  });
  return {
    app, log, store, data, mapPoints, models, slept, mapFiles,
  };
}

const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const lastView = (app) => app.views.at(-1).args.view;
const blocksOf = (view, type) => view.blocks.filter((b) => b.type === type);
const lines = (view) => blocksOf(view, 'section').map((b) => b.text.text).join('\n').split('\n');
const texts = (view) => blocksOf(view, 'section').map((b) => b.text.text);
const open = (ctx, user = U.dispatch) => ctx.app.dispatchAction('routing:open', { user, view: MENU });
const pick = (value) => ({ type: 'static_select', selected_option: { value, text: { type: 'plain_text', text: value } } });
const date = (day) => ({ type: 'datepicker', selected_date: day });

// A click from the map view as it now stands (V1, its latest hash).
function click(ctx, actionId, action, { user = U.dispatch, view } = {}) {
  const v = lastView(ctx.app);
  const from = view || {
    id: 'V1', type: 'modal', hash: ctx.app.hashes.get('V1'), private_metadata: v.private_metadata, title: v.title,
  };
  return ctx.app.dispatchAction(actionId, { user, view: from, action });
}

// Waits for work started without await to settle.
const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

// A promise that resolves when open() is called.
function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { wait: () => p, open };
}

// --- Open ----------------------------------------------------------------------------

test('a dispatcher clicks Open: the ack first, "Loading…" pushed inside the trigger\'s life before any read, then the map by views.update', async () => {
  const ctx = setup();
  const events = [];
  const ack = ctx.app.ack.bind(ctx.app);
  ctx.app.ack = () => { const a = ack(); return async () => { events.push('ack'); await a(); }; };
  const push = ctx.app.client.views.push;
  ctx.app.client.views.push = async (args) => { events.push(`push (reads so far: ${ctx.data.calls.length})`); return push(args); };
  await open(ctx);
  assert.deepEqual(events, ['ack', 'push (reads so far: 0)']);
  assert.deepEqual(ctx.app.views.map((v) => v.method), ['push', 'update']);
  const [pushed] = calls(ctx.app, 'push');
  assert.deepEqual(texts(pushed.view), ['Loading…']);
  assert.equal(pushed.view.callback_id, 'hub:map');
  assert.equal(pushed.view.notify_on_close, true);
  assert.equal(pushed.view.title.text, 'Routing');
  assert.equal(pushed.view.close.text, 'Back');

  const shown = lastView(ctx.app);
  assert.equal(shown.callback_id, 'hub:map');
  assert.equal(shown.notify_on_close, true);
  assert.match(shown.private_metadata, ID_PATTERN, 'the session id, a v4 UUID, and nothing else');
  assert.deepEqual(shown.blocks.map((b) => b.type), ['actions', 'context', 'image', 'section']);
  assert.equal(blocksOf(shown, 'image').length, 1);
  const [image] = blocksOf(shown, 'image');
  assert.deepEqual(image, { type: 'image', slack_file: { id: 'F1' }, alt_text: 'Route map: Booked vs optimized, Maple crew, 4 stops' });
  const [actions] = blocksOf(shown, 'actions');
  assert.deepEqual(actions.elements.map((e) => [e.type, e.action_id]), [
    ['static_select', 'routing-map:view'], ['datepicker', 'routing-map:day'], ['static_select', 'routing-map:crew'],
  ]);
  assert.deepEqual(actions.elements[0].options.map((o) => [o.value, o.text.text]), [
    ['compare', 'Booked vs optimized'], ['change', 'Route change'], ['zone', 'Zone'], ['gap', 'Gap fill'],
  ]);
  assert.equal(actions.elements[0].initial_option.value, 'compare');
  assert.equal(actions.elements[1].initial_date, DAY.asOf);
  assert.deepEqual(actions.elements[2].options.map((o) => [o.value, o.text.text]), [['v1', 'Maple crew'], ['v2', 'Birch crew'], ['v3', 'Cedar crew']]);
  assert.equal(blocksOf(shown, 'context')[0].elements[0].text, 'Days from 2026-10-26 to 2026-11-16. Suggestions only: nothing is changed.');
  // The text list: crew, client name, city, start, drive minutes, reason.
  assert.deepEqual(lines(shown), [
    '*Booked vs optimized: Maple crew, Monday 2026-11-02*',
    'Driving: booked 22 min, optimized 20 min. 2 fewer minutes of driving than booked.',
    "1. 08:00 · Maple crew · Ana Ruiz, Riverton · 5 min drive · stays on crew v1; 5 minutes' drive from the crew's base",
    "2. 10:05 · Maple crew · Cara Lind, Lakeside · 5 min drive · stays on crew v1; 5 minutes' drive from stop s1",
    "3. 11:10 · Maple crew · Ben Ode, Riverton · 5 min drive · stays on crew v1; 5 minutes' drive from stop s3",
    "4. 12:45 · Maple crew · Dev Patel, Lakeside · 5 min drive · stays on crew v1; 5 minutes' drive from stop s2",
    SUGGEST_ONLY,
  ]);
  assert.equal(ctx.app.uploads.length, 1);
  assert.equal(ctx.app.uploads[0].filename, 'route-map.png');
  assert.equal(ctx.store.mapFilesOf('UDISPATCH:V1').length, 1);
});

test('fail closed: when the sweep cannot run (no store, no Slack files client, no sweep), the routing module shows "not available" and opens no modal', async () => {
  for (const opts of [{ store: null }, { client: {} }, { sweeping: () => false }, { noMapFiles: true }]) {
    const what = JSON.stringify(Object.keys(opts));
    const ctx = setup(opts);
    await open(ctx);
    const [pushed] = calls(ctx.app, 'push');
    assert.deepEqual(texts(pushed.view), [NOT_AVAILABLE], what);
    assert.equal(pushed.view.title.text, 'Not available', what);
    assert.ok(!('notify_on_close' in pushed.view), what);
    assert.deepEqual(ctx.data.calls, [], `${what}: nothing read`);
    assert.deepEqual(ctx.app.uploads, [], what);
    assert.ok(ctx.log.lines.some((l) => l.msg === 'hub action refused' && l.fields.reason === 'map files cannot be cleaned up'), what);
  }
});

test('a person outside the audience is refused at Open; nothing is read', async () => {
  const ctx = setup();
  await open(ctx, U.member);
  assert.deepEqual(texts(lastView(ctx.app)), [`You don't have access to Routing; ask ${ADMIN}.`]);
  assert.deepEqual(ctx.data.calls, []);
  assert.deepEqual(ctx.app.uploads, []);
});

// --- the date picker (F17) -----------------------------------------------------------------

test('the date picker is bounded to [as_of - 7 days, as_of + horizon_days]; a crafted date outside it is refused plainly and nothing is read', async () => {
  const ctx = setup();
  await open(ctx);
  const before = ctx.data.calls.length;
  for (const day of ['2026-10-25', '2026-11-17', '2026-13-01', '2026-02-30', 'tomorrow', '', undefined, 20261102]) {
    await click(ctx, 'routing-map:day', date(day));
    const shown = lastView(ctx.app);
    assert.deepEqual(texts(shown), [MAP_WORDS.badDate('2026-10-26', '2026-11-16')], String(day));
    assert.equal(blocksOf(shown, 'image').length, 0, String(day));
    assert.equal(blocksOf(shown, 'actions').length, 1, `${day}: the controls stay`);
    assert.equal(ctx.data.calls.length, before, `${day}: nothing read`);
  }
  assert.deepEqual(ctx.app.deleted, ['F1'], 'the map no longer shown is deleted');
  for (const day of ['2026-10-26', '2026-11-16']) {
    await click(ctx, 'routing-map:day', date(day));
    const shown = lastView(ctx.app);
    assert.equal(blocksOf(shown, 'actions')[0].elements[1].initial_date, day);
    assert.match(texts(shown)[0], /has no stops booked on/, `${day} is read`);
  }
  assert.ok(ctx.data.calls.some((c) => c.params.day === '2026-10-26'));
});

// --- view switching -----------------------------------------------------------------------

test('a view switch is acked at once, shows "Drawing the map…", then the new map; the previous file is deleted', async () => {
  const ctx = setup();
  await open(ctx);
  const acks = ctx.app.acks;
  let atDrawing = null;
  const update = ctx.app.client.views.update;
  ctx.app.client.views.update = async (args) => {
    if (atDrawing === null) atDrawing = { acks: ctx.app.acks, deleted: [...ctx.app.deleted] };
    return update(args);
  };
  await click(ctx, 'routing-map:view', pick('change'));
  assert.equal(atDrawing.acks, acks + 1, 'acked before the first update');
  const updates = calls(ctx.app, 'update');
  const drawing = updates.at(-2).view;
  assert.deepEqual(texts(drawing), ['Drawing the map…']);
  assert.equal(blocksOf(drawing, 'actions').length, 1);
  assert.equal(blocksOf(drawing, 'actions')[0].elements[0].initial_option.value, 'change');
  const shown = updates.at(-1).view;
  assert.deepEqual(blocksOf(shown, 'image')[0].slack_file, { id: 'F2' });
  assert.deepEqual(ctx.app.deleted, ['F1']);
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F2']);
  assert.equal(shown.private_metadata, calls(ctx.app, 'update')[0].view.private_metadata, 'the same session');
});

test('two clicks whose work finishes out of order: the newer map shows; the older abandons before its upload and uploads nothing (F4)', async () => {
  const mapPoints = fx.fakeMapPoints();
  const hold = gate();
  let first = true;
  const slow = async (...args) => {
    if (first) {
      first = false;
      await hold.wait();
    }
    return mapPoints(...args);
  };
  const ctx = setup({ mapPoints: slow });
  first = false;
  await open(ctx);
  first = true;
  const older = click(ctx, 'routing-map:view', pick('zone'));
  await settle();
  await click(ctx, 'routing-map:view', pick('gap'));
  hold.open();
  await older;
  assert.equal(ctx.app.uploads.length, 2, 'Open and the newer click only');
  const shown = lastView(ctx.app);
  assert.equal(blocksOf(shown, 'image')[0].alt_text, 'Route map: Gap fill, Maple crew, 4 stops');
  assert.ok(!calls(ctx.app, 'update').some((u) => /Zone/.test(JSON.stringify(blocksOf(u.view, 'image')))), 'the older map never shows');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'map superseded' && l.fields.step === 'draw'));
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F2']);
});

test('an older click that uploaded before a newer click came in checks again before views.update, and its file is deleted at once (F4)', async () => {
  const ctx = setup();
  await open(ctx);
  const hold = gate();
  const upload = ctx.app.client.files.uploadV2;
  let n = 0;
  ctx.app.client.files.uploadV2 = async (args) => {
    n += 1;
    const res = await upload(args);
    if (n === 1) await hold.wait();
    return res;
  };
  const older = click(ctx, 'routing-map:view', pick('zone'));
  await settle();
  await click(ctx, 'routing-map:view', pick('gap'));
  hold.open();
  await older;
  // F2: the older click's file (uploaded first, held); F3: the newer one's.
  assert.deepEqual(ctx.app.uploads.length, 3);
  assert.ok(ctx.app.deleted.includes('F2'), 'the superseded file is deleted');
  assert.ok(!ctx.app.deleted.includes('F3'), 'the newer map is never deleted by the older click');
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F3']);
  assert.ok(!calls(ctx.app, 'update').some((u) => blocksOf(u.view, 'image').some((b) => b.slack_file.id === 'F2')), 'F2 never shown');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'map superseded' && l.fields.step === 'show'));
});

test('an upload that succeeds and a views.update dropped on hash_conflict: that file is deleted at once (F4)', async () => {
  const ctx = setup();
  await open(ctx);
  const update = ctx.app.client.views.update;
  ctx.app.client.views.update = async (args) => {
    if (blocksOf(args.view, 'image').length) {
      ctx.app.hashes.set('V1', 'h-elsewhere'); // the view changed elsewhere
    }
    return update(args);
  };
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.ok(ctx.app.deleted.includes('F2'));
  assert.equal(ctx.store.mapFilesOf('UDISPATCH:V1').includes('F2'), false);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'stale view result dropped' && l.fields.reason === 'hash_conflict'));
});

test('an upload that succeeds and a views.update that fails: that file is deleted at once and the view says so plainly', async () => {
  const ctx = setup();
  await open(ctx);
  const update = ctx.app.client.views.update;
  ctx.app.client.views.update = async (args) => {
    if (blocksOf(args.view, 'image').length) throw Object.assign(new Error('An API error occurred: internal_error'), { data: { ok: false, error: 'internal_error' } });
    return update(args);
  };
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.deepEqual(ctx.app.deleted.sort(), ['F1', 'F2']);
  assert.equal(ctx.store.mapFileCount(), 0);
  assert.deepEqual(texts(lastView(ctx.app)), [PLAIN_ERROR]);
  assert.equal(lastView(ctx.app).callback_id, 'hub:map', 'still a map view: view_closed still comes');
});

test('a superseded draw commits nothing: the next click draws the crew last shown, and its selects are the ones last shown (PR #226 review)', async () => {
  const hold = gate();
  let holdNext = false;
  // The held draw's day lacks Birch (v2): had it committed, its pick (Maple)
  // and its options (no Birch) would leak into the next view.
  const createAdapter = (deps) => {
    const a = fx.createAdapter(deps);
    return Object.freeze({
      asOf: a.asOf,
      labels: a.labels,
      input: async (args) => {
        const got = await a.input(args);
        if (!holdNext) return got;
        holdNext = false;
        await hold.wait();
        got.input.crews = got.input.crews.filter((c) => c.crewId !== 'v2');
        got.input.stops = got.input.stops.filter((st) => st.currentCrewId !== 'v2');
        return got;
      },
    });
  };
  const ctx = setup({ mod: routingModule({ createAdapter }) });
  await open(ctx);
  holdNext = true;
  const older = click(ctx, 'routing-map:view', pick('compare'));
  await settle();
  await click(ctx, 'routing-map:crew', pick('v2'));
  assert.match(blocksOf(lastView(ctx.app), 'image')[0].alt_text, /Birch crew/);
  hold.open();
  await older;
  assert.ok(ctx.log.lines.some((l) => l.msg === 'map superseded' && l.fields.step === 'draw'));
  await click(ctx, 'routing-map:view', pick('compare'));
  const updates = calls(ctx.app, 'update');
  const drawing = updates.at(-2).view;
  assert.deepEqual(texts(drawing), ['Drawing the map…']);
  const crewSelect = blocksOf(drawing, 'actions')[0].elements[2];
  assert.deepEqual(crewSelect.options.map((o) => o.value), ['v1', 'v2', 'v3'], 'the selects last shown, not the superseded draw\'s');
  assert.equal(crewSelect.initial_option.value, 'v2', 'the crew last picked and shown');
  assert.match(blocksOf(updates.at(-1).view, 'image')[0].alt_text, /Birch crew/, 'the next click draws the crew last shown');
});

test('a superseded click\'s map waiting in the view\'s queue is skipped when its turn comes: deleted, never shown (PR #226 review)', async () => {
  const mapPoints = fx.fakeMapPoints();
  const work = gate();
  let holdWork = false;
  const slow = async (...args) => {
    if (holdWork) {
      holdWork = false;
      await work.wait();
    }
    return mapPoints(...args);
  };
  const ctx = setup({ mapPoints: slow });
  await open(ctx);
  // An update ahead in the view's queue, held at Slack: a click with no
  // session (told "expired") that takes no number in the session.
  const ahead = gate();
  const update = ctx.app.client.views.update;
  let heldAhead = false;
  ctx.app.client.views.update = async (args) => {
    if (!heldAhead && texts(args.view).some((t) => /has expired/.test(t))) {
      heldAhead = true;
      await ahead.wait();
    }
    return update(args);
  };
  holdWork = true;
  const older = click(ctx, 'routing-map:view', pick('zone'));
  await settle();
  const v = lastView(ctx.app);
  const stray = click(ctx, 'routing-map:view', pick('gap'), {
    view: {
      id: 'V1', type: 'modal', hash: ctx.app.hashes.get('V1'), private_metadata: 'not-a-session', title: v.title,
    },
  });
  await settle();
  work.open(); // the older click uploads F2 and queues its map behind the held update
  await settle(50);
  assert.equal(ctx.app.uploads.length, 2);
  const newer = click(ctx, 'routing-map:view', pick('gap')); // its "Drawing the map…" queues behind
  await settle();
  ahead.open();
  await Promise.all([older, stray, newer]);
  const shownFiles = calls(ctx.app, 'update').flatMap((u) => blocksOf(u.view, 'image').map((b) => b.slack_file.id));
  assert.ok(!shownFiles.includes('F2'), 'the superseded map is never shown');
  assert.ok(ctx.app.deleted.includes('F2'), 'and its file is deleted');
  assert.equal(blocksOf(lastView(ctx.app), 'image')[0].slack_file.id, 'F3', 'the newer map shows');
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F3']);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'map superseded' && l.fields.step === 'show'));
});

test('"map not shown" dropped on hash_conflict (a newer update won): logged quietly, never the handler\'s failure path (PR #226 review)', async () => {
  const ctx = setup();
  await open(ctx);
  ctx.app.rateLimited.add('files.uploadV2');
  const update = ctx.app.client.views.update;
  ctx.app.client.views.update = async (args) => {
    if (texts(args.view).includes(MAP_NOT_SHOWN)) ctx.app.hashes.set('V1', 'h-elsewhere');
    return update(args);
  };
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.ok(!ctx.log.lines.some((l) => l.msg === 'handler failed'), 'no handler failure');
  assert.ok(!calls(ctx.app, 'update').some((u) => texts(u.view).includes(PLAIN_ERROR)), 'no plain error shown');
  assert.ok(ctx.log.lines.some((l) => l.level === 'info' && l.msg === 'stale view result dropped'
    && l.fields.action === 'map not shown' && l.fields.reason === 'hash_conflict'));
});

test('an unexpected failure in a click: the plain error shows and the view\'s map files are deleted then, not at the sweep (PR #226 review)', async () => {
  const ctx = setup();
  await open(ctx);
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F1']);
  const update = ctx.app.client.views.update;
  let failed = false;
  ctx.app.client.views.update = async (args) => {
    if (!failed && texts(args.view).includes('Drawing the map…')) {
      failed = true;
      throw Object.assign(new Error('An API error occurred: internal_error'), { data: { ok: false, error: 'internal_error' } });
    }
    return update(args);
  };
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.ok(ctx.log.lines.some((l) => l.msg === 'handler failed' && l.fields.handler === 'hub:routing-map'));
  assert.deepEqual(texts(lastView(ctx.app)), [PLAIN_ERROR]);
  assert.equal(lastView(ctx.app).callback_id, 'hub:map', 'still a map view: view_closed still comes');
  assert.deepEqual(ctx.app.deleted, ['F1']);
  assert.equal(ctx.store.mapFileCount(), 0);
});

test('an unexpected failure in a click with files.delete rate limited: the plain error shows; the records stay for the sweep (PR #226 review)', async () => {
  const ctx = setup();
  await open(ctx);
  ctx.app.rateLimited.add('files.delete');
  const update = ctx.app.client.views.update;
  let failed = false;
  ctx.app.client.views.update = async (args) => {
    if (!failed && texts(args.view).includes('Drawing the map…')) {
      failed = true;
      throw Object.assign(new Error('An API error occurred: internal_error'), { data: { ok: false, error: 'internal_error' } });
    }
    return update(args);
  };
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.deepEqual(texts(lastView(ctx.app)), [PLAIN_ERROR]);
  assert.deepEqual(ctx.app.deleted, []);
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F1'], 'kept for the sweep');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'map file delete failed; kept for the next sweep'));
});

// --- the four views (F15) -------------------------------------------------------------------

const nodesOf = (routes) => routes.map((r) => [r.crewId, r.stops]);

test('compare: both panels (booked, optimized) and both drive totals', async () => {
  const ctx = setup();
  await open(ctx);
  const [{ view, model }] = ctx.models;
  assert.equal(view, 'compare');
  assert.deepEqual(model.frame, { ...FRAME });
  assert.deepEqual(model.crews, [{ crewId: 'v1', color: 0, baseNode: 'crew:v1' }]);
  assert.deepEqual(nodesOf(model.booked), [['v1', ['property:s1', 'property:s2', 'property:s3', 'property:s4']]]);
  assert.deepEqual(nodesOf(model.optimized), [['v1', ['property:s1', 'property:s3', 'property:s2', 'property:s4']]]);
  const svg = renderSvg(view, model);
  assert.equal((svg.match(/<polyline /g) || []).length, 2, 'one line per panel');
  assert.equal((svg.match(/<circle [^>]*r="11"/g) || []).length, 8, 'four numbered stops in each panel');
  assert.match(lines(lastView(ctx.app))[1], /^Driving: booked 22 min, optimized 20 min\./);
});

test('change: moved stops, the cross-zone recommendation and the stops to rebook, each with its row', async () => {
  const ctx = setup();
  await open(ctx);
  await click(ctx, 'routing-map:view', pick('change'));
  const { view, model } = ctx.models.at(-1);
  assert.equal(view, 'change');
  assert.deepEqual(model.crews, [
    { crewId: 'v1', color: 0, baseNode: 'crew:v1' }, { crewId: 'v2', color: 1, baseNode: 'crew:v2' }, { crewId: 'v3', color: 2, baseNode: 'crew:v3' },
  ]);
  assert.deepEqual(nodesOf(model.before), [
    ['v1', ['property:s1', 'property:s2', 'property:s3', 'property:s4']], ['v2', ['property:s5', 'property:s6', 'property:s7']],
  ]);
  assert.deepEqual(nodesOf(model.after), [['v1', ['property:s1', 'property:s5', 'property:s2', 'property:s3', 'property:s4']], ['v2', []]]);
  assert.deepEqual(model.moved, ['property:s5']);
  assert.deepEqual(model.crossZone, [{ node: 'property:s6', crewId: 'v3' }]);
  assert.deepEqual(model.unplaced, ['property:s7']);
  const svg = renderSvg(view, model);
  assert.equal((svg.match(/stroke-dasharray="2 7"/g) || []).length, 1, 'the cross-zone recommendation dashed');
  assert.equal((svg.match(/<circle [^>]*r="16"/g) || []).length, 2, 'the moved stop ringed in both panels');
  assert.deepEqual(lines(lastView(ctx.app)), [
    '*Route change: Zone north, Monday 2026-11-02*',
    'crew v2 is not working today: 3 stops to place; 1 placed in their zone, 1 recommended for another zone, 1 to rebook; 3 existing stops to confirm a new time.',
    'Not working: Birch crew.',
    "1. 08:00 · Maple crew · Ana Ruiz, Riverton · 5 min drive · stays on crew v1; 5 minutes' drive from the crew's base",
    "2. 10:05 · Maple crew · Eva Moss, Riverton · 5 min drive · moved from crew v2 to crew v1, both in zone north; 5 minutes' drive from stop s1",
    "3. 11:15 · Maple crew · Ben Ode, Riverton · 7 min drive · stays on crew v1; 7 minutes' drive from stop s5",
    "4. 12:50 · Maple crew · Cara Lind, Lakeside · 5 min drive · stays on crew v1; 5 minutes' drive from stop s2",
    "5. 14:00 · Maple crew · Dev Patel, Lakeside · 6 min drive · stays on crew v1; 6 minutes' drive from stop s3",
    'Recommended for another zone, not placed: 10:40 · Cedar crew · Finn Hale, Hillcrest · crew v2 is not working today and no slot on crew v1 keeps every hard rule (it would make stop s4 break one (no start leaves time to finish by 19:00)); crew v3 in zone south could take it at 10:40 (27 more minutes of driving): a recommendation only, not in any crew\'s plan',
    'To rebook: Gail Ito, Hillcrest · locked to crew v2 at 15:00, and crew v2 is not working today; call to rebook',
    'New time: 10:10 to 11:15 · Maple crew · Ben Ode, Riverton · now starts at 11:15 instead of 10:10, after stop s5 joined crew v1; call to confirm the new time',
    'New time: 11:45 to 12:50 · Maple crew · Cara Lind, Lakeside · now starts at 12:50 instead of 11:45, after stop s5 joined crew v1; call to confirm the new time',
    'New time: 12:55 to 14:00 · Maple crew · Dev Patel, Lakeside · now starts at 14:00 instead of 12:55, after stop s5 joined crew v1; call to confirm the new time',
    SUGGEST_ONLY,
  ]);
  const [actions] = blocksOf(lastView(ctx.app), 'actions');
  assert.deepEqual(actions.elements[2].options.map((o) => [o.value, o.text.text]), [['north', 'Zone north'], ['south', 'Zone south']]);
  assert.equal(actions.elements[2].action_id, 'routing-map:zone');
});

test('zone: one color per crew, the zone outlined, and every crew\'s rows', async () => {
  const ctx = setup();
  await open(ctx);
  await click(ctx, 'routing-map:view', pick('zone'));
  const { view, model } = ctx.models.at(-1);
  assert.deepEqual(model.crews.map((c) => [c.crewId, c.color]), [['v1', 0], ['v2', 1]]);
  assert.deepEqual(model.zones, [{ zoneId: 'north', crewIds: ['v1', 'v2'] }]);
  const svg = renderSvg(view, model);
  assert.equal(new Set([...svg.matchAll(/<polyline [^>]*stroke="(#[0-9A-F]{6})"/g)].map((m) => m[1])).size, 2, 'two line colors');
  assert.equal((svg.match(/fill-opacity="0.05"/g) || []).length, 1, 'one zone outline');
  assert.deepEqual(lines(lastView(ctx.app)), [
    '*Zone north: 2 crews, Monday 2026-11-02*',
    '1. 08:00 · Maple crew · Ana Ruiz, Riverton · 5 min drive · as booked',
    '2. 10:15 · Maple crew · Ben Ode, Riverton · 6 min drive · as booked',
    '3. 14:30 · Maple crew · Cara Lind, Lakeside · 5 min drive · as booked',
    '4. 15:45 · Maple crew · Dev Patel, Lakeside · 6 min drive · as booked',
    '1. 08:00 · Birch crew · Eva Moss, Riverton · 5 min drive · as booked',
    '2. 09:15 · Birch crew · Finn Hale, Hillcrest · 5 min drive · as booked',
    '3. 15:00 · Birch crew · Gail Ito, Hillcrest · 5 min drive · as booked',
    SUGGEST_ONLY,
  ]);
  await click(ctx, 'routing-map:zone', pick('south'));
  assert.deepEqual(ctx.models.at(-1).model.zones, [{ zoneId: 'south', crewIds: ['v3'] }]);
  assert.equal(blocksOf(lastView(ctx.app), 'image')[0].alt_text, 'Route map: Zone, Zone south, 2 stops');
});

test('gap: the gap and up to five ranked candidates, each with its reason', async () => {
  const ctx = setup();
  await open(ctx);
  await click(ctx, 'routing-map:view', pick('gap'));
  const { view, model } = ctx.models.at(-1);
  assert.deepEqual(model.gap, { crewId: 'v1', before: 'property:s2', after: 'property:s3' });
  assert.deepEqual(model.candidates, [
    { node: 'property:k1', rank: 1 }, { node: 'property:k2', rank: 2 }, { node: 'property:k3', rank: 3 },
    { node: 'property:k4', rank: 4 }, { node: 'property:k5', rank: 5 },
  ]);
  const svg = renderSvg(view, model);
  assert.equal((svg.match(/<polygon [^>]*fill="#333333"/g) || []).length, 5, 'five diamonds');
  assert.equal((svg.match(/<circle [^>]*r="(17|22)"/g) || []).length, 4, 'both neighbours double-ringed');
  const rows = lines(lastView(ctx.app));
  assert.deepEqual(rows.slice(0, 3), [
    '*Gap fill: Maple crew, Monday 2026-11-02*',
    'Gap: 11:45 to 14:30 (165 min), after Ben Ode, Riverton, before Cara Lind, Lakeside.',
    'Cancelled: Jon Avery, Riverton.',
  ]);
  assert.equal(rows[3], '1. 11:50 · Kim Sato, Riverton · booked on Maple crew for 2026-11-05 (3 days earlier) · 5 min extra drive · Extra drive minutes: 5; Days the visit moves up: 3; could start at 11:50 on crew v1 (5 minutes\' drive in, 5 out, 5 more minutes of driving); moves up 3 days from 2026-11-05; call to confirm');
  assert.equal(rows[6], '4. 11:50 · Nia Cole, Lakeside · booked on no crew for 2026-11-09 (7 days earlier) · 5 min extra drive · Extra drive minutes: 5; Flexible (no hard day or time rule); could start at 11:50 on crew v1 (5 minutes\' drive in, 5 out, 5 more minutes of driving); moves up 7 days from 2026-11-09; call to confirm');
  assert.equal(rows.length, 9);
  await click(ctx, 'routing-map:crew', pick('v2'));
  assert.deepEqual(texts(lastView(ctx.app)), ["No visit was cancelled on Birch crew on Monday 2026-11-02, so there's no gap to fill."]);
  assert.equal(blocksOf(lastView(ctx.app), 'image').length, 0);
  assert.ok(ctx.app.deleted.includes('F2'), 'the gap map no longer shown is deleted');
});

// --- crew leads (AD-R17, F7) -------------------------------------------------------------------

const otherCustomers = (crewId) => Object.entries(DAY.places)
  .filter(([node]) => node.startsWith('property:'))
  .filter(([node]) => {
    const stop = [...DAY.stops, ...DAY.cancelled, ...DAY.candidates].find((s) => s.node === node);
    return stop && stop.currentCrewId !== crewId;
  })
  .map(([, p]) => p.client_name);

test('a crew lead: every view holds only their crew; the adapter gets their scope, the labels are filtered by it, mapPoints gets only their ids', async () => {
  const ctx = setup();
  await open(ctx, U.leadA);
  for (const v of ['change', 'zone', 'gap']) await click(ctx, 'routing-map:view', pick(v), { user: U.leadA });
  // The adapter's inputs and labels went with the lead's scope.
  const labelCalls = ctx.data.calls.filter((c) => c.sql === fx.SQL.labels);
  assert.equal(labelCalls.length, 4);
  for (const c of labelCalls) assert.equal(c.params.crew_id, 'v1');
  for (const c of labelCalls) assert.ok(!c.params.node_ids.split(',').some((n) => /^crew:v[23]$/.test(n)), c.params.node_ids);
  assert.deepEqual(ctx.mapPoints.asked, [
    ['crew:v1', 'property:s1', 'property:s2', 'property:s3', 'property:s4'],
    ['crew:v1', 'property:s1', 'property:s2', 'property:s3', 'property:s4', 'property:s5'],
    ['crew:v1', 'property:s1', 'property:s2', 'property:s3', 'property:s4'],
    ['crew:v1', 'property:s1', 'property:s2', 'property:s3', 'property:s4', 'property:k1', 'property:k5'],
  ]);
  for (const { model } of ctx.models) assert.deepEqual(model.crews.map((c) => c.crewId), ['v1']);
  // Their text lists name no other crew's customer, except the stop moved onto their crew (in full).
  const all = calls(ctx.app, 'update').map((u) => JSON.stringify(u.view)).join('\n');
  for (const name of otherCustomers('v1').filter((n) => n !== 'Eva Moss')) assert.ok(!all.includes(name), name);
  assert.ok(!all.includes('Birch crew') && !all.includes('Cedar crew'), 'no other crew named');
});

test('a crew lead\'s route change: stops moved onto their crew show in full; stops moved off show as "moved to another crew", with no destination', async () => {
  const a = setup();
  await open(a, U.leadA);
  await click(a, 'routing-map:view', pick('change'), { user: U.leadA });
  assert.ok(lines(lastView(a.app)).includes("2. 10:05 · Maple crew · Eva Moss, Riverton · 5 min drive · moved from crew v2 to crew v1, both in zone north; 5 minutes' drive from stop s1"));
  assert.deepEqual(a.models.at(-1).model.moved, ['property:s5']);

  const b = setup();
  await open(b, U.leadB);
  await click(b, 'routing-map:view', pick('change'), { user: U.leadB });
  const { model } = b.models.at(-1);
  assert.deepEqual(model.crews, [{ crewId: 'v2', color: 1, baseNode: 'crew:v2' }], 'the lead keeps their crew\'s color');
  assert.deepEqual(nodesOf(model.after), [['v2', []]]);
  assert.deepEqual(model.crossZone, [], 'no destination line');
  assert.deepEqual(model.moved, ['property:s5', 'property:s6']);
  assert.deepEqual(model.unplaced, ['property:s7']);
  assert.deepEqual(b.mapPoints.asked.at(-1), ['crew:v2', 'property:s5', 'property:s6', 'property:s7']);
  assert.deepEqual(lines(lastView(b.app)), [
    '*Route change: Birch crew, Monday 2026-11-02*',
    'Not working: Birch crew.',
    'Moved: Eva Moss, Riverton · moved to another crew',
    'Moved: Finn Hale, Hillcrest · moved to another crew',
    'To rebook: Gail Ito, Hillcrest · locked to crew v2 at 15:00, and crew v2 is not working today; call to rebook',
    SUGGEST_ONLY,
  ]);
  const text = JSON.stringify(lastView(b.app));
  for (const word of ['Maple', 'Cedar', 'crew v1', 'crew v3', 'Ana Ruiz']) assert.ok(!text.includes(word), word);
});

test('a crew lead\'s gap fill: candidates on other crews or on none are counted only, each by what it is; the visible ones renumbered 1..n', async () => {
  const ctx = setup();
  await open(ctx, U.leadA);
  await click(ctx, 'routing-map:view', pick('gap'), { user: U.leadA });
  assert.deepEqual(ctx.models.at(-1).model.candidates, [{ node: 'property:k1', rank: 1 }, { node: 'property:k5', rank: 2 }]);
  const rows = lines(lastView(ctx.app));
  assert.match(rows[3], /^1\. 11:50 · Kim Sato, Riverton · booked on Maple crew/);
  assert.match(rows[4], /^2\. 11:50 · Omar Diaz, Riverton · booked on Maple crew/);
  // k2 (Birch), k3 (Cedar) and k4 (booked on no crew), counted apart (PR #226 review).
  assert.equal(rows[5], '2 more visits booked on other crews and 1 visit not booked on any crew could fill it; they are not shown here.');
  for (const name of ['Lea Quinn', 'Max Ford', 'Nia Cole']) assert.ok(!rows.join('\n').includes(name), name);
});

test('the hidden gap-fill count names what it counts: other crews, no crew, or both', () => {
  assert.deepEqual(hiddenLine(0, 0), []);
  assert.deepEqual(hiddenLine(1, 0), ['1 more visit booked on other crews could fill it; it is not shown here.']);
  assert.deepEqual(hiddenLine(2, 0), ['2 more visits booked on other crews could fill it; they are not shown here.']);
  assert.deepEqual(hiddenLine(0, 1), ['1 more visit not booked on any crew could fill it; it is not shown here.']);
  assert.deepEqual(hiddenLine(0, 2), ['2 more visits not booked on any crew could fill it; they are not shown here.']);
  assert.deepEqual(hiddenLine(1, 2), ['1 more visit booked on other crews and 2 visits not booked on any crew could fill it; they are not shown here.']);
});

test('a lead\'s action naming another crew or a zone still yields only their crew: the scope comes from the audience', async () => {
  const ctx = setup();
  await open(ctx, U.leadA);
  await click(ctx, 'routing-map:crew', pick('v2'), { user: U.leadA });
  await click(ctx, 'routing-map:zone', pick('south'), { user: U.leadA });
  await click(ctx, 'routing-map:view', pick('zone'), { user: U.leadA });
  await click(ctx, 'routing-map:zone', pick('north'), { user: U.leadA });
  for (const { model } of ctx.models) assert.deepEqual(model.crews.map((c) => c.crewId), ['v1']);
  for (const asked of ctx.mapPoints.asked) assert.ok(asked.every((n) => !['crew:v2', 'crew:v3', 'property:s5', 'property:s8'].includes(n)), asked.join());
  for (const c of ctx.data.calls.filter((x) => x.sql === fx.SQL.labels)) assert.equal(c.params.crew_id, 'v1');
  const [actions] = blocksOf(lastView(ctx.app), 'actions');
  assert.deepEqual(actions.elements[2].options.map((o) => o.value), ['v1'], 'the lead\'s select offers their crew only');
});

test('own_crew with no crew_leads row: the configuration refusal, logged; nothing is read or drawn', async () => {
  const ctx = setup();
  await open(ctx, U.none);
  assert.deepEqual(texts(lastView(ctx.app)), [`That option isn't set up correctly, so I can't open it right now. I've logged the problem; please tell ${ADMIN}.`]);
  assert.deepEqual(ctx.data.calls, []);
  assert.deepEqual(ctx.mapPoints.asked, []);
  assert.deepEqual(ctx.app.uploads, []);
  assert.ok(ctx.log.lines.some((l) => l.level === 'error' && l.msg === 'routing map refused' && l.fields.reason === 'own_crew with no crew_leads row'));
});

test('a crew_leads row whose crew_id matches no crew: the configuration refusal, never an empty map; logged; no positions or names read', async () => {
  const ctx = setup();
  await open(ctx, U.ghost);
  assert.deepEqual(texts(lastView(ctx.app)), [`That option isn't set up correctly, so I can't open it right now. I've logged the problem; please tell ${ADMIN}.`]);
  assert.equal(blocksOf(lastView(ctx.app), 'image').length, 0);
  assert.deepEqual(ctx.mapPoints.asked, []);
  assert.ok(!ctx.data.calls.some((c) => c.sql === fx.SQL.labels));
  assert.deepEqual(ctx.app.uploads, []);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map refused' && /not in the data/.test(l.fields.reason)));
});

// --- the session (F7) ---------------------------------------------------------------------------

test('the session is bound to the user and the view: a click from another user changes nothing; from another view it is refused there', async () => {
  const ctx = setup();
  await open(ctx);
  const sessionView = lastView(ctx.app);
  const before = ctx.app.views.length;
  await click(ctx, 'routing-map:view', pick('zone'), { user: U.leadB });
  assert.equal(ctx.app.views.length, before, 'another user: the view is not touched');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.reason === 'another user'));
  await click(ctx, 'routing-map:view', pick('zone'), {
    view: {
      id: 'V9', type: 'modal', private_metadata: sessionView.private_metadata, title: sessionView.title,
    },
  });
  const other = calls(ctx.app, 'update').at(-1);
  assert.equal(other.view_id, 'V9');
  assert.deepEqual(texts(other.view), [MAP_WORDS.notYours()]);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'routing map click refused' && l.fields.reason === 'another view'));
  assert.equal(ctx.app.uploads.length, 1, 'nothing drawn for either');
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F1'], 'the owner\'s map stays');
});

test('session ids are crypto.randomUUID values, one per Open', async () => {
  const ctx = setup();
  await open(ctx);
  const a = lastView(ctx.app).private_metadata;
  await open(ctx);
  const b = lastView(ctx.app).private_metadata;
  assert.match(a, ID_PATTERN);
  assert.match(b, ID_PATTERN);
  assert.notEqual(a, b);
});

// --- access and the LLM -----------------------------------------------------------------------------

test('access is re-checked on every click: withdrawn mid-session, the refusal shows in the view and the map is deleted', async () => {
  let withdrawn = false;
  const ctx = setup({ canUse: () => (withdrawn ? 'denied' : 'allowed') });
  await open(ctx);
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.equal(ctx.app.uploads.length, 2);
  withdrawn = true;
  await click(ctx, 'routing-map:view', pick('gap'));
  assert.deepEqual(texts(lastView(ctx.app)), [`You don't have access to Routing; ask ${ADMIN}.`]);
  assert.equal(lastView(ctx.app).callback_id, 'hub:map');
  assert.equal(ctx.app.uploads.length, 2, 'nothing drawn');
  assert.equal(ctx.store.mapFileCount(), 0, 'the map no longer shown is deleted');
  // The session is gone: a later click is told it expired.
  withdrawn = false;
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.match(texts(lastView(ctx.app))[0], /^This map has expired/);
});

test('nothing goes to the LLM: an AI service wired into the hub is never called by the map', async () => {
  const used = [];
  const llm = new Proxy({}, { get: (_, k) => { used.push(k); return () => { throw new Error('the map called the AI service'); }; } });
  const ctx = setup({ llm });
  used.length = 0;
  await open(ctx);
  for (const v of ['change', 'zone', 'gap']) await click(ctx, 'routing-map:view', pick(v));
  assert.deepEqual(used, []);
  assert.equal(ctx.app.uploads.length, 4);
});

// --- nothing leaks (F15) --------------------------------------------------------------------------

const MICRO = Object.values(DAY.places).flatMap((p) => [p.lat_e6, p.lon_e6]).filter(Number.isInteger).map(String);
const ADDRESSES = Object.values(DAY.places).flatMap((p) => [p.street_address, p.postal_code]).filter(Boolean);

// Every object reachable from v (no cycles followed twice).
function holdsPointsOrXY(v, seen = new Set()) {
  if (v === null || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  if (Buffer.isBuffer(v)) return false;
  if (Object.hasOwn(v, 'x') || Object.hasOwn(v, 'y')) return true;
  return Object.values(v).some((x) => holdsPointsOrXY(x, seen));
}

test('no log line, Slack call or error holds the points or an x/y key; none holds a micro-degree value, an address or a postal code', async () => {
  const errors = [];
  const ctx = setup();
  // Every failure exit too: a node missing, a render fault, an upload refused.
  const users = [U.dispatch, U.leadA, U.leadB, U.ghost, U.none];
  for (const user of users) {
    await open(ctx, user);
    for (const v of ['change', 'zone', 'gap', 'compare']) await click(ctx, 'routing-map:view', pick(v), { user });
  }
  const broken = setup({ mapPoints: async (d, ids, frame) => { const r = await fx.fakeMapPoints()(d, ids, frame); return { ...r, points: r.points.slice(1) }; } });
  await open(broken);
  const failing = setup({ render: () => { throw new RoutingFault({ field: 'map image', problem: 'renderer_failed' }); } });
  await open(failing);
  for (const c of [ctx, broken, failing]) {
    for (const l of c.log.lines) if (l.fields && l.fields.err) errors.push(l.fields.err);
    const records = [
      ['log', c.log.lines], ['views', c.app.views], ['uploads', c.app.uploads.map(({ file, ...rest }) => rest)],
      ['deleted', c.app.deleted], ['responded', c.app.responded], ['posted', c.app.posted], ['errors', errors],
    ];
    for (const [name, rec] of records) {
      assert.equal(holdsPointsOrXY(rec), false, `${name} holds a points object or an x/y key`);
      const text = JSON.stringify(rec);
      for (const m of MICRO) assert.ok(!text.includes(m), `${name} holds a micro-degree value`);
      for (const a of ADDRESSES) assert.ok(!text.includes(a), `${name} holds an address or postal code`);
    }
  }
  assert.ok(ctx.models.length > 0, 'the renderer did get points');
});

// Every object reachable from v that holds a mosaic key (no cycles followed twice).
const MOSAIC_KEYS = Object.keys(fx.FAKE_MOSAIC);
// Whether text holds the tile number n as a whole token, not inside a longer
// run of letters or digits: a session id (a random UUID in
// private_metadata) can hold "3068" inside a longer hex run by chance
// (clean-bones CI on PR #309), while a leaked tile number stands alone
// ("/2417/3066.png", "tx0":2417), so it still matches (as holdsToken in the
// Brightside routing tests, PR #239).
const holdsTileNumber = (text, n) => new RegExp(`(?<![0-9A-Za-z])${n}(?![0-9A-Za-z])`).test(text);

function holdsMosaic(v, seen = new Set()) {
  if (v === null || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  if (Buffer.isBuffer(v)) return false;
  if (Object.hasOwn(v, 'mosaic') || ['tx0', 'ty0', 'ox', 'oy'].some((k) => Object.hasOwn(v, k))) return true;
  return Object.values(v).some((x) => holdsMosaic(x, seen));
}

test('Story 15.8: the renderer gets the points only; the mosaic reaches no renderer, log line, Slack call or error (AD-R20)', async () => {
  const mapPoints = fx.fakeMapPoints();
  const reads = [];
  const spy = async (...args) => { const r = await mapPoints(...args); reads.push(r); return r; };
  const ctx = setup({ mapPoints: spy });
  const users = [U.dispatch, U.leadA, U.leadB, U.ghost, U.none];
  for (const user of users) {
    await open(ctx, user);
    for (const v of ['change', 'zone', 'gap', 'compare']) await click(ctx, 'routing-map:view', pick(v), { user });
  }
  // The error exits too: a node missing, a render fault.
  const broken = setup({
    mapPoints: async (d, ids, frame) => { const r = await fx.fakeMapPoints()(d, ids, frame); return { ...r, points: r.points.slice(1) }; },
  });
  await open(broken);
  const failing = setup({ render: () => { throw new RoutingFault({ field: 'map image', problem: 'renderer_failed' }); } });
  await open(failing);
  assert.ok(ctx.models.length > 0 && reads.length === ctx.models.length, 'every read was drawn');
  // The renderer gets exactly the read's points, and nothing of the mosaic.
  ctx.models.forEach(({ model }, i) => {
    assert.equal(model.points, reads[i].points, 'the points the read returned, as returned');
    assert.equal(holdsMosaic(model), false, 'the model holds no mosaic');
    for (const k of MOSAIC_KEYS) assert.equal(Object.hasOwn(model, k), false, `the model has no ${k}`);
  });
  const big = [fx.FAKE_MOSAIC.tx0, fx.FAKE_MOSAIC.ty0].map(String);
  for (const c of [ctx, broken, failing]) {
    const errors = c.log.lines.filter((l) => l.fields && l.fields.err).map((l) => l.fields.err);
    const records = [
      ['log', c.log.lines], ['views', c.app.views], ['uploads', c.app.uploads.map(({ file, ...rest }) => rest)],
      ['deleted', c.app.deleted], ['responded', c.app.responded], ['posted', c.app.posted], ['errors', errors],
    ];
    for (const [name, rec] of records) {
      assert.equal(holdsMosaic(rec), false, `${name} holds a mosaic or a tile key`);
      const text = JSON.stringify(rec) + (name === 'errors' ? errors.map((e) => `${e && e.message} ${e && e.stack}`).join('\n') : '');
      for (const n of big) assert.ok(!holdsTileNumber(text, n), `${name} holds a tile number`);
      assert.ok(!/mosaic|tx0|ty0/.test(text), `${name} names the mosaic`);
    }
  }
});

test('Story 15.8: a read with no points list draws nothing: an engine fault (no_position), at the error exit', async () => {
  for (const shape of [[], null, { mosaic: fx.FAKE_MOSAIC }, { points: 'none', mosaic: null }]) {
    const ctx = setup({ mapPoints: async () => shape });
    await open(ctx);
    await errorExit(ctx, PLAN_FAILED);
    assert.deepEqual(ctx.log.lines.find((l) => l.msg === 'routing map not drawn').fields, {
      module: 'routing', view: 'compare', field: 'mapPoints', problem: 'no_position',
    }, JSON.stringify(shape));
    assert.deepEqual(ctx.app.uploads, []);
  }
});

// --- exits -------------------------------------------------------------------------------------------

test('exit, Back: returns to the hub menu and view_closed deletes the session\'s files; the session is gone', async () => {
  const ctx = setup();
  await open(ctx);
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F2']);
  // Back pops the pushed view: the menu was never replaced.
  assert.ok(!calls(ctx.app, 'update').some((u) => u.view_id === 'VMENU'));
  assert.equal(await ctx.app.dispatchViewClosed('hub:map', { user: U.dispatch, view: { id: 'V1' } }), 1);
  assert.deepEqual(ctx.app.deleted, ['F1', 'F2']);
  assert.equal(ctx.store.mapFileCount(), 0);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'map view closed' && l.fields.deleted === 1 && l.fields.cleared === false));
  await click(ctx, 'routing-map:view', pick('gap'));
  assert.match(texts(lastView(ctx.app))[0], /^This map has expired/);
});

test('exit, Close (the X): view_closed with is_cleared deletes the session\'s files', async () => {
  const ctx = setup();
  await open(ctx);
  await ctx.app.dispatchViewClosed('hub:map', { user: U.dispatch, view: { id: 'V1' }, is_cleared: true });
  assert.deepEqual(ctx.app.deleted, ['F1']);
  assert.equal(ctx.store.mapFileCount(), 0);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'map view closed' && l.fields.cleared === true));
});

for (const how of ['Back', 'Close']) {
  test(`exit, ${how} with no view_closed: the sweep deletes the files within 20 minutes of upload (every clock frozen)`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-02T15:00:00Z') });
    const store = createStore();
    let jobs;
    const ctx = setup({ store, sweeping: () => jobs.running('sweep-map-files') });
    jobs = createEngineJobs({ names: ['sweep-map-files'], store, client: ctx.app.client, log: ctx.log });
    jobs.start();
    t.mock.timers.tick(3 * MIN);
    await open(ctx);
    await click(ctx, 'routing-map:view', pick('zone'));
    const uploaded = Date.now();
    let goneAt = null;
    for (let m = 1; m <= 25 && goneAt === null; m += 1) {
      t.mock.timers.tick(MIN);
      await settle(5);
      if (ctx.app.deleted.includes('F2')) goneAt = Date.now();
    }
    assert.ok(goneAt !== null, 'the sweep deleted the map');
    assert.ok(goneAt - uploaded <= 20 * MIN, `lived ${(goneAt - uploaded) / MIN} minutes`);
    assert.equal(store.mapFileCount(), 0);
    jobs.stop();
  });
}

const errorExit = async (ctx, expected) => {
  const shown = lastView(ctx.app);
  assert.deepEqual(texts(shown), [expected]);
  assert.equal(shown.close.text, 'Back', 'with Back');
  assert.equal(shown.callback_id, 'hub:map');
  assert.equal(blocksOf(shown, 'image').length, 0);
};
const PLAN_FAILED = MAP_WORDS.planFailed(ADMIN);
const DRAW_FAILED = MAP_WORDS.drawFailed(ADMIN);
const DATA_DOWN = "The data isn't available right now, so I can't answer that. The app is still running; please tell your admin.";

test('exit, data unavailable: on Open and on a click, a plain message in the view with Back', async () => {
  const ctx = setup();
  ctx.data.failWith = new DataUnavailable('fixture down');
  await open(ctx);
  await errorExit(ctx, DATA_DOWN);
  ctx.data.failWith = null;
  const c2 = setup();
  await open(c2);
  c2.data.failWith = new DataUnavailable('fixture down');
  await click(c2, 'routing-map:view', pick('zone'));
  assert.deepEqual(texts(lastView(c2.app)), [DATA_DOWN]);
  assert.equal(blocksOf(lastView(c2.app), 'actions').length, 1, 'the controls stay, to try again');
  assert.deepEqual(c2.app.deleted, ['F1']);
  assert.ok(c2.log.lines.some((l) => l.msg === 'data unavailable' && l.fields.reason === 'fixture down'));
});

test('exit, the real mapPoints with a data object createData did not make: data unavailable, nothing uploaded', async () => {
  const { mapPoints } = require('../../kit/runtime/data/map');
  const ctx = setup({ mapPoints });
  await open(ctx);
  await errorExit(ctx, DATA_DOWN);
  assert.deepEqual(ctx.app.uploads, []);
});

test('exit, an engine fault: a plain message in the view with Back; the fault logged by field and problem', async () => {
  const day = JSON.parse(JSON.stringify(DAY));
  day.stops[0].currentCrewId = 'v9';
  const ctx = setup({ data: fx.fakeData({ day }) });
  await open(ctx);
  await errorExit(ctx, PLAN_FAILED);
  const line = ctx.log.lines.find((l) => l.msg === 'routing map not drawn');
  assert.deepEqual(line.fields, { module: 'routing', view: 'compare', field: 'stops[0].currentCrewId', problem: 'unknown_crew' });
  assert.deepEqual(ctx.app.uploads, []);
});

test('exit, a node missing from mapPoints: an engine fault, at the error exit', async () => {
  const points = fx.fakeMapPoints();
  const ctx = setup({
    mapPoints: async (d, ids, frame) => { const r = await points(d, ids, frame); return { ...r, points: r.points.filter((p) => p.node !== 'property:s3') }; },
  });
  await open(ctx);
  await errorExit(ctx, PLAN_FAILED);
  assert.deepEqual(ctx.log.lines.find((l) => l.msg === 'routing map not drawn').fields, {
    module: 'routing', view: 'compare', field: 'mapPoints', problem: 'no_position',
  });
  assert.deepEqual(ctx.app.uploads, []);
});

test('exit, labels holding any field but crew name, client name and city: refused, at the error exit', async () => {
  const leaky = routingModule({
    createAdapter: (args) => {
      const real = fx.createAdapter(args);
      return {
        ...real,
        labels: async (q) => {
          const out = await real.labels(q);
          const first = Object.keys(out).find((k) => k.startsWith('property:'));
          out[first] = { ...out[first], street: 'somewhere' };
          return out;
        },
      };
    },
  });
  const ctx = setup({ mod: leaky });
  await open(ctx);
  await errorExit(ctx, PLAN_FAILED);
  assert.deepEqual(ctx.log.lines.find((l) => l.msg === 'routing map not drawn').fields.problem, 'unknown_key');
  assert.deepEqual(ctx.mapPoints.asked, [], 'refused before any position is read');
});

test('the fixture adapter\'s labels hold only crew name, client name and city', async () => {
  const adapter = fx.createAdapter({ data: fx.fakeData() });
  const nodeIds = Object.keys(DAY.places);
  const out = await adapter.labels({ day: DAY.day, nodeIds, scope: { all: true } });
  assert.equal(Object.keys(out).length, nodeIds.length);
  for (const [node, label] of Object.entries(out)) {
    assert.deepEqual(Object.keys(label).sort(), node.startsWith('crew:') ? ['crewName'] : ['city', 'clientName'], node);
  }
  const lead = await adapter.labels({ day: DAY.day, nodeIds, scope: { crewId: 'v1' } });
  assert.deepEqual(Object.keys(lead).filter((n) => n.startsWith('crew:')), ['crew:v1']);
  const input = await adapter.input({ day: DAY.day, view: 'compare', scope: { crewId: 'v1' } });
  assert.deepEqual(input.input.crews.map((c) => c.crewId), ['v1']);
  assert.equal(typeof input.travel, 'function');
});

test('exit, a render failure and the rasterizer failing to load: a plain message in the view with Back; nothing uploaded', async () => {
  for (const problem of ['renderer_failed', 'renderer_unavailable', 'image_too_large']) {
    const ctx = setup({ render: () => { throw new RoutingFault({ field: 'map image', problem }); } });
    await open(ctx);
    await errorExit(ctx, DRAW_FAILED);
    assert.deepEqual(ctx.app.uploads, [], problem);
    assert.equal(ctx.log.lines.find((l) => l.msg === 'routing map not drawn').fields.problem, problem);
  }
});

test('exit, an upload failure and Slack\'s ratelimited on files.uploadV2: the plain upload message with Back; nothing recorded', async () => {
  const ctx = setup();
  ctx.app.rateLimited.add('files.uploadV2');
  await open(ctx);
  await errorExit(ctx, MAP_NOT_SHOWN);
  assert.equal(ctx.store.mapFileCount(), 0);
  assert.deepEqual(ctx.log.lines.find((l) => l.msg === 'map not shown').fields, { module: 'routing', reason: 'ratelimited' });
  // A click while still limited: the same, the controls kept.
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.deepEqual(texts(lastView(ctx.app)), [MAP_NOT_SHOWN]);
  assert.equal(blocksOf(lastView(ctx.app), 'actions').length, 1);
  ctx.app.rateLimited.clear();
  ctx.app.filesFail = Object.assign(new Error('An API error occurred: internal_error'), { data: { ok: false, error: 'internal_error' } });
  await click(ctx, 'routing-map:view', pick('gap'));
  assert.deepEqual(texts(lastView(ctx.app)), [MAP_NOT_SHOWN]);
});

test('exit, Slack\'s ratelimited on files.delete: a map not shown keeps its record for the sweep and the view says so with Back; a replaced map stays shown', async () => {
  const ctx = setup();
  await open(ctx);
  ctx.app.rateLimited.add('files.delete');
  ctx.app.filesNotReadyFor = Infinity; // the new map is never accepted, so it must be deleted
  await click(ctx, 'routing-map:view', pick('zone'));
  await errorExit(ctx, MAP_NOT_SHOWN);
  assert.deepEqual(ctx.app.deleted, [], 'every delete was rate limited');
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1').sort(), ['F1', 'F2'], 'both kept for the sweep');
  assert.ok(ctx.log.lines.some((l) => l.level === 'warn' && l.msg === 'map file delete failed; kept for the next sweep' && l.fields.reason === 'ratelimited'));
  // A switch that shows: the old files' deletes are limited, the new map stays.
  ctx.app.filesNotReadyFor = 0;
  await click(ctx, 'routing-map:view', pick('gap'));
  assert.equal(blocksOf(lastView(ctx.app), 'image')[0].slack_file.id, 'F3');
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1').sort(), ['F1', 'F2', 'F3']);
  ctx.app.rateLimited.clear();
  await ctx.app.dispatchViewClosed('hub:map', { user: U.dispatch, view: { id: 'V1' } });
  assert.equal(ctx.store.mapFileCount(), 0);
});

test('exit, an expired trigger on Open: the hub\'s existing path (in place on the menu, logged); no map, nothing read', async () => {
  const ctx = setup();
  ctx.app.viewsFail.push = Object.assign(new Error('An API error occurred: expired_trigger_id'), { data: { ok: false, error: 'expired_trigger_id' } });
  await ctx.app.dispatchAction('routing:open', { user: U.dispatch, view: { ...MENU, hash: 'hmenu' } });
  const [update] = calls(ctx.app, 'update');
  assert.equal(update.view_id, 'VMENU');
  assert.deepEqual(texts(update.view), [MAP_NEEDS_WINDOW]);
  assert.ok(ctx.log.lines.some((l) => l.msg === 'hub modal fallback' && l.fields.reason === 'expired_trigger_id'));
  assert.deepEqual(ctx.data.calls, []);
  assert.deepEqual(ctx.app.uploads, []);
});

test('exit, an expired session (15 minutes without use): "this map has expired, go back and open Routing again" (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T15:00:00Z') });
  const ctx = setup();
  await open(ctx);
  t.mock.timers.tick(14 * MIN);
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.equal(blocksOf(lastView(ctx.app), 'image').length, 1, 'a click within 15 minutes draws, and renews the session');
  t.mock.timers.tick(15 * MIN + 1);
  const uploads = ctx.app.uploads.length;
  const reads = ctx.data.calls.length;
  await click(ctx, 'routing-map:view', pick('gap'));
  const shown = lastView(ctx.app);
  assert.deepEqual(texts(shown), [MAP_WORDS.expired('Routing')]);
  assert.equal(MAP_WORDS.expired('Routing'), 'This map has expired (a map closes after 15 minutes without use). Go back and open Routing again.');
  assert.equal(shown.close.text, 'Back');
  assert.equal(ctx.app.uploads.length, uploads);
  assert.equal(ctx.data.calls.length, reads, 'nothing read');
  assert.equal(ctx.store.mapFilesOf('UDISPATCH:V1').length, 0, 'its map deleted');
});

test('a click from outside a modal is told to open the map in its window', async () => {
  const ctx = setup();
  await ctx.app.dispatchAction('routing-map:view', { user: U.dispatch, action: pick('zone') });
  assert.deepEqual(ctx.app.responded.map((r) => r.text), [MAP_NEEDS_WINDOW]);
  assert.deepEqual(ctx.app.uploads, []);
});

// --- the fake rejects what Slack rejects (AD-R16, F10) ---------------------------------------

test('the fake refuses what Slack refuses in a map view: titles, blocks, metadata, selects, options, dates, unknown or deleted files, rate limits, stale hashes', async () => {
  const app = new FakeSlackApp({ views: true });
  const png = renderPng('compare', JSON.parse(JSON.stringify(require('../fixtures/routing-map/compare.json').model)));
  const up = await app.client.files.uploadV2({ file: png, filename: 'route-map.png', title: 'Route map' });
  const id = up.files[0].files[0].id;
  const opt = (v, t = v) => ({ text: { type: 'plain_text', text: t }, value: v });
  const select = (over = {}) => ({
    type: 'static_select', action_id: 'routing-map:view', options: [opt('a'), opt('b')], initial_option: opt('a'), ...over,
  });
  const view = (blocks, over = {}) => ({
    type: 'modal', title: { type: 'plain_text', text: 'Routing' }, close: { type: 'plain_text', text: 'Back' }, blocks, ...over,
  });
  const image = { type: 'image', slack_file: { id }, alt_text: 'Route map: Zone, Zone north, 2 stops' };
  const actions = (...elements) => ({ type: 'actions', elements });
  const update = (v) => app.client.views.update({ view_id: 'V1', view: v });
  const refused = (v, code) => assert.rejects(update(v), (e) => e.data.error === code, JSON.stringify(v).slice(0, 120));

  // What the archetype sends is accepted.
  await update(view([actions(select(), { type: 'datepicker', action_id: 'routing-map:day', initial_date: '2026-11-02' }), image]));
  // A select or date picker the way Slack refuses it.
  await refused(view([actions(select({ options: Array.from({ length: 101 }, (_, i) => opt(`v${i}`)), initial_option: undefined }))]), 'invalid_blocks');
  await refused(view([actions(select({ options: [opt('a', 'x'.repeat(76))], initial_option: undefined }))]), 'invalid_blocks');
  await refused(view([actions(select({ initial_option: opt('z') }))]), 'invalid_blocks');
  await refused(view([actions(select({ options: [], initial_option: undefined }))]), 'invalid_blocks');
  for (const d of ['2026-11-2', '11/02/2026', 20261102, '']) {
    await refused(view([actions({ type: 'datepicker', action_id: 'routing-map:day', initial_date: d })]), 'invalid_blocks');
  }
  await refused(view([{ type: 'context', elements: [select()] }]), 'invalid_blocks');
  await refused(view([actions(...Array.from({ length: 26 }, () => select()))]), 'invalid_blocks');
  // The view's frame.
  await refused(view([image], { title: { type: 'plain_text', text: 'x'.repeat(25) } }), 'invalid_arguments');
  await refused(view(Array.from({ length: 101 }, () => ({ type: 'divider' }))), 'invalid_arguments');
  await refused(view([image], { private_metadata: 'x'.repeat(3001) }), 'invalid_arguments');
  await refused(view([{ type: 'section', text: { type: 'mrkdwn', text: 'x'.repeat(3001) } }]), 'invalid_blocks');
  // An unknown or deleted slack_file, answered as Slack answers it.
  await refused(view([{ ...image, slack_file: { id: 'F999' } }]), 'invalid_arguments');
  await app.client.files.delete({ file: id });
  await refused(view([image]), 'invalid_arguments');
  // Rate limits on upload and delete.
  app.rateLimited.add('files.uploadV2');
  await assert.rejects(app.client.files.uploadV2({ file: png, filename: 'route-map.png' }), (e) => e.data.error === 'ratelimited');
  app.rateLimited.add('files.delete');
  await assert.rejects(app.client.files.delete({ file: id }), (e) => e.data.error === 'ratelimited');
  // A stale hash, when the fake checks hashes (as Slack does).
  app.checkHashes = true;
  const pushed = await app.client.views.push({ trigger_id: app.issueTrigger('T-x'), view: view([]) });
  await app.client.views.update({ view_id: pushed.view.id, hash: pushed.view.hash, view: view([]) });
  await assert.rejects(app.client.views.update({ view_id: pushed.view.id, hash: pushed.view.hash, view: view([]) }), (e) => e.data.error === 'hash_conflict');
});

// --- Story 15.10: streets under the plot (AD-R18, AD-R19, AD-R21) ----------------------------

const { createBasemap, REASONS } = require('../../kit/runtime/basemap');
const { createFakeTiles } = require('../fixtures/fake-tiles');

const SOURCE = loadProfile(path.join(__dirname, '../fixtures/profiles/routing-basemap.yml')).routing.basemap;
// The audience profile with a street map source (the basemap fixture's block).
const streetProfile = (over = {}) => ({ ...profile, routing: { ...profile.routing, basemap: { ...SOURCE, ...over } } });
// A mosaic that covers the archetype's 700 x 560 frame: 4 x 3 tiles.
const STREET_MOSAIC = Object.freeze({ ...fx.FAKE_MOSAIC, cols: 4 });
const TILE_COUNT = STREET_MOSAIC.cols * STREET_MOSAIC.rows;
const CAPTION = '<https://tiles.example.org/copyright|© Example Map contributors>';
const UNAVAILABLE = 'Street map unavailable, showing the plain map.';

// The real tile fetcher (a fresh cache) on the fake tile server, spied:
// calls holds each { mosaic, opts }; hold(call) may delay or change a call.
function streetFetcher({ env = {}, hold } = {}) {
  const tiles = createFakeTiles();
  const { fetchMosaic } = createBasemap();
  const calls = [];
  const real = (mosaic, opts) => fetchMosaic(mosaic, { ...opts, fetch: tiles.fetch, env });
  const fn = async (mosaic, opts) => {
    const call = { mosaic, opts };
    calls.push(call);
    if (hold) {
      const held = await hold(call, real);
      if (held !== undefined) return held;
    }
    return real(mosaic, opts);
  };
  return { tiles, calls, fn };
}

function streetSetup({ fetcher = streetFetcher(), mosaic = STREET_MOSAIC, ...rest } = {}) {
  const ctx = setup({
    profile: streetProfile(), mapPoints: fx.fakeMapPoints({ mosaic }), fetchMosaic: fetcher.fn, ...rest,
  });
  return { ...ctx, fetcher };
}

// Resolves when signal aborts, with what fetchMosaic gives for an abort.
const untilAborted = (signal) => new Promise((resolve) => {
  const done = () => resolve({
    basemap: null, reason: 'aborted', requested: TILE_COUNT, cached: 0,
  });
  if (signal.aborted) done();
  else signal.addEventListener('abort', done, { once: true });
});

const captionOf = (view) => {
  const types = view.blocks.map((b) => b.type);
  const at = types.indexOf('image');
  const next = view.blocks[at + 1];
  return next && next.type === 'context' ? next.elements.map((e) => e.text).join('') : null;
};
const tileLines = (ctx) => ctx.log.lines.filter((l) => l.msg === 'street map tiles');

test('Story 15.10: with a basemap block and a mosaic the streets show: the view\'s tiles fetched, drawn under the plot, the attribution straight under the image; alt text unchanged', async () => {
  const ctx = streetSetup();
  await open(ctx);
  const shown = lastView(ctx.app);
  assert.deepEqual(shown.blocks.map((b) => b.type), ['actions', 'context', 'image', 'context', 'section']);
  assert.equal(captionOf(shown), CAPTION);
  assert.deepEqual(blocksOf(shown, 'image')[0].alt_text, 'Route map: Booked vs optimized, Maple crew, 4 stops', 'the alt text holds no attribution');
  // The fetcher got the view's mosaic, the profile and a live signal.
  const [call] = ctx.fetcher.calls;
  assert.deepEqual(call.mosaic, STREET_MOSAIC);
  assert.ok(call.opts.signal instanceof AbortSignal);
  assert.equal(call.opts.signal.aborted, false);
  assert.equal(call.opts.profile.routing.basemap.url_template, SOURCE.url_template);
  assert.equal(ctx.fetcher.tiles.requests.length, TILE_COUNT);
  // The renderer got pixel offsets and bytes only.
  const [{ view, model, opts }] = ctx.models;
  assert.deepEqual(Object.keys(opts[0]), ['basemap']);
  const { basemap } = opts[0];
  assert.deepEqual(Object.keys(basemap).sort(), ['ox', 'oy', 'tiles']);
  assert.deepEqual([basemap.ox, basemap.oy], [STREET_MOSAIC.ox, STREET_MOSAIC.oy]);
  assert.equal(basemap.tiles.length, TILE_COUNT);
  for (const t of basemap.tiles) assert.deepEqual(Object.keys(t).sort(), ['col', 'png', 'row']);
  assert.equal(Object.hasOwn(model, 'basemap'), false);
  // What was uploaded is the map drawn over those tiles.
  assert.ok(ctx.app.uploads[0].file.equals(renderPng(view, model, { basemap })));
  assert.ok(!ctx.app.uploads[0].file.equals(renderPng(view, model)));
});

test('Story 15.10: one "street map tiles" line per fetch, holding only the module, the counts and the reason code; reopening the view requests nothing new', async () => {
  const ctx = streetSetup();
  await open(ctx);
  await open(ctx);
  const lines = tileLines(ctx);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.level, l.fields]), [
    ['info', { module: 'routing', requested: TILE_COUNT, cached: 0, reason: null }],
    ['info', { module: 'routing', requested: TILE_COUNT, cached: TILE_COUNT, reason: null }],
  ]);
  assert.equal(ctx.fetcher.tiles.requests.length, TILE_COUNT, 'the second Open sent no tile request');
  // A failed fetch: its fixed reason code, still only counts.
  const down = streetSetup();
  down.fetcher.tiles.respond = { status: 503 };
  await open(down);
  assert.deepEqual(tileLines(down)[0].fields, { module: 'routing', requested: TILE_COUNT, cached: 0, reason: 'server_error' });
  // A fetcher that throws or answers oddly: fetch_failed, counts 0.
  for (const odd of [async () => { throw new Error('https://tiles.example.org/13/2417/3066.png'); }, async () => ({ basemap: null, reason: 'see https://x' }), async () => null]) {
    const c = streetSetup({ fetcher: { fn: odd, calls: [] } });
    await open(c);
    assert.deepEqual(tileLines(c)[0].fields, { module: 'routing', requested: 0, cached: 0, reason: 'fetch_failed' });
    assert.equal(captionOf(lastView(c.app)), UNAVAILABLE);
  }
  for (const l of [...tileLines(ctx), ...tileLines(down)]) assert.ok(l.fields.reason === null || REASONS.includes(l.fields.reason));
});

test('Story 15.10: the attribution is escaped, and linked only when attribution_url is an https link Slack can carry', async () => {
  const cases = [
    [{ attribution: '<b>Maps & co</b>' }, '<https://tiles.example.org/copyright|&lt;b&gt;Maps &amp; co&lt;/b&gt;>'],
    [{ attribution_url: 'javascript:alert(1)' }, '© Example Map contributors'],
    [{ attribution_url: 'https://evil.example/|<!channel>' }, '© Example Map contributors'],
    [{ attribution_url: 'https://tiles.example.org/c?a=1&b=2' }, '<https://tiles.example.org/c?a=1&amp;b=2|© Example Map contributors>'],
  ];
  for (const [over, want] of cases) {
    const ctx = setup({
      profile: streetProfile(over), mapPoints: fx.fakeMapPoints({ mosaic: STREET_MOSAIC }), fetchMosaic: streetFetcher().fn,
    });
    await open(ctx);
    assert.equal(captionOf(lastView(ctx.app)), want, JSON.stringify(over));
  }
});

test('Story 15.10: no basemap block: no tile fetch, no caption, the plain map as before', async () => {
  const fetcher = streetFetcher();
  const ctx = setup({ fetchMosaic: fetcher.fn, mapPoints: fx.fakeMapPoints({ mosaic: STREET_MOSAIC }) });
  await open(ctx);
  for (const v of ['change', 'zone', 'gap']) await click(ctx, 'routing-map:view', pick(v));
  assert.equal(fetcher.calls.length, 0);
  assert.equal(fetcher.tiles.requests.length, 0);
  assert.ok(ctx.models.every((m) => m.opts.length === 0), 'the renderer got no basemap');
  assert.equal(captionOf(lastView(ctx.app)), null);
  assert.equal(tileLines(ctx).length, 0);
});

test('Story 15.10: the fetch gives null, for any reason: the plain map with "Street map unavailable, showing the plain map."; never the error exit', async () => {
  const responds = [{ status: 503 }, { status: 429 }, { status: 403 }, { body: 'html' }, { body: 'small' }, { body: 'garbage' }, { body: 'oversize' }];
  const runs = responds.map((respond) => ({ name: JSON.stringify(respond), fetcher: (() => { const f = streetFetcher(); f.tiles.respond = respond; return f; })() }));
  runs.push({ name: 'the kill switch', fetcher: streetFetcher({ env: { APLABS_BASEMAP_OFF: '1' } }) });
  runs.push({ name: 'an unknown host', fetcher: streetFetcher(), profile: streetProfile({ url_template: 'https://no-such-tiles.example.org/{z}/{x}/{y}.png' }) });
  runs.push({ name: 'no mosaic', fetcher: streetFetcher(), mosaic: null });
  for (const run of runs) {
    const ctx = streetSetup({ fetcher: run.fetcher, ...(run.mosaic === null ? { mosaic: null } : {}), ...(run.profile ? { profile: run.profile } : {}) });
    await open(ctx);
    await click(ctx, 'routing-map:view', pick('zone'));
    const shown = lastView(ctx.app);
    assert.equal(blocksOf(shown, 'image').length, 1, `${run.name}: a map shows`);
    assert.equal(captionOf(shown), UNAVAILABLE, run.name);
    assert.equal(blocksOf(shown, 'image')[0].alt_text, 'Route map: Zone, Zone north, 7 stops', run.name);
    assert.ok(ctx.models.every((m) => m.opts.length === 0), `${run.name}: drawn plain`);
    assert.equal(ctx.app.uploads.length, 2, run.name);
    assert.ok(!ctx.log.lines.some((l) => l.msg === 'routing map not drawn'), `${run.name}: never the error exit`);
    if (run.mosaic === null) assert.equal(run.fetcher.calls.length, 0, 'no mosaic, no fetch');
  }
});

test('Story 15.10: rasterizing with tiles fails: one plain-map retry with the note; if that fails too, the error exit', async () => {
  for (const problem of ['renderer_failed', 'image_too_large', 'basemap_invalid', 'renderer_unavailable']) {
    const tilesFail = (view, model, opts) => {
      if (opts && opts.basemap) throw new RoutingFault({ field: 'map image', problem });
      return renderPng(view, model);
    };
    const ctx = streetSetup({ render: tilesFail });
    await open(ctx);
    assert.deepEqual(ctx.models.map((m) => m.opts.length), [1, 0], `${problem}: tiles, then plain once`);
    assert.equal(captionOf(lastView(ctx.app)), UNAVAILABLE, problem);
    assert.equal(ctx.app.uploads.length, 1);
    assert.deepEqual(ctx.log.lines.find((l) => l.msg === 'street map not drawn').fields, { module: 'routing', view: 'compare', reason: problem });
  }
  // A tile the fetcher let through that the renderer refuses: the real path.
  const small = require('../fixtures/fake-tiles').SMALL_PNG;
  const odd = async () => ({
    basemap: { tiles: Array.from({ length: TILE_COUNT }, (_, i) => ({ col: i % 4, row: Math.floor(i / 4), png: small })), ox: STREET_MOSAIC.ox, oy: STREET_MOSAIC.oy },
    reason: null, requested: TILE_COUNT, cached: 0,
  });
  const real = streetSetup({ fetcher: { fn: odd, calls: [] } });
  await open(real);
  assert.equal(captionOf(lastView(real.app)), UNAVAILABLE);
  assert.equal(real.log.lines.find((l) => l.msg === 'street map not drawn').fields.reason, 'basemap_invalid');
  // Both fail: the error exit, nothing uploaded.
  const always = streetSetup({ render: () => { throw new RoutingFault({ field: 'map image', problem: 'renderer_failed' }); } });
  await open(always);
  await errorExit(always, DRAW_FAILED);
  assert.equal(always.models.length, 2, 'one retry, no more');
  assert.deepEqual(always.app.uploads, []);
});

test('Story 15.10 exit: a newer click while tiles load aborts that fetch; the older click uploads nothing and the newer map shows', async () => {
  let held = null;
  const fetcher = streetFetcher({
    hold: async (call) => {
      if (!held) return undefined;
      const h = held;
      held = null;
      h.call = call;
      return untilAborted(call.opts.signal);
    },
  });
  const ctx = streetSetup({ fetcher });
  await open(ctx);
  held = {};
  const pending = held;
  const older = click(ctx, 'routing-map:view', pick('zone'));
  await settle();
  assert.ok(pending.call, 'the older click is loading tiles');
  assert.equal(pending.call.opts.signal.aborted, false);
  await click(ctx, 'routing-map:view', pick('gap'));
  await older;
  assert.equal(pending.call.opts.signal.aborted, true, 'the older fetch was aborted');
  assert.equal(ctx.app.uploads.length, 2, 'Open and the newer click only');
  const shown = lastView(ctx.app);
  assert.equal(blocksOf(shown, 'image')[0].alt_text, 'Route map: Gap fill, Maple crew, 4 stops');
  assert.equal(captionOf(shown), CAPTION);
  assert.ok(!calls(ctx.app, 'update').some((u) => /Zone/.test(JSON.stringify(blocksOf(u.view, 'image')))), 'the older map never shows');
  assert.deepEqual(ctx.store.mapFilesOf('UDISPATCH:V1'), ['F2']);
});

for (const [how, cleared] of [['Back', false], ['Close', true]]) {
  test(`Story 15.10 exit: ${how} while tiles load aborts the fetch; no file is uploaded`, async () => {
    let call = null;
    const fetcher = streetFetcher({ hold: async (c) => { call = c; return untilAborted(c.opts.signal); } });
    const ctx = streetSetup({ fetcher });
    const opening = open(ctx);
    await settle();
    assert.ok(call, 'Open is loading tiles');
    await ctx.app.dispatchViewClosed('hub:map', { user: U.dispatch, view: { id: 'V1' }, is_cleared: cleared });
    await opening;
    assert.equal(call.opts.signal.aborted, true);
    assert.deepEqual(ctx.app.uploads, []);
    assert.equal(ctx.store.mapFileCount(), 0);
    assert.deepEqual(ctx.app.views.map((v) => v.method), ['push'], 'nothing shown after the view closed');
  });
}

test('Story 15.10 exit: the session expires during the tile fetch: the expired message, nothing uploaded (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T15:00:00Z') });
  let expire = false;
  const fetcher = streetFetcher({
    hold: async () => {
      if (expire) t.mock.timers.tick(15 * MIN + 1);
      return undefined;
    },
  });
  const ctx = streetSetup({ fetcher });
  await open(ctx);
  assert.equal(ctx.app.uploads.length, 1);
  expire = true;
  await click(ctx, 'routing-map:view', pick('zone'));
  const shown = lastView(ctx.app);
  assert.deepEqual(texts(shown), [MAP_WORDS.expired('Routing')]);
  assert.equal(shown.close.text, 'Back');
  assert.equal(ctx.app.uploads.length, 1, 'nothing uploaded');
  assert.equal(ctx.store.mapFilesOf('UDISPATCH:V1').length, 0, 'the earlier map deleted');
  expire = false;
  await click(ctx, 'routing-map:view', pick('gap'));
  assert.deepEqual(texts(lastView(ctx.app)), [MAP_WORDS.expired('Routing')], 'the session is gone');
});

test('Story 15.10 exit: access withdrawn during the tile fetch: the refusal in the view, nothing uploaded (on a click and on Open)', async () => {
  let withdrawn = false;
  let withdraw = false;
  const fetcher = streetFetcher({ hold: async () => { if (withdraw) withdrawn = true; return undefined; } });
  const ctx = streetSetup({ fetcher, canUse: () => (withdrawn ? 'denied' : 'allowed') });
  await open(ctx);
  withdraw = true;
  await click(ctx, 'routing-map:view', pick('zone'));
  assert.deepEqual(texts(lastView(ctx.app)), [`You don't have access to Routing; ask ${ADMIN}.`]);
  assert.equal(lastView(ctx.app).callback_id, 'hub:map');
  assert.equal(ctx.app.uploads.length, 1, 'nothing uploaded');
  assert.equal(ctx.store.mapFileCount(), 0, 'the map no longer shown is deleted');
  withdrawn = false;
  withdraw = false;
  await click(ctx, 'routing-map:view', pick('gap'));
  assert.match(texts(lastView(ctx.app))[0], /^This map has expired/);

  let gone = false;
  const onOpen = streetSetup({ fetcher: streetFetcher({ hold: async () => { gone = true; return undefined; } }), canUse: () => (gone ? 'denied' : 'allowed') });
  await open(onOpen);
  assert.deepEqual(texts(lastView(onOpen.app)), [`You don't have access to Routing; ask ${ADMIN}.`]);
  assert.deepEqual(onOpen.app.uploads, []);
});

test('the tile-number check finds a number standing alone, and not inside a random session id', () => {
  assert.equal(holdsTileNumber('"private_metadata":"97776f30-2182-465c-8a15-306832575aab"', '3068'), false);
  for (const leak of ['/13/2417/3066.png', '"tx0":2417', 'tile 3066 failed', '[2417,3066]']) {
    assert.ok(holdsTileNumber(leak, leak.includes('2417') ? '2417' : '3066'), leak);
  }
});

test('Story 15.10: no tile number, mosaic or tile URL in any log line, Slack call or error', async () => {
  const ctxs = [];
  const shown = streetSetup();
  await open(shown);
  for (const v of ['change', 'zone', 'gap']) await click(shown, 'routing-map:view', pick(v));
  ctxs.push(shown);
  const down = streetSetup();
  down.fetcher.tiles.respond = { status: 503 };
  await open(down);
  ctxs.push(down);
  ctxs.push(streetSetup({ profile: streetProfile({ url_template: 'https://no-such-tiles.example.org/{z}/{x}/{y}.png' }) }));
  await open(ctxs.at(-1));
  ctxs.push(streetSetup({ render: () => { throw new RoutingFault({ field: 'map image', problem: 'renderer_failed' }); } }));
  await open(ctxs.at(-1));
  const numbers = [];
  for (let c = 0; c < STREET_MOSAIC.cols; c += 1) numbers.push(String(STREET_MOSAIC.tx0 + c));
  for (let r = 0; r < STREET_MOSAIC.rows; r += 1) numbers.push(String(STREET_MOSAIC.ty0 + r));
  for (const c of ctxs) {
    const errors = c.log.lines.filter((l) => l.fields && l.fields.err).map((l) => l.fields.err);
    const records = [
      ['log', c.log.lines], ['views', c.app.views], ['uploads', c.app.uploads.map(({ file, ...rest }) => rest)],
      ['deleted', c.app.deleted], ['responded', c.app.responded], ['posted', c.app.posted], ['errors', errors],
    ];
    for (const [name, rec] of records) {
      assert.equal(holdsMosaic(rec), false, `${name} holds a mosaic or a tile key`);
      const text = JSON.stringify(rec) + (name === 'errors' ? errors.map((e) => `${e && e.message} ${e && e.stack}`).join('\n') : '');
      for (const n of numbers) assert.ok(!holdsTileNumber(text, n), `${name} holds a tile number`);
      assert.ok(!/mosaic|tx0|ty0|\{z\}|\/\d+\/\d+\/\d+\.png|tiles\.example\.org\/\d|no-such-tiles/.test(text), `${name} names a tile, the mosaic or a tile URL`);
    }
  }
});
