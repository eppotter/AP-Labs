'use strict';

// Story 8.3: the Outbox entry on the /brightside hub shows a permitted person,
// privately, what the mock email tool has received: the latest lists, newest
// first, each with its contact count and a short sample (email and first name
// only). It reads the outbox file only. An example test (architecture
// carve-out): it reads Brightside's app dir and profile, and is deleted with
// the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadProfile } = require('../../../kit/lib/profile');
const { resolveAccess } = require('../../../kit/lib/permissions');
const { AccessDenied } = require('../../../kit/runtime/errors');
const { messageFor } = require('../../../kit/runtime/messages');
const { createRegistry } = require('../../../kit/runtime/registry');
const { registerHubs } = require('../../../kit/runtime/slack/hubs');
const { createStore } = require('../../../kit/runtime/store');
const { testLog } = require('../../../kit/runtime/sdk');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const emailConnector = require('../app/connectors/email/connector');
const { openOutbox } = require('../app/connectors/email/outbox');

const REPO = path.join(__dirname, '..', '..', '..');
const OUTBOX = path.join(__dirname, '..', 'app', 'modules', 'outbox');
const manifest = JSON.parse(fs.readFileSync(path.join(OUTBOX, 'manifest.json'), 'utf8'));
const handler = require(path.join(OUTBOX, manifest.handler));

// A fixture profile, never a client's: an admin (the role confers OUTBOX) and
// a member without it.
const PROFILE = Object.freeze({
  client: { id: 'tiny', name: 'Tiny' },
  resources: [{ key: 'OUTBOX', label: 'Outbox', admin_grantable: true, open_access: false }],
  users: [
    { id: 'ada', name: 'Ada', role: 'admin', identities: { slack: 'UADMIN' }, grants: [], deny: [] },
    { id: 'bo', name: 'Bo', role: 'member', identities: { slack: 'UMEMBER' }, grants: [], deny: [] },
  ],
});
const HUB = Object.freeze({ id: 'brightside', command: '/hub', name: 'Hub', description: 'Hub', file: 'hubs/brightside.json' });

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'outbox', 'email.jsonl');
}

// The hub with the Outbox module, its handler reading file.
function setup(file) {
  const app = new FakeSlackApp({});
  const mod = { ...manifest, file: 'modules/outbox/manifest.json', run: (ctx) => handler(ctx, { file }) };
  const registry = createRegistry({ hubs: [HUB], modules: [mod] });
  registerHubs(app, { registry, profile: PROFILE, env: 'dev', log: testLog(), store: createStore() });
  return app;
}

function list(outbox, key, name, contacts = []) {
  const listId = `list-${key}`;
  outbox.append({ type: 'list', operation: 'createList', key, payload: { listId, name } });
  for (const c of contacts) {
    outbox.append({ type: 'contact', operation: 'addContacts', key: `${key}:${c.external_ref}`, payload: { listId, ...c } });
  }
}

const people = (n, from = 1) => Array.from({ length: n }, (_, i) => ({
  external_ref: String(from + i), email: `p${from + i}@home.invalid`, first_name: `P${from + i}`,
}));

test('the Outbox entry shows a permitted person, privately, the latest lists newest first with counts and a sample', async (t) => {
  const file = tmpFile(t);
  const outbox = openOutbox(file);
  list(outbox, 'a', 'win-back-north-2026-10-23', people(2));
  list(outbox, 'b', 'win-back-south-2026-10-24', people(5, 10));
  const app = setup(file);
  await app.dispatchAction('outbox:open', { user: { id: 'UADMIN', name: 'ada' } });
  assert.equal(app.responded.length, 1);
  const [reply] = app.responded;
  assert.equal(reply.response_type, 'ephemeral');
  const lines = reply.text.split('\n');
  assert.equal(lines[0], '*Email outbox*');
  const south = lines.findIndex((l) => l.startsWith('*win-back-south-2026-10-24*'));
  const north = lines.findIndex((l) => l.startsWith('*win-back-north-2026-10-23*'));
  assert.ok(south > 0 && north > south, 'newest first');
  assert.match(lines[south], /· 5 contacts · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  assert.deepEqual(lines.slice(south + 1, south + 5), ['• P10, p10@home.invalid', '• P11, p11@home.invalid', '• P12, p12@home.invalid', '…and 2 more']);
  assert.match(lines[north], /· 2 contacts ·/);
});

test('the sample shows email and first name only, escaped for Slack, never a phone or an address', async (t) => {
  const file = tmpFile(t);
  list(openOutbox(file), 'x', '<!channel> & friends', [
    { external_ref: '1', email: 'a<b>@home.invalid', first_name: 'Al & <@U123>', phone: '555-0100', street_address: '1 Main St' },
    { external_ref: '2', email: 'no.name@home.invalid', first_name: '' },
  ]);
  const replies = [];
  await handler({ reply: async (m) => replies.push(m) }, { file });
  const text = replies[0];
  assert.match(text, /^\*&lt;!channel&gt; &amp; friends\* · 2 contacts/m);
  assert.match(text, /^• Al &amp; &lt;@U123&gt;, a&lt;b&gt;@home\.invalid$/m);
  assert.match(text, /^• no\.name@home\.invalid$/m);
  assert.ok(!text.includes('555') && !text.includes('Main St'), 'no phone, no address');
  assert.ok(!/<[!@]/.test(text), 'no live mention');
});

test('at most five lists are shown, and the reply says how many there are', async (t) => {
  const file = tmpFile(t);
  const outbox = openOutbox(file);
  for (let i = 1; i <= 7; i += 1) list(outbox, `k${i}`, `list-${i}`);
  const replies = [];
  await handler({ reply: async (m) => replies.push(m) }, { file });
  const names = replies[0].split('\n').filter((l) => /^\*list-\d\*/.test(l)).map((l) => l.match(/^\*(list-\d)\*/)[1]);
  assert.deepEqual(names, ['list-7', 'list-6', 'list-5', 'list-4', 'list-3']);
  assert.match(replies[0], /latest 5 of 7 lists/);
  assert.match(replies[0], /· 0 contacts ·/);
});

test('a torn line in the outbox (which refuses writes) is skipped in the read-only view', async (t) => {
  const file = tmpFile(t);
  list(openOutbox(file), 'a', 'win-back-west', people(2));
  fs.appendFileSync(file, '{"type":"contact","key":"a:3"');
  const replies = [];
  await handler({ reply: async (m) => replies.push(m) }, { file });
  assert.match(replies[0], /^\*win-back-west\* · 2 contacts · /m);
});

test('with nothing sent yet (no outbox file), the person is told so', async (t) => {
  const replies = [];
  await handler({ reply: async (m) => replies.push(m) }, { file: tmpFile(t) });
  assert.equal(replies[0], '*Email outbox*\nNothing has been sent to the email tool yet.');
});

test('a person without access is refused and sees nothing from the outbox', async (t) => {
  const file = tmpFile(t);
  list(openOutbox(file), 'a', 'secret-list', people(1));
  const app = setup(file);
  await app.dispatchAction('outbox:open', { user: { id: 'UMEMBER', name: 'bo' } });
  assert.equal(app.responded.length, 1);
  const words = messageFor(new AccessDenied({ label: 'Outbox', admin: 'ADMIN' })).split('ADMIN')[0];
  assert.ok(app.responded[0].text.startsWith(words), app.responded[0].text);
  assert.ok(!app.responded[0].text.includes('secret-list'));
  assert.equal(app.responded[0].response_type, 'ephemeral');
});

test('what the mock email tool writes is what the Outbox shows', async (t) => {
  const file = tmpFile(t);
  const email = emailConnector.create({ log: testLog(), env: { BRIGHTSIDE_EMAIL_KEY: 'mock-email-key-not-a-secret' }, outboxPath: file });
  const { listId } = await email.write.createList({ name: 'win-back-east-2026-10-24', idempotencyKey: 'L', dryRun: false });
  await email.write.addContacts({ listId, contacts: people(4), idempotencyKey: 'L', dryRun: false });
  await email.write.addContacts({ listId, contacts: people(4), idempotencyKey: 'L', dryRun: false });
  const replies = [];
  await handler({ reply: async (m) => replies.push(m) }, { file });
  assert.match(replies[0], /^\*win-back-east-2026-10-24\* · 4 contacts · /m, 'the repeat added nothing');
  assert.match(replies[0], /^…and 1 more$/m);
});

test('Brightside gates the Outbox: a declared resource, not open to everyone, that its admin role confers', () => {
  const profile = loadProfile(path.join(REPO, 'profiles', 'brightside', 'profile.yml'));
  const resource = profile.resources.find((r) => r.key === manifest.resource);
  assert.ok(resource, `the profile declares ${manifest.resource}`);
  assert.equal(resource.open_access, false);
  const admin = profile.users.find((u) => u.role === 'admin');
  const member = profile.users.find((u) => u.role !== 'admin' && !u.grants.includes(manifest.resource));
  assert.equal(resolveAccess(profile, admin.id, manifest.resource), 'allowed');
  assert.equal(resolveAccess(profile, member.id, manifest.resource), 'denied');
  assert.equal(resolveAccess(profile, undefined, manifest.resource), 'denied', 'not for someone outside the profile');
});

test('the outbox file is gitignored', () => {
  const r = spawnSync('git', ['check-ignore', '-q', 'var/outbox/email.jsonl'], { cwd: REPO });
  assert.equal(r.status, 0, 'var/outbox/email.jsonl is not ignored');
});

test('the Outbox handler reads no data and declares no parameters', () => {
  assert.equal(manifest.archetype, 'handler');
  assert.equal(manifest.parameters, undefined);
  assert.equal(manifest.hub, 'brightside');
});
