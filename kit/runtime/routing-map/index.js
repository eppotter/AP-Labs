'use strict';

// The route map renderer (Story 15.3, AD-R14): a map model in, an SVG or a
// PNG out. Its own directory, so the routing engine (kit/runtime/routing)
// keeps its dependency rule and never meets the rasterizer. It may require
// only kit/runtime/errors and its own files (engine-boundary.test.js); png.js
// alone requires @resvg/resvg-js, lazily. It takes pixel points from
// mapPoints (AD-R13), never coordinates, and holds no client names.
//
//   renderSvg(view, model, { base }?)    the SVG text (svg.js documents the
//                                        model; base 'plain' or 'streets')
//   renderPng(view, model, { basemap }?) the PNG bytes, checked against
//                                        imageSize; with a basemap (Story
//                                        15.10, AD-R21) the plot is drawn with
//                                        the wash over the street tiles
//   imageSize(view, frame)               { width, height } of the image
//
// Views: compare, change, zone, gap (Routing's four) and route (Story
// 15.13, AD-R28: Plan a route's one panel, the Office marker and a closed
// loop through the stops in the order given). Every view works with and
// without a basemap.
//
// A basemap is { tiles: [{ col, row, png }], ox, oy }: pixel offsets and
// checked PNG bytes only, never tile numbers (png.js composeBasemap). With no
// basemap the PNG is the plain map, byte for byte what it was before street
// tiles. A basemap whose PNG fails (a tile refused, over MAX_PNG_BYTES, the
// rasterizer failing) throws its RoutingFault; the archetype then draws the
// plain map once.
//
// rasterize (png.js) is not exported: the rasterizer can read local files an
// SVG names, so the public entry only rasterizes what renderSvg drew. Only
// png.js's own tests and the smoke script require png.js directly.
//
// The routing-map archetype (Story 15.4) is the one caller; the sdk does not
// export it.

const {
  renderSvg, imageSize, panelCount, VIEWS,
} = require('./svg');
const { rasterize, MAX_PNG_BYTES, ROUTE_SCALES } = require('./png');

// Plan a route's map is drawn at 2x, then 1.5x, then 1x, the first under the
// cap (Story 15.18, AD-R29), its street tiles enlarged pixel for pixel
// (png.js composeBasemap); Routing's four views at 1x, as always.
const scalesOf = (view) => (view === 'route' ? { scales: ROUTE_SCALES } : undefined);

function renderPng(view, model, { basemap = null } = {}) {
  if (basemap === null) {
    const svg = renderSvg(view, model);
    return rasterize(svg, imageSize(view, model.frame), scalesOf(view));
  }
  const svg = renderSvg(view, model, { base: 'streets' });
  const layout = { frame: { width: model.frame.width, height: model.frame.height }, panels: panelCount(view) };
  if (view === 'route') layout.pixelated = true;
  return rasterize.streets(svg, basemap, layout, imageSize(view, model.frame), scalesOf(view));
}

module.exports = {
  renderSvg, renderPng, imageSize, VIEWS, MAX_PNG_BYTES,
};
