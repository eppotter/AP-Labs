'use strict';

// SVG to PNG (Story 15.3, AD-R14). The one file that requires the rasterizer,
// @resvg/resvg-js (MPL-2.0, prebuilt per-platform binaries, no install script
// and no network at run time). It is required lazily, on the first rasterize,
// so loading the kit never loads a native binary; if it cannot load, every
// call fails with the same fixed-text RoutingFault (renderer_unavailable),
// which the routing-map archetype shows through its error exit.
//
// System fonts are off and nothing is loaded from outside the SVG (the map
// has no text and no reference). The PNG is drawn at the SVG's own size, so
// it has the frame's width and height (two frames for a two-panel view);
// a result of any other size is refused (renderer_failed). A PNG over
// MAX_PNG_BYTES is refused (image_too_large). Same SVG, same bytes on one
// machine; no cross-platform hash is promised.
//
// Defence in depth: the rasterizer's default image loader can read a local
// file an <image href> names. renderSvg never draws one, and index.js only
// rasterizes renderSvg's output, but rasterize also refuses (unsafe_svg) any
// SVG holding a reference or style: <image, href, xlink, url(, <use, <style,
// @import, foreignObject or <script, in any case.
//
// Street tiles (Story 15.10, AD-R21). The one allowance: composeBasemap puts
// the tiles under the plot as <image href="data:image/png;base64,..."> it
// writes itself, from bytes it has checked. The defence stays whole:
//   1. the plot SVG still passes the UNSAFE check, before anything is added;
//   2. every tile is checked: the PNG signature, an IHDR chunk saying
//      256 x 256, at most 256 KB; and the tiles must be a whole grid that
//      covers the frame from (ox, oy), ox and oy in (-256, 0]; else
//      basemap_invalid;
//   3. after composing, the SVG with the tile elements taken out must pass
//      UNSAFE again, it must hold exactly tiles x panels <image elements and
//      as many href, and every href must start data:image/png;base64,;
//   4. so no file path and no http(s) href ever reaches the rasterizer.
// The tiles come as pixel offsets (col, row, ox, oy) and bytes only, never
// tile numbers. A two-panel view gets the same tiles under both panels, each
// panel's tiles clipped to it (a nested <svg> clips its content). A composed
// PNG over MAX_PNG_BYTES is refused (image_too_large) like any other; the
// archetype then draws the plain map.
//
// MAX_PNG_BYTES was set by measuring (AD-R21): the four fixture views, at
// the archetype's frame (700 x 560 a panel), drawn over dense synthetic
// street tiles (test/fixtures/routing-map/tiles/streets-*.png, busier than a
// city-centre tile) on a 4 x 4 or 3 x 3 grid, came to at most
// MEASURED_PNG_BYTES (a two-panel view, darwin/x64, resvg-js 2.6.2; the
// plain views are 12 to 27 KB). The cap is twice that, never over 4 MB
// (MAX_PNG_CEILING), and stays under the Slack upload's own 1 MB check
// (kit/runtime/slack/image.js). The PNG test re-measures the views and fails
// if any grows more than a tenth past the measurement.
//
// Scale (Story 15.18, AD-R29). rasterize and rasterize.streets take an
// optional { scales }: the zooms to try in turn, largest first, each one of
// SCALES (2, 1.5, 1). The PNG is drawn at the first scale whose PNG is at
// most the cap; its size is the image size times the scale, rounded up (as
// resvg sizes it). Over the cap at every scale is image_too_large, and the
// archetype draws the plain map. Plan a route's map passes ROUTE_SCALES
// (2, 1.5, 1); with no scales the PNG is drawn at 1x with the options it
// always had, so Routing's four views are byte for byte what they were.
//
// The cap (PNG_CAP) is the smaller of MAX_PNG_BYTES and SLACK_UPLOAD_BYTES,
// the 1 MB check the Slack upload makes (kit/runtime/slack/image.js
// MAX_PNG_BYTES, unchanged; this directory may not require it, so the PNG
// test asserts the two numbers agree).
//
// Never log the SVG, the PNG or a tile: all are as sensitive as the places
// they show (AD-R12).

const { RoutingFault } = require('../errors');

const MEASURED_PNG_BYTES = 510077;
const MAX_PNG_CEILING = 4 * 1024 * 1024;
const MAX_PNG_BYTES = Math.min(2 * MEASURED_PNG_BYTES, MAX_PNG_CEILING);
const SLACK_UPLOAD_BYTES = 1024 * 1024;
const PNG_CAP = Math.min(MAX_PNG_BYTES, SLACK_UPLOAD_BYTES);
const SCALES = Object.freeze([2, 1.5, 1]);
const ROUTE_SCALES = SCALES;
const TILE_PX = 256;
const MAX_TILE_BYTES = 256 * 1024;
const MAX_TILES = 64;
const DATA_PNG = 'data:image/png;base64,';

const OPTIONS = Object.freeze({
  fitTo: { mode: 'original' },
  font: { loadSystemFonts: false },
  logLevel: 'off',
});
// The options for a scale: 1 is OPTIONS itself; else resvg's zoom.
const optionsAt = (scale) => (scale === 1 ? OPTIONS : { ...OPTIONS, fitTo: { mode: 'zoom', value: scale } });
const sizeAt = (size, scale) => (size ? { width: Math.ceil(size.width * scale), height: Math.ceil(size.height * scale) } : size);

// The scales asked for: none means [1]; else a non-empty list of SCALES,
// largest first, each once.
function checkScales(options) {
  if (options === undefined) return [1];
  if (!isPlainObject(options) || !sameKeys(options, ['scales'])) throw fault('out_of_range', 'scales');
  const { scales } = options;
  const sound = Array.isArray(scales) && scales.length >= 1 && scales.every((v, i) => SCALES.includes(v) && (i === 0 || v < scales[i - 1]));
  if (!sound) throw fault('out_of_range', 'scales');
  return scales;
}

const UNSAFE = /<image|href|xlink|url\(|<use|<style|@import|foreignObject|<script/i;

const fault = (problem, field = 'map image') => new RoutingFault({ field, problem });
const loadResvg = () => require('@resvg/resvg-js');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A PNG's width and height from its IHDR chunk, or null if it is not a PNG.
function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// --- street tiles (Story 15.10, AD-R21) ------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (obj, keys) => Object.keys(obj).length === keys.length && keys.every((k) => Object.hasOwn(obj, k));

// True for bytes that are a 256 x 256 PNG of at most 256 KB, by its header.
function isTile(png) {
  if (!Buffer.isBuffer(png) || png.length > MAX_TILE_BYTES || png.length < 33) return false;
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  if (png.readUInt32BE(8) !== 13 || png.toString('latin1', 12, 16) !== 'IHDR') return false;
  return png.readUInt32BE(16) === TILE_PX && png.readUInt32BE(20) === TILE_PX;
}

// The tiles one panel needs on an axis: the first drawn at offset (in
// (-256, 0]), n of them, covering side pixels with none spare.
const covers = (offset, n, side) => offset <= 0 && offset > -TILE_PX
  && offset + TILE_PX * n >= side && offset + TILE_PX * (n - 1) < side;

// The basemap checked against the frame: [{ x, y, b64 }], x and y the tile's
// top-left pixel in its panel, in row then column order. Anything else is
// basemap_invalid, naming no value.
function checkBasemap(basemap, frame) {
  const invalid = () => fault('basemap_invalid', 'basemap');
  if (!isPlainObject(basemap) || !sameKeys(basemap, ['tiles', 'ox', 'oy'])) throw invalid();
  const { tiles, ox, oy } = basemap;
  if (!Number.isSafeInteger(ox) || !Number.isSafeInteger(oy)) throw invalid();
  if (!Array.isArray(tiles) || tiles.length < 1 || tiles.length > MAX_TILES) throw invalid();
  const at = new Map();
  let cols = 0;
  let rows = 0;
  for (const t of tiles) {
    if (!isPlainObject(t) || !sameKeys(t, ['col', 'row', 'png'])) throw invalid();
    const { col, row, png } = t;
    const inRange = (v) => Number.isSafeInteger(v) && v >= 0 && v < MAX_TILES;
    if (!inRange(col) || !inRange(row)) throw invalid();
    const key = row * MAX_TILES + col;
    if (at.has(key) || !isTile(png)) throw invalid();
    at.set(key, png);
    cols = Math.max(cols, col + 1);
    rows = Math.max(rows, row + 1);
  }
  if (cols * rows !== tiles.length) throw invalid();
  if (!covers(ox, cols, frame.width) || !covers(oy, rows, frame.height)) throw invalid();
  const out = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      out.push({ x: ox + col * TILE_PX, y: oy + row * TILE_PX, b64: at.get(row * MAX_TILES + col).toString('base64') });
    }
  }
  return out;
}

// The opening tag renderSvg writes, on its own first line.
const SVG_OPEN = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="(\d+)" height="(\d+)" viewBox="0 0 \1 \2">\n/;
// Exactly the element composeBasemap writes for a tile, and nothing else.
const TILE_ELEMENT = /<image x="-?\d+" y="-?\d+" width="256" height="256"(?: image-rendering="optimizeSpeed")? href="data:image\/png;base64,[A-Za-z0-9+/]*={0,2}"\/>/g;
// layout.pixelated (Story 15.18): the tiles are enlarged pixel for pixel
// when the map is drawn at 2x or 1.5x, not smoothed: the PNG is about a
// third the size (measured: dense synthetic tiles, the route view at 2x,
// about 1.6 MB smoothed, about 0.6 MB pixel for pixel), and under the 0.6
// wash the streets look much the same.
const PIXELATED = ' image-rendering="optimizeSpeed"';

const tileElement = (t, pixelated) => `<image x="${t.x}" y="${t.y}" width="${TILE_PX}" height="${TILE_PX}"${pixelated ? PIXELATED : ''} href="${DATA_PNG}${t.b64}"/>`;
const count = (text, pattern) => (text.match(pattern) || []).length;

// composeBasemap(svg, basemap, { frame, panels, pixelated? }) -> the SVG with the street
// tiles under the plot: right after the opening tag (so under the wash and
// every mark), one clipped layer per panel, the same tiles in each. svg must
// be renderSvg's output for that frame and number of panels (1 or 2).
function composeBasemap(svg, basemap, layout) {
  if (typeof svg !== 'string') throw fault('not_text');
  if (UNSAFE.test(svg)) throw fault('unsafe_svg');
  const { frame, panels, pixelated = false } = isPlainObject(layout) ? layout : {};
  const whole = (v) => Number.isSafeInteger(v) && v >= 1;
  if (!isPlainObject(frame) || !whole(frame.width) || !whole(frame.height) || (panels !== 1 && panels !== 2) || typeof pixelated !== 'boolean') {
    throw fault('out_of_range', 'layout');
  }
  const open = SVG_OPEN.exec(svg);
  if (!open || Number(open[1]) !== frame.width * panels || Number(open[2]) !== frame.height) throw fault('out_of_range', 'layout');
  const tiles = checkBasemap(basemap, frame);
  const layers = [];
  for (let p = 0; p < panels; p += 1) {
    layers.push(`<svg x="${p * frame.width}" y="0" width="${frame.width}" height="${frame.height}">`);
    for (const t of tiles) layers.push(tileElement(t, pixelated));
    layers.push('</svg>');
  }
  const composed = `${open[0]}${layers.join('\n')}\n${svg.slice(open[0].length)}`;
  // After composing: nothing but the tiles is a reference, and every
  // reference is a PNG data URI written above.
  const want = tiles.length * panels;
  if (UNSAFE.test(composed.replace(TILE_ELEMENT, ''))) throw fault('unsafe_svg');
  const hrefs = [...composed.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  const sound = count(composed, /<image/gi) === want && count(composed, /href/gi) === want
    && count(composed, TILE_ELEMENT) === want && hrefs.length === want && hrefs.every((h) => h.startsWith(DATA_PNG));
  if (!sound) throw fault('basemap_invalid', 'basemap');
  return composed;
}

// --- the rasterizer ------------------------------------------------------------------

// A rasterizer. load() returns the @resvg/resvg-js module; it runs once, on
// the first call, and its failure is remembered (tests pass their own load,
// and may pass a smaller maxBytes).
function createRasterizer({ load = loadResvg, maxBytes = PNG_CAP } = {}) {
  let Resvg = null;
  let failed = false;
  const resvg = () => {
    if (Resvg) return Resvg;
    if (failed) throw fault('renderer_unavailable');
    try {
      const mod = load();
      if (!mod || typeof mod.Resvg !== 'function') throw new TypeError('no Resvg');
      Resvg = mod.Resvg;
      return Resvg;
    } catch {
      failed = true;
      throw fault('renderer_unavailable');
    }
  };

  // Draws an SVG that has passed its checks at one scale: PNG bytes of
  // exactly size x scale, at most maxBytes.
  const drawAt = (svg, size, scale) => {
    const Ctor = resvg();
    let png;
    try {
      png = new Ctor(svg, optionsAt(scale)).render().asPng();
    } catch {
      throw fault('renderer_failed');
    }
    if (!Buffer.isBuffer(png) && !(png instanceof Uint8Array)) throw fault('renderer_failed');
    const bytes = Buffer.from(png);
    if (bytes.length > maxBytes) throw fault('image_too_large');
    const dims = pngSize(bytes);
    const want = sizeAt(size, scale);
    if (!dims || (want && (dims.width !== want.width || dims.height !== want.height))) throw fault('renderer_failed');
    return bytes;
  };

  // The first scale whose PNG fits; image_too_large only after the last.
  const tooLarge = (err) => err instanceof RoutingFault && err.details.problem === 'image_too_large';
  const draw = (svg, size, scales) => {
    const last = scales.length - 1;
    for (let i = 0; i < last; i += 1) {
      try {
        return drawAt(svg, size, scales[i]);
      } catch (err) {
        if (!tooLarge(err)) throw err;
      }
    }
    return drawAt(svg, size, scales[last]);
  };

  // rasterize(svg, { width, height }, { scales }?) -> PNG bytes (a Buffer) of
  // that size times the scale drawn at, at most maxBytes.
  function rasterize(svg, size, options) {
    const scales = checkScales(options);
    if (typeof svg !== 'string') throw fault('not_text');
    if (UNSAFE.test(svg)) throw fault('unsafe_svg');
    return draw(svg, size, scales);
  }

  // rasterize.streets(svg, basemap, { frame, panels }, size, { scales }?):
  // the plot SVG (drawn with base 'streets') over the street tiles, through
  // every check composeBasemap makes; the same size and byte checks as
  // rasterize.
  rasterize.streets = (svg, basemap, layout, size, options) => {
    const scales = checkScales(options);
    return draw(composeBasemap(svg, basemap, layout), size, scales);
  };

  return rasterize;
}

const rasterize = createRasterizer();

module.exports = {
  rasterize, createRasterizer, composeBasemap, isTile, pngSize,
  MAX_PNG_BYTES, MAX_PNG_CEILING, MEASURED_PNG_BYTES, MAX_TILE_BYTES, TILE_PX, DATA_PNG,
  SLACK_UPLOAD_BYTES, PNG_CAP, SCALES, ROUTE_SCALES,
};
