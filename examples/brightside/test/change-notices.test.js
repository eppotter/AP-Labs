'use strict';

// Story 20.3 (plan brightside-v1, D14, D14a, GRD-010): change notices from a
// route skill on /brightside. A route skill's result shows "Notify affected
// customers (N)" to a dispatcher granted APPOINTMENT_EMAILS by name (Ely and
// Steven, equally) when it changes N > 0 booked visits; the click puts the
// changed visits in a route record bound to the person and the route
// session; a view pushed on the route shows the Change notices preview, each
// email's exact text; Approve sends exactly those through the mock email
// tool, keyed by the change.
//
// The planted scenarios (fixture/lib/scenarios.js, as_of 2026-09-30):
//   S1  Plan a route, crew 4 on 2026-10-01, Optimize: visits 2, 27 and 38
//       change window ("we've improved the day's route").
//   S2  Customer cancellation, crew 2 on 2026-10-02, the cancelled afternoon
//       visit, Fill with #1: property 762's visit moves up from 2026-10-05
//       ("an earlier slot opened up").
//   S3  Crew out, crew 7 on 2026-10-03: the 5 visits placed on crews 8 and 9
//       change crew ("our team for that day is unavailable"); the 1
//       recommended for another zone is listed, not emailed.
//
// Ways out, each tested: Back to the route, Cancel, the record expired (and
// the route session expired), nothing changed (no button), and the
// approval-write ways out (an expired preview, Approve twice). Also: a forged
// click can't name other visits; the before values come from scheduled_visits
// with status 'scheduled'; a move within the window is not a change and a
// crew change is; the reason line matches the skill; a second, different
// change to a visit is a new email.
//
// The clock is frozen (Date: the store, the routing sessions, the run date
// and the email tool's day all read it). An example test: it reads
// Brightside's app dir, fixture data and mock email tool, and is deleted
// with the example in a fork. Its profile and Slack ids come from a test
// fixture (fixtures/change-notices-profile.yml), never profiles/brightside/.

const test = require('node:test');
const { before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { loadRegistry } = require('../../../kit/runtime/registry');
const { createData } = require('../../../kit/runtime/data');
const { registerHubs } = require('../../../kit/runtime/slack/hubs');
const { createStore } = require('../../../kit/runtime/store');
const { createMapFiles } = require('../../../kit/runtime/slack/image');
const { NOTICE_WORDS, MAP_WORDS } = require('../../../kit/runtime/messages');
const {
  createApprovalWrite, createConnectors, routeSource, sendItems,
} = require('../../../kit/runtime/archetypes/approval-write');
const { testLog } = require('../../../kit/runtime/sdk');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const templates = require('../app/connectors/email/templates');
const { S2, S3 } = require('../fixture/lib/scenarios');

const ROOT = path.join(__dirname, '../../..');
const APP = path.join(ROOT, 'examples/brightside/app');
const profile = loadProfile(path.join(__dirname, 'fixtures/change-notices-profile.yml'));
const { registry, problems } = loadRegistry({ appDir: APP, profile });
const NOTICES = registry.module('change-notices');
const slackOf = (id) => ({ id: profile.users.find((u) => u.id === id).identities.slack, name: id });
const ELY = slackOf('ely');
const STEVEN = slackOf('steven');
const DEE = slackOf('dee');
const LEE = slackOf('lee');
const MENU = Object.freeze({ id: 'VMENU', type: 'modal', private_metadata: 'brightside', title: { type: 'plain_text', text: 'Brightside' } });

const NOW = Date.parse('2026-11-01T15:00:00Z');
const LIST = 'change-notices-2026-11-01';
const S1 = Object.freeze({ crewId: '4', day: '2026-10-01', changed: ['2', '27', '38'] });

let tmp;
let data;
let raw;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-change-notices-')));
  const file = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: file });
  data = createData({ file, profile });
  raw = createData({ file, profile: { sql: { forbidden_columns: [] } } });
});
after(() => {
  if (data) data.close();
  if (raw) raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: NOW }));
test.afterEach(() => mock.timers.reset());

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

let seq = 0;
// The /brightside hub on the fixture build, with its own store, outbox and
// email connector (the app's, as boot makes it).
function hub() {
  seq += 1;
  const varDir = path.join(tmp, `var-${seq}`);
  const app = new FakeSlackApp({ views: true });
  app.checkHashes = true;
  const log = quietLog();
  const store = createStore();
  const mapFiles = createMapFiles({
    store, client: app.client, log, sweeping: () => true, sleep: async () => {},
  });
  const connectors = createConnectors({
    appDir: APP, modules: registry.modules, log: testLog(), env: { APLABS_VAR_DIR: varDir },
  });
  registerHubs(app, {
    registry, profile, env: 'dev', log, store, data, mapFiles, connectors, routingMap: { editor: { mapDelayMs: 0 } },
  });
  return {
    app, log, store, outbox: path.join(varDir, 'outbox', 'email.jsonl'),
  };
}

const settle = async (n = 40) => { for (let i = 0; i < n; i += 1) await new Promise((r) => { setImmediate(r); }); };
const pick = (value) => ({ type: 'static_select', selected_option: { value, text: { type: 'plain_text', text: value } } });
const elementsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const textOf = (view) => view.blocks.map((b) => (b.text && b.text.text) || (b.fields || []).map((f) => f.text).join(' ')
  || (b.elements || []).map((e) => (e.text && (e.text.text || e.text)) || '').join(' ')).join('\n');
const notifyOf = (view) => elementsOf(view).find((e) => e.action_id === 'routing-map:notify') || null;

// A view's latest content: its latest update, else the push that made it
// (the fake names each accepted views call's view V<n>, in call order; every
// call in these tests is accepted).
function contentOf(app, id) {
  const update = app.views.filter((v) => v.method === 'update' && v.args.view_id === id).at(-1);
  if (update) return update.args.view;
  const made = app.views.find((v, i) => v.method !== 'update' && `V${i + 1}` === id);
  return made ? made.args.view : null;
}
// The views pushed on view id, oldest first.
const pushedOn = (app, id) => [...app.parents].filter(([, parent]) => parent === id).map(([child]) => child);

// Opens a route skill from the menu as user: ctx.map is its view.
async function open(ctx, moduleId, user) {
  await ctx.app.dispatchAction(`${moduleId}:open`, { user, view: MENU });
  await settle();
  [ctx.map] = pushedOn(ctx.app, MENU.id).slice(-1);
  ctx.user = user;
}
const mapView = (ctx) => contentOf(ctx.app, ctx.map);
// A click on the route's view.
async function act(ctx, actionId, payload, user = ctx.user) {
  const v = mapView(ctx);
  const from = {
    id: ctx.map, type: 'modal', hash: ctx.app.hashes.get(ctx.map), private_metadata: v.private_metadata, title: v.title,
  };
  await ctx.app.dispatchAction(actionId, { user, view: from, ...payload });
  await settle();
}
const press = (ctx, button, user) => act(ctx, button.action_id, { value: button.value }, user);
const buttonOf = (ctx, actionId) => elementsOf(mapView(ctx)).find((e) => e.action_id === actionId);

// Notify affected customers: returns the notices view's id and content.
async function notify(ctx, user = ctx.user, button = notifyOf(mapView(ctx))) {
  const before = pushedOn(ctx.app, ctx.map).length;
  await press(ctx, button, user);
  const pushed = pushedOn(ctx.app, ctx.map);
  if (pushed.length === before) return null;
  const id = pushed.at(-1);
  return { id, view: contentOf(ctx.app, id) };
}
// A click in the notices view.
async function inNotices(ctx, notices, actionId, value, user = ctx.user) {
  const v = contentOf(ctx.app, notices.id);
  await ctx.app.dispatchAction(actionId, {
    user, view: { id: notices.id, hash: ctx.app.hashes.get(notices.id), title: v.title, private_metadata: v.private_metadata }, value,
  });
  await settle();
  return contentOf(ctx.app, notices.id);
}
const approveOf = (view) => elementsOf(view).find((e) => e.action_id === 'approval-write:approve');

function emails(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'email');
}
// Each email the preview shows, exactly: "Subject: …\n\n<body>".
const previewTexts = (view) => view.blocks.filter((b) => b.type === 'section' && /exactly as it will be sent/.test(b.text.text))
  .map((b) => b.text.text.split('```\n')[1].replace(/\n```$/, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

// --- the scenarios ------------------------------------------------------------------

// S1: Plan a route, crew 4 on its zig-zag day, as user; returns after Optimize.
async function s1(ctx, user = ELY) {
  await open(ctx, 'route-planner', user);
  await act(ctx, 'routing-map:day', { action: { type: 'datepicker', selected_date: S1.day } });
  await act(ctx, 'routing-map:crew', { action: pick(S1.crewId) });
  await act(ctx, 'routing-map:show', { value: 'show' });
}

test('the module loads: route-sourced, gated by APPOINTMENT_EMAILS (by name, Ely and Steven alike), dev only, its one input bound by the engine', () => {
  assert.deepEqual(problems, []);
  assert.equal(NOTICES.write.source, 'route');
  assert.equal(NOTICES.resource, 'APPOINTMENT_EMAILS');
  assert.equal(profile.resources.find((r) => r.key === 'APPOINTMENT_EMAILS').admin_grantable, false);
  assert.deepEqual(NOTICES.environments, ['dev']);
  assert.deepEqual(NOTICES.parameters.map((p) => p.name), ['visit_ids']);
  for (const id of ['route-cancellation', 'route-crew-out', 'route-add-stop']) {
    const mod = registry.module(id);
    assert.equal(mod.hub, 'brightside', id);
    assert.deepEqual(mod.environments, ['dev'], `${id} is dev only (gate item 5)`);
    assert.equal(mod.screen, registry.module(`v1-${id}`).screen, `${id} copies the v1 skill`);
  }
  // The one named query, with its grain comment, binding $visit_ids as one string.
  const sql = fs.readFileSync(path.join(APP, 'modules/change-notices/change-notices.sql'), 'utf8');
  assert.match(sql, /^-- Grain: one row per scheduled visit/m);
  assert.match(sql, /string_split\(\$visit_ids, ','\)/);
  assert.match(sql, /sv\.status = 'scheduled'/);
});

test('S1: Plan a route, crew 4, Optimize: no button as booked; then "Notify affected customers (3)", and the preview holds exactly visits 2, 27 and 38, each email\'s exact text', async () => {
  const ctx = hub();
  await s1(ctx);
  assert.equal(notifyOf(mapView(ctx)), null, 'nothing changed: no button');
  await press(ctx, buttonOf(ctx, 'routing-map:optimize'));
  const button = notifyOf(mapView(ctx));
  assert.equal(button.text.text, 'Notify affected customers (3)');
  const notices = await notify(ctx);
  assert.equal(notices.view.close.text, 'Back', 'Back returns to the route');
  const text = textOf(notices.view);
  assert.ok(text.includes(NOTICE_WORDS.caveat()), 'the suggestions caveat');
  assert.match(text, /\*Rows to send:\* 3 of 3 rows/);
  const texts = previewTexts(notices.view);
  assert.equal(texts.length, 3);
  for (const t of texts) assert.ok(t.includes("Why: we've improved the day's route."), 'the Plan a route reason line');
  await inNotices(ctx, notices, 'approval-write:approve', approveOf(notices.view).value);
  const sent = emails(ctx.outbox);
  assert.deepEqual(sent.map((e) => e.payload.external_ref).sort(), S1.changed.slice().sort());
  assert.deepEqual(sent.map((e) => `Subject: ${e.payload.subject}\n\n${e.payload.body}`), texts, 'the preview is exactly what was sent');
  assert.ok(sent.every((e) => e.payload.kind === 'change' && e.payload.push === LIST));
});

test('S1: Steven has the same button and preview as Ely (never Ely only)', async () => {
  const ctx = hub();
  await s1(ctx, STEVEN);
  await press(ctx, buttonOf(ctx, 'routing-map:optimize'));
  const notices = await notify(ctx);
  assert.equal(previewTexts(notices.view).length, 3);
});

test('S2: Customer cancellation, crew 2, the cancelled afternoon visit, Fill with #1: one notice, property 762\'s visit moved up from Monday, October 5', async () => {
  const ctx = hub();
  await open(ctx, 'route-cancellation', ELY);
  await act(ctx, 'routing-map:crew', { action: pick(String(S2.crewId)) });
  await act(ctx, 'routing-map:day', { action: { type: 'datepicker', selected_date: '2026-10-02' } });
  await act(ctx, 'routing-map:show', { value: 'show' });
  const select = elementsOf(mapView(ctx)).find((e) => e.action_id === 'routing-map:visit');
  const option = select.options.find((o) => o.text.text.endsWith('(cancelled)'));
  await act(ctx, 'routing-map:visit', { action: { type: 'static_select', selected_option: option } });
  assert.equal(notifyOf(mapView(ctx)), null, 'the gap view changes nothing yet');
  const fill = elementsOf(mapView(ctx)).find((e) => e.action_id === 'routing-map:fill-1');
  await press(ctx, fill);
  assert.equal(notifyOf(mapView(ctx)).text.text, 'Notify affected customers (1)');
  const notices = await notify(ctx);
  const [{ id }] = await raw.run("SELECT scheduled_visit_id AS id FROM scheduled_visits WHERE property_id = $p AND visit_date = DATE '2026-10-05' AND status = 'scheduled'",
    { p: S2.bestFill }, { declared: ['p'] });
  const [only] = previewTexts(notices.view);
  assert.match(only, /- Day: Friday, October 2, 2026 \(before: Monday, October 5, 2026\)/);
  assert.match(only, /Why: an earlier slot opened up\./);
  await inNotices(ctx, notices, 'approval-write:approve', approveOf(notices.view).value);
  assert.deepEqual(emails(ctx.outbox).map((e) => e.payload.external_ref), [String(id)]);
});

test('S3: Crew out, crew 7: 5 notices for the visits placed on crews 8 and 9 (a crew change), the cross-zone one listed and never emailed', async () => {
  const ctx = hub();
  await open(ctx, 'route-crew-out', ELY);
  await act(ctx, 'routing-map:day', { action: { type: 'datepicker', selected_date: '2026-10-03' } });
  await act(ctx, 'routing-map:crew', { action: pick(String(S3.crewId)) });
  await act(ctx, 'routing-map:out', { value: 'out' });
  assert.equal(notifyOf(mapView(ctx)).text.text, 'Notify affected customers (5)');
  const notices = await notify(ctx);
  const text = textOf(notices.view);
  assert.match(text, /\*Rows to send:\* 5 of 6 rows/);
  assert.match(text, /\*Held, not sent: 1\.\*/);
  assert.ok(text.includes(NOTICE_WORDS.crossZone()), 'the cross-zone visit is listed with why');
  const texts = previewTexts(notices.view);
  assert.equal(texts.length, 5);
  for (const t of texts) {
    assert.match(t, /- Crew: (East|[A-Z][a-z]+) crew [BC] \(before: [A-Za-z]+ crew A\)/, 'a crew change is a change');
    assert.ok(t.includes('Why: our team for that day is unavailable.'));
  }
  await inNotices(ctx, notices, 'approval-write:approve', approveOf(notices.view).value);
  const sent = emails(ctx.outbox).map((e) => Number(e.payload.external_ref)).sort((a, b) => a - b);
  const moved = await raw.run("SELECT scheduled_visit_id AS id FROM scheduled_visits WHERE crew_id = 7 AND visit_date = DATE '2026-10-03' AND status = 'scheduled' ORDER BY 1");
  assert.equal(moved.length, 6);
  assert.equal(sent.length, 5);
  assert.ok(sent.every((id) => moved.some((m) => m.id === id)), 'only crew 7\'s visits');
});

// --- who sees the button, and forged clicks -----------------------------------------

test('no button for a dispatcher without APPOINTMENT_EMAILS, nor for a crew lead who has it; their forged Notify clicks send nothing', async () => {
  const dee = hub();
  await s1(dee, DEE);
  await press(dee, buttonOf(dee, 'routing-map:optimize'));
  assert.equal(notifyOf(mapView(dee)), null);
  const version = buttonOf(dee, 'routing-map:optimize').value.split(':')[0];
  const refused = await notify(dee, DEE, { action_id: 'routing-map:notify', value: `${version}:notify` });
  assert.ok(refused, 'the hub answers in a pushed view');
  assert.match(textOf(contentOf(dee.app, refused.id)), /Change notices/, 'the access refusal names the tool');
  assert.equal(approveOf(contentOf(dee.app, refused.id)), undefined);

  const lee = hub();
  await open(lee, 'route-planner', LEE);
  await act(lee, 'routing-map:day', { action: { type: 'datepicker', selected_date: '2026-10-03' } });
  await act(lee, 'routing-map:show', { value: 'show' });
  await press(lee, buttonOf(lee, 'routing-map:optimize'));
  assert.equal(notifyOf(mapView(lee)), null, 'a crew lead sees one crew, never the whole change');
  const v = buttonOf(lee, 'routing-map:optimize').value.split(':')[0];
  assert.equal(await notify(lee, LEE, { action_id: 'routing-map:notify', value: `${v}:notify` }), null);
  assert.deepEqual(emails(dee.outbox).concat(emails(lee.outbox)), []);
});

test('a forged click can\'t name other visits: the click carries only "<version>:notify"; ids in it, a stale version or someone else\'s click change nothing, and the preview holds only the session\'s changes', async () => {
  const ctx = hub();
  await s1(ctx);
  await press(ctx, buttonOf(ctx, 'routing-map:optimize'));
  const real = notifyOf(mapView(ctx));
  for (const value of ['1,2,3:notify', '2,27,38', `${real.value},999`, '1:notify', 'notify']) {
    assert.equal(await notify(ctx, ELY, { action_id: 'routing-map:notify', value }), null, value);
  }
  // Someone else on Ely's route view: refused, nothing pushed.
  assert.equal(await notify(ctx, STEVEN, real), null);
  // Ids smuggled beside a good value are never read.
  await act(ctx, 'routing-map:notify', { action: { type: 'button', value: real.value, selected_option: { value: '1,5,9' }, visit_ids: '1,5,9' } });
  const [id] = pushedOn(ctx.app, ctx.map).slice(-1);
  const view = contentOf(ctx.app, id);
  await inNotices(ctx, { id }, 'approval-write:approve', approveOf(view).value);
  assert.deepEqual(emails(ctx.outbox).map((e) => e.payload.external_ref).sort(), S1.changed.slice().sort());
});

// --- ways out ------------------------------------------------------------------------

test('way out, Back to the route: the preview is pushed on the route with Back, and the route under it is untouched and still answers', async () => {
  const ctx = hub();
  await s1(ctx);
  await press(ctx, buttonOf(ctx, 'routing-map:optimize'));
  const before = ctx.app.views.length;
  const notices = await notify(ctx);
  const calls = ctx.app.views.slice(before);
  assert.ok(calls.every((c) => c.method === 'push' || c.args.view_id === notices.id), 'nothing updated the route view');
  assert.equal(ctx.app.parentOf(notices.id), ctx.map, 'Slack\'s Back returns to the route');
  assert.equal(notices.view.close.text, 'Back');
  assert.ok(textOf(notices.view).includes(NOTICE_WORDS.back()));
  // Back: the route is still live; Reset to booked answers and the button goes.
  await press(ctx, buttonOf(ctx, 'routing-map:reset'));
  assert.equal(notifyOf(mapView(ctx)), null, 'nothing changed: no button');
});

test('way out, Cancel: nothing is sent, the view says so and how to get back to the route; Approve after it is no longer valid', async () => {
  const ctx = hub();
  await s1(ctx);
  await press(ctx, buttonOf(ctx, 'routing-map:optimize'));
  const notices = await notify(ctx);
  const token = approveOf(notices.view).value;
  const cancelled = await inNotices(ctx, notices, 'approval-write:cancel', token);
  assert.equal(textOf(cancelled), NOTICE_WORDS.cancelled('email tool'));
  const again = await inNotices(ctx, notices, 'approval-write:approve', token);
  assert.match(textOf(again), /no longer valid/);
  assert.deepEqual(emails(ctx.outbox), []);
});

test('way out, the record expired: a route record past 30 minutes previews nothing and says so; a route session past 15 minutes says it expired', async () => {
  const ctx = hub();
  await s1(ctx);
  await press(ctx, buttonOf(ctx, 'routing-map:optimize'));
  const button = notifyOf(mapView(ctx));
  mock.timers.tick(15 * 60 * 1000 + 1);
  const before = ctx.app.views.length;
  await press(ctx, button);
  assert.equal(pushedOn(ctx.app, ctx.map).length, 0, 'no preview');
  assert.equal(textOf(ctx.app.views.slice(before).at(-1).args.view), MAP_WORDS.expired('Plan a route'));

  // The route record itself: bound for 30 minutes, then gone.
  const store = createStore();
  const shown = [];
  const writes = createApprovalWrite({ store, log: quietLog(), connectors: createConnectors({ appDir: APP, modules: [NOTICES], log: testLog(), env: { APLABS_VAR_DIR: path.join(tmp, 'var-expired') } }) });
  const token = routeSource.put(store, {
    person: ELY.id, session: 'S', module: NOTICES.id, skill: 'route-editor', visits: [routeVisit('2', { window: 'afternoon' })],
  });
  mock.timers.tick(30 * 60 * 1000);
  await writes.previewRoute({
    token, person: ELY.id, session: 'S', resolve: () => ({ mod: NOTICES }), show: async (m) => { shown.push(m); }, data,
  });
  assert.deepEqual(shown, [{ text: NOTICE_WORDS.expired() }]);
});

test('way out, nothing changed: no button as booked, nor after Optimize then Reset; a forged Notify on the unchanged day pushes nothing', async () => {
  const ctx = hub();
  await s1(ctx);
  assert.equal(notifyOf(mapView(ctx)), null);
  await press(ctx, buttonOf(ctx, 'routing-map:optimize'));
  assert.ok(notifyOf(mapView(ctx)));
  await press(ctx, buttonOf(ctx, 'routing-map:reset'));
  assert.equal(notifyOf(mapView(ctx)), null);
  // A forged Notify on the unchanged day: refused, nothing pushed.
  const v = buttonOf(ctx, 'routing-map:optimize').value.split(':')[0];
  assert.equal(await notify(ctx, ELY, { action_id: 'routing-map:notify', value: `${v}:notify` }), null);
});

test('the approval-write ways out: Approve twice sends once ("already done"); a preview past 30 minutes is no longer valid', async () => {
  const ctx = hub();
  await s1(ctx);
  await press(ctx, buttonOf(ctx, 'routing-map:optimize'));
  const notices = await notify(ctx);
  const token = approveOf(notices.view).value;
  await inNotices(ctx, notices, 'approval-write:approve', token);
  const twice = await inNotices(ctx, notices, 'approval-write:approve', token);
  assert.match(textOf(twice), /already/i);
  assert.equal(emails(ctx.outbox).length, 3);

  const late = hub();
  await s1(late);
  await press(late, buttonOf(late, 'routing-map:optimize'));
  const stale = await notify(late);
  mock.timers.tick(30 * 60 * 1000);
  const expired = await inNotices(late, stale, 'approval-write:approve', approveOf(stale.view).value);
  assert.match(textOf(expired), /no longer valid/);
  assert.deepEqual(emails(late.outbox), []);
});

test('from the menu, Change notices opens no form: it says where change notices start', async () => {
  const ctx = hub();
  await ctx.app.dispatchAction('change-notices:open', { user: ELY, view: MENU });
  assert.equal(textOf(ctx.app.views.at(-1).args.view), NOTICE_WORDS.fromMenu());
  assert.ok(!ctx.app.views.some((v) => JSON.stringify(v.args.view || {}).includes('sp-input:visit_ids')), 'never a visit_ids box');
});

// --- the route record, the booking and the email (the archetype directly) ----------

// A visit as the route session gives it: booked on crew 4 in the morning of
// its own day unless said otherwise.
function routeVisit(id, after = {}, beforeValues = {}) {
  return {
    id,
    before: {
      date: '2026-10-01', window: 'morning', crewId: '4', ...beforeValues,
    },
    after: {
      date: '2026-10-01', window: 'morning', crewId: '4', crewName: 'South crew A', ...after,
    },
  };
}

// The archetype with Brightside's email tool on its own outbox, previewing a
// route record as Ely on route session S; approve() sends it.
function direct() {
  seq += 1;
  const varDir = path.join(tmp, `direct-${seq}`);
  const store = createStore();
  const writes = createApprovalWrite({
    store, log: quietLog(), connectors: createConnectors({ appDir: APP, modules: [NOTICES], log: testLog(), env: { APLABS_VAR_DIR: varDir } }),
  });
  const shown = [];
  const show = async (m) => { shown.push(m); };
  const resolve = () => ({ mod: NOTICES });
  return {
    shown,
    outbox: path.join(varDir, 'outbox', 'email.jsonl'),
    async preview(skill, visits, held = []) {
      const token = routeSource.put(store, {
        person: ELY.id, session: 'S', module: NOTICES.id, skill, visits, held,
      });
      await writes.previewRoute({
        token, person: ELY.id, session: 'S', resolve, show, data,
      });
      return shown.at(-1);
    },
    async approve(view) {
      await writes.click({
        verb: 'approve', value: approveOf(view).value, person: ELY.id, resolve, show,
      });
      return shown.at(-1);
    },
  };
}

test('before values come from scheduled_visits with status \'scheduled\': a cancelled visit is listed as no longer booked, never emailed; the booked crew and window are the email\'s "before"', async () => {
  const [booked] = await raw.run("SELECT scheduled_visit_id AS id, arrival_window AS w, crew_id AS c FROM scheduled_visits WHERE visit_date = DATE '2026-10-01' AND crew_id = 4 AND status = 'scheduled' ORDER BY scheduled_visit_id LIMIT 1");
  const [{ name: crewName }] = await raw.run('SELECT name FROM crews WHERE crew_id = 4');
  const d = direct();
  const flip = booked.w === 'morning' ? 'afternoon' : 'morning';
  // The route session claims the visit was booked on another crew in the
  // other window: the booking, not the session, gives the before values.
  const view = await d.preview('route-editor', [
    routeVisit(String(booked.id), { window: flip }, { window: flip, crewId: '9' }),
    routeVisit(String(S2.cancelled), { window: 'afternoon' }),
  ]);
  const text = textOf(view);
  assert.ok(text.includes(NOTICE_WORDS.notBooked()), 'the cancelled visit is listed');
  const [only] = previewTexts(view);
  assert.ok(only.includes(`- Arrival window: ${flip} (before: ${booked.w})`), only);
  assert.ok(!only.includes('- Crew:'), 'the booking already has this crew');
  await d.approve(view);
  assert.deepEqual(emails(d.outbox).map((e) => e.payload.external_ref), [String(booked.id)]);
  assert.ok(emails(d.outbox)[0].payload.body.includes(`with ${crewName}`));
});

test('a move within the window is not a change (listed, not emailed); a crew change is', async () => {
  const [a, b] = await raw.run("SELECT scheduled_visit_id AS id, arrival_window AS w FROM scheduled_visits WHERE visit_date = DATE '2026-10-01' AND crew_id = 4 AND status = 'scheduled' ORDER BY scheduled_visit_id LIMIT 2");
  const [{ name: other }] = await raw.run('SELECT name FROM crews WHERE crew_id = 5');
  const d = direct();
  const view = await d.preview('route-editor', [
    routeVisit(String(a.id), { window: a.w }),
    routeVisit(String(b.id), { window: b.w, crewId: '5', crewName: other }),
  ]);
  assert.ok(textOf(view).includes(NOTICE_WORDS.notChanged()));
  const [only] = previewTexts(view);
  assert.ok(only.includes(`- Crew: ${other} (before: `), only);
  await d.approve(view);
  assert.deepEqual(emails(d.outbox).map((e) => e.payload.external_ref), [String(b.id)]);
});

test('a crew-out stop to rebook is listed, not emailed: the email tool gets only the visit that moved; all held means nothing to approve', async () => {
  const [a, b] = await raw.run("SELECT scheduled_visit_id AS id, arrival_window AS w FROM scheduled_visits WHERE visit_date = DATE '2026-10-03' AND crew_id = 7 AND status = 'scheduled' ORDER BY scheduled_visit_id LIMIT 2");
  const [{ name: crew8 }] = await raw.run('SELECT name FROM crews WHERE crew_id = 8');
  const moved = routeVisit(String(a.id), {
    date: '2026-10-03', window: a.w, crewId: '8', crewName: crew8,
  }, { date: '2026-10-03', window: a.w, crewId: '7' });
  const d = direct();
  const view = await d.preview('crew-out', [moved], [{ id: String(b.id), reason: 'rebook' }]);
  assert.ok(textOf(view).includes(NOTICE_WORDS.rebook()), 'the stop to rebook is listed with why');
  assert.equal(previewTexts(view).length, 1);
  await d.approve(view);
  assert.deepEqual(emails(d.outbox).map((e) => e.payload.external_ref), [String(a.id)]);
  // Held only: listed, nothing to approve, nothing sent.
  const only = direct();
  const none = await only.preview('crew-out', [], [{ id: String(b.id), reason: 'rebook' }]);
  assert.ok(textOf(none).includes(NOTICE_WORDS.rebook()));
  assert.equal(approveOf(none), undefined, 'nothing to approve');
  assert.deepEqual(emails(only.outbox), []);
});

test('the reason line matches the skill, for each of the four route skills; an added stop is never a visit', async () => {
  const lines = {
    'route-editor': "we've improved the day's route",
    cancellation: 'an earlier slot opened up',
    'crew-out': 'our team for that day is unavailable',
    'add-stop': "we've adjusted the day's schedule",
  };
  assert.deepEqual(routeSource.SKILLS.slice().sort(), Object.keys(lines).sort());
  const [v] = await raw.run("SELECT scheduled_visit_id AS id, arrival_window AS w FROM scheduled_visits WHERE visit_date = DATE '2026-10-01' AND crew_id = 4 AND status = 'scheduled' ORDER BY scheduled_visit_id LIMIT 1");
  const flip = v.w === 'morning' ? 'afternoon' : 'morning';
  for (const [skill, line] of Object.entries(lines)) {
    const d = direct();
    const [text] = previewTexts(await d.preview(skill, [routeVisit(String(v.id), { window: flip })]));
    assert.ok(text.endsWith(`Why: ${line}.\n\nSorry for the change.\n\nReply to this email, or call us on 555-0100, and we'll find a time that suits you.\n\nThe Brightside Home Cleaning team`), skill);
    assert.equal(templates.REASONS[skill], line);
  }
  // Add a stop's own stop ("add-<property>") can never be put in a record.
  assert.throws(() => routeSource.put(createStore(), {
    person: ELY.id, session: 'S', module: NOTICES.id, skill: 'add-stop', visits: [routeVisit('add-762')],
  }), routeSource.RouteRecordError);
});

test('the push key covers the change: the same change again sends nothing new; a second, different change to the same visit is a new email', async () => {
  const [v] = await raw.run("SELECT scheduled_visit_id AS id, arrival_window AS w FROM scheduled_visits WHERE visit_date = DATE '2026-10-01' AND crew_id = 4 AND status = 'scheduled' ORDER BY scheduled_visit_id LIMIT 1");
  const [{ name: other }] = await raw.run('SELECT name FROM crews WHERE crew_id = 5');
  const flip = v.w === 'morning' ? 'afternoon' : 'morning';
  const d = direct();
  const first = await d.preview('route-editor', [routeVisit(String(v.id), { window: flip })]);
  assert.match((await d.approve(first)).blocks[0].text.text, /^\*Pushed 1 to email tool\*/);
  const same = await d.preview('route-editor', [routeVisit(String(v.id), { window: flip })]);
  assert.match((await d.approve(same)).blocks[0].text.text, /already sent today|nothing new/i);
  const second = await d.preview('route-editor', [routeVisit(String(v.id), { window: flip, crewId: '5', crewName: other })]);
  assert.match((await d.approve(second)).blocks[0].text.text, /^\*Pushed 1 to email tool\*/);
  assert.equal(emails(d.outbox).length, 2);
  assert.deepEqual(emails(d.outbox).map((e) => e.payload.external_ref), [String(v.id), String(v.id)]);
});

test('what reaches the email tool is exactly the module\'s send fields: never an address, a price or a staff name', async () => {
  const [v] = await raw.run("SELECT scheduled_visit_id AS id, arrival_window AS w FROM scheduled_visits WHERE visit_date = DATE '2026-10-01' AND crew_id = 4 AND status = 'scheduled' ORDER BY scheduled_visit_id LIMIT 1");
  const rows = await data.run(NOTICES.sql, { visit_ids: String(v.id) }, { declared: ['visit_ids'] });
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['before_crew_id', 'before_crew_name', 'before_date', 'before_window', 'email', 'first_name', 'held', 'kind', 'package_name', 'scheduled_visit_id']);
  const record = {
    skill: 'route-editor', visits: [{ ...routeVisit(String(v.id), { window: v.w === 'morning' ? 'afternoon' : 'morning' }) }], held: [],
  };
  const [item] = sendItems(NOTICES, routeSource.rowsFor(NOTICES, record, rows));
  assert.deepEqual(Object.keys(item).sort(), ['before_crew_id', 'before_crew_name', 'before_date', 'before_window', 'crew_id', 'crew_name', 'email', 'external_ref', 'first_name', 'kind', 'package_name', 'reason', 'visit_date', 'window']);
});
