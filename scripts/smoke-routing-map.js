'use strict';

// Route map smoke test (Story 15.3, AD-R14, F11; street tiles, Story 15.10,
// AD-R19, AD-R21), run inside the built image by the CI `container` job, so
// the rasterizer's native binary is proved on the image we ship
// (linux/amd64, glibc, installed by `npm ci --ignore-scripts`):
//
//   docker run --rm --network none --read-only --tmpfs /tmp \
//     -v "$PWD/test/fixtures:/app/test/fixtures:ro" \
//     <image> node scripts/smoke-routing-map.js
//
// 1. For each synthetic map model in test/fixtures/routing-map/ (mounted
//    read-only; test/ is not in the image) it renders the SVG, rasterizes it
//    twice, and checks the PNG is a PNG of the image's width and height (the
//    route view's twice that: Plan a route's map is drawn at 2x, Story
//    15.18), the same bytes both times, and at most PNG_CAP.
// 2. It draws one two-panel view over the synthetic street tiles
//    (test/fixtures/routing-map/tiles/streets-*.png) twice, and checks the
//    same size and byte checks, and the size against the cap.
// 3. It asks kit/runtime/basemap fetchMosaic for a view's tiles from the
//    OpenStreetMap template. With --network none no request can leave, so
//    the answer must be null (the plain map) within the 8 s budget. Outside
//    the image this step would reach the real tile server, so the unit test
//    that runs this script on the dev machine passes --skip-network.
// Nothing is written. Each step prints one line, never a URL or a tile
// number. Exits 0 on pass, 1 on fail.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const map = require('../kit/runtime/routing-map');
const {
  rasterize, pngSize, MAX_PNG_BYTES, PNG_CAP, ROUTE_SCALES,
} = require('../kit/runtime/routing-map/png');
const { createBasemap, MAP_TIMEOUT_MS } = require('../kit/runtime/basemap');

const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'routing-map');
const STREET_TILES = ['a', 'b', 'c', 'd'];
// Slack on the 8 s map budget for a slow runner's timers.
const BUDGET_SLACK_MS = 1500;
// The OpenStreetMap source a profile names (AD-R18); only ever reached when
// a network is there, which inside the CI image it is not.
const OSM_PROFILE = Object.freeze({
  routing: {
    basemap: {
      url_template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors',
      attribution_url: 'https://www.openstreetmap.org/copyright',
      user_agent: 'aplabs-routing-map/smoke (+https://example.org/contact)',
    },
  },
});
// A view's mosaic near the demo's city at zoom 12: 3 x 3 tiles.
const MOSAIC = Object.freeze({ z: 12, tx0: 1103, ty0: 1546, cols: 3, rows: 3, ox: -100, oy: -50 });

const model = (dir, view) => JSON.parse(fs.readFileSync(path.join(dir, `${view}.json`), 'utf8')).model;

function smoke(dir = FIXTURES) {
  console.log(`routing-map smoke: platform ${process.platform}/${process.arch}`);
  for (const view of map.VIEWS) {
    const m = model(dir, view);
    const size = map.imageSize(view, m.frame);
    const scaled = view === 'route' ? { scales: ROUTE_SCALES } : undefined;
    const zoom = scaled ? ROUTE_SCALES[0] : 1;
    const want = { width: size.width * zoom, height: size.height * zoom };
    const a = map.renderPng(view, m);
    const b = rasterize(map.renderSvg(view, m), size, scaled);
    assert.deepEqual(pngSize(a), want, `${view}: the PNG is ${want.width}x${want.height}`);
    assert.ok(a.equals(b), `${view}: the same bytes twice`);
    assert.ok(a.length <= PNG_CAP, `${view}: at most ${PNG_CAP} bytes`);
    console.log(`routing-map smoke: ok - ${view} ${want.width}x${want.height}, ${a.length} bytes`);
  }
}

// The tiles covering a frame from (ox, oy), the street fixtures in turn.
function streetBasemap(dir, frame, ox, oy) {
  const pngs = STREET_TILES.map((n) => fs.readFileSync(path.join(dir, 'tiles', `streets-${n}.png`)));
  const cols = Math.ceil((frame.width - ox) / 256);
  const rows = Math.ceil((frame.height - oy) / 256);
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) tiles.push({ col, row, png: pngs[(col * 3 + row) % pngs.length] });
  }
  return { tiles, ox, oy };
}

function streets(dir = FIXTURES, view = 'compare') {
  const m = model(dir, view);
  const want = map.imageSize(view, m.frame);
  const basemap = streetBasemap(dir, m.frame, -100, -50);
  const a = map.renderPng(view, m, { basemap });
  const b = map.renderPng(view, m, { basemap });
  assert.deepEqual(pngSize(a), want, `${view} with streets: the PNG is ${want.width}x${want.height}`);
  assert.ok(a.equals(b), `${view} with streets: the same bytes twice`);
  assert.ok(a.length <= MAX_PNG_BYTES, `${view} with streets: ${a.length} bytes is at most the cap, ${MAX_PNG_BYTES}`);
  console.log(`routing-map smoke: ok - ${view} with streets ${want.width}x${want.height}, ${a.length} bytes (cap ${MAX_PNG_BYTES})`);
}

// fetchMosaic against the OpenStreetMap template must give null within the
// budget. fetch: Node's own unless a test passes one.
async function offline({ fetch = globalThis.fetch, now = Date.now } = {}) {
  const { fetchMosaic } = createBasemap();
  const start = now();
  const got = await fetchMosaic(MOSAIC, {
    profile: OSM_PROFILE, fetch, now, env: {},
  });
  const took = now() - start;
  assert.equal(got.basemap, null, 'no tiles without a network');
  assert.ok(took <= MAP_TIMEOUT_MS + BUDGET_SLACK_MS, `the plain map within the budget (${took} ms)`);
  console.log(`routing-map smoke: ok - no network gives the plain map (${got.reason}, ${took} ms)`);
  return got;
}

module.exports = {
  smoke, streets, offline, OSM_PROFILE, MOSAIC,
};

if (require.main === module) {
  (async () => {
    smoke();
    streets();
    if (process.argv.includes('--skip-network')) console.log('routing-map smoke: skipped - the no-network fetch (--skip-network)');
    else await offline();
    console.log('routing-map smoke: PASSED');
  })().catch((err) => {
    console.error(`routing-map smoke: FAILED\n${err.message}`);
    process.exitCode = 1;
  });
}
