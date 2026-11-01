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
//   route({ day, crewId, depot, scope })  (Story 15.14, AD-R26) { input,
//                                travel, distance } for Plan a route: that
//                                crew and its stops (a crew lead: only their
//                                own crew, whatever crewId says), its baseNode
//                                the Office (depot), a crew in day.json "out"
//                                marked out (available false); travel and
//                                distance from the matrix's minutes and
//                                km_tenths. distance throws for a pair the
//                                matrix lacks, never 0. With fill (Story
//                                19.4) { cancel, add }: candidate add in the
//                                place of visit cancel
//   visits, gapFor, crewOut      (Story 19.4) the what-if screens: a crew's
//                                visits (booked and cancelled), the gap day
//                                with one visit taken as cancelled, and the
//                                day with one crew out (plus day.json "out")
//
// Like an app's adapter it reads only through data.run (so a data outage
// reaches the archetype as DataUnavailable). fakeData() answers its three
// queries from day.json, records every call, and returns only the columns
// each query names: never a position, address or postal code.
// fakeMapPoints() stands in for kit/runtime/data/map's mapPoints: it fits
// only the requested nodes into the frame (north up), from the fixture's
// micro-degree positions, as whole pixels, and returns them with FAKE_MOSAIC
// as { points, mosaic } (the real shape, Story 15.8). It records the ids it
// was asked.

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

  // The what-if screens (Story 19.4): a crew lead's crew from the scope.
  const crewOf = (scope, crewId) => (scope && scope.all !== true ? scope.crewId : crewId);

  async function visits({ day, crewId, scope }) {
    const rows = await data.run(SQL.day, { day }, { declared: ['day'] });
    const p = rows[0].payload;
    const wanted = crewOf(scope, crewId);
    if (!p.crews.some((c) => c.crewId === wanted)) return { known: false, visits: [] };
    const own = (st) => st.currentCrewId === wanted;
    const visit = (cancelled) => (st) => ({
      stopId: st.stopId, node: st.node, start: st.start, cancelled,
    });
    return { known: true, visits: [...p.stops.filter(own).map(visit(false)), ...p.cancelled.filter(own).map(visit(true))] };
  }

  async function gapFor({
    day, crewId, stopId, scope,
  }) {
    const rows = await data.run(SQL.day, { day }, { declared: ['day'] });
    const p = rows[0].payload;
    const wanted = crewOf(scope, crewId);
    const taken = p.stops.find((st) => st.stopId === stopId && st.currentCrewId === wanted);
    const already = p.cancelled.some((c) => c.stopId === stopId && c.currentCrewId === wanted);
    if (!taken && !already) throw new sdk.RoutingFault({ field: 'stopId', problem: 'unknown_stop' });
    const cancelled = taken ? [...p.cancelled, {
      stopId: taken.stopId, node: taken.node, currentCrewId: taken.currentCrewId, start: taken.start, serviceMinutes: taken.serviceMinutes,
    }] : p.cancelled;
    return {
      input: {
        day, asOf: p.asOf, limits: p.limits, crews: p.crews, stops: p.stops.filter((st) => st !== taken), cancelled, candidates: p.candidates,
      },
      travel: engine.travel.fromMatrix(p.matrix),
    };
  }

  async function crewOut({ day, crewId, scope }) {
    const rows = await data.run(SQL.day, { day }, { declared: ['day'] });
    const p = rows[0].payload;
    const wanted = crewOf(scope, crewId);
    const crews = p.crews.map((c) => (p.out.includes(c.crewId) || c.crewId === wanted ? { ...c, headcountPresent: 0, available: false } : c));
    return {
      input: {
        day, asOf: p.asOf, limits: p.limits, crews, stops: p.stops,
      },
      travel: engine.travel.fromMatrix(p.matrix),
      wasOut: p.out.includes(wanted),
    };
  }

  async function route({
    day, crewId, depot, scope, fill,
  }) {
    const rows = await data.run(SQL.day, { day }, { declared: ['day'] });
    const p = rows[0].payload;
    const lead = scope && scope.all !== true ? scope.crewId : null;
    const wanted = lead || crewId;
    const crews = p.crews.filter((c) => c.crewId === wanted)
      .map((c) => ({ ...c, baseNode: depot, ...(p.out.includes(c.crewId) ? { headcountPresent: 0, available: false } : {}) }));
    let stops = p.stops.filter((st) => st.currentCrewId === wanted && crews.length > 0);
    if (fill && crews.length) {
      // Customer cancellation's Fill with #n: the candidate in the cancelled
      // visit's place.
      const gone = [...p.stops, ...p.cancelled].find((st) => st.stopId === fill.cancel && st.currentCrewId === wanted);
      const cand = p.candidates.find((c) => c.stopId === fill.add);
      if (!gone || !cand) throw new sdk.RoutingFault({ field: gone ? 'fill.add' : 'fill.cancel', problem: 'unknown_stop' });
      const {
        plannedDate, cadenceDays, prevVisitDate, flexible, ...rest
      } = cand;
      const order = gone.routeOrder === undefined ? null : gone.routeOrder;
      stops = [...stops.filter((st) => st.stopId !== fill.cancel), {
        ...rest, currentCrewId: wanted, routeOrder: order, start: gone.start,
      }];
    }
    const km = new Map(p.matrix.map((r) => [`${r.from_node}>${r.to_node}`, r.km_tenths]));
    const distance = (from, to) => {
      const d = km.get(`${from}>${to}`);
      if (d === undefined) throw new sdk.RoutingFault({ field: 'distance', problem: 'no_travel' });
      return d;
    };
    return {
      input: {
        day, asOf: p.asOf, limits: p.limits, crews, stops,
      },
      travel: engine.travel.fromMatrix(p.matrix),
      distance,
    };
  }

  return Object.freeze({
    asOf, input, labels, route, visits, gapFor, crewOut,
  });
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

// A made-up tile mosaic with numbers found nowhere else in the fixture, so a
// test can prove it reaches no log, Slack call, error or renderer.
const FAKE_MOSAIC = Object.freeze({ z: 13, tx0: 2417, ty0: 3066, cols: 3, rows: 3, ox: -91, oy: -77 });

// mapPoints for tests: fits the requested nodes (only them) into the frame
// at one scale, centred, north up, as whole pixels, with FAKE_MOSAIC (no
// mosaic for no points). asked: every id list.
function fakeMapPoints({ day = DAY, mosaic = FAKE_MOSAIC } = {}) {
  const fn = async (data, nodeIds, frame) => {
    fn.asked.push([...nodeIds]);
    const known = nodeIds.filter((n) => day.places[n] && Number.isInteger(day.places[n].lat_e6));
    if (!known.length) return { points: [], mosaic: null };
    const lat = known.map((n) => day.places[n].lat_e6);
    const lon = known.map((n) => day.places[n].lon_e6);
    const [minLat, maxLat, minLon, maxLon] = [Math.min(...lat), Math.max(...lat), Math.min(...lon), Math.max(...lon)];
    const span = Math.max(maxLat - minLat, maxLon - minLon, 1);
    const room = Math.min(frame.width, frame.height) - 2 * frame.padding;
    const scale = room / span;
    const midLat = (minLat + maxLat) / 2;
    const midLon = (minLon + maxLon) / 2;
    const points = known.map((node) => ({
      node,
      x: Math.round(frame.width / 2 + (day.places[node].lon_e6 - midLon) * scale),
      y: Math.round(frame.height / 2 - (day.places[node].lat_e6 - midLat) * scale),
    }));
    return { points, mosaic };
  };
  fn.asked = [];
  return fn;
}

module.exports = {
  createAdapter, fakeData, fakeMapPoints, FAKE_MOSAIC, SQL, DAY,
};
