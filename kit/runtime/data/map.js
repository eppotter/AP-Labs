'use strict';

// mapPoints, the second governed read of coordinate columns (Story 15.2,
// AD-R13; Web Mercator and the tile mosaic, Story 15.8, AD-R20; data-design
// §3). It returns only pixel positions for the routing map, and the street
// tiles that would lie under them:
//   { points: [{ node, x, y }], mosaic: { z, tx0, ty0, cols, rows, ox, oy } | null }
// all integers. Never a latitude or a longitude.
//
// Who may call it (AD-R13, F1): it is NOT a key of the data object that
// modules, adapters and jobs receive (that object's keys are fixed by 13.2's
// exact-keys test), and kit/runtime/sdk does not export it. The query runner
// (./index) builds the read inside createData's closure, so it shares run()'s
// guard, 30 s time limit and redaction, and attaches it to the data object it
// returns through a private side table (attach, below). The one way to reach
// it is mapPoints(data, nodeIds, frame) from this file, and only
// kit/runtime/archetypes/routing-map/** and kit/runtime/data/** may require
// this file (engine-boundary test). This file opens nothing and imports no
// DuckDB: it requires only ./travel (the shared source, column-type, guard and
// fault helpers) and kit/runtime/errors.
//
// The read, before it runs:
//   - routing on, and its map keys filled and at or above their floors:
//     max_points >= 1, map_grid_e6 >= 2000, map_min_span_km >= 5 (a loaded
//     profile always has them; kit/lib/profile ROUTING_DEFAULTS). A missing
//     or lowered floor is refused, never read as "no limit". The highest zoom
//     is routing.basemap.max_zoom when a basemap block is set (a whole number,
//     0 to 19), else 19.
//   - frame is exactly { width, height, padding }, integers within the kit's
//     bounds (width and height 200 to 2000, padding 0 to 200, and the padding
//     leaves room to draw). Anything else is refused.
//   - nodeIds is a list of at most max_points kind-prefixed ids of a declared
//     kind, each once (the same id check travelMatrix uses).
//   - the coordinate columns pass travelMatrix's checks: the shared-name
//     refusal, then the column-type query (INTEGER or BIGINT only).
// Then one static template runs with the profile's forbidden columns minus
// exactly the declared coordinate columns. Inside DuckDB it:
//   1. snaps each micro-degree value to the map_grid_e6 grid (to the nearest
//      multiple, half away from zero): nothing after this sees a finer value;
//   2. takes only the requested nodes' box and widens it around its centre to
//      at least map_min_span_km each way (north-south in degrees of latitude;
//      east-west at the box's poleward edge, where a degree of longitude is
//      shortest, so the whole box spans the floor);
//   3. projects Web Mercator (the world as a 256 * 2^z pixel square, x east,
//      y south: north up) and picks the largest whole zoom z <= max_zoom at
//      which the widened box fits inside the frame's padding (with one pixel
//      kept for rounding). Tiles are drawn at their native 256 px, never
//      scaled, so the map only zooms out from the box: the frame may show up
//      to twice the box each way, never less than the floor;
//   4. centres the box (its middle longitude and latitude) in the frame on a
//      whole-pixel corner, so a lone node is centred and each marker
//      and the tiles under it share one pixel grid, and returns per node its
//      pixel and the mosaic: tiles tx0..tx0+cols-1 by ty0..ty0+rows-1 at zoom
//      z, the first drawn at (ox, oy), ox and oy in (-256, 0], covering the
//      frame. The mosaic columns are null when the widened box reaches beyond
//      ±85.0511° (Web Mercator's edge) or across the antimeridian, or when the
//      frame's tiles fall off the world.
// Here the rows are checked: the mosaic columns must be the same on every
// row (else query_failed) and cover the frame; more than MAX_TILES tiles is
// no mosaic. Tile numbers are rough locations (about 2 km): process memory
// only, never logged, passed only to the tile fetcher (AD-R19, R20). A node
// with no row (an unknown id, or a null coordinate) is left out; the rest
// return in the order asked. Every failure is a RoutingFault with fixed words
// naming mapPoints.

const { RoutingFault } = require('../errors');
const travel = require('./travel');

const FIELD = 'mapPoints';
// The floors GRD-002 is signed against (AD-R10, AD-R12): a profile may only
// coarsen the grid or widen the minimum span.
const MAP_GRID_FLOOR_E6 = 2000;
const MAP_MIN_SPAN_FLOOR_KM = 5;
// The frame's bounds, in pixels.
const FRAME_BOUNDS = Object.freeze({
  width: Object.freeze([200, 2000]),
  height: Object.freeze([200, 2000]),
  padding: Object.freeze([0, 200]),
});
// Web Mercator (AD-R20): the tile size, the zoom range (OpenStreetMap's), the
// most tiles one map may need, and the latitude where the square world ends
// (atan(sinh(pi)) in degrees, the ±85.0511° of the architecture).
const TILE_PX = 256;
const MAX_ZOOM = 19;
const MAX_TILES = 64;
const MAX_LAT = 85.0511287798066;
// The mosaic's keys, in the select list's order after node, x, y.
const MOSAIC_KEYS = Object.freeze(['z', 'tx0', 'ty0', 'cols', 'rows', 'ox', 'oy']);
// The fixed select list (AD-R20), every column INTEGER.
const SELECT_LIST = Object.freeze(['node', 'x', 'y', ...MOSAIC_KEYS]);
// The named parameters the points query declares, and nothing else.
const POINTS_PARAMS = Object.freeze(['node_ids', 'grid_e6', 'min_span_km', 'max_zoom', 'width', 'height', 'padding']);

const fault = (field, problem) => new RoutingFault({ field, problem });
const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

// The profile's routing block with its map keys checked.
function routingOf(profile) {
  const routing = travel.routingOf(profile);
  const ok = {
    max_points: (v) => Number.isSafeInteger(v) && v >= 1,
    map_grid_e6: (v) => Number.isSafeInteger(v) && v >= MAP_GRID_FLOOR_E6,
    map_min_span_km: (v) => Number.isFinite(v) && v >= MAP_MIN_SPAN_FLOOR_KM,
  };
  for (const [key, check] of Object.entries(ok)) if (!check(routing[key])) throw fault(`routing.${key}`, 'out_of_range');
  maxZoomOf(routing);
  return routing;
}

// The highest zoom: routing.basemap.max_zoom when a basemap block sets it
// (Story 15.9 adds the key to the schema), else MAX_ZOOM. A value that is not
// a whole number from 0 to 19 is refused, never read as "no limit".
function maxZoomOf(routing) {
  const basemap = routing.basemap;
  if (basemap === undefined || basemap === null) return MAX_ZOOM;
  if (!isPlainObject(basemap)) throw fault('routing.basemap', 'not_object');
  const v = basemap.max_zoom;
  if (v === undefined) return MAX_ZOOM;
  if (!Number.isSafeInteger(v) || v < 0 || v > MAX_ZOOM) throw fault('routing.basemap.max_zoom', 'out_of_range');
  return v;
}

// The frame checked. Returns a fresh frozen { width, height, padding }.
function checkFrame(frame) {
  if (!isPlainObject(frame)) throw fault('frame', 'not_object');
  for (const key of Object.keys(frame)) if (!Object.hasOwn(FRAME_BOUNDS, key)) throw fault(`frame.${key}`, 'out_of_range');
  for (const [key, [lo, hi]] of Object.entries(FRAME_BOUNDS)) {
    const v = frame[key];
    if (v === undefined) throw fault(`frame.${key}`, 'missing');
    if (!Number.isSafeInteger(v)) throw fault(`frame.${key}`, 'not_integer');
    if (v < lo || v > hi) throw fault(`frame.${key}`, 'out_of_range');
  }
  const { width, height, padding } = frame;
  if (2 * padding >= Math.min(width, height)) throw fault('frame.padding', 'out_of_range');
  return Object.freeze({ width, height, padding });
}

// nodeIds checked: at most max_points, then each a kind-prefixed id of a
// declared kind, once.
function checkIds(nodeIds, routing) {
  if (!Array.isArray(nodeIds)) throw fault('nodeIds', 'not_list');
  if (nodeIds.length > routing.max_points) throw fault('nodeIds', 'out_of_range');
  travel.checkNodeList('nodeIds', nodeIds, routing);
}

// Web Mercator's y for a latitude column, the world as 0 (north edge) to 1
// (south edge). The latitude is held inside ±MAX_LAT first, so the pole never
// reaches tan; a box that goes past it has no mosaic.
const mercY = (lat) => {
  const held = `radians(least(greatest(${lat}, -${MAX_LAT}), ${MAX_LAT}))`;
  return `(1 - ln(tan(${held}) + 1 / cos(${held})) / pi()) / 2`;
};
const mercX = (lon) => `(${lon} + 180) / 360`;
const D = (param) => `CAST($${param} AS DOUBLE)`;

// The one static template. Only checked identifiers and kinds are put in; ids
// and numbers are bound parameters.
function pointsSql(routing) {
  const nodes = travel.nodeSources(routing).map((s) => [
    `  SELECT '${s.kind}:' || CAST(${s.id} AS VARCHAR) AS node, ${s.lat} AS lat_e6, ${s.lon} AS lon_e6`,
    `  FROM ${s.table}`,
    `  WHERE ${s.lat} IS NOT NULL AND ${s.lon} IS NOT NULL`,
  ].join('\n')).join('\n  UNION ALL\n');
  const kmPerDegree = `radians(1) * ${travel.EARTH_RADIUS_KM}`;
  const inner = (side) => `${D(side)} - 2 * ${D('padding')} - 1`;
  const mosaic = (expr, name) => `  CASE WHEN k.drawn THEN CAST(${expr} AS INTEGER) END AS ${name}`;
  return [
    'WITH nodes AS (',
    nodes,
    '),',
    // Snapped to the grid first: nothing after this sees a finer position.
    's AS (',
    '  SELECT node,',
    '    round(CAST(lat_e6 AS DOUBLE) / $grid_e6) * $grid_e6 / 1e6 AS lat,',
    '    round(CAST(lon_e6 AS DOUBLE) / $grid_e6) * $grid_e6 / 1e6 AS lon',
    '  FROM nodes',
    "  WHERE list_contains(string_split($node_ids, ','), node)",
    '),',
    // The requested nodes' box: its centre, its sides in degrees, the
    // north-south side widened to the minimum span.
    'b AS (',
    '  SELECT (min(lat) + max(lat)) / 2 AS mid_lat, (min(lon) + max(lon)) / 2 AS mid_lon,',
    `    greatest(max(lat) - min(lat), ${D('min_span_km')} / (${kmPerDegree})) AS deg_lat,`,
    '    max(lon) - min(lon) AS deg_lon',
    '  FROM s',
    '),',
    // The east-west side widened at the box's poleward edge.
    'w AS (',
    '  SELECT mid_lat - deg_lat / 2 AS lat_lo, mid_lat + deg_lat / 2 AS lat_hi, mid_lat, mid_lon,',
    `    greatest(deg_lon, ${D('min_span_km')} / (${kmPerDegree}`,
    `      * cos(radians(least(greatest(abs(mid_lat - deg_lat / 2), abs(mid_lat + deg_lat / 2)), ${MAX_LAT}))))) AS deg_lon`,
    '  FROM b',
    '),',
    // The widened box in Web Mercator, the world as 1 x 1, and its centre
    // line (the middle latitude's y: Mercator stretches poleward, so the box
    // is not even about it); on_world when it stays inside ±MAX_LAT and does
    // not cross the antimeridian.
    'm AS (',
    `  SELECT ${mercX('mid_lon - deg_lon / 2')} AS mx_lo, ${mercX('mid_lon + deg_lon / 2')} AS mx_hi,`,
    `    ${mercY('lat_hi')} AS my_lo,`,
    `    ${mercY('lat_lo')} AS my_hi,`,
    `    ${mercY('mid_lat')} AS my_mid,`,
    `    lat_lo >= -${MAX_LAT} AND lat_hi <= ${MAX_LAT} AND mid_lon - deg_lon / 2 >= -180 AND mid_lon + deg_lon / 2 <= 180 AS on_world`,
    '  FROM w',
    '),',
    // The largest whole zoom, at most max_zoom, at which the box, centred on
    // its middle latitude, fits inside the padding, one pixel kept for
    // rounding.
    'z AS (',
    `  SELECT mx_lo, mx_hi, my_mid, on_world, least(${D('max_zoom')}, floor(log2(least(`,
    `    (${inner('width')}) / (${TILE_PX} * greatest(mx_hi - mx_lo, 1e-15)),`,
    `    (${inner('height')}) / (${TILE_PX} * greatest(2 * greatest(my_hi - my_mid, my_mid - my_lo), 1e-15))`,
    '  )))) AS zoom',
    '  FROM m',
    '),',
    // The frame's top-left corner in whole world pixels: the box's middle
    // longitude and middle latitude at the frame's centre, so a lone node is
    // centred.
    'o AS (',
    `  SELECT zoom, on_world, ${TILE_PX} * pow(2, zoom) AS world,`,
    `    round((mx_lo + mx_hi) / 2 * ${TILE_PX} * pow(2, zoom) - ${D('width')} / 2) AS left_px,`,
    `    round(my_mid * ${TILE_PX} * pow(2, zoom) - ${D('height')} / 2) AS top_px`,
    '  FROM z',
    '),',
    // The tiles under the frame: the first tile's number and its offset.
    't AS (',
    `  SELECT zoom, on_world, world, left_px, top_px, floor(left_px / ${TILE_PX}) AS tx0, floor(top_px / ${TILE_PX}) AS ty0 FROM o`,
    '),',
    'k AS (',
    `  SELECT zoom, world, left_px, top_px, tx0, ty0, tx0 * ${TILE_PX} - left_px AS ox, ty0 * ${TILE_PX} - top_px AS oy,`,
    `    ceil((${D('width')} - (tx0 * ${TILE_PX} - left_px)) / ${TILE_PX}) AS cols,`,
    `    ceil((${D('height')} - (ty0 * ${TILE_PX} - top_px)) / ${TILE_PX}) AS rows,`,
    `    on_world AND zoom >= 0 AND tx0 >= 0 AND ty0 >= 0`,
    `      AND tx0 + ceil((${D('width')} - (tx0 * ${TILE_PX} - left_px)) / ${TILE_PX}) <= pow(2, zoom)`,
    `      AND ty0 + ceil((${D('height')} - (ty0 * ${TILE_PX} - top_px)) / ${TILE_PX}) <= pow(2, zoom) AS drawn`,
    '  FROM t',
    ')',
    'SELECT s.node AS node,',
    `  CAST(round(${mercX('s.lon')} * k.world - k.left_px) AS INTEGER) AS x,`,
    `  CAST(round(${mercY('s.lat')} * k.world - k.top_px) AS INTEGER) AS y,`,
    mosaic('k.zoom', 'z') + ',',
    mosaic('k.tx0', 'tx0') + ',',
    mosaic('k.ty0', 'ty0') + ',',
    mosaic('k.cols', 'cols') + ',',
    mosaic('k.rows', 'rows') + ',',
    mosaic('k.ox', 'ox') + ',',
    mosaic('k.oy', 'oy'),
    'FROM s CROSS JOIN k',
    'ORDER BY node',
  ].join('\n');
}

// The bound values for the points query.
function pointsParams(nodeIds, frame, routing) {
  return {
    node_ids: nodeIds.join(','),
    grid_e6: routing.map_grid_e6,
    min_span_km: routing.map_min_span_km,
    max_zoom: maxZoomOf(routing),
    width: frame.width,
    height: frame.height,
    padding: frame.padding,
  };
}

// The result for no rows: no points, no mosaic.
const empty = () => Object.freeze({ points: Object.freeze([]), mosaic: null });

// The mosaic the rows agree on, checked: null when the query found none or
// it needs more than MAX_TILES tiles. Columns that differ between rows, a
// part-null mosaic, or one that does not cover the frame exactly from tiles
// on the world is refused by fixed words, never by value.
function mosaicOf(rows, frame, maxZoom) {
  const [first] = rows;
  for (const r of rows) {
    if (MOSAIC_KEYS.some((k) => !Object.is(r[k], first[k]))) throw fault(FIELD, 'query_failed');
  }
  const values = MOSAIC_KEYS.map((k) => first[k]);
  if (values.every((v) => v === null)) return null;
  if (!values.every((v) => Number.isSafeInteger(v))) throw fault(FIELD, 'query_failed');
  const m = Object.fromEntries(MOSAIC_KEYS.map((k, i) => [k, values[i]]));
  const span = 2 ** m.z;
  const tilesFit = (t0, n, offset, side) => t0 >= 0 && n >= 1 && t0 + n <= span
    && offset <= 0 && offset > -TILE_PX
    && offset + TILE_PX * n >= side && offset + TILE_PX * (n - 1) < side;
  const sound = m.z >= 0 && m.z <= maxZoom
    && tilesFit(m.tx0, m.cols, m.ox, frame.width) && tilesFit(m.ty0, m.rows, m.oy, frame.height);
  if (!sound) throw fault(FIELD, 'query_failed');
  if (m.cols * m.rows > MAX_TILES) return null;
  return Object.freeze(m);
}

// DuckDB's rows as a fresh frozen { points, mosaic }: points [{ node, x, y }]
// in the order asked. A node with no row is left out (the caller treats it
// as a fault, AD-R16). A row for a node not asked for, a repeated node, or a
// position outside the frame is refused by fixed words, never by value.
function result(rows, nodeIds, frame, maxZoom = MAX_ZOOM) {
  const asked = new Set(nodeIds);
  const at = new Map();
  for (const r of rows) {
    if (!asked.has(r.node)) throw fault(FIELD, 'query_failed');
    if (at.has(r.node)) throw fault(FIELD, 'duplicate');
    const inside = Number.isSafeInteger(r.x) && Number.isSafeInteger(r.y)
      && r.x >= 0 && r.x <= frame.width && r.y >= 0 && r.y <= frame.height;
    if (!inside) throw fault(FIELD, 'query_failed');
    at.set(r.node, Object.freeze({ node: r.node, x: r.x, y: r.y }));
  }
  if (!rows.length) return empty();
  const mosaic = mosaicOf(rows, frame, maxZoom);
  const points = Object.freeze(nodeIds.filter((id) => at.has(id)).map((id) => at.get(id)));
  return Object.freeze({ points, mosaic });
}

const faultFor = (err) => travel.faultFor(err, FIELD);

// The data objects createData made, each with its own mapPoints read. Private
// to this file: a WeakMap, so it holds no data object alive and lists none.
const READS = new WeakMap();

// Called by ./index once per createData, on the frozen object it returns.
// Each object takes one read, once.
function attach(data, read) {
  if (!data || typeof data !== 'object' || !Object.isFrozen(data) || typeof read !== 'function' || READS.has(data)) {
    throw new TypeError('mapPoints can be attached once, to a frozen data object');
  }
  READS.set(data, read);
}

// The pixel positions of nodeIds in frame and the mosaic under them, read by
// data's own mapPoints (the one createData attached). Resolves
// { points, mosaic }; rejects only with a fixed-text RoutingFault. A data
// object without one is refused, never read some other way.
function mapPoints(data, nodeIds, frame) {
  const read = data && typeof data === 'object' ? READS.get(data) : undefined;
  if (!read) return Promise.reject(fault(FIELD, 'data_unavailable'));
  return read(nodeIds, frame);
}

module.exports = {
  mapPoints, attach,
  routingOf, maxZoomOf, checkFrame, checkIds, pointsSql, pointsParams, result, empty, faultFor,
  FIELD, FRAME_BOUNDS, POINTS_PARAMS, SELECT_LIST, MOSAIC_KEYS, MAP_GRID_FLOOR_E6, MAP_MIN_SPAN_FLOOR_KM,
  TILE_PX, MAX_ZOOM, MAX_TILES, MAX_LAT,
};
