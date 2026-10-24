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
// { operation, input(count, key) }, or a list of them) must cover every write
// whose sample has a list in it, so each one's request sizing is checked: a
// write that sends a whole list in one call fails the suite.
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
  function harness({ env = {}, credentials = true } = {}) {
    const clock = fakeClock();
    const requests = [];
    const state = { failWith: null };
    const liveEnv = { ...(credentials ? Object.fromEntries(authEnv.map((n) => [n, fakeSecret(n)])) : {}), ...env };
    const instance = connector.create({
      log: createLog({ write: () => {} }),
      ...deps,
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
    const run = `~h${(harnesses += 1)}`;
    const write = Object.fromEntries(Object.entries(instance.write).map(([n, w]) => [n, (input = {}) => w(
      typeof input.idempotencyKey === 'string' && input.idempotencyKey ? { ...input, idempotencyKey: `${input.idempotencyKey}${run}` } : input,
    )]));
    return { instance: { ...instance, write }, requests, state, clock, env: liveEnv };
  }

  const writeInput = (name, key, extra = {}) => ({ ...samples.write[name](key), ...extra });
  const bulks = samples.bulk ? [].concat(samples.bulk) : [];
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
      const count = size * 2 + 1;
      await instance.write[bulk.operation]({ ...bulk.input(count, 'bulk'), dryRun: false });
      const batches = requests.filter((r) => r.operation === bulk.operation && r.size > 0);
      assert.ok(batches.every((r) => r.size <= size), `${bulk.operation}: batch sizes ${batches.map((r) => r.size)} are within ${size}`);
      assert.equal(batches.reduce((sum, r) => sum + r.size, 0), count, `${bulk.operation}: every item is sent, in requests that say their size`);
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
      const size = decl.rateLimit.batchSize;
      const input = { ...bulk.input(size * 2 + 1, `per-item-${n}`), dryRun: false };
      let calls = 0;
      state.failWith = () => (calls += 1) === 2 ? new Error('HTTP 503 on the second batch') : null;
      const first = await settle(instance.write[n](input));
      assert.ok(first.error instanceof ConnectorFailed, `${n}: the failed batch fails the write, got ${first.error ? first.error.name : 'a result'}`);
      state.failWith = null;
      const retry = await settle(instance.write[n](input));
      assert.ok(!retry.error, `${n}: the retry with the same key and input succeeds, got ${retry.error && retry.error.name}`);
    }
  });
}

module.exports = { connectorContract, fakeClock };
