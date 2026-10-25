'use strict';

// Brightside's Unpaid invoices (Story 9.5): the second scoped-pull module,
// built from a manifest and a SQL file only, on the same engine as Win-back.
// Checked here: it loads with two bounded inputs, its SQL passes the startup
// check, and on a temporary build of the fixture its rows reconcile with the
// known truth outstanding-at-as-of (every zone, no past-due filter: the
// outstanding amounts add up to $198,753.25 exactly), and that cents become
// dollars by exact decimal arithmetic (19.99, 100000.01, two places in the
// CSV). Then the scripted
// request (North, at least 30 days past due) runs end to end: the exact rows
// in the CSV in the admin's DM, the count in the view, and a member without
// UNPAID_INVOICES never sees it.
//
// An example test (architecture carve-out): it reads Brightside's app dir and
// fixture data, and is deleted with the example in a fork. Its profile and
// Slack ids come from a test fixture (fixtures/win-back-profile.yml), never
// from profiles/brightside/.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { loadRegistry } = require('../../../kit/runtime/registry');
const { createData } = require('../../../kit/runtime/data');
const { checkQuery, bindValues } = require('../../../kit/runtime/archetypes/scoped-pull/run');
const { forbiddenColumnsOf } = require('../../../kit/runtime/sql');
const { toCsv, BOM } = require('../../../kit/runtime/archetypes/scoped-pull/csv');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');

const ROOT = path.join(__dirname, '../../..');
const PROFILE_PATH = path.join(__dirname, 'fixtures/win-back-profile.yml');
const APP_DIR = path.join(ROOT, 'examples/brightside/app');
const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/brightside/fixture/targets.json'), 'utf8'));
const profile = loadProfile(PROFILE_PATH);
const { registry, problems } = loadRegistry({ appDir: APP_DIR, profile });
const unpaid = registry && registry.module('unpaid-invoices');
const declared = unpaid ? unpaid.parameters.map((p) => p.name) : [];
const COLUMNS = ['invoice_id', 'client_id', 'first_name', 'last_name', 'zone_id', 'issued_on', 'due_on', 'days_past_due', 'total', 'paid', 'outstanding'];

const ADMIN = profile.users.find((u) => u.role === 'admin').identities.slack;
const MEMBER = profile.users.find((u) => u.role === 'member').identities.slack;

let tmp;
let FIXTURE;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-unpaid-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Dollars as text ("166.00") to whole cents, exactly.
const cents = (s) => {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(String(s));
  assert.ok(m, `not a dollar amount: ${s}`);
  return (m[1] ? -1n : 1n) * (BigInt(m[2]) * 100n + BigInt(m[3]));
};

test('Unpaid invoices loads as a scoped pull: a manifest, a SQL file, two bounded inputs, gated by UNPAID_INVOICES', () => {
  assert.deepEqual(problems, []);
  assert.equal(unpaid.archetype, 'scoped-pull');
  assert.equal(unpaid.resource, 'UNPAID_INVOICES');
  assert.equal(unpaid.handler, undefined);
  assert.deepEqual(fs.readdirSync(path.join(APP_DIR, 'modules/unpaid-invoices')).sort(), ['manifest.json', 'unpaid-invoices.sql']);
  assert.deepEqual(unpaid.parameters.map((p) => [p.name, p.enum || [p.min, p.max], p.default, Boolean(p.required)]), [
    ['zone', ['all', 'north', 'south', 'east', 'west', 'central'], 'all', true],
    ['min_days_past_due', [0, 730], undefined, false],
  ]);
  const resource = profile.resources.find((r) => r.key === 'UNPAID_INVOICES');
  assert.ok(resource && !resource.open_access);
});

test('its SQL passes the startup check with the forbidden columns, and names no contact or address column', () => {
  assert.deepEqual(checkQuery(unpaid.sql, unpaid.parameters, { forbiddenColumns: forbiddenColumnsOf(profile) }), []);
  assert.ok(!unpaid.sql.includes('${'));
  assert.ok(!/\b(email|phone|street_address|postal_code)\b/.test(unpaid.sql.replace(/--[^\n]*/g, '')));
});

test('on the fixture, every zone with no filter reconciles to the outstanding-at-as-of truth, to the cent', async (t) => {
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  const rows = await data.run(unpaid.sql, bindValues(unpaid.parameters, { zone: 'all' }), { declared });
  assert.deepEqual(Object.keys(rows[0]), COLUMNS);
  assert.equal(rows.length, 1136);
  assert.equal(rows.reduce((sum, r) => sum + cents(r.outstanding), 0n), BigInt(TARGETS.truths['outstanding-at-as-of']));
  assert.ok(rows.every((r) => cents(r.outstanding) > 0n && cents(r.total) - cents(r.paid) === cents(r.outstanding)));
  // Oldest due date first.
  assert.deepEqual(rows.map((r) => r.due_on), rows.map((r) => r.due_on).slice().sort());
  // The zone and past-due filters narrow it.
  const north = await data.run(unpaid.sql, bindValues(unpaid.parameters, { zone: 'north' }), { declared });
  assert.ok(north.length > 0 && north.length < rows.length && north.every((r) => r.zone_id === 'north'));
  const pastDue = await data.run(unpaid.sql, bindValues(unpaid.parameters, { zone: 'north', min_days_past_due: 30 }), { declared });
  assert.equal(pastDue.length, 95);
  assert.ok(pastDue.every((r) => Number(r.days_past_due) >= 30));
  assert.deepEqual(pastDue.slice(0, 2).map((r) => [r.invoice_id, r.client_id, r.due_on, r.days_past_due, r.outstanding]), [
    [16, 1998, '2024-10-24', '706', '166.00'],
    [133, 16, '2024-11-08', '691', '154.00'],
  ]);
});

test('cents become dollars exactly: DECIMAL(18, 2) from decimal arithmetic, never a floating-point division, and the CSV keeps two places', async (t) => {
  assert.ok(!/\/\s*100\b/.test(unpaid.sql.replace(/--[^\n]*/g, '')), 'no division of cents by 100');
  // The module's own SQL, run through the data layer on the built fixture,
  // with its four tables shadowed by small hand-made ones (a CTE named like a
  // table wins over the table).
  const shadow = `WITH fixture_meta AS (SELECT 'as_of' AS key, '2025-01-31' AS value),
    clients AS (SELECT 1 AS client_id, 'Ada' AS first_name, 'Penn' AS last_name, 'north' AS zone_id),
    invoices AS (
      SELECT 1 AS invoice_id, 1 AS client_id, DATE '2025-01-01' AS issued_on, DATE '2025-01-10' AS due_on, CAST(1999 AS BIGINT) AS total_cents
      UNION ALL SELECT 2 AS invoice_id, 1 AS client_id, DATE '2025-01-02' AS issued_on, DATE '2025-01-11' AS due_on, CAST(10000001 AS BIGINT) AS total_cents
      UNION ALL SELECT 3 AS invoice_id, 1 AS client_id, DATE '2025-01-03' AS issued_on, DATE '2025-01-12' AS due_on, CAST(1000 AS BIGINT) AS total_cents),
    payments AS (
      SELECT 2 AS invoice_id, DATE '2025-01-20' AS paid_on, CAST(1 AS BIGINT) AS amount_cents
      UNION ALL SELECT 2 AS invoice_id, DATE '2025-02-01' AS paid_on, CAST(500 AS BIGINT) AS amount_cents
      UNION ALL SELECT 3 AS invoice_id, DATE '2025-01-15' AS paid_on, CAST(999 AS BIGINT) AS amount_cents),
    `;
  const body = unpaid.sql.replace(/^(?:--[^\n]*\n)*\s*WITH\s+/, '');
  assert.notEqual(body, unpaid.sql, 'the module SQL opens with comments and WITH');
  const sql = shadow + body;
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  const params = bindValues(unpaid.parameters, { zone: 'all' });
  // (The checker refuses naming "paid" here, a CTE in the module SQL; paid is
  // the same expression, and its "0.00" below shows the two places.)
  const types = await data.run(`SELECT DISTINCT typeof(r.total) AS t, typeof(r.outstanding) AS o FROM (${sql}) AS r`, params, { declared });
  assert.deepEqual(types, [{ t: 'DECIMAL(18,2)', o: 'DECIMAL(18,2)' }]);
  const rows = await data.run(sql, params, { declared });
  // A payment after as_of does not count; invoice 3 has one cent left.
  assert.deepEqual(rows.map((r) => [r.invoice_id, r.total, r.paid, r.outstanding]), [
    [1, '19.99', '0.00', '19.99'],
    [2, '100000.01', '0.01', '100000.00'],
    [3, '10.00', '9.99', '0.01'],
  ]);
  const csv = toCsv(COLUMNS, rows).replace(BOM, '').trimEnd().split('\r\n');
  assert.deepEqual(csv.slice(1).map((l) => l.split(',').slice(-3).join(',')), ['19.99,0.00,19.99', '100000.01,0.01,100000.00', '10.00,9.99,0.01']);
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

test('the scripted request end to end: North, at least 30 days past due, gives the exact rows in the admin\'s DM', async (t) => {
  const app = await boot(t);
  await app.dispatchCommand('/brightside', { user_id: ADMIN });
  assert.ok(opens(app.views[0].args.view).includes('unpaid-invoices:open'));
  await app.dispatchAction('unpaid-invoices:open', { user: { id: ADMIN }, view: MENU });
  const form = last(app);
  const formId = `V${app.viewSeq}`;
  const typed = {
    values: {
      'sp-input:zone': { value: { type: 'static_select', selected_option: { value: 'north' } } },
      'sp-input:min_days_past_due': { value: { type: 'number_input', value: '30' } },
    },
  };
  await app.dispatchView('scoped-pull:form', {
    user: { id: ADMIN }, view: { id: formId, hash: 'h', title: form.title, private_metadata: form.private_metadata, state: typed },
  });
  const confirm = app.viewAcks.at(-1).view;
  const session = confirm.blocks.find((b) => b.type === 'actions').elements[0].value;
  await app.dispatchAction('scoped-pull:confirm', { user: { id: ADMIN }, view: { id: formId, hash: 'hc', title: confirm.title, private_metadata: confirm.private_metadata }, value: session });

  const result = last(app);
  assert.equal(result.blocks[0].text.text, '*Unpaid invoices: 95 rows.*');
  assert.deepEqual(result.blocks.filter((b) => b.fields).map((b) => b.fields[1].text), ['north', '30']);
  assert.equal(app.uploads.length, 1);
  assert.equal(app.uploads[0].channel_id, `D${ADMIN.slice(1)}`);
  const lines = app.uploads[0].content.replace(/^﻿/, '').trimEnd().split('\r\n');
  assert.equal(lines[0], COLUMNS.join(','));
  assert.equal(lines.length, 1 + 95);
  const data = createData({ file: FIXTURE, profile });
  t.after(() => data.close());
  const expected = await data.run(unpaid.sql, { zone: 'north', min_days_past_due: 30 }, { declared });
  assert.deepEqual(lines.slice(1), expected.map((r) => COLUMNS.map((c) => r[c]).join(',')));
  assert.equal(lines[1], '16,1998,Holly,Stillford,north,2024-10-10,2024-10-24,706,166.00,0.00,166.00');
  assert.deepEqual(app.posted, []);
});

test('a member without UNPAID_INVOICES never sees it and is refused if they click it', async (t) => {
  const app = await boot(t);
  await app.dispatchCommand('/brightside', { user_id: MEMBER });
  assert.ok(!opens(app.views[0].args.view).includes('unpaid-invoices:open'));
  await app.dispatchAction('unpaid-invoices:open', { user: { id: MEMBER }, view: MENU });
  assert.equal(last(app).blocks.filter((b) => b.type === 'input').length, 0);
  assert.match(last(app).blocks[0].text.text, /don't have access to Unpaid invoices/);
});
