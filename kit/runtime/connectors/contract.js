'use strict';

// The connector contract (AD-15, Story 8.1): one shape for every external
// system, with the guardrails enforced here rather than in each adapter.
//
//   module.exports = defineConnector({
//     id: 'crm', system: 'Acme CRM',
//     auth: { env: ['ACME_CRM_TOKEN'] },          // env var NAMES, never values
//     killSwitchEnv: 'ACME_CRM_OFF',
//     rateLimit: { perSecond: 5, batchSize: 100 },
//     connect: ({ secret }) => makeClient(secret('ACME_CRM_TOKEN')),  // also gets { registerSecret, data, simulate }
//     read: { lookupClient: async (input, ctx) => ctx.request(() => ctx.client.get(...)) },
//     write: { addContacts: { plan: (input) => preview, apply: async (input, ctx) => result } },
//   });
//
//   const crm = connector.create({ env, log });  // log is required; instances share idempotency state
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
//     working. The env is read on every call and again before every request
//     a write makes, so flipping a switch takes effect at once, even partway
//     through a push: the requests still to come are refused.
//   - Every write needs an idempotencyKey. A repeated key (per operation)
//     with the same input returns the first result and calls nothing; two
//     concurrent calls with one key share one apply. The input is fingerprinted
//     under its key, so a reused key with a different input is refused with
//     IdempotencyConflict and calls nothing. Keys are kept in
//     deps.idempotency ({ get, set }, holding { input, result }) or, by
//     default, in memory for the process's life, in one store per connector
//     (per defineConnector) that every instance it creates shares: a second
//     create() in the process sees the first one's keys, and a concurrent
//     repeat on another instance joins the first apply (DEP-012). Instances
//     given the same deps.idempotency object share their in-flight writes too.
//   - Only kit/runtime/archetypes/approval-write passes dryRun: false (AD-15);
//     the write-path check (scripts/check-write-path.js, run by npm run check
//     and npm test) fails app code that writes live outside it.
//   - Credentials are read once through kit/lib/secrets, from env only (no
//     Keychain fallback, unlike other AD-12 reads: see AD-12), and cached
//     with the client connect() returns (or resolves to: connect may be async,
//     and a rejected connect is dropped, not cached); a missing one fails closed with
//     ConnectorAuthFailed naming the env var, before any I/O. An auth error
//     from the system (an error with status 401 or 403, or a thrown
//     ConnectorAuthFailed) fails closed too and drops the cached client so the
//     next call re-reads the credential.
//   - Every call to the system goes through ctx.request(fn, { size }), which
//     spaces calls at least 1000 / perSecond ms apart (it waits, never drops)
//     and refuses a batch larger than batchSize. ctx.batches(items) splits a
//     list into batches of batchSize. A call that fails with status 429 is
//     retried through the limiter, which holds every call for its Retry-After
//     (up to 60 s; longer fails at once), at most 3 attempts in all; then the
//     operation fails with ConnectorFailed.
//   - Every error that leaves an operation is a ConnectorFailed (or
//     ConnectorAuthFailed / KillSwitchOn) built fresh from a redacted message:
//     the connector's own credentials, any token connect() obtained and passed
//     to registerSecret, credential-shaped strings (headers, query values,
//     URL passwords, JSON access_token / refresh_token / id_token) and the log
//     redactor's patterns are masked, and the original error is not kept.

const crypto = require('node:crypto');
const { readSecret, redact } = require('../../lib/secrets');
const {
  KillSwitchOn, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict,
} = require('../errors');

const GLOBAL_KILL_SWITCH = 'APLABS_WRITES_OFF';
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const OP_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,62}$/;
const MAX_KEY = 256;
// A 429 is retried this many times in all, waiting what Retry-After asks,
// but never longer than MAX_RETRY_AFTER_MS: past that the call fails.
const RATE_LIMIT_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const MASK = '[redacted]';
// Credential shapes masked whether or not the connector declared them.
const PATTERNS = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /([?&;](?:access_token|refresh_token|token|api[_-]?key|apikey|key|secret|client_secret|password|signature|sig)=)[^&\s'"<>]+/gi,
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@'"<>]+:[^\s/@'"<>]+@/gi,
  /"(?:access_token|refresh_token|id_token)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
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

// JSON with object keys sorted, so key order is not a different input.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// The write's input, minus its key, as a short hash.
const fingerprint = ({ idempotencyKey, ...input }) => crypto.createHash('sha256').update(canonical(input)).digest('hex');

const isAuthError = (err) => err instanceof ConnectorAuthFailed || (err && (err.status === 401 || err.status === 403));

// Calls spaced at least interval ms apart, in arrival order. Waits, never drops.
// hold(ms) holds every call back for ms (a system's Retry-After).
function createLimiter(perSecond, now, sleep) {
  const interval = 1000 / perSecond;
  let last = -Infinity;
  let heldUntil = -Infinity;
  let gate = Promise.resolve();
  const limit = () => {
    const turn = gate.then(async () => {
      const wait = Math.max(last + interval, heldUntil) - now();
      if (wait > 0) await sleep(wait);
      last = now();
    });
    gate = turn.catch(() => {});
    return turn;
  };
  limit.hold = (ms) => { heldUntil = Math.max(heldUntil, now() + ms); };
  return limit;
}

// Retry-After from a 429, in ms: err.retryAfter (seconds) or the header,
// as seconds or an HTTP date. 0 when absent or unreadable.
function retryAfterMs(err) {
  const h = err.headers;
  const raw = err.retryAfter ?? (h && (typeof h.get === 'function' ? h.get('retry-after') : h['retry-after'] ?? h['Retry-After']));
  if (raw === undefined || raw === null || raw === '') return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

// In-flight writes per idempotency store, so instances sharing a store also
// share the writes still running under it: a concurrent repeat key joins the
// first apply instead of missing it and applying again (DEP-012).
const IN_FLIGHT = new WeakMap();
function inFlightFor(store) {
  if (!IN_FLIGHT.has(store)) IN_FLIGHT.set(store, new Map());
  return IN_FLIGHT.get(store);
}

const memoryLedger = () => { const m = new Map(); return Object.freeze({ get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } }); };

function defineConnector(spec) {
  checkDeclaration(spec);
  // The default idempotency store: one per connector for the process's life,
  // shared by every instance create() makes, so a second instance (a handler
  // that created its own) sees the keys the first applied (DEP-012).
  const sharedLedger = memoryLedger();
  const declaration = Object.freeze({
    id: spec.id,
    system: spec.system,
    auth: Object.freeze({ env: Object.freeze([...spec.auth.env]) }),
    killSwitchEnv: spec.killSwitchEnv,
    rateLimit: Object.freeze({ perSecond: spec.rateLimit.perSecond, batchSize: spec.rateLimit.batchSize }),
    read: Object.freeze(Object.keys(spec.read || {})),
    write: Object.freeze(Object.keys(spec.write || {})),
  });

  // deps: env (default process.env), log (required: the app's
  // kit/runtime/log logger, so every credential registers with it, AD-12; a
  // test passes its own, such as the SDK's testLog()), now and sleep (tests
  // inject a clock), idempotency ({ get(key), set(key, { input, result }) }:
  // input is the write input's fingerprint), onRequest(info) (tests: runs
  // before each call to the system; it may throw to simulate the system
  // failing), simulate (passed to connect() as is, for an adapter's own
  // failure simulation in tests), data (a query runner, passed to connect()
  // as is, for a connector that reads the client's data). The contract does
  // not check what data is: only when it is kit/runtime/data's runner (what
  // the app passes) do the connector's reads pass the SQL guardrail and the
  // profile's forbidden columns. A test's stand-in runner checks neither.
  function create(deps = {}) {
    const { log } = deps;
    if (!log || typeof log.registerSecret !== 'function' || typeof log.redact !== 'function') {
      throw new Error(`connector "${declaration.id}": create() needs deps.log, the app's logger (kit/runtime/log), so its credentials are masked in every log line`);
    }
    const env = deps.env || process.env;
    const now = deps.now || Date.now;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const store = deps.idempotency;
    if (store !== undefined && !(store && isFn(store.get) && isFn(store.set))) {
      throw new Error(`connector "${declaration.id}": deps.idempotency must be { get(key), set(key, value) }`);
    }
    const ledger = store || sharedLedger;
    const inFlight = inFlightFor(ledger);
    const limit = createLimiter(declaration.rateLimit.perSecond, now, sleep);
    const seen = [];
    let session = null;

    const clean = (text) => log.redact(redact(text, seen, { mask: MASK, patterns: PATTERNS }));
    const details = (operation) => ({ connector: declaration.id, system: declaration.system, operation });

    function killSwitch() {
      for (const name of [declaration.killSwitchEnv, GLOBAL_KILL_SWITCH]) if (env[name]) return name;
      return null;
    }

    function refuseIfSwitchedOff() {
      const switched = killSwitch();
      if (switched) throw new KillSwitchOn({ connector: declaration.id, system: declaration.system, env: switched });
    }

    // Reads every declared credential (once), then connects (once). connect
    // may be async: concurrent first calls share one connect, and a rejected
    // one is dropped so the next call reads the credentials and connects again
    // (rethrow maps an auth-style rejection to ConnectorAuthFailed).
    function open(operation) {
      if (session) return session;
      const opening = connectOnce(operation);
      session = opening;
      opening.catch(() => { if (session === opening) session = null; });
      return opening;
    }

    async function connectOnce(operation) {
      // Masks a value in this connector's errors and in every app log line.
      const registerSecret = (value) => {
        if (typeof value !== 'string' || !value) throw new Error(`${declaration.id}: registerSecret takes a non-empty string`);
        log.registerSecret(value);
        if (!seen.includes(value)) seen.push(value);
        return value;
      };
      const values = {};
      for (const name of declaration.auth.env) {
        const value = readSecret(name, null, { env });
        if (!value) throw new ConnectorAuthFailed(`${name} is not set`, { ...details(operation), setup: true });
        values[name] = registerSecret(value);
      }
      const secret = (name) => {
        if (!Object.hasOwn(values, name)) throw new Error(`${declaration.id}: ${name} is not a declared credential`);
        return values[name];
      };
      return { client: spec.connect ? await spec.connect({ secret, registerSecret, simulate: deps.simulate, data: deps.data }) : null };
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
          for (let attempt = 1; ; attempt += 1) {
            await limit();
            // Re-checked before every request of a write, after the wait, so a
            // switch flipped partway through a push stops the requests still to come.
            if (kind === 'write') refuseIfSwitchedOff();
            try {
              if (deps.onRequest) await deps.onRequest({ connector: declaration.id, operation, kind, size, at: now() });
              return await fn();
            } catch (err) {
              // A 429 was not processed, so retrying it is safe, writes included.
              if (!err || err.status !== 429) throw err;
              if (attempt >= RATE_LIMIT_ATTEMPTS) throw new Error(`still rate limited after ${RATE_LIMIT_ATTEMPTS} attempts`);
              const wait = retryAfterMs(err);
              if (wait > MAX_RETRY_AFTER_MS) {
                throw new Error(`rate limited: asked to wait ${Math.ceil(wait / 1000)} s, over the ${MAX_RETRY_AFTER_MS / 1000} s limit`);
              }
              limit.hold(wait);
            }
          }
        },
      });
    }

    // Every error leaving an operation is rebuilt from a redacted message.
    function rethrow(err, operation) {
      if (err instanceof KillSwitchOn) throw err;
      if (err instanceof IdempotencyConflict) throw new IdempotencyConflict(clean(err.reason), details(operation));
      const raw = err instanceof ConnectorFailed ? err.reason : (err && err.message) || String(err);
      const reason = clean(raw);
      if (isAuthError(err)) {
        session = null;
        // setup: a credential is not set (a setup fault), not a rejected one.
        const setup = err instanceof ConnectorAuthFailed && err.details && err.details.setup === true;
        throw new ConnectorAuthFailed(reason, setup ? { ...details(operation), setup: true } : details(operation));
      }
      throw new ConnectorFailed(reason, details(operation));
    }

    const read = {};
    for (const [name, op] of Object.entries(spec.read || {})) {
      read[name] = async (input = {}) => {
        try {
          const { client } = await open(name);
          return await op(input, context(name, 'read', client));
        } catch (err) {
          return rethrow(err, name);
        }
      };
    }

    const write = {};
    for (const [name, op] of Object.entries(spec.write || {})) {
      write[name] = async (input = {}) => {
        refuseIfSwitchedOff();
        const { dryRun, ...rest } = input;
        const key = rest.idempotencyKey;
        try {
          if (typeof key !== 'string' || !key || key.length > MAX_KEY) {
            throw new Error(`idempotencyKey must be a non-empty string of at most ${MAX_KEY} characters`);
          }
          if (dryRun !== false) return { dryRun: true, operation: name, wouldWrite: await op.plan(rest) };
          const slot = `${name}\u0000${key}`;
          // The in-flight slot is checked and claimed with no await between,
          // before the store is read: a slow store can't let a second call
          // with the key miss the first and apply again.
          const input = fingerprint(rest);
          const conflict = () => new IdempotencyConflict(`idempotencyKey "${key}" was already used with a different input`, details(name));
          // Keyed by connector too: one injected store may serve several.
          const flight = `${declaration.id}\u0000${slot}`;
          if (inFlight.has(flight)) {
            const other = inFlight.get(flight);
            if (other.input !== input) throw conflict();
            return await other.run;
          }
          const run = (async () => {
            const done = await ledger.get(slot);
            if (done !== undefined) {
              if (!done || done.input !== input) throw conflict();
              return done.result;
            }
            const { client } = await open(name);
            const result = await op.apply(rest, context(name, 'write', client, { idempotencyKey: key }));
            const settled = result === undefined ? null : result;
            await ledger.set(slot, { input, result: settled });
            return settled;
          })();
          inFlight.set(flight, { input, run });
          try { return await run; } finally { inFlight.delete(flight); }
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
  KillSwitchOn, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict,
};
