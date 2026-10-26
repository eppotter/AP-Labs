'use strict';

// The runtime's one store for short-lived state (AD-7). In memory, so a
// deployment runs exactly one process (AD-8).
//
//   const store = createStore({ now: () => Date.now() });
//   store.set('event', eventId, true);          // TTL from the namespace table
//   store.get('event', eventId);                // undefined once expired
//   const entry = store.consume('approval', t, { person }); // get + delete + done marker
//   store.finish('approval', t, { pushed: 3 });
//   store.done('approval', t);                  // { person, state: 'done', result }
//
// consume's marker (Story 10.3, plan epic-10 decision 5) ties the done marker
// to whoever consumed the entry (for example { person }), so "already
// running" and "already done" can be told only to them; finish keeps it.
//
// Every call is synchronous: nothing can run between a check and a consume.
// Tests inject the clock. Expired entries read as absent and are swept on
// later writes.
//
// Map files (Story 15.1, AD-R15) are a record kind of their own, not a
// namespace: the id of each uploaded map image, its owner and its expiry (15
// minutes after it was recorded). An expired record is NOT dropped: it stays
// until its file is deleted and the record removed, so the sweep job
// (kit/runtime/jobs/sweep-map-files) finds it and a failed delete is retried.
// sweep() never touches them. A new process given the same store finds every
// record the previous one left.
//
//   store.addMapFile(fileId, owner);   // throws StoreError on a bad id, owner,
//                                      // a duplicate id or a full table
//   store.mapFilesOf(owner);           // [fileId] still recorded for an owner
//   store.expiredMapFiles();           // [fileId] whose expiry has passed
//   store.removeMapFile(fileId);       // true when a record was removed
//   store.mapFileCount();

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

// Map file records (Story 15.1).
const MAP_FILE_TTL = 15 * MINUTE;
const MAX_MAP_FILES = 1000;
const FILE_ID = /^F[A-Z0-9]{1,40}$/;
const MAX_OWNER = 200;

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

// consume's marker: undefined, or a plain object without state or result.
function markerFields(marker) {
  if (marker === undefined) return {};
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || Object.getPrototypeOf(marker) !== Object.prototype) {
    throw new StoreError('a consume marker must be a plain object');
  }
  if (Object.hasOwn(marker, 'state') || Object.hasOwn(marker, 'result')) {
    throw new StoreError('a consume marker may not set state or result (the store sets them)');
  }
  return { ...marker };
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
  // { ...marker, state: 'running' } for it. marker (optional) is a plain
  // object of its own fields (never state or result), copied and frozen.
  // Returns undefined (and marks nothing) when the entry is absent or expired.
  function consume(ns, key, marker) {
    checkNs(ns);
    checkKey(key);
    const fields = markerFields(marker);
    const entry = live(ns, key);
    if (!entry) return undefined;
    maps.get(ns).delete(key);
    put('done', `${ns}:${key}`, Object.freeze({ ...fields, state: 'running' }), NAMESPACES.done);
    return entry.value;
  }

  // Records the outcome of a consumed entry, keeping its marker's fields
  // (the person) while the running marker is still live.
  function finish(ns, key, result) {
    checkNs(ns);
    checkKey(key);
    const prior = live('done', `${ns}:${key}`);
    const kept = {};
    if (prior) {
      for (const [k, v] of Object.entries(prior.value)) if (k !== 'state' && k !== 'result') kept[k] = v;
    }
    put('done', `${ns}:${key}`, Object.freeze({ ...kept, state: 'done', result }), NAMESPACES.done);
  }

  // The done marker for a consumed entry, or undefined.
  function done(ns, key) {
    checkNs(ns);
    checkKey(key);
    const entry = live('done', `${ns}:${key}`);
    return entry ? entry.value : undefined;
  }

  // fileId → { owner, expires }, in recording order.
  const mapFiles = new Map();

  function checkFileId(id) {
    if (typeof id !== 'string' || !FILE_ID.test(id)) throw new StoreError('a map file id must look like a Slack file id (F…)');
  }

  function addMapFile(id, owner) {
    checkFileId(id);
    if (typeof owner !== 'string' || !owner || owner.length > MAX_OWNER) {
      throw new StoreError(`a map file owner must be a non-empty string of at most ${MAX_OWNER} characters`);
    }
    if (mapFiles.has(id)) throw new StoreError('that map file is already recorded');
    if (mapFiles.size >= MAX_MAP_FILES) throw new StoreError(`no room for another map file (${MAX_MAP_FILES} recorded)`);
    mapFiles.set(id, Object.freeze({ owner, expires: now() + MAP_FILE_TTL }));
  }

  function mapFilesOf(owner) {
    const out = [];
    for (const [id, r] of mapFiles) if (r.owner === owner) out.push(id);
    return out;
  }

  function expiredMapFiles() {
    const t = now();
    const out = [];
    for (const [id, r] of mapFiles) if (r.expires <= t) out.push(id);
    return out;
  }

  function removeMapFile(id) {
    checkFileId(id);
    return mapFiles.delete(id);
  }

  return {
    get, set, consume, finish, done, sweep,
    addMapFile, mapFilesOf, expiredMapFiles, removeMapFile, mapFileCount: () => mapFiles.size,
  };
}

module.exports = { createStore, NAMESPACES, StoreError, MAP_FILE_TTL, MAX_MAP_FILES };
