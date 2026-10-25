'use strict';

// The mock email tool's own test: the shared contract suite, then what its
// writes leave in the outbox: create, add, a repeated key, a restart, both
// kill switches, a simulated row failure and a process that dies mid-push.
// Story 10.2: pushList, the one write a Win-back push makes (the list, then
// its contacts, under one key): its dry run lists the rows it would skip,
// each request answers only counts and id-shaped refs, and a push that dies
// after the list step, a middle batch or the last batch resumes and sends
// nothing twice. Every test writes to its own temporary outbox, never var/.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  connectorContract, testLog, KillSwitchOn, ConnectorFailed, IdempotencyConflict, PartialFailure,
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
    pushList: (idempotencyKey) => ({ name: 'win-back-north-2026-10-24', contacts: contacts(3), idempotencyKey }),
  },
  bulk: [
    { operation: 'addContacts', input: (count, idempotencyKey) => ({ listId: SUITE_LIST, contacts: contacts(count), idempotencyKey }) },
    { operation: 'pushList', input: (count, idempotencyKey) => ({ name: 'win-back-north-2026-10-24', contacts: contacts(count), idempotencyKey }) },
  ],
}, {
  deps: {
    get outboxPath() {
      const file = freshPath();
      openOutbox(file).append({ type: 'list', operation: 'createList', key: 'suite-seed', payload: { listId: SUITE_LIST, name: 'suite' } });
      return file;
    },
  },
});

// The mock declares no credential (#90): env is only the kill switches a test
// sets, never the process's own.
function email({ file = freshPath(), env = {}, simulate, log = testLog() } = {}) {
  const requests = [];
  const instance = connector.create({ log, env: { ...env }, outboxPath: file, simulate, onRequest: (r) => requests.push(r) });
  return { instance, file, requests, log, lines: () => readLines(file) };
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const live = { dryRun: false };

test('email: a mock with no credential, its own kill switch, and three writes', () => {
  assert.equal(connector.id, 'email');
  assert.deepEqual([...connector.auth.env], [], 'a mock declares no credential (#90)');
  assert.equal(connector.killSwitchEnv, 'BRIGHTSIDE_EMAIL_OFF');
  assert.deepEqual([...connector.write].sort(), ['addContacts', 'createList', 'pushList']);
  assert.deepEqual([...connector.read], []);
  assert.deepEqual({ ...connector.rateLimit }, { perSecond: 5, batchSize: 100 });
  assert.deepEqual([...connector.perItemIdempotency], ['addContacts', 'pushList'], 'each contact is keyed, so a retry re-sends only the failed ones');
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
  assert.match(list.listId, /^list-[0-9a-f]{12}0?$/);
  assert.match(list.listId, /[0-9]/, 'a list id always has a digit (id-shaped)');
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
  const { instance, file, lines, log } = email({ simulate });
  const { listId } = await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live });
  const input = { listId, contacts: contacts(3), idempotencyKey: 'L', ...live };

  await assert.rejects(instance.write.addContacts(input), (err) => {
    // A typed partial failure (#90): the counts and the failed ref, never contact data.
    assert.ok(err instanceof PartialFailure && err instanceof ConnectorFailed, `got ${err && err.name}`);
    assert.deepEqual([err.details.succeeded, err.details.failed, [...err.details.failedRefs]], [2, 1, ['2']]);
    // addContacts keys each contact, so the person may be told a retry is safe.
    assert.equal(err.details.retrySafe, true);
    // Counts only in the text (round 2): no ref, no address, no tool reason.
    assert.equal(err.reason, '2 of 3 items succeeded, 1 failed');
    assert.ok(!JSON.stringify(err.details).includes('@'), 'no email address in the details');
    return true;
  });
  const warned = log.lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'connector write partly failed');
  assert.deepEqual(warned && [warned.succeeded, warned.failed, warned.failed_refs, warned.retry_safe], [2, 1, ['2'], true]);
  assert.ok(!log.lines.join('\n').includes('@home.invalid'), 'no contact address in the log');
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
      // Line 4: the list, its progress record (10.0) and its done record come first.
      (err) => err instanceof ConnectorFailed && /torn or corrupt line 4/.test(err.reason) && /writes are refused/.test(err.reason));
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
  // The contract binds the key to its first input once a request went (its
  // progress record, 10.0), so this reaches the tool with a store that has
  // never seen the key: the tool's own per-contact keys are what's checked.
  const m = new Map();
  const fresh = connector.create({ log: testLog(), env: {}, outboxPath: file, idempotency: { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } } });
  await assert.rejects(email({ file }).instance.write.addContacts({ listId: b.listId, contacts: contacts(3), idempotencyKey: 'K', ...live }), IdempotencyConflict);
  const res = await fresh.write.addContacts({ listId: b.listId, contacts: contacts(3), idempotencyKey: 'K', ...live });
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
  // One contact and 100 contacts read the outbox the same few times: the done
  // slot, the stopped-write progress slot (#89), and one transaction each to
  // add, to save the progress after the request (10.0) and to record.
  const one = await instance.write.addContacts({ listId, contacts: contacts(1), idempotencyKey: 'L1', ...live });
  assert.equal(one.added, 1);
  const forOne = reads.length;
  reads.length = 0;
  const res = await instance.write.addContacts({ listId, contacts: contacts(100), idempotencyKey: 'L', ...live });
  assert.equal(res.added, 100);
  assert.equal(reads.length, forOne, `100 contacts read the outbox ${reads.length} times, 1 contact ${forOne}`);
  assert.ok(reads.length <= 5, `read the outbox ${reads.length} times`);
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

// Story 10.0 (DEP-017): the outbox is a durable store, so a push whose process
// dies partway resumes after a restart. The dying process is this one: its
// store answers the k-th progress save never (it stopped there). The restart
// is a new node process over the same outbox file, with nothing in memory.
function restartedPush(file, input, operation = 'addContacts') {
  const script = `
    const { testLog } = require('#sdk');
    const email = require(${JSON.stringify(path.join(__dirname, 'connector.js'))}).create({
      log: testLog(), env: {}, outboxPath: process.env.OUTBOX, onRequest: () => { requests += 1; },
    });
    let requests = 0;
    email.write[${JSON.stringify(operation)}](JSON.parse(process.env.INPUT)).then(
      (result) => console.log(JSON.stringify({ result, requests })),
      (err) => console.log(JSON.stringify({ error: err.name, reason: err.reason, requests })),
    );`;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname, env: { PATH: process.env.PATH, OUTBOX: file, INPUT: JSON.stringify(input) }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('email: a push that dies after the first, a middle or the last request resumes after a restart, sending each contact once (10.0)', async () => {
  // 201 contacts in batches of 100: three requests.
  for (const k of [1, 2, 3]) {
    const file = freshPath();
    const { instance } = email({ file });
    const { listId } = await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live });
    const outbox = openOutbox(file);
    let saves = 0;
    const requests = [];
    const dying = connector.create({
      log: testLog(), env: {}, outboxPath: file, onRequest: (r) => requests.push(r),
      // A clock that never waits, so the rate limit doesn't slow the test.
      now: () => 0,
      sleep: async () => {},
      idempotency: {
        get: (slot) => outbox.ledger.get(slot),
        set: (slot, value) => {
          outbox.ledger.set(slot, value);
          return slot.includes('\u0001progress') && (saves += 1) === k ? new Promise(() => {}) : undefined;
        },
      },
    });
    const input = { listId, contacts: contacts(201), idempotencyKey: `P${k}`, ...live };
    dying.write.addContacts(input).catch(() => {});
    for (let i = 0; i < 1000 && saves < k; i += 1) await new Promise(setImmediate);
    assert.equal(requests.length, k, `k=${k}: the process died after request ${k}`);
    const kept = readLines(file).filter((l) => l.type === 'progress' && l.key === `P${k}`);
    assert.equal(kept.length, k, `k=${k}: one progress record per request`);
    assert.deepEqual(kept.at(-1).completed.map((c) => c.size), [100, 100, 1].slice(0, k));
    assert.ok(!JSON.stringify(kept).includes('@home.invalid'), 'no contact data in a progress record');

    const after = restartedPush(file, input);
    assert.equal(after.error, undefined, `k=${k}: the restart finished, got ${after.error}: ${after.reason}`);
    assert.equal(after.requests, 3 - k, `k=${k}: the restart sent only requests ${k + 1} to 3`);
    assert.deepEqual(after.result, { listId, added: 201, alreadyAdded: 0 });
    const added = readLines(file).filter((l) => l.type === 'contact' && l.key.startsWith(`P${k}:`));
    assert.equal(added.length, 201, `k=${k}: each contact is in the outbox once`);
    assert.equal(new Set(added.map((l) => l.key)).size, 201);
    assert.equal(readLines(file).filter((l) => l.type === 'done' && l.key === `P${k}`).length, 1);
  }
});

test('email: a per-item push that partly fails after saving progress drops it, so the retry calls every batch and adds only the failed contact (10.0, B3)', async () => {
  const simulate = { failContacts: new Set(['150']) };
  const { instance, file, lines } = email({ simulate });
  const { listId } = await instance.write.createList({ name: 'l', idempotencyKey: 'L', ...live });
  const input = { listId, contacts: contacts(201), idempotencyKey: 'B3', ...live };
  // Batch 1 went and was saved; contact 150 is refused in batch 2.
  await assert.rejects(instance.write.addContacts(input), (err) => err instanceof PartialFailure && err.details.retrySafe === true);
  const progress = lines().filter((l) => l.type === 'progress' && l.key === 'B3');
  assert.deepEqual(progress.at(-1).completed, [], 'the latest record has no completed requests');
  simulate.failContacts.clear();
  const retried = email({ file, simulate });
  assert.deepEqual(await retried.instance.write.addContacts(input), { listId, added: 1, alreadyAdded: 200 });
  assert.equal(retried.requests.length, 3, 'the retry called every batch');
  assert.equal(lines().filter((l) => l.type === 'contact' && l.key.startsWith('B3:')).length, 201);
});

// Story 10.2: pushList, the one write the approval-write archetype calls for
// a Win-back push (plan epic-10, decision 3).
const withoutEmail = (list, refs) => list.map((c) => (refs.includes(c.external_ref) ? { external_ref: c.external_ref, first_name: c.first_name } : c));

test('email: pushList\'s dry run lists the contacts the tool would refuse as skipped, with the reason, and writes nothing', async () => {
  const { instance, file, requests } = email();
  const input = { name: 'win-back-north-2026-10-25', contacts: withoutEmail(contacts(5), ['2', '4']), idempotencyKey: 'K' };
  const dry = await instance.write.pushList(input);
  assert.deepEqual(dry, {
    dryRun: true,
    operation: 'pushList',
    wouldWrite: { create: 'list', name: 'win-back-north-2026-10-25', add: 3, skipped: [{ ref: '2', reason: 'no email' }, { ref: '4', reason: 'no email' }] },
  });
  assert.equal(requests.length, 0);
  assert.equal(fs.existsSync(file), false);
  // A shape fault is not a skip: an unknown field, a missing ref or a ref twice is refused.
  for (const bad of [[{ ...contacts(1)[0], score: 80 }], [{ email: 'x@home.invalid' }], [...contacts(1), ...contacts(1)]]) {
    await assert.rejects(instance.write.pushList({ ...input, contacts: bad }), ConnectorFailed);
  }
});

test('email: pushList creates the list once and adds only the contacts it did not skip; a repeat adds nothing', async () => {
  const { instance, lines, requests } = email();
  const input = { name: 'win-back-north-2026-10-25', contacts: withoutEmail(contacts(5), ['2']), idempotencyKey: 'K', ...live };
  const res = await instance.write.pushList(input);
  assert.match(res.listId, /^list-[0-9a-f]{12}0?$/);
  assert.deepEqual(res, { listId: res.listId, added: 4, alreadyAdded: 0, skipped: 1 });
  assert.deepEqual(requests.map((r) => r.size), [0, 4], 'the list step carries no items, then one batch');
  const lists = lines().filter((l) => l.type === 'list');
  assert.deepEqual(lists.map((l) => l.payload), [{ listId: res.listId, name: 'win-back-north-2026-10-25' }]);
  const added = lines().filter((l) => l.type === 'contact');
  assert.deepEqual(added.map((l) => l.payload.external_ref), ['1', '3', '4', '5']);
  assert.deepEqual(added.map((l) => l.key), ['1', '3', '4', '5'].map((r) => `K:${res.listId}:${r}`));
  const n = lines().length;
  assert.deepEqual(await instance.write.pushList(input), res);
  assert.equal(lines().length, n, 'the repeat wrote nothing');
});

test('email: every pushList request answers only counts and id-shaped refs: { listId }, then { added, alreadyAdded, failedRefs }', async () => {
  const { instance, lines } = email({ simulate: { failContacts: new Set(['150']) } });
  await assert.rejects(instance.write.pushList({ name: 'l', contacts: contacts(201), idempotencyKey: 'R', ...live }), PartialFailure);
  // The progress records the contract kept, latest last (before B3 dropped it).
  const kept = lines().filter((l) => l.type === 'progress' && l.key === 'R').map((l) => l.completed).filter((c) => c.length);
  const results = kept.at(-1).map((c) => c.result);
  assert.ok(kept.at(-1).every((c) => !c.opaque), 'no answer was too rich to keep');
  assert.deepEqual(Object.keys(results[0]), ['listId']);
  assert.match(results[0].listId, /[0-9]/);
  assert.deepEqual(results[1], { added: 100, alreadyAdded: 0, failedRefs: [] });
  assert.ok(!JSON.stringify(kept).includes('home.invalid') && !JSON.stringify(kept).includes('"name"'));
});

test('email: a list id always has a digit, even when its hash starts with none', async () => {
  const hex = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 12);
  let key = null;
  for (let i = 0; !key; i += 1) if (!/[0-9]/.test(hex(`k${i}`))) key = `k${i}`;
  const { instance } = email();
  const { listId } = await instance.write.createList({ name: 'l', idempotencyKey: key, ...live });
  assert.equal(listId, `list-${hex(key)}0`);
});

test('email: a pushList whose process dies after the list step, a middle batch or the last batch resumes after a restart, sending each contact once', async () => {
  // 201 contacts: the list step, then batches of 100, 100 and 1 (four requests).
  for (const k of [1, 2, 4]) {
    const file = freshPath();
    const outbox = openOutbox(file);
    let saves = 0;
    const requests = [];
    const dying = connector.create({
      log: testLog(), env: {}, outboxPath: file, onRequest: (r) => requests.push(r),
      now: () => 0,
      sleep: async () => {},
      idempotency: {
        get: (slot) => outbox.ledger.get(slot),
        set: (slot, value) => {
          outbox.ledger.set(slot, value);
          return slot.includes('\u0001progress') && (saves += 1) === k ? new Promise(() => {}) : undefined;
        },
      },
    });
    const input = { name: 'win-back-north-2026-10-25', contacts: contacts(201), idempotencyKey: `Q${k}`, ...live };
    dying.write.pushList(input).catch(() => {});
    for (let i = 0; i < 1000 && saves < k; i += 1) await new Promise(setImmediate);
    assert.equal(requests.length, k, `k=${k}: the process died after request ${k}`);
    const kept = readLines(file).filter((l) => l.type === 'progress' && l.key === `Q${k}`);
    assert.deepEqual(kept.at(-1).completed.map((c) => c.size), [0, 100, 100, 1].slice(0, k));

    const after = restartedPush(file, input, 'pushList');
    assert.equal(after.error, undefined, `k=${k}: the restart finished, got ${after.error}: ${after.reason}`);
    assert.equal(after.requests, 4 - k, `k=${k}: the restart sent only requests ${k + 1} to 4`);
    assert.equal(after.result.added, 201);
    assert.equal(after.result.alreadyAdded, 0);
    assert.equal(readLines(file).filter((l) => l.type === 'list').length, 1, `k=${k}: one list`);
    const added = readLines(file).filter((l) => l.type === 'contact');
    assert.equal(added.length, 201, `k=${k}: each contact is in the outbox once`);
    assert.equal(new Set(added.map((l) => l.key)).size, 201);
  }
});

test('email: a pushList that partly fails is retry-safe, and the retry adds only the failed contact', async () => {
  const simulate = { failContacts: new Set(['150']) };
  const { instance, file, lines } = email({ simulate });
  const input = { name: 'l', contacts: contacts(201), idempotencyKey: 'PF', ...live };
  await assert.rejects(instance.write.pushList(input), (err) => {
    assert.ok(err instanceof PartialFailure);
    assert.deepEqual([err.details.succeeded, err.details.failed, [...err.details.failedRefs], err.details.retrySafe], [200, 1, ['150'], true]);
    return true;
  });
  simulate.failContacts.clear();
  const retried = email({ file, simulate });
  const res = await retried.instance.write.pushList(input);
  assert.deepEqual({ added: res.added, alreadyAdded: res.alreadyAdded }, { added: 1, alreadyAdded: 200 });
  assert.equal(lines().filter((l) => l.type === 'list').length, 1);
  assert.equal(lines().filter((l) => l.type === 'contact').length, 201);
});
