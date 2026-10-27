'use strict';

// A stand-in tile server for kit/runtime/basemap (Story 15.9, AD-R19). It is
// a fetch function, not a socket: no test reaches the network.
//
//   const tiles = createFakeTiles();
//   await fetchMosaic(mosaic, { profile, fetch: tiles.fetch, ... });
//   tiles.requests   // every request it saw: url, method, headers, options
//
// It refuses what OpenStreetMap's tile servers refuse (their tile usage
// policy and observed answers), so a request that passes here is shaped like
// one the real server takes:
//   - 403 for a missing, empty or generic User-Agent (a library's or a
//     browser's default);
//   - 404 for z outside 0 to 19, or x or y outside [0, 2^z), or any other path;
//   - 400 for any query string (even a bare "?");
//   - 405 for any method but GET;
//   - a host it does not serve fails the way Node's fetch fails on an unknown
//     host: a TypeError "fetch failed" whose cause names the host;
//   - a redirect with redirect: 'error' fails the way Node's fetch does.
// Like the real server it sends Cache-Control (max-age, 7 days by default)
// and an ETag, and answers 304 to a matching If-None-Match.
//
// It can be told to misbehave, for every tile or only the ones `only` picks
// (({ z, x, y }) => boolean), by setting tiles.respond:
//   { status: 429 | 503 | 403 | 500 | 302 }  that status, a text body
//   { delayMs }                               answer late (setTimeout, so
//                                             mock.timers drives it); an
//                                             abort while waiting rejects
//   { body: 'oversize' }                      300 KB of PNG-headed bytes; with
//                                             contentLength: false no
//                                             Content-Length is sent
//   { body: 'html' }                          text/html, not a tile
//   { body: 'garbage' }                       image/png that is not a PNG
//   { body: 'small' }                         a 128 x 128 PNG
//   { cacheControl, expires, date, age, etag: false }  the cache headers
//                                             (null leaves one out)
//
// The tile images under test/fixtures/routing-map/tiles/ are synthetic
// patterns drawn for these tests, not OpenStreetMap imagery.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TILES_DIR = path.join(__dirname, 'routing-map/tiles');
const read = (name) => fs.readFileSync(path.join(TILES_DIR, name));
const TILE_PNGS = Object.freeze([read('grid.png'), read('stripes.png')]);
const SMALL_PNG = read('small.png');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WEEK_SECONDS = 7 * 24 * 3600;

// User-Agents OpenStreetMap blocks as generic: a library's or a browser's own.
const GENERIC_AGENT = /^\s*(node|undici|node-fetch|axios|got|python|curl|wget|go-http-client|java|okhttp|libwww|mozilla|aiohttp|requests|fetch)\b/i;
const TILE_PATH = /^\/(-?\d+)\/(-?\d+)\/(-?\d+)\.png$/;

// The tile the server holds at z/x/y: one of the two patterns, chosen by x + y.
const tileAt = ({ x, y }) => TILE_PNGS[(x + y) % 2];
const etagOf = (bytes) => `"${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}"`;

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError');
}

function headersOf(init) {
  const out = {};
  for (const [k, v] of new Headers((init && init.headers) || {})) out[k] = v;
  return out;
}

function createFakeTiles({ host = 'tiles.example.org', maxAge = WEEK_SECONDS } = {}) {
  const fake = {
    requests: [],
    respond: null,
    only: null,
    active: 0,
    maxActive: 0,
    fetch: null,
  };

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });

  const text = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });

  function cacheHeaders(r, bytes) {
    const h = {};
    const pick = (key, dflt) => (r && Object.hasOwn(r, key) ? r[key] : dflt);
    const cc = pick('cacheControl', `max-age=${maxAge}`);
    if (cc !== null) h['cache-control'] = cc;
    const expires = pick('expires', null);
    if (expires !== null) h.expires = expires;
    const date = pick('date', new Date(Date.now()).toUTCString());
    if (date !== null) h.date = date;
    const age = pick('age', null);
    if (age !== null) h.age = String(age);
    if (pick('etag', true) !== false) h.etag = etagOf(bytes);
    return h;
  }

  fake.fetch = async (url, init = {}) => {
    const signal = init.signal;
    const method = (init.method || 'GET').toUpperCase();
    const headers = headersOf(init);
    const request = {
      url: String(url), method, headers, redirect: init.redirect, credentials: init.credentials, referrerPolicy: init.referrerPolicy,
    };
    fake.requests.push(request);
    if (signal && signal.aborted) throw abortError();

    const u = new URL(String(url));
    if (u.hostname !== host) {
      throw new TypeError('fetch failed', { cause: new Error(`getaddrinfo ENOTFOUND ${u.hostname} ${String(url)}`) });
    }

    fake.active += 1;
    fake.maxActive = Math.max(fake.maxActive, fake.active);
    try {
      const m = TILE_PATH.exec(u.pathname);
      const tile = m ? { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) } : null;
      const r = fake.respond && (!fake.only || (tile && fake.only(tile))) ? fake.respond : null;
      if (r && r.delayMs) await sleep(r.delayMs, signal);

      if (method !== 'GET') return text(405, 'Method Not Allowed');
      const agent = headers['user-agent'];
      if (!agent || !agent.trim() || GENERIC_AGENT.test(agent)) return text(403, 'Access blocked: see the tile usage policy');
      if (String(url).includes('?')) return text(400, 'Bad Request');
      if (!tile || tile.z < 0 || tile.z > 19) return text(404, 'Not Found');
      const n = 2 ** tile.z;
      if (tile.x < 0 || tile.x >= n || tile.y < 0 || tile.y >= n) return text(404, 'Not Found');

      if (r && r.status >= 300 && r.status < 400) {
        if (init.redirect === 'error') throw new TypeError('fetch failed', { cause: new Error(`unexpected redirect ${String(url)}`) });
        return new Response(null, { status: r.status, headers: { location: 'https://elsewhere.example.org/' } });
      }
      if (r && r.status) return text(r.status, `${r.status} from the fake tile server`);

      let bytes = tileAt(tile);
      let type = 'image/png';
      let sendLength = true;
      if (r && r.body === 'oversize') {
        bytes = Buffer.concat([bytes.subarray(0, 33), Buffer.alloc(300 * 1024, 7)]);
        sendLength = r.contentLength !== false;
      } else if (r && r.body === 'html') {
        bytes = Buffer.from('<html><body>not a tile</body></html>');
        type = 'text/html; charset=utf-8';
      } else if (r && r.body === 'garbage') {
        bytes = Buffer.from('this is not a png, though it says so');
      } else if (r && r.body === 'small') {
        bytes = SMALL_PNG;
      }

      const out = cacheHeaders(r, bytes);
      if (out.etag && headers['if-none-match'] === out.etag) return new Response(null, { status: 304, headers: out });
      out['content-type'] = type;
      if (sendLength) out['content-length'] = String(bytes.length);
      // A stream sent 16 KB at a time, so a body without a Content-Length is
      // read chunk by chunk; like Node's fetch, an abort errors the body.
      let offset = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (signal && signal.aborted) return controller.error(abortError());
          if (offset >= bytes.length) return controller.close();
          controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + 16 * 1024)));
          offset += 16 * 1024;
          return undefined;
        },
      });
      return new Response(body, { status: 200, headers: out });
    } finally {
      fake.active -= 1;
    }
  };

  // Every tile path requested, as "z/x/y", in order.
  fake.paths = () => fake.requests.map((q) => new URL(q.url).pathname.replace(/^\//, '').replace(/\.png$/, ''));
  fake.reset = () => {
    fake.requests.length = 0;
    fake.respond = null;
    fake.only = null;
    fake.maxActive = 0;
  };
  return fake;
}

module.exports = { createFakeTiles, tileAt, etagOf, TILE_PNGS, SMALL_PNG, PNG_SIGNATURE, GENERIC_AGENT };
