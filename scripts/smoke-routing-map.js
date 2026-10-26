'use strict';

// Route map smoke test (Story 15.3, AD-R14, F11), run inside the built image
// by the CI `container` job, so the rasterizer's native binary is proved on
// the image we ship (linux/amd64, glibc, installed by `npm ci --ignore-scripts`):
//
//   docker run --rm --network none --read-only --tmpfs /tmp \
//     -v "$PWD/test/fixtures:/app/test/fixtures:ro" \
//     <image> node scripts/smoke-routing-map.js
//
// For each synthetic map model in test/fixtures/routing-map/ (mounted
// read-only; test/ is not in the image) it renders the SVG, rasterizes it
// twice, and checks the PNG is a PNG of the image's width and height, the same
// bytes both times, and at most 1 MB. Offline: no network, nothing written.
// Each step prints one line. Exits 0 on pass, 1 on fail. It also runs outside
// the image (runtime-routing-map-png.test.js runs it on the dev machine).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const map = require('../kit/runtime/routing-map');
const { pngSize, MAX_PNG_BYTES } = require('../kit/runtime/routing-map/png');

const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'routing-map');

function smoke(dir = FIXTURES) {
  console.log(`routing-map smoke: platform ${process.platform}/${process.arch}`);
  for (const view of map.VIEWS) {
    const { model } = JSON.parse(fs.readFileSync(path.join(dir, `${view}.json`), 'utf8'));
    const want = map.imageSize(view, model.frame);
    const a = map.renderPng(view, model);
    const b = map.rasterize(map.renderSvg(view, model), want);
    assert.deepEqual(pngSize(a), want, `${view}: the PNG is ${want.width}x${want.height}`);
    assert.ok(a.equals(b), `${view}: the same bytes twice`);
    assert.ok(a.length <= MAX_PNG_BYTES, `${view}: at most 1 MB`);
    console.log(`routing-map smoke: ok - ${view} ${want.width}x${want.height}, ${a.length} bytes`);
  }
}

module.exports = { smoke };

if (require.main === module) {
  try {
    smoke();
    console.log('routing-map smoke: PASSED');
  } catch (err) {
    console.error(`routing-map smoke: FAILED\n${err.message}`);
    process.exitCode = 1;
  }
}
