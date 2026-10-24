'use strict';

// The runtime's one store for short-lived state (AD-7). In memory, so a
// deployment runs exactly one process (AD-8).
//
//   const store = createStore({ now: () => Date.now() });
//   store.set('event', eventId, true);          // TTL from the namespace table
//   store.get('event', eventId);                // undefined once expired
//   const entry = store.consume('approval', t); // get + delete + done marker
//   store.finish('approval', t, { pushed: 3 });
//   store.done('approval', t);                  // { state: 'done', result }
//
// Every call is synchronous: nothing can run between a check and a consume.
// Tests inject the clock. Expired entries read as absent and are swept on
// later writes.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Namespace → TTL (ms). set() rejects any namespace not listed here.
const NAMESPACES = Object.freeze({
  welcome: 7 * 24 * HOUR,
  session: 30 * MINUTE,
  provenance: 24 * HOUR,
  approval: 30 * MINUTE,
  done: 10 * MINUTE,
  event: 10 * MINUTE,
  escalation: 15 * MINUTE,
  ratelimit: HOUR,
});

const SWEEP_EVERY = 100;

class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreError';
  }
}

function checkNs(ns) {
  if (typeof ns !== 'string' || !Object.hasOwn(NAMESPACES, ns)) {
    throw new StoreError(`unknown store namespace "${ns}"`);
  }
}

function checkKey(key) {
  if (typeof key !== 'string' || !key) throw new StoreError('store key must be a non-empty string');
}

function createStore({ now = () => Date.now() } = {}) {
  // ns → Map<key, { value, expires }>
  const maps = new Map(Object.keys(NAMESPACES).map((ns) => [ns, new Map()]));
  let writes = 0;

  // Drops every expired entry; returns how many.
  function sweep() {
    const t = now();
    let dropped = 0;
    for (const map of maps.values()) {
      for (const [key, entry] of map) {
        if (entry.expires <= t) {
          map.delete(key);
          dropped += 1;
        }
      }
    }
    return dropped;
  }

  function live(ns, key) {
    const map = maps.get(ns);
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  }

  function put(ns, key, value, ttlMs) {
    if (++writes % SWEEP_EVERY === 0) sweep();
    maps.get(ns).set(key, { value, expires: now() + ttlMs });
  }

  // ttlMs defaults to the namespace's TTL and may only shorten it.
  function set(ns, key, value, ttlMs) {
    checkNs(ns);
    checkKey(key);
    const max = NAMESPACES[ns];
    const ttl = ttlMs === undefined ? max : ttlMs;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > max) {
      throw new StoreError(`TTL for "${ns}" must be a whole number of ms from 1 to ${max}`);
    }
    put(ns, key, value, ttl);
  }

  function get(ns, key) {
    checkNs(ns);
    checkKey(key);
    const entry = live(ns, key);
    return entry ? entry.value : undefined;
  }

  // Gets and deletes the entry, and in the same call leaves a done marker
  // { state: 'running' } for it. Returns undefined (and marks nothing) when
  // the entry is absent or expired.
  function consume(ns, key) {
    checkNs(ns);
    checkKey(key);
    const entry = live(ns, key);
    if (!entry) return undefined;
    maps.get(ns).delete(key);
    put('done', `${ns}:${key}`, { state: 'running' }, NAMESPACES.done);
    return entry.value;
  }

  // Records the outcome of a consumed entry.
  function finish(ns, key, result) {
    checkNs(ns);
    checkKey(key);
    put('done', `${ns}:${key}`, { state: 'done', result }, NAMESPACES.done);
  }

  // The done marker for a consumed entry, or undefined.
  function done(ns, key) {
    checkNs(ns);
    checkKey(key);
    const entry = live('done', `${ns}:${key}`);
    return entry ? entry.value : undefined;
  }

  return { get, set, consume, finish, done, sweep };
}

module.exports = { createStore, NAMESPACES, StoreError };
