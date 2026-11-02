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
const util = require('node:util');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { defineConnector, GLOBAL_KILL_SWITCH } = require('../../kit/runtime/connectors/contract');
const { connectorContract, fakeClock } = require('../../kit/runtime/connectors/suite');
const { KillSwitchOn, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict, PartialFailure } = require('../../kit/runtime/errors');
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
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

// A stand-in for node:test's t: records diagnostics and in-test skips.
function fakeT() {
  const t = { notes: [], skipped: null };
  t.diagnostic = (msg) => { t.notes.push(msg); };
  t.skip = (msg) => { t.skipped = msg || true; };
  return t;
}

// Runs the suite in process with a collecting test(), and returns the names of
// the cases that failed.
async function failingCases(connector, samples = SAMPLES) {
  const cases = [];
  connectorContract(connector, samples, { test: (name, opts, fn) => cases.push({ name, fn: fn || opts, opts: fn ? opts : {} }) });
  const failed = [];
  for (const c of cases) {
    if (c.opts.skip) continue;
    try { await c.fn(fakeT()); } catch { failed.push(c.name.replace(/^[^:]+: /, '')); }
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
    ['a repeated idempotency key changes nothing', 'a write whose process dies after request k resumes at request k+1 on a fresh instance over the same store']],
  // 10.0: a connector that drops the store it was given keeps its progress in
  // memory, so a restart loses it.
  ['ignores the idempotency store it is given', broken((c) => c, (d) => ({ ...d, idempotency: undefined })),
    ['a write whose process dies after request k resumes at request k+1 on a fresh instance over the same store']],
  ['ignores the rate limit', broken((c) => c, (d) => ({ ...d, now: () => 0, sleep: async () => {} })),
    ['calls are spaced to the rate limit and none is dropped']],
  ['fails open on auth errors', broken((c) => {
    for (const n of Object.keys(c.read)) {
      const r = c.read[n];
      c.read[n] = (i) => r(i).catch((e) => { if (e instanceof ConnectorAuthFailed) return null; throw e; });
    }
    return c;
  }), ['reads fail closed when a credential is missing', 'reads fail closed when the system rejects the credentials', 'errors never include credentials', 'errors mask credential-shaped strings']],
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
  for (const name of ['defineConnector', 'connectorContract', 'KillSwitchOn', 'ConnectorFailed', 'ConnectorAuthFailed', 'IdempotencyConflict', 'PartialFailure']) {
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
  for (const c of cases) if (!c.opts.skip) await c.fn(fakeT());
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
  assert.ok(!messageFor(failed).includes('500'));
});

test('a missing key, a rejected key, an outage and a reused key each get their own plain message (AD-17, #82)', async () => {
  const d = { connector: 'demo', system: 'Demo', operation: 'get' };
  const missing = await defineConnector(spec()).create({ log: quietLog(), env: {} }).read.get().catch((e) => e);
  assert.ok(missing instanceof ConnectorAuthFailed && missing.details.setup === true, 'a missing key is flagged as a setup fault');
  const rejected = await defineConnector(spec({ read: { get: async (i, ctx) => ctx.request(() => { throw Object.assign(new Error('no'), { status: 401 }); }) } }))
    .create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } }).read.get().catch((e) => e);
  assert.ok(rejected instanceof ConnectorAuthFailed && !rejected.details.setup);
  const words = [missing, rejected, new ConnectorFailed('HTTP 500', d), new IdempotencyConflict('reused', d)].map(messageFor);
  assert.equal(words[0], "Demo isn't set up correctly, so I can't reach it. I've logged the problem; please tell your admin.");
  assert.equal(words[1], "Demo turned down my sign-in, so I couldn't reach it. Please tell your admin; trying again won't help until it's fixed.");
  assert.equal(words[2], "I couldn't reach Demo just now. Please try again later, or tell your admin if it keeps happening.");
  assert.equal(words[3], "That was already sent to Demo with different contents, so I didn't send it again. Please tell your admin.");
  assert.equal(new Set(words).size, 4);
  for (const w of words) assert.doesNotMatch(w, /DEMO_TOKEN|401|500|reused/);
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
  assert.match(r.stdout, /pass 14\n/);
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
    // The stopped write did not use up its key, and its retry resumes after
    // the 2 requests already sent instead of sending them again (#89 round 2).
    assert.deepEqual(await c.write.put({ idempotencyKey: 'k', dryRun: false }), { sent: 5 }, `${name}: the retry sent only the 3 requests still to come`);
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

test('an HTTP-date Retry-After is read against the injected clock, capped, and a write re-checks the kill switch after the wait (#89)', async () => {
  const T0 = Date.parse('2026-10-24T12:00:00Z');
  const limited = (retryAfter) => Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429, headers: { 'retry-after': retryAfter } });
  const httpDate = (ms) => new Date(ms).toUTCString();
  function make(answers, { onSleep } = {}) {
    let t = T0;
    const at = [];
    const slept = [];
    const env = { DEMO_TOKEN: TOKEN };
    const c = defineConnector(spec()).create({
      log: quietLog(), env,
      now: () => t,
      sleep: async (ms) => { slept.push(ms); t += ms; if (onSleep) onSleep(env); },
      onRequest: (info) => { at.push(info.at); const a = answers.shift(); if (a) throw a(t); },
    });
    return { c, at, slept };
  }
  // The date is 5 s after the injected now (not the wall clock): the retry waits 5 s.
  const ok = make([(t) => limited(httpDate(t + 5000)), null]);
  assert.deepEqual(await ok.c.read.get(), { ok: true });
  assert.equal(ok.at.length, 2);
  assert.equal(ok.at[1] - ok.at[0], 5000, `waited ${ok.at[1] - ok.at[0]} ms, not the 5 s the date asked`);
  // A date already past retries without waiting beyond the rate limit.
  const past = make([(t) => limited(httpDate(t - 60_000)), null]);
  assert.deepEqual(await past.c.read.get(), { ok: true });
  assert.ok(past.at[1] - past.at[0] < 1000, `waited ${past.at[1] - past.at[0]} ms for a past date`);
  // A date past the cap fails at once with ConnectorFailed, and nothing sleeps that long.
  const far = make([(t) => limited(httpDate(t + 2 * 3600_000)), null]);
  await assert.rejects(far.c.read.get(), (e) => e instanceof ConnectorFailed && /over the 60 s limit/.test(e.reason));
  assert.equal(far.at.length, 1);
  assert.ok(far.slept.every((ms) => ms <= 60_000), `slept ${far.slept}`);
  // A huge seconds value is capped the same way.
  const huge = make([() => limited('1e12'), null]);
  await assert.rejects(huge.c.read.get(), (e) => e instanceof ConnectorFailed && /over the 60 s limit/.test(e.reason));
  assert.equal(huge.at.length, 1);
  const endless = make([() => limited('Infinity'), null]);
  await assert.rejects(endless.c.read.get(), (e) => e instanceof ConnectorFailed && /without limit, over the 60 s limit/.test(e.reason));
  assert.equal(endless.at.length, 1);
  // A kill switch flipped during the Retry-After wait stops the write's retry.
  const w = make([(t) => limited(httpDate(t + 3000)), null], { onSleep: (env) => { env.DEMO_OFF = '1'; } });
  await assert.rejects(w.c.write.put({ idempotencyKey: 'k89', dryRun: false }), KillSwitchOn);
  assert.equal(w.at.length, 1, 'the retry was not sent');
  // A read keeps working through the same switch.
  const r = make([(t) => limited(httpDate(t + 3000)), null], { onSleep: (env) => { env.DEMO_OFF = '1'; } });
  assert.deepEqual(await r.c.read.get(), { ok: true });
});

// A batched write that the system records item by item: system.sent lists
// every item id it received, in order.
function batchedPush({ batchSize = 2, perItemIdempotency, partlyFails } = {}) {
  const system = { sent: [], calls: 0 };
  const op = {
    plan: (i) => i,
    apply: async (input, ctx) => {
      let n = 0;
      for (const batch of ctx.batches(input.items)) {
        n += await ctx.request(() => { system.calls += 1; system.sent.push(...batch.map((x) => x.id)); return batch.length; }, { size: batch.length });
      }
      if (partlyFails) throw new PartialFailure('1 failed', { succeeded: n - 1, failed: 1, failedRefs: ['p0'] });
      return { pushed: n };
    },
  };
  if (perItemIdempotency !== undefined) op.perItemIdempotency = perItemIdempotency;
  const connector = defineConnector(spec({ rateLimit: { perSecond: 10, batchSize }, write: { push: op } }));
  return { connector, system };
}

test('a batched write stopped partway (kill switch or failure) records its progress, so a retry with the same key and input resumes after the last sent batch (#89 round 2)', async () => {
  const input = (key, count = 5) => ({ items: items(count), idempotencyKey: key, dryRun: false });
  // The kill switch flips after the first batch went out.
  {
    const { connector, system } = batchedPush();
    const env = { DEMO_TOKEN: TOKEN };
    let requests = 0;
    const c = connector.create({ log: quietLog(), env, ...fakeClock(), onRequest: () => { requests += 1; if (requests === 1) env.DEMO_OFF = '1'; } });
    const stopped = await settle(c.write.push(input('ks')));
    assert.ok(stopped.error instanceof KillSwitchOn, `got ${stopped.error ? stopped.error.name : 'a result'}`);
    assert.deepEqual(stopped.error.details.sent, { batches: 1, items: 2, recorded: true });
    assert.deepEqual(system.sent, ['p0', 'p1']);
    const words = messageFor(stopped.error, { admin: 'Ely' });
    assert.match(words, /partway/);
    assert.match(words, /\b2 items were sent\b/);
    assert.doesNotMatch(words, /nothing was sent/i);
    delete env.DEMO_OFF;
    assert.deepEqual(await c.write.push(input('ks')), { pushed: 5 });
    assert.deepEqual(system.sent, ['p0', 'p1', 'p2', 'p3', 'p4'], 'each item went once: the retry resumed after the sent batch');
    // Done now: a repeat calls nothing.
    assert.deepEqual(await c.write.push(input('ks')), { pushed: 5 });
    assert.equal(system.calls, 3);
  }
  // A failure (an outage) after the first batch: the same.
  {
    const { connector, system } = batchedPush();
    let requests = 0;
    const c = connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, ...fakeClock(), onRequest: () => { requests += 1; if (requests === 2) throw Object.assign(new Error('HTTP 503'), { status: 503 }); } });
    const failed = await settle(c.write.push(input('outage')));
    assert.ok(failed.error instanceof ConnectorFailed && !(failed.error instanceof PartialFailure), `got ${failed.error && failed.error.name}`);
    assert.deepEqual(failed.error.details.sent, { batches: 1, items: 2, recorded: true });
    assert.match(messageFor(failed.error), /couldn't finish sending to Demo: 2 items were sent/);
    assert.deepEqual(await c.write.push(input('outage')), { pushed: 5 });
    assert.deepEqual(system.sent, ['p0', 'p1', 'p2', 'p3', 'p4']);
  }
  // A rejected sign-in partway says what went too.
  const auth = new ConnectorAuthFailed('HTTP 401', { connector: 'demo', system: 'Demo', operation: 'push', sent: { batches: 1, items: 1 } });
  assert.match(messageFor(auth), /partway through: 1 item was sent before it stopped/);
  // A failure before anything was sent says nothing was sent, and records nothing.
  {
    const { connector, system } = batchedPush();
    let fail = true;
    const c = connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, ...fakeClock(), onRequest: () => { if (fail) throw new Error('HTTP 503'); } });
    const failed = await settle(c.write.push(input('none')));
    assert.equal(failed.error.details.sent, undefined);
    fail = false;
    assert.deepEqual(await c.write.push(input('none')), { pushed: 5 });
    assert.deepEqual(system.sent, ['p0', 'p1', 'p2', 'p3', 'p4']);
  }
});

test('resuming a stopped write needs the same input and batch size, else IdempotencyConflict and nothing is sent (#89 round 2)', async () => {
  const store = new Map();
  const idempotency = { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); } };
  const input = (count) => ({ items: items(count), idempotencyKey: 'k', dryRun: false });
  const first = batchedPush({ batchSize: 2 });
  let requests = 0;
  const c = first.connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency, ...fakeClock(), onRequest: () => { requests += 1; if (requests === 2) throw new Error('HTTP 503'); } });
  await assert.rejects(c.write.push(input(5)), ConnectorFailed);
  assert.deepEqual(first.system.sent, ['p0', 'p1']);
  // Same key, other input.
  await assert.rejects(c.write.push(input(4)), IdempotencyConflict);
  // Same key and input, but the connector now batches by 3 (a redeploy).
  const other = batchedPush({ batchSize: 3 });
  const c3 = other.connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency, ...fakeClock() });
  await assert.rejects(c3.write.push(input(5)), (e) => e instanceof IdempotencyConflict && /batch size/.test(e.reason));
  assert.equal(other.system.calls, 0);
  assert.deepEqual(first.system.sent, ['p0', 'p1']);
  // A store that keeps only { input, result } mangles the progress record:
  // the retry fails closed instead of sending it all again.
  const lossy = new Map();
  const narrow = { get: (k) => lossy.get(k), set: (k, { input: i, result }) => { lossy.set(k, { input: i, result }); } };
  const third = batchedPush({ batchSize: 2 });
  let n = 0;
  const cl = third.connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency: narrow, ...fakeClock(), onRequest: () => { n += 1; if (n === 2) throw new Error('HTTP 503'); } });
  await assert.rejects(cl.write.push(input(5)), ConnectorFailed);
  await assert.rejects(cl.write.push(input(5)), (e) => e instanceof ConnectorFailed && /progress record/.test(e.reason));
  assert.deepEqual(third.system.sent, ['p0', 'p1']);
});

// A write whose system answers each batch with `answer(batch)`, stopped by an
// outage on the second request. Returns what the store holds and what was sent.
async function stoppedWith(answer, { idempotency } = {}) {
  const store = new Map();
  const ledger = idempotency || { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); } };
  const sent = [];
  const connector = defineConnector(spec({
    write: {
      push: {
        plan: (i) => i,
        apply: async (input, ctx) => {
          const out = [];
          for (const batch of ctx.batches(input.items)) {
            out.push(await ctx.request(() => { sent.push(...batch.map((x) => x.id)); return answer(batch); }, { size: batch.length }));
          }
          return { batches: out.length };
        },
      },
    },
  }));
  const lines = [];
  let n = 0;
  const c = connector.create({
    log: createLog({ write: (line) => lines.push(JSON.parse(line)) }), env: { DEMO_TOKEN: TOKEN }, idempotency: ledger, ...fakeClock(),
    onRequest: () => { n += 1; if (n === 2) throw new Error('HTTP 503'); },
  });
  const input = { items: items(5), idempotencyKey: 'k', dryRun: false };
  const first = await settle(c.write.push(input));
  return { c, input, first, store, sent, lines };
}

test('a progress record never holds an answer with contact data: such a write fails closed on retry, and sends nothing more (#89 round 3)', async () => {
  const { c, input, first, store, sent } = await stoppedWith((batch) => ({ count: batch.length, id: 'c_123', contacts: batch.map((x) => ({ email: x.email })) }));
  assert.ok(first.error instanceof ConnectorFailed);
  const held = JSON.stringify([...store.values()]);
  assert.doesNotMatch(held, /example\.invalid/, `the store holds contact data: ${held}`);
  assert.deepEqual(first.error.details.sent, { batches: 1, items: 2, recorded: true });
  const retry = await settle(c.write.push(input));
  assert.ok(retry.error instanceof ConnectorFailed && /could not be kept/.test(retry.error.reason), `got ${retry.error && retry.error.reason}`);
  assert.deepEqual(sent, ['p0', 'p1'], 'nothing was sent again');
});

test('a progress record keeps counts and id-shaped refs, so a write answered with them resumes (#89 round 3)', async () => {
  const answers = [];
  const { c, input, store, sent } = await stoppedWith((batch) => {
    const a = { count: batch.length, ok: true, ids: batch.map((x, i) => `c_${answers.length}${i}`) };
    answers.push(a);
    return a;
  });
  const held = [...store.values()][0];
  assert.deepEqual(held.completed, [{ size: 2, result: answers[0] }]);
  assert.deepEqual(await c.write.push(input), { batches: 3 });
  assert.deepEqual(sent, ['p0', 'p1', 'p2', 'p3', 'p4']);
});

test('a progress record that could not be saved is marked unrecorded, logged as an error, and never called safe to retry (#89 round 3)', async () => {
  const store = new Map();
  const idempotency = { get: (k) => store.get(k), set: (k, v) => { if (k.includes('\u0001progress')) throw new Error('disk full'); store.set(k, v); } };
  const { first, lines } = await stoppedWith(() => 1, { idempotency });
  assert.ok(first.error instanceof ConnectorFailed);
  assert.deepEqual(first.error.details.sent, { batches: 1, items: 2, recorded: false });
  assert.ok(lines.some((l) => l.level === 'error' && /progress could not be recorded/.test(l.msg)), JSON.stringify(lines));
  const words = messageFor(first.error, { admin: 'Ely' });
  assert.match(words, /Ely should check what arrived before anyone tries again/);
  assert.doesNotMatch(words, /safe/i);
  const ks = new KillSwitchOn({ connector: 'demo', system: 'Demo', env: 'DEMO_OFF', sent: { batches: 1, items: 2, recorded: false } });
  assert.match(messageFor(ks, { admin: 'Ely' }), /Ely should check what arrived before anyone tries again/);
  const auth = new ConnectorAuthFailed('HTTP 401', { connector: 'demo', system: 'Demo', operation: 'push', sent: { batches: 1, items: 2, recorded: false } });
  assert.match(messageFor(auth, { admin: 'Ely' }), /Ely should check what arrived before anyone tries again/);
});

test('a per-item PartialFailure whose stale progress could not be cleared is not called safe to retry (#89 round 3)', async () => {
  const store = new Map();
  let broken = false;
  // Only the overwrite that clears the record fails: since 10.0 a failed save
  // after a request stops the write before it could partly fail.
  const idempotency = { get: (k) => store.get(k), set: (k, v) => { if (broken && k.includes('\u0001progress') && v.completed.length === 0) throw new Error('disk full'); store.set(k, v); } };
  const { connector } = batchedPush({ perItemIdempotency: true, partlyFails: true });
  let n = 0;
  const c = connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency, ...fakeClock(), onRequest: () => { n += 1; if (n === 2) throw new Error('HTTP 503'); } });
  const input = { items: items(4), idempotencyKey: 'k', dryRun: false };
  await assert.rejects(c.write.push(input), ConnectorFailed);
  broken = true;
  const partly = await settle(c.write.push(input));
  assert.ok(partly.error instanceof PartialFailure);
  assert.equal(partly.error.details.retrySafe, false);
  assert.doesNotMatch(messageFor(partly.error), /safe/);
});

test('a resumed write whose requests changed since the first try fails closed (#89 round 2)', async () => {
  let shift = 0;
  const sent = [];
  const connector = defineConnector(spec({
    write: {
      push: {
        plan: (i) => i,
        apply: async (input, ctx) => {
          await ctx.request(() => { sent.push('a'); }, { size: 1 + shift });
          await ctx.request(() => { sent.push('b'); }, { size: 1 });
          return { ok: true };
        },
      },
    },
  }));
  let requests = 0;
  const c = connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, ...fakeClock(), onRequest: () => { requests += 1; if (requests === 2) throw new Error('HTTP 503'); } });
  await assert.rejects(c.write.push({ idempotencyKey: 'k', dryRun: false }), ConnectorFailed);
  shift = 1;
  await assert.rejects(c.write.push({ idempotencyKey: 'k', dryRun: false }), (e) => e instanceof ConnectorFailed && /changed/.test(e.reason));
  assert.deepEqual(sent, ['a']);
});

test('after a PartialFailure, a per-item idempotent write re-sends on retry; any other write never re-sends what it sent (#89 round 2)', async () => {
  const input = { items: items(4), idempotencyKey: 'k', dryRun: false };
  const safe = batchedPush({ perItemIdempotency: true, partlyFails: true });
  const s = safe.connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, ...fakeClock() });
  await assert.rejects(s.write.push(input), PartialFailure);
  await assert.rejects(s.write.push(input), PartialFailure);
  assert.equal(safe.system.calls, 4, 'the retry re-sent: the system keys each item');
  const unsafe = batchedPush({ partlyFails: true });
  const u = unsafe.connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, ...fakeClock() });
  await assert.rejects(u.write.push(input), PartialFailure);
  await assert.rejects(u.write.push(input), PartialFailure);
  assert.equal(unsafe.system.calls, 2, 'the retry sent nothing twice');
});

// Story 10.0 (DEP-017): progress is saved after every request, not only when
// a write stops. A durable store is a Map behind JSON (what a file or a
// database hands back); each view is a new store object, as a new process
// would have, so a fresh connector never joins the dead one's in-flight write.
function durableStore() {
  const data = new Map();
  const progress = () => [...data.entries()].filter(([k]) => k.includes('\u0001progress')).map(([, v]) => JSON.parse(v));
  // onSet(slot, value): runs after the value is kept; may return a promise
  // that never settles (the process died there) or throw (the save failed).
  const view = (onSet) => ({
    get: (k) => (data.has(k) ? JSON.parse(data.get(k)) : undefined),
    set: (k, v) => { data.set(k, JSON.stringify(v)); return onSet ? onSet(k, v) : undefined; },
  });
  return { data, progress, view };
}
const DIES = () => new Promise(() => {});
const ticks = async (until, max = 1000) => { for (let i = 0; i < max && !until(); i += 1) await new Promise(setImmediate); };

test('a live batched write saves its progress after every request, so a process that dies after request k resumes at k+1 on a fresh connector (10.0)', async () => {
  // 5 items in batches of 2: three requests. k = 1 (the first), 2 (a middle
  // one) and 3 (the last: it died before the write could record its result).
  for (const k of [1, 2, 3]) {
    const system = { sent: [], calls: 0 };
    const make = () => defineConnector(spec({
      rateLimit: { perSecond: 10, batchSize: 2 },
      write: {
        push: {
          plan: (i) => i,
          apply: async (input, ctx) => {
            let n = 0;
            for (const batch of ctx.batches(input.items)) {
              n += await ctx.request(() => { system.calls += 1; system.sent.push(...batch.map((x) => x.id)); return { count: batch.length }; }, { size: batch.length }).then((r) => r.count);
            }
            return { pushed: n };
          },
        },
      },
    }));
    const store = durableStore();
    let saves = 0;
    const dying = store.view((slot) => { if (slot.includes('\u0001progress') && (saves += 1) === k) return DIES(); return undefined; });
    const input = { items: items(5), idempotencyKey: 'k', dryRun: false };
    make().create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency: dying, ...fakeClock() }).write.push(input);
    await ticks(() => saves >= k);
    assert.equal(saves, k, `k=${k}: a save after each of the first ${k} requests`);
    assert.equal(system.calls, k, `k=${k}: the process died after request ${k}`);
    // The record: counts and sizes only, bound to the input and batch size.
    const [record] = store.progress();
    assert.deepEqual(Object.keys(record).sort(), ['batchSize', 'completed', 'input', 'partial']);
    assert.equal(record.batchSize, 2);
    assert.match(record.input, /^[0-9a-f]{64}$/, 'the input is a fingerprint, never the rows');
    assert.deepEqual(record.completed, [{ size: 2, result: { count: 2 } }, { size: 2, result: { count: 2 } }, { size: 1, result: { count: 1 } }].slice(0, k));
    assert.doesNotMatch(JSON.stringify(record), /example\.invalid|p[0-9]/, 'no row data in the record');
    // A fresh connector (a restart) over the same store, same key and input,
    // sends only requests k+1 onwards and finishes.
    const before = system.calls;
    const fresh = make().create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency: store.view(), ...fakeClock() });
    assert.deepEqual(await fresh.write.push(input), { pushed: 5 });
    assert.equal(system.calls - before, 3 - k, `k=${k}: the restart sent ${3 - k} requests`);
    assert.deepEqual(system.sent, ['p0', 'p1', 'p2', 'p3', 'p4'], `k=${k}: each item went once`);
  }
});

test('a save that fails mid-write stops the write before the next request, unrecorded, and the admin is told to check first (10.0)', async () => {
  const store = durableStore();
  let saves = 0;
  const idempotency = store.view((slot) => { if (slot.includes('\u0001progress') && (saves += 1) === 2) throw new Error('disk full'); });
  const { connector, system } = batchedPush();
  const lines = [];
  const c = connector.create({ log: createLog({ write: (l) => lines.push(JSON.parse(l)) }), env: { DEMO_TOKEN: TOKEN }, idempotency, ...fakeClock() });
  const stopped = await settle(c.write.push({ items: items(5), idempotencyKey: 'k', dryRun: false }));
  assert.ok(stopped.error instanceof ConnectorFailed && !(stopped.error instanceof PartialFailure), `got ${stopped.error && stopped.error.name}`);
  assert.equal(system.calls, 2, 'the third request was never sent');
  assert.deepEqual(stopped.error.details.sent, { batches: 2, items: 4, recorded: false });
  assert.match(stopped.error.reason, /progress could not be saved/);
  assert.ok(lines.some((l) => l.level === 'error' && /progress could not be recorded/.test(l.msg)), JSON.stringify(lines));
  const words = messageFor(stopped.error, { admin: 'Ely' });
  assert.match(words, /\b4 items were sent\b/);
  assert.match(words, /Ely should check what arrived before anyone tries again/);
  assert.doesNotMatch(words, /safe/i);
});

test('an adapter that swallows a failed save still sends nothing more, and the write fails unrecorded (10.0)', async () => {
  const store = durableStore();
  const idempotency = store.view((slot) => { if (slot.includes('\u0001progress')) throw new Error('disk full'); });
  let calls = 0;
  const connector = defineConnector(spec({
    write: {
      push: {
        plan: (i) => i,
        apply: async (input, ctx) => {
          for (let i = 0; i < 3; i += 1) {
            try { await ctx.request(() => { calls += 1; return 1; }); } catch (_) { /* a careless adapter */ }
          }
          return { ok: true };
        },
      },
    },
  }));
  const c = connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency, ...fakeClock() });
  const r = await settle(c.write.push({ idempotencyKey: 'k', dryRun: false }));
  assert.equal(calls, 1, 'no request after the failed save');
  assert.ok(r.error instanceof ConnectorFailed, `got ${r.error ? r.error.name : 'a result'}`);
  assert.deepEqual(r.error.details.sent, { batches: 1, items: 1, recorded: false });
  assert.equal(store.data.get('demo\u0000push\u0000k'), undefined, 'the write was not recorded as done');
});

test('the suite\'s "dies after request k" case resumes on the same system, so a write whose later requests need its first one passes (10.0)', async () => {
  // Request 1 makes a list in the system; every later request needs it. The
  // system comes from a deps getter, fresh per instance, as the email tool's
  // outbox does: the restarted instance must reach the dying one's.
  const connector = defineConnector(spec({
    auth: { env: [] },
    rateLimit: { perSecond: 10, batchSize: 2 },
    connect: ({ data }) => data,
    read: undefined,
    write: {
      pushList: {
        perItemIdempotency: true,
        plan: (i) => i,
        apply: async (input, ctx) => {
          const { listId } = await ctx.request(() => { ctx.client.lists.add('list-1'); return { listId: 'list-1' }; });
          let added = 0;
          for (const batch of ctx.batches(input.items)) {
            added += (await ctx.request(() => {
              if (!ctx.client.lists.has(listId)) throw new Error('no such list');
              return { added: batch.length };
            }, { size: batch.length })).added;
          }
          return { listId, added };
        },
      },
    },
  }));
  const cases = [];
  connectorContract(connector, {
    read: {},
    write: { pushList: (idempotencyKey) => ({ items: items(3), idempotencyKey }) },
    bulk: { operation: 'pushList', input: (count, idempotencyKey) => ({ items: items(count), idempotencyKey }) },
  }, {
    test: (name, opts, fn) => cases.push({ name, fn: fn || opts }),
    deps: { get data() { return { lists: new Set() }; } },
  });
  const dies = cases.find((c) => /dies after request k/.test(c.name));
  await dies.fn(fakeT());
});

// B3: the saved progress of a per-item write must not survive a
// PartialFailure, or its retry would skip the batches holding failed items.
test('a per-item write that saved progress and then partly failed drops its record: the retry calls every batch and the tool adds only the failed items (10.0, B3)', async () => {
  // A system that keys each item and adds only keys it hasn't seen; refuses
  // the ids in fail. Each batch answers with counts and id-shaped refs.
  const tool = { keys: new Set(), calls: 0, fail: new Set(['p3']) };
  const connector = defineConnector(spec({
    rateLimit: { perSecond: 10, batchSize: 2 },
    write: {
      push: {
        perItemIdempotency: true,
        plan: (i) => i,
        apply: async (input, ctx) => {
          const total = { added: 0, alreadyAdded: 0, failedRefs: [] };
          for (const batch of ctx.batches(input.items)) {
            const res = await ctx.request(() => {
              tool.calls += 1;
              const out = { added: 0, alreadyAdded: 0, failedRefs: [] };
              for (const x of batch) {
                const key = `${ctx.idempotencyKey}:${x.id}`;
                if (tool.keys.has(key)) out.alreadyAdded += 1;
                else if (tool.fail.has(x.id)) out.failedRefs.push(x.id);
                else { tool.keys.add(key); out.added += 1; }
              }
              return out;
            }, { size: batch.length });
            total.added += res.added;
            total.alreadyAdded += res.alreadyAdded;
            total.failedRefs.push(...res.failedRefs);
          }
          if (total.failedRefs.length) {
            throw new PartialFailure('partly', { succeeded: total.added + total.alreadyAdded, failed: total.failedRefs.length, failedRefs: total.failedRefs });
          }
          return { added: total.added, alreadyAdded: total.alreadyAdded };
        },
      },
    },
  }));
  const store = durableStore();
  const make = () => connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency: store.view(), ...fakeClock() });
  const input = { items: items(5), idempotencyKey: 'k', dryRun: false };
  // p3 is in batch 2: progress was saved after batch 1, then batch 2 partly failed.
  const first = await settle(make().write.push(input));
  assert.ok(first.error instanceof PartialFailure, `got ${first.error && first.error.name}`);
  assert.equal(first.error.details.retrySafe, true);
  assert.deepEqual(store.progress(), [{ input: store.progress()[0].input, partial: true, batchSize: 2, completed: [] }], 'the record was overwritten with no completed requests');
  // The retry (a restart too) calls the system for every batch; only p3 is new.
  tool.fail.clear();
  const callsBefore = tool.calls;
  assert.deepEqual(await make().write.push(input), { added: 1, alreadyAdded: 4 });
  assert.equal(tool.calls - callsBefore, 3, 'every batch was called again');
  assert.equal(tool.keys.size, 5);
});

test('a per-item write resumed from an earlier try\'s record, then partly failing, drops that record too (10.0, B3)', async () => {
  const store = durableStore();
  const { connector, system } = batchedPush({ perItemIdempotency: true, partlyFails: true });
  let outage = true;
  let n = 0;
  const c = connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency: store.view(), ...fakeClock(), onRequest: () => { n += 1; if (outage && n === 2) throw new Error('HTTP 503'); } });
  const input = { items: items(4), idempotencyKey: 'k', dryRun: false };
  await assert.rejects(c.write.push(input), (e) => e instanceof ConnectorFailed && !(e instanceof PartialFailure));
  assert.equal(store.progress()[0].completed.length, 1, 'the outage left batch 1 recorded');
  outage = false;
  const partly = await settle(c.write.push(input));
  assert.ok(partly.error instanceof PartialFailure);
  assert.equal(partly.error.details.retrySafe, true);
  assert.deepEqual(store.progress()[0].completed, []);
  const before = system.calls;
  await assert.rejects(c.write.push(input), PartialFailure);
  assert.equal(system.calls - before, 2, 'the next retry called every batch');
});

test('a call waiting in the limiter re-checks a Retry-After hold set while it slept (#89 round 2)', async () => {
  let t = 0;
  const tick = () => new Promise((r) => setImmediate(r));
  const at = [];
  let first = true;
  const c = defineConnector(spec()).create({
    log: quietLog(), env: { DEMO_TOKEN: TOKEN },
    now: () => t,
    sleep: async (ms) => { t += ms; await tick(); await tick(); },
    onRequest: async (info) => {
      at.push(info.at);
      if (first) {
        first = false;
        await tick();
        throw Object.assign(new Error('HTTP 429'), { status: 429, headers: { 'retry-after': '5' } });
      }
    },
  });
  const results = await Promise.all([c.read.get(), c.read.get()]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal(at.length, 3);
  for (const when of at.slice(1)) assert.ok(when >= 5000, `a call went at ${when} ms, inside the 5 s hold: ${at}`);
});

test('err.retryAfter may be a Date, read against the injected clock (#89 round 2)', async () => {
  let t = Date.parse('2026-10-24T12:00:00Z');
  const at = [];
  const answers = [() => Object.assign(new Error('HTTP 429'), { status: 429, retryAfter: new Date(t + 4000) })];
  const c = defineConnector(spec()).create({
    log: quietLog(), env: { DEMO_TOKEN: TOKEN },
    now: () => t, sleep: async (ms) => { t += ms; },
    onRequest: (info) => { at.push(info.at); const a = answers.shift(); if (a) throw a(); },
  });
  assert.deepEqual(await c.read.get(), { ok: true });
  assert.equal(at[1] - at[0], 4000);
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

// DEP-012: a handler that creates its own instance must not get a fresh
// idempotency ledger, so every create() of one connector in a process shares one.
test('two instances of one connector share idempotency state: a repeat key from the second calls nothing (DEP-012)', async () => {
  let calls = 0;
  const connector = defineConnector(spec());
  const make = () => connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, onRequest: () => { calls += 1; } });
  const [a, b] = [make(), make()];
  assert.deepEqual(await a.write.put({ idempotencyKey: 'shared', v: 1, dryRun: false }), { put: true });
  assert.deepEqual(await b.write.put({ idempotencyKey: 'shared', v: 1, dryRun: false }), { put: true });
  assert.equal(calls, 1, 'the second instance saw the first instance\'s key');
  await assert.rejects(b.write.put({ idempotencyKey: 'shared', v: 2, dryRun: false }), IdempotencyConflict, 'the input fingerprint is shared too');
  assert.equal(calls, 1);
  await b.write.put({ idempotencyKey: 'other', v: 1, dryRun: false });
  assert.equal(calls, 2, 'a new key still writes');
});

test('two instances of one connector apply a concurrent repeat key once, with the default or an injected store (DEP-012)', async () => {
  for (const injected of [false, true]) {
    let calls = 0;
    const m = new Map();
    const idempotency = injected ? { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } } : undefined;
    const connector = defineConnector(spec({
      write: { put: { plan: (i) => i, apply: async (i, ctx) => ctx.request(async () => { await new Promise((r) => setTimeout(r, 10)); return { put: true }; }) } },
    }));
    const make = () => connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency, onRequest: () => { calls += 1; } });
    const both = await Promise.all([make(), make()].map((c) => c.write.put({ idempotencyKey: 'race', dryRun: false })));
    assert.deepEqual(both, [{ put: true }, { put: true }]);
    assert.equal(calls, 1, `injected store ${injected}: the second instance joined the first`);
  }
});

test('{ report: true } tells a replay from a fresh write: from the store or a concurrent call, replayed is true and nothing was sent (Story 10.3, N6)', async () => {
  let calls = 0;
  const connector = defineConnector(spec({
    write: { put: { plan: (i) => i, apply: async (i, ctx) => ctx.request(async () => { await new Promise((r) => setTimeout(r, 5)); return { put: true }; }) } },
  }));
  const c = connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, onRequest: () => { calls += 1; } });
  const report = { report: true };
  // Two at once: one applies, the other joins it and is told it sent nothing.
  const both = await Promise.all([c.write.put({ idempotencyKey: 'rep', dryRun: false }, report), c.write.put({ idempotencyKey: 'rep', dryRun: false }, report)]);
  assert.deepEqual(both.map((r) => r.replayed).sort(), [false, true]);
  assert.deepEqual(both.map((r) => r.result), [{ put: true }, { put: true }]);
  assert.equal(calls, 1);
  // Later, from the store.
  assert.deepEqual(await c.write.put({ idempotencyKey: 'rep', dryRun: false }, report), { result: { put: true }, replayed: true });
  // Without report the result is as before, and the options are not part of the input.
  assert.deepEqual(await c.write.put({ idempotencyKey: 'rep', dryRun: false }), { put: true });
  assert.equal(calls, 1);
  assert.deepEqual(await c.write.put({ idempotencyKey: 'rep2' }, report), { result: { dryRun: true, operation: 'put', wouldWrite: { idempotencyKey: 'rep2' } }, replayed: false });
});

test('a dry run on one instance does not use up the key for another (DEP-012)', async () => {
  let calls = 0;
  const connector = defineConnector(spec());
  const make = () => connector.create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN }, onRequest: () => { calls += 1; } });
  await make().write.put({ idempotencyKey: 'dry-then-live' });
  await make().write.put({ idempotencyKey: 'dry-then-live', dryRun: false });
  assert.equal(calls, 1);
});

test('two different connectors keep their own idempotency state (DEP-012)', async () => {
  let calls = 0;
  const opts = { log: quietLog(), env: { DEMO_TOKEN: TOKEN }, onRequest: () => { calls += 1; } };
  await defineConnector(spec()).create(opts).write.put({ idempotencyKey: 'mine', dryRun: false });
  await defineConnector(spec({ id: 'other' })).create(opts).write.put({ idempotencyKey: 'mine', dryRun: false });
  assert.equal(calls, 2);
});

test('two connectors sharing one injected store keep their keys apart: the slot names the connector (DEP-012)', async () => {
  const m = new Map();
  const idempotency = { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } };
  let calls = 0;
  const opts = { log: quietLog(), env: { DEMO_TOKEN: TOKEN }, idempotency, onRequest: () => { calls += 1; } };
  await defineConnector(spec()).create(opts).write.put({ idempotencyKey: 'same', dryRun: false });
  await defineConnector(spec({ id: 'other' })).create(opts).write.put({ idempotencyKey: 'same', dryRun: false });
  assert.equal(calls, 2, 'the second connector wrote rather than reuse the first one\'s result');
  // Each write's done slot and its progress record (saved after every
  // request, 10.0) name the connector.
  assert.deepEqual([...m.keys()].sort(), [
    'demo\u0000put\u0000same', 'demo\u0000put\u0001progress\u0000same',
    'other\u0000put\u0000same', 'other\u0000put\u0001progress\u0000same',
  ]);
});

// #90: a connector that declares no credential (a mock) can pass the suite.
test('a connector with no credential passes the suite: the declared-credential check is skipped, the shape check still runs (#90)', async () => {
  const open = defineConnector(spec({ auth: { env: [] }, connect: () => ({}) }));
  const cases = [];
  connectorContract(open, { read: { get: {} }, write: { put: (idempotencyKey) => ({ idempotencyKey }) } }, {
    test: (name, opts, fn) => cases.push({ name, fn: fn || opts, opts: fn ? opts : {} }),
  });
  const failed = [];
  const skipped = new Map();
  for (const c of cases) {
    if (c.opts.skip) { skipped.set(c.name, []); continue; }
    const t = fakeT();
    try { await c.fn(t); } catch (err) { failed.push(`${c.name}: ${err.message}`); }
    if (t.skipped) skipped.set(c.name, t.notes);
  }
  assert.deepEqual(failed, []);
  assert.ok(skipped.has('demo: errors never include credentials'), [...skipped.keys()].join('\n'));
  assert.ok(!skipped.has('demo: errors mask credential-shaped strings'), 'the shape check runs for every connector');
  // The skip says so in the test output, not only in a skip count (round 2, item 5).
  assert.match(skipped.get('demo: errors never include credentials').join('\n'), /declares no credentials.*skipped/i);
});

test('a bare token=<value> is masked in errors, not only after ?, & or ; (#90)', async () => {
  let body = '';
  const c = defineConnector(spec({ read: { get: async (i, ctx) => ctx.request(() => { throw new Error(body); }) } }))
    .create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
  for (const shape of ['token=fake-bare-1a', 'said token=fake-bare-1a.', '(api_key=fake-bare-1a)', 'x-token=fake-bare-1a']) {
    body = `system said: ${shape}`;
    await assert.rejects(c.read.get(), (e) => e instanceof ConnectorFailed && !e.message.includes('fake-bare-1a') && /\[redacted\]/.test(e.reason), shape);
  }
  body = 'retokenize=keep-this';
  await assert.rejects(c.read.get(), (e) => e.reason.includes('retokenize=keep-this'), 'a word ending in "token" is not a credential');
});

test('JSON secret fields, X-Api-Key style headers and any Authorization scheme are masked in errors (round 2)', async () => {
  let body = '';
  const c = defineConnector(spec({ read: { get: async (i, ctx) => ctx.request(() => { throw new Error(body); }) } }))
    .create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
  const v = 'fake-shape-7Hq';
  for (const shape of [
    `{"api_key":"${v}"}`, `{"apiKey": "${v}"}`, `{"token":"${v}"}`, `{"secret" : "${v} with space"}`, `{"password":"${v}"}`,
    `{"client_secret":"${v}"}`, `{"access_token":"${v}"}`, `{"refresh_token":"${v}"}`, `{"x-api-key":"${v}"}`,
    `X-Api-Key: ${v}`, `x-api-key:${v}`, `Api-Key: ${v}`, `X-Auth-Token: ${v}`,
    `Authorization: Token ${v}`, `Authorization: Basic ${v}`, `authorization: Bearer ${v}`, `Authorization: ${v}`,
    `{"Authorization":"Token ${v}"}`,
  ]) {
    body = `system said: ${shape} and status 400`;
    await assert.rejects(c.read.get(), (e) => {
      assert.ok(!e.message.includes(v), `${shape} leaked: ${e.message}`);
      assert.match(e.reason, /\[redacted\]/);
      assert.match(e.reason, /status 400/, 'the rest of the message is kept');
      return true;
    });
  }
  body = '{"scope":"read","token_type":"bearer","expires_in":3600}';
  await assert.rejects(c.read.get(), (e) => e.reason.includes('"scope":"read"') && e.reason.includes('"token_type":"bearer"'), 'non-secret fields are kept');
});

// #90: a batch that partly applied is a typed PartialFailure with its counts.
function partialSpec(details, { reason = '2 of 4 added, 2 failed', perItemIdempotency } = {}) {
  const push = {
    plan: (i) => i,
    async apply(input, ctx) {
      await ctx.request(() => true, { size: 2 });
      throw new sdk.PartialFailure(reason, details);
    },
  };
  if (perItemIdempotency !== undefined) push.perItemIdempotency = perItemIdempotency;
  return spec({ write: { push } });
}

test('a write that partly applied fails with PartialFailure carrying succeeded, failed and failedRefs (#90)', async () => {
  const lines = [];
  const log = createLog({ write: (l) => lines.push(l) });
  const c = defineConnector(partialSpec({ succeeded: 2, failed: 2, failedRefs: ['c-3', 4] })).create({ log, env: { DEMO_TOKEN: TOKEN } });
  const err = await c.write.push({ idempotencyKey: 'p1', dryRun: false }).catch((e) => e);
  assert.ok(err instanceof sdk.PartialFailure, `got ${err && err.name}`);
  assert.ok(err instanceof ConnectorFailed, 'a PartialFailure is a ConnectorFailed');
  assert.equal(err.code, 'PARTIAL_FAILURE');
  assert.deepEqual({ ...err.details }, {
    connector: 'demo', system: 'Demo', operation: 'push', succeeded: 2, failed: 2, failedRefs: ['c-3', '4'], retrySafe: false,
  });
  // The refs go to the log, with the counts, never to the person.
  const logged = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'connector write partly failed');
  assert.ok(logged, lines.join('\n'));
  assert.equal(logged.level, 'warn');
  assert.deepEqual([logged.connector, logged.operation, logged.succeeded, logged.failed, logged.failed_refs], ['demo', 'push', 2, 2, ['c-3', '4']]);
  assert.doesNotMatch(messageFor(err), /c-3/);
});

test('a PartialFailure does not use up its key: a retry with the same input applies again (#90)', async () => {
  let applies = 0;
  const c = defineConnector(spec({
    write: {
      push: {
        plan: (i) => i,
        async apply(input, ctx) {
          applies += 1;
          await ctx.request(() => true);
          if (applies === 1) throw new sdk.PartialFailure('1 of 2', { succeeded: 1, failed: 1, failedRefs: ['b'] });
          return { added: 1, alreadyAdded: 1 };
        },
      },
    },
  })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
  await assert.rejects(c.write.push({ idempotencyKey: 'p', dryRun: false }), sdk.PartialFailure);
  assert.deepEqual(await c.write.push({ idempotencyKey: 'p', dryRun: false }), { added: 1, alreadyAdded: 1 });
  assert.equal(applies, 2);
});

test('failedRefs are masked when they hold a credential or are not id-shaped (an email, a phone, a name, a sentence) (#90, round 2)', async () => {
  const masked = [
    TOKEN, 'person@home.invalid', 'has space', '',
    '5550139', '555-0139', '15551234567', '555.123.4567', '2026-10-24', '20261024',
    'Briar', 'Laurel', 'Mary-Jane', 'john.smith', 'O_Neil',
  ];
  const kept = ['c_123', 'CRM-00042', '123e4567-e89b-12d3-a456-426614174000', 'ok-1', '2', '42', '123456', 'list-abc:7'];
  const refs = [...masked, ...kept];
  const c = defineConnector(partialSpec({ succeeded: 0, failed: refs.length, failedRefs: refs })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
  const err = await c.write.push({ idempotencyKey: 'p', dryRun: false }).catch((e) => e);
  assert.ok(err instanceof sdk.PartialFailure, `got ${err && err.name}`);
  assert.deepEqual(err.details.failedRefs, [...masked.map(() => '[redacted]'), ...kept]);
  const text = [JSON.stringify(err), util.inspect(err, { depth: 10 }), err.stack].join('\n');
  for (const m of masked.filter(Boolean)) assert.ok(!text.includes(m), `${m} leaked: ${text}`);
});

test('a PartialFailure\'s text is rebuilt from its counts: an adapter can\'t leak refs or contact data through the reason (round 2)', async () => {
  const lines = [];
  const log = createLog({ write: (l) => lines.push(l) });
  const leaky = 'contact person@home.invalid (555-0139, ref c_9) was refused';
  const c = defineConnector(partialSpec({ succeeded: 3, failed: 1, failedRefs: ['c_9'] }, { reason: leaky })).create({ log, env: { DEMO_TOKEN: TOKEN } });
  const err = await c.write.push({ idempotencyKey: 'p', dryRun: false }).catch((e) => e);
  assert.ok(err instanceof sdk.PartialFailure);
  assert.equal(err.reason, '3 of 4 items succeeded, 1 failed');
  const text = [err.message, err.reason, err.stack, JSON.stringify(err), util.inspect(err, { depth: 10 }), lines.join('\n')].join('\n');
  for (const bit of ['person@home.invalid', '555-0139']) assert.ok(!text.includes(bit), `${bit} leaked: ${text}`);
  assert.ok(!err.message.includes('c_9') && !err.reason.includes('c_9'), 'refs stay out of the message; they are in details and the log only');
  // An invalid PartialFailure drops the adapter's text too.
  const bad = defineConnector(partialSpec({ succeeded: 1, failed: 2, failedRefs: ['c_9'] }, { reason: leaky })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
  const plain = await bad.write.push({ idempotencyKey: 'p', dryRun: false }).catch((e) => e);
  assert.ok(plain instanceof ConnectorFailed && !(plain instanceof sdk.PartialFailure));
  assert.ok(!plain.message.includes('person@home.invalid') && !plain.message.includes('555-0139'), plain.message);
});

test('a write may declare perItemIdempotency (true or false only), and a PartialFailure from it is retrySafe (round 2)', async () => {
  for (const bad of [1, 'yes', null, {}]) {
    assert.throws(() => defineConnector(partialSpec({}, { perItemIdempotency: bad })), (e) => e.message.includes('field "write.push.perItemIdempotency"'), String(bad));
  }
  assert.throws(() => defineConnector(spec({ write: { put: { plan: (i) => i, apply: async () => ({}), other: true } } })), /field "write.put"/);
  const decl = defineConnector(partialSpec({}, { perItemIdempotency: true }));
  assert.deepEqual([...decl.perItemIdempotency], ['push']);
  assert.deepEqual([...defineConnector(partialSpec({}, { perItemIdempotency: false })).perItemIdempotency], []);
  assert.deepEqual([...defineConnector(spec()).perItemIdempotency], []);
  for (const [flag, safe] of [[true, true], [false, false], [undefined, false]]) {
    const c = defineConnector(partialSpec({ succeeded: 1, failed: 1, failedRefs: ['c_1'] }, { perItemIdempotency: flag })).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
    const err = await c.write.push({ idempotencyKey: 'p', dryRun: false }).catch((e) => e);
    assert.equal(err.details.retrySafe, safe, `perItemIdempotency ${flag}`);
  }
});

test('the suite requires a bulk sample for a write that declares perItemIdempotency, and retries it after a failed batch (round 2)', async () => {
  const items = new Map();
  const listSpec = (perItem) => spec({
    rateLimit: { perSecond: 10, batchSize: 2 },
    write: {
      add: {
        perItemIdempotency: perItem,
        plan: (i) => ({ add: i.items.length }),
        async apply({ items: list }, ctx) {
          for (const batch of ctx.batches(list)) {
            await ctx.request(() => { for (const it of batch) items.set(`${ctx.idempotencyKey}:${it}`, it); }, { size: batch.length });
          }
          return { added: list.length };
        },
      },
    },
  });
  const samples = { read: { get: {} }, write: { add: (idempotencyKey) => ({ items: ['a', 'b', 'c'], idempotencyKey }) } };
  const bulk = { operation: 'add', input: (count, idempotencyKey) => ({ items: Array.from({ length: count }, (_, i) => `i${i}`), idempotencyKey }) };
  // Lists without a bulk sample already fail the declaration check; the flag
  // also names the retry check, which passes for an adapter that keys items.
  const withBulk = await failingCases(defineConnector(listSpec(true)), { ...samples, bulk });
  assert.deepEqual(withBulk, []);
  const noBulk = await failingCases(defineConnector(listSpec(true)), samples);
  assert.ok(noBulk.includes('a write that declares per-item idempotency retries cleanly after a failed batch'), noBulk.join('\n'));
  const cases = [];
  connectorContract(defineConnector(listSpec(true)), { ...samples, bulk }, { test: (name, opts, fn) => cases.push({ name, opts: fn ? opts : {} }) });
  const retry = cases.find((c) => /per-item idempotency/.test(c.name));
  assert.ok(retry && !retry.opts.skip, cases.map((c) => c.name).join('\n'));
  const none = [];
  connectorContract(defineConnector(listSpec(false)), { ...samples, bulk }, { test: (name, opts, fn) => none.push({ name, opts: fn ? opts : {} }) });
  assert.ok(none.find((c) => /per-item idempotency/.test(c.name)).opts.skip, 'skipped when no write declares it');
});

// Story 20.1: a bulk sample may declare the write's own item limit (the mock
// email tool's sendEmails takes at most 50 a push). The suite checks one more
// is refused before any I/O and the limit goes, sends no more than the limit
// in its bulk checks, and says so when the limit fits in one request.
test('the suite checks a write\'s own item limit, and sizes its bulk checks to it (Story 20.1)', async () => {
  const limitSpec = (enforce, batchSize) => spec({
    rateLimit: { perSecond: 10, batchSize },
    write: {
      send: {
        perItemIdempotency: true,
        plan: (i) => {
          if (enforce && i.items.length > 3) throw new Error('over the limit of 3');
          return { send: i.items.length };
        },
        async apply({ items: list }, ctx) {
          if (enforce && list.length > 3) throw new Error('over the limit of 3');
          for (const batch of ctx.batches(list)) await ctx.request(() => ({ sent: batch.length }), { size: batch.length });
          return { sent: list.length };
        },
      },
    },
  });
  const samples = { read: { get: {} }, write: { send: (idempotencyKey) => ({ items: ['a', 'b'], idempotencyKey }) } };
  const bulk = { operation: 'send', limit: 3, input: (count, idempotencyKey) => ({ items: Array.from({ length: count }, (_, i) => `i${i}`), idempotencyKey }) };
  const LIMIT_CASE = 'a write with an item limit refuses one more, before any I/O';
  // Batches of 2: a limit of 3 takes two requests, so every check runs.
  assert.deepEqual(await failingCases(defineConnector(limitSpec(true, 2)), { ...samples, bulk }), []);
  // Batches of 5: the limit fits in one request; the resume check says so.
  const cases = [];
  connectorContract(defineConnector(limitSpec(true, 5)), { ...samples, bulk }, { test: (name, opts, fn) => cases.push({ name, fn: fn || opts, opts: fn ? opts : {} }) });
  const failed = [];
  const notes = [];
  for (const c of cases) {
    if (c.opts.skip) continue;
    const t = fakeT();
    try { await c.fn(t); } catch { failed.push(c.name); }
    notes.push(...t.notes);
  }
  assert.deepEqual(failed, []);
  assert.ok(notes.some((n) => /send takes at most 3 items, one request/.test(n)), notes.join('\n'));
  // A write that ignores its limit fails the limit check.
  assert.deepEqual(await failingCases(defineConnector(limitSpec(false, 2)), { ...samples, bulk }), [LIMIT_CASE]);
  // No limit declared: the limit check is skipped.
  const none = [];
  connectorContract(defineConnector(limitSpec(true, 2)), { ...samples, bulk: { ...bulk, limit: undefined } }, { test: (name, opts, fn) => none.push({ name, opts: fn ? opts : {} }) });
  assert.ok(none.find((c) => c.name.endsWith(LIMIT_CASE)).opts.skip, 'skipped when no bulk sample declares a limit');
  // A limit that isn't a positive integer fails the declaration.
  const bad = await failingCases(defineConnector(limitSpec(true, 2)), { ...samples, bulk: { ...bulk, limit: 0 } });
  assert.ok(bad.includes('declares the contract (auth env names, operations, kill switch, rate limit)'), bad.join('\n'));
});

// Story 20.1 (Connector review P3 7, P3 9): a system's own limit for the day,
// before anything went, leaves as LimitReached rebuilt from checked details
// (not a ConnectorFailed, so approval-write does not escalate it), with its
// own words; after a request went, or with unchecked details, it is a plain
// ConnectorFailed. ctx.now is the connector's clock.
test('LimitReached leaves a write as its own refusal before anything went; ctx.now is the injected clock (Story 20.1)', async () => {
  const { LimitReached } = sdk;
  const seen = [];
  const limitSpec = (details, before = 0) => spec({
    write: {
      put: {
        plan: (i) => i,
        async apply(i, ctx) {
          seen.push(ctx.now());
          for (let n = 0; n < before; n += 1) await ctx.request(() => ({ put: 1 }));
          return ctx.request(() => { throw new LimitReached({ system: 'Demo', operation: 'put', ...details }); });
        },
      },
    },
  });
  const create = (s) => defineConnector(s).create({
    log: quietLog(), env: { DEMO_TOKEN: TOKEN }, now: () => 1234, sleep: async () => {},
  });
  const ok = { what: 'email', limit: 200, period: 'day' };
  const err = await create(limitSpec(ok)).write.put({ idempotencyKey: 'k', dryRun: false }).catch((e) => e);
  assert.ok(err instanceof LimitReached && !(err instanceof ConnectorFailed), `got ${err && err.name}`);
  assert.deepEqual({ ...err.details }, {
    connector: 'demo', system: 'Demo', operation: 'put', what: 'email', limit: 200, period: 'day',
  });
  assert.equal(messageFor(err), "Today's email limit is reached (200 a day), so nothing was sent. Try again tomorrow.");
  assert.deepEqual(seen, [1234], 'ctx.now is deps.now');
  for (const bad of [{ ...ok, what: 'Email <b>' }, { ...ok, limit: 0 }, { ...ok, period: 'hour' }]) {
    const e = await create(limitSpec(bad)).write.put({ idempotencyKey: 'k', dryRun: false }).catch((x) => x);
    assert.ok(e instanceof ConnectorFailed, `${JSON.stringify(bad)}: got ${e && e.name}`);
  }
  // After a request went, the person is told what went.
  const late = await create(limitSpec(ok, 1)).write.put({ idempotencyKey: 'k2', dryRun: false }).catch((e) => e);
  assert.ok(late instanceof ConnectorFailed && late.details.sent && late.details.sent.batches === 1, `got ${late && late.name}`);
});

test('a PartialFailure with bad counts, or from a read, is a plain ConnectorFailed (#90)', async () => {
  for (const details of [
    { succeeded: -1, failed: 1, failedRefs: ['a'] },
    { succeeded: 1, failed: 0, failedRefs: [] },
    { succeeded: 1.5, failed: 1, failedRefs: ['a'] },
    { succeeded: 1, failed: 2, failedRefs: ['a'] },
    { succeeded: 1, failed: 1 },
    undefined,
  ]) {
    const c = defineConnector(partialSpec(details)).create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
    const err = await c.write.push({ idempotencyKey: 'p', dryRun: false }).catch((e) => e);
    assert.ok(err instanceof ConnectorFailed && !(err instanceof sdk.PartialFailure), `${JSON.stringify(details)}: got ${err && err.name}`);
    assert.match(err.reason, /partial failure/i);
  }
  const r = defineConnector(spec({ read: { get: async () => { throw new sdk.PartialFailure('half', { succeeded: 1, failed: 1, failedRefs: ['a'] }); } } }))
    .create({ log: quietLog(), env: { DEMO_TOKEN: TOKEN } });
  const err = await r.read.get().catch((e) => e);
  assert.ok(err instanceof ConnectorFailed && !(err instanceof sdk.PartialFailure), 'a read never returns partial data, or a partial-failure count');
});

test('a partial failure, a setup fault and an outage each get an honest message; the setup fault names the admin (AD-17, #90, #82)', () => {
  const d = { connector: 'demo', system: 'Demo <Mail>', operation: 'push' };
  // By default the engine can't promise a retry is safe, so it doesn't (round 2).
  const partial = new sdk.PartialFailure('3 failed', { ...d, succeeded: 97, failed: 3, failedRefs: ['r-1', 'r-2', 'r-3'] });
  assert.equal(messageFor(partial), 'Sent 97 of 100 to Demo &lt;Mail&gt;; 3 failed. Please tell your admin before trying again.');
  assert.equal(messageFor(new sdk.PartialFailure('x', { ...d, succeeded: 97, failed: 3, failedRefs: ['r-1', 'r-2', 'r-3'], retrySafe: false }), { admin: '<@UADMIN>' }),
    'Sent 97 of 100 to Demo &lt;Mail&gt;; 3 failed. Please tell <@UADMIN> before trying again.');
  assert.doesNotMatch(messageFor(partial), /safe|twice/);
  // Only a write that declares per-item idempotency gets the safe-retry wording.
  const safe = new sdk.PartialFailure('3 failed', { ...d, succeeded: 97, failed: 3, failedRefs: ['r-1', 'r-2', 'r-3'], retrySafe: true });
  assert.equal(messageFor(safe),
    'Sent 97 of 100 to Demo &lt;Mail&gt;; 3 failed. Nothing was sent twice, so trying again is safe: it sends only the 3 that failed. If they keep failing, please tell your admin.');
  assert.equal(messageFor(safe, { admin: '<@UADMIN>' }),
    'Sent 97 of 100 to Demo &lt;Mail&gt;; 3 failed. Nothing was sent twice, so trying again is safe: it sends only the 3 that failed. If they keep failing, please tell <@UADMIN>.');
  for (const ref of ['r-1', 'r-2', 'r-3']) assert.ok(!messageFor(partial).includes(ref) && !messageFor(safe).includes(ref), 'failed refs never reach the person');
  const setup = new ConnectorAuthFailed('DEMO_TOKEN is not set', { ...d, setup: true });
  assert.equal(messageFor(setup, { admin: '<@UADMIN>' }), "Demo &lt;Mail&gt; isn't set up correctly, so I can't reach it. I've logged the problem; please tell <@UADMIN>.");
  assert.equal(messageFor(new ConnectorAuthFailed('401', d), { admin: '<@UADMIN>' }),
    "Demo &lt;Mail&gt; turned down my sign-in, so I couldn't reach it. Please tell <@UADMIN>; trying again won't help until it's fixed.");
  assert.equal(messageFor(new ConnectorFailed('HTTP 500', d), { admin: '<@UADMIN>' }),
    "I couldn't reach Demo &lt;Mail&gt; just now. Please try again later, or tell <@UADMIN> if it keeps happening.");
  const words = [partial, setup, new ConnectorAuthFailed('401', d), new ConnectorFailed('HTTP 500', d)].map((e) => messageFor(e));
  assert.equal(new Set(words).size, 4, 'no two read alike');
  assert.doesNotMatch(words[1], /try again later|just now/, 'a setup fault never reads as a passing outage');
});
