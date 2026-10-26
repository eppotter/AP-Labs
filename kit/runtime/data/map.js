'use strict';

// mapPoints, the second governed read of coordinate columns (Story 15.2,
// AD-R13, data-design §3). It returns only pixel positions for the routing
// map: { node, x, y }, integers inside the frame. Never a latitude or a
// longitude.
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
//     or lowered floor is refused, never read as "no limit".
//   - frame is exactly { width, height, padding }, integers within the kit's
//     bounds (width and height 200 to 2000, padding 0 to 200, and the padding
//     leaves room to draw). Anything else is refused.
//   - nodeIds is a list of at most max_points kind-prefixed ids of a declared
//     kind, each once (the same id check travelMatrix uses).
//   - the coordinate columns pass travelMatrix's checks: the shared-name
//     refusal, then the column-type query (INTEGER or BIGINT only).
// Then one static template runs with the profile's forbidden columns minus
// exactly the declared coordinate columns. Inside DuckDB it snaps each
// micro-degree value to the map_grid_e6 grid (to the nearest multiple, half
// away from zero), then fits only the requested nodes' bounding box, each side
// widened around its centre to at least map_min_span_km, to the frame inside
// its padding at one scale for both axes (x east, y south: north up), centred,
// and rounds to whole pixels. A node with no row (an unknown id, or a null
// coordinate) is left out; the rest return in the order asked. Every failure
// is a RoutingFault with fixed words naming mapPoints.

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
// The named parameters the points query declares, and nothing else.
const POINTS_PARAMS = Object.freeze(['node_ids', 'grid_e6', 'min_span_km', 'width', 'height', 'padding']);

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
  return routing;
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

// The one static template. Only checked identifiers and kinds are put in; ids
// and numbers are bound parameters.
function pointsSql(routing) {
  const nodes = travel.nodeSources(routing).map((s) => [
    `  SELECT '${s.kind}:' || CAST(${s.id} AS VARCHAR) AS node, ${s.lat} AS lat_e6, ${s.lon} AS lon_e6`,
    `  FROM ${s.table}`,
    `  WHERE ${s.lat} IS NOT NULL AND ${s.lon} IS NOT NULL`,
  ].join('\n')).join('\n  UNION ALL\n');
  const kmPerDegree = `radians(1) * ${travel.EARTH_RADIUS_KM}`;
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
    // The requested nodes' box: its centre and its sides in km.
    'b AS (',
    '  SELECT (min(lat) + max(lat)) / 2 AS mid_lat, (min(lon) + max(lon)) / 2 AS mid_lon,',
    `    ${kmPerDegree} AS km_lat,`,
    `    ${kmPerDegree} * cos(radians((min(lat) + max(lat)) / 2)) AS km_lon,`,
    '    max(lat) - min(lat) AS deg_lat, max(lon) - min(lon) AS deg_lon',
    '  FROM s',
    '),',
    // One scale for both axes: each side widened to the minimum span.
    'f AS (',
    '  SELECT mid_lat, mid_lon, km_lat, km_lon,',
    '    least(',
    '      (CAST($width AS DOUBLE) - 2 * CAST($padding AS DOUBLE)) / greatest(deg_lon * km_lon, CAST($min_span_km AS DOUBLE)),',
    '      (CAST($height AS DOUBLE) - 2 * CAST($padding AS DOUBLE)) / greatest(deg_lat * km_lat, CAST($min_span_km AS DOUBLE))',
    '    ) AS px_per_km',
    '  FROM b',
    ')',
    'SELECT s.node AS node,',
    '  CAST(round(CAST($width AS DOUBLE) / 2 + (s.lon - f.mid_lon) * f.km_lon * f.px_per_km) AS INTEGER) AS x,',
    '  CAST(round(CAST($height AS DOUBLE) / 2 - (s.lat - f.mid_lat) * f.km_lat * f.px_per_km) AS INTEGER) AS y',
    'FROM s CROSS JOIN f',
    'ORDER BY node',
  ].join('\n');
}

// The bound values for the points query.
function pointsParams(nodeIds, frame, routing) {
  return {
    node_ids: nodeIds.join(','),
    grid_e6: routing.map_grid_e6,
    min_span_km: routing.map_min_span_km,
    width: frame.width,
    height: frame.height,
    padding: frame.padding,
  };
}

// DuckDB's rows as fresh frozen { node, x, y }, in the order asked. A node
// with no row is left out (the caller treats it as a fault, AD-R16). A row
// for a node not asked for, a repeated node, or a position outside the frame
// is refused by fixed words, never by value.
function points(rows, nodeIds, frame) {
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
  return nodeIds.filter((id) => at.has(id)).map((id) => at.get(id));
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

// The pixel positions of nodeIds in frame, read by data's own mapPoints (the
// one createData attached). Resolves [{ node, x, y }]; rejects only with a
// fixed-text RoutingFault. A data object without one is refused, never read
// some other way.
function mapPoints(data, nodeIds, frame) {
  const read = data && typeof data === 'object' ? READS.get(data) : undefined;
  if (!read) return Promise.reject(fault(FIELD, 'data_unavailable'));
  return read(nodeIds, frame);
}

module.exports = {
  mapPoints, attach,
  routingOf, checkFrame, checkIds, pointsSql, pointsParams, points, faultFor,
  FIELD, FRAME_BOUNDS, POINTS_PARAMS, MAP_GRID_FLOOR_E6, MAP_MIN_SPAN_FLOOR_KM,
};
