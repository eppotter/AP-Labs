'use strict';

// The mock email tool's appointment emails (Story 20.1, plan brightside-v1
// D14, D14a, GRD-010): sendEmails and ./templates.js. The exact text for a
// fixture visit, only D14's fields, the strict .invalid address parse, the
// limits (50 a push, 200 a day, with every clock frozen), per-email keys, and
// a partial failure with its retry. The contract suite covers sendEmails in
// ./connector.test.js. Every test writes to its own temporary outbox.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  testLog, ConnectorFailed, IdempotencyConflict, PartialFailure,
} = require('#sdk');
const connector = require('./connector');
const templates = require('./templates');

// A clock that moves only when the connector sleeps (as the contract suite's).
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function freshPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-emails-'));
  dirs.push(dir);
  return path.join(dir, 'outbox', 'email.jsonl');
}

// An instance over a fresh outbox, with the contract's clock injected (so a
// test that freezes Date freezes every clock the write reads).
function email({ file = freshPath(), simulate } = {}) {
  const requests = [];
  const clock = fakeClock();
  const instance = connector.create({
    log: testLog(), env: {}, outboxPath: file, simulate, now: clock.now, sleep: clock.sleep, onRequest: (r) => requests.push(r),
  });
  const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    instance, file, requests, sent: () => lines().filter((l) => l.type === 'email'),
  };
}

const live = { dryRun: false };
const NAME = 'appointment-reminders-2026-10-01';

// The fixture's scheduled visit 2 (2026-10-01, morning, crew 4 "South crew
// A", package "deep"), its client 67's first name and email.
const VISIT = Object.freeze({
  external_ref: '2',
  email: 'rain.highbrook.67@home.invalid',
  first_name: 'Rain',
  kind: 'reminder',
  visit_date: '2026-10-01',
  window: 'morning',
  crew_name: 'South crew A',
  package_name: 'Deep clean',
});
const CHANGE = Object.freeze({
  ...VISIT,
  kind: 'change',
  visit_date: '2026-10-02',
  window: 'afternoon',
  before_date: '2026-10-01',
  before_window: 'morning',
  before_crew_name: 'South crew A',
  reason: 'cancellation',
});

const reminders = (count, from = 1) => Array.from({ length: count }, (_, i) => ({
  ...VISIT, external_ref: String(from + i), email: `p${from + i}@home.invalid`, first_name: `P${from + i}`,
}));

const REMINDER_BODY = [
  'Hi Rain,',
  '',
  'This is a reminder of your Deep clean on Thursday, October 1, 2026. South crew A will arrive in the morning.',
  '',
  "Need to change it? Reply to this email, or call us on 555-0100, and we'll find a time that suits you.",
  '',
  'The Brightside Home Cleaning team',
].join('\n');

const CHANGE_BODY = [
  'Hi Rain,',
  '',
  "We've changed your Deep clean. It is now on Friday, October 2, 2026, in the afternoon, with South crew A.",
  '',
  'What changed:',
  '- Day: Friday, October 2, 2026 (before: Thursday, October 1, 2026)',
  '- Arrival window: afternoon (before: morning)',
  '',
  'Why: an earlier slot opened up.',
  '',
  'Sorry for the change.',
  '',
  "Reply to this email, or call us on 555-0100, and we'll find a time that suits you.",
  '',
  'The Brightside Home Cleaning team',
].join('\n');

test('templates: the exact reminder and change notice for a fixture visit', () => {
  const { external_ref: _r, email: _e, ...reminder } = VISIT;
  assert.deepEqual({ ...templates.render(reminder) }, {
    kind: 'reminder', subject: 'Reminder: your Deep clean on Thursday, October 1, 2026', body: REMINDER_BODY,
  });
  const { external_ref: _r2, email: _e2, ...change } = CHANGE;
  assert.deepEqual({ ...templates.render(change) }, {
    kind: 'change', subject: 'Your Deep clean has changed: now Friday, October 2, 2026', body: CHANGE_BODY,
  });
});

test('templates: a crew change lists the crew; each source has its fixed reason line', () => {
  const { external_ref: _r, email: _e, ...change } = CHANGE;
  const crew = templates.render({ ...change, visit_date: '2026-10-01', window: 'morning', crew_name: 'South crew B', reason: 'crew-out' });
  assert.match(crew.body, /\nWhat changed:\n- Crew: South crew B \(before: South crew A\)\n\nWhy: our team for that day is unavailable\.\n/);
  assert.equal(Object.keys(templates.REASONS).length, 4);
  for (const [reason, line] of [
    ['route-editor', "we've improved the day's route"],
    ['cancellation', 'an earlier slot opened up'],
    ['crew-out', 'our team for that day is unavailable'],
    ['add-stop', "we've adjusted the day's schedule"],
  ]) assert.ok(templates.render({ ...change, reason }).body.includes(`\nWhy: ${line}.\n`), reason);
});

test('templates: only D14\'s fields; a reminder takes no before values; a change must change something', () => {
  const { external_ref: _r, email: _e, ...reminder } = VISIT;
  const { external_ref: _r2, email: _e2, ...change } = CHANGE;
  for (const [what, fields, words] of [
    ['a street address', { ...reminder, street_address: '1 Elm St' }, /fields not allowed in an email: street_address/],
    ['a price', { ...reminder, price_cents: 26000 }, /fields not allowed in an email: price_cents/],
    ['an email address', { ...reminder, email: 'a@b.invalid' }, /fields not allowed in an email: email/],
    ['another kind', { ...reminder, kind: 'promo' }, /kind must be one of reminder, change/],
    ['an evening window', { ...reminder, window: 'evening' }, /window must be one of morning, afternoon/],
    ['a date that is not a date', { ...reminder, visit_date: '2026-02-30' }, /visit_date must be a real date/],
    ['a timestamp', { ...reminder, visit_date: '2026-10-01T09:00:00Z' }, /visit_date must be a date/],
    ['no first name', { ...reminder, first_name: '  ' }, /first_name must not be empty/],
    ['a line break in a name', { ...reminder, first_name: 'Rain\nCall 555-0199' }, /first_name must be one line/],
    ['a long crew name', { ...reminder, crew_name: 'x'.repeat(61) }, /crew_name must be at most 60/],
    ['a number as a package', { ...reminder, package_name: 26000 }, /package_name must be a string/],
    ['a reminder with before values', { ...reminder, before_date: '2026-09-30' }, /a reminder takes no before_date/],
    ['a reminder with a reason', { ...reminder, reason: 'cancellation' }, /a reminder takes no reason/],
    ['a change without before values', { ...change, before_crew_name: null }, /before_crew_name must be a string/],
    ['a free-text reason', { ...change, reason: 'we felt like it' }, /reason must be one of/],
    ['a change that changes nothing', { ...change, visit_date: '2026-10-01', window: 'morning' }, /needs a changed date, window or crew/],
  ]) assert.throws(() => templates.render(fields), words, what);
  // Absent optional fields may come as null (the archetype maps a missing field to null).
  assert.equal(templates.render({ ...reminder, before_date: null, reason: null }).kind, 'reminder');
});

test('sendEmails: the dry run renders each email; apply sends exactly what was previewed', async () => {
  const { instance, file, requests, sent } = email();
  const input = { name: NAME, contacts: [VISIT, { ...CHANGE, external_ref: '9' }], idempotencyKey: 'push-1' };
  const dry = await instance.write.sendEmails(input);
  assert.equal(dry.dryRun, true);
  assert.equal(requests.length, 0, 'a dry run calls nothing');
  assert.equal(fs.existsSync(file), false, 'a dry run writes nothing');
  assert.deepEqual(dry.wouldWrite, {
    name: NAME,
    send: 2,
    skipped: [],
    emails: [
      { ref: '2', to: 'rain.highbrook.67@home.invalid', kind: 'reminder', subject: 'Reminder: your Deep clean on Thursday, October 1, 2026', body: REMINDER_BODY },
      { ref: '9', to: 'rain.highbrook.67@home.invalid', kind: 'change', subject: 'Your Deep clean has changed: now Friday, October 2, 2026', body: CHANGE_BODY },
    ],
    limits: { perPush: 50, perDay: 200 },
  });

  const res = await instance.write.sendEmails({ ...input, ...live });
  assert.deepEqual(res, { sent: 2, alreadySent: 0, skipped: 0 });
  const out = sent();
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => ({ ref: r.payload.external_ref, to: r.payload.to, kind: r.payload.kind, subject: r.payload.subject, body: r.payload.body })), dry.wouldWrite.emails);
  for (const r of out) {
    assert.deepEqual(Object.keys(r.payload).sort(), ['body', 'external_ref', 'kind', 'push', 'subject', 'to'], 'the outbox holds the email and nothing else');
    assert.equal(r.payload.push, NAME);
    assert.equal(r.operation, 'sendEmails');
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // The request answered only counts.
  assert.equal(requests.length, 1);
});

test('sendEmails: any other field on a contact is refused, dry run and live, before any I/O', async () => {
  const { instance, file, requests } = email();
  for (const bad of [
    [{ ...VISIT, street_address: '3672 Station Way' }],
    [{ ...VISIT, postal_code: '00120' }],
    [{ ...VISIT, base_price_cents: 26000 }],
    [{ ...VISIT, phone: '555-0187' }],
    [{ ...VISIT, external_ref: undefined }],
    [VISIT, VISIT],
    [{ ...VISIT, kind: 'change' }],
  ]) {
    for (const dryRun of [true, false]) {
      await assert.rejects(instance.write.sendEmails({ name: NAME, contacts: bad, idempotencyKey: 'bad', dryRun }), ConnectorFailed);
    }
  }
  assert.equal(requests.length, 0);
  assert.equal(fs.existsSync(file), false);
});

test('sendEmails: the strict address parse refuses everything but one plain lower-case .invalid address', async () => {
  const refused = [
    ['two addresses', 'rain@home.invalid,ash@home.invalid'],
    ['two addresses, spaced', 'rain@home.invalid ash@home.invalid'],
    ['a display name', 'Rain Highbrook <rain@home.invalid>'],
    ['a quoted display name', '"Rain" <rain@home.invalid>'],
    ['a comma', 'rain,highbrook@home.invalid'],
    ['whitespace', ' rain@home.invalid'],
    ['whitespace inside', 'rain @home.invalid'],
    ['a tab', 'rain@home.invalid\t'],
    ['a trailing dot', 'rain@home.invalid.'],
    ['upper case', 'Rain@home.invalid'],
    ['upper case in the domain', 'rain@home.INVALID'],
    ['a .com', 'rain@home.com'],
    ['.invalid not at the end', 'rain@home.invalid.com'],
    ['no domain label', 'rain@.invalid'],
    ['no @', 'rain.home.invalid'],
    ['two @', 'rain@x@home.invalid'],
    ['a leading dot', '.rain@home.invalid'],
    ['two dots', 'rain..h@home.invalid'],
    ['a line break', 'rain@home.invalid\nbcc@home.invalid'],
    ['too long', `${'a'.repeat(250)}@x.invalid`],
    ['not a string', 42],
  ];
  for (const [what, address] of refused) assert.equal(connector.isAllowedAddress(address), false, what);
  for (const ok of ['rain.highbrook.67@home.invalid', 'p1@inbox.invalid', 'a+b_c-d@mail.post.invalid']) assert.equal(connector.isAllowedAddress(ok), true, ok);

  // Through sendEmails: each refused address is skipped with a short reason,
  // in the dry run and in apply alike, and never reaches the outbox.
  const { instance, sent } = email();
  const contacts = refused.map(([, address], i) => ({ ...VISIT, external_ref: String(i + 10), email: address }));
  contacts.push({ ...VISIT, external_ref: '99', email: null }, { ...VISIT, external_ref: '98', email: '' }, VISIT);
  const input = { name: NAME, contacts, idempotencyKey: 'parse' };
  const dry = await instance.write.sendEmails(input);
  assert.equal(dry.wouldWrite.send, 1);
  assert.deepEqual(dry.wouldWrite.emails.map((e) => e.to), [VISIT.email]);
  assert.deepEqual(dry.wouldWrite.skipped, [
    ...refused.map((_, i) => ({ ref: String(i + 10), reason: 'address refused' })),
    { ref: '99', reason: 'no email' },
    { ref: '98', reason: 'no email' },
  ]);
  assert.deepEqual(await instance.write.sendEmails({ ...input, ...live }), { sent: 1, alreadySent: 0, skipped: refused.length + 2 });
  assert.deepEqual(sent().map((r) => r.payload.to), [VISIT.email], 'only the .invalid address reached the outbox');
});

test('sendEmails: 50 emails a push go; 51 are refused whole, dry run and live, and nothing is sent', async () => {
  const { instance, requests, sent } = email();
  for (const dryRun of [true, false]) {
    await assert.rejects(
      instance.write.sendEmails({ name: NAME, contacts: reminders(51), idempotencyKey: 'p51', dryRun }),
      (err) => err instanceof ConnectorFailed && /51 emails is over the limit of 50 a push, so none is sent/.test(err.reason),
    );
  }
  assert.equal(requests.length, 0);
  assert.equal(sent().length, 0);
  assert.equal((await instance.write.sendEmails({ name: NAME, contacts: reminders(50), idempotencyKey: 'p50' })).wouldWrite.send, 50);
  assert.deepEqual(await instance.write.sendEmails({ name: NAME, contacts: reminders(50), idempotencyKey: 'p50', ...live }), { sent: 50, alreadySent: 0, skipped: 0 });
  assert.equal(sent().length, 50);
});

test('sendEmails: 200 emails a day go; the 201st is refused whole, and the next UTC day starts again (frozen clock)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T09:00:00Z') });
  const { instance, sent } = email();
  for (let push = 0; push < 4; push += 1) {
    const res = await instance.write.sendEmails({ name: NAME, contacts: reminders(50, push * 50 + 1), idempotencyKey: `day-${push}`, ...live });
    assert.equal(res.sent, 50);
  }
  assert.equal(sent().length, 200);
  // A repeat of a push already sent is no new email, so it is not refused.
  assert.deepEqual(await instance.write.sendEmails({ name: NAME, contacts: reminders(50, 1), idempotencyKey: 'day-0', ...live }), { sent: 50, alreadySent: 0, skipped: 0 });
  await assert.rejects(
    instance.write.sendEmails({ name: NAME, contacts: reminders(2, 201), idempotencyKey: 'day-4', ...live }),
    (err) => err instanceof ConnectorFailed && /sent 200 emails today; 2 more is over the limit of 200 a day, so none is sent/.test(err.reason),
  );
  assert.equal(sent().length, 200, 'none of the push was sent');
  // Late the same UTC day: still refused. The next UTC day: sent.
  t.mock.timers.setTime(Date.parse('2026-11-01T23:59:59Z'));
  await assert.rejects(instance.write.sendEmails({ name: NAME, contacts: reminders(1, 201), idempotencyKey: 'day-5', ...live }), ConnectorFailed);
  t.mock.timers.setTime(Date.parse('2026-11-02T00:00:00Z'));
  // A refused write did not use up its key: the same key and input go now.
  assert.deepEqual(await instance.write.sendEmails({ name: NAME, contacts: reminders(2, 201), idempotencyKey: 'day-4', ...live }), { sent: 2, alreadySent: 0, skipped: 0 });
  assert.deepEqual(sent().slice(-2).map((r) => r.at.slice(0, 10)), ['2026-11-02', '2026-11-02']);
});

test('sendEmails: a repeat sends nothing; a different change to the same visit is a new email', async () => {
  const { instance, sent } = email();
  const first = { name: NAME, contacts: [CHANGE], idempotencyKey: 'push-a', ...live };
  assert.deepEqual(await instance.write.sendEmails(first), { sent: 1, alreadySent: 0, skipped: 0 });
  assert.deepEqual(await instance.write.sendEmails(first), { sent: 1, alreadySent: 0, skipped: 0 }, 'the repeat returns the first result');
  assert.equal(sent().length, 1, 'and sends nothing');
  await assert.rejects(instance.write.sendEmails({ ...first, contacts: [{ ...CHANGE, window: 'morning', crew_name: 'South crew B' }] }), IdempotencyConflict);

  // Under the same list key (the archetype's first-push key, kept on a
  // retry), the same change under a new write key is no new email...
  const base = { name: NAME, listKey: 'push-b', ...live };
  assert.deepEqual(await instance.write.sendEmails({ ...base, contacts: [CHANGE], idempotencyKey: 'push-b' }), { sent: 1, alreadySent: 0, skipped: 0 });
  assert.deepEqual(await instance.write.sendEmails({ ...base, contacts: [CHANGE], idempotencyKey: 'push-b-retry' }), { sent: 0, alreadySent: 1, skipped: 0 });
  // ...and a different change to the same visit (another crew) is.
  const moved = { ...CHANGE, window: 'morning', crew_name: 'South crew B', reason: 'crew-out' };
  assert.deepEqual(await instance.write.sendEmails({ ...base, contacts: [moved], idempotencyKey: 'push-b-2' }), { sent: 1, alreadySent: 0, skipped: 0 });
  const keys = sent().map((r) => r.key);
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 3);
  for (const k of keys.slice(1)) assert.match(k, /^push-b:change:2:[0-9a-f]{12}$/, 'the key: the push, the kind, the visit and a hash of the change');
  // A reminder for the same visit is a different email from its change notice.
  assert.deepEqual(await instance.write.sendEmails({ ...base, contacts: [{ ...VISIT, visit_date: CHANGE.visit_date, window: CHANGE.window }], idempotencyKey: 'push-b-3' }), { sent: 1, alreadySent: 0, skipped: 0 });
});

test('sendEmails: a refused email records the others and fails with refs only; a retry sends only the failed one', async () => {
  const simulate = { failContacts: new Set(['2']) };
  const { instance, sent } = email({ simulate });
  const input = { name: NAME, contacts: reminders(3), idempotencyKey: 'partial', ...live };
  await assert.rejects(instance.write.sendEmails(input), (err) => {
    assert.ok(err instanceof PartialFailure, `got ${err && err.name}`);
    assert.deepEqual([err.details.succeeded, err.details.failed, [...err.details.failedRefs]], [2, 1, ['2']]);
    assert.equal(err.details.retrySafe, true);
    assert.ok(!JSON.stringify(err.details).includes('@'), 'no address in the details');
    assert.ok(!err.message.includes('@'));
    return true;
  });
  assert.deepEqual(sent().map((r) => r.payload.external_ref), ['1', '3']);
  simulate.failContacts.clear();
  assert.deepEqual(await instance.write.sendEmails(input), { sent: 1, alreadySent: 2, skipped: 0 });
  assert.deepEqual(sent().map((r) => r.payload.external_ref), ['1', '3', '2'], 'each email once');
});

test('sendEmails: a list name and a list key are checked', async () => {
  const { instance } = email();
  await assert.rejects(instance.write.sendEmails({ name: '', contacts: [VISIT], idempotencyKey: 'n' }), ConnectorFailed);
  await assert.rejects(instance.write.sendEmails({ name: NAME, contacts: [VISIT], idempotencyKey: 'n', listKey: '', ...live }), ConnectorFailed);
  await assert.rejects(instance.write.sendEmails({ name: NAME, contacts: [], idempotencyKey: 'n' }), ConnectorFailed);
});
