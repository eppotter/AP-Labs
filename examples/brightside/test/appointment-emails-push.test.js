'use strict';

// Story 20.1, Connector review P1: an appointment-email push end to end through
// the approval-write archetype's createPush and the mock email tool's
// sendEmails. The push reads the connector's { added, alreadyAdded } answer, so
// emails already sent are reported as already there, never as sent again; a
// new push (another key) of the same emails sends nothing; and the day limit
// is its own refusal ("today's email limit is reached"), not escalated. The
// approval-write archetype is unchanged here (its push key is Story 20.3's).
// An example test: it uses the Brightside email connector and is deleted with
// the example in a fork.

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../../kit/runtime/store');
const entry = require('../../../kit/runtime/archetypes/approval-write/entry');
const { createPush } = require('../../../kit/runtime/archetypes/approval-write/push');
const { testLog } = require('../../../kit/runtime/sdk');
const connector = require('../app/connectors/email/connector');
const { openOutbox } = require('../app/connectors/email/outbox');

const NOW = Date.parse('2026-11-01T15:00:00Z');
test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: NOW }));
test.afterEach(() => mock.timers.reset());

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const PERSON = 'U0TESTPERSON';
const LIST = 'appointment-reminders-2026-10-01';

// A stand-in module in the shape the archetype reads: the row id and the
// connector fields mapped from the row's columns.
const MOD = Object.freeze({
  id: 'appointment-reminders',
  label: 'Appointment reminders',
  row_id: 'scheduled_visit_id',
  write: {
    connector: 'email',
    operation: 'sendEmails',
    destination: 'the email tool',
    send: {
      external_ref: 'scheduled_visit_id',
      email: 'email',
      first_name: 'first_name',
      kind: 'kind',
      visit_date: 'visit_date',
      window: 'window',
      crew_id: 'crew_id',
      crew_name: 'crew_name',
      package_name: 'package_name',
    },
  },
});

const rows = (ids) => ids.map((id) => ({
  scheduled_visit_id: id,
  email: `p${id}@home.invalid`,
  first_name: `P${id}`,
  kind: 'reminder',
  visit_date: '2026-10-01',
  window: 'morning',
  crew_id: 4,
  crew_name: 'South crew A',
  package_name: 'Deep clean',
}));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-appt-push-'));
  dirs.push(dir);
  const file = path.join(dir, 'outbox', 'email.jsonl');
  const instance = connector.create({
    log: testLog(), env: {}, outboxPath: file, now: () => Date.now(), sleep: async () => {},
  });
  const store = createStore();
  const escalations = [];
  const push = createPush({
    store,
    log: testLog(),
    connectors: { get: (id) => (id === 'email' ? instance : null) },
    admin: 'your admin',
    escalate: async (e) => { escalations.push(e); },
  });
  const shown = [];
  // One approval entry for the rows, approved by the person.
  async function approve(r, listName = LIST) {
    const token = entry.create(store, {
      person: PERSON,
      module: MOD.id,
      runId: `run-${shown.length}`,
      destination: MOD.write.destination,
      listName,
      rows: r,
      idempotencyKey: entry.idempotencyKey(listName, r.map((x) => x.scheduled_visit_id)),
    });
    await push.approve({
      token, person: PERSON, resolve: () => ({ mod: MOD }), show: async (m) => { shown.push(m); }, client: {},
    });
    return shown.at(-1).blocks[0].text.text;
  }
  const emails = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'email') : []);
  return {
    approve, emails, escalations, file,
  };
}

test('a push of appointment emails reports what was sent; a new push of the same emails sends nothing and says they were already there', async () => {
  const ctx = setup();
  assert.equal(await ctx.approve(rows([11, 12, 13])), `*Pushed 3 to the email tool*, skipped 0, failed 0. List: ${LIST}.`);
  assert.equal(ctx.emails().length, 3);
  // Another list name, so another push key: the emails are already sent.
  const again = await ctx.approve(rows([11, 12, 13]), `${LIST}-again`);
  assert.equal(again, `*Pushed 0 to the email tool* (3 were already there), skipped 0, failed 0. List: ${LIST}-again.`);
  // One new among the old: only the new one goes, and is counted as sent.
  const mixed = await ctx.approve(rows([11, 12, 14]), `${LIST}-mixed`);
  assert.equal(mixed, `*Pushed 1 to the email tool* (2 were already there), skipped 0, failed 0. List: ${LIST}-mixed.`);
  assert.deepEqual(ctx.emails().map((e) => e.payload.external_ref), ['11', '12', '13', '14']);
  assert.deepEqual(ctx.escalations, []);
});

test('over the day limit the push says "today\'s email limit is reached", sends nothing, and is not escalated', async () => {
  const ctx = setup();
  // 199 emails already sent today.
  const outbox = openOutbox(ctx.file);
  for (let i = 0; i < 199; i += 1) {
    outbox.append({
      type: 'email', operation: 'sendEmails', key: `email:reminder:${1000 + i}:seed`, payload: { push: 'seed', external_ref: String(1000 + i) },
    });
  }
  const text = await ctx.approve(rows([21, 22]));
  assert.equal(text, "Today's email limit is reached (200 a day), so nothing was sent. Try again tomorrow. Skipped 0.");
  assert.equal(ctx.emails().length, 199);
  assert.deepEqual(ctx.escalations, [], 'a limit is not an outage');
  // One more fits.
  assert.equal(await ctx.approve(rows([21]), `${LIST}-one`), `*Pushed 1 to the email tool*, skipped 0, failed 0. List: ${LIST}-one.`);
});
