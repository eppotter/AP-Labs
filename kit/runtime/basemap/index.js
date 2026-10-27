'use strict';

// The street map's one tile fetcher (AD-R18, AD-R19, Story 15.9).
//
//   // fetchMosaic from kit/runtime/basemap (only the routing-map archetype and the smoke script)
//   const { basemap, reason } = await fetchMosaic(mosaic, { profile, fetch, now, signal, log });
//   // basemap: { tiles: [{ col, row, png }], ox, oy }, or null with a fixed reason code
//   // also requested and cached: how many tiles the map needed and how many
//   // of those the cache held fresh (counts only, never which tiles; 0 and 0
//   // when it stopped before working out the tiles), Story 15.10
//
// mosaic is mapPoints' { z, tx0, ty0, cols, rows, ox, oy } (AD-R20). Only that
// view's cols x rows tiles are fetched (no neighbours, no other zoom, no
// warm-up), minus the ones the cache holds fresh. The tile source is the
// profile's routing.basemap (AD-R18); no block, no request: the kit has no
// default provider.
//
// This is the bot's outbound connection to the tile provider (DEP-029), so it
// follows connector discipline without being a connector (no credentials, no
// writes):
//   - Each request is a GET with redirect: 'error', the profile's User-Agent,
//     no cookies and no Referer. At most 2 run at once (across every caller),
//     4 s per tile once it starts, 8 s per map.
//   - Only a 200 (or a 304 against a cached ETag) with Content-Type image/png
//     is taken, read with a 256 KB cap, and its header must say a 256 x 256
//     PNG. One tile failing drops the whole street layer, never a patchy map:
//     the other requests are aborted and the result is null.
//   - After a 403, 429 or 5xx, nothing is requested for 10 minutes (tiles the
//     cache holds fresh are still served).
//   - APLABS_BASEMAP_OFF, any non-empty value but "0", read on every call,
//     means no request at all.
//   - The cache (./cache) is memory only, honours Cache-Control, Expires and
//     ETag, falls back to cache_days, stores nothing on no-store, is a bounded
//     LRU (max_cached_tiles) and shares one fetch per tile between callers.
//
// It never throws and never rejects: every failure is a fixed reason code
// (REASONS). Logs and results never hold a URL, a host, a path, tile numbers,
// the mosaic or a body. Node's fetch errors carry the URL, so none is ever
// passed on: each is caught and turned into its code. Tile numbers stay in
// process memory, like the map's pixel positions (AD-R12).
//
// It requires only its own files (and may require kit/runtime/errors); only
// the routing-map archetype and the smoke script require it (boundary test).

const { createTileCache, freshUntil } = require('./cache');

const TILE_SIZE = 256;
const MAX_TILE_BYTES = 256 * 1024;
const MAX_TILES = 64;
const MAX_CONCURRENT = 2;
const TILE_TIMEOUT_MS = 4000;
const MAP_TIMEOUT_MS = 8000;
const COOL_DOWN_MS = 10 * 60 * 1000;
const OFF_ENV = 'APLABS_BASEMAP_OFF';
// What a profile left out (kit/lib/profile fills these; a hand-built profile
// object may not have).
const FALLBACK = Object.freeze({ max_zoom: 19, cache_days: 7, max_cached_tiles: 512 });

// Every reason fetchMosaic can give. Fixed codes, safe to log.
const REASONS = Object.freeze([
  'no_basemap', // the profile has no routing.basemap (not a failure; not logged)
  'switched_off', // APLABS_BASEMAP_OFF
  'mosaic_invalid', // not a whole, in-range mosaic of at most 64 tiles at or below max_zoom
  'cooling_down', // within 10 minutes of a 403, 429 or 5xx
  'forbidden', // 403
  'rate_limited', // 429
  'server_error', // 5xx
  'bad_status', // any other status, or a 304 with nothing cached
  'timeout', // 4 s for a tile or 8 s for the map
  'not_png', // not image/png, or not a PNG
  'wrong_size', // a PNG that is not 256 x 256
  'too_large', // over 256 KB
  'aborted', // the caller's signal
  'fetch_failed', // the request itself failed (network, TLS, a redirect)
]);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const isOff = (env) => {
  const v = env && env[OFF_ENV];
  return typeof v === 'string' && v !== '' && v !== '0';
};

// The tiles a mosaic needs, row by row, or null when it is not a whole,
// in-range mosaic.
function tileList(m, maxZoom) {
  if (!m || typeof m !== 'object') return null;
  if (!['z', 'tx0', 'ty0', 'cols', 'rows', 'ox', 'oy'].every((k) => Number.isSafeInteger(m[k]))) return null;
  if (m.z < 0 || m.z > maxZoom || m.cols < 1 || m.rows < 1 || m.cols * m.rows > MAX_TILES) return null;
  const n = 2 ** m.z;
  if (m.tx0 < 0 || m.ty0 < 0 || m.tx0 + m.cols > n || m.ty0 + m.rows > n) return null;
  const tiles = [];
  for (let row = 0; row < m.rows; row += 1) {
    for (let col = 0; col < m.cols; col += 1) tiles.push({ col, row, z: m.z, x: m.tx0 + col, y: m.ty0 + row });
  }
  return tiles;
}

// Why bytes are not a 256 x 256 PNG, or null.
function pngProblem(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'not_png';
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return 'not_png';
  if (bytes.readUInt32BE(16) !== TILE_SIZE || bytes.readUInt32BE(20) !== TILE_SIZE) return 'wrong_size';
  return null;
}

function statusReason(status) {
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'server_error';
  return null;
}

// Reads a body, stopping as soon as it passes cap bytes or signal aborts
// (Node's fetch errors the body on abort; this does not count on it).
async function readCapped(res, cap, signal) {
  if (!res.body) return { bytes: Buffer.alloc(0) };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (signal.aborted) {
      reader.cancel().catch(() => {});
      return null;
    }
    size += value.byteLength;
    if (size > cap) {
      reader.cancel().catch(() => {});
      return { reason: 'too_large' };
    }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks) };
}

function discard(res) {
  try {
    if (res.body) res.body.cancel().catch(() => {});
  } catch {
    // Nothing to free.
  }
}

// At most max requests at once; the rest wait their turn. acquire(signal)
// resolves true with a slot, or false if signal aborts while waiting.
function createLimiter(max) {
  let active = 0;
  const queue = [];
  return {
    acquire(signal) {
      if (signal.aborted) return Promise.resolve(false);
      if (active < max) {
        active += 1;
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const item = { resolve, signal, onAbort: null };
        item.onAbort = () => {
          const i = queue.indexOf(item);
          if (i >= 0) queue.splice(i, 1);
          resolve(false);
        };
        signal.addEventListener('abort', item.onAbort, { once: true });
        queue.push(item);
      });
    },
    release() {
      const next = queue.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.onAbort);
        next.resolve(true);
      } else {
        active -= 1;
      }
    },
  };
}

// A fetcher with its own cache, cool-down and request limit. The module's
// fetchMosaic is one shared instance; tests make their own.
function createBasemap() {
  const cache = createTileCache();
  const inflight = new Map();
  const coolUntil = new Map();
  const limiter = createLimiter(MAX_CONCURRENT);

  const coolingDown = (template, at) => (coolUntil.get(template) || 0) > at;

  // One request for one tile, shared by every caller that wants it.
  // Resolves { png } or { reason }; never rejects.
  async function request(key, url, source, ctx, controller) {
    const max = source.max_cached_tiles || FALLBACK.max_cached_tiles;
    const cacheDays = source.cache_days || FALLBACK.cache_days;
    const cached = cache.get(key);
    const headers = { 'User-Agent': source.user_agent, Accept: 'image/png' };
    if (cached && cached.etag) headers['If-None-Match'] = cached.etag;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TILE_TIMEOUT_MS);
    const lost = () => ({ reason: timedOut ? 'timeout' : controller.signal.aborted ? 'aborted' : 'fetch_failed' });
    try {
      if (controller.signal.aborted) return lost();
      let res;
      try {
        res = await ctx.fetch(url, {
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers,
          signal: controller.signal,
        });
      } catch {
        return lost();
      }
      const at = ctx.now();
      if (res.status === 304 && cached && cached.etag) {
        discard(res);
        const until = freshUntil(res.headers, at, cacheDays);
        if (until === null) cache.delete(key);
        else cache.set(key, { png: cached.png, etag: res.headers.get('etag') || cached.etag, freshUntil: until }, max);
        return { png: cached.png };
      }
      const refused = statusReason(res.status);
      if (refused) {
        coolUntil.set(source.url_template, at + COOL_DOWN_MS);
        discard(res);
        return { reason: refused };
      }
      if (res.status !== 200) {
        discard(res);
        return { reason: 'bad_status' };
      }
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type !== 'image/png') {
        discard(res);
        return { reason: 'not_png' };
      }
      const declared = res.headers.get('content-length');
      if (declared !== null && Number(declared) > MAX_TILE_BYTES) {
        discard(res);
        return { reason: 'too_large' };
      }
      let body;
      try {
        body = await readCapped(res, MAX_TILE_BYTES, controller.signal);
      } catch {
        return lost();
      }
      if (!body) return lost();
      if (body.reason) return body;
      const problem = pngProblem(body.bytes);
      if (problem) return { reason: problem };
      const until = freshUntil(res.headers, ctx.now(), cacheDays);
      if (until !== null) cache.set(key, { png: body.bytes, etag: res.headers.get('etag'), freshUntil: until }, max);
      return { png: body.bytes };
    } finally {
      clearTimeout(timer);
    }
  }

  function startFlight(key, url, source, ctx) {
    const controller = new AbortController();
    const flight = { controller, waiters: 0, promise: null };
    flight.promise = (async () => {
      if (!(await limiter.acquire(controller.signal))) return { reason: 'aborted' };
      try {
        if (coolingDown(source.url_template, ctx.now())) return { reason: 'cooling_down' };
        return await request(key, url, source, ctx, controller);
      } finally {
        // The slot frees on the next turn, after this result has reached its
        // callers: a failed tile stops the map before a queued tile can start.
        setImmediate(() => limiter.release());
      }
    })().catch(() => ({ reason: 'fetch_failed' }));
    flight.promise.then(() => {
      if (inflight.get(key) === flight) inflight.delete(key);
    });
    return flight;
  }

  // One tile's bytes for one caller: a fresh cache hit, or a share of the
  // tile's one request. Leaving (the map aborted) frees the share; the last
  // one to leave aborts the request.
  function tileBytes(tile, source, ctx, mapSignal) {
    const key = `${source.url_template}\n${tile.z}/${tile.x}/${tile.y}`;
    const hit = cache.get(key);
    if (hit && hit.freshUntil > ctx.now()) return Promise.resolve({ png: hit.png });
    let flight = inflight.get(key);
    if (!flight) {
      const url = source.url_template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
      flight = startFlight(key, url, source, ctx);
      inflight.set(key, flight);
    }
    flight.waiters += 1;
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        mapSignal.removeEventListener('abort', leave);
        flight.waiters -= 1;
        if (flight.waiters === 0 && result.reason === 'aborted') flight.controller.abort();
        resolve(result);
      };
      function leave() {
        finish({ reason: 'aborted' });
      }
      if (mapSignal.aborted) return leave();
      mapSignal.addEventListener('abort', leave, { once: true });
      flight.promise.then(finish);
      return undefined;
    });
  }

  async function fetchMosaic(mosaic, {
    profile, fetch = globalThis.fetch, now = Date.now, signal, log, env = process.env,
  } = {}) {
    const logEvent = (level, event, fields) => {
      try {
        if (log && typeof log[level] === 'function') log[level](event, fields);
      } catch {
        // A logger that fails never breaks the map.
      }
    };
    let requested = 0;
    let cached = 0;
    const fail = (reason) => {
      logEvent('warn', 'basemap_unavailable', { reason });
      return {
        basemap: null, reason, requested, cached,
      };
    };
    try {
      if (isOff(env)) return fail('switched_off');
      const block = profile && profile.routing && profile.routing.basemap;
      if (!block) {
        return {
          basemap: null, reason: 'no_basemap', requested, cached,
        };
      }
      const source = { ...FALLBACK, ...block };
      const tiles = tileList(mosaic, source.max_zoom);
      if (!tiles) return fail('mosaic_invalid');
      requested = tiles.length;
      if (signal && signal.aborted) return fail('aborted');
      if (typeof fetch !== 'function') return fail('fetch_failed');
      const ctx = { fetch, now };
      const start = now();

      // During a cool-down only fresh cached tiles can be served.
      const fresh = tiles.filter((t) => {
        const e = cache.get(`${source.url_template}\n${t.z}/${t.x}/${t.y}`);
        return e && e.freshUntil > start;
      }).length;
      cached = fresh;
      if (fresh < tiles.length && coolingDown(source.url_template, start)) return fail('cooling_down');

      const map = new AbortController();
      let failure = null;
      const stop = (reason) => {
        if (!failure) failure = reason;
        map.abort();
      };
      const timer = setTimeout(() => stop('timeout'), MAP_TIMEOUT_MS);
      const onAbort = () => stop('aborted');
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const stopped = new Promise((resolve) => { map.signal.addEventListener('abort', resolve, { once: true }); });
      try {
        const all = Promise.all(tiles.map(async (t) => {
          const r = await tileBytes(t, source, ctx, map.signal);
          if (r.reason) stop(r.reason);
          return r;
        }));
        const results = await Promise.race([all, stopped]);
        if (failure || !Array.isArray(results)) return fail(failure || 'aborted');
        logEvent('debug', 'basemap_tiles', { tiles: tiles.length, from_cache: fresh });
        return {
          basemap: { tiles: tiles.map((t, i) => ({ col: t.col, row: t.row, png: results[i].png })), ox: mosaic.ox, oy: mosaic.oy },
          reason: null,
          requested,
          cached,
        };
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (!map.signal.aborted) map.abort();
      }
    } catch {
      return fail('fetch_failed');
    }
  }

  return { fetchMosaic };
}

const shared = createBasemap();

module.exports = {
  fetchMosaic: shared.fetchMosaic,
  createBasemap,
  REASONS,
  OFF_ENV,
  TILE_SIZE,
  MAX_TILE_BYTES,
  MAX_TILES,
  MAX_CONCURRENT,
  TILE_TIMEOUT_MS,
  MAP_TIMEOUT_MS,
  COOL_DOWN_MS,
};
