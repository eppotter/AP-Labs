'use strict';

// Brightside's what-if route skills (Story 19.4, plan brightside-v1 D8):
// the adapter's visits(), gapFor(), crewOut() and route({ fill }), and
// Customer cancellation and Crew out through the hub, on a temporary build
// of the fixture. The planted scenarios: S2 (crew 2 on as_of+2, its
// afternoon visit cancelled; property 762's visit the best fill) and S3
// (crew 7 out on as_of+3: 5 placed in the zone, 1 cross-zone, 0 unplaced).
// None of the four runs new SQL: only day.sql, crews.sql, candidates.sql and
// labels.sql, which pass the guardrail with the coordinate, address and
// postal code columns forbidden; nothing shown or logged holds one.
//
// An example test (architecture carve-out): it reads Brightside's app dir and
// fixture, and is deleted with the example in a fork. Its profile comes from
// a test fixture (fixtures/routing-profile.yml), never profiles/brightside/.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { createData } = require('../../../kit/runtime/data');
const { checkSql } = require('../../../kit/runtime/sql');
const routing = require('../../../kit/runtime/routing');
const { RoutingFault } = require('../../../kit/runtime/errors');
const { createRegistry } = require('../../../kit/runtime/registry');
const { registerHubs } = require('../../../kit/runtime/slack/hubs');
const { createStore } = require('../../../kit/runtime/store');
const { createMapFiles } = require('../../../kit/runtime/slack/image');
const { renderPng } = require('../../../kit/runtime/routing-map');
const { WHATIF_WORDS } = require('../../../kit/runtime/messages');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const { createAdapter, SQL } = require('../app/routing/adapter');
const { S2, S3 } = require('../fixture/lib/scenarios');
const { toDay, toIso } = require('../fixture/lib/days');

const ROOT = path.join(__dirname, '../../..');
const APP = path.join(ROOT, 'examples/brightside/app');
const HUB = JSON.parse(fs.readFileSync(path.join(APP, 'hubs/brightside.json'), 'utf8'));
const profile = loadProfile(path.join(__dirname, 'fixtures/routing-profile.yml'));
const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/brightside/fixture/targets.json'), 'utf8')).routing;
const OFFICE = profile.routing.depot.node;
const slackOf = (id) => ({ id: profile.users.find((u) => u.id === id).identities.slack, name: id });
const DISPATCH = slackOf('dee');
const LEAD = slackOf('lee');
const LEAD_CREW = profile.routing.audience.crew_leads.find((l) => l.user === 'lee').crew_id;
const MENU = Object.freeze({ id: 'VMENU', type: 'modal', private_metadata: HUB.id });
const ALL = Object.freeze({ all: true });
const HIDDEN = ['clients.phone', 'properties.street_address', 'properties.postal_code', 'properties.geo_lat_e6', 'properties.geo_lon_e6',
  'crews.base_geo_lat_e6', 'crews.base_geo_lon_e6', 'depots.geo_lat_e6', 'depots.geo_lon_e6'];

let tmp;
let data;
let raw;
let asOf;
let adapter;
let ran;
const dayOf = (offset) => toIso(toDay(asOf) + offset);

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-route-whatif-')));
  const file = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: file });
  data = createData({ file, profile });
  raw = createData({ file, profile: { sql: { forbidden_columns: [] } } });
  asOf = (await data.run("SELECT value FROM fixture_meta WHERE key = 'as_of'"))[0].value;
  // Every SQL text the adapter runs, recorded.
  ran = new Set();
  const spied = Object.freeze({
    run: (sql, ...rest) => {
      ran.add(sql);
      return data.run(sql, ...rest);
    },
    describe: data.describe,
    travelMatrix: data.travelMatrix,
  });
  adapter = createAdapter({ data: spied, routing: profile.routing });
});
after(() => {
  if (data) data.close();
  if (raw) raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const propertyOf = async (visitId) => (await raw.run('SELECT property_id FROM scheduled_visits WHERE scheduled_visit_id = $id', { id: visitId }, { declared: ['id'] }))[0].property_id;
const clientOf = async (propertyId) => (await raw.run(
  "SELECT cl.first_name || ' ' || cl.last_name AS n FROM properties p JOIN clients cl ON cl.client_id = p.client_id WHERE p.property_id = $id",
  { id: propertyId },
  { declared: ['id'] },
))[0].n;
const gapOpts = () => ({ horizonDays: profile.routing.gap_fill.horizon_days, limit: profile.routing.gap_fill.limit });

// --- the adapter ---------------------------------------------------------------------

test('visits(): crew 2\'s visits on S2\'s day, booked and the one the data shows cancelled, each { stopId, node, start, cancelled }', async () => {
  const got = await adapter.visits({ day: dayOf(S2.dayOffset), crewId: String(S2.crewId), scope: ALL });
  assert.equal(got.known, true);
  assert.deepEqual(got.visits.map((v) => v.stopId).sort(), S2.route.map(String).sort());
  assert.deepEqual(got.visits.filter((v) => v.cancelled).map((v) => v.stopId), [String(S2.cancelled)]);
  for (const v of got.visits) assert.deepEqual(Object.keys(v).sort(), ['cancelled', 'node', 'start', 'stopId']);
  const none = await adapter.visits({ day: dayOf(S2.dayOffset), crewId: '999', scope: ALL });
  assert.deepEqual(none, { known: false, visits: [] });
});

test('gapFor(): S2\'s cancelled visit gives the data\'s own gap, property 762 first and the runner-up second (route-change-s2-top, -count)', async () => {
  const { input, travel } = await adapter.gapFor({
    day: dayOf(S2.dayOffset), crewId: String(S2.crewId), stopId: String(S2.cancelled), scope: ALL,
  });
  const result = routing.fillGap(input, { travel, ...gapOpts() });
  const gap = result.gaps.find((g) => g.cancelled.includes(String(S2.cancelled)));
  assert.equal(gap.valid, TARGETS['route-change-s2-count']);
  const node = (stopId) => input.candidates.find((c) => c.stopId === stopId).node;
  assert.deepEqual(gap.candidates.map((c) => node(c.stopId)), [`property:${TARGETS['route-change-s2-top']}`, `property:${S2.runnerUp}`]);
});

test('gapFor(): a booked visit taken as cancelled leaves the stops, joins the cancelled visits, and its property is never a candidate', async () => {
  const day = dayOf(S2.dayOffset);
  const [first] = S2.route;
  const { input } = await adapter.gapFor({
    day, crewId: String(S2.crewId), stopId: String(first), scope: ALL,
  });
  assert.ok(!input.stops.some((s) => s.stopId === String(first)));
  assert.deepEqual(input.cancelled.map((c) => c.stopId).sort(), [String(first), String(S2.cancelled)].sort());
  const gone = input.cancelled.find((c) => c.stopId === String(first)).node;
  assert.ok(!input.candidates.some((c) => c.node === gone));
  routing.validateInput(input);
});

test('gapFor(): a visit not on that crew that day, or a malformed id, is refused by field name before any travel read', async () => {
  const day = dayOf(S2.dayOffset);
  for (const [stopId, problem] of [['1', 'unknown_stop'], ['x', 'bad_id'], [undefined, 'bad_id']]) {
    await assert.rejects(adapter.gapFor({
      day, crewId: String(S2.crewId), stopId, scope: ALL,
    }), (err) => err instanceof RoutingFault && err.details.field === 'stopId' && err.details.problem === problem, String(stopId));
  }
  await assert.rejects(adapter.gapFor({ day, crewId: String(S2.crewId), stopId: String(S2.cancelled) }), (err) => err instanceof RoutingFault && err.details.field === 'scope');
});

test('crewOut(): crew 7 on S3\'s day was already out; the engine places 5 in the zone, 1 cross-zone, 0 unplaced (route-change-s3-crosszone)', async () => {
  const { input, travel, wasOut } = await adapter.crewOut({ day: dayOf(S3.dayOffset), crewId: String(S3.crewId), scope: ALL });
  assert.equal(wasOut, true);
  const result = routing.placeOrphans(input, { travel });
  assert.deepEqual(result.crewsOut, [String(S3.crewId)]);
  assert.deepEqual({
    in_zone: result.moves.filter((m) => !m.crossZone).length,
    cross_zone: result.moves.filter((m) => m.crossZone && m.recommendation).length,
    unplaced: result.unplaced.length,
  }, TARGETS['route-change-s3-crosszone']);
});

test('crewOut(): a working crew taken as out: available false, its stops keep their booked minutes, wasOut false; a crew lead\'s own crew whatever crewId says', async () => {
  const day = dayOf(S3.dayOffset);
  const working = String(S3.zoneCrews[1]);
  const { input, wasOut } = await adapter.crewOut({ day, crewId: working, scope: ALL });
  assert.equal(wasOut, false);
  assert.equal(input.crews.find((c) => c.crewId === working).available, false);
  const booked = await raw.run("SELECT CAST(scheduled_visit_id AS VARCHAR) AS id, scheduled_minutes AS m FROM scheduled_visits WHERE crew_id = $c AND visit_date = CAST($d AS DATE) AND status = 'scheduled'",
    { c: Number(working), d: day }, { declared: ['c', 'd'] });
  for (const r of booked) assert.equal(input.stops.find((s) => s.stopId === r.id).serviceMinutes, r.m);
  const lead = await adapter.crewOut({ day, crewId: '1', scope: { crewId: LEAD_CREW } });
  assert.equal(lead.input.crews.find((c) => c.crewId === LEAD_CREW).available, false);
  assert.equal(lead.input.crews.find((c) => c.crewId === '1').available, true, 'the click\'s crew is not touched');
});

test('route({ fill }): S2\'s day from the Office with the best fill in the cancelled visit\'s place, its service on crew 2\'s headcount', async () => {
  const day = dayOf(S2.dayOffset);
  const gap = await adapter.gapFor({
    day, crewId: String(S2.crewId), stopId: String(S2.cancelled), scope: ALL,
  });
  const best = gap.input.candidates.find((c) => c.node === `property:${S2.bestFill}`);
  const { input } = await adapter.route({
    day, crewId: String(S2.crewId), depot: OFFICE, scope: ALL, fill: { cancel: String(S2.cancelled), add: best.stopId },
  });
  routing.validateInput(input);
  const ids = input.stops.map((s) => s.stopId);
  assert.ok(ids.includes(best.stopId));
  assert.ok(!ids.includes(String(S2.cancelled)));
  const added = input.stops.find((s) => s.stopId === best.stopId);
  assert.equal(added.currentCrewId, String(S2.crewId));
  assert.equal(added.serviceMinutes, best.serviceMinutes, 'the gap crew\'s headcount, as the gap fill used');
  const [{ o }] = await raw.run('SELECT route_order AS o FROM scheduled_visits WHERE scheduled_visit_id = $id', { id: S2.cancelled }, { declared: ['id'] });
  assert.equal(added.routeOrder, o);
  await assert.rejects(adapter.route({
    day, crewId: String(S2.crewId), depot: OFFICE, scope: ALL, fill: { cancel: String(S2.cancelled), add: '1' },
  }), (err) => err instanceof RoutingFault && err.details.field === 'fill.add');
  await assert.rejects(adapter.route({
    day, crewId: String(S2.crewId), depot: OFFICE, scope: ALL, fill: { cancel: '1', add: best.stopId },
  }), (err) => err instanceof RoutingFault && err.details.field === 'fill.cancel');
});

test('the four run only the adapter\'s existing SQL, which passes the guardrail with every hidden column forbidden', () => {
  const known = new Set(Object.values(SQL));
  for (const sql of ran) {
    if (/fixture_meta/.test(sql)) continue;
    assert.ok(known.has(sql), 'only the adapter\'s own SQL files run');
  }
  for (const [name, sql] of Object.entries(SQL)) {
    assert.deepEqual(checkSql(sql, { forbiddenColumns: HIDDEN }), { ok: true }, name);
    for (const c of HIDDEN) assert.ok(!sql.includes(c.split('.')[1]), `${name} names ${c}`);
  }
  // Nor does the adapter's code: no hidden column is named outside its comments.
  const code = fs.readFileSync(path.join(APP, 'routing/adapter.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const c of HIDDEN) assert.ok(!code.includes(c.split('.')[1]), `adapter.js names ${c}`);
});

// --- through the hub -----------------------------------------------------------------

const moduleOf = (screen, id, label) => Object.freeze({
  id,
  hub: HUB.id,
  label,
  description: 'A what-if',
  resource: 'ROUTING_ALL_CREWS',
  archetype: 'routing-map',
  screen,
  environments: ['dev'],
  adapter: 'adapter.js',
  file: `modules/${id}/manifest.json`,
  createAdapter,
});
const CANCEL = moduleOf('cancellation', 'route-cancellation', 'Customer cancellation');
const OUT = moduleOf('crew-out', 'route-crew-out', 'Crew out');

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function hub() {
  const app = new FakeSlackApp({ views: true });
  app.checkHashes = true;
  const log = quietLog();
  const store = createStore();
  const mapFiles = createMapFiles({
    store, client: app.client, log, sweeping: () => true, sleep: async () => {},
  });
  const models = [];
  const render = (view, model, ...opts) => {
    models.push({ view, model });
    return renderPng(view, model, ...opts);
  };
  registerHubs(app, {
    registry: createRegistry({ hubs: [HUB], modules: [CANCEL, OUT] }), profile, env: 'dev', log, store, data, mapFiles,
    routingMap: { render, editor: { mapDelayMs: 0 } },
  });
  return { app, log, models };
}

const viewOf = (app) => app.views.at(-1).args.view;
const sectionTexts = (view) => view.blocks.filter((b) => b.type === 'section' && b.text).map((b) => b.text.text);
const elementsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await new Promise((r) => { setImmediate(r); }); };
const pick = (value) => ({ type: 'static_select', selected_option: { value, text: { type: 'plain_text', text: value } } });
function act(ctx, actionId, payload, user) {
  const v = viewOf(ctx.app);
  const from = {
    id: 'V1', type: 'modal', hash: ctx.app.hashes.get('V1'), private_metadata: v.private_metadata, title: v.title,
  };
  return ctx.app.dispatchAction(actionId, { user, view: from, ...payload });
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const holdsToken = (text, value) => new RegExp(`(?<![0-9A-Za-z])${escape(String(value))}(?![0-9A-Za-z])`).test(text);

test('through the hub: Customer cancellation, crew 2 on S2\'s day, the afternoon visit cancels; property 762\'s client is #1; Fill with #1 shows the day with it moved up', async () => {
  const ctx = hub();
  const day = dayOf(S2.dayOffset);
  await ctx.app.dispatchAction(`${CANCEL.id}:open`, { user: DISPATCH, view: MENU });
  await act(ctx, 'routing-map:crew', { action: pick(String(S2.crewId)) }, DISPATCH);
  await act(ctx, 'routing-map:day', { action: { type: 'datepicker', selected_date: day } }, DISPATCH);
  await act(ctx, 'routing-map:show', { value: 'show' }, DISPATCH);
  const select = elementsOf(viewOf(ctx.app)).find((e) => e.action_id === 'routing-map:visit');
  assert.equal(select.options.length, S2.route.length);
  const cancelledName = await clientOf(await propertyOf(S2.cancelled));
  const option = select.options.find((o) => o.text.text.endsWith(`${cancelledName} (cancelled)`));
  assert.ok(option, 'the afternoon visit the data shows cancelled is listed and marked');
  await act(ctx, 'routing-map:visit', { action: { type: 'static_select', selected_option: option } }, DISPATCH);
  await settle();
  const view = viewOf(ctx.app);
  assert.match(sectionTexts(view)[0], /is cancelled in the data/);
  const { view: drawn, model } = ctx.models.at(-1);
  assert.equal(drawn, 'gap');
  assert.deepEqual(model.candidates.map((c) => c.node), [`property:${TARGETS['route-change-s2-top']}`, `property:${S2.runnerUp}`]);
  const bestName = await clientOf(S2.bestFill);
  const list = sectionTexts(view).join('\n');
  assert.match(list, new RegExp(`\\n1\\. \\d\\d:\\d\\d · ${escape(bestName)}, `), 'property 762\'s client is first');
  const fills = elementsOf(view).filter((e) => /^routing-map:fill-\d$/.test(e.action_id));
  assert.deepEqual(fills.map((b) => b.text.text), ['Fill with #1', 'Fill with #2']);

  await act(ctx, fills[0].action_id, { value: fills[0].value }, DISPATCH);
  await settle();
  const day2 = sectionTexts(viewOf(ctx.app));
  const moved = day2.filter((t) => t.includes('↩️ Moved up from'));
  assert.equal(moved.length, 1);
  assert.ok(moved[0].includes(bestName), 'the moved-up row is the best fill\'s');
  assert.ok(!day2.some((t) => t.includes(`*${cancelledName}*`) || t.includes(` ${cancelledName}*`)), 'the cancelled visit is gone');
  assert.ok(viewOf(ctx.app).blocks.some((b) => b.type === 'image'), 'the day\'s map');

  // No coordinate, street address or postal code in Slack or the logs.
  const out = JSON.stringify(ctx.app.views) + JSON.stringify(ctx.log.lines);
  const secrets = await raw.run('SELECT p.street_address AS v FROM properties p UNION ALL SELECT CAST(p.geo_lat_e6 AS VARCHAR) FROM properties p');
  assert.deepEqual(secrets.filter((r) => holdsToken(out, r.v)), []);
});

test('through the hub: Crew out, crew 7 on S3\'s day: out in the data, says so; 5 move in the zone, 1 cross-zone, 0 to rebook', async () => {
  const ctx = hub();
  const day = dayOf(S3.dayOffset);
  await ctx.app.dispatchAction(`${OUT.id}:open`, { user: DISPATCH, view: MENU });
  await act(ctx, 'routing-map:day', { action: { type: 'datepicker', selected_date: day } }, DISPATCH);
  await act(ctx, 'routing-map:crew', { action: pick(String(S3.crewId)) }, DISPATCH);
  await act(ctx, 'routing-map:out', { value: 'out' }, DISPATCH);
  await settle();
  const view = viewOf(ctx.app);
  assert.match(sectionTexts(view)[0], /is out on .+ in the data,\* so this is the plan for it\./);
  const { view: drawn, model } = ctx.models.at(-1);
  assert.equal(drawn, 'change');
  assert.deepEqual({
    in_zone: model.moved.length,
    cross_zone: model.crossZone.length,
    unplaced: model.unplaced.length,
  }, TARGETS['route-change-s3-crosszone']);
  const text = sectionTexts(view).join('\n').split('\n');
  assert.equal(text.filter((l) => l.startsWith('Recommended for another zone, not placed:')).length, 1);
  assert.equal(text.filter((l) => l.startsWith('To rebook:')).length, 0);
  assert.deepEqual(elementsOf(view).map((e) => e.text.text), ['Change crew or day']);
});

test('through the hub: a crew lead\'s Customer cancellation lists only their crew\'s visits, whatever crew the click names', async () => {
  const ctx = hub();
  const day = dayOf(S3.dayOffset);
  await ctx.app.dispatchAction(`${CANCEL.id}:open`, { user: LEAD, view: MENU });
  await act(ctx, 'routing-map:day', { action: { type: 'datepicker', selected_date: day } }, LEAD);
  await act(ctx, 'routing-map:crew', { action: pick(String(S3.crewId)) }, LEAD);
  await act(ctx, 'routing-map:show', { value: 'show' }, LEAD);
  const select = elementsOf(viewOf(ctx.app)).find((e) => e.action_id === 'routing-map:visit');
  const own = await raw.run("SELECT COUNT(*)::INTEGER AS n FROM scheduled_visits WHERE crew_id = $c AND visit_date = CAST($d AS DATE) AND status IN ('scheduled', 'cancelled')",
    { c: Number(LEAD_CREW), d: day }, { declared: ['c', 'd'] });
  assert.equal(select.options.length, own[0].n);
  const crewName = (await raw.run('SELECT name FROM crews WHERE crew_id = $c', { c: Number(LEAD_CREW) }, { declared: ['c'] }))[0].name;
  assert.equal(sectionTexts(viewOf(ctx.app))[0].split('\n')[1], WHATIF_WORDS.whichVisit('x', 'y').split('\n')[1]);
  assert.ok(sectionTexts(viewOf(ctx.app))[0].startsWith(`*${crewName}, `), 'the lead\'s own crew');
});
