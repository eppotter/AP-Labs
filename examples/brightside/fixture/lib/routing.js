'use strict';

// Brightside's routing data (Stories 14.1 and 14.2, data-design §1-2):
// synthetic coordinates for every property and crew base, the booked schedule
// after as_of (scheduled_visits), the customers' rules (service_rules) and
// staff absences in the horizon (staff_absences).
//
// It runs after the operations build, reads only final tables, and draws
// from its own stream (createRng(deriveSeed(seed, ROUTING_STREAM))), so every
// earlier column keeps its values byte for byte. Draw order inside the stream
// is fixed: each property's jitter in property_id order, each scheduled
// visit's cancellation chance in scheduled_visit_id order, each crew-day's
// route in date then crew order, each booked property's rules in property_id
// order, then each open membership's absence chance, day by day. With the
// recorded seed, lib/scenarios.js plants S1 to S3 on top (data-design §5);
// planting draws nothing. Then balanceDays (generator v8) moves stops so
// every crew-day fits 08:00 to 18:00; it draws nothing either, so every
// draw is v7's.
//
// Coordinates are synthetic: random points in a box around a round-number
// point in Columbus, Ohio (Story 15.7, AD-R22), so a street map can sit under
// the plot. A point may land near a real street or home, but none is or
// comes from a real address, and none is on water (generator v6): a point
// that falls in one of lib/water.js's rough outlines, as is or snapped to the
// map grid, is drawn again from its own stream (WATER_STREAM), so every other
// draw stays where it was. Micro-degrees (degrees x 1e6) as whole numbers.
// Each of the 15 cities has a fixed centre, laid out in km from the box's
// centre so that same-city drives are about 5-12 minutes and drives between a
// zone's cities about 10-35, as the history's travel bounds show. A property
// sits within 2.5 km of its city's centre on each axis. A crew's base sits
// near its zone's first city, with no randomness.
//
// Drive minutes are travelMatrix's (kit/runtime/data, Story 13.2): haversine
// km on a 6371.0088 km sphere x detour_factor / speed_kmh x 60, rounded to
// 1e-6, then up to a whole minute, never below min_travel_minutes. The three
// numbers match profiles/brightside/profile.yml routing, and the routing test
// checks every booked leg against the same formula run in DuckDB.

const { toDay, toIso } = require('./days');
const { onWater } = require('./water');
const { scheduleDays } = require('./activity');
const {
  labourMinutes, clockTime, ceilTo,
  EARLIEST_START, DAY_START, AIM_TO_FINISH, LATEST_FINISH, NOON, SLOT_MINUTES, MIN_SCHEDULED,
} = require('./operations');

const ROUTING_STREAM = 'routing';
// The redraws of a point that fell on water (generator v6).
const WATER_STREAM = 'routing-water';
const MAX_REDRAWS = 1000;

// travelMatrix's constants and Brightside's profile routing block.
const EARTH_RADIUS_KM = 6371.0088;
const SPEED_KMH = 40;
const DETOUR_FACTOR = 1.3;
const MIN_TRAVEL_MINUTES = 5;

// Booked through as_of + 28 days (fixture_meta schedule_horizon_end).
const SCHEDULE_HORIZON_DAYS = 28;
// A small share of booked visits is already called off by as_of, the call
// made in the week up to it.
const CANCEL_CHANCE = 0.02;
const CANCEL_NOTICE_DAYS = 6;

// The box's centre and how many micro-degrees one km is there (1 degree of
// latitude is 111.195 km; of longitude, that x cos(40 degrees)). Generator v5
// moved only CENTRE and BOX (from the open South Pacific, v4); the per-km
// scales, jitter, city and base offsets are v4's, so every draw is unchanged.
// Generator v6 moved three city centres off water (CITY_KM below).
const CENTRE = { lat: 40000000, lon: -83000000 };
const LAT_E6_PER_KM = 8993;
const LON_E6_PER_KM = 11740;
const JITTER_KM = 2.5;
// Every coordinate lies inside this box (checks/synthetic-coordinates.sql).
const BOX = { latMin: 39700000, latMax: 40300000, lonMin: -83400000, lonMax: -82600000 };

// The Office (Story 15.15, AD-R23, generator v7): the one depot, where every
// crew starts and ends in Plan a route. Not random, unlike every other point:
// a point Ely chose in Westerville, rounded to 0.002° (about 150 m), the map
// grid, so it is already a grid point. Ely confirmed it may ship in the
// fixture (DEP-035). It takes no draw, so no other value moves. It is near
// Hoover Reservoir's outline but off it (checks/synthetic-off-water.sql).
const OFFICE = Object.freeze({ depot_id: 'office', name: 'Office', lat: 40122000, lon: -82908000 });

// City centres in km [east, north] of the box's centre. Central's cities sit
// closer together, as the history's shorter central drives show. Generator
// v6 moved three whose centre was on water onto land, keeping the zone's
// drive bounds: Oldmarket from [-3, 4] (the Olentangy), Northvale from
// [2, 21] (Alum Creek Reservoir) and Riverbend from [1, -21] (the Scioto).
const CITY_KM = {
  Centerpoint: [0, 0], Midtown: [4, 3], Oldmarket: [-0.5, 6],
  Fernhill: [-5, 16], Northvale: [0, 18.5], Pinecrest: [6, 15],
  Clayfield: [-6, -15], Riverbend: [4, -20], Southmere: [5, -14],
  Eastbrook: [15, -4], Harborview: [21, 2], Sunridge: [15, 5],
  Stonegate: [-15, 4], Westfall: [-21, -1], Willowmere: [-14, -5],
};
// A crew's base in km from its zone's first city: crews A, B, C side by side.
const BASE_OFFSET_KM = [[-1, -1.5], [0, -1.5], [1, -1.5]];

const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const k = typeof key === 'function' ? key(row) : row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
};

function shuffled(rng, list) {
  const pool = list.slice();
  const out = [];
  while (pool.length > 0) out.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
  return out;
}

const point = ([east, north]) => ({
  lat: CENTRE.lat + Math.round(north * LAT_E6_PER_KM),
  lon: CENTRE.lon + Math.round(east * LON_E6_PER_KM),
});

const CITY_CENTRES = new Map(Object.entries(CITY_KM).map(([city, km]) => [city, point(km)]));

// Whole drive minutes between two points in micro-degrees, as travelMatrix
// works them out in DuckDB, in the same order of operations.
function travelMinutes(from, to) {
  const radians = (deg) => (deg * Math.PI) / 180;
  const fLat = from.lat / 1e6;
  const fLon = from.lon / 1e6;
  const tLat = to.lat / 1e6;
  const tLon = to.lon / 1e6;
  const h = Math.sin(radians(tLat - fLat) / 2) ** 2
    + Math.cos(radians(fLat)) * Math.cos(radians(tLat)) * Math.sin(radians(tLon - fLon) / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1.0, Math.sqrt(h)));
  const minutes = Math.round(((km * DETOUR_FACTOR) / SPEED_KMH) * 60 * 1e6) / 1e6;
  return Math.max(MIN_TRAVEL_MINUTES, Math.ceil(minutes));
}

// ---- coordinates ----------------------------------------------------------

// Each property takes its two draws from `rng`, on water or not, so no
// later draw moves. A point on water is drawn again, in the same square
// around its city's centre, from `waterRng` until it is dry.
function placeProperties(rng, properties, waterRng) {
  const latJitter = Math.round(JITTER_KM * LAT_E6_PER_KM);
  const lonJitter = Math.round(JITTER_KM * LON_E6_PER_KM);
  return properties.map((p) => {
    const centre = CITY_CENTRES.get(p.city);
    if (!centre) throw new Error(`properties ${p.property_id}: city ${p.city} has no synthetic centre`);
    let lat = centre.lat + rng.int(-latJitter, latJitter);
    let lon = centre.lon + rng.int(-lonJitter, lonJitter);
    for (let tries = 0; onWater(lat, lon); tries++) {
      if (tries === MAX_REDRAWS) throw new Error(`properties ${p.property_id}: no dry point near ${p.city}'s centre`);
      lat = centre.lat + waterRng.int(-latJitter, latJitter);
      lon = centre.lon + waterRng.int(-lonJitter, lonJitter);
    }
    return { ...p, geo_lat_e6: lat, geo_lon_e6: lon };
  });
}

function placeCrews(crews, zones) {
  const firstCity = new Map(zones.map((z) => [z.zone_id, z.cities[0]]));
  const index = new Map();
  return crews.map((c) => {
    const i = index.get(c.zone_id) || 0;
    index.set(c.zone_id, i + 1);
    const [east, north] = CITY_KM[firstCity.get(c.zone_id)];
    const [dx, dy] = BASE_OFFSET_KM[i];
    const base = point([east + dx, north + dy]);
    return { ...c, base_geo_lat_e6: base.lat, base_geo_lon_e6: base.lon };
  });
}

// ---- the booked schedule --------------------------------------------------

// Each active plan's cadence dates after as_of through the horizon, on its
// crew (every visit of a plan is on one crew).
function plannedVisits(tables, asOf, horizonEnd) {
  const crewOf = new Map();
  for (const v of tables.visits) {
    if (v.plan_id === null) continue;
    if (crewOf.has(v.plan_id) && crewOf.get(v.plan_id) !== v.crew_id) throw new Error(`plan ${v.plan_id}: visits on more than one crew`);
    crewOf.set(v.plan_id, v.crew_id);
  }
  const planned = [];
  for (const plan of tables.plans) {
    if (plan.end_date !== null) continue;
    if (!crewOf.has(plan.plan_id)) throw new Error(`plan ${plan.plan_id}: active with no visit, so no crew`);
    const cadence = { start: toDay(plan.start_date), frequency: plan.frequency };
    for (const day of scheduleDays(cadence, horizonEnd)) {
      if (day <= asOf) continue;
      planned.push({ plan, day, crew_id: crewOf.get(plan.plan_id) });
    }
  }
  planned.sort((a, b) => a.day - b.day || a.plan.property_id - b.plan.property_id || a.plan.plan_id - b.plan.plan_id);
  return planned;
}

// The crew's headcount after as_of: its open memberships.
function headcounts(memberships) {
  const count = new Map();
  for (const m of memberships) if (m.end_date === null) count.set(m.crew_id, (count.get(m.crew_id) || 0) + 1);
  return count;
}

// One crew-day's times, as the history's days are planned: a long day starts
// earlier (never before 06:00); a day that cannot fit 06:00 to 23:00 is
// squeezed in proportion, never below the minimum slot.
function timeDay(stops) {
  let planned = stops.reduce((s, x) => s + x.travel + x.minutes, 0);
  if (planned > LATEST_FINISH - EARLIEST_START) {
    const travel = stops.reduce((s, x) => s + x.travel + 5, 0);
    const work = stops.reduce((s, x) => s + x.minutes, 0);
    const factor = (LATEST_FINISH - EARLIEST_START - travel) / work;
    for (const x of stops) x.minutes = Math.max(MIN_SCHEDULED, Math.floor((x.minutes * factor) / SLOT_MINUTES) * SLOT_MINUTES);
    planned = stops.reduce((s, x) => s + x.travel + x.minutes, 0);
  }
  const dayStart = planned <= AIM_TO_FINISH - DAY_START ? DAY_START
    : Math.max(EARLIEST_START, Math.floor((AIM_TO_FINISH - planned) / SLOT_MINUTES) * SLOT_MINUTES);
  let cursor = dayStart;
  for (const s of stops) {
    s.start = ceilTo(cursor + s.travel, 5);
    cursor = s.start + s.minutes;
  }
  return cursor;
}

// A crew-day's key: its date, then its crew in number order.
const crewDayKey = (r) => `${r.visit_date}|${String(r.crew_id).padStart(6, '0')}`;

// Generator v8: every booked crew-day fits a normal day. Starting at
// DAY_START (08:00) from the crew's base, each stop starts once the crew has
// driven there (to the next 5 minutes, as timeDay books it) and the last one
// ends by AIM_TO_FINISH (18:00); the drive home is not counted. So the day's
// drives plus service minutes are at most DAY_CAPACITY, and timeDay books it
// from 08:00 (checks/integrity-scheduled-day-capacity.sql).
const DAY_CAPACITY = AIM_TO_FINISH - DAY_START;
// How far a visit may move to a later day: under half its cadence, the
// routing engine's own rule for moving a visit (kit/runtime/routing/gapfill.js:
// at least half a cadence since the previous visit). A monthly cadence counts
// 30 days, as the adapter does.
const CADENCE_DAYS = { weekly: 7, biweekly: 14, monthly: 30 };
const maxShiftDays = (frequency) => Math.floor(CADENCE_DAYS[frequency] / 2);

// Each stop's start, and the minutes from DAY_START until the last stop
// ends, booked as timeDay books a day that fits.
function dayPlan(route, from, placeOf, minutesOf) {
  let at = from;
  let cursor = DAY_START;
  const starts = [];
  for (const r of route) {
    const next = placeOf(r);
    const start = ceilTo(cursor + travelMinutes(at, next), 5);
    starts.push(start);
    cursor = start + minutesOf(r);
    at = next;
  }
  return { load: cursor - DAY_START, starts };
}
const dayLoad = (route, from, placeOf, minutesOf) => dayPlan(route, from, placeOf, minutesOf).load;

// The booked schedule gives each plan's visits to the plan's own crew on its
// cadence dates, with no limit on a crew-day (as the history does, which
// stays as it is), so some crew-days held far more than a day's work
// (generator v7: 44 of 410 past 18:00 from 08:00, the worst to 23:47).
// balanceDays takes each crew-day over DAY_CAPACITY, in date then crew order,
// and gives away one stop at a time until it fits:
//   1. to another crew of its zone on the same day with room, at the
//      cheapest place in that crew's route (the move adding the fewest
//      minutes in all; ties to the lower scheduled_visit_id, then crew);
//   2. failing that, to the nearest later day, at most maxShiftDays and never
//      past the horizon, then (near the horizon's end) the nearest earlier
//      day after as_of, on any crew of its zone with room (its own
//      included), by the same cost; never onto a day the property is
//      already booked, nor under half a cadence from its plan's visit
//      before or after.
// A day that still does not fit throws: no visit is dropped. Days in
// `fixedDays` (the planted scenarios') neither give nor take a stop, and
// visits of `fixedProperties` never move. A visit of a `morningOnly`
// property (a planted morning rule) must start before noon: a day that
// would start one later is first given its morning-only stops at the
// front, and no move may push one past noon. Draws nothing. Returns the
// ids of the visits on another crew (`reassigned`) or day (`rebooked`)
// than they had before it ran.
function balanceDays(routes, {
  crews, base, placeOf, minutesFor, frequencyOf, lastVisitOf, firstDay, horizonEnd,
  fixedDays = new Set(), fixedProperties = new Set(), morningOnly = new Set(), capacity = DAY_CAPACITY,
}) {
  const sorted = crews.slice().sort((a, b) => a.crew_id - b.crew_id);
  const zoneCrews = groupBy(sorted, 'zone_id');
  const zoneOf = new Map(crews.map((c) => [c.crew_id, c.zone_id]));
  const keyOf = (iso, crewId) => crewDayKey({ visit_date: iso, crew_id: crewId });
  const planOf = (crewId, route) => dayPlan(route, base.get(crewId), placeOf, (r) => minutesFor(r, crewId));
  const loadOf = (crewId, route) => planOf(crewId, route).load;
  const fits = (crewId, route) => {
    const { load, starts } = planOf(crewId, route);
    return load <= capacity && route.every((r, i) => !morningOnly.has(r.property_id) || starts[i] < NOON);
  };
  const all = [...routes.values()].flat();
  const original = new Map(all.map((r) => [r.scheduled_visit_id, { crew_id: r.crew_id, visit_date: r.visit_date }]));
  const bookedOn = new Set(all.map((r) => `${r.property_id}|${r.visit_date}`));
  const ofPlan = groupBy(all, 'plan_id');
  // A visit may go to `to` when its plan's visits either side (or the last
  // history visit) stay at least half a cadence away.
  const spaced = (r, to) => {
    const at = toDay(r.visit_date);
    const half = (d) => 2 * d >= CADENCE_DAYS[frequencyOf(r)];
    let prev = lastVisitOf(r.plan_id);
    let next = null;
    for (const o of ofPlan.get(r.plan_id)) {
      if (o === r) continue;
      const d = toDay(o.visit_date);
      if (d < at && (prev === null || d > prev)) prev = d;
      if (d > at && (next === null || d < next)) next = d;
    }
    return (prev === null || half(to - prev)) && (next === null || half(next - to));
  };
  // The days a stop may go to, nearest first: its own, the later days its
  // cadence allows, then (near the horizon's end) the earlier ones.
  const reachOf = (r, day) => {
    const most = maxShiftDays(frequencyOf(r));
    const out = [0];
    for (let k = 1; k <= Math.min(most, horizonEnd - day); k++) out.push(k);
    for (let k = 1; k <= Math.min(most, day - firstDay); k++) out.push(-k);
    return out;
  };
  const better = (a, b) => !b || a.rank < b.rank || (a.rank === b.rank && (a.cost < b.cost
    || (a.cost === b.cost && (a.r.scheduled_visit_id < b.r.scheduled_visit_id
      || (a.r.scheduled_visit_id === b.r.scheduled_visit_id && a.crewId < b.crewId)))));
  for (let day = firstDay; day <= horizonEnd; day++) {
    const iso = toIso(day);
    for (const crew of sorted) {
      const key = keyOf(iso, crew.crew_id);
      const route = routes.get(key);
      if (!route || fixedDays.has(key)) continue;
      if (!fits(crew.crew_id, route) && route.some((r) => morningOnly.has(r.property_id))) {
        const front = route.filter((r) => morningOnly.has(r.property_id)).concat(route.filter((r) => !morningOnly.has(r.property_id)));
        route.splice(0, route.length, ...front);
      }
      let load = loadOf(crew.crew_id, route);
      while (!fits(crew.crew_id, route)) {
        let best = null;
        route.forEach((r, i) => {
          if (fixedProperties.has(r.property_id)) return;
          const rest = route.slice(0, i).concat(route.slice(i + 1));
          if (route.some((x) => morningOnly.has(x.property_id)) && !planOf(crew.crew_id, rest).starts.every((t, k) => !morningOnly.has(rest[k].property_id) || t < NOON)) return;
          const freed = load - loadOf(crew.crew_id, rest);
          reachOf(r, day).forEach((shift, rank) => {
            if (best && best.rank < rank) return;
            const to = toIso(day + shift);
            if (shift !== 0 && (bookedOn.has(`${r.property_id}|${to}`) || !spaced(r, day + shift))) return;
            for (const other of zoneCrews.get(zoneOf.get(crew.crew_id))) {
              const otherKey = keyOf(to, other.crew_id);
              if ((shift === 0 && other.crew_id === crew.crew_id) || fixedDays.has(otherKey)) continue;
              const target = routes.get(otherKey) || [];
              const before = loadOf(other.crew_id, target);
              for (let j = 0; j <= target.length; j++) {
                const into = target.slice(0, j).concat([r], target.slice(j));
                if (!fits(other.crew_id, into)) continue;
                const after = loadOf(other.crew_id, into);
                const move = { rank, cost: after - before - freed, r, i, crewId: other.crew_id, to, j, rest: load - freed };
                if (better(move, best)) best = move;
              }
            }
          });
        });
        if (!best) throw new Error(`crew ${crew.crew_id} on ${iso}: ${route.length} booked visits need ${load} minutes (a day has ${capacity}) or start a morning-only stop after noon, and no stop has room on its zone's crews that day or the days its cadence allows`);
        route.splice(best.i, 1);
        const otherKey = keyOf(best.to, best.crewId);
        if (!routes.has(otherKey)) routes.set(otherKey, []);
        routes.get(otherKey).splice(best.j, 0, best.r);
        bookedOn.delete(`${best.r.property_id}|${iso}`);
        bookedOn.add(`${best.r.property_id}|${best.to}`);
        Object.assign(best.r, { crew_id: best.crewId, visit_date: best.to, minutes: minutesFor(best.r, best.crewId) });
        load = best.rest;
      }
    }
  }
  const ids = (pick) => all.filter(pick).map((r) => r.scheduled_visit_id).sort((a, b) => a - b);
  return {
    reassigned: ids((r) => r.crew_id !== original.get(r.scheduled_visit_id).crew_id),
    rebooked: ids((r) => r.visit_date !== original.get(r.scheduled_visit_id).visit_date),
  };
}

function buildSchedule(rng, tables, { properties, crews, asOf, plant }) {
  const asOfDay = toDay(asOf);
  const horizonEnd = asOfDay + SCHEDULE_HORIZON_DAYS;
  const home = new Map(properties.map((p) => [p.property_id, p]));
  const base = new Map(crews.map((c) => [c.crew_id, { lat: c.base_geo_lat_e6, lon: c.base_geo_lon_e6 }]));
  const heads = headcounts(tables.crew_memberships);
  const where = (p) => ({ lat: p.geo_lat_e6, lon: p.geo_lon_e6 });

  const rows = plannedVisits(tables, asOfDay, horizonEnd).map((v, i) => {
    const headcount = heads.get(v.crew_id) || 0;
    if (headcount === 0) throw new Error(`crew ${v.crew_id} has no members after as_of`);
    const labour = Math.round(labourMinutes({ visit_id: `scheduled ${i + 1}`, package_id: v.plan.package_id }, home.get(v.plan.property_id), []));
    return {
      scheduled_visit_id: i + 1,
      property_id: v.plan.property_id,
      plan_id: v.plan.plan_id,
      crew_id: v.crew_id,
      package_id: v.plan.package_id,
      visit_date: toIso(v.day),
      status: 'scheduled',
      status_changed_on: v.plan.start_date,
      labour_minutes: labour,
      minutes: Math.max(MIN_SCHEDULED, Math.round(labour / headcount / SLOT_MINUTES) * SLOT_MINUTES),
    };
  });
  for (const r of rows) {
    if (!rng.chance(CANCEL_CHANCE)) continue;
    const called = Math.max(toDay(r.status_changed_on), asOfDay - rng.int(0, CANCEL_NOTICE_DAYS));
    r.status = 'cancelled';
    r.status_changed_on = toIso(called);
  }

  // Each crew-day's booked route: cities in a random order, stops in a random
  // order within each city. Cancelled stops keep their place, as in history.
  // The planted scenarios (lib/scenarios.js) then move a few stops between a
  // zone's crews on their days and set those days' orders; the draws above
  // are made first on the unplanted days, so no other day's order moves.
  const routes = new Map();
  for (const [key, day] of [...groupBy(rows, crewDayKey)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const byCity = groupBy(day, (r) => home.get(r.property_id).city);
    const cities = shuffled(rng, [...byCity.keys()].sort());
    routes.set(key, cities.flatMap((c) => shuffled(rng, byCity.get(c))));
  }
  if (plant) plant.schedule(rows, routes, { asOf, city: (r) => home.get(r.property_id).city });
  // Generator v8: every crew-day then fits a normal day (balanceDays).
  const frequency = new Map(tables.plans.map((p) => [p.plan_id, p.frequency]));
  const lastVisit = new Map();
  for (const v of tables.visits) {
    if (v.plan_id !== null && !(lastVisit.get(v.plan_id) >= toDay(v.visit_date))) lastVisit.set(v.plan_id, toDay(v.visit_date));
  }
  const moves = balanceDays(routes, {
    crews: crews.filter((c) => (heads.get(c.crew_id) || 0) > 0),
    base,
    placeOf: (r) => where(home.get(r.property_id)),
    minutesFor: (r, crewId) => Math.max(MIN_SCHEDULED, Math.round(r.labour_minutes / heads.get(crewId) / SLOT_MINUTES) * SLOT_MINUTES),
    frequencyOf: (r) => frequency.get(r.plan_id),
    lastVisitOf: (planId) => (lastVisit.has(planId) ? lastVisit.get(planId) : null),
    firstDay: asOfDay + 1,
    horizonEnd,
    fixedDays: plant ? plant.fixedDays : new Set(),
    fixedProperties: plant ? plant.fixedProperties : new Set(),
    morningOnly: plant ? plant.morningOnly : new Set(),
  });
  for (const [, route] of [...routes].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (route.length === 0) continue;
    const { crew_id: crewId, visit_date: iso } = route[0];
    let at = base.get(crewId);
    for (const r of route) {
      const next = where(home.get(r.property_id));
      r.travel = travelMinutes(at, next);
      at = next;
    }
    const end = timeDay(route);
    if (end > LATEST_FINISH) throw new Error(`crew ${crewId} on ${iso}: ${route.length} booked visits end after 23:00`);
    route.forEach((r, i) => {
      r.route_order = i + 1;
      r.arrival_window = r.start < NOON ? 'morning' : 'afternoon';
      r.scheduled_start = clockTime(r.start);
      r.scheduled_minutes = r.minutes;
      r.travel_minutes_from_previous = r.travel;
    });
  }
  const scheduledVisits = rows.map((r) => ({
    scheduled_visit_id: r.scheduled_visit_id,
    property_id: r.property_id,
    plan_id: r.plan_id,
    crew_id: r.crew_id,
    package_id: r.package_id,
    visit_date: r.visit_date,
    status: r.status,
    status_changed_on: r.status_changed_on,
    arrival_window: r.arrival_window,
    scheduled_start: r.scheduled_start,
    scheduled_minutes: r.scheduled_minutes,
    labour_minutes: r.labour_minutes,
    route_order: r.route_order,
    travel_minutes_from_previous: r.travel_minutes_from_previous,
  }));
  return { scheduledVisits, moves };
}

// ---- customer rules -------------------------------------------------------

// ISO weekday (Monday 1 to Sunday 7) of a day number; day 0 was a Thursday.
const isoWeekday = (day) => ((day + 3) % 7) + 1;
const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const RULE_TYPES = ['preferred_crew', 'day_of_week', 'time_of_day'];
const RULE_STRENGTH = { preferred_crew: 'soft', day_of_week: 'hard', time_of_day: 'hard' };
const PREFERRED_CREW_SHARE = 0.6;
const DAY_OF_WEEK_SHARE = 0.2;
const EXTRA_DAY_SHARE = 0.5;
const TIME_OF_DAY_SHARE = 0.25;

// A day_of_week value: ISO day names in week order, separated by | (a
// comma would make the seed CSV quote the field).
const dayList = (isoDays) => [...new Set(isoDays)].sort((a, b) => a - b).map((d) => DAY_NAMES[d - 1]).join('|');

// One row per (property, rule type), long form, for each property with a
// booked visit (data-design §1). Every rule matches the property's own
// booked visits (status scheduled): preferred_crew is the crew of every one
// of them (so a property with a visit moved to another crew has none),
// day_of_week holds each of their weekdays (sometimes one more day), and
// time_of_day is the window all of them share. Each property takes the same
// five draws whether or not it gets a rule, so one property's rules never
// move another's. A planted scenario may set a property's rules outright.
function buildRules(rng, scheduledVisits, plant) {
  const booked = groupBy(scheduledVisits.filter((v) => v.status === 'scheduled'), 'property_id');
  const rows = [];
  for (const pid of [...booked.keys()].sort((a, b) => a - b)) {
    const visits = booked.get(pid);
    const crewIds = new Set(visits.map((v) => v.crew_id));
    const windows = new Set(visits.map((v) => v.arrival_window));
    const days = visits.map((v) => isoWeekday(toDay(v.visit_date)));
    const wantsCrew = rng.chance(PREFERRED_CREW_SHARE);
    const wantsDays = rng.chance(DAY_OF_WEEK_SHARE);
    const wantsExtraDay = rng.chance(EXTRA_DAY_SHARE);
    const extraDay = rng.int(1, 7);
    const wantsWindow = rng.chance(TIME_OF_DAY_SHARE);
    let rules = [];
    if (wantsCrew && crewIds.size === 1) rules.push({ rule_type: 'preferred_crew', value: String(visits[0].crew_id) });
    if (wantsDays) rules.push({ rule_type: 'day_of_week', value: dayList(wantsExtraDay ? [...days, extraDay] : days) });
    if (wantsWindow && windows.size === 1) rules.push({ rule_type: 'time_of_day', value: visits[0].arrival_window });
    if (plant) rules = plant.rules(pid, rules);
    for (const type of RULE_TYPES) {
      const rule = rules.find((r) => r.rule_type === type);
      if (rule) rows.push({ rule_id: rows.length + 1, property_id: pid, rule_type: type, value: rule.value, strength: RULE_STRENGTH[type] });
    }
  }
  return rows;
}

// ---- staff absences -------------------------------------------------------

const BACKGROUND_ABSENCE_CHANCE = 0.01;
const ABSENCE_NOTICE_DAYS = 13;
// The planted scenarios' days (as_of + 1 to + 3) get no background absence,
// so only the planted ones change a crew there.
const QUIET_DAYS = 3;

// About 1% of cleaner-days in the horizon, on open memberships (only those
// cover a day after as_of), at most one per crew-day so a crew is never
// left with nobody; never a crew lead, so the background never puts a crew
// out (that is S3's job). Each was reported on or before as_of. Then the
// planted ones. One row per (staff, day), in date then staff order.
function buildAbsences(rng, tables, { asOf, plant }) {
  const asOfDay = toDay(asOf);
  const role = new Map(tables.staff.map((s) => [s.staff_id, s.role]));
  const open = tables.crew_memberships.filter((m) => m.end_date === null).sort((a, b) => a.membership_id - b.membership_id);
  const absent = [];
  for (let day = asOfDay + 1; day <= asOfDay + SCHEDULE_HORIZON_DAYS; day++) {
    const crewsOut = new Set();
    for (const m of open) {
      const hit = rng.chance(BACKGROUND_ABSENCE_CHANCE);
      const notice = rng.int(0, ABSENCE_NOTICE_DAYS);
      if (!hit || day <= asOfDay + QUIET_DAYS || role.get(m.staff_id) !== 'cleaner' || crewsOut.has(m.crew_id)) continue;
      crewsOut.add(m.crew_id);
      absent.push({ staff_id: m.staff_id, absence_date: toIso(day), reported_on: toIso(asOfDay - notice) });
    }
  }
  if (plant) absent.push(...plant.absences({ asOf }));
  absent.sort((a, b) => (a.absence_date < b.absence_date ? -1 : a.absence_date > b.absence_date ? 1 : a.staff_id - b.staff_id));
  return absent.map((a, i) => ({ absence_id: i + 1, ...a }));
}

// Returns `tables`: the two extended tables, scheduled_visits, service_rules
// and staff_absences; and `moves`: the booked visits balanceDays put on
// another crew of their zone (reassigned) or a later day (rebooked). The
// input `tables` is read, never changed: the extended tables are new row
// objects with the columns appended. `plant` (lib/scenarios.js, the
// recorded seed only) plants S1 to S3. `waterRng` (WATER_STREAM) redraws a
// point that fell on water.
function buildRouting(rng, tables, { zones, asOf, plant = null, waterRng }) {
  let properties = placeProperties(rng, tables.properties, waterRng);
  if (plant) properties = plant.coordinates(properties, point);
  const crews = placeCrews(tables.crews, zones);
  const { scheduledVisits, moves } = buildSchedule(rng, tables, { properties, crews, asOf, plant });
  const serviceRules = buildRules(rng, scheduledVisits, plant);
  const staffAbsences = buildAbsences(rng, tables, { asOf, plant });
  return { tables: { properties, crews, scheduled_visits: scheduledVisits, service_rules: serviceRules, staff_absences: staffAbsences }, moves };
}

// The depots table (generator v7): the Office only. Built from a constant,
// with no draw, so every other table stays v6's byte for byte.
function buildDepots() {
  return [{ depot_id: OFFICE.depot_id, name: OFFICE.name, geo_lat_e6: OFFICE.lat, geo_lon_e6: OFFICE.lon }];
}

// fixture_meta's last booked day.
const scheduleHorizonEnd = (asOf) => toIso(toDay(asOf) + SCHEDULE_HORIZON_DAYS);

module.exports = {
  buildRouting,
  buildDepots,
  balanceDays,
  dayLoad,
  maxShiftDays,
  DAY_CAPACITY,
  CADENCE_DAYS,
  placeProperties,
  travelMinutes,
  isoWeekday,
  dayList,
  crewDayKey,
  scheduleHorizonEnd,
  point,
  DAY_NAMES,
  RULE_STRENGTH,
  ROUTING_STREAM,
  WATER_STREAM,
  SCHEDULE_HORIZON_DAYS,
  EARTH_RADIUS_KM,
  SPEED_KMH,
  DETOUR_FACTOR,
  MIN_TRAVEL_MINUTES,
  BOX,
  CENTRE,
  OFFICE,
  LAT_E6_PER_KM,
  LON_E6_PER_KM,
  JITTER_KM,
  CITY_KM,
  BASE_OFFSET_KM,
};
