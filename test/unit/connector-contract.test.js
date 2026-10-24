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
    ['a repeated idempotency key changes nothing']],
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
  assert.match(r.stdout, /pass 13\n/);
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
  assert.deepEqual([...m.keys()].sort(), ['demo\u0000put\u0000same', 'other\u0000put\u0000same']);
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
