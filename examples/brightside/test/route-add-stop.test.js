'use strict';

// Brightside's Add a stop (Story 19.5, plan brightside-v1 D8): the adapter's
// clients() and addStop(), the engine's insertStop on what they give, and
// Add a stop through the hub, on a temporary build of the fixture. The demo
// day is S1's (crew 4 on as_of+1). clients.sql reads a client's name, its
// zone (clients.zone_id) and a property's city only, and passes the
// guardrail with the coordinate, address and postal code columns forbidden;
// nothing shown or logged holds one.
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
const { ADD_WORDS } = require('../../../kit/runtime/messages');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const { createAdapter, SQL } = require('../app/routing/adapter');
const { S1 } = require('../fixture/lib/scenarios');
const { toDay, toIso } = require('../fixture/lib/days');

const ROOT = path.join(__dirname, '../../..');
const APP = path.join(ROOT, 'examples/brightside/app');
const HUB = JSON.parse(fs.readFileSync(path.join(APP, 'hubs/brightside-v1.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(APP, 'modules/v1-route-add-stop/manifest.json'), 'utf8'));
const profile = loadProfile(path.join(__dirname, 'fixtures/routing-profile.yml'));
const OFFICE = profile.routing.depot.node;
const slackOf = (id) => ({ id: profile.users.find((u) => u.id === id).identities.slack, name: id });
const DISPATCH = slackOf('dee');
const LEAD = slackOf('lee');
const LEAD_CREW = profile.routing.audience.crew_leads.find((l) => l.user === 'lee').crew_id;
const MENU = Object.freeze({ id: 'VMENU', type: 'modal', private_metadata: HUB.id });
const ALL = Object.freeze({ all: true });
const HIDDEN = ['clients.phone', 'properties.street_address', 'properties.postal_code', 'properties.geo_lat_e6', 'properties.geo_lon_e6',
  'crews.base_geo_lat_e6', 'crews.base_geo_lon_e6', 'depots.geo_lat_e6', 'depots.geo_lon_e6'];
const CREW = String(S1.crewId);

let tmp;
let data;
let raw;
let asOf;
let adapter;
let day;
let zone;
let client;

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-route-add-stop-')));
  const file = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: file });
  data = createData({ file, profile });
  raw = createData({ file, profile: { sql: { forbidden_columns: [] } } });
  asOf = (await data.run("SELECT value FROM fixture_meta WHERE key = 'as_of'"))[0].value;
  day = toIso(toDay(asOf) + S1.dayOffset);
  adapter = createAdapter({ data, routing: profile.routing });
  zone = (await raw.run('SELECT zone_id FROM crews WHERE crew_id = $c', { c: S1.crewId }, { declared: ['c'] }))[0].zone_id;
  // A client of crew 4's zone with one property and no visit that day.
  [client] = await raw.run(`
    SELECT p.property_id, cl.first_name, cl.last_name
    FROM clients cl JOIN properties p ON p.client_id = cl.client_id
    WHERE cl.zone_id = $z
      AND p.property_id NOT IN (SELECT property_id FROM scheduled_visits WHERE visit_date = CAST($d AS DATE) AND status = 'scheduled')
      AND (SELECT COUNT(*) FROM properties q WHERE q.client_id = cl.client_id) = 1
    ORDER BY cl.last_name, cl.first_name, p.property_id
    LIMIT 1`, { z: zone, d: day }, { declared: ['z', 'd'] });
});
after(() => {
  if (data) data.close();
  if (raw) raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const nameOf = (c) => `${c.first_name} ${c.last_name}`;

// --- the adapter ----------------------------------------------------------------------

test('the v1 module: Add a stop on /brightside-v1, the routing key, Run, Routing, dev only', () => {
  assert.deepEqual(
    [MANIFEST.id, MANIFEST.hub, MANIFEST.label, MANIFEST.archetype, MANIFEST.screen, MANIFEST.resource, MANIFEST.verb, MANIFEST.group, MANIFEST.environments],
    ['v1-route-add-stop', 'brightside-v1', 'Add a stop', 'routing-map', 'add-stop', 'ROUTING_ALL_CREWS', 'Run', 'Routing', ['dev']],
  );
  assert.equal(require(path.join(APP, 'modules/v1-route-add-stop/adapter.js')).createAdapter, createAdapter);
});

test('clients(): clients of crew 4\'s zone whose name holds the text, at most 20, one per property, never one booked that day', async () => {
  const got = await adapter.clients({
    day, crewId: CREW, query: client.last_name.slice(0, 3), scope: ALL,
  });
  assert.ok(got.clients.length >= 1 && got.clients.length <= 20);
  assert.ok(got.clients.some((c) => c.node === `property:${client.property_id}` && c.clientName === nameOf(client)));
  for (const c of got.clients) {
    assert.deepEqual(Object.keys(c).sort(), ['city', 'clientName', 'node']);
    assert.ok(c.clientName.toLowerCase().includes(client.last_name.slice(0, 3).toLowerCase()));
    const id = Number(c.node.slice('property:'.length));
    const [row] = await raw.run('SELECT cl.zone_id FROM properties p JOIN clients cl ON cl.client_id = p.client_id WHERE p.property_id = $p', { p: id }, { declared: ['p'] });
    assert.equal(row.zone_id, zone, 'the crew\'s zone, by clients.zone_id');
    const booked = await raw.run("SELECT 1 FROM scheduled_visits WHERE property_id = $p AND visit_date = CAST($d AS DATE) AND status = 'scheduled'", { p: id, d: day }, { declared: ['p', 'd'] });
    assert.equal(booked.length, 0);
  }
  // A two-letter search a few names hold is still capped at 20.
  const wide = await adapter.clients({
    day, crewId: CREW, query: 'an', scope: ALL,
  });
  assert.ok(wide.clients.length <= 20);
});

test('addStop(): the zone\'s crews from the Office, the new stop with its window as a hard rule, travel and distance for every leg; insertStop places it', async () => {
  const got = await adapter.addStop({
    day, crewId: CREW, depot: OFFICE, scope: ALL, node: `property:${client.property_id}`, minutes: 60, window: 'afternoon',
  });
  routing.validateInput(got.input);
  assert.ok(got.input.crews.length >= 1);
  for (const c of got.input.crews) {
    assert.equal(c.baseNode, OFFICE);
    const [row] = await raw.run('SELECT zone_id FROM crews WHERE crew_id = $c', { c: Number(c.crewId) }, { declared: ['c'] });
    assert.equal(row.zone_id, zone);
  }
  assert.equal(got.input.stops.filter((s) => s.currentCrewId === CREW).length, S1.stops);
  assert.deepEqual(got.stop.rules, [{ ruleId: 'time-of-day', value: { startFrom: 720, startBefore: profile.routing.limits.latest_finish }, strength: 'hard' }]);
  assert.equal(got.stop.serviceMinutes, 60);
  assert.equal(got.stop.stopId, `add-${client.property_id}`);
  const crew4 = got.input.stops.filter((s) => s.currentCrewId === CREW).sort((a, b) => a.routeOrder - b.routeOrder).map((s) => s.stopId);
  const result = routing.insertStop(got.input, got.stop, { travel: got.travel, returnToBase: true, order: crew4 });
  assert.equal(result.crewId, CREW);
  assert.equal(result.order.length, S1.stops + 1);
  assert.ok(result.start >= 720, 'an afternoon start');
  // Every leg a reorder of crew 4's day can drive has a time and a distance.
  const nodes = [...new Set(result.order.map((id) => (id === got.stop.stopId ? got.stop.node : got.input.stops.find((s) => s.stopId === id).node)))];
  for (const from of [OFFICE, ...nodes]) {
    for (const to of [...nodes, OFFICE]) {
      if (from === to) continue;
      assert.ok(Number.isSafeInteger(got.travel(from, to)));
      assert.ok(Number.isSafeInteger(got.distance(from, to)));
    }
  }
  // Same input, same answer.
  assert.equal(JSON.stringify(result), JSON.stringify(routing.insertStop(got.input, got.stop, { travel: got.travel, returnToBase: true, order: crew4 })));
});

test('addStop() and clients() for a crew lead: only their own crew, whatever crewId says; their zone\'s clients only; no other crew to offer', async () => {
  const SCOPE = Object.freeze({ crewId: LEAD_CREW });
  const [lz] = await raw.run('SELECT zone_id FROM crews WHERE crew_id = $c', { c: Number(LEAD_CREW) }, { declared: ['c'] });
  const zoneCrews = await raw.run('SELECT crew_id FROM crews WHERE zone_id = $z', { z: lz.zone_id }, { declared: ['z'] });
  assert.ok(zoneCrews.length > 1, 'the lead\'s zone has other crews, so leaving them out is a real check');
  // A client of the lead's zone with no visit that day.
  const [mine] = await raw.run(`
    SELECT p.property_id FROM clients cl JOIN properties p ON p.client_id = cl.client_id
    WHERE cl.zone_id = $z
      AND p.property_id NOT IN (SELECT property_id FROM scheduled_visits WHERE visit_date = CAST($d AS DATE) AND status = 'scheduled')
    ORDER BY p.property_id LIMIT 1`, { z: lz.zone_id, d: day }, { declared: ['z', 'd'] });
  // crewId names crew 4 (another crew, maybe another zone): the scope wins.
  const got = await adapter.addStop({
    day, crewId: CREW, depot: OFFICE, scope: SCOPE, node: `property:${mine.property_id}`, minutes: 60, window: 'any',
  });
  assert.deepEqual(got.input.crews.map((c) => c.crewId), [LEAD_CREW]);
  assert.ok(got.input.stops.length > 0);
  assert.deepEqual([...new Set(got.input.stops.map((s) => s.currentCrewId))], [LEAD_CREW]);
  assert.equal(got.stop.currentCrewId, LEAD_CREW);
  const order = got.input.stops.sort((a, b) => a.routeOrder - b.routeOrder).map((s) => s.stopId);
  const result = routing.insertStop(got.input, got.stop, { travel: got.travel, returnToBase: true, order });
  assert.equal(result.crewId, LEAD_CREW);
  assert.deepEqual(result.others, [], 'no other crew is offered to a lead');
  // A client of crew 4's zone (another zone than the lead's) is refused for the lead.
  assert.notEqual(zone, lz.zone_id, 'crew 4 and the lead\'s crew work different zones');
  const err = await adapter.addStop({
    day, crewId: CREW, depot: OFFICE, scope: SCOPE, node: `property:${client.property_id}`, minutes: 60, window: 'any',
  }).catch((e) => e);
  assert.ok(err instanceof RoutingFault);
  assert.deepEqual([err.details.field, err.details.problem], ['node', 'unknown_client']);
  // The lead's search: every client in the lead's zone, whatever crewId says.
  const found = await adapter.clients({
    day, crewId: CREW, query: 'an', scope: SCOPE,
  });
  assert.ok(found.clients.length > 0);
  for (const c of found.clients) {
    const [row] = await raw.run('SELECT cl.zone_id FROM properties p JOIN clients cl ON cl.client_id = p.client_id WHERE p.property_id = $p', { p: Number(c.node.slice(9)) }, { declared: ['p'] });
    assert.equal(row.zone_id, lz.zone_id);
  }
});

test('addStop() refuses, by field name, a client booked that day or of another zone, and a bad length, window or node', async () => {
  const [bookedRow] = await raw.run("SELECT property_id FROM scheduled_visits WHERE crew_id = $c AND visit_date = CAST($d AS DATE) AND status = 'scheduled' LIMIT 1", { c: S1.crewId, d: day }, { declared: ['c', 'd'] });
  const [other] = await raw.run('SELECT p.property_id FROM properties p JOIN clients cl ON cl.client_id = p.client_id WHERE cl.zone_id <> $z LIMIT 1', { z: zone }, { declared: ['z'] });
  const base = {
    day, crewId: CREW, depot: OFFICE, scope: ALL, node: `property:${client.property_id}`, minutes: 60, window: 'any',
  };
  const cases = [
    [{ node: `property:${bookedRow.property_id}` }, 'node', 'unknown_client'],
    [{ node: `property:${other.property_id}` }, 'node', 'unknown_client'],
    [{ node: 'crew:4' }, 'node', 'bad_node'],
    [{ minutes: 50 }, 'minutes', 'out_of_range'],
    [{ minutes: 255 }, 'minutes', 'out_of_range'],
    [{ window: 'evening' }, 'window', 'out_of_range'],
    [{ scope: undefined }, 'scope', 'missing'],
  ];
  for (const [over, field, problem] of cases) {
    const err = await adapter.addStop({ ...base, ...over }).catch((e) => e);
    assert.ok(err instanceof RoutingFault, JSON.stringify(over));
    assert.deepEqual([err.details.field, err.details.problem], [field, problem], JSON.stringify(over));
  }
});

test('clients.sql passes the guardrail with every hidden column forbidden, and names none', () => {
  assert.deepEqual(checkSql(SQL.clients, { forbiddenColumns: HIDDEN }), { ok: true });
  for (const c of HIDDEN) assert.ok(!SQL.clients.includes(c.split('.')[1]), `clients.sql names ${c}`);
  const code = fs.readFileSync(path.join(APP, 'routing/adapter.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const c of HIDDEN) assert.ok(!code.includes(c.split('.')[1]), `adapter.js names ${c}`);
});

// --- through the hub ----------------------------------------------------------------------

const MOD = Object.freeze({
  ...MANIFEST, file: 'modules/v1-route-add-stop/manifest.json', createAdapter,
});

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function hub({ mod = MOD } = {}) {
  const app = new FakeSlackApp({ views: true });
  app.checkHashes = true;
  const log = quietLog();
  const store = createStore();
  const mapFiles = createMapFiles({
    store, client: app.client, log, sweeping: () => true, sleep: async () => {},
  });
  registerHubs(app, {
    registry: createRegistry({ hubs: [HUB], modules: [mod] }), profile, env: 'dev', log, store, data, mapFiles,
    routingMap: { editor: { mapDelayMs: 0 } },
  });
  return { app, log };
}

const viewOf = (app) => app.views.at(-1).args.view;
const sectionTexts = (view) => view.blocks.filter((b) => b.type === 'section' && b.text).map((b) => b.text.text);
const contexts = (view) => view.blocks.filter((b) => b.type === 'context').flatMap((b) => b.elements.map((e) => e.text));
const buttonsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements).filter((e) => e.type === 'button');
const rows = (view) => sectionTexts(view).filter((t) => /^\S+ \*\d\d:\d\d /.test(t));
const settle = async (n = 40) => { for (let i = 0; i < n; i += 1) await new Promise((r) => { setImmediate(r); }); };
const pick = (value) => ({ type: 'static_select', selected_option: { value, text: { type: 'plain_text', text: value } } });
const fromOf = (ctx) => {
  const v = viewOf(ctx.app);
  return {
    id: 'V1', type: 'modal', hash: ctx.app.hashes.get('V1'), private_metadata: v.private_metadata, title: v.title,
  };
};
const act = (ctx, actionId, payload, user = DISPATCH) => ctx.app.dispatchAction(actionId, { user, view: fromOf(ctx), ...payload });
const valueOf = (view, what) => buttonsOf(view).find((b) => b.value && b.value.endsWith(`:${what}`)).value;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const holdsToken = (text, value) => new RegExp(`(?<![0-9A-Za-z])${escape(String(value))}(?![0-9A-Za-z])`).test(text);

test('through the hub: crew 4 on S1\'s day, Add a stop, search a client of its zone, 60 minutes, afternoon: the stop joins with ➕; Remove takes it out', async () => {
  const ctx = hub();
  await ctx.app.dispatchAction(`${MOD.id}:open`, { user: DISPATCH, view: MENU });
  await act(ctx, 'routing-map:day', { action: { type: 'datepicker', selected_date: day } });
  await settle();
  await act(ctx, 'routing-map:crew', { action: pick(CREW) });
  await act(ctx, 'routing-map:show', { value: 'show' });
  await settle();
  const booked = rows(viewOf(ctx.app));
  assert.equal(booked.length, S1.stops);
  await act(ctx, 'routing-map:add', { value: valueOf(viewOf(ctx.app), 'add') });
  await settle();
  assert.ok(sectionTexts(viewOf(ctx.app)).some((t) => t.startsWith('*Add a stop to ')));
  await ctx.app.dispatchOptions('routing-map:client', { user: DISPATCH, view: fromOf(ctx), value: client.last_name.slice(0, 4) });
  const { options } = ctx.app.optionAcks.at(-1);
  const option = options.find((o) => o.text.text.startsWith(nameOf(client)));
  assert.ok(option, 'the client is offered');
  assert.ok(options.length <= 20);
  await act(ctx, 'routing-map:client', { action: { type: 'external_select', selected_option: option } });
  await act(ctx, 'routing-map:window', { action: pick('afternoon') });
  await act(ctx, 'routing-map:place', { value: valueOf(viewOf(ctx.app), 'place') });
  await settle();
  const view = viewOf(ctx.app);
  const list = rows(view);
  assert.equal(list.length, S1.stops + 1);
  const added = list.filter((r) => r.includes('➕'));
  assert.equal(added.length, 1);
  assert.ok(added[0].includes(nameOf(client)));
  assert.match(added[0], /^\S+ \*(1[2-9]|2\d):\d\d /, 'an afternoon start');
  assert.ok(contexts(view).some((c) => c.startsWith('Other crews in the zone') || c === ADD_WORDS.noOthers()));
  assert.ok(view.blocks.some((b) => b.type === 'image'), 'the day\'s map with the new stop');
  await act(ctx, 'routing-map:remove', { value: valueOf(view, 'remove') });
  await settle();
  assert.deepEqual(rows(viewOf(ctx.app)), booked);

  // No coordinate, street address or postal code in Slack or the logs.
  const out = JSON.stringify(ctx.app.views) + JSON.stringify(ctx.app.optionAcks) + JSON.stringify(ctx.log.lines);
  const secrets = await raw.run('SELECT p.street_address AS v FROM properties p UNION ALL SELECT p.postal_code FROM properties p UNION ALL SELECT CAST(p.geo_lat_e6 AS VARCHAR) FROM properties p');
  assert.deepEqual(secrets.filter((r) => holdsToken(out, r.v)), []);
});

test('through the hub: a crew lead searches and adds only on their own crew, and sees no other crew', async () => {
  // Every clients() and addStop() call the hub makes, and what it answered.
  const seen = { clients: [], addStop: [] };
  const spied = Object.freeze({
    ...MOD,
    createAdapter: (args) => {
      const a = createAdapter(args);
      return Object.freeze({
        ...a,
        clients: async (q) => { const r = await a.clients(q); seen.clients.push({ q, r }); return r; },
        addStop: async (q) => { const r = await a.addStop(q); seen.addStop.push({ q, r }); return r; },
      });
    },
  });
  const ctx = hub({ mod: spied });
  const [lz] = await raw.run('SELECT zone_id FROM crews WHERE crew_id = $c', { c: Number(LEAD_CREW) }, { declared: ['c'] });
  await ctx.app.dispatchAction(`${MOD.id}:open`, { user: LEAD, view: MENU });
  await act(ctx, 'routing-map:day', { action: { type: 'datepicker', selected_date: day } }, LEAD);
  await settle();
  // A forged crew pick names crew 4: the lead's crew comes from the scope.
  await act(ctx, 'routing-map:crew', { action: pick(CREW) }, LEAD);
  await act(ctx, 'routing-map:show', { value: 'show' }, LEAD);
  await settle();
  const view = viewOf(ctx.app);
  assert.ok(rows(view).length > 0, 'the lead\'s crew has a day');
  await act(ctx, 'routing-map:add', { value: valueOf(view, 'add') }, LEAD);
  await settle();
  await ctx.app.dispatchOptions('routing-map:client', { user: LEAD, view: fromOf(ctx), value: 'an' });
  const { options } = ctx.app.optionAcks.at(-1);
  assert.ok(options.length > 0, 'a client of the lead\'s zone is offered');
  await act(ctx, 'routing-map:client', { action: { type: 'external_select', selected_option: options[0] } }, LEAD);
  await act(ctx, 'routing-map:place', { value: valueOf(viewOf(ctx.app), 'place') }, LEAD);
  await settle();
  const after = viewOf(ctx.app);
  assert.equal(rows(after).filter((r) => r.includes('➕')).length, 1);
  assert.ok(!contexts(after).some((c) => c.startsWith('Other crews') || c === ADD_WORDS.noOthers()), 'no other crew for a lead');
  // The search listener's read: the lead's scope and crew, their zone's clients only.
  assert.ok(seen.clients.length >= 1);
  for (const { q, r } of seen.clients) {
    assert.deepEqual(q.scope, { crewId: LEAD_CREW });
    assert.equal(q.crewId, LEAD_CREW);
    for (const c of r.clients) {
      const [row] = await raw.run('SELECT cl.zone_id FROM properties p JOIN clients cl ON cl.client_id = p.client_id WHERE p.property_id = $p', { p: Number(c.node.slice(9)) }, { declared: ['p'] });
      assert.equal(row.zone_id, lz.zone_id);
    }
  }
  // Add's read: the lead's crew alone.
  assert.equal(seen.addStop.length, 1);
  const [{ q, r }] = seen.addStop;
  assert.deepEqual(q.scope, { crewId: LEAD_CREW });
  assert.deepEqual(r.input.crews.map((c) => c.crewId), [LEAD_CREW]);
  assert.deepEqual([...new Set(r.input.stops.map((s) => s.currentCrewId))], [LEAD_CREW]);
  // No other crew of the zone is named anywhere the lead was shown.
  const others = await raw.run('SELECT name FROM crews WHERE zone_id = $z AND crew_id <> $c', { z: lz.zone_id, c: Number(LEAD_CREW) }, { declared: ['z', 'c'] });
  assert.ok(others.length > 0);
  const shown = JSON.stringify(ctx.app.views.map((v) => v.args.view)) + JSON.stringify(ctx.app.optionAcks);
  for (const o of others) assert.ok(!shown.includes(o.name), `${o.name} is not shown to the lead`);
});
