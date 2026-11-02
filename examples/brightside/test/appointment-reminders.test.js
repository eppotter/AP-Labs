'use strict';

// Story 20.2 (plan brightside-v1, D14, D14a, GRD-010): Customers → Appointment
// reminders on /brightside. A person granted APPOINTMENT_EMAILS by name (Ely
// and Steven, equally) picks a day after as_of and a zone or a crew, checks
// the preview and approves; the email tool gets one reminder per visit, the
// fixed template's text. A visit on a crew-day with an absence is held
// (SQLsmith P2-11): listed in the preview, never emailed.
//
// The scenario: 2026-10-03 (as_of + 3), East zone. East crew A (crew 7) has
// two members absent that day (fixture S3), so its 6 visits are held; East
// crews B and C have 7 visits, which are emailed.
//
// Ways out, each tested once: Cancel, an expired preview, a partial failure
// and Retry; with every visit held, there is nothing to approve. Also: the
// preview equals what is sent, a second Approve sends nothing new,
// BRIGHTSIDE_EMAIL_OFF stops it, and no key means no row.
//
// The clock is frozen (Date: the store's expiry, the run date and the email
// tool's day all read it). An example test: it reads Brightside's app dir,
// fixture data and mock email tool, and is deleted with the example in a
// fork. Its profiles and Slack ids come from test fixtures, never from
// profiles/brightside/.

const test = require('node:test');
const { before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { loadRegistry } = require('../../../kit/runtime/registry');
const { createStore } = require('../../../kit/runtime/store');
const approvalWrite = require('../../../kit/runtime/archetypes/approval-write');
const { testLog } = require('../../../kit/runtime/sdk');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const provenance = require('../../../kit/runtime/slack/provenance');
const email = require('../app/connectors/email/connector.js');
const templates = require('../app/connectors/email/templates.js');

const ROOT = path.join(__dirname, '../../..');
const PROFILE_PATH = path.join(__dirname, 'fixtures/demo-profile.yml');
const NO_KEY_PROFILE = path.join(__dirname, 'fixtures/win-back-profile.yml');
const APP_DIR = path.join(ROOT, 'examples/brightside/app');
const profile = loadProfile(PROFILE_PATH);
const { registry } = loadRegistry({ appDir: APP_DIR, profile });
const reminders = registry.module('appointment-reminders');
const slackOf = (p, id) => p.users.find((u) => u.id === id).identities.slack;
const ELY = slackOf(profile, 'ely');
const STEVEN = slackOf(profile, 'steven');
const MENU = { id: 'VMENU', type: 'modal', private_metadata: 'brightside', title: { type: 'plain_text', text: 'Brightside' } };
const SYSTEM = 'Brightside email tool (mock)';

const NOW = Date.parse('2026-11-01T15:00:00Z');
const RUN_DATE = '2026-11-01';
const LIST = `appointment-reminders-${RUN_DATE}`;
const DAY = '2026-10-03';
const HELD_TEXT = 'Held: a member of East crew A is absent that day. Check Crew out first.';

let tmp;
let FIXTURE;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-appt-reminders-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: NOW }));
test.afterEach(() => mock.timers.reset());

class ViewsSlackApp extends FakeSlackApp {
  constructor(options) { super({ ...options, views: true }); }
}

let seq = 0;
// Boots the app on the fixture build with its own outbox and store. env:
// extra env (an object a test may change).
async function boot(t, { env = {}, profilePath = PROFILE_PATH } = {}) {
  seq += 1;
  const varDir = path.join(tmp, `var-${seq}`);
  const lines = [];
  const store = createStore();
  Object.assign(env, {
    APLABS_VAR_DIR: varDir,
    APLABS_NO_KEYCHAIN: '1',
    APLABS_ENV: 'dev',
    // Fake values, shaped like the real ones; nothing here is a credential.
    SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
    SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
    APLABS_PROFILE: profilePath,
    APLABS_APP_DIR: APP_DIR,
    APLABS_DATA_PATH: FIXTURE,
  });
  const res = await main({
    env,
    cwd: os.tmpdir(),
    deps: {
      App: ViewsSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain'), store,
    },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => res.data.close());
  const outbox = path.join(varDir, 'outbox', 'email.jsonl');
  return {
    app: res.app, store, outbox, lines, env,
  };
}

const last = (app) => app.views.at(-1).args.view;
const actionsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const head = (view) => view.blocks[0].text.text;
const textOf = (view) => view.blocks.map((b) => (b.text && b.text.text) || (b.elements || []).map((e) => (e.text && (e.text.text || e.text)) || '').join(' ')).join('\n');

// The outbox's email records ([] with no file).
function emails(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'email');
}

// Runs Appointment reminders for day and zoneOrCrew as person, presses Push
// and returns the preview view.
async function preview(ctx, { day = DAY, zoneOrCrew = 'east', person = ELY } = {}) {
  const { app } = ctx;
  await app.dispatchAction('appointment-reminders:open', { user: { id: person }, view: MENU });
  const form = last(app);
  const formId = `V${app.viewSeq}`;
  const state = { values: {
    'sp-input:day': { value: { type: 'datepicker', selected_date: day } },
    'sp-input:zone_or_crew': { value: { type: 'static_select', selected_option: { value: zoneOrCrew } } },
  } };
  await app.dispatchView('scoped-pull:form', {
    user: { id: person }, view: { id: formId, hash: `h${app.viewSeq}`, title: form.title, private_metadata: form.private_metadata, state },
  });
  const confirm = app.viewAcks.at(-1).view;
  const from = { id: formId, hash: 'hc', title: confirm.title, private_metadata: confirm.private_metadata, state: { values: {} } };
  await app.dispatchAction('scoped-pull:confirm', { user: { id: person }, view: from, value: actionsOf(confirm)[0].value });
  ctx.from = from;
  ctx.result = last(app);
  const push = actionsOf(ctx.result).find((b) => b.action_id === 'approval-write:push');
  if (!push) return null;
  await app.dispatchAction('approval-write:push', { user: { id: person }, view: { ...from, hash: `h${app.viewSeq}` }, value: push.value });
  return last(app);
}

const tokenOf = (view) => actionsOf(view).find((b) => b.action_id === 'approval-write:approve').value;

async function click(ctx, action, value, user = ELY) {
  await ctx.app.dispatchAction(action, { user: { id: user }, view: { ...ctx.from, hash: `h${ctx.app.viewSeq}` }, value });
  return last(ctx.app);
}

// The fields a row's email is rendered from (write.send, less the address and ref).
function fieldsOf(row) {
  return {
    first_name: row.first_name,
    kind: row.kind,
    visit_date: row.visit_date,
    window: row.arrival_window,
    crew_id: row.crew_id,
    crew_name: row.crew_name,
    package_name: row.package_name,
  };
}

// The preview's email texts, as a person reads them: each "Email i of n"
// section's code block, with Slack's &amp; &lt; &gt; read back.
function emailTexts(view) {
  return view.blocks
    .filter((b) => b.type === 'section' && /^\*Email \d+ of \d+, exactly as it will be sent:\*\n```\n/.test(b.text.text))
    .map((b) => b.text.text.split('```\n')[1].replace(/\n```$/, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

// Saves a run record of rows for person (as a run of the module would) and
// presses its Push: the preview view. Lets a test change a row between runs
// (a hold lifted, an address the tool refuses).
async function pushRows(ctx, rows, person = ELY) {
  const record = provenance.buildRecord({
    person, module: reminders.id, parameters: { day: DAY, zone_or_crew: 'east' }, sql: reminders.sql, ranAt: new Date(), rowIds: rows.map((r) => r.scheduled_visit_id), rows,
  });
  provenance.save(ctx.store, record);
  return click(ctx, 'approval-write:push', record.runId, person);
}

// A code block's table rows (header dropped), each split on the column gap.
function tableRows(sectionText) {
  const block = sectionText.split('```')[1];
  return block.split('\n').filter(Boolean).slice(1).map((l) => l.trim().split(/\s{2,}/));
}

test('Ely and Steven see Customers → Appointment reminders (Review) on /brightside; an admin without APPOINTMENT_EMAILS never sees it and is refused if they click it', async (t) => {
  const ctx = await boot(t);
  for (const who of [ELY, STEVEN]) {
    const before = ctx.app.views.length;
    await ctx.app.dispatchCommand('/brightside', { user_id: who });
    const menu = ctx.app.views[before].args.view;
    const at = menu.blocks.findIndex((b) => b.accessory && b.accessory.action_id === 'appointment-reminders:open');
    assert.ok(at > 0, `${who} sees it`);
    assert.equal(menu.blocks[at].accessory.text.text, 'Review');
    const header = menu.blocks.slice(0, at).filter((b) => b.type === 'header').at(-1);
    assert.equal(header.text.text, 'Customers');
  }
  // No key, no row: an admin (admin_grantable: false) and a member without it.
  const noKey = loadProfile(NO_KEY_PROFILE);
  const other = await boot(t, { profilePath: NO_KEY_PROFILE });
  for (const who of [slackOf(noKey, 'ada'), slackOf(noKey, 'max')]) {
    const before = other.app.views.length;
    await other.app.dispatchCommand('/brightside', { user_id: who });
    assert.ok(!other.app.views[before].args.view.blocks.some((b) => b.accessory && b.accessory.action_id === 'appointment-reminders:open'));
    await other.app.dispatchAction('appointment-reminders:open', { user: { id: who }, view: MENU });
    assert.equal(last(other.app).blocks.filter((b) => b.type === 'input').length, 0, 'no form');
  }
  assert.match(head(last(other.app)), /You don't have access to Appointment reminders/);
});

test('the preview lists the 7 visits it will email and the 6 held for the absence; Approve sends exactly those 7, each the template\'s exact text, and never a held one', async (t) => {
  const ctx = await boot(t);
  const view = await preview(ctx);
  const token = tokenOf(view);
  const stored = ctx.store.get('approval', token);
  assert.equal(stored.rows.length, 13);
  const held = stored.rows.filter((r) => r.held);
  const sending = stored.rows.filter((r) => !r.held);
  assert.equal(held.length, 6);
  assert.ok(held.every((r) => r.crew_name === 'East crew A' && r.held === HELD_TEXT));
  assert.equal(sending.length, 7);
  assert.ok(sending.every((r) => r.crew_name !== 'East crew A' && r.visit_date === DAY));

  assert.equal(head(view), '*Push Appointment reminders to email tool?* Check it before you approve.');
  assert.equal(view.blocks[1].text.text, `*List name:* ${LIST}\n*Rows to send:* 7 of 13 rows\n*Skipped:* 6: held (6)`);
  const heldText = view.blocks[2].text.text;
  assert.ok(heldText.startsWith(`*Held, not sent: 6.*\n• ${HELD_TEXT} (6)\n`), heldText);
  const listed = (r) => [r.first_name, r.visit_date, r.arrival_window, r.crew_name];
  assert.deepEqual(tableRows(heldText), held.map(listed));
  // What will be sent: every row, in order, and nothing else.
  const sendText = view.blocks[3].text.text;
  assert.ok(sendText.startsWith('*What will be sent (7):*\n'), sendText);
  assert.deepEqual(tableRows(sendText), sending.map(listed));
  // GRD-010: each email's exact text, one section each, in the order sent.
  const shownTexts = emailTexts(view);
  assert.equal(shownTexts.length, 7);
  assert.ok(view.blocks.length <= 100);
  assert.ok(!/@|invalid/.test(textOf(view)), 'no address in the preview');

  const done = await click(ctx, 'approval-write:approve', token);
  assert.equal(head(done), `*Pushed 7 to email tool*, skipped 6, failed 0. List: ${LIST}.`);
  assert.match(textOf(done), /Skipped rows were never sent: held \(6\)\./);
  const sent = emails(ctx.outbox);
  assert.deepEqual(sent.map((e) => e.payload.external_ref), sending.map((r) => String(r.scheduled_visit_id)), 'the previewed rows, in order');
  for (const [i, e] of sent.entries()) {
    const row = sending[i];
    const want = templates.render(fieldsOf(row));
    assert.equal(e.payload.to, row.email);
    assert.equal(e.payload.kind, 'reminder');
    assert.equal(e.payload.subject, want.subject);
    assert.equal(e.payload.body, want.body);
    assert.equal(e.at, new Date(NOW).toISOString());
    assert.equal(shownTexts[i], `Subject: ${e.payload.subject}\n\n${e.payload.body}`, `email ${i + 1}: the text shown is the text sent`);
  }
  assert.equal(sent[0].payload.body.split('\n')[0], `Hi ${sending[0].first_name},`);
  assert.match(sent[0].payload.subject, /^Reminder: your (Deep|Standard|Move-out) clean on Saturday, October 3, 2026$/);
  assert.deepEqual(ctx.app.posted, []);
});

test('a second Approve, and a new run of the same day, send nothing new', async (t) => {
  const ctx = await boot(t);
  const token = tokenOf(await preview(ctx));
  await click(ctx, 'approval-write:approve', token);
  const before = fs.readFileSync(ctx.outbox, 'utf8');
  const again = await click(ctx, 'approval-write:approve', token);
  assert.match(head(again), /^You already approved this push, so it ran once and I won't send it again\. \*Pushed 7 to email tool\*/);
  assert.equal(fs.readFileSync(ctx.outbox, 'utf8'), before, 'nothing written');
  // Steven, with the same access, runs the same day and approves: nothing new goes.
  const second = await preview(ctx, { person: STEVEN });
  const view = await click(ctx, 'approval-write:approve', tokenOf(second), STEVEN);
  assert.equal(head(view), `*Already sent today; nothing new sent.* email tool already has this list with these rows, so I didn't send it again (skipped 6). List: ${LIST}.`);
  assert.equal(fs.readFileSync(ctx.outbox, 'utf8'), before, 'nothing written');
  assert.equal(emails(ctx.outbox).length, 7);
});

test('BRIGHTSIDE_EMAIL_OFF on before Approve: nothing is sent and the preview stays valid', async (t) => {
  const ctx = await boot(t);
  const token = tokenOf(await preview(ctx));
  ctx.env.BRIGHTSIDE_EMAIL_OFF = '1';
  const view = await click(ctx, 'approval-write:approve', token);
  assert.equal(head(view), `Sending to ${SYSTEM} is switched off right now, so nothing was sent. Please tell your admin.`);
  assert.equal(emails(ctx.outbox).length, 0);
  assert.ok(ctx.store.get('approval', token), 'not consumed');
  delete ctx.env.BRIGHTSIDE_EMAIL_OFF;
  assert.match(head(await click(ctx, 'approval-write:approve', token)), /^\*Pushed 7 to email tool\*/);
});

test('way out, Cancel: nothing is sent, and the preview can no longer be approved', async (t) => {
  const ctx = await boot(t);
  const token = tokenOf(await preview(ctx));
  const view = await click(ctx, 'approval-write:cancel', token);
  assert.equal(head(view), '*Push cancelled.* Nothing was sent to email tool. Run the list again from the menu to start a new one.');
  assert.match(head(await click(ctx, 'approval-write:approve', token)), /^This preview is no longer valid/);
  assert.equal(emails(ctx.outbox).length, 0);
});

test('way out, an expired preview: Approve after 30 minutes sends nothing', async (t) => {
  const ctx = await boot(t);
  const token = tokenOf(await preview(ctx));
  mock.timers.setTime(NOW + 31 * 60 * 1000);
  assert.match(head(await click(ctx, 'approval-write:approve', token)), /^This preview is no longer valid/);
  assert.equal(emails(ctx.outbox).length, 0);
});

test('way out, a partial failure: "Retry the failed ones" sends only the failed email, so each visit gets one', async (t) => {
  const ctx = await boot(t);
  const token = tokenOf(await preview(ctx));
  const stored = ctx.store.get('approval', token);
  const sending = stored.rows.filter((r) => !r.held);
  const failing = String(sending[2].scheduled_visit_id);
  // The archetype over the same outbox, with the mock tool refusing one email.
  const simulate = { failContacts: new Set([failing]) };
  const tool = email.create({ log: testLog(), outboxPath: ctx.outbox, simulate });
  const aw = approvalWrite.createApprovalWrite({ store: ctx.store, log: testLog(), connectors: { get: () => tool } });
  const shown = [];
  const show = async (m) => { shown.push(m); };
  const resolve = () => ({ mod: reminders });
  await aw.click({ verb: 'approve', value: token, person: ELY, resolve, show });
  assert.match(head(shown.at(-1)), new RegExp(`^Sent 6 of 7 to ${SYSTEM.replace(/[()]/g, '\\$&')}; 1 failed\\. Nothing was sent twice, so trying again is safe`));
  assert.equal(emails(ctx.outbox).length, 6);
  const retry = actionsOf(shown.at(-1)).find((b) => b.action_id === 'approval-write:retry');
  assert.equal(retry.text.text, 'Retry the failed ones');
  assert.deepEqual(ctx.store.get('approval', retry.value).rows.map((r) => String(r.scheduled_visit_id)), [failing]);
  simulate.failContacts.delete(failing);
  await aw.click({ verb: 'retry', value: retry.value, person: ELY, resolve, show });
  assert.equal(head(shown.at(-1)), `*Retried 1 that failed: sent 1, failed 0.* List: ${LIST}.`);
  const refs = emails(ctx.outbox).map((e) => e.payload.external_ref);
  assert.deepEqual([...refs].sort(), sending.map((r) => String(r.scheduled_visit_id)).sort(), 'each email once');
});

test('every visit held (East crew A on its absence day): nothing to approve, the held visits listed, nothing sent', async (t) => {
  const ctx = await boot(t);
  const view = await preview(ctx, { zoneOrCrew: 'East crew A' });
  assert.equal(head(view), '*Nothing to push to email tool.* All 6 rows would be skipped: held (6).');
  assert.ok(view.blocks[1].text.text.startsWith(`*Held, not sent: 6.*\n• ${HELD_TEXT} (6)\n`));
  assert.equal(actionsOf(view).some((b) => b.action_id === 'approval-write:approve'), false);
  assert.equal(emails(ctx.outbox).length, 0);
});

test('a day on or before as_of has no visits: no rows, nothing to push', async (t) => {
  const ctx = await boot(t);
  assert.equal(await preview(ctx, { day: '2026-09-30' }), null);
  assert.match(head(ctx.result), /no rows matched these values/);
  assert.equal(emails(ctx.outbox).length, 0);
});

test('a visit held at the first push that is no longer held later the same day is sent then: the push key covers only the visits sent (review P2)', async (t) => {
  const ctx = await boot(t);
  const view1 = await preview(ctx);
  const first = ctx.store.get('approval', tokenOf(view1));
  await click(ctx, 'approval-write:approve', tokenOf(view1));
  assert.equal(emails(ctx.outbox).length, 7);
  // The same 13 visits, run again after the absence was lifted: none held.
  const lifted = first.rows.map((r) => ({ ...r, held: null }));
  const view = await pushRows(ctx, lifted);
  assert.equal(view.blocks[1].text.text, `*List name:* ${LIST}\n*Rows to send:* 13 of 13 rows\n*Skipped:* none`);
  assert.equal(emailTexts(view).length, 13);
  const second = ctx.store.get('approval', tokenOf(view));
  assert.notEqual(second.idempotencyKey, first.idempotencyKey);
  const done = await click(ctx, 'approval-write:approve', tokenOf(view));
  assert.equal(head(done), `*Pushed 6 to email tool* (7 were already there), skipped 0, failed 0. List: ${LIST}.`);
  assert.deepEqual(emails(ctx.outbox).map((e) => e.payload.external_ref).sort(), first.rows.map((r) => String(r.scheduled_visit_id)).sort(), 'each visit once');
});

test('held visits and a visit the email tool refuses in the same run: both skipped with their reasons, the rest sent with the text shown', async (t) => {
  const ctx = await boot(t);
  const { rows } = ctx.store.get('approval', tokenOf(await preview(ctx)));
  const sending = rows.filter((r) => !r.held);
  const refusedId = sending[1].scheduled_visit_id;
  const changed = rows.map((r) => (r.scheduled_visit_id === refusedId ? { ...r, email: 'someone@example.com' } : r));
  const view = await pushRows(ctx, changed);
  assert.equal(view.blocks[1].text.text, `*List name:* ${LIST}\n*Rows to send:* 6 of 13 rows\n*Skipped:* 7: held (6), address refused (1)`);
  assert.ok(view.blocks[2].text.text.startsWith(`*Held, not sent: 6.*\n• ${HELD_TEXT} (6)\n`));
  const going = sending.filter((r) => r.scheduled_visit_id !== refusedId);
  assert.deepEqual(tableRows(view.blocks[3].text.text), going.map((r) => [r.first_name, r.visit_date, r.arrival_window, r.crew_name]));
  const shown = emailTexts(view);
  assert.equal(shown.length, 6);
  const done = await click(ctx, 'approval-write:approve', tokenOf(view));
  assert.equal(head(done), `*Pushed 6 to email tool*, skipped 7, failed 0. List: ${LIST}.`);
  assert.match(textOf(done), /Skipped rows were never sent: held \(6\), address refused \(1\)\./);
  const sent = emails(ctx.outbox);
  assert.deepEqual(sent.map((e) => e.payload.external_ref), going.map((r) => String(r.scheduled_visit_id)));
  assert.deepEqual(sent.map((e) => `Subject: ${e.payload.subject}\n\n${e.payload.body}`), shown, 'the text shown is the text sent');
});

test('a crew short-handed but not out under GRD-008 (West crew B on 2026-10-23: one member absent, its lead present): its visits are held with the short-handed reason', async (t) => {
  const ctx = await boot(t);
  const view = await preview(ctx, { day: '2026-10-23', zoneOrCrew: 'West crew B' });
  const text = 'Held: a member of West crew B is absent that day; the crew works short-handed.';
  assert.equal(head(view), '*Nothing to push to email tool.* All 5 rows would be skipped: held (5).');
  assert.ok(view.blocks[1].text.text.startsWith(`*Held, not sent: 5.*\n• ${text} (5)\n`), view.blocks[1].text.text);
  assert.equal(emails(ctx.outbox).length, 0);
});
