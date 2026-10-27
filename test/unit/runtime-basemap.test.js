'use strict';

// The street map's tile fetcher (Story 15.9, AD-R18, AD-R19), against the fake
// tile server in test/fixtures/fake-tiles.js. Every clock is frozen with
// mock.timers (setTimeout and Date: the fetcher's timeouts, its cache and
// cool-down clock, and the fake's Date header and delays). Global fetch is
// stubbed to throw, so nothing here can reach the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { validateProfile, loadProfile } = require('../../kit/lib/profile');
const {
  createBasemap, fetchMosaic: sharedFetchMosaic, REASONS, OFF_ENV, MAX_CONCURRENT, TILE_TIMEOUT_MS, MAP_TIMEOUT_MS, COOL_DOWN_MS,
} = require('../../kit/runtime/basemap');
const { createTileCache, freshUntil, DAY_MS } = require('../../kit/runtime/basemap/cache');
const {
  createFakeTiles, tileAt, etagOf, TILE_PNGS, SMALL_PNG,
} = require('../fixtures/fake-tiles');

const FIXTURE = path.join(__dirname, '../fixtures/profiles/routing-basemap.yml');
const PROFILE = loadProfile(FIXTURE);
const UA = PROFILE.routing.basemap.user_agent;
const T0 = Date.parse('2026-10-26T12:00:00Z');
// A 3 x 2 view at zoom 12; its tile numbers must never show in a log or result.
const MOSAIC = Object.freeze({ z: 12, tx0: 1100, ty0: 1500, cols: 3, rows: 2, ox: -40, oy: -100 });
const MOSAIC_PATHS = ['12/1100/1500', '12/1101/1500', '12/1102/1500', '12/1100/1501', '12/1101/1501', '12/1102/1501'];
const one = (x, y) => ({ z: 12, tx0: x, ty0: y, cols: 1, rows: 1, ox: 0, oy: 0 });

const withBasemap = (edit) => {
  const p = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
  edit(p.routing.basemap);
  return validateProfile(p);
};

// No test may reach the network: global fetch throws, and counts the calls.
let globalCalls = 0;
const realFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = async () => {
    globalCalls += 1;
    throw new Error('the network is off in tests: inject fetch (https://tiles.example.org/12/1100/1500.png)');
  };
});
test.after(() => {
  globalThis.fetch = realFetch;
});

const flush = async () => {
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

// A fresh fetcher, fake server and log spy, with the clocks frozen at T0.
function setup(t, { profile = PROFILE, host } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const tiles = createFakeTiles(host ? { host } : {});
  const { fetchMosaic } = createBasemap();
  const logs = [];
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (event, fields) => logs.push({ level, event, fields });
  const run = (mosaic = MOSAIC, extra = {}) => fetchMosaic(mosaic, {
    profile, fetch: tiles.fetch, log, env: {}, ...extra,
  });
  return { tiles, run, logs, fetchMosaic, log };
}

// A null result: its reason, and the two counts (whole numbers, never which tiles).
const expectNull = (result, reason) => {
  assert.deepEqual(Object.keys(result).sort(), ['basemap', 'cached', 'reason', 'requested']);
  assert.deepEqual({ basemap: result.basemap, reason: result.reason }, { basemap: null, reason });
  for (const k of ['requested', 'cached']) assert.ok(Number.isInteger(result[k]) && result[k] >= 0, k);
};

test('only the view\'s cols x rows tiles are requested, each a plain GET with the profile\'s User-Agent and redirect: error', async (t) => {
  const { tiles, run } = setup(t);
  const result = await run();
  assert.equal(result.reason, null);
  assert.deepEqual(tiles.paths(), MOSAIC_PATHS);
  for (const q of tiles.requests) {
    assert.match(q.url, /^https:\/\/tiles\.example\.org\/12\/\d+\/\d+\.png$/);
    assert.equal(q.method, 'GET');
    assert.equal(q.redirect, 'error');
    assert.equal(q.credentials, 'omit');
    assert.equal(q.referrerPolicy, 'no-referrer');
    assert.equal(q.headers['user-agent'], UA);
    for (const h of ['cookie', 'referer', 'authorization', 'if-none-match']) assert.equal(Object.hasOwn(q.headers, h), false, h);
  }
  assert.deepEqual(result.basemap.tiles.map(({ col, row }) => [col, row]), [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]);
  result.basemap.tiles.forEach(({ col, row, png }) => assert.ok(png.equals(tileAt({ x: 1100 + col, y: 1500 + row })), `${col},${row}`));
  assert.deepEqual([result.basemap.ox, result.basemap.oy], [-40, -100]);
  assert.equal(globalCalls, 0);
});

test('Story 15.10: the result counts the tiles the map needed and the ones the cache held fresh, and names no tile', async (t) => {
  const { run } = setup(t);
  const first = await run();
  assert.deepEqual(Object.keys(first).sort(), ['basemap', 'cached', 'reason', 'requested']);
  assert.deepEqual([first.requested, first.cached], [6, 0]);
  const again = await run();
  assert.deepEqual([again.requested, again.cached], [6, 6]);
  const invalid = await run({ ...MOSAIC, cols: 0 });
  assert.deepEqual([invalid.reason, invalid.requested, invalid.cached], ['mosaic_invalid', 0, 0]);
});

test('cached tiles are not requested again: the same view sends nothing, an overlapping one only its new tiles', async (t) => {
  const { tiles, run, logs } = setup(t);
  await run();
  tiles.reset();
  const again = await run();
  assert.equal(again.reason, null);
  assert.equal(tiles.requests.length, 0);
  assert.deepEqual(logs.at(-1), { level: 'debug', event: 'basemap_tiles', fields: { tiles: 6, from_cache: 6 } });
  const shifted = await run({ ...MOSAIC, tx0: 1101 });
  assert.equal(shifted.reason, null);
  assert.deepEqual(tiles.paths(), ['12/1103/1500', '12/1103/1501']);
});

test('at most 2 requests run at once, across callers', async (t) => {
  const { tiles, run } = setup(t);
  tiles.respond = { delayMs: 100 };
  const a = run();
  const b = run({ ...MOSAIC, ty0: 1600 });
  for (let i = 0; i < 8; i += 1) {
    await flush();
    assert.ok(tiles.active <= MAX_CONCURRENT, `active ${tiles.active}`);
    t.mock.timers.tick(100);
  }
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.reason, null);
  assert.equal(rb.reason, null);
  assert.equal(MAX_CONCURRENT, 2);
  assert.equal(tiles.maxActive, 2);
  assert.equal(tiles.requests.length, 12);
});

test('two callers wanting the same tiles share one request per tile; one leaving does not stop the other', async (t) => {
  const { tiles, run } = setup(t);
  tiles.respond = { delayMs: 50 };
  const leaver = new AbortController();
  const a = run(MOSAIC, { signal: leaver.signal });
  const b = run();
  await flush();
  leaver.abort();
  for (let i = 0; i < 4; i += 1) {
    await flush();
    t.mock.timers.tick(50);
  }
  expectNull(await a, 'aborted');
  const rb = await b;
  assert.equal(rb.reason, null);
  assert.equal(rb.basemap.tiles.length, 6);
  assert.deepEqual(tiles.paths(), MOSAIC_PATHS, 'each tile once');
});

test('each refusing answer gives null with its reason, and the whole layer is dropped', async (t) => {
  const cases = [
    [{ status: 403 }, 'forbidden'],
    [{ status: 429 }, 'rate_limited'],
    [{ status: 503 }, 'server_error'],
    [{ status: 500 }, 'server_error'],
    [{ status: 404 }, 'bad_status'],
    [{ status: 302 }, 'fetch_failed'],
    [{ body: 'html' }, 'not_png'],
    [{ body: 'garbage' }, 'not_png'],
    [{ body: 'small' }, 'wrong_size'],
    [{ body: 'oversize' }, 'too_large'],
    [{ body: 'oversize', contentLength: false }, 'too_large'],
  ];
  for (const [respond, reason] of cases) {
    await t.test(reason, async (st) => {
      const { tiles, run, logs } = setup(st);
      tiles.respond = respond;
      // Only one tile misbehaves: one bad tile drops them all.
      tiles.only = ({ x, y }) => x === 1101 && y === 1501;
      expectNull(await run(), reason);
      assert.deepEqual(logs, [{ level: 'warn', event: 'basemap_unavailable', fields: { reason } }]);
      assert.ok(REASONS.includes(reason));
    });
  }
});

test('a tile slower than 4 s times out; a map slower than 8 s times out; the rest is aborted', async (t) => {
  await t.test('tile', async (st) => {
    const { tiles, run } = setup(st);
    tiles.respond = { delayMs: 60000 };
    const p = run(one(1100, 1500));
    let settled = false;
    p.then(() => { settled = true; });
    await flush();
    st.mock.timers.tick(TILE_TIMEOUT_MS - 1);
    await flush();
    assert.equal(settled, false);
    st.mock.timers.tick(1);
    await flush();
    expectNull(await p, 'timeout');
    assert.equal(tiles.active, 0, 'the request was aborted');
  });
  await t.test('map', async (st) => {
    const { tiles, run } = setup(st);
    // Each tile takes 3.5 s (under the tile limit); 6 tiles, 2 at a time, need 10.5 s.
    tiles.respond = { delayMs: 3500 };
    const p = run();
    let settled = false;
    p.then(() => { settled = true; });
    for (let ms = 0; ms < MAP_TIMEOUT_MS - 500; ms += 500) {
      await flush();
      st.mock.timers.tick(500);
    }
    await flush();
    assert.equal(settled, false, 'still waiting at 7.5 s');
    st.mock.timers.tick(500);
    await flush();
    expectNull(await p, 'timeout');
    assert.equal(tiles.requests.length, 6);
    assert.equal(tiles.active, 0, 'the last two requests were aborted');
  });
});

test('the caller\'s signal aborts the fetch; an aborted signal sends nothing', async (t) => {
  const { tiles, run } = setup(t);
  const already = new AbortController();
  already.abort();
  expectNull(await run(MOSAIC, { signal: already.signal }), 'aborted');
  assert.equal(tiles.requests.length, 0);
  tiles.respond = { delayMs: 1000 };
  const ctrl = new AbortController();
  const p = run(MOSAIC, { signal: ctrl.signal });
  await flush();
  assert.equal(tiles.requests.length, 2);
  ctrl.abort();
  await flush();
  expectNull(await p, 'aborted');
  assert.equal(tiles.active, 0, 'the requests were aborted');
  assert.equal(tiles.requests.length, 2, 'the queued tiles were never requested');
});

test('after a 403, 429 or 5xx nothing is requested for 10 minutes; fresh cached tiles still show', async (t) => {
  for (const [status, reason] of [[403, 'forbidden'], [429, 'rate_limited'], [503, 'server_error']]) {
    await t.test(String(status), async (st) => {
      const { tiles, run } = setup(st);
      const cachedView = one(2000, 2000);
      assert.equal((await run(cachedView)).reason, null);
      tiles.reset();
      tiles.respond = { status };
      tiles.only = ({ x, y }) => x === 1100 && y === 1500;
      expectNull(await run(), reason);
      assert.ok(tiles.requests.length <= MAX_CONCURRENT, 'no tile after the refusal is requested');
      // The tile requested alongside the refused one came back and is cached.
      const cachedAlongside = tiles.requests.length - 1;
      tiles.reset();
      expectNull(await run(), 'cooling_down');
      expectNull(await run({ ...MOSAIC, ty0: 1700 }), 'cooling_down');
      assert.equal(tiles.requests.length, 0);
      assert.equal((await run(cachedView)).reason, null, 'a fully cached view needs no request');
      st.mock.timers.tick(COOL_DOWN_MS - 1);
      expectNull(await run(), 'cooling_down');
      assert.equal(tiles.requests.length, 0);
      st.mock.timers.tick(1);
      assert.equal((await run()).reason, null);
      assert.equal(tiles.requests.length, 6 - cachedAlongside);
    });
  }
});

test('APLABS_BASEMAP_OFF, read on every call, means no request', async (t) => {
  const { tiles, run, fetchMosaic, log } = setup(t);
  for (const v of ['1', 'true', 'yes', 'off']) {
    expectNull(await run(MOSAIC, { env: { [OFF_ENV]: v } }), 'switched_off');
  }
  assert.equal(tiles.requests.length, 0);
  for (const v of ['', '0']) assert.equal((await run(one(10, 10 + v.length), { env: { [OFF_ENV]: v } })).reason, null, `"${v}"`);
  // The default env is process.env, read on each call.
  const before = process.env[OFF_ENV];
  try {
    process.env[OFF_ENV] = '1';
    expectNull(await fetchMosaic(one(30, 30), { profile: PROFILE, fetch: tiles.fetch, log }), 'switched_off');
    delete process.env[OFF_ENV];
    assert.equal((await fetchMosaic(one(30, 30), { profile: PROFILE, fetch: tiles.fetch, log })).reason, null);
  } finally {
    if (before === undefined) delete process.env[OFF_ENV];
    else process.env[OFF_ENV] = before;
  }
});

test('no basemap block means no request and no warning', async (t) => {
  const plain = loadProfile(path.join(__dirname, '../fixtures/profiles/routing.yml'));
  const { tiles, run, logs } = setup(t, { profile: plain });
  expectNull(await run(), 'no_basemap');
  expectNull(await run(MOSAIC, { profile: undefined }), 'no_basemap');
  assert.equal(tiles.requests.length, 0);
  assert.deepEqual(logs, []);
});

test('a mosaic that is not whole, in range and at most 64 tiles at or below max_zoom is refused before any request', async (t) => {
  const { tiles, run } = setup(t);
  const low = withBasemap((b) => { b.max_zoom = 11; });
  const bad = [
    null, 'mosaic', {}, [],
    { ...MOSAIC, z: 20 }, { ...MOSAIC, z: -1 }, { ...MOSAIC, z: 12.5 }, { ...MOSAIC, z: '12' },
    { ...MOSAIC, cols: 0 }, { ...MOSAIC, rows: -1 }, { ...MOSAIC, cols: 9, rows: 8 }, { ...MOSAIC, cols: 65, rows: 1 },
    { ...MOSAIC, tx0: -1 }, { ...MOSAIC, ty0: 4095 }, { ...MOSAIC, tx0: 4094 }, { ...MOSAIC, ox: 0.5 }, { ...MOSAIC, oy: undefined },
  ];
  for (const m of bad) expectNull(await run(m), 'mosaic_invalid');
  expectNull(await run(MOSAIC, { profile: low }), 'mosaic_invalid');
  assert.equal(tiles.requests.length, 0);
  assert.equal((await run({ z: 0, tx0: 0, ty0: 0, cols: 1, rows: 1, ox: 0, oy: 0 })).reason, null);
  assert.equal((await run({ ...MOSAIC, cols: 8, rows: 8 })).basemap.tiles.length, 64);
});

test('the cache honours max-age, then revalidates with If-None-Match; a 304 refreshes the entry', async (t) => {
  const { tiles, run } = setup(t);
  tiles.respond = { cacheControl: 'max-age=3600' };
  await run(one(1, 1));
  tiles.reset();
  tiles.respond = { cacheControl: 'max-age=3600' };
  t.mock.timers.tick(3600 * 1000 - 1);
  await run(one(1, 1));
  assert.equal(tiles.requests.length, 0, 'fresh until max-age');
  t.mock.timers.tick(1);
  const revalidated = await run(one(1, 1));
  assert.equal(tiles.requests.length, 1);
  assert.equal(tiles.requests[0].headers['if-none-match'], etagOf(tileAt({ x: 1, y: 1 })));
  assert.ok(revalidated.basemap.tiles[0].png.equals(tileAt({ x: 1, y: 1 })), 'the 304 serves the cached bytes');
  t.mock.timers.tick(3599 * 1000);
  await run(one(1, 1));
  assert.equal(tiles.requests.length, 1, 'the 304 refreshed the entry for another max-age');
});

test('max-age counts the Age the response already had', async (t) => {
  const { tiles, run } = setup(t);
  tiles.respond = { cacheControl: 'max-age=600', age: 500 };
  await run(one(1, 1));
  t.mock.timers.tick(99 * 1000);
  await run(one(1, 1));
  assert.equal(tiles.requests.length, 1);
  t.mock.timers.tick(1000);
  await run(one(1, 1));
  assert.equal(tiles.requests.length, 2);
});

test('the cache honours Expires (from the response Date) when there is no max-age', async (t) => {
  const { tiles, run } = setup(t);
  tiles.respond = { cacheControl: null, expires: new Date(T0 + 3600 * 1000).toUTCString() };
  await run(one(1, 1));
  t.mock.timers.tick(3600 * 1000 - 1);
  await run(one(1, 1));
  assert.equal(tiles.requests.length, 1);
  t.mock.timers.tick(1);
  await run(one(1, 1));
  assert.equal(tiles.requests.length, 2);
});

test('with no cache headers the cache keeps a tile cache_days (7 by default, or the profile\'s)', async (t) => {
  for (const [profile, days] of [[PROFILE, 7], [withBasemap((b) => { b.cache_days = 30; }), 30]]) {
    await t.test(`${days} days`, async (st) => {
      const { tiles, run } = setup(st, { profile });
      tiles.respond = { cacheControl: null };
      await run(one(1, 1));
      st.mock.timers.tick(days * DAY_MS - 1);
      await run(one(1, 1));
      assert.equal(tiles.requests.length, 1);
      st.mock.timers.tick(1);
      await run(one(1, 1));
      assert.equal(tiles.requests.length, 2);
    });
  }
});

test('no-store stores nothing; no-cache revalidates every time; a stale entry with no ETag is fetched plainly', async (t) => {
  const { tiles, run } = setup(t);
  tiles.respond = { cacheControl: 'no-store' };
  await run(one(1, 1));
  await run(one(1, 1));
  assert.equal(tiles.requests.length, 2);
  assert.equal(Object.hasOwn(tiles.requests[1].headers, 'if-none-match'), false);
  tiles.reset();
  tiles.respond = { cacheControl: 'no-cache' };
  await run(one(2, 2));
  const second = await run(one(2, 2));
  assert.equal(tiles.requests.length, 2);
  assert.equal(tiles.requests[1].headers['if-none-match'], etagOf(tileAt({ x: 2, y: 2 })));
  assert.ok(second.basemap.tiles[0].png.equals(tileAt({ x: 2, y: 2 })));
  tiles.reset();
  tiles.respond = { cacheControl: 'max-age=1', etag: false };
  await run(one(3, 3));
  t.mock.timers.tick(1000);
  await run(one(3, 3));
  assert.equal(tiles.requests.length, 2);
  assert.equal(Object.hasOwn(tiles.requests[1].headers, 'if-none-match'), false);
});

test('the cache evicts the least recently used tile past max_cached_tiles', async (t) => {
  const profile = withBasemap((b) => { b.max_cached_tiles = 64; });
  const { tiles, run } = setup(t, { profile });
  const grid = { z: 12, tx0: 100, ty0: 100, cols: 8, rows: 8, ox: 0, oy: 0 };
  assert.equal((await run(grid)).reason, null);
  assert.equal(tiles.requests.length, 64);
  tiles.reset();
  await run(one(100, 100)); // the oldest, now the most recent
  await run(one(500, 500)); // a 65th tile: evicts the least recent, 101/100
  assert.deepEqual(tiles.paths(), ['12/500/500']);
  tiles.reset();
  await run(one(100, 100));
  assert.equal(tiles.requests.length, 0, 'the touched tile stayed');
  await run(one(101, 100));
  assert.deepEqual(tiles.paths(), ['12/101/100'], 'the least recent was evicted');
});

test('createTileCache and freshUntil, directly', () => {
  const cache = createTileCache();
  cache.set('a', { n: 1 }, 2);
  cache.set('b', { n: 2 }, 2);
  cache.get('a');
  cache.set('c', { n: 3 }, 2);
  assert.deepEqual([cache.has('a'), cache.has('b'), cache.has('c'), cache.size], [true, false, true, 2]);
  const h = (o) => new Headers(o);
  assert.equal(freshUntil(h({ 'cache-control': 'public, max-age=60' }), 1000, 7), 61000);
  assert.equal(freshUntil(h({ 'cache-control': 'max-age=60, no-store' }), 1000, 7), null);
  assert.equal(freshUntil(h({ 'cache-control': 'no-cache' }), 1000, 7), 1000);
  assert.equal(freshUntil(h({ expires: 'not a date' }), 1000, 7), 1000, 'an unreadable Expires is already stale');
  assert.equal(freshUntil(h({ 'cache-control': 'max-age=x' }), 1000, 7), 1000 + 7 * DAY_MS);
  assert.equal(freshUntil(h({}), 0, 8), 8 * DAY_MS);
});

test('logs, results and errors hold no URL, host, path, tile numbers or body, whatever goes wrong', async (t) => {
  const seen = [];
  const throwingLog = { warn() { throw new Error('logger down'); } };
  const scenarios = [
    { respond: { status: 429 } }, { respond: { status: 503 } }, { respond: { body: 'html' } }, { respond: { body: 'oversize', contentLength: false } },
    { respond: { delayMs: 60000 }, tick: TILE_TIMEOUT_MS }, { host: 'other.example.net' }, { respond: { status: 302 } }, {},
  ];
  for (const s of scenarios) {
    await t.test(JSON.stringify(s), async (st) => {
      const { tiles, run, logs } = setup(st, { host: s.host });
      tiles.respond = s.respond || null;
      const p = run();
      if (s.tick) {
        await flush();
        st.mock.timers.tick(s.tick);
      }
      const result = await p;
      seen.push(JSON.stringify(result, (k, v) => (k === 'png' ? '[png]' : v)), JSON.stringify(logs));
      assert.ok(result.reason === null || REASONS.includes(result.reason), result.reason);
    });
  }
  // A thrown fetch error that names the URL, and a logger that throws: still a plain code.
  await t.test('a fetch that throws the URL, a logger that throws', async (st) => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    const { fetchMosaic } = createBasemap();
    const result = await fetchMosaic(MOSAIC, {
      profile: PROFILE, env: {}, log: throwingLog, fetch: async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); },
    });
    expectNull(result, 'fetch_failed');
    const viaGlobal = await fetchMosaic(one(7, 7), { profile: PROFILE, env: {} });
    expectNull(viaGlobal, 'fetch_failed');
    assert.equal(globalCalls, 1, 'with no fetch injected it uses the global one, which is stubbed off');
    globalCalls = 0;
    seen.push(JSON.stringify(result), JSON.stringify(viaGlobal));
  });
  const all = seen.join('\n');
  for (const needle of ['example', 'http', '.png', '/12/', '1100', '1101', '1102', '1500', '1501', 'not a tile', 'fake tile server', 'ECONN', 'ENOTFOUND', 'z":12', 'tx0']) {
    assert.equal(all.includes(needle), false, needle);
  }
});

test('the module\'s shared fetchMosaic follows the same rules (kill switch, no basemap)', async () => {
  expectNull(await sharedFetchMosaic(MOSAIC, { profile: PROFILE, env: { [OFF_ENV]: '1' } }), 'switched_off');
  expectNull(await sharedFetchMosaic(MOSAIC, { profile: {}, env: {} }), 'no_basemap');
});

// The fake must refuse what OpenStreetMap refuses, or a test passing against it proves nothing.
test('the fake tile server refuses what OpenStreetMap refuses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const tiles = createFakeTiles();
  const get = (url, headers = { 'User-Agent': UA }, init = {}) => tiles.fetch(url, { headers, ...init });
  const base = 'https://tiles.example.org';
  assert.equal((await get(`${base}/12/1100/1500.png`, {})).status, 403, 'no User-Agent');
  for (const ua of ['', 'node', 'undici', 'node-fetch/1.0', 'python-requests/2.31', 'curl/8.4.0', 'Mozilla/5.0 (X11)']) {
    assert.equal((await get(`${base}/12/1100/1500.png`, { 'User-Agent': ua })).status, 403, ua);
  }
  for (const p of ['20/0/0', '-1/0/0', '12/4096/0', '12/0/4096', '12/-1/0', '0/1/0', '12/1100', 'x/1/1']) {
    assert.equal((await get(`${base}/${p}.png`)).status, 404, p);
  }
  for (const q of ['?', '?key=1', '?s=a']) assert.equal((await get(`${base}/12/1100/1500.png${q}`)).status, 400, q);
  for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
    assert.equal((await get(`${base}/12/1100/1500.png`, { 'User-Agent': UA }, { method })).status, 405, method);
  }
  await assert.rejects(get('https://elsewhere.example.org/12/1100/1500.png'), /fetch failed/);
  tiles.respond = { status: 302 };
  await assert.rejects(get(`${base}/12/1100/1500.png`, { 'User-Agent': UA }, { redirect: 'error' }), /fetch failed/);
  assert.equal((await get(`${base}/12/1100/1500.png`)).status, 302);
  tiles.respond = null;
  const ok = await get(`${base}/12/1100/1500.png`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('cache-control'), 'max-age=604800');
  const etag = ok.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{16}"$/);
  assert.ok(Buffer.from(await ok.arrayBuffer()).equals(tileAt({ x: 1100, y: 1500 })));
  assert.equal((await get(`${base}/12/1100/1500.png`, { 'User-Agent': UA, 'If-None-Match': etag })).status, 304);
  assert.equal((await get(`${base}/12/1100/1500.png`, { 'User-Agent': UA, 'If-None-Match': '"other"' })).status, 200);
});

test('the tile fixtures are synthetic 256 x 256 PNGs (and one 128 x 128)', () => {
  for (const png of TILE_PNGS) assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256]);
  assert.deepEqual([SMALL_PNG.readUInt32BE(16), SMALL_PNG.readUInt32BE(20)], [128, 128]);
  assert.ok(TILE_PNGS.every((p) => p.length < 4096), 'flat synthetic patterns, not map imagery');
});
