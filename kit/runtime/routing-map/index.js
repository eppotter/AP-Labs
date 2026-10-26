'use strict';

// The route map renderer (Story 15.3, AD-R14): a map model in, an SVG or a
// PNG out. Its own directory, so the routing engine (kit/runtime/routing)
// keeps its dependency rule and never meets the rasterizer. It may require
// only kit/runtime/errors and its own files (engine-boundary.test.js); png.js
// alone requires @resvg/resvg-js, lazily. It takes pixel points from
// mapPoints (AD-R13), never coordinates, and holds no client names.
//
//   renderSvg(view, model)   the SVG text (svg.js documents the model)
//   renderPng(view, model)   the PNG bytes, checked against imageSize
//   imageSize(view, frame)   { width, height } of the image for a frame
//   rasterize(svg, size)     SVG text to PNG bytes (png.js)
//
// The routing-map archetype (Story 15.4) is the one caller; the sdk does not
// export it.

const { renderSvg, imageSize, VIEWS } = require('./svg');
const { rasterize, MAX_PNG_BYTES } = require('./png');

function renderPng(view, model) {
  const svg = renderSvg(view, model);
  return rasterize(svg, imageSize(view, model.frame));
}

module.exports = { renderSvg, renderPng, imageSize, rasterize, VIEWS, MAX_PNG_BYTES };
