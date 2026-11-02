'use strict';

// The approval-write route row source (Story 20.3, plan brightside-v1 D14a,
// AD-15 amended): the record is bound to the person and the route session
// for 30 minutes and consumed by the preview; its rows hold the booking's
// before values and the route's after values; an unchanged, unbooked,
// to-rebook or cross-zone visit is held (listed, never sent); a startup check
// keeps the route fields the engine's. The change key covers the change. A
// stand-in module and made-up ids: no client specifics.

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../../kit/runtime/store');
const routeSource = require('../../kit/runtime/archetypes/approval-write/route-source');
const entry = require('../../kit/runtime/archetypes/approval-write/entry');
const { checkModule } = require('../../kit/runtime/archetypes/approval-write');
const { NOTICE_WORDS } = require('../../kit/runtime/messages');

const NOW = Date.parse('2026-11-01T15:00:00Z');
test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: NOW }));
test.afterEach(() => mock.timers.reset());

const MOD = Object.freeze({
  id: 'notices',
  archetype: 'approval-write',
  resource: 'NOTICES',
  row_id: 'visit_id',
  parameters: [{
    name: 'visit_ids', type: 'string', pattern: '[1-9][0-9]*(,[1-9][0-9]*)*', max_length: 500, required: true,
  }],
  write: {
    source: 'route',
    connector: 'mail',
    operation: 'send',
    destination: 'mail',
    fields: ['visit_id', 'email', 'before_date', 'before_window', 'before_crew_id', 'after_date', 'after_window', 'after_crew_id', 'after_crew_name', 'change_reason', 'held'],
    send: { external_ref: 'visit_id', email: 'email' },
    hold: 'held',
    list_name: 'notices-{run_date}',
  },
});

const visit = (id, before, after) => ({
  id,
  before: { date: '2026-10-01', window: 'morning', crewId: '4', ...before },
  after: {
    date: '2026-10-01', window: 'afternoon', crewId: '4', crewName: 'Crew Four', ...after,
  },
});
const record = (over = {}) => ({
  person: 'U1', session: 'S1', module: MOD.id, skill: 'route-editor', visits: [visit('12')], held: [], ...over,
});

test('put and take: the record is the person\'s and the route session\'s, taken once; another person, another session or a bad token gets nothing', () => {
  const store = createStore();
  const token = routeSource.put(store, record());
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal(routeSource.take(store, token, { person: 'U2', session: 'S1' }), null, 'another person');
  assert.equal(routeSource.take(store, token, { person: 'U1', session: 'S2' }), null, 'another route session');
  for (const bad of ['', 'x', token.toUpperCase(), undefined, 12]) assert.equal(routeSource.take(store, bad, { person: 'U1', session: 'S1' }), null);
  const got = routeSource.take(store, token, { person: 'U1', session: 'S1' });
  assert.deepEqual(got.visits.map((v) => v.id), ['12']);
  assert.equal(got.skill, 'route-editor');
  assert.equal(routeSource.take(store, token, { person: 'U1', session: 'S1' }), null, 'the preview consumed it');
});

test('the record expired: after 30 minutes it is gone (the store\'s route namespace, frozen clock)', () => {
  const store = createStore();
  const token = routeSource.put(store, record());
  mock.timers.tick(30 * 60 * 1000 - 1);
  const live = routeSource.put(store, record());
  assert.ok(routeSource.take(store, live, { person: 'U1', session: 'S1' }));
  mock.timers.tick(1);
  assert.equal(routeSource.take(store, token, { person: 'U1', session: 'S1' }), null);
});

test('put refuses a malformed record: a skill no route has, an id that names no visit, an id twice, a bad window, a reason no route gives, too many visits', () => {
  const store = createStore();
  const refuses = (over, what) => assert.throws(() => routeSource.put(store, record(over)), routeSource.RouteRecordError, what);
  refuses({ skill: 'views' }, 'skill');
  refuses({ visits: [visit('add-12')] }, 'an added stop is never a visit');
  refuses({ visits: [visit('012')] }, 'leading zero');
  refuses({ visits: [visit('12'), visit('12')] }, 'twice');
  refuses({ visits: [visit('12')], held: [{ id: '12', reason: 'rebook' }] }, 'visit and held');
  refuses({ visits: [visit('12', {}, { window: 'evening' })] }, 'window');
  refuses({ visits: [visit('12', {}, { crewName: 'A\nB' })] }, 'crew name');
  refuses({ held: [{ id: '13', reason: 'because' }] }, 'reason');
  refuses({ person: '' }, 'person');
  refuses({ session: null }, 'session');
  const many = Array.from({ length: routeSource.MAX_VISITS + 1 }, (_, i) => visit(String(i + 1)));
  refuses({ visits: many }, 'too many');
  assert.deepEqual(routeSource.fits({ visits: many, held: [] }), { tooMany: routeSource.MAX_VISITS });
  assert.deepEqual(routeSource.fits({ visits: many.slice(1), held: [] }), { ok: true });
});

test('idsText is the one string the query binds: the visits, then the held ones', () => {
  const store = createStore();
  const token = routeSource.put(store, record({ visits: [visit('12'), visit('40')], held: [{ id: '7', reason: 'rebook' }] }));
  assert.equal(routeSource.idsText(routeSource.take(store, token, { person: 'U1', session: 'S1' })), '12,40,7');
});

test('rowsFor: the booking\'s before values, the route\'s after values and reason; unchanged, unbooked, to-rebook and cross-zone visits are held with their reason', () => {
  const rec = {
    skill: 'crew-out',
    visits: [
      visit('12', {}, { crewId: '5', window: 'morning', crewName: 'Crew Five' }),
      // The route says afternoon; the booking already says afternoon: not a change.
      visit('13'),
      // Not returned by the query: no longer booked.
      visit('14'),
    ],
    held: [{ id: '15', reason: 'rebook' }, { id: '16', reason: 'cross-zone' }],
  };
  const booked = (id, window, crew) => ({
    visit_id: id, email: `v${id}@home.invalid`, before_date: '2026-10-01', before_window: window, before_crew_id: crew, held: null,
  });
  const rows = routeSource.rowsFor(MOD, rec, [booked(12, 'morning', 4), booked(13, 'afternoon', 4), booked(15, 'morning', 7), booked(16, 'morning', 7)]);
  assert.deepEqual(rows.map((r) => String(r.visit_id)), ['12', '13', '14', '15', '16']);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), [...MOD.write.fields].sort(), 'exactly the write fields');
  assert.deepEqual(rows[0], {
    visit_id: 12,
    email: 'v12@home.invalid',
    before_date: '2026-10-01',
    before_window: 'morning',
    before_crew_id: 4,
    after_date: '2026-10-01',
    after_window: 'morning',
    after_crew_id: '5',
    after_crew_name: 'Crew Five',
    change_reason: 'crew-out',
    held: null,
  });
  assert.equal(rows[1].held, NOTICE_WORDS.notChanged(), 'a move within the same window is not a change');
  assert.equal(rows[2].held, NOTICE_WORDS.notBooked());
  assert.equal(rows[2].email, null, 'nothing about an unbooked visit');
  assert.equal(rows[3].held, NOTICE_WORDS.rebook());
  assert.equal(rows[3].after_date, null, 'a stop to rebook has no after values');
  assert.equal(rows[4].held, NOTICE_WORDS.crossZone());
});

test('rowsFor: the booking decides, not the route session: a crew the booking already has is no change; a crew it doesn\'t is', () => {
  const rec = { skill: 'crew-out', visits: [visit('12', { crewId: '7' }, { crewId: '5', window: 'morning' })], held: [] };
  const row = (crew) => routeSource.rowsFor(MOD, rec, [{
    visit_id: 12, email: 'a@b.invalid', before_date: '2026-10-01', before_window: 'morning', before_crew_id: crew, held: null,
  }])[0];
  assert.equal(row(5).held, NOTICE_WORDS.notChanged());
  assert.equal(row(7).held, null);
});

test('rowsFor fails closed when the query breaks its grain: a visit twice, or one the record doesn\'t hold', () => {
  const rec = { skill: 'route-editor', visits: [visit('12')], held: [] };
  const r = { visit_id: 12, before_date: '2026-10-01', before_window: 'morning', before_crew_id: 4 };
  assert.throws(() => routeSource.rowsFor(MOD, rec, [r, r]), routeSource.RouteRecordError);
  assert.throws(() => routeSource.rowsFor(MOD, rec, [{ ...r, visit_id: 99 }]), routeSource.RouteRecordError);
});

test('the change key covers the change: the same change is the same key in any order; another change to the same visit is another key', () => {
  const a = ['12', '2026-10-01', 'morning', '4', '2026-10-01', 'afternoon', '4'];
  const b = ['13', '2026-10-01', 'morning', '4', '2026-10-01', 'morning', '5'];
  const key = entry.changeKey('notices-2026-11-01', [a, b]);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(entry.changeKey('notices-2026-11-01', [b, a]), key);
  assert.equal(entry.changeKey('notices-2026-11-01', [a.map((v, i) => (i === 3 ? 4 : v)), b]), key, 'a number and its text are the same');
  assert.notEqual(entry.changeKey('notices-2026-11-01', [[...a.slice(0, 6), '5'], b]), key, 'a second, different change');
  assert.notEqual(entry.changeKey('notices-2026-11-01', [a]), key);
  assert.notEqual(entry.changeKey('notices-2026-11-01', [a]), entry.idempotencyKey('notices-2026-11-01', ['12']));
});

// --- startup -----------------------------------------------------------------------

const SQL = `SELECT v.visit_id, v.email, v.before_date, v.before_window, v.before_crew_id, CAST(NULL AS VARCHAR) AS held
FROM v WHERE v.visit_id IN (SELECT CAST(unnest(string_split($visit_ids, ',')) AS INTEGER))`;
const PROFILE = { resources: [{ key: 'NOTICES', admin_grantable: false }] };
const problemsOf = (mod, sql = SQL) => checkModule(mod, { appDir: '/nowhere', profile: PROFILE, sql }).filter((p) => !p.includes('write.connector'));

test('startup: a route-sourced module passes with the route fields set by the engine, not the query', () => {
  assert.deepEqual(problemsOf(MOD), []);
});

test('startup refuses a route-sourced module that takes a form input, has no hold, lacks a before or route field, returns a route field itself, or names an input in its list', () => {
  const withWrite = (w, over = {}) => ({ ...MOD, ...over, write: { ...MOD.write, ...w } });
  const has = (problems, words) => assert.ok(problems.some((p) => p.includes(words)), `${words}: ${problems.join(' | ')}`);
  has(problemsOf({ ...MOD, parameters: [...MOD.parameters, { name: 'zone', type: 'string', enum: ['n'], required: true }] }), 'exactly one input, "visit_ids"');
  has(problemsOf({ ...MOD, parameters: [{ ...MOD.parameters[0], required: false }] }), 'exactly one input');
  has(problemsOf(withWrite({ hold: undefined })), 'field "write.hold" is required');
  has(problemsOf(withWrite({ fields: MOD.write.fields.filter((f) => f !== 'before_crew_id') })), '"before_crew_id"');
  has(problemsOf(withWrite({ fields: MOD.write.fields.filter((f) => f !== 'change_reason') })), '"change_reason"');
  has(problemsOf(MOD, SQL.replace('AS held', 'AS held, v.after_window')), 'must not return "after_window"');
  has(problemsOf(withWrite({ list_name: 'notices-{zone}-{run_date}' })), 'only {run_date}');
  // A module without write.source is not route-sourced: none of this applies.
  assert.equal(routeSource.checkRouteModule({ ...MOD, write: { ...MOD.write, source: undefined } }, '').length, 0);
});
