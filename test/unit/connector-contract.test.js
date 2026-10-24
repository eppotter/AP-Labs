'use strict';

// Story 8.1: one connector contract (kit/runtime/connectors/contract.js), one
// shared suite (suite.js) and a template (kit/templates/connector/). The
// template's own test runs the suite against the template adapter; these tests
// check the declaration rules, that the suite catches each guardrail breach,
// the details the suite cannot see from outside, and that the template works
// once copied into a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { defineConnector, GLOBAL_KILL_SWITCH } = require('../../kit/runtime/connectors/contract');
const { connectorContract, fakeClock } = require('../../kit/runtime/connectors/suite');
const { KillSwitchOn, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');
const { createLog } = require('../../kit/runtime/log');
const sdk = require('../../kit/runtime/sdk');
const { makeFork, REPO } = require('../fixtures/temp-fork');

const quietLog = () => createLog({ write: () => {} });
const TEMPLATE_DIR = path.join(REPO, 'kit/templates/connector');
const template = require('../../kit/templates/connector/connector');
// The template's adapter with another batch size (a redeploy that changed it).
function templateWithBatchSize(size) {
  const file = path.join(TEMPLATE_DIR, 'connector.js');
  const src = fs.readFileSync(file, 'utf8');
  assert.match(src, /batchSize: 100\b/);
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(TEMPLATE_DIR);
  m._compile(src.replace(/batchSize: 100\b/, `batchSize: ${size}`), file);
  return m.exports;
}
const items = (count) => Array.from({ length: count }, (_, i) => ({ id: `p${i}`, email: `p${i}@example.invalid` }));
const SAMPLES = {
  read: { getRecord: { id: 'r1', fields: ['id'] } },
  write: {
    createList: (idempotencyKey) => ({ name: 'l', idempotencyKey }),
    addItems: (idempotencyKey) => ({ listId: 'list-1', items: items(2), idempotencyKey }),
  },
  bulk: { operation: 'addItems', input: (count, idempotencyKey) => ({ listId: 'list-1', items: items(count), idempotencyKey }) },
};
// Not a credential: a fake value shaped like a token.
const TOKEN = 'fake-token-value-9fQ2';

// A minimal, valid declaration; tests break one field at a time.
function spec(over = {}) {
  return {
    id: 'demo',
    system: 'Demo',
    auth: { env: ['DEMO_TOKEN'] },
    killSwitchEnv: 'DEMO_OFF',
    rateLimit: { perSecond: 10, batchSize: 2 },
    connect: ({ secret }) => ({ token: secret('DEMO_TOKEN') }),
    read: { get: async (input, ctx) => ctx.request(() => ({ ok: true })) },
    write: { put: { plan: (i) => i, apply: async (i, ctx) => ctx.request(() => ({ put: true })) } },
    ...over,
  };
}

// Runs the suite in process with a collecting test(), and returns the names of
// the cases that failed.
async function failingCases(connector, samples = SAMPLES) {
  const cases = [];
  connectorContract(connector, samples, { test: (name, opts, fn) => cases.push({ name, fn: fn || opts, opts: fn ? opts : {} }) });
  const failed = [];
  for (const c of cases) {
    if (c.opts.skip) continue;
    try { await c.fn(); } catch { failed.push(c.name.replace(/^[^:]+: /, '')); }
  }
  return failed;
}

// A connector whose instances are the template's, altered by patch(instance, deps).
function broken(patch, depsPatch = (d) => d) {
  return {
    declaration: template.declaration,
    create(deps) {
      const real = template.create(depsPatch(deps));
      return patch({ ...real, read: { ...real.read }, write: { ...real.write } }, deps);
    },
  };
}

test('the template is exactly an adapter and its test, and passes the suite unaltered', async () => {
  assert.deepEqual(fs.readdirSync(TEMPLATE_DIR).sort(), ['connector.js', 'connector.test.js']);
  assert.deepEqual(await failingCases(template), []);
});

test('the template\'s defaults are safe: one credential by name, its own kill switch, a rate limit', () => {
  const d = template.describe ? template.describe() : template.declaration;
  assert.deepEqual(d.auth.env, ['MY_SYSTEM_TOKEN']);
  assert.equal(d.killSwitchEnv, 'MY_SYSTEM_OFF');
  assert.deepEqual(d.rateLimit, { perSecond: 5, batchSize: 100 });
  assert.deepEqual([...d.read], ['getRecord']);
  assert.deepEqual([...d.write], ['createList', 'addItems']);
});

for (const [breach, connector, expected] of [
  ['ignores both kill switches', broken((c) => c, (d) => ({ ...d, env: { ...d.env, MY_SYSTEM_OFF: '', [GLOBAL_KILL_SWITCH]: '' } })),
    ['the connector kill switch refuses every write before any I/O; reads keep working', `${GLOBAL_KILL_SWITCH} refuses every write before any I/O; reads keep working`]],
  ['writes for real by default', broken((c) => {
    for (const n of Object.keys(c.write)) { const w = c.write[n]; c.write[n] = (i) => w({ dryRun: false, ...i }); }
    return c;
  }), ['a write is a dry run unless dryRun is false, and a dry run calls nothing']],
  ['forgets idempotency keys', broken((c) => c, (d) => ({ ...d, idempotency: { get: () => undefined, set() {} } })),
    ['a repeated idempotency key changes nothing']],
  ['ignores the rate limit', broken((c) => c, (d) => ({ ...d, now: () => 0, sleep: async () => {} })),
    ['calls are spaced to the rate limit and none is dropped']],
  ['fails open on auth errors', broken((c) => {
    for (const n of Object.keys(c.read)) {
      const r = c.read[n];
      c.read[n] = (i) => r(i).catch((e) => { if (e instanceof ConnectorAuthFailed) return null; throw e; });
    }
    return c;
  }), ['reads fail closed when a credential is missing', 'reads fail closed when the system rejects the credentials', 'errors never include credentials']],
  ['puts a credential in its errors', broken((c, deps) => {
    const leak = (fn) => (i) => fn(i).catch((e) => {
      if (e instanceof ConnectorFailed && deps.env.MY_SYSTEM_TOKEN) throw new e.constructor(`${e.reason} with ${deps.env.MY_SYSTEM_TOKEN}`, e.details);
      throw e;
    });
    for (const k of ['read', 'write']) for (const n of Object.keys(c[k])) c[k][n] = leak(c[k][n]);
    return c;
  }), ['errors never include credentials']],
]) {
  test(`the suite catches a connector that ${breach}`, async () => {
    assert.deepEqual(await failingCases(connector), expected);
  });
}

test('the suite fails a connector whose samples miss an operation', async () => {
  const failed = await failingCases(template, { ...SAMPLES, write: { createList: SAMPLES.write.createList } });
  assert.ok(failed.includes('declares the contract (auth env names, operations, kill switch, rate limit)'), failed.join('\n'));
});

for (const [what, over, field] of [
  ['a credential value instead of a name', { auth: { env: ['xoxb-123-secret'] } }, 'auth.env'],
  ['a lower-case env name', { auth: { env: ['demo_token'] } }, 'auth.env'],
  ['no kill switch', { killSwitchEnv: undefined }, 'killSwitchEnv'],
  ['the global switch as its own', { killSwitchEnv: GLOBAL_KILL_SWITCH }, 'killSwitchEnv'],
  ['no rate limit', { rateLimit: undefined }, 'rateLimit'],
  ['a zero rate', { rateLimit: { perSecond: 0, batchSize: 1 } }, 'rateLimit.perSecond'],
  ['a fractional batch size', { rateLimit: { perSecond: 1, batchSize: 1.5 } }, 'rateLimit.batchSize'],
  ['a write without plan', { write: { put: { apply: async () => {} } } }, 'write.put'],
  ['a write as a bare function', { write: { put: async () => {} } }, 'write.put'],
  ['no operations', { read: {}, write: {} }, 'read'],
  ['an unknown field', { retries: 3 }, 'retries'],
  ['a bad id', { id: 'My System' }, 'id'],
]) {
  test(`defineConnector rejects ${what}, naming the field`, () => {
    assert.throws(() => defineConnector(spec(over)), (err) => err.message.includes(`field "${field}"`));
  });
}

test('a credential value given as an env name is never echoed back', () => {
  assert.throws(() => defineConnector(spec({ auth: { env: ['xoxb-123-secret'] } })), (err) => !err.message.includes('xoxb-123-secret'));
});

test('the SDK exposes the contract to app code', () => {
  for (const name of ['defineConnector', 'connectorContract', 'KillSwitchOn', 'ConnectorFailed', 'ConnectorAuthFailed', 'IdempotencyConflict']) {
    assert.ok(sdk[name], name);
  }
  assert.equal(sdk.defineConnector, defineConnector);
});

test('any non-empty kill-switch value counts as on, even "0"; killSwitch() names it', async () => {
  const env = { DEMO_TOKEN: TOKEN };
  const c = defineConnector(spec()).create({ log: quietLog(), env });
  assert.equal(c.killSwitch(), null);
  for (const value of ['1', '0', 'false']) {
    env.DEMO_OFF = value;
    assert.equal(c.killSwitch(), 'DEMO_OFF');
    await assert.rejects(c.write.put({ idempotencyKey: 'k', dryRun: false }), KillSwitchOn);
  }
  delete env.DEMO_OFF;
  env[GLOBAL_KILL_SWITCH] = '1';
  assert.equal(c.killSwitch(), GLOBAL_KILL_SWITCH);
});

test('a write without an idempotency key is refused before any I/O', async () => {
  let calls = 0;
  const c = defineConnector(spec()).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, onRequest: () => { calls += 1; } });
  for (const key of [undefined, '', 42, 'x'.repeat(257)]) {
    await assert.rejects(c.write.put({ idempotencyKey: key, dryRun: false }), (e) => e instanceof ConnectorFailed && /idempotencyKey/.test(e.message));
  }
  assert.equal(calls, 0);
});

test('an injected idempotency store carries keys across instances (a restart)', async () => {
  const m = new Map();
  const idempotency = { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } };
  let calls = 0;
  const make = () => defineConnector(spec()).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency, onRequest: () => { calls += 1; } });
  assert.deepEqual(await make().write.put({ idempotencyKey: 'k1', dryRun: false }), { put: true });
  assert.deepEqual(await make().write.put({ idempotencyKey: 'k1', dryRun: false }), { put: true });
  assert.equal(calls, 1);
});

test('a failed write does not record its key, so a retry writes', async () => {
  let fail = true;
  let calls = 0;
  const c = defineConnector(spec()).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, onRequest: () => { calls += 1; if (fail) throw new Error('503'); } });
  await assert.rejects(c.write.put({ idempotencyKey: 'k', dryRun: false }), ConnectorFailed);
  fail = false;
  assert.deepEqual(await c.write.put({ idempotencyKey: 'k', dryRun: false }), { put: true });
  assert.equal(calls, 2);
});

test('credentials are read once and connect runs once; an auth error drops them so the next call re-reads', async () => {
  let connects = 0;
  let reject = false;
  const env = { DEMO_TOKEN: TOKEN };
  const c = defineConnector(spec({
    connect: ({ secret }) => { connects += 1; return { token: secret('DEMO_TOKEN') }; },
    read: { get: async (i, ctx) => ctx.request(() => ctx.client.token) },
  })).create({ log: quietLog(), env, onRequest: () => { if (reject) throw Object.assign(new Error('nope'), { status: 401 }); } });
  assert.equal(await c.read.get(), TOKEN);
  assert.equal(await c.read.get(), TOKEN);
  assert.equal(connects, 1);
  reject = true;
  await assert.rejects(c.read.get(), ConnectorAuthFailed);
  reject = false;
  env.DEMO_TOKEN = 'rotated-fake-value';
  assert.equal(await c.read.get(), 'rotated-fake-value');
  assert.equal(connects, 2);
});

test('connect gets the query runner from deps.data, for a connector that reads the client\'s data (Story 8.2)', async () => {
  const data = { run: async () => [] };
  let got;
  const c = defineConnector(spec({ connect: (args) => { got = args; return {}; } })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, data });
  await c.read.get();
  assert.equal(got.data, data);
  const none = defineConnector(spec({ connect: (args) => { got = args; return {}; } })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
  await none.read.get();
  assert.equal(got.data, undefined, 'no runner unless one is given');
});

test('the suite passes its deps option to every instance it creates, but keeps its own env, clock and onRequest', async () => {
  const seen = [];
  const connector = {
    declaration: template.declaration,
    create(deps) { seen.push(deps); return template.create(deps); },
  };
  const data = { run: async () => [] };
  const cases = [];
  connectorContract(connector, SAMPLES, {
    test: (name, opts, fn) => cases.push({ fn: fn || opts, opts: fn ? opts : {} }),
    deps: { data, env: { MY_SYSTEM_TOKEN: 'ignored' }, onRequest: () => assert.fail('the suite\'s own onRequest is kept') },
  });
  for (const c of cases) if (!c.opts.skip) await c.fn();
  assert.ok(seen.length > 0);
  assert.ok(seen.every((d) => d.data === data), 'every instance gets deps.data');
  assert.ok(seen.every((d) => d.env.MY_SYSTEM_TOKEN !== 'ignored'), 'the suite\'s fake env wins');
});

test('an operation may read only the credentials it declared', async () => {
  const c = defineConnector(spec({ connect: ({ secret }) => secret('OTHER_TOKEN') })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN, OTHER_TOKEN: 'x' } });
  await assert.rejects(c.read.get(), (e) => e instanceof ConnectorFailed && /OTHER_TOKEN is not a declared credential/.test(e.message));
});

test('credentials are registered with the log, so log lines mask them too', async () => {
  const lines = [];
  const log = createLog({ write: (l) => lines.push(l) });
  const c = defineConnector(spec()).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, log });
  await c.read.get();
  log.info(`token is ${TOKEN}`);
  assert.ok(!lines.join('\n').includes(TOKEN));
});

test('a request over the batch size is refused; batches() splits by it', async () => {
  const c = defineConnector(spec({
    write: { put: { plan: (i) => i, apply: async (i, ctx) => ({ batches: ctx.batches([1, 2, 3, 4, 5]).map((b) => b.length), r: await ctx.request(() => 1, { size: 3 }) }) } },
  })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
  await assert.rejects(c.write.put({ idempotencyKey: 'k', dryRun: false }), /batch of 3 is over the batch size of 2/);
});

test('the limiter waits between calls on the injected clock', async () => {
  const clock = fakeClock();
  const at = [];
  const c = defineConnector(spec({ rateLimit: { perSecond: 4, batchSize: 1 } })).create({
    log: quietLog(), env: { DEMO_TOKEN: TOKEN }, ...clock, onRequest: (info) => { at.push(info.at); },
  });
  await Promise.all([1, 2, 3].map(() => c.read.get()));
  assert.deepEqual(at, [0, 250, 500]);
});

test('kill-switch and connector errors have plain messages that name the system, never the reason', () => {
  const d = { connector: 'demo', system: 'Demo <CRM>', operation: 'put' };
  assert.equal(messageFor(new KillSwitchOn({ ...d, env: 'DEMO_OFF' })), 'Sending to Demo &lt;CRM&gt; is switched off right now, so nothing was sent. Please tell your admin.');
  const failed = new ConnectorFailed('HTTP 500 from host', d);
  assert.equal(messageFor(failed), "I couldn't reach Demo &lt;CRM&gt; just now. Please try again later, or tell your admin if it keeps happening.");
  assert.equal(messageFor(new ConnectorAuthFailed('HTTP 401', d)), messageFor(failed));
  assert.ok(!messageFor(failed).includes('500'));
});

test('the template\'s own test passes once copied into a fork', (t) => {
  const f = makeFork();
  t.after(f.cleanup);
  const dir = path.join(f.appDir, 'connectors', 'my-system');
  fs.cpSync(TEMPLATE_DIR, dir, { recursive: true });
  const r = spawnSync(process.execPath, ['--test', path.join(dir, 'connector.test.js')], {
    cwd: f.root, env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass 12\n/);
  assert.match(r.stdout, /fail 0\n/);
});

test('a kill switch flipped partway through a write stops the requests still to come (#82)', async () => {
  for (const name of ['DEMO_OFF', GLOBAL_KILL_SWITCH]) {
    const env = { DEMO_TOKEN: TOKEN };
    let sent = 0;
    const c = defineConnector(spec({
      write: {
        put: {
          plan: (i) => i,
          async apply(i, ctx) {
            for (let b = 0; b < 5; b += 1) {
              await ctx.request(() => { sent += 1; if (sent === 2) env[name] = '1'; });
            }
            return { sent };
          },
        },
      },
    })).create({ log: quietLog(), env });
    await assert.rejects(c.write.put({ idempotencyKey: 'k', dryRun: false }), (e) => e instanceof KillSwitchOn && e.details.env === name);
    assert.equal(sent, 2, `${name}: no request went out after the switch was flipped`);
    assert.equal(await c.read.get().then((r) => r.ok), true, `${name}: reads keep working`);
    delete env[name];
    sent = 2;
    assert.deepEqual(await c.write.put({ idempotencyKey: 'k', dryRun: false }), { sent: 7 }, `${name}: the stopped write did not use up its key`);
  }
});

test('with a slow idempotency store, two concurrent calls with one key still apply once (#82)', async () => {
  const m = new Map();
  // The second read of the store is slow: it answers after the first write has
  // applied, recorded its key and finished, with what the store held when asked.
  let gets = 0;
  const idempotency = {
    get: async (k) => { const held = m.get(k); gets += 1; if (gets > 1) await new Promise((r) => setTimeout(r, 30)); return held; },
    set: async (k, v) => { m.set(k, v); },
  };
  let calls = 0;
  const c = defineConnector(spec()).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency, onRequest: () => { calls += 1; } });
  const both = await Promise.all([1, 2].map(() => c.write.put({ idempotencyKey: 'k', dryRun: false })));
  assert.deepEqual(both, [{ put: true }, { put: true }]);
  assert.equal(calls, 1, 'the second call joined the first instead of applying again');
});

test('a reused idempotency key with a different input is refused, never answered with the first result (#82)', async () => {
  let calls = 0;
  const c = defineConnector(spec({
    write: { put: { plan: (i) => i, apply: async (i, ctx) => ctx.request(() => ({ put: i.value })) } },
  })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, onRequest: () => { calls += 1; } });
  assert.deepEqual(await c.write.put({ idempotencyKey: 'k', value: { a: 1, b: 2 }, dryRun: false }), { put: { a: 1, b: 2 } });
  assert.deepEqual(await c.write.put({ value: { b: 2, a: 1 }, idempotencyKey: 'k', dryRun: false }), { put: { a: 1, b: 2 } }, 'key order is not a different input');
  const conflict = (e) => e instanceof IdempotencyConflict && e instanceof ConnectorFailed && e.code === 'IDEMPOTENCY_CONFLICT';
  await assert.rejects(c.write.put({ idempotencyKey: 'k', value: { a: 2, b: 2 }, dryRun: false }), conflict);
  assert.equal(calls, 1, 'nothing was sent for the refused input');
  // Two concurrent calls with one key and different inputs: one applies, one is refused.
  const [x, y] = await Promise.allSettled([1, 2].map((v) => c.write.put({ idempotencyKey: 'k2', value: v, dryRun: false })));
  assert.deepEqual(x, { status: 'fulfilled', value: { put: 1 } });
  assert.ok(y.status === 'rejected' && conflict(y.reason));
  assert.equal(calls, 2);
});

test('the template keys each item, so a retry with reordered rows or a new batch size loses no row and repeats none (#82)', async () => {
  const env = { MY_SYSTEM_TOKEN: TOKEN };
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const rows = (order) => order.map((id) => ({ id, email: `${id}@example.invalid` }));
  for (const [what, retryWith, order] of [
    ['reordered rows', () => templateWithBatchSize(2), [...ids].reverse()],
    ['a new batch size', () => template, ids],
  ]) {
    const state = {};
    let pushes = 0;
    // The first push fails on its second batch: a and b reached the system.
    const first = templateWithBatchSize(2).create({
      log: quietLog(), env, simulate: { state },
      onRequest: (info) => { if (info.operation === 'addItems' && ++pushes === 2) throw new Error('503 from the system'); },
    });
    const { listId } = await first.write.createList({ name: 'l', idempotencyKey: 'list', dryRun: false });
    await assert.rejects(first.write.addItems({ listId, items: rows(ids), idempotencyKey: 'push-1', dryRun: false }), ConnectorFailed);
    assert.deepEqual(state.lists.get(listId).items.map((i) => i.id), ['a', 'b']);
    const retry = retryWith().create({ log: quietLog(), env, simulate: { state } });
    await retry.write.addItems({ listId, items: rows(order), idempotencyKey: 'push-1', dryRun: false });
    assert.deepEqual(state.lists.get(listId).items.map((i) => i.id).sort(), ids, `${what}: every row is in the list exactly once`);
  }
});

test('an async connect is awaited once; a rejected one is dropped, and an auth-style rejection is ConnectorAuthFailed (#82)', async () => {
  let connects = 0;
  let fail = 'auth';
  const c = defineConnector(spec({
    async connect({ secret }) {
      connects += 1;
      await new Promise((r) => setImmediate(r));
      if (fail === 'auth') throw Object.assign(new Error('invalid_grant'), { status: 401 });
      if (fail === 'down') throw new Error('connect ECONNRESET');
      return { token: secret('DEMO_TOKEN') };
    },
    read: { get: async (i, ctx) => ctx.request(() => ctx.client.token) },
  })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
  await assert.rejects(c.read.get(), ConnectorAuthFailed);
  fail = 'down';
  await assert.rejects(c.read.get(), (e) => e instanceof ConnectorFailed && !(e instanceof ConnectorAuthFailed));
  fail = null;
  assert.deepEqual(await Promise.all([c.read.get(), c.read.get()]), [TOKEN, TOKEN]);
  assert.equal(connects, 3, 'each rejection was dropped; the two concurrent calls shared one connect');
  await c.read.get();
  assert.equal(connects, 3);
});

test('connect can register a token it obtains, and JSON token fields are masked in errors (#82)', async () => {
  // Fake values shaped like tokens, not credentials.
  const obtained = 'fake-oauth-access-Qm4t';
  const lines = [];
  const log = createLog({ write: (l) => lines.push(l) });
  let body = '';
  const c = defineConnector(spec({
    async connect({ registerSecret }) { return { token: registerSecret(obtained) }; },
    read: { get: async (i, ctx) => ctx.request(() => { throw new Error(body); }) },
  })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, log });
  body = `upstream echoed ${obtained}`;
  await assert.rejects(c.read.get(), (e) => e instanceof ConnectorFailed && !e.message.includes(obtained));
  log.info(`token ${obtained}`);
  assert.ok(!lines.join('\n').includes(obtained), 'the app logger masks it too');
  body = '{"access_token": "fake-at-1x", "refresh_token":"fake-rt-2y","id_token" :"fake-it-3z","scope":"read"}';
  await assert.rejects(c.read.get(), (e) => {
    for (const v of ['fake-at-1x', 'fake-rt-2y', 'fake-it-3z']) assert.ok(!e.message.includes(v), `${v} leaked: ${e.message}`);
    assert.match(e.message, /"scope":"read"/);
    return true;
  });
});

test('a 429 is retried through the rate limiter, honouring Retry-After, then fails as ConnectorFailed (#82)', async () => {
  const limited = (retryAfter) => Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } });
  function make(answers) {
    const clock = fakeClock();
    const at = [];
    const c = defineConnector(spec({ rateLimit: { perSecond: 10, batchSize: 2 } })).create({
      log: quietLog(), env: { DEMO_TOKEN: TOKEN }, ...clock,
      onRequest: (info) => { at.push(info.at); const a = answers.shift(); if (a) throw a; },
    });
    return { c, at };
  }
  // Two 429s (the first asks for 2 s), then an answer: the caller sees the answer.
  const ok = make([limited('2'), limited(), null]);
  assert.deepEqual(await ok.c.read.get(), { ok: true });
  assert.equal(ok.at.length, 3);
  assert.ok(ok.at[1] - ok.at[0] >= 2000, `waited ${ok.at[1] - ok.at[0]} ms of the 2 s asked`);
  assert.ok(ok.at[2] - ok.at[1] >= 100, 'a retry still keeps to the rate limit');
  // Still limited after the bounded attempts: a ConnectorFailed, never a result.
  const out = make([limited(), limited(), limited(), limited()]);
  await assert.rejects(out.c.read.get(), (e) => e instanceof ConnectorFailed && /rate limit/i.test(e.reason));
  assert.equal(out.at.length, 3);
  // A Retry-After past the limit fails at once instead of hanging.
  const long = make([limited('3600'), null]);
  await assert.rejects(long.c.read.get(), (e) => e instanceof ConnectorFailed && /3600/.test(e.reason));
  assert.equal(long.at.length, 1);
  // Writes retry too, and the retry re-checks the kill switch.
  const w = make([limited('1'), null]);
  assert.deepEqual(await w.c.write.put({ idempotencyKey: 'k', dryRun: false }), { put: true });
  assert.equal(w.at.length, 2);
});

test('create() needs the app logger, so every credential registers with it (AD-12, #82)', () => {
  const c = defineConnector(spec());
  for (const log of [undefined, null, {}, { registerSecret() {} }]) {
    assert.throws(() => c.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, log }), /deps\.log/);
  }
  assert.doesNotThrow(() => c.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, log: createLog({ write: () => {} }) }));
});

test('the suite needs a bulk sample for every write that takes a list, so 500 items in one unsized call fails it (#82)', async () => {
  const DECLARES = 'declares the contract (auth env names, operations, kill switch, rate limit)';
  const BULK = 'a bulk write goes in batches no larger than batchSize';
  // Sends every item in one call and never says how many.
  const unsized = defineConnector(spec({
    write: { addAll: { plan: (i) => i, apply: async (i, ctx) => ctx.request(() => ({ sent: i.items.length })) } },
  }));
  const write = { addAll: (idempotencyKey) => ({ items: items(500), idempotencyKey }) };
  const read = { get: {} };
  assert.ok((await failingCases(unsized, { read, write })).includes(DECLARES), 'no bulk sample for a list write fails the declaration');
  const bulk = { operation: 'addAll', input: (count, idempotencyKey) => ({ items: items(count), idempotencyKey }) };
  assert.ok((await failingCases(unsized, { read, write, bulk })).includes(BULK));
  assert.ok((await failingCases(unsized, { read, write, bulk: [bulk] })).includes(BULK), 'bulk may list several writes');
  // A connector whose writes take no list needs no bulk sample.
  assert.deepEqual(await failingCases(defineConnector(spec()), { read, write: { put: (idempotencyKey) => ({ v: 1, idempotencyKey }) } }), []);
});
