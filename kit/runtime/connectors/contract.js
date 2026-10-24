'use strict';

// The connector contract (AD-15, Story 8.1): one shape for every external
// system, with the guardrails enforced here rather than in each adapter.
//
//   module.exports = defineConnector({
//     id: 'crm', system: 'Acme CRM',
//     auth: { env: ['ACME_CRM_TOKEN'] },          // env var NAMES, never values
//     killSwitchEnv: 'ACME_CRM_OFF',
//     rateLimit: { perSecond: 5, batchSize: 100 },
//     connect: ({ secret }) => makeClient(secret('ACME_CRM_TOKEN')),  // also gets { data, simulate }
//     read: { lookupClient: async (input, ctx) => ctx.request(() => ctx.client.get(...)) },
//     write: { addContacts: { plan: (input) => preview, apply: async (input, ctx) => result } },
//   });
//
//   const crm = connector.create({ env, log });  // one instance per process
//   await crm.read.lookupClient({ clientId, fields: ['email'] });
//   await crm.write.addContacts({ ...input, idempotencyKey, dryRun: false });
//
// What every instance guarantees:
//   - A write is a dry run unless the caller passes dryRun: false. A dry run
//     returns { dryRun: true, operation, wouldWrite: plan(input) } and does no
//     I/O (plan gets no ctx). A dry run never records its idempotency key.
//   - Every write, dry run included, refuses with KillSwitchOn when the
//     connector's killSwitchEnv or APLABS_WRITES_OFF is set to any non-empty
//     value, before credentials are read or anything is called. Reads keep
//     working. The env is read on every call, so flipping a switch takes effect
//     at once.
//   - Every write needs an idempotencyKey. A repeated key (per operation)
//     returns the first result and calls nothing; two concurrent calls with
//     one key share one apply. Keys are kept in deps.idempotency ({ get, set })
//     or, by default, in memory for the instance's life.
//   - Credentials are read once through kit/lib/secrets (env only) and cached
//     with the client connect() returns; a missing one fails closed with
//     ConnectorAuthFailed naming the env var, before any I/O. An auth error
//     from the system (an error with status 401 or 403, or a thrown
//     ConnectorAuthFailed) fails closed too and drops the cached client so the
//     next call re-reads the credential.
//   - Every call to the system goes through ctx.request(fn, { size }), which
//     spaces calls at least 1000 / perSecond ms apart (it waits, never drops)
//     and refuses a batch larger than batchSize. ctx.batches(items) splits a
//     list into batches of batchSize.
//   - Every error that leaves an operation is a ConnectorFailed (or
//     ConnectorAuthFailed / KillSwitchOn) built fresh from a redacted message:
//     the connector's own credentials, credential-shaped strings and the log
//     redactor's patterns are masked, and the original error is not kept.

const { readSecret, redact } = require('../../lib/secrets');
const { createLog } = require('../log');
const { KillSwitchOn, ConnectorFailed, ConnectorAuthFailed } = require('../errors');

const GLOBAL_KILL_SWITCH = 'APLABS_WRITES_OFF';
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const OP_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,62}$/;
const MAX_KEY = 256;
const MASK = '[redacted]';
// Credential shapes masked whether or not the connector declared them.
const PATTERNS = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /([?&;](?:access_token|refresh_token|token|api[_-]?key|apikey|key|secret|client_secret|password|signature|sig)=)[^&\s'"<>]+/gi,
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@'"<>]+:[^\s/@'"<>]+@/gi,
];

const isFn = (f) => typeof f === 'function';

// Throws naming the field when a declaration breaks the contract.
function checkDeclaration(spec) {
  const fail = (field, why) => { throw new Error(`connector${spec && spec.id ? ` "${spec.id}"` : ''}: field "${field}" ${why}`); };
  if (!spec || typeof spec !== 'object') throw new Error('connector: the declaration must be an object');
  const known = ['id', 'system', 'auth', 'killSwitchEnv', 'rateLimit', 'connect', 'read', 'write'];
  for (const k of Object.keys(spec)) if (!known.includes(k)) fail(k, 'is not a contract field');
  if (typeof spec.id !== 'string' || !SLUG.test(spec.id)) fail('id', 'must be a lower-case slug');
  if (typeof spec.system !== 'string' || !spec.system.trim()) fail('system', 'must be the system\'s plain name');
  if (!spec.auth || typeof spec.auth !== 'object' || !Array.isArray(spec.auth.env)) fail('auth', 'must be { env: [env var names] }');
  if (Object.keys(spec.auth).some((k) => k !== 'env')) fail('auth', 'may hold only env');
  for (const name of spec.auth.env) {
    if (typeof name !== 'string' || !ENV_NAME.test(name)) fail('auth.env', 'must list env var names (UPPER_SNAKE), never values');
  }
  if (new Set(spec.auth.env).size !== spec.auth.env.length) fail('auth.env', 'lists a name twice');
  if (typeof spec.killSwitchEnv !== 'string' || !ENV_NAME.test(spec.killSwitchEnv)) fail('killSwitchEnv', 'must be an env var name (UPPER_SNAKE)');
  if (spec.killSwitchEnv === GLOBAL_KILL_SWITCH) fail('killSwitchEnv', `must be the connector's own switch, not ${GLOBAL_KILL_SWITCH}`);
  if (spec.auth.env.includes(spec.killSwitchEnv)) fail('killSwitchEnv', 'must not be a credential');
  const rl = spec.rateLimit;
  if (!rl || typeof rl !== 'object' || Object.keys(rl).some((k) => !['perSecond', 'batchSize'].includes(k))) {
    fail('rateLimit', 'must be { perSecond, batchSize }');
  }
  if (!(typeof rl.perSecond === 'number' && rl.perSecond > 0 && Number.isFinite(rl.perSecond))) fail('rateLimit.perSecond', 'must be a positive number');
  if (!(Number.isInteger(rl.batchSize) && rl.batchSize > 0)) fail('rateLimit.batchSize', 'must be a positive integer');
  if (spec.connect !== undefined && !isFn(spec.connect)) fail('connect', 'must be a function');
  for (const kind of ['read', 'write']) {
    const ops = spec[kind];
    if (ops === undefined) continue;
    if (!ops || typeof ops !== 'object' || Array.isArray(ops)) fail(kind, 'must map operation names to operations');
    for (const [name, op] of Object.entries(ops)) {
      if (!OP_NAME.test(name)) fail(`${kind}.${name}`, 'must be a camelCase name');
      if (kind === 'read' && !isFn(op)) fail(`read.${name}`, 'must be a function (input, ctx)');
      if (kind === 'write' && !(op && isFn(op.plan) && isFn(op.apply) && Object.keys(op).length === 2)) {
        fail(`write.${name}`, 'must be { plan(input), apply(input, ctx) }');
      }
    }
  }
  const reads = Object.keys(spec.read || {});
  const writes = Object.keys(spec.write || {});
  if (!reads.length && !writes.length) fail('read', 'or write must declare at least one operation');
  const both = reads.find((n) => writes.includes(n));
  if (both) fail(`write.${both}`, 'has the same name as a read');
}

const isAuthError = (err) => err instanceof ConnectorAuthFailed || (err && (err.status === 401 || err.status === 403));

// Calls spaced at least interval ms apart, in arrival order. Waits, never drops.
function createLimiter(perSecond, now, sleep) {
  const interval = 1000 / perSecond;
  let last = -Infinity;
  let gate = Promise.resolve();
  return () => {
    const turn = gate.then(async () => {
      const wait = last + interval - now();
      if (wait > 0) await sleep(wait);
      last = now();
    });
    gate = turn.catch(() => {});
    return turn;
  };
}

function defineConnector(spec) {
  checkDeclaration(spec);
  const declaration = Object.freeze({
    id: spec.id,
    system: spec.system,
    auth: Object.freeze({ env: Object.freeze([...spec.auth.env]) }),
    killSwitchEnv: spec.killSwitchEnv,
    rateLimit: Object.freeze({ perSecond: spec.rateLimit.perSecond, batchSize: spec.rateLimit.batchSize }),
    read: Object.freeze(Object.keys(spec.read || {})),
    write: Object.freeze(Object.keys(spec.write || {})),
  });

  // deps: env (default process.env), log (a kit/runtime/log logger: secrets
  // are registered with it), now and sleep (tests inject a clock),
  // idempotency ({ get(key), set(key, result) }), onRequest(info) (tests: runs
  // before each call to the system; it may throw to simulate the system
  // failing), simulate (passed to connect() as is, for an adapter's own
  // failure simulation in tests), data (the query runner, passed to connect()
  // as is, for a connector that reads the client's data: its reads then pass
  // the SQL guardrail and the profile's forbidden columns).
  function create(deps = {}) {
    const env = deps.env || process.env;
    const log = deps.log || createLog({ write: () => {} });
    const now = deps.now || Date.now;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const ledger = deps.idempotency || (() => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } }; })();
    const limit = createLimiter(declaration.rateLimit.perSecond, now, sleep);
    const inFlight = new Map();
    const seen = [];
    let session = null;

    const clean = (text) => log.redact(redact(text, seen, { mask: MASK, patterns: PATTERNS }));
    const details = (operation) => ({ connector: declaration.id, system: declaration.system, operation });

    function killSwitch() {
      for (const name of [declaration.killSwitchEnv, GLOBAL_KILL_SWITCH]) if (env[name]) return name;
      return null;
    }

    // Reads every declared credential (once), then connects (once).
    function open(operation) {
      if (session) return session;
      const values = {};
      for (const name of declaration.auth.env) {
        const value = readSecret(name, null, { env });
        if (!value) throw new ConnectorAuthFailed(`${name} is not set`, details(operation));
        values[name] = log.registerSecret(value);
        if (!seen.includes(value)) seen.push(value);
      }
      const secret = (name) => {
        if (!Object.hasOwn(values, name)) throw new Error(`${declaration.id}: ${name} is not a declared credential`);
        return values[name];
      };
      session = { client: spec.connect ? spec.connect({ secret, simulate: deps.simulate, data: deps.data }) : null };
      return session;
    }

    function context(operation, kind, client, extra = {}) {
      return Object.freeze({
        operation,
        client,
        ...extra,
        batches(items) {
          const out = [];
          for (let i = 0; i < items.length; i += declaration.rateLimit.batchSize) out.push(items.slice(i, i + declaration.rateLimit.batchSize));
          return out;
        },
        async request(fn, { size = 1 } = {}) {
          if (!Number.isInteger(size) || size < 0 || size > declaration.rateLimit.batchSize) {
            throw new Error(`batch of ${size} is over the batch size of ${declaration.rateLimit.batchSize}`);
          }
          await limit();
          if (deps.onRequest) await deps.onRequest({ connector: declaration.id, operation, kind, size, at: now() });
          return fn();
        },
      });
    }

    // Every error leaving an operation is rebuilt from a redacted message.
    function rethrow(err, operation) {
      if (err instanceof KillSwitchOn) throw err;
      const raw = err instanceof ConnectorFailed ? err.reason : (err && err.message) || String(err);
      const reason = clean(raw);
      if (isAuthError(err)) {
        session = null;
        throw new ConnectorAuthFailed(reason, details(operation));
      }
      throw new ConnectorFailed(reason, details(operation));
    }

    const read = {};
    for (const [name, op] of Object.entries(spec.read || {})) {
      read[name] = async (input = {}) => {
        try {
          const { client } = open(name);
          return await op(input, context(name, 'read', client));
        } catch (err) {
          return rethrow(err, name);
        }
      };
    }

    const write = {};
    for (const [name, op] of Object.entries(spec.write || {})) {
      write[name] = async (input = {}) => {
        const switched = killSwitch();
        if (switched) throw new KillSwitchOn({ connector: declaration.id, system: declaration.system, env: switched });
        const { dryRun, ...rest } = input;
        const key = rest.idempotencyKey;
        try {
          if (typeof key !== 'string' || !key || key.length > MAX_KEY) {
            throw new Error(`idempotencyKey must be a non-empty string of at most ${MAX_KEY} characters`);
          }
          if (dryRun !== false) return { dryRun: true, operation: name, wouldWrite: await op.plan(rest) };
          const slot = `${name}\u0000${key}`;
          const done = await ledger.get(slot);
          if (done !== undefined) return done;
          if (inFlight.has(slot)) return await inFlight.get(slot);
          const run = (async () => {
            const { client } = open(name);
            const result = await op.apply(rest, context(name, 'write', client, { idempotencyKey: key }));
            await ledger.set(slot, result === undefined ? null : result);
            return result === undefined ? null : result;
          })();
          inFlight.set(slot, run);
          try { return await run; } finally { inFlight.delete(slot); }
        } catch (err) {
          return rethrow(err, name);
        }
      };
    }

    return Object.freeze({
      id: declaration.id,
      system: declaration.system,
      describe: () => declaration,
      // The env var name of the kill switch that is on, or null. The
      // approval-write archetype checks it before consuming an approval.
      killSwitch,
      read: Object.freeze(read),
      write: Object.freeze(write),
    });
  }

  return Object.freeze({ ...declaration, declaration, create });
}

module.exports = {
  defineConnector, checkDeclaration, GLOBAL_KILL_SWITCH,
  KillSwitchOn, ConnectorFailed, ConnectorAuthFailed,
};
