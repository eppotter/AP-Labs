'use strict';

// Brightside's Routing module (Story 15.5, AD-R12, AD-R16, AD-R17) on a
// temporary build of the fixture: the module as the app dir declares it (its
// manifest and its adapter) driven through the hub and the routing-map
// archetype with the fake Slack app, the real mapPoints and the real
// renderer (a spy keeps each model). Checked here: S3's day (as_of+3), the
// route change view for crew 7's zone places 5 stops in zone, recommends 1
// cross-zone and leaves 0 unplaced, matching truth route-change-s3-crosszone
// (targets.json `routing`); a crew lead sees only their crew; every view
// draws on S3's day; the labels SQL passes the guardrail, names no forbidden
// column and returns only crew name, client name and city, filtered by the
// scope; and no coordinate, street address or postal code reaches Slack or
// the logs as text. The manifest was dev-only (F12) until Story 15.6 added prod.
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
const { createRegistry } = require('../../../kit/runtime/registry');
const { registerHubs } = require('../../../kit/runtime/slack/hubs');
const { createStore } = require('../../../kit/runtime/store');
const { createMapFiles } = require('../../../kit/runtime/slack/image');
const { renderPng } = require('../../../kit/runtime/routing-map');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const { S2, S3 } = require('../fixture/lib/scenarios');
const { toDay, toIso } = require('../fixture/lib/days');

const ROOT = path.join(__dirname, '../../..');
const APP = path.join(ROOT, 'examples/brightside/app');
const MODULE_DIR = path.join(APP, 'modules/routing');
const manifest = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'manifest.json'), 'utf8'));
const { createAdapter } = require('../app/modules/routing/adapter');
const { SQL } = require('../app/routing/adapter');
const HUB = JSON.parse(fs.readFileSync(path.join(APP, 'hubs/brightside.json'), 'utf8'));
const profile = loadProfile(path.join(__dirname, 'fixtures/routing-profile.yml'));
const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/brightside/fixture/targets.json'), 'utf8')).routing;
const slackOf = (id) => ({ id: profile.users.find((u) => u.id === id).identities.slack, name: id });
const DISPATCH = slackOf('dee');
const LEAD = slackOf('lee'); // leads crew 8, in S3's zone
const LEAD_CREW = profile.routing.audience.crew_leads.find((l) => l.user === 'lee').crew_id;
const MENU = Object.freeze({ id: 'VMENU', type: 'modal', private_metadata: HUB.id });

let tmp;
let data;
let raw; // a test-only reader of the hidden columns, to scan the output for them
let asOf;
const dayOf = (offset) => toIso(toDay(asOf) + offset);

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-routing-module-')));
  const file = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: file });
  data = createData({ file, profile });
  raw = createData({ file, profile: { sql: { forbidden_columns: [] } } });
  asOf = (await data.run("SELECT value FROM fixture_meta WHERE key = 'as_of'"))[0].value;
});
after(() => {
  if (data) data.close();
  if (raw) raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// The hub with Brightside's Routing module, as the registry loads it.
function setup() {
  const app = new FakeSlackApp({ views: true });
  app.checkHashes = true;
  const log = quietLog();
  const store = createStore();
  const mapFiles = createMapFiles({
    store, client: app.client, log, sweeping: () => true, sleep: async () => {},
  });
  const models = [];
  const render = (view, model) => {
    models.push({ view, model });
    return renderPng(view, model);
  };
  const mod = Object.freeze({ ...manifest, file: 'modules/routing/manifest.json', createAdapter });
  registerHubs(app, {
    registry: createRegistry({ hubs: [HUB], modules: [mod] }), profile, env: 'dev', log, store, data, mapFiles, routingMap: { render },
  });
  return { app, log, models };
}

const lastView = (app) => app.views.at(-1).args.view;
const lines = (view) => view.blocks.filter((b) => b.type === 'section').map((b) => b.text.text).join('\n').split('\n');
// Whether text holds value as a whole token, not inside a longer run of
// letters or digits. The output carries a random session id (a UUID in
// private_metadata), and a fixture postal code such as 00012 is 5 digits: a
// plain substring check fails whenever the UUID happens to hold those digits
// (PR #239 CI). A leaked postal code or coordinate stands on its own
// ("Fernhill 00012", "postal_code":"00012"), so it still matches.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const holdsToken = (text, value) => new RegExp(`(?<![0-9A-Za-z])${escape(String(value))}(?![0-9A-Za-z])`).test(text);
const pick = (value) => ({ type: 'static_select', selected_option: { value, text: { type: 'plain_text', text: value } } });
const date = (day) => ({ type: 'datepicker', selected_date: day });

function click(ctx, actionId, action, user) {
  const v = lastView(ctx.app);
  const from = {
    id: 'V1', type: 'modal', hash: ctx.app.hashes.get('V1'), private_metadata: v.private_metadata, title: v.title,
  };
  return ctx.app.dispatchAction(actionId, { user, view: from, action });
}

async function openOn(ctx, user, day) {
  await ctx.app.dispatchAction(`${manifest.id}:open`, { user, view: MENU });
  await click(ctx, 'routing-map:day', date(day), user);
}

test('the Routing manifest is a dev and prod routing-map module whose resource is the audience\'s all_crews key (F12, Story 15.6)', () => {
  assert.deepEqual(manifest.environments, ['dev', 'prod']);
  assert.equal(manifest.archetype, 'routing-map');
  assert.equal(manifest.adapter, 'adapter.js');
  assert.equal(manifest.resource, profile.routing.audience.all_crews);
  for (const field of ['handler', 'query', 'parameters', 'scoring', 'row_id']) assert.equal(manifest[field], undefined, field);
  assert.equal(fs.existsSync(path.join(APP, 'modules/map-check')), false, 'the dev-only map-check module is removed');
});

test('the labels SQL passes the guardrail, names no forbidden column, and returns only crew name, client name and city', async () => {
  assert.deepEqual(checkSql(SQL.labels, { forbiddenColumns: profile.sql.forbidden_columns }), { ok: true });
  for (const column of profile.sql.forbidden_columns) {
    assert.ok(!SQL.labels.includes(column.split('.')[1]), `labels.sql names ${column}`);
  }
  const adapter = createAdapter({ data, routing: profile.routing });
  const day = dayOf(S3.dayOffset);
  const nodeIds = ['crew:7', 'crew:8', 'crew:9', ...S3.routes[7].map((p) => `property:${p}`)];
  const all = await adapter.labels({ day, nodeIds, scope: { all: true } });
  assert.deepEqual(Object.keys(all).sort(), [...nodeIds].sort());
  for (const [node, label] of Object.entries(all)) {
    const want = node.startsWith('crew:') ? ['crewName'] : ['city', 'clientName'];
    assert.deepEqual(Object.keys(label).sort(), want, node);
    for (const v of Object.values(label)) assert.ok(typeof v === 'string' && v.length > 0, node);
  }
  // A crew lead's labels name no other crew; places are asked by the archetype.
  const lead = await adapter.labels({ day, nodeIds, scope: { crewId: LEAD_CREW } });
  assert.deepEqual(Object.keys(lead).filter((n) => n.startsWith('crew:')), [`crew:${LEAD_CREW}`]);
});

test(`S3's day (as_of+3): the route change view for crew 7's zone places 5 in zone, recommends 1 cross-zone, leaves 0 unplaced (route-change-s3-crosszone)`, async () => {
  const ctx = setup();
  const day = dayOf(S3.dayOffset);
  const [{ zone_id: zone }] = await data.run('SELECT zone_id FROM crews WHERE crew_id = $id', { id: S3.crewId }, { declared: ['id'] });
  await openOn(ctx, DISPATCH, day);
  await click(ctx, 'routing-map:view', pick('change'), DISPATCH);
  await click(ctx, 'routing-map:zone', pick(String(zone)), DISPATCH);
  const { view, model } = ctx.models.at(-1);
  assert.equal(view, 'change');
  assert.deepEqual(model.crews.slice(0, 3).map((c) => c.crewId), S3.zoneCrews.map(String));
  assert.deepEqual({
    in_zone: model.moved.length,
    cross_zone: model.crossZone.length,
    unplaced: model.unplaced.length,
  }, TARGETS['route-change-s3-crosszone']);
  assert.deepEqual(model.crossZone.map((z) => z.node), [`property:${S3.orphanMorning}`]);
  const text = lines(lastView(ctx.app));
  assert.match(text[0], new RegExp(`^\\*Route change: Zone ${zone}, `));
  assert.equal(text.filter((l) => l.startsWith('Recommended for another zone, not placed:')).length, 1);
  assert.equal(text.filter((l) => l.startsWith('To rebook:')).length, 0);
  assert.ok(text.some((l) => l.startsWith('Not working: ')), 'names the crew that is out');
  const image = lastView(ctx.app).blocks.find((b) => b.type === 'image');
  assert.match(image.alt_text, /^Route map: Route change, Zone /);
});

test('the leak check finds a postal code or coordinate standing alone, and not inside a random session id', () => {
  for (const leak of ['Fernhill 00012', '{"postal_code":"00012"}', '00012', '(00012)', '"lat":39961234']) {
    assert.ok(holdsToken(leak, leak.includes('3996') ? 39961234 : '00012'), leak);
  }
  assert.ok(holdsToken('"lon":-82998123,', -82998123));
  for (const id of ['ad48dfbe-8157-41ee-9662-2700012e0b1b', '"private_metadata":"a00012b"', '100012', '000123', 'x39961234']) {
    assert.ok(!holdsToken(id, id.includes('3996') ? 39961234 : '00012'), id);
  }
  assert.ok(holdsToken('at 12 Oak St, Fernhill', '12 Oak St'));
});

test('a dispatcher draws all four views on S3\'s day; nothing shows a coordinate, street address or postal code as text', async () => {
  const ctx = setup();
  await openOn(ctx, DISPATCH, dayOf(S3.dayOffset));
  const drawn = [];
  for (const v of ['zone', 'gap', 'change', 'compare']) {
    const before = ctx.models.length;
    await click(ctx, 'routing-map:view', pick(v), DISPATCH);
    if (ctx.models.length > before) drawn.push(ctx.models.at(-1).view);
    else drawn.push(`${v}: ${lines(lastView(ctx.app))[0]}`);
  }
  // The first crew has no cancelled visit on S3's day, so gap says so in
  // plain words (S2's gap is the next test); the other three draw a map.
  assert.deepEqual(drawn.map((d) => d.replace(/ on .*$/, '')), ['zone', 'gap: No visit was cancelled', 'change', 'compare']);
  assert.ok(!ctx.log.lines.some((l) => /not drawn|not shown|refused/.test(l.msg)), JSON.stringify(ctx.log.lines.filter((l) => l.level !== 'info')));
  const said = JSON.stringify([ctx.app.views, ctx.log.lines, ctx.app.responded || []]);
  const props = await raw.run('SELECT street_address, postal_code, geo_lat_e6, geo_lon_e6 FROM properties');
  const bases = await raw.run('SELECT base_geo_lat_e6 AS geo_lat_e6, base_geo_lon_e6 AS geo_lon_e6 FROM crews');
  for (const p of props) {
    assert.ok(!holdsToken(said, p.street_address), `a street address reached Slack or the logs: ${p.street_address}`);
    assert.ok(!holdsToken(said, p.postal_code), `a postal code reached Slack or the logs: ${p.postal_code}`);
  }
  for (const p of [...props, ...bases]) {
    assert.ok(!holdsToken(said, p.geo_lat_e6) && !holdsToken(said, p.geo_lon_e6), 'a coordinate reached Slack or the logs');
  }
  assert.ok(!/"x"\s*:|"y"\s*:/.test(said), 'a pixel position reached Slack or the logs');
});

test('S2\'s day (as_of+2): a dispatcher\'s gap view for crew 2 ranks the two valid fills, the best first (route-change-s2-top, -count)', async () => {
  const ctx = setup();
  await openOn(ctx, DISPATCH, dayOf(S2.dayOffset));
  await click(ctx, 'routing-map:view', pick('gap'), DISPATCH);
  await click(ctx, 'routing-map:crew', pick(String(S2.crewId)), DISPATCH);
  const { view, model } = ctx.models.at(-1);
  assert.equal(view, 'gap');
  assert.equal(model.gap.crewId, String(S2.crewId));
  assert.equal(model.candidates.length, TARGETS['route-change-s2-count']);
  assert.deepEqual(model.candidates.map((c) => c.node), [`property:${TARGETS['route-change-s2-top']}`, `property:${S2.runnerUp}`]);
  assert.deepEqual(model.candidates.map((c) => c.rank), [1, 2]);
});

test(`a crew lead (crew ${LEAD_CREW}) sees only their crew on S3's day, in every view`, async () => {
  const ctx = setup();
  await openOn(ctx, LEAD, dayOf(S3.dayOffset));
  for (const v of ['zone', 'gap', 'change']) await click(ctx, 'routing-map:view', pick(v), LEAD);
  const [{ name: own }] = await raw.run('SELECT name FROM crews WHERE crew_id = $id', { id: Number(LEAD_CREW) }, { declared: ['id'] });
  const others = (await raw.run('SELECT name FROM crews WHERE crew_id <> $id', { id: Number(LEAD_CREW) }, { declared: ['id'] })).map((r) => r.name);
  assert.ok(ctx.models.length >= 3, 'compare, zone and change draw a map');
  for (const { view, model } of ctx.models) {
    assert.deepEqual(model.crews.map((c) => c.crewId), [LEAD_CREW], view);
  }
  const shown = ctx.app.views.filter((x) => x.method === 'update').map((x) => x.args.view).filter((v) => lines(v).join('\n').includes(own));
  assert.ok(shown.length >= 4, 'every view names the lead\'s own crew');
  for (const v of shown) {
    const text = lines(v).join('\n');
    for (const name of others) assert.ok(!text.includes(name), `the lead's view names ${name}`);
    const select = v.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'routing-map:crew');
    assert.deepEqual(select.options.map((o) => o.value), [LEAD_CREW]);
  }
});
