'use strict';

// The shared connector contract suite (Story 8.1). Every connector's test file
// calls it once; it registers node:test cases that check the guardrails from
// the outside, through the connector's create(deps):
//
//   const { connectorContract } = require('#sdk');
//   connectorContract(require('./connector'), {
//     read:  { lookupClient: { clientId: 'c1', fields: ['email'] } },
//     write: { addContacts: (idempotencyKey) => ({ listId: 'l1', contacts: [...], idempotencyKey }) },
//     bulk:  { operation: 'addContacts', input: (count, idempotencyKey) => ({ ...count contacts... }) },
//   });
//
// samples.read and samples.write must cover every declared operation (a
// write sample is a function of the idempotency key). samples.bulk (one
// { operation, input(count, key), limit? }, or a list of them) must cover every write
// whose sample has a list in it, so each one's request sizing is checked: a
// write that sends a whole list in one call fails the suite.
//
// limit (Story 20.1): the most items the write takes in one call, when it
// has a cap of its own (the mock email tool's sendEmails takes at most 50
// emails a push). The suite then checks that limit + 1 items are refused
// before any I/O, dry run and live, and that limit items go; its bulk checks
// send min(2 x batchSize + 1, limit) items. When that fits in one request,
// there is no request k to stop after, so the resume check says so and
// skips that write, and the per-item retry check fails its only request.
//
// options.deps is merged into every create(deps) call, for what the connector
// needs beyond the suite's own (for example data: a stand-in query runner, or
// log: by default the suite passes a silent logger).
// The suite's env, now, sleep and onRequest always win.
//
// The suite drives the connector with a fake env (fake credential values for
// every auth.env name), a fake clock, and deps.onRequest to count calls to the
// system and make the system fail. It never needs a real system.

const assert = require('node:assert/strict');
const util = require('node:util');
const { KillSwitchOn, ConnectorFailed, ConnectorAuthFailed } = require('../errors');
const { createLog } = require('../log');

const GLOBAL_KILL_SWITCH = 'APLABS_WRITES_OFF';
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

// A clock that moves only when the connector sleeps.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

// Counts harnesses across every run of the suite in the process.
let harnesses = 0;

function connectorContract(connector, samples = {}, { test = require('node:test'), deps = {} } = {}) {
  const decl = connector && connector.declaration;
  const label = decl && decl.id ? decl.id : 'connector';
  const reads = (decl && decl.read) || [];
  const writes = (decl && decl.write) || [];
  const authEnv = (decl && decl.auth && decl.auth.env) || [];
  const fakeSecret = (name) => `contract-fake-${name.toLowerCase()}-Zq81xW`;

  // A fresh instance plus what it did. env overrides the fake env.
  // idempotency: a store for this instance (else the connector's own);
  // run: the key suffix, so a second instance can retry the first one's key;
  // system: another harness's resolved deps, so a second instance reaches the
  // same system (options.deps getters, such as a fresh outbox, run once).
  function harness({ env = {}, credentials = true, idempotency, run: suffix, system } = {}) {
    const resolved = system || { ...deps };
    const clock = fakeClock();
    const requests = [];
    const state = { failWith: null };
    const liveEnv = { ...(credentials ? Object.fromEntries(authEnv.map((n) => [n, fakeSecret(n)])) : {}), ...env };
    const instance = connector.create({
      log: createLog({ write: () => {} }),
      ...resolved,
      ...(idempotency ? { idempotency } : {}),
      env: liveEnv,
      now: clock.now,
      sleep: clock.sleep,
      onRequest(info) {
        requests.push(info);
        // failWith(info) returns the error to throw, or nothing to let it through.
        const failure = state.failWith && state.failWith(info);
        if (failure) throw failure;
      },
    });
    // Instances of one connector share its idempotency state for the process
    // (DEP-012), so each harness suffixes its keys: a check never sees the
    // keys another check, or another run of the suite, already used.
    const run = suffix || `~h${(harnesses += 1)}`;
    const write = Object.fromEntries(Object.entries(instance.write).map(([n, w]) => [n, (input = {}) => w(
      typeof input.idempotencyKey === 'string' && input.idempotencyKey ? { ...input, idempotencyKey: `${input.idempotencyKey}${run}` } : input,
    )]));
    return { instance: { ...instance, write }, requests, state, clock, env: liveEnv, deps: resolved };
  }

  const writeInput = (name, key, extra = {}) => ({ ...samples.write[name](key), ...extra });
  const bulks = samples.bulk ? [].concat(samples.bulk) : [];
  // How many items a bulk check sends: 2 x batchSize + 1 (at least three
  // requests), or the write's own limit when that is smaller.
  const bulkCount = (bulk) => {
    const full = decl.rateLimit.batchSize * 2 + 1;
    return bulk.limit === undefined ? full : Math.min(full, bulk.limit);
  };
  const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));

  test(`${label}: declares the contract (auth env names, operations, kill switch, rate limit)`, () => {
    assert.ok(decl && typeof decl === 'object', 'exports a declaration (use defineConnector from #sdk)');
    assert.equal(typeof connector.create, 'function', 'exports create(deps)');
    assert.match(decl.id, /^[a-z][a-z0-9-]*$/, 'id is a slug');
    assert.ok(typeof decl.system === 'string' && decl.system.trim(), 'system is a plain name');
    assert.ok(Array.isArray(authEnv), 'auth.env is a list');
    for (const n of authEnv) assert.match(n, ENV_NAME, `auth.env lists env var names, never values: ${n}`);
    assert.match(decl.killSwitchEnv || '', ENV_NAME, 'killSwitchEnv is an env var name');
    assert.notEqual(decl.killSwitchEnv, GLOBAL_KILL_SWITCH, 'killSwitchEnv is the connector\'s own');
    assert.ok(decl.rateLimit.perSecond > 0, 'rateLimit.perSecond is positive');
    assert.ok(Number.isInteger(decl.rateLimit.batchSize) && decl.rateLimit.batchSize > 0, 'rateLimit.batchSize is a positive integer');
    assert.ok(reads.length + writes.length > 0, 'declares at least one operation');
    assert.deepEqual(Object.keys(samples.read || {}).sort(), [...reads].sort(), 'samples.read covers every read operation');
    assert.deepEqual(Object.keys(samples.write || {}).sort(), [...writes].sort(), 'samples.write covers every write operation');
    for (const n of writes) assert.equal(typeof samples.write[n], 'function', `samples.write.${n} is a function of the idempotency key`);
    for (const b of bulks) assert.ok(b && writes.includes(b.operation) && typeof b.input === 'function', 'each samples.bulk is { operation: a write operation, input(count, key) }');
    for (const b of bulks) {
      if (b.limit !== undefined) assert.ok(Number.isSafeInteger(b.limit) && b.limit > 0, `samples.bulk ${b.operation}: limit is a positive integer`);
    }
    for (const n of writes) {
      if (!Object.values(samples.write[n]('probe') || {}).some(Array.isArray)) continue;
      assert.ok(bulks.some((b) => b.operation === n), `samples.bulk covers ${n}: its sample takes a list, so its request sizing must be checked`);
    }
    const instance = harness().instance;
    assert.deepEqual(Object.keys(instance.read).sort(), [...reads].sort());
    assert.deepEqual(Object.keys(instance.write).sort(), [...writes].sort());
  });

  test(`${label}: reads and writes work with nothing switched off`, async () => {
    const { instance, requests } = harness();
    for (const n of reads) await instance.read[n](samples.read[n]);
    for (const n of writes) await instance.write[n](writeInput(n, `ok-${n}`, { dryRun: false }));
    assert.ok(requests.length >= reads.length + writes.length, 'each operation calls the system through ctx.request');
  });

  test(`${label}: a write is a dry run unless dryRun is false, and a dry run calls nothing`, async () => {
    for (const n of writes) {
      const { instance, requests } = harness();
      for (const input of [writeInput(n, 'dry'), writeInput(n, 'dry', { dryRun: true })]) {
        const res = await instance.write[n](input);
        assert.equal(res && res.dryRun, true, `${n}: returns { dryRun: true, ... }`);
        assert.ok('wouldWrite' in res, `${n}: says what would be written`);
      }
      assert.equal(requests.length, 0, `${n}: a dry run calls nothing`);
      await instance.write[n](writeInput(n, 'dry', { dryRun: false }));
      assert.ok(requests.length > 0, `${n}: a dry run did not use up the idempotency key`);
    }
  });

  for (const [what, envName] of [['the connector kill switch', () => decl.killSwitchEnv], [GLOBAL_KILL_SWITCH, () => GLOBAL_KILL_SWITCH]]) {
    test(`${label}: ${what} refuses every write before any I/O; reads keep working`, async () => {
      const name = envName();
      // No credentials: the switch must be checked before they are read.
      for (const credentials of [true, false]) {
        const { instance, requests } = harness({ env: { [name]: '1' }, credentials });
        for (const n of writes) {
          for (const dryRun of [false, true]) {
            const r = await settle(instance.write[n](writeInput(n, `ks-${n}`, { dryRun })));
            assert.ok(r.error instanceof KillSwitchOn, `${n} (dryRun ${dryRun}): refuses with KillSwitchOn, got ${r.error ? r.error.name : 'a result'}`);
            assert.equal(r.error.details.env, name);
          }
        }
        assert.equal(requests.length, 0, 'no write reached the system');
        if (credentials) for (const n of reads) await instance.read[n](samples.read[n]);
      }
      // The switch is read on every call: turning it off lets the same
      // instance write, and a refused write did not use up its key.
      const flip = harness({ env: { [name]: '1' } });
      for (const n of writes) await settle(flip.instance.write[n](writeInput(n, `flip-${n}`, { dryRun: false })));
      assert.equal(flip.requests.length, 0);
      delete flip.env[name];
      for (const n of writes) await flip.instance.write[n](writeInput(n, `flip-${n}`, { dryRun: false }));
      if (writes.length) assert.ok(flip.requests.length > 0, 'writes resume once the switch is off');
    });
  }

  test(`${label}: a repeated idempotency key changes nothing`, async () => {
    for (const n of writes) {
      const { instance, requests } = harness();
      const first = await instance.write[n](writeInput(n, `idem-${n}`, { dryRun: false }));
      const calls = requests.length;
      assert.ok(calls > 0);
      const again = await instance.write[n](writeInput(n, `idem-${n}`, { dryRun: false }));
      assert.deepEqual(again, first, `${n}: the repeat returns the first result`);
      assert.equal(requests.length, calls, `${n}: the repeat calls nothing`);
      const [a, b] = await Promise.all([1, 2].map(() => instance.write[n](writeInput(n, `idem-race-${n}`, { dryRun: false }))));
      assert.deepEqual(a, b, `${n}: two concurrent calls with one key get one result`);
      assert.equal(requests.length, calls * 2, `${n}: two concurrent calls with one key apply once`);
      await instance.write[n](writeInput(n, `idem-other-${n}`, { dryRun: false }));
      assert.ok(requests.length > calls * 2, `${n}: a new key does write`);
    }
  });

  test(`${label}: calls are spaced to the rate limit and none is dropped`, async () => {
    const { instance, requests } = harness();
    const interval = 1000 / decl.rateLimit.perSecond;
    const total = Math.min(25, Math.ceil(decl.rateLimit.perSecond) * 2 + 1);
    const calls = [];
    for (let i = 0; i < total; i += 1) {
      if (reads.length) {
        const n = reads[i % reads.length];
        calls.push(instance.read[n](samples.read[n]));
      } else {
        const n = writes[i % writes.length];
        calls.push(instance.write[n](writeInput(n, `rate-${i}`, { dryRun: false })));
      }
    }
    const results = await Promise.allSettled(calls);
    assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason.message), [], 'every call completes');
    assert.ok(requests.length >= total, 'every call reached the system');
    for (let i = 1; i < requests.length; i += 1) {
      const gap = requests[i].at - requests[i - 1].at;
      assert.ok(gap >= interval - 1e-6, `call ${i} came ${gap} ms after the last; the limit is one per ${interval} ms`);
    }
  });

  test(`${label}: a bulk write goes in batches no larger than batchSize`, { skip: !bulks.length && 'no bulk sample (no write takes a list)' }, async () => {
    for (const bulk of bulks) {
      const { instance, requests } = harness();
      const size = decl.rateLimit.batchSize;
      const count = bulkCount(bulk);
      await instance.write[bulk.operation]({ ...bulk.input(count, 'bulk'), dryRun: false });
      const batches = requests.filter((r) => r.operation === bulk.operation && r.size > 0);
      assert.ok(batches.every((r) => r.size <= size), `${bulk.operation}: batch sizes ${batches.map((r) => r.size)} are within ${size}`);
      assert.equal(batches.reduce((sum, r) => sum + r.size, 0), count, `${bulk.operation}: every item is sent, in requests that say their size`);
    }
  });

  // A write with a limit of its own refuses one item more, whole, before any
  // I/O (dry run and live), and takes exactly the limit (Story 20.1).
  const limited = bulks.filter((b) => b.limit !== undefined);
  test(`${label}: a write with an item limit refuses one more, before any I/O`, { skip: !limited.length && 'no bulk sample declares a limit' }, async () => {
    for (const bulk of limited) {
      const n = bulk.operation;
      const { instance, requests } = harness();
      for (const dryRun of [true, false]) {
        const r = await settle(instance.write[n]({ ...bulk.input(bulk.limit + 1, `over-${n}`), dryRun }));
        assert.ok(r.error instanceof ConnectorFailed, `${n} (dryRun ${dryRun}): ${bulk.limit + 1} items are refused, got ${r.error ? r.error.name : 'a result'}`);
      }
      assert.equal(requests.length, 0, `${n}: nothing over the limit reached the system`);
      await instance.write[n]({ ...bulk.input(bulk.limit, `at-${n}`), dryRun: false });
      const sent = requests.filter((r) => r.operation === n).reduce((sum, r) => sum + r.size, 0);
      assert.equal(sent, bulk.limit, `${n}: exactly ${bulk.limit} items go`);
    }
  });

  test(`${label}: reads fail closed when a credential is missing`, { skip: !authEnv.length && 'declares no credentials' }, async () => {
    const { instance, requests } = harness({ credentials: false });
    for (const n of reads) {
      const r = await settle(instance.read[n](samples.read[n]));
      assert.ok(r.error instanceof ConnectorAuthFailed, `${n}: refuses with ConnectorAuthFailed, got ${r.error ? r.error.name : 'a result'}`);
      assert.match(r.error.message, new RegExp(authEnv.join('|')), `${n}: names the missing env var`);
    }
    assert.equal(requests.length, 0, 'nothing reached the system');
  });

  test(`${label}: reads fail closed when the system rejects the credentials`, async () => {
    for (const status of [401, 403]) {
      const { instance, state } = harness();
      state.failWith = () => Object.assign(new Error(`HTTP ${status}`), { status });
      for (const n of reads) {
        const r = await settle(instance.read[n](samples.read[n]));
        assert.ok(r.error instanceof ConnectorAuthFailed, `${n} on ${status}: refuses with ConnectorAuthFailed, got ${r.error ? r.error.name : `a result: ${util.inspect(r.value)}`}`);
      }
    }
  });

  // The system's errors echo secrets back; none may leave in a ConnectorFailed.
  // secrets: the values to look for; leaky(s): how the system echoes one.
  async function checkErrorsHide(secrets, leaky) {
    for (const status of [undefined, 401]) {
      const { instance, state } = harness();
      state.failWith = () => Object.assign(new Error(`system said: ${secrets.map(leaky).join('; ')}`), { status, config: { headers: { Authorization: secrets[0] } } });
      const calls = [
        ...reads.map((n) => [n, () => instance.read[n](samples.read[n])]),
        ...writes.map((n) => [n, () => instance.write[n](writeInput(n, `leak-${n}-${status}`, { dryRun: false }))]),
      ];
      for (const [n, call] of calls) {
        const r = await settle(call());
        assert.ok(r.error instanceof ConnectorFailed, `${n}: fails with a ConnectorFailed, got ${r.error ? r.error.name : 'a result'}`);
        const text = [r.error.message, r.error.stack, String(r.error), JSON.stringify(r.error), util.inspect(r.error, { depth: 10 })].join('\n');
        for (const s of secrets) assert.ok(!text.includes(s), `${n}: the error carries a credential: ${text}`);
      }
    }
  }

  // The declared credentials, echoed raw and in every shape. A connector that
  // declares none (a mock) has nothing to leak here (#90).
  // The skip is said in the output too, so a reader sees why it didn't run.
  test(`${label}: errors never include credentials`, (t) => {
    if (!authEnv.length) {
      t.diagnostic(`${label} declares no credentials (auth.env is empty), so the declared-credential leak check is skipped; the credential-shape check still runs`);
      t.skip('declares no credentials');
      return undefined;
    }
    return checkErrorsHide(
      authEnv.map(fakeSecret),
      (s) => `token=${s} Bearer ${s} https://user:${s}@api.example.invalid/x?api_key=${s} raw ${s}`,
    );
  });

  // A value the connector never saw, in credential shapes only (a token the
  // system minted, say): masked by shape, for every connector.
  test(`${label}: errors mask credential-shaped strings`, () => checkErrorsHide(
    ['contract-sentinel-Kp27vN'],
    (s) => [
      `token=${s}`, `Bearer ${s}`, `https://user:${s}@api.example.invalid/x?api_key=${s}`,
      `{"access_token":"${s}"}`, `{"api_key":"${s}"}`, `{"token":"${s}"}`, `{"client_secret":"${s}"}`, `{"password":"${s}"}`,
      `X-Api-Key: ${s}`, `Authorization: Token ${s}`, `Authorization: Basic ${s}`,
    ].join(' '),
  ));

  // Story 10.0 (DEP-017): a live write saves its progress after every
  // request, so a process that dies partway leaves an accurate record. The
  // suite kills the write after request k (its store never answers the k-th
  // progress save, as if the process stopped there), then runs the same key
  // and input on a fresh instance over the same store (a new store object, as
  // a restarted process would have) and the same system (the same resolved
  // options.deps), and checks it sends only requests k+1
  // onwards. k is the first, a middle and the last request. The store is a
  // map behind JSON, as a durable one is; with an in-memory store a restart
  // loses the record (kit/templates/connector.md).
  const PROGRESS = '\u0001progress';
  const durable = () => {
    const data = new Map();
    return (onSet) => ({
      get: (k) => (data.has(k) ? JSON.parse(data.get(k)) : undefined),
      set: (k, v) => { data.set(k, JSON.stringify(v)); return onSet ? onSet(k) : undefined; },
    });
  };
  const turns = async (until) => { for (let i = 0; i < 1000 && !until(); i += 1) await new Promise(setImmediate); };
  test(`${label}: a write whose process dies after request k resumes at request k+1 on a fresh instance over the same store`, { skip: !bulks.length && 'no bulk sample (no write takes a list)' }, async (t) => {
    for (const bulk of bulks) {
      const n = bulk.operation;
      const count = bulkCount(bulk);
      const ofOp = (h) => h.requests.filter((r) => r.operation === n).length;
      const probe = harness({ idempotency: durable()() });
      await probe.instance.write[n]({ ...bulk.input(count, `dies-probe-${n}`), dryRun: false });
      const total = ofOp(probe);
      if (bulk.limit !== undefined && total < 2) {
        // Its limit fits in one request: nothing is sent before a stop.
        t.diagnostic(`${n} takes at most ${bulk.limit} items, one request, so there is no request k to stop after`);
        continue;
      }
      assert.ok(total >= 2, `${n}: a bulk of ${count} takes more than one request`);
      for (const k of [...new Set([1, Math.ceil(total / 2), total])]) {
        const store = durable();
        const run = `~h${(harnesses += 1)}`;
        let saves = 0;
        const dying = harness({ run, idempotency: store((slot) => (slot.includes(PROGRESS) && (saves += 1) === k ? new Promise(() => {}) : undefined)) });
        const input = { ...bulk.input(count, `dies-${n}-${k}`), dryRun: false };
        const dead = dying.instance.write[n](input);
        dead.catch(() => {});
        await turns(() => saves >= k || ofOp(dying) > k);
        assert.equal(ofOp(dying), k, `${n}: the write was stopped after request ${k} of ${total}`);
        assert.equal(saves, k, `${n}: its progress was saved after each of the first ${k} requests, not only when it stopped`);
        const fresh = harness({ run, idempotency: store(), system: dying.deps });
        const r = await Promise.race([
          settle(fresh.instance.write[n](input)),
          new Promise((resolve) => { setTimeout(() => resolve({ error: new Error('the fresh instance never finished') }), 5000).unref(); }),
        ]);
        assert.ok(!r.error, `${n} (k=${k}): the retry on a fresh instance finishes, got ${r.error && (r.error.reason || r.error.message)}`);
        assert.equal(ofOp(fresh), total - k, `${n} (k=${k}): the fresh instance sent only requests ${k + 1} to ${total}`);
      }
    }
  });

  // A write that declares perItemIdempotency claims a retry with the same key
  // and input re-sends only what failed (so a partial failure tells the
  // person retrying is safe). From outside, the suite checks the part it can:
  // after a batch fails partway through, the same key and input retry to a
  // result rather than an error or an idempotency conflict. That the system
  // then holds each item once is the connector's own test to show.
  const perItem = (decl && decl.perItemIdempotency) || [];
  test(`${label}: a write that declares per-item idempotency retries cleanly after a failed batch`, { skip: !perItem.length && 'no write declares perItemIdempotency' }, async () => {
    for (const n of perItem) {
      const bulk = bulks.find((b) => b.operation === n);
      assert.ok(bulk, `samples.bulk covers ${n}: it declares perItemIdempotency, so its retry after a failed batch must be checked`);
      const { instance, state } = harness();
      const count = bulkCount(bulk);
      const input = { ...bulk.input(count, `per-item-${n}`), dryRun: false };
      // The second batch fails, or the only one when the write's limit fits
      // in one request.
      const failAt = count > decl.rateLimit.batchSize ? 2 : 1;
      let calls = 0;
      state.failWith = () => (calls += 1) === failAt ? new Error(`HTTP 503 on batch ${failAt}`) : null;
      const first = await settle(instance.write[n](input));
      assert.ok(first.error instanceof ConnectorFailed, `${n}: the failed batch fails the write, got ${first.error ? first.error.name : 'a result'}`);
      state.failWith = null;
      const retry = await settle(instance.write[n](input));
      assert.ok(!retry.error, `${n}: the retry with the same key and input succeeds, got ${retry.error && retry.error.name}`);
    }
  });
}

module.exports = { connectorContract, fakeClock };
