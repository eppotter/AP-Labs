'use strict';

// The mock email tool's own test: the shared contract suite, then what its
// writes leave in the outbox: create, add, a repeated key, a restart, both
// kill switches and a simulated row failure. Every test writes to its own
// temporary outbox, never var/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  connectorContract, testLog, KillSwitchOn, ConnectorFailed, IdempotencyConflict,
} = require('#sdk');
const connector = require('./connector');
const { openOutbox, outboxPath } = require('./outbox');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A path in a new temporary directory; the file itself is not created.
function freshPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-email-'));
  dirs.push(dir);
  return path.join(dir, 'outbox', 'email.jsonl');
}

const contacts = (count, from = 1) => Array.from({ length: count }, (_, i) => ({
  external_ref: String(from + i), email: `p${from + i}@home.invalid`, first_name: `P${from + i}`,
}));

// The contract suite creates a fresh instance per check; the getter gives each
// one its own outbox, holding one list for the addContacts samples to use.
const SUITE_LIST = 'list-suite';
connectorContract(connector, {
  read: {},
  write: {
    createList: (idempotencyKey) => ({ name: 'win-back-north-2026-10-24', idempotencyKey }),
    addContacts: (idempotencyKey) => ({ listId: SUITE_LIST, contacts: contacts(3), idempotencyKey }),
  },
  bulk: { operation: 'addContacts', input: (count, idempotencyKey) => ({ listId: SUITE_LIST, contacts: contacts(count), idempotencyKey }) },
}, {
  deps: {
    get outboxPath() {
      const file = freshPath();
      openOutbox(file).append({ type: 'list', operation: 'createList', key: 'suite-seed', payload: { listId: SUITE_LIST, name: 'suite' } });
      return file;
    },
  },
});

// Not a credential: the mock checks only that the key is set.
const KEY = Object.freeze({ BRIGHTSIDE_EMAIL_KEY: 'mock-email-key-not-a-secret' });

function email({ file = freshPath(), env = {}, simulate } = {}) {
  const requests = [];
  const instance = connector.create({ log: testLog(), env: { ...KEY, ...env }, outboxPath: file, simulate, onRequest: (r) => requests.push(r) });
  return { instance, file, requests, lines: () => readLines(file) };
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const live = { dryRun: false };

test('email: a mock with a stand-in key, its own kill switch, and two writes', () => {
  assert.equal(connector.id, 'email');
  assert.deepEqual([...connector.auth.env], ['BRIGHTSIDE_EMAIL_KEY']);
  assert.equal(connector.killSwitchEnv, 'BRIGHTSIDE_EMAIL_OFF');
  assert.deepEqual([...connector.write].sort(), ['addContacts', 'createList']);
  assert.deepEqual([...connector.read], []);
  assert.deepEqual({ ...connector.rateLimit }, { perSecond: 5, batchSize: 100 });
});

test('email: the outbox defaults to var/outbox/email.jsonl, under APLABS_VAR_DIR when set', () => {
  assert.equal(outboxPath({}), path.resolve('var', 'outbox', 'email.jsonl'));
  assert.equal(outboxPath({ APLABS_VAR_DIR: '/v' }), path.join('/v', 'outbox', 'email.jsonl'));
});

test('email: creating a list records it with its key; the file is created on first use', async () => {
  const { instance, file, lines } = email();
  const dry = await instance.write.createList({ name: 'win-back-north-2026-10-24', idempotencyKey: 'k1' });
  assert.deepEqual(dry, { dryRun: true, operation: 'createList', wouldWrite: { create: 'list', name: 'win-back-north-2026-10-24' } });
  assert.equal(fs.existsSync(file), false, 'a dry run writes nothing');

  const list = await instance.write.createList({ name: 'win-back-north-2026-10-24', idempotencyKey: 'k1', ...live });
  assert.match(list.listId, /^list-[0-9a-f]{12}$/);
  assert.equal(list.name, 'win-back-north-2026-10-24');
  const recorded = lines().filter((l) => l.type === 'list');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].key, 'k1');
  assert.equal(recorded[0].operation, 'createList');
  assert.deepEqual(recorded[0].payload, { listId: list.listId, name: 'win-back-north-2026-10-24' });
  assert.ok(!Number.isNaN(Date.parse(recorded[0].at)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'contact data: readable by the owner only');
});

test('email: adding contacts records each with its own key, and only email, first name and ref', async () => {
  const { instance, lines } = email();
  const { listId } = await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live });
  const res = await instance.write.addContacts({ listId, contacts: contacts(3), idempotencyKey: 'L', ...live });
  assert.deepEqual(res, { listId, added: 3, alreadyAdded: 0 });
  const recorded = lines().filter((l) => l.type === 'contact');
  assert.deepEqual(recorded.map((l) => l.key), [`L:${listId}:1`, `L:${listId}:2`, `L:${listId}:3`]);
  assert.deepEqual(recorded[0].payload, { listId, external_ref: '1', email: 'p1@home.invalid', first_name: 'P1' });
});

test('email: a contact with any other field (a phone, an address) is refused, before any I/O', async () => {
  const { instance, requests, file } = email();
  for (const bad of [
    [{ ...contacts(1)[0], phone: '555' }],
    [{ external_ref: '1', first_name: 'No email' }],
    [{ email: 'x@home.invalid' }],
    [...contacts(1), ...contacts(1)],
  ]) {
    await assert.rejects(instance.write.addContacts({ listId: 'list-x', contacts: bad, idempotencyKey: 'bad', ...live }), ConnectorFailed);
    await assert.rejects(instance.write.addContacts({ listId: 'list-x', contacts: bad, idempotencyKey: 'bad' }), ConnectorFailed, 'a dry run checks too');
  }
  assert.equal(requests.length, 0);
  assert.equal(fs.existsSync(file), false);
});

test('email: adding to a list the tool does not have fails, and records nothing', async () => {
  const { instance, lines } = email();
  await assert.rejects(instance.write.addContacts({ listId: 'list-nope', contacts: contacts(1), idempotencyKey: 'x', ...live }), /no list list-nope/);
  assert.deepEqual(lines().filter((l) => l.type === 'contact'), []);
});

test('email: a repeated key adds nothing, in the same process or after a restart', async () => {
  const { instance, file, lines } = email();
  const list = await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live });
  const first = await instance.write.addContacts({ listId: list.listId, contacts: contacts(2), idempotencyKey: 'L', ...live });
  const before = lines().length;

  assert.deepEqual(await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live }), list);
  assert.deepEqual(await instance.write.addContacts({ listId: list.listId, contacts: contacts(2), idempotencyKey: 'L', ...live }), first);
  assert.equal(lines().length, before, 'the repeat appended nothing');

  // A new process reads the outbox as its idempotency store.
  const restarted = email({ file });
  assert.deepEqual(await restarted.instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live }), list);
  assert.deepEqual(await restarted.instance.write.addContacts({ listId: list.listId, contacts: contacts(2), idempotencyKey: 'L', ...live }), first);
  assert.equal(restarted.requests.length, 0, 'the repeat called nothing');
  assert.equal(lines().length, before);
  await assert.rejects(
    restarted.instance.write.addContacts({ listId: list.listId, contacts: contacts(3), idempotencyKey: 'L', ...live }),
    IdempotencyConflict,
    'the same key with other contacts is refused, after a restart too',
  );
  assert.equal(lines().length, before);
});

test('email: the same list name under a new key (a later day\'s run) is a new list', async () => {
  const { instance } = email();
  const a = await instance.write.createList({ name: 'l', idempotencyKey: 'day-1', ...live });
  const b = await instance.write.createList({ name: 'l', idempotencyKey: 'day-2', ...live });
  assert.notEqual(a.listId, b.listId);
});

for (const name of ['BRIGHTSIDE_EMAIL_OFF', 'APLABS_WRITES_OFF']) {
  test(`email: with ${name} set, every write is refused before any I/O`, async () => {
    const { instance, file, requests } = email({ env: { [name]: '1' } });
    for (const input of [{ name: 'l', idempotencyKey: 'L' }, { name: 'l', idempotencyKey: 'L', ...live }]) {
      await assert.rejects(instance.write.createList(input), (err) => err instanceof KillSwitchOn && err.details.env === name);
    }
    await assert.rejects(instance.write.addContacts({ listId: 'list-x', contacts: contacts(1), idempotencyKey: 'L', ...live }), KillSwitchOn);
    assert.equal(requests.length, 0);
    assert.equal(fs.existsSync(file), false, 'the outbox was not even created');
  });
}

test('email: a simulated row failure records the others, reports both counts, and a retry sends only the failed one', async () => {
  const simulate = { failContacts: new Set(['2']) };
  const { instance, file, lines } = email({ simulate });
  const { listId } = await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live });
  const input = { listId, contacts: contacts(3), idempotencyKey: 'L', ...live };

  await assert.rejects(instance.write.addContacts(input), (err) => {
    assert.ok(err instanceof ConnectorFailed);
    assert.match(err.reason, /2 of 3 contacts added, 1 failed \(external_ref 2: the email tool refused the address\)/);
    return true;
  });
  const recorded = () => lines().filter((l) => l.type === 'contact').map((l) => l.key);
  assert.deepEqual(recorded(), [`L:${listId}:1`, `L:${listId}:3`], 'the failed contact recorded no key');
  assert.equal(lines().filter((l) => l.type === 'done' && l.operation === 'addContacts').length, 0, 'the failed call did not use up its key');

  // A retry after a restart, with the failure cleared: only contact 2 is new.
  simulate.failContacts.clear();
  const retried = email({ file, simulate });
  assert.deepEqual(await retried.instance.write.addContacts(input), { listId, added: 1, alreadyAdded: 2 });
  assert.deepEqual(recorded(), [`L:${listId}:1`, `L:${listId}:3`, `L:${listId}:2`]);
  // Now it is done: one more repeat adds nothing.
  const n = lines().length;
  await retried.instance.write.addContacts(input);
  assert.equal(lines().length, n);
});

// A misread outbox must never cause a duplicate send: if the file can't be
// read, or a line in it is torn or corrupt, every write is refused and the
// file is left as it was, until someone repairs it.
for (const [what, damage] of [
  ['a torn last line (a crash mid-write)', '{"type":"contact","key":"L:9"'],
  ['a last line with no newline', '{"type":"contact","key":"L:9","payload":{}}'],
  ['a corrupt line in the middle', 'not json\n{"type":"done","key":"x"}\n'],
  ['a line that is JSON but not a record', '[1,2]\n'],
]) {
  test(`email: with ${what} in the outbox, every write is refused and nothing is appended`, async () => {
    const { instance, file } = email();
    const { listId } = await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live });
    fs.appendFileSync(file, damage);
    const before = fs.readFileSync(file, 'utf8');
    await assert.rejects(instance.write.createList({ name: 'l2', idempotencyKey: 'L2', ...live }),
      (err) => err instanceof ConnectorFailed && /torn or corrupt line 3/.test(err.reason) && /writes are refused/.test(err.reason));
    await assert.rejects(instance.write.addContacts({ listId, contacts: contacts(1, 9), idempotencyKey: 'L', ...live }), /torn or corrupt line/);
    // After a restart too.
    await assert.rejects(email({ file }).instance.write.addContacts({ listId, contacts: contacts(1, 9), idempotencyKey: 'L', ...live }), /torn or corrupt line/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the outbox is unchanged');
  });
}

test('email: the refusal names the line, not what is in it (contacts are client data)', async () => {
  const { instance, file } = email();
  await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live });
  fs.appendFileSync(file, '{"type":"contact","payload":{"email":"secret@home.invalid"');
  await assert.rejects(instance.write.createList({ name: 'l2', idempotencyKey: 'L2', ...live }),
    (err) => !err.reason.includes('secret@home.invalid'));
});

test('email: an outbox that cannot be read refuses every write instead of counting as empty', { skip: process.getuid && process.getuid() === 0 ? 'root reads anything' : false }, async () => {
  const { instance, file } = email();
  const { listId } = await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live });
  fs.chmodSync(file, 0o000);
  try {
    await assert.rejects(instance.write.createList({ name: 'l', idempotencyKey: 'L-new', ...live }), ConnectorFailed);
    await assert.rejects(instance.write.addContacts({ listId, contacts: contacts(1), idempotencyKey: 'L', ...live }), ConnectorFailed);
  } finally {
    fs.chmodSync(file, 0o600);
  }
  assert.equal(readLines(file).filter((l) => l.type === 'contact').length, 0);
});

test('email: an outbox path that is a directory refuses every write', async () => {
  const file = freshPath();
  fs.mkdirSync(file, { recursive: true });
  const { instance } = email({ file });
  await assert.rejects(instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live }), ConnectorFailed);
});

test('email: a contact\'s key carries its list, so a retry with the same key on another list adds the contacts there', async () => {
  const simulate = { failContacts: new Set(['2']) };
  const { instance, file, lines } = email({ simulate });
  const a = await instance.write.createList({ name: 'a', idempotencyKey: 'A', ...live });
  const b = await instance.write.createList({ name: 'b', idempotencyKey: 'B', ...live });
  await assert.rejects(instance.write.addContacts({ listId: a.listId, contacts: contacts(3), idempotencyKey: 'K', ...live }), ConnectorFailed);
  simulate.failContacts.clear();
  const res = await email({ file }).instance.write.addContacts({ listId: b.listId, contacts: contacts(3), idempotencyKey: 'K', ...live });
  assert.deepEqual(res, { listId: b.listId, added: 3, alreadyAdded: 0 }, 'nothing on list a counts for list b');
  const onB = lines().filter((l) => l.type === 'contact' && l.payload.listId === b.listId);
  assert.deepEqual(onB.map((l) => l.payload.external_ref), ['1', '2', '3']);
  assert.deepEqual(onB.map((l) => l.key), [`K:${b.listId}:1`, `K:${b.listId}:2`, `K:${b.listId}:3`]);
});

test('email: a batch of 100 contacts reads the outbox a fixed number of times, not once per contact', async (t) => {
  const { instance, file } = email();
  const { listId } = await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live });
  const reads = [];
  const real = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === file) reads.push(p);
    return real.call(this, p, ...rest);
  });
  const res = await instance.write.addContacts({ listId, contacts: contacts(100), idempotencyKey: 'L', ...live });
  assert.equal(res.added, 100);
  assert.ok(reads.length <= 3, `read the outbox ${reads.length} times`);
});

test('email: instances on one outbox share in-flight writes, so a concurrent reused key with another input is refused (DEP-012)', async () => {
  const file = freshPath();
  const a = email({ file });
  const b = email({ file });
  const results = await Promise.allSettled([
    a.instance.write.createList({ name: 'one', idempotencyKey: 'same', ...live }),
    b.instance.write.createList({ name: 'two', idempotencyKey: 'same', ...live }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'one write applied');
  const refused = results.find((r) => r.status === 'rejected');
  assert.ok(refused && refused.reason instanceof IdempotencyConflict, `the other is an IdempotencyConflict, got ${refused && refused.reason}`);
  assert.equal(a.lines().filter((l) => l.type === 'list').length, 1, 'one list in the outbox');
});

test('email: the outbox records the contract slot with the connector id (DEP-012)', async () => {
  const { instance, lines } = email();
  await instance.write.createList({ name: 'l', idempotencyKey: 'K', ...live });
  const done = lines().find((l) => l.type === 'done');
  assert.deepEqual({ slot: done.slot, operation: done.operation, key: done.key }, { slot: 'email\u0000createList\u0000K', operation: 'createList', key: 'K' });
});
