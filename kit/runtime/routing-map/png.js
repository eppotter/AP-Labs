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
// a result of any other size is refused (renderer_failed). A PNG over 1 MB
// is refused (image_too_large). Same SVG, same bytes on one machine; no
// cross-platform hash is promised.
//
// Defence in depth: the rasterizer's default image loader can read a local
// file an <image href> names. renderSvg never draws one, and index.js only
// rasterizes renderSvg's output, but rasterize also refuses (unsafe_svg) any
// SVG holding a reference or style: <image, href, xlink, url(, <use, <style,
// @import, foreignObject or <script, in any case.
//
// Never log the SVG or the PNG: both are as sensitive as the places they
// show (AD-R12).

const { RoutingFault } = require('../errors');

const MAX_PNG_BYTES = 1024 * 1024;
const OPTIONS = Object.freeze({
  fitTo: { mode: 'original' },
  font: { loadSystemFonts: false },
  logLevel: 'off',
});

const UNSAFE = /<image|href|xlink|url\(|<use|<style|@import|foreignObject|<script/i;

const fault = (problem) => new RoutingFault({ field: 'map image', problem });
const loadResvg = () => require('@resvg/resvg-js');

// A rasterizer. load() returns the @resvg/resvg-js module; it runs once, on
// the first call, and its failure is remembered (tests pass their own load).
function createRasterizer({ load = loadResvg } = {}) {
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

  // rasterize(svg, { width, height }) -> PNG bytes (a Buffer) of exactly that
  // size, at most MAX_PNG_BYTES.
  return function rasterize(svg, size) {
    if (typeof svg !== 'string') throw fault('not_text');
    if (UNSAFE.test(svg)) throw fault('unsafe_svg');
    const Ctor = resvg();
    let image;
    let png;
    try {
      image = new Ctor(svg, OPTIONS).render();
      png = image.asPng();
    } catch {
      throw fault('renderer_failed');
    }
    if (!Buffer.isBuffer(png) && !(png instanceof Uint8Array)) throw fault('renderer_failed');
    const bytes = Buffer.from(png);
    if (bytes.length > MAX_PNG_BYTES) throw fault('image_too_large');
    const dims = pngSize(bytes);
    if (!dims || (size && (dims.width !== size.width || dims.height !== size.height))) throw fault('renderer_failed');
    return bytes;
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A PNG's width and height from its IHDR chunk, or null if it is not a PNG.
function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const rasterize = createRasterizer();

module.exports = { rasterize, createRasterizer, pngSize, MAX_PNG_BYTES };
