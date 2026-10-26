'use strict';

// travelMatrix's template and checks (Story 13.2, AD-R9, data-design §3): the
// first governed read of coordinate columns (mapPoints, ./map, is the second;
// AD-R13). Pure helpers only: this file opens nothing, runs nothing and
// imports no DuckDB. The query runner (kit/runtime/data/index.js) builds
// travelMatrix inside createData's closure from these, so it shares run()'s
// guard, 30 s time limit and redaction. That file and ./map (which reuses the
// source, column-type, guard and fault helpers) are the only ones that may
// require this one (engine-boundary test).
//
// The read:
//   - the profile's routing.coordinates names, per node kind, the table, its id
//     column and its two micro-degree columns (lat_column, lon_column). Each
//     name passes IDENTIFIER again here, whatever the schema said, before it
//     is put into the one static template below.
//   - before the matrix query, the column-type query checks each declared
//     coordinate column exists and is INTEGER or BIGINT, so declaring
//     street_address (text) is refused.
//   - the guard runs with the profile's forbidden columns minus exactly the
//     declared coordinate columns (travelForbidden); every other forbidden
//     column still applies, the id columns included.
//   - node ids are kind-prefixed (<kind>:<id>) and reach DuckDB only as two
//     bound parameters ($from_ids, $to_ids: the ids joined by commas; an id
//     can hold no comma). The rectangle is capped at routing.max_pairs.
//   - minutes = haversine km x detour_factor / speed_kmh x 60, rounded to
//     1e-6, then up to a whole minute, never below min_travel_minutes; all of
//     it inside DuckDB. The select list is fixed: from_node, to_node, minutes
//     (INTEGER). No coordinate ever comes back to JS.
//   - every failure is a RoutingFault with fixed words (faultFor): never
//     DuckDB's text, the SQL, a path or a value.

const { RoutingFault, DataUnavailable } = require('../errors');

// A plain lower-case SQL name (the profile schema's sqlIdentifier).
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
// A node kind (the profile schema's kind) and a node id after the prefix.
const KIND = /^[a-z][a-z0-9_]{0,31}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COORDINATE_TYPES = Object.freeze(['INTEGER', 'BIGINT']);
// Mean Earth radius (IUGG), in km.
const EARTH_RADIUS_KM = 6371.0088;
// The named parameters the matrix query declares, and nothing else.
const MATRIX_PARAMS = Object.freeze(['from_ids', 'to_ids', 'speed_kmh', 'detour_factor', 'min_minutes']);
// The column-type query: no parameters, no forbidden column, only names and types.
const COLUMN_TYPES_SQL = [
  'SELECT table_name, column_name, data_type',
  'FROM information_schema.columns',
  'WHERE table_catalog = current_database() AND table_schema = current_schema()',
].join('\n');
const FIELD = 'travelMatrix';

const fault = (field, problem) => new RoutingFault({ field, problem });

// The profile's routing block, or a refusal when routing is off.
function routingOf(profile) {
  const routing = profile && profile.routing;
  if (!routing || !routing.coordinates || !Array.isArray(routing.coordinates.nodes)) throw fault('routing', 'routing_off');
  // A loaded profile has these filled (kit/lib/profile ROUTING_DEFAULTS); a
  // missing cap or floor is refused, never read as "no limit".
  const ok = {
    max_pairs: (v) => Number.isSafeInteger(v) && v >= 1,
    min_travel_minutes: (v) => Number.isSafeInteger(v) && v >= 0,
    speed_kmh: (v) => Number.isFinite(v) && v > 0,
    detour_factor: (v) => Number.isFinite(v) && v >= 1,
  };
  for (const [key, check] of Object.entries(ok)) if (!check(routing[key])) throw fault(`routing.${key}`, 'out_of_range');
  return routing;
}

// Each node source, its names checked again against IDENTIFIER and KIND.
function nodeSources(routing) {
  return routing.coordinates.nodes.map((n, i) => {
    const at = `routing.coordinates.nodes[${i}]`;
    if (typeof n.kind !== 'string' || !KIND.test(n.kind)) throw fault(`${at}.kind`, 'bad_id');
    for (const key of ['table', 'id_column', 'lat_column', 'lon_column']) {
      if (typeof n[key] !== 'string' || !IDENTIFIER.test(n[key])) throw fault(`${at}.${key}`, 'bad_id');
    }
    return Object.freeze({ kind: n.kind, table: n.table, id: n.id_column, lat: n.lat_column, lon: n.lon_column, at });
  });
}

// The declared coordinate columns, as "table.column".
function coordinateColumns(routing) {
  return nodeSources(routing).flatMap((s) => [`${s.table}.${s.lat}`, `${s.table}.${s.lon}`]);
}

// The forbidden list travelMatrix runs under: the profile's, minus exactly the
// declared coordinate columns (table.column pairs). Nothing else is ever
// dropped. The guard (kit/runtime/sql) matches a forbidden column by its bare
// name in any table, so the exception cannot be scoped to a table there: when
// another table also forbids a column with a declared coordinate column's
// name, travelMatrix is refused outright (shared_column_name, before any
// query), so that column stays forbidden everywhere (review finding, PR #200).
function travelForbidden(forbidden, routing) {
  const drop = new Set(coordinateColumns(routing));
  for (const s of nodeSources(routing)) {
    for (const [key, column] of [['lat_column', s.lat], ['lon_column', s.lon]]) {
      if (forbidden.some((fc) => !drop.has(fc) && fc.split('.')[1] === column)) throw fault(`${s.at}.${key}`, 'shared_column_name');
    }
  }
  return forbidden.filter((fc) => !drop.has(fc));
}

// The column-type query's rows checked against the declared columns: each must
// exist in its table and be INTEGER or BIGINT. Throws RoutingFault naming the
// profile key, never the column's type or content.
function checkColumnTypes(rows, routing) {
  const types = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, String(r.data_type).toUpperCase()]));
  for (const s of nodeSources(routing)) {
    for (const [key, column] of [['lat_column', s.lat], ['lon_column', s.lon]]) {
      if (!COORDINATE_TYPES.includes(types.get(`${s.table}.${column}`))) throw fault(`${s.at}.${key}`, 'not_coordinate_column');
    }
  }
}

// The one static template. Only checked identifiers and kinds are put in; ids
// and numbers are bound parameters.
function matrixSql(routing) {
  const nodes = nodeSources(routing).map((s) => [
    `  SELECT '${s.kind}:' || CAST(${s.id} AS VARCHAR) AS node,`,
    `    CAST(${s.lat} AS DOUBLE) / 1e6 AS lat, CAST(${s.lon} AS DOUBLE) / 1e6 AS lon`,
    `  FROM ${s.table}`,
    `  WHERE ${s.lat} IS NOT NULL AND ${s.lon} IS NOT NULL`,
  ].join('\n')).join('\n  UNION ALL\n');
  return [
    'WITH nodes AS (',
    nodes,
    '),',
    "f AS (SELECT node, lat, lon FROM nodes WHERE list_contains(string_split($from_ids, ','), node)),",
    "t AS (SELECT node, lat, lon FROM nodes WHERE list_contains(string_split($to_ids, ','), node)),",
    'd AS (',
    '  SELECT f.node AS from_node, t.node AS to_node,',
    `    2 * ${EARTH_RADIUS_KM} * asin(least(1.0, sqrt(`,
    '      power(sin(radians(t.lat - f.lat) / 2), 2)',
    '      + cos(radians(f.lat)) * cos(radians(t.lat)) * power(sin(radians(t.lon - f.lon) / 2), 2)',
    '    ))) AS km',
    '  FROM f CROSS JOIN t',
    ')',
    'SELECT from_node, to_node,',
    '  CAST(greatest($min_minutes, ceil(round(km * $detour_factor / $speed_kmh * 60, 6))) AS INTEGER) AS minutes',
    'FROM d',
    'ORDER BY from_node, to_node',
  ].join('\n');
}

// One list of node ids checked, named name in a refusal: a list of kind-
// prefixed ids of a declared kind, each once. Shared with mapPoints (./map).
function checkNodeList(name, ids, routing) {
  const kinds = new Set(nodeSources(routing).map((s) => s.kind));
  if (!Array.isArray(ids)) throw fault(name, 'not_list');
  const seen = new Set();
  ids.forEach((id, i) => {
    const at = `${name}[${i}]`;
    if (typeof id !== 'string') throw fault(at, 'not_text');
    const sep = id.indexOf(':');
    if (sep === -1 || !kinds.has(id.slice(0, sep)) || !NODE_ID.test(id.slice(sep + 1))) throw fault(at, 'bad_node');
    if (seen.has(id)) throw fault(at, 'duplicate');
    seen.add(id);
  });
}

// fromIds and toIds checked: lists of kind-prefixed ids of a declared kind,
// no repeats within a list, at most max_pairs pairs. Returns them as given.
function checkIds(fromIds, toIds, routing) {
  checkNodeList('fromIds', fromIds, routing);
  checkNodeList('toIds', toIds, routing);
  if (fromIds.length * toIds.length > routing.max_pairs) throw fault(FIELD, 'too_many_pairs');
}

// The bound values for the matrix query.
function matrixParams(fromIds, toIds, routing) {
  return {
    from_ids: fromIds.join(','),
    to_ids: toIds.join(','),
    speed_kmh: routing.speed_kmh,
    detour_factor: routing.detour_factor,
    min_minutes: routing.min_travel_minutes,
  };
}

// DuckDB's rows as the full from x to rectangle, in the order asked, each a
// fresh { from_node, to_node, minutes }. A node with no row (unknown id or a
// null coordinate) is refused by its list position, never its value.
function rectangle(rows, fromIds, toIds) {
  const minutes = new Map();
  for (const r of rows) {
    if (!Number.isSafeInteger(r.minutes) || r.minutes < 0) throw fault(FIELD, 'query_failed');
    const key = `${r.from_node}\u0000${r.to_node}`;
    if (minutes.has(key)) throw fault(FIELD, 'duplicate');
    minutes.set(key, r.minutes);
  }
  const froms = new Set(rows.map((r) => r.from_node));
  const tos = new Set(rows.map((r) => r.to_node));
  fromIds.forEach((id, i) => { if (!froms.has(id)) throw fault(`fromIds[${i}]`, 'no_position'); });
  toIds.forEach((id, i) => { if (!tos.has(id)) throw fault(`toIds[${i}]`, 'no_position'); });
  const out = [];
  for (const from of fromIds) {
    for (const to of toIds) {
      const m = minutes.get(`${from}\u0000${to}`);
      if (m === undefined) throw fault(FIELD, 'no_position');
      out.push(Object.freeze({ from_node: from, to_node: to, minutes: m }));
    }
  }
  return out;
}

// Any error from the read as a fixed-text RoutingFault naming field (the
// read: travelMatrix here, mapPoints from ./map). Nothing of the original
// (DuckDB's text, the SQL, a path, a value) is carried.
function faultFor(err, field = FIELD) {
  if (err instanceof RoutingFault) return err;
  if (err instanceof DataUnavailable) return fault(field, 'data_unavailable');
  if (err && err.code === 'QUERY_REFUSED') return fault(field, 'query_refused');
  return fault(field, 'query_failed');
}

module.exports = {
  routingOf, nodeSources, checkNodeList, coordinateColumns, travelForbidden, checkColumnTypes, matrixSql, checkIds, matrixParams, rectangle, faultFor,
  COLUMN_TYPES_SQL, MATRIX_PARAMS, COORDINATE_TYPES, EARTH_RADIUS_KM, IDENTIFIER,
};
