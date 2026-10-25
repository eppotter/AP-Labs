'use strict';

// Brightside's Labour cost (Story 9.7): the third scoped-pull module, built
// from a manifest and a SQL file only, on the same engine as Win-back and
// Unpaid invoices. Checked here: it loads with one bounded input (the month),
// its SQL passes the startup check and shows totals only (no name, id or
// rate). On small hand-made tables it follows MET-007: the pay rate in effect
// on the visit date, cancelled visits excluded, rounded once at the end (half
// up, never per timesheet), exact decimals, and "September" meaning the latest
// September on or before as_of. On a temporary build of the fixture, September
// 2026 costs exactly $163,554.16, matching an independent BigInt sum over the
// raw timesheets and pay rates. Then the scripted request runs end to end
// (Confirm shows the month; the admin gets the one-row CSV), and a member
// without LABOUR_COST never sees it.
//
// An example test (architecture carve-out): it reads Brightside's app dir and
// fixture data (and, for the grant check only, profiles/brightside/), and is
// deleted with the example in a fork. Its run profile and Slack ids come from
// a test fixture (fixtures/win-back-profile.yml).

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { resolveAccess } = require('../../../kit/lib/permissions');
const { loadRegistry } = require('../../../kit/runtime/registry');
const { createData } = require('../../../kit/runtime/data');
const { checkQuery, bindValues } = require('../../../kit/runtime/archetypes/scoped-pull/run');
const { forbiddenColumnsOf } = require('../../../kit/runtime/sql');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');

const ROOT = path.join(__dirname, '../../..');
const PROFILE_PATH = path.join(__dirname, 'fixtures/win-back-profile.yml');
const APP_DIR = path.join(ROOT, 'examples/brightside/app');
const profile = loadProfile(PROFILE_PATH);
const { registry, problems } = loadRegistry({ appDir: APP_DIR, profile });
const labour = registry && registry.module('labour-cost');
const declared = labour ? labour.parameters.map((p) => p.name) : [];
const COLUMNS = ['month', 'first_day', 'last_day', 'visit_count', 'timesheet_count', 'minutes_worked', 'hours_worked', 'labour_cost'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const ADMIN = profile.users.find((u) => u.role === 'admin').identities.slack;
const MEMBER = profile.users.find((u) => u.role === 'member').identities.slack;

let tmp;
let FIXTURE;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-labour-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const withoutComments = (sql) => sql.replace(/--[^\n]*/g, '');

test('Labour cost loads as a scoped pull: a manifest, a SQL file, one month input, gated by LABOUR_COST', () => {
  assert.deepEqual(problems, []);
  assert.equal(labour.archetype, 'scoped-pull');
  assert.equal(labour.resource, 'LABOUR_COST');
  assert.equal(labour.handler, undefined);
  assert.deepEqual(fs.readdirSync(path.join(APP_DIR, 'modules/labour-cost')).sort(), ['labour-cost.sql', 'manifest.json']);
  assert.deepEqual(labour.parameters.map((p) => [p.name, p.type, p.enum, p.default, Boolean(p.required)]), [
    ['month', 'string', MONTHS, undefined, true],
  ]);
});

test('LABOUR_COST is never open access: in the demo profile only the admin role confers it, and no member holds it', () => {
  const demo = loadProfile(path.join(ROOT, 'profiles/brightside/profile.yml'));
  const resource = demo.resources.find((r) => r.key === 'LABOUR_COST');
  assert.ok(resource, 'the demo profile declares LABOUR_COST');
  assert.ok(!resource.open_access);
  assert.equal(resource.admin_grantable, true);
  for (const u of demo.users) {
    assert.equal(resolveAccess(demo, u.id, 'LABOUR_COST'), u.role === 'admin' ? 'allowed' : 'denied', u.id);
  }
  assert.equal(resolveAccess(demo, 'nobody-in-users', 'LABOUR_COST'), 'denied');
  assert.ok(!profile.resources.find((r) => r.key === 'LABOUR_COST').open_access);
});

test('its SQL passes the startup check, prices by pay_rates (never staff), and names no person column', () => {
  assert.deepEqual(checkQuery(labour.sql, labour.parameters, { forbiddenColumns: forbiddenColumnsOf(profile) }), []);
  const body = withoutComments(labour.sql);
  assert.ok(!labour.sql.includes('${'));
  assert.ok(/\bpay_rates\b/.test(body) && !/\bstaff\b/.test(body), 'priced from pay_rates, never the staff table');
  assert.ok(!/\b(name|first_name|last_name|email|phone)\b/.test(body));
  // No division by a decimal (DuckDB makes it a DOUBLE): only integer division.
  assert.ok(!/[^/]\/[^/]/.test(body), 'no floating-point division');
});

// The module's own SQL with its four tables shadowed by small hand-made ones
// (a CTE named like a table wins over the table).
function shadowed(asOf) {
  const shadow = `WITH fixture_meta AS (SELECT 'as_of' AS key, '${asOf}' AS value),
    visits AS (
      SELECT 1 AS visit_id, DATE '2026-09-14' AS visit_date, 'completed' AS status
      UNION ALL SELECT 2, DATE '2026-09-15', 'completed'
      UNION ALL SELECT 3, DATE '2026-09-16', 'completed'
      UNION ALL SELECT 4, DATE '2026-09-17', 'cancelled'
      UNION ALL SELECT 5, DATE '2026-08-31', 'completed'
      UNION ALL SELECT 6, DATE '2025-09-10', 'completed'
      UNION ALL SELECT 7, DATE '2025-10-05', 'completed'),
    timesheets AS (
      SELECT 1 AS visit_id, 1 AS staff_id, 60 AS minutes
      UNION ALL SELECT 2, 1, 60
      UNION ALL SELECT 3, 2, 1
      UNION ALL SELECT 3, 3, 1
      UNION ALL SELECT 3, 4, 1
      UNION ALL SELECT 3, 5, 1
      UNION ALL SELECT 4, 2, 500
      UNION ALL SELECT 5, 2, 500
      UNION ALL SELECT 6, 2, 500
      UNION ALL SELECT 7, 1, 30),
    pay_rates AS (
      SELECT 1 AS staff_id, DATE '2025-01-01' AS start_date, DATE '2026-09-14' AS end_date, CAST(2000 AS BIGINT) AS hourly_rate_cents
      UNION ALL SELECT 1, DATE '2026-09-15', NULL, CAST(2075 AS BIGINT)
      UNION ALL SELECT 2, DATE '2025-01-01', NULL, CAST(2000 AS BIGINT)
      UNION ALL SELECT 3, DATE '2025-01-01', NULL, CAST(2000 AS BIGINT)
      UNION ALL SELECT 4, DATE '2025-01-01', NULL, CAST(2000 AS BIGINT)
      UNION ALL SELECT 5, DATE '2025-01-01', NULL, CAST(2010 AS BIGINT)),
    `;
  const body = labour.sql.replace(/^(?:--[^\n]*\n)*\s*WITH\s+/, '');
  assert.notEqual(body, labour.sql, 'the module SQL opens with comments and WITH');
  return shadow + body;
}

test('on hand-made tables: the rate on the visit date, cancelled visits out, rounded once at the end, exact decimals', async (t) => {
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  const run = (asOf, month) => data.run(shadowed(asOf), bindValues(labour.parameters, { month }), { declared });

  // September on 2026-09-30: visits 1-3 only. 60 min at 2,000 (the day before
  // the raise) + 60 min at 2,075 (the day of it) + three 1-minute timesheets at
  // 2,000 + one at 2,010 = 252,510 cent-minutes = 4,208.5 cents, rounded half
  // up once to 4,209. Rounding each timesheet would give 4,208.
  const sept = await run('2026-09-30', 'September');
  assert.deepEqual(sept, [{
    month: 'September 2026', first_day: '2026-09-01', last_day: '2026-09-30',
    visit_count: '3', timesheet_count: '6', minutes_worked: '124', hours_worked: '2.07', labour_cost: '42.09',
  }]);
  const types = await data.run(`SELECT typeof(r.labour_cost) AS c, typeof(r.hours_worked) AS h FROM (${shadowed('2026-09-30')}) AS r`, bindValues(labour.parameters, { month: 'September' }), { declared });
  assert.deepEqual(types, [{ c: 'DECIMAL(18,2)', h: 'DECIMAL(18,2)' }]);

  // A month after as_of's month is last year's: October on 2026-09-30 is
  // October 2025 (30 min at 2,000 = 1,000 cents).
  assert.deepEqual((await run('2026-09-30', 'October')).map((r) => [r.month, r.labour_cost]), [['October 2025', '10.00']]);
  // On 2026-08-31, September is September 2025.
  assert.deepEqual((await run('2026-08-31', 'September')).map((r) => [r.month, r.visit_count, r.labour_cost]), [['September 2025', '1', '166.67']]);
  // When as_of is inside the month, the month runs to as_of.
  assert.deepEqual((await run('2026-09-15', 'September')).map((r) => [r.last_day, r.visit_count, r.labour_cost]), [['2026-09-15', '2', '40.75']]);
  // A month with no timesheets gives no row.
  assert.deepEqual(await run('2026-09-30', 'June'), []);
});

// Exact cents from the raw rows, in BigInt: minutes x the rate on the visit
// date, summed, then divided by 60 and rounded half up once.
async function independentCents(data, first, next) {
  const sheets = await data.run(
    `SELECT t.staff_id, t.minutes, CAST(v.visit_date AS VARCHAR) AS visit_date
     FROM timesheets t JOIN visits v ON v.visit_id = t.visit_id
     WHERE v.status = 'completed' AND v.visit_date >= CAST($first AS DATE) AND v.visit_date < CAST($next AS DATE)`,
    { first, next }, { declared: ['first', 'next'] });
  const rates = await data.run(
    `SELECT r.staff_id, CAST(r.start_date AS VARCHAR) AS start_date, CAST(r.end_date AS VARCHAR) AS end_date, r.hourly_rate_cents FROM pay_rates r`);
  const byStaff = new Map();
  for (const r of rates) {
    const list = byStaff.get(String(r.staff_id)) || [];
    list.push(r);
    byStaff.set(String(r.staff_id), list);
  }
  let total = 0n;
  for (const s of sheets) {
    const inEffect = (byStaff.get(String(s.staff_id)) || []).filter((r) => r.start_date <= s.visit_date && (r.end_date === null || r.end_date >= s.visit_date));
    assert.equal(inEffect.length, 1, `one rate for staff ${s.staff_id} on ${s.visit_date}`);
    total += BigInt(s.minutes) * BigInt(inEffect[0].hourly_rate_cents);
  }
  return { count: sheets.length, cents: (total + 30n) / 60n };
}

test('on the fixture, September 2026 costs exactly $163,554.16, matching an independent sum over the raw rows', async (t) => {
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  const rows = await data.run(labour.sql, bindValues(labour.parameters, { month: 'September' }), { declared });
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), COLUMNS);
  assert.deepEqual(rows[0], {
    month: 'September 2026', first_day: '2026-09-01', last_day: '2026-09-30',
    visit_count: '1882', timesheet_count: '5646', minutes_worked: '450589', hours_worked: '7509.82', labour_cost: '163554.16',
  });
  const independent = await independentCents(data, '2026-09-01', '2026-10-01');
  assert.equal(independent.count, 5646);
  assert.equal(independent.cents, 16355416n);
});

class ViewsSlackApp extends FakeSlackApp {
  constructor(options) { super({ ...options, views: true }); }
}

async function boot(t) {
  const lines = [];
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      APLABS_PROFILE: PROFILE_PATH,
      APLABS_APP_DIR: APP_DIR,
      APLABS_DATA_PATH: FIXTURE,
    },
    cwd: os.tmpdir(),
    deps: { App: ViewsSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => res.data.close());
  return res.app;
}

const MENU = { id: 'VMENU', type: 'modal', private_metadata: 'brightside', title: { type: 'plain_text', text: 'Brightside' } };
const last = (app) => app.views.at(-1).args.view;
const opens = (view) => view.blocks.filter((b) => b.accessory).map((b) => b.accessory.action_id);

test('the scripted request end to end: September is shown on Confirm, and the admin gets the one-row total', async (t) => {
  const app = await boot(t);
  await app.dispatchCommand('/brightside', { user_id: ADMIN });
  assert.ok(opens(app.views[0].args.view).includes('labour-cost:open'));
  await app.dispatchAction('labour-cost:open', { user: { id: ADMIN }, view: MENU });
  const form = last(app);
  const formId = `V${app.viewSeq}`;
  const typed = { values: { 'sp-input:month': { value: { type: 'static_select', selected_option: { value: 'September' } } } } };
  await app.dispatchView('scoped-pull:form', {
    user: { id: ADMIN }, view: { id: formId, hash: 'h', title: form.title, private_metadata: form.private_metadata, state: typed },
  });
  const confirm = app.viewAcks.at(-1).view;
  assert.deepEqual(confirm.blocks.filter((b) => b.fields).map((b) => b.fields.map((f) => f.text)), [['*Month*', 'September']]);
  const session = confirm.blocks.find((b) => b.type === 'actions').elements[0].value;
  await app.dispatchAction('scoped-pull:confirm', { user: { id: ADMIN }, view: { id: formId, hash: 'hc', title: confirm.title, private_metadata: confirm.private_metadata }, value: session });

  const result = last(app);
  assert.equal(result.blocks[0].text.text, '*Labour cost: 1 row.*');
  assert.equal(app.uploads.length, 1);
  assert.equal(app.uploads[0].channel_id, `D${ADMIN.slice(1)}`);
  const lines = app.uploads[0].content.replace(/^﻿/, '').trimEnd().split('\r\n');
  assert.deepEqual(lines, [COLUMNS.join(','), 'September 2026,2026-09-01,2026-09-30,1882,5646,450589,7509.82,163554.16']);
  assert.deepEqual(app.posted, []);
});

test('a member without LABOUR_COST never sees it and is refused if they click it', async (t) => {
  const app = await boot(t);
  await app.dispatchCommand('/brightside', { user_id: MEMBER });
  assert.ok(!opens(app.views[0].args.view).includes('labour-cost:open'));
  await app.dispatchAction('labour-cost:open', { user: { id: MEMBER }, view: MENU });
  assert.equal(last(app).blocks.filter((b) => b.type === 'input').length, 0);
  assert.match(last(app).blocks[0].text.text, /don't have access to Labour cost/);
  assert.equal(app.uploads.length, 0);
});
