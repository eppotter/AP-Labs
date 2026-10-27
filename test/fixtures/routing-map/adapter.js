'use strict';

// A routing-map adapter over the synthetic day in ./day.json (Story 15.4,
// AD-R16, F8). Test fixture only: no client data. It implements the adapter
// contract the archetype (kit/runtime/archetypes/routing-map) reads:
//
//   asOf()                       the day the data is as of
//   input({ day, view, scope })  { input, travel }: the engine's input for
//                                that day and view. change: the crews in
//                                day.json "out" are out (available false);
//                                gap: plus cancelled[] and candidates[].
//                                compare and zone are cut to a crew lead's
//                                crew; change and gap are not (the engine
//                                needs the other crews to place stops)
//   labels({ day, nodeIds, scope })  per node id { crewName } for a crew node
//                                and { clientName, city } for a place, and
//                                nothing else; its query is filtered by the
//                                scope (a crew lead gets no other crew's name)
//
// Like an app's adapter it reads only through data.run (so a data outage
// reaches the archetype as DataUnavailable). fakeData() answers its three
// queries from day.json, records every call, and returns only the columns
// each query names: never a position, address or postal code.
// fakeMapPoints() stands in for kit/runtime/data/map's mapPoints: it fits
// only the requested nodes into the frame (north up), from the fixture's
// micro-degree positions, as whole pixels. It records the ids it was asked.

const sdk = require('#sdk');
const DAY = require('./day.json');

const { routing: engine } = sdk;

const SQL = Object.freeze({
  asOf: "SELECT value FROM meta WHERE key = 'as_of'",
  day: 'SELECT payload FROM routing_days WHERE day = CAST($day AS DATE)',
  labels: [
    'SELECT node, crew_name, client_name, city FROM route_labels',
    "WHERE list_contains(string_split($node_ids, ','), node)",
    '  AND ($crew_id IS NULL OR crew_id IS NULL OR crew_id = $crew_id)',
  ].join('\n'),
});

const clone = (v) => JSON.parse(JSON.stringify(v));

function createAdapter({ data } = {}) {
  if (!data || typeof data.run !== 'function') throw new sdk.RoutingFault({ field: 'data', problem: 'data_unavailable' });

  async function asOf() {
    const rows = await data.run(SQL.asOf);
    return rows[0].value;
  }

  async function input({ day, view, scope }) {
    const rows = await data.run(SQL.day, { day }, { declared: ['day'] });
    const p = rows[0].payload;
    let crews = p.crews;
    if (view === 'change') crews = crews.map((c) => (p.out.includes(c.crewId) ? { ...c, headcountPresent: 0, available: false } : c));
    let stops = p.stops;
    const lead = scope && scope.all !== true ? scope.crewId : null;
    if (lead && (view === 'compare' || view === 'zone')) {
      crews = crews.filter((c) => c.crewId === lead);
      stops = stops.filter((s) => s.currentCrewId === lead);
    }
    const out = {
      day, asOf: p.asOf, limits: p.limits, crews, stops,
    };
    if (view === 'gap') Object.assign(out, { cancelled: p.cancelled, candidates: p.candidates });
    return { input: out, travel: engine.travel.fromMatrix(p.matrix) };
  }

  async function labels({ day, nodeIds, scope }) {
    const crewId = scope && scope.all !== true ? scope.crewId : null;
    const rows = await data.run(SQL.labels, { day, node_ids: nodeIds.join(','), crew_id: crewId }, { declared: ['day', 'node_ids', 'crew_id'] });
    const out = {};
    for (const r of rows) {
      out[r.node] = r.node.startsWith('crew:') ? { crewName: r.crew_name } : { clientName: r.client_name, city: r.city };
    }
    return out;
  }

  return Object.freeze({ asOf, input, labels });
}

// The data the adapter reads, from day.json. calls: every run, in order.
// Set failWith to an error to make every run reject with it.
function fakeData({ day = DAY } = {}) {
  const fake = {
    calls: [],
    failWith: null,
    async run(sql, params = {}) {
      fake.calls.push({ sql, params: clone(params) });
      if (fake.failWith) throw fake.failWith;
      if (sql === SQL.asOf) return [{ value: day.asOf }];
      if (sql === SQL.day) {
        const payload = clone(day);
        if (params.day !== day.day) Object.assign(payload, { stops: [], cancelled: [], candidates: [] });
        return [{ payload }];
      }
      if (sql === SQL.labels) {
        const rows = [];
        for (const node of [...new Set(String(params.node_ids).split(','))].sort()) {
          if (node.startsWith('crew:')) {
            const id = node.slice('crew:'.length);
            // Filtered by the scope: a crew lead's labels name no other crew.
            if (params.crew_id && id !== params.crew_id) continue;
            if (day.crewNames[id]) rows.push({ node, crew_name: day.crewNames[id], client_name: null, city: null });
          } else if (day.places[node]) {
            const place = day.places[node];
            rows.push({ node, crew_name: null, client_name: place.client_name, city: place.city });
          }
        }
        return rows;
      }
      throw new Error('unexpected query');
    },
    describe: () => ({ source: 'fixture', label: 'routing-map fixture', available: true }),
  };
  return fake;
}

// mapPoints for tests: fits the requested nodes (only them) into the frame
// at one scale, centred, north up, as whole pixels. asked: every id list.
function fakeMapPoints({ day = DAY } = {}) {
  const fn = async (data, nodeIds, frame) => {
    fn.asked.push([...nodeIds]);
    const known = nodeIds.filter((n) => day.places[n] && Number.isInteger(day.places[n].lat_e6));
    if (!known.length) return [];
    const lat = known.map((n) => day.places[n].lat_e6);
    const lon = known.map((n) => day.places[n].lon_e6);
    const [minLat, maxLat, minLon, maxLon] = [Math.min(...lat), Math.max(...lat), Math.min(...lon), Math.max(...lon)];
    const span = Math.max(maxLat - minLat, maxLon - minLon, 1);
    const room = Math.min(frame.width, frame.height) - 2 * frame.padding;
    const scale = room / span;
    const midLat = (minLat + maxLat) / 2;
    const midLon = (minLon + maxLon) / 2;
    return known.map((node) => ({
      node,
      x: Math.round(frame.width / 2 + (day.places[node].lon_e6 - midLon) * scale),
      y: Math.round(frame.height / 2 - (day.places[node].lat_e6 - midLat) * scale),
    }));
  };
  fn.asked = [];
  return fn;
}

module.exports = {
  createAdapter, fakeData, fakeMapPoints, SQL, DAY,
};
