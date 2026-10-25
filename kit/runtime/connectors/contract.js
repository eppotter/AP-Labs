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
//     write: { addContacts: { plan: (input) => preview, apply: async (input, ctx) => result, perItemIdempotency: true } },
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
//   - A live write keeps a record of the requests that went, saved after
//     every request completes and before the next is sent (10.0, DEP-017), in
//     the idempotency store beside the write's slot
//     (at "<connector id>\u0000<operation>\u0001progress\u0000<key>"), as
//     { input, partial: true, batchSize, completed: [{ size, result }] }. So a
//     write that stops partway (a kill switch, an outage, a rejected sign-in)
//     or whose process dies or is redeployed mid-write leaves an accurate
//     record; that needs a durable store (an in-memory one is lost on a
//     restart). The record stays once the write completes (its done slot wins).
//     A store must keep that value whole and return the latest one set (a
//     mangled one fails closed). A request's
//     answer is kept only when it is nothing but counts, flags and id-shaped
//     refs; any other answer (contact data, free text) is never stored, the
//     request is marked opaque, and a retry that reaches it fails closed with
//     ConnectorFailed, sending nothing more. If a save fails, the write stops
//     before its next request (even if the adapter caught the error) with a
//     ConnectorFailed whose details.sent.recorded is false, an error line is
//     logged, and the person is told the admin should check what arrived
//     before anyone retries (never that a retry is safe). Only a request that answered is
//     recorded: one that timed out after the system had already processed
//     it can't be, so a retry may send it again; adapters should pass the
//     system's own dedupe keys (ctx.idempotencyKey per item) where it has them. A retry with the same key and input
//     re-runs apply, answers those requests from the record without calling
//     the system, and sends only the rest (#89). The record is bound to the
//     input fingerprint and the batch size: other input, or the same input
//     under another batch size, is refused with IdempotencyConflict and
//     sends nothing; a resumed request whose size changed fails closed with
//     ConnectorFailed. apply must make the same requests in the same order
//     for the same input, and a durable store must hold the requests'
//     answers. The error that leaves carries details.sent ({ batches, items },
//     items being the requests' sizes), and the person's message says what
//     went instead of "nothing was sent". After a PartialFailure a write that
//     declares perItemIdempotency drops the record: if one was saved on this
//     or an earlier try, it is overwritten with completed: [] (B3), so its
//     retry calls the system for every request and the system keeps only the
//     items it lacks; if that save fails, retrySafe is false. Any other write
//     keeps it, so its retry sends nothing twice. A key whose write sent a
//     request is bound to that input, even after a failure.
//   - Every write needs an idempotencyKey. A repeated key (per operation)
//     with the same input returns the first result and calls nothing; two
//     concurrent calls with one key share one apply. A caller that must tell
//     a replay from a fresh write (the approval-write archetype says "already
//     sent today; nothing new sent", Story 10.3) passes a second argument
//     { report: true } and gets { result, replayed }: replayed is true when
//     the key's result came from the store or from another call's apply, so
//     this call sent nothing. The options are never part of the input. The input is fingerprinted
//     under its key, so a reused key with a different input is refused with
//     IdempotencyConflict and calls nothing. Keys are kept in
//     deps.idempotency ({ get, set }, holding { input, result }) or, by
//     default, in memory for the process's life, in one store per connector
//     (per defineConnector) that every instance it creates shares: a second
//     create() in the process sees the first one's keys, and a concurrent
//     repeat on another instance joins the first apply (DEP-012). Instances
//     given the same deps.idempotency object share their in-flight writes too.
//   - Only kit/runtime/archetypes/approval-write passes dryRun: false (AD-15);
//     the write-path check (kit/verify/write-path.js, run by npm run check,
//     npm test, and npm run verify as engine:write-path) fails app code that
//     writes live outside it.
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
//     (seconds, an HTTP date or a Date, a date read against deps.now; up to
//     60 s, and longer fails at once), at most 3 attempts in all; then the
//     operation fails with ConnectorFailed. A call already waiting in the
//     limiter re-checks the hold when it wakes, so it can't go inside a hold
//     set while it slept. A write re-checks its kill switch after the wait,
//     before the retry is sent (#89).
//   - Every error that leaves an operation is a ConnectorFailed (or
//     ConnectorAuthFailed / KillSwitchOn) built fresh from a redacted message:
//     the connector's own credentials, any token connect() obtained and passed
//     to registerSecret, credential-shaped strings (headers, query values,
//     URL passwords, JSON access_token / refresh_token / id_token) and the log
//     redactor's patterns are masked, and the original error is not kept.
//     A credential-shaped name=value pair is masked after ?, & or ; and bare
//     (token=... in prose), so a connector with no credential passes too
//     (#90), as are JSON fields named like a secret ("api_key", "token",
//     "client_secret", ...), header-style "X-Api-Key: ..." and any
//     Authorization value, whatever its scheme.
//   - A write whose batch partly applied throws PartialFailure from apply with
//     { succeeded, failed, failedRefs } (failedRefs: the failed items'
//     external ids, one per failed item). It leaves as a PartialFailure with
//     the connector's details and a text rebuilt from the counts alone (the
//     adapter's text is dropped), after a warn log line with the counts and
//     refs. A ref that is not id-shaped (an email, a phone number or date of
//     7+ digits, a word with no digit such as a name) or holds a credential
//     is masked. Counts that don't add up, or a PartialFailure from a read (a
//     read fails whole), leave as a plain ConnectorFailed, also without the
//     adapter's text. Like any failed write it does not use up its key.
//     details.retrySafe is true only when the write declares
//     perItemIdempotency: true (each item keyed, so a retry with the same key
//     and input re-sends only the failed items); only then does the person's
//     message call a retry safe (#90).

const crypto = require('node:crypto');
const { readSecret, redact } = require('../../lib/secrets');
const {
  KillSwitchOn, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict, PartialFailure,
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
  // A name=value pair after ?, & or ;, or bare (token=... in prose, #90): the
  // name must start a word, so "retokenize=" is left alone.
  /((?:[?&;]|\b)(?:access_token|refresh_token|token|api[_-]?key|apikey|key|secret|client_secret|password|signature|sig)=)[^&\s'"<>]+/gi,
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@'"<>]+:[^\s/@'"<>]+@/gi,
  // A JSON field whose name ends in a secret-ish word ("api_key", "token",
  // "client_secret", "x-api-key", ...), whatever its value holds. Runs before
  // the header shape so a value with spaces is masked whole.
  /"[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
  // Any Authorization header or field, any scheme (Token, Basic, Bearer, none).
  /\bauthorization['"]?\s*[:=]\s*['"]?(?:[A-Za-z]+\s+)?[^\s'",;<>]+/gi,
  // Header style "X-Api-Key: value", "X-Auth-Token: value".
  /\b[A-Za-z0-9-]*(?:token|secret|password|api[_-]?key|apikey)['"]?\s*:\s*['"]?[^\s'",;<>]+/gi,
];

const isFn = (f) => typeof f === 'function';
// A failed item's ref must look like an external id (c_123, CRM-00042, a
// UUID, a short number); anything else is masked, so a PartialFailure never
// carries contact data (#90). Masked: anything with other characters (an
// email, a sentence), a word with no digit (a name), and digits-only refs of
// 7 or more digits once separators are dropped (a phone number, a date).
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function isIdShaped(ref) {
  if (!REF.test(ref) || !/[0-9]/.test(ref)) return false;
  if (/^[0-9._:-]+$/.test(ref) && ref.replace(/[^0-9]/g, '').length >= 7) return false;
  return true;
}
// A field name a progress record may keep: a plain identifier, never one
// named like a credential or contact data.
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SECRET_FIELD = /token|secret|password|passwd|api_?key|apikey|auth|email|phone|name|address/i;
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

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
      if (kind === 'write') {
        const extra = op && Object.keys(op).filter((k) => !['plan', 'apply', 'perItemIdempotency'].includes(k));
        if (!(op && isFn(op.plan) && isFn(op.apply) && !extra.length)) {
          fail(`write.${name}`, 'must be { plan(input), apply(input, ctx) }, optionally with perItemIdempotency');
        }
        if (op.perItemIdempotency !== undefined && typeof op.perItemIdempotency !== 'boolean') {
          fail(`write.${name}.perItemIdempotency`, 'must be true or false');
        }
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
      let wait = Math.max(last + interval, heldUntil) - now();
      // A hold set while this call slept (another call's 429) is honoured
      // too: re-checked after every wake, looping only while the hold grew,
      // so a clock that doesn't move can't spin it (#89).
      while (wait > 0) {
        const held = heldUntil;
        await sleep(wait);
        if (heldUntil <= held) break;
        wait = heldUntil - now();
      }
      last = now();
    });
    gate = turn.catch(() => {});
    return turn;
  };
  limit.hold = (ms) => { heldUntil = Math.max(heldUntil, now() + ms); };
  return limit;
}

// Retry-After from a 429, in ms: err.retryAfter (seconds) or the header,
// as seconds, an HTTP date or a Date. A date is read against the connector's
// clock (deps.now), not the wall clock, so an injected clock governs it (#89).
// 0 when absent, unreadable or in the past; a number too large to be finite
// ("Infinity", "1e400") is Infinity, so the caller's cap refuses it.
function retryAfterMs(err, now) {
  const h = err.headers;
  const raw = err.retryAfter ?? (h && (typeof h.get === 'function' ? h.get('retry-after') : h['retry-after'] ?? h['Retry-After']));
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  if (raw instanceof Date) {
    const when = raw.getTime();
    return Number.isFinite(when) ? Math.max(0, when - now()) : 0;
  }
  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
}

// In-flight writes per idempotency store, so instances sharing a store also
// share the writes still running under it: a concurrent repeat key joins the
// first apply instead of missing it and applying again (DEP-012).
const IN_FLIGHT = new WeakMap();
function inFlightFor(store) {
  if (!IN_FLIGHT.has(store)) IN_FLIGHT.set(store, new Map());
  return IN_FLIGHT.get(store);
}

// A live write that failed, with what it had sent (or null), carried to the
// write's catch so a caller joining the same in-flight write gets it too.
class Stopped {
  constructor(err, sent, recorded) { this.err = err; this.sent = sent; this.recorded = recorded; }
}
const sentSoFar = (completed) => {
  const done = completed.filter(Boolean);
  return Object.freeze({ batches: done.length, items: done.reduce((n, r) => n + r.size, 0) });
};

// Where a stopped write keeps its progress: beside its slot, never equal to
// one ("\u0001" can't be in an operation name), so a store keeping
// { input, result } per slot keeps working.
const progressSlot = (id, operation, key) => `${id}\u0000${operation}\u0001progress\u0000${key}`;

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
    // The writes that key each item, so a retry with the same key and input
    // re-sends only the items that failed. Only these get the safe-retry
    // wording on a PartialFailure.
    perItemIdempotency: Object.freeze(Object.entries(spec.write || {}).filter(([, op]) => op.perItemIdempotency === true).map(([n]) => n)),
  });

  // deps: env (default process.env), log (required: the app's
  // kit/runtime/log logger, so every credential registers with it, AD-12; a
  // test passes its own, such as the SDK's testLog()), now and sleep (tests
  // inject a clock), idempotency ({ get(slot), set(slot, { input, result }) }:
  // slot is "<connector id>\u0000<operation>\u0000<key>", input is the write
  // input's fingerprint), onRequest(info) (tests: runs
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

    // What a progress record keeps of a request: its size and, only when it
    // is nothing but counts, flags and id-shaped refs, its answer. Any other
    // answer (contact data, free text) is never stored: the request is marked
    // opaque, and a retry that reaches it fails closed (#89).
    function keepable(value, depth = 0) {
      if (value === null || typeof value === 'boolean') return true;
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value === 'string') return isIdShaped(value) && clean(value) === value;
      if (depth >= 4 || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.every((v) => keepable(v, depth + 1));
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      return Object.entries(value).every(([k, v]) => SAFE_FIELD.test(k) && !SECRET_FIELD.test(k) && keepable(v, depth + 1));
    }
    function note(size, result) {
      if (result === undefined) return { size };
      return keepable(result) ? { size, result } : { size, opaque: true };
    }

    // progress (a live write only): the write's batch-level record, so a
    // retry with the same key and input resumes after the requests already
    // sent. Request i that completed on an earlier try is answered from the
    // record without calling the system; each request that completes now is
    // noted and the record saved before the next one is sent (#89, 10.0).
    function context(operation, kind, client, extra = {}, progress = null) {
      async function send(fn, size) {
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
            const wait = retryAfterMs(err, now);
            if (!(wait <= MAX_RETRY_AFTER_MS)) {
              const asked = Number.isFinite(wait) ? `${Math.ceil(wait / 1000)} s` : 'without limit';
              throw new Error(`rate limited: asked to wait ${asked}, over the ${MAX_RETRY_AFTER_MS / 1000} s limit`);
            }
            limit.hold(wait);
          }
        }
      }
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
          if (!progress) return send(fn, size);
          // A save that failed stops the write: nothing more goes out
          // unrecorded, even if the adapter caught the error (10.0).
          if (progress.unsaved) throw progress.unsaved;
          const index = progress.next;
          progress.next += 1;
          const done = progress.completed[index];
          if (done) {
            // The adapter must ask the same requests in the same order on a
            // retry; one that changed means the record can't be trusted.
            if (done.size !== size) throw new Error(`request ${index + 1} of this write changed since the first try (size ${done.size}, now ${size}), so it was stopped before sending`);
            if (done.opaque === true) {
              throw new Error(`request ${index + 1}'s answer could not be kept (it held more than counts and ids), so this write can't resume; nothing more was sent`);
            }
            return done.result;
          }
          const result = await send(fn, size);
          progress.completed[index] = note(size, result);
          // Saved after every request, so a process that dies partway leaves
          // an accurate record and a retry resumes after it (10.0, DEP-017).
          await progress.save();
          return result;
        },
      });
    }

    // A write's PartialFailure, rebuilt from its counts alone (the adapter's
    // text is dropped: it may name refs or contact data) with id-shaped refs,
    // or null when its counts don't add up (then it is a plain ConnectorFailed).
    function partial(err, operation, recorded = true) {
      const { succeeded, failed, failedRefs } = err.details || {};
      if (!isCount(succeeded) || !isCount(failed) || failed < 1 || !Array.isArray(failedRefs) || failedRefs.length !== failed) return null;
      const refs = failedRefs.map((r) => {
        const ref = typeof r === 'number' && Number.isSafeInteger(r) ? String(r) : r;
        if (typeof ref !== 'string' || !isIdShaped(ref)) return MASK;
        return clean(ref) === ref ? ref : MASK;
      });
      // Not safe when the write's progress could not be updated: a stale
      // record could make the retry skip what failed (#89).
      const retrySafe = declaration.perItemIdempotency.includes(operation) && recorded;
      log.warn('connector write partly failed', {
        connector: declaration.id, operation, succeeded, failed, failed_refs: refs, retry_safe: retrySafe,
      });
      return new PartialFailure(`${succeeded} of ${succeeded + failed} items succeeded, ${failed} failed`, {
        ...details(operation), succeeded, failed, failedRefs: Object.freeze(refs), retrySafe,
      });
    }

    // Every error leaving an operation is rebuilt from a redacted message.
    // sent: what a write stopped partway had already sent ({ batches, items }),
    // added to the error's details so its message is honest about it.
    // recorded: false when the write's progress record could not be saved.
    function rethrow(err, operation, kind, sent = null, recorded = true) {
      if (err instanceof KillSwitchOn) throw sent ? new KillSwitchOn({ ...err.details, sent }) : err;
      if (err instanceof IdempotencyConflict) throw new IdempotencyConflict(clean(err.reason), details(operation));
      // Only a write can partly apply: a read fails whole (fail closed). The
      // adapter's text never leaves with a PartialFailure, valid or not.
      if (err instanceof PartialFailure) {
        const rebuilt = kind === 'write' ? partial(err, operation, recorded) : null;
        if (rebuilt) throw rebuilt;
        const why = kind === 'write' ? 'counts must be whole numbers, failed at least 1, one ref per failed item' : 'a read cannot partly fail';
        throw new ConnectorFailed(`invalid partial failure (${why})`, details(operation));
      }
      const raw = err instanceof ConnectorFailed ? err.reason : (err && err.message) || String(err);
      const reason = clean(raw);
      if (isAuthError(err)) {
        session = null;
        // setup: a credential is not set (a setup fault), not a rejected one.
        const setup = err instanceof ConnectorAuthFailed && err.details && err.details.setup === true;
        const base = sent ? { ...details(operation), sent } : details(operation);
        throw new ConnectorAuthFailed(reason, setup ? { ...base, setup: true } : base);
      }
      throw new ConnectorFailed(reason, sent ? { ...details(operation), sent } : details(operation));
    }

    const read = {};
    for (const [name, op] of Object.entries(spec.read || {})) {
      read[name] = async (input = {}) => {
        try {
          const { client } = await open(name);
          return await op(input, context(name, 'read', client));
        } catch (err) {
          return rethrow(err, name, 'read');
        }
      };
    }

    const write = {};
    for (const [name, op] of Object.entries(spec.write || {})) {
      write[name] = async (input = {}, { report = false } = {}) => {
        // { result, replayed } when the caller asked (report), else the result.
        const out = (result, replayed) => (report === true ? Object.freeze({ result, replayed }) : result);
        refuseIfSwitchedOff();
        const { dryRun, ...rest } = input;
        const key = rest.idempotencyKey;
        try {
          if (typeof key !== 'string' || !key || key.length > MAX_KEY) {
            throw new Error(`idempotencyKey must be a non-empty string of at most ${MAX_KEY} characters`);
          }
          if (dryRun !== false) return out({ dryRun: true, operation: name, wouldWrite: await op.plan(rest) }, false);
          // "<connector id>\u0000<operation>\u0000<key>": the connector is part
          // of the slot, so one store can serve several connectors (DEP-012).
          const slot = `${declaration.id}\u0000${name}\u0000${key}`;
          // The in-flight slot is checked and claimed with no await between,
          // before the store is read: a slow store can't let a second call
          // with the key miss the first and apply again.
          const input = fingerprint(rest);
          const conflict = () => new IdempotencyConflict(`idempotencyKey "${key}" was already used with a different input`, details(name));
          if (inFlight.has(slot)) {
            const other = inFlight.get(slot);
            if (other.input !== input) throw conflict();
            return out((await other.run).result, true);
          }
          const run = (async () => {
            const done = await ledger.get(slot);
            if (done !== undefined) {
              if (!done || done.input !== input) throw conflict();
              return { result: done.result, replayed: true };
            }
            // Stopped partway on an earlier try: resume after what was sent,
            // only when the requests can be the same ones (same input, same
            // batch size). A record the store mangled fails closed.
            const batchSize = declaration.rateLimit.batchSize;
            const pslot = progressSlot(declaration.id, name, key);
            const saved = await ledger.get(pslot);
            let completed = [];
            if (saved !== undefined) {
              if (!saved || saved.partial !== true || !Array.isArray(saved.completed)) {
                throw new Error('the idempotency store returned a write progress record it could not have been given, so nothing was sent');
              }
              if (saved.input !== input) throw conflict();
              if (saved.batchSize !== batchSize) {
                throw new IdempotencyConflict(`idempotencyKey "${key}" was first tried with a batch size of ${saved.batchSize}, now ${batchSize}, so the sent batches can't be matched`, details(name));
              }
              completed = saved.completed.slice();
            }
            const unsavedLog = (batches) => log.error('connector write progress could not be recorded: a retry may send again', {
              connector: declaration.id, operation: name, sent_batches: batches,
            });
            const record = (done) => ledger.set(pslot, { input, partial: true, batchSize, completed: done });
            const progress = {
              next: 0,
              completed,
              // Whether the store may hold a record for this key: one from an
              // earlier try, or one this try saved (or tried to).
              touched: saved !== undefined,
              unsaved: null,
              async save() {
                progress.touched = true;
                try {
                  await record(progress.completed.slice());
                } catch (_) {
                  // Unrecorded: a retry would send this request again. The
                  // write stops here (sent.recorded false) and the person is
                  // told the admin should check what arrived before anyone retries.
                  progress.unsaved = new Error('the write\'s progress could not be saved, so it stopped before the next request');
                  throw progress.unsaved;
                }
              },
            };
            let recorded = true;
            try {
              const { client } = await open(name);
              const result = await op.apply(rest, context(name, 'write', client, { idempotencyKey: key }, progress));
              // An adapter that caught the failed save must not finish as if
              // everything went.
              if (progress.unsaved) throw progress.unsaved;
              const settled = result === undefined ? null : result;
              await ledger.set(slot, { input, result: settled });
              return { result: settled, replayed: false };
            } catch (thrown) {
              const err = progress.unsaved || thrown;
              const counts = progress.completed.some(Boolean) ? sentSoFar(progress.completed) : null;
              if (progress.unsaved) {
                recorded = false;
                unsavedLog(counts ? counts.batches : 0);
              } else if (err instanceof PartialFailure && declaration.perItemIdempotency.includes(name) && progress.touched) {
                // A write keyed per item re-sends after a PartialFailure (the
                // system drops the items it has), so its retry must call the
                // system for every request: the record saved on this or an
                // earlier try is overwritten with none completed (B3). If that
                // fails, the retry could skip failed items: not retry-safe.
                // Any other write keeps its record (every completed request
                // was saved as it went), so nothing it sent is sent twice.
                try {
                  await record([]);
                } catch (_) {
                  recorded = false;
                  unsavedLog(counts ? counts.batches : 0);
                }
              }
              throw new Stopped(err, counts ? Object.freeze({ ...counts, recorded }) : null, recorded);
            }
          })();
          inFlight.set(slot, { input, run });
          try {
            const settled = await run;
            return out(settled.result, settled.replayed);
          } finally { inFlight.delete(slot); }
        } catch (err) {
          if (err instanceof Stopped) return rethrow(err.err, name, 'write', err.sent, err.recorded);
          return rethrow(err, name, 'write');
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
  KillSwitchOn, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict, PartialFailure,
};
