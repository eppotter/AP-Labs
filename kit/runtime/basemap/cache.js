'use strict';

// The street map's tile cache (AD-R19, Story 15.9). Memory only: nothing is
// written to disk, and a restart starts empty. Keyed by the profile's URL
// template plus the tile's numbers; the keys never leave this process and are
// never logged.
//
// An entry is { png, etag, freshUntil } (freshUntil in ms since the epoch). A
// stale entry is kept so its ETag can revalidate it (If-None-Match; a 304
// refreshes it). The cache is a bounded LRU: reading an entry makes it the
// most recent, and storing past the bound evicts the least recent.
//
// How long a tile stays fresh (freshUntil below) follows HTTP caching, as the
// providers' tile policies ask: Cache-Control no-store means never stored;
// no-cache means stored but revalidated before every use; max-age (less any
// Age the response already had) wins over Expires; Expires counts from the
// response's Date (an unreadable Expires means already stale); with neither,
// the profile's cache_days (7 or more) applies.

const DAY_MS = 24 * 60 * 60 * 1000;

function createTileCache() {
  const entries = new Map();
  return {
    // The entry for key, made the most recent, or null.
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    // Stores entry as the most recent, then evicts down to max entries.
    set(key, entry, max) {
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    delete(key) {
      entries.delete(key);
    },
    has(key) {
      return entries.has(key);
    },
    get size() {
      return entries.size;
    },
  };
}

function directives(value) {
  const out = new Map();
  for (const part of String(value || '').split(',')) {
    const [name, ...rest] = part.split('=');
    const key = name.trim().toLowerCase();
    if (key) out.set(key, rest.join('=').trim().replace(/^"(.*)"$/, '$1'));
  }
  return out;
}

function seconds(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
}

// When a response stops being fresh, in ms since the epoch, or null when it
// must not be stored. headers: a fetch Headers; now: ms since the epoch.
function freshUntil(headers, now, cacheDays) {
  const cc = directives(headers.get('cache-control'));
  if (cc.has('no-store')) return null;
  if (cc.has('no-cache')) return now;
  const age = seconds(headers.get('age')) || 0;
  const maxAge = seconds(cc.get('max-age'));
  if (maxAge !== null) return now + Math.max(0, maxAge - age) * 1000;
  const expires = headers.get('expires');
  if (expires !== null) {
    const until = Date.parse(expires);
    if (!Number.isFinite(until)) return now;
    const sent = Date.parse(headers.get('date') || '');
    return now + Math.max(0, until - (Number.isFinite(sent) ? sent : now));
  }
  return now + cacheDays * DAY_MS;
}

module.exports = { createTileCache, freshUntil, DAY_MS };
