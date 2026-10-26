'use strict';

// The planted routing scenarios S1 to S3 (Story 14.2, data-design §5). They
// sit at fixed ids and dates in the recorded seed's fixture, so the routing
// truths (targets.json `routing`, Story 14.4) have known answers. Planting
// draws nothing from any stream: it moves a few booked visits between a
// zone's crews on their own day (never to another day, so every plan keeps
// its cadence), sets those days' orders, places a handful of properties, and
// sets a few properties' rules and staff absences outright.
//
//   S1 zig-zag day   crew 4 on as_of+1: seven stops booked going back and
//                    forth between cities (one city at a time, in turn).
//   S2 cancellation  crew 2 on as_of+2: an afternoon stop cancelled on as_of,
//                    in a small estate on Pinecrest's east edge. Around it:
//                    one clear best fill (Pinecrest, next visit 3 days later,
//                    no rule), a runner-up (7 days later), a closer decoy
//                    whose time_of_day is morning, and a decoy whose last
//                    visit was too recent for its cadence. The estate sits
//                    far enough from every other home that nothing else fits
//                    the gap, so exactly two candidates are valid.
//   S3 sick crew     crew 7's lead and one cleaner are off on as_of+3, so the
//                    crew is out with six stops. Crews 8 and 9 each have a
//                    morning-only stop placed so that nothing can start
//                    before noon ahead of it; the one orphan that must start
//                    in the morning has no slot in its zone and goes
//                    cross-zone; the other five fit on crews 8 and 9.
//
// Ids are scheduled_visit_id, property_id and staff_id values of the
// recorded seed's fixture; with another seed nothing is planted.
//
// The gap mirror below follows fillGap's fit and filter rules (AD-R8) with
// the adapter rules data-design §4 sets (candidates are each property's next
// booked visit within 14 days; service time is labour over the gap crew's
// headcount that day, to 15, at least 30; a monthly cadence counts 30 days).
// It proves the valid set from the data alone; the engine's own answer is a
// truth checked under npm run verify (Story 14.4).

const { toDay, toIso } = require('./days');
const { travelMinutes, isoWeekday, crewDayKey, DAY_NAMES } = require('./routing');
const { EARLIEST_START, LATEST_FINISH, NOON, SLOT_MINUTES, MIN_SCHEDULED } = require('./operations');

const S1 = Object.freeze({ crewId: 4, dayOffset: 1, stops: 7, join: Object.freeze([27]) });

const S2 = Object.freeze({
  crewId: 2,
  dayOffset: 2,
  // The crew's day, in booked order; 80 is the cancelled stop.
  route: Object.freeze([110, 100, 114, 80, 79]),
  cancelled: 80,
  bestFill: 762,
  runnerUp: 1055,
  morningDecoy: 2126,
  cadenceDecoy: 1145,
  // The estate: km [east, north] of the box's centre, then each member's
  // offset from it in km. The cancelled stop's property and its two
  // neighbours live there too. Every other home is over 5 km away.
  estateKm: Object.freeze([13.8, 15]),
  estate: Object.freeze({
    629: [0, 0], 2126: [0.1, 0], 1717: [-0.3, 0.2], 567: [0.3, -0.2], 762: [0, 0.5], 1055: [-0.4, -0.4], 1145: [0.2, 0.3],
  }),
  horizonDays: 14,
});

const S3 = Object.freeze({
  crewId: 7,
  dayOffset: 3,
  zoneCrews: Object.freeze([7, 8, 9]),
  // The lead (87) and one cleaner (55) of crew 7.
  absent: Object.freeze([87, 55]),
  routes: Object.freeze({
    7: Object.freeze([146, 135, 196, 143, 136, 171]),
    8: Object.freeze([184, 199, 172]),
    9: Object.freeze([141, 191, 163, 198, 159]),
  }),
  // Properties whose time_of_day is morning: crew 8's and crew 9's blocking
  // stops, and the orphan that must start before noon.
  morning: Object.freeze([1357, 1008, 618]),
  orphanMorning: 618,
});

const ROUTING_TARGET_IDS = Object.freeze([
  'scheduled-stops-next-14d',
  'route-optimize-s1-drive',
  'route-change-s2-top',
  'route-change-s2-count',
  'route-change-s3-crosszone',
]);
const S3_KEYS = Object.freeze(['in_zone', 'cross_zone', 'unplaced']);

const CADENCE_DAYS = { weekly: 7, biweekly: 14, monthly: 30 };
const WINDOWS = { morning: [EARLIEST_START, NOON], afternoon: [NOON, LATEST_FINISH] };

const dayOf = (asOf, offset) => toIso(toDay(asOf) + offset);
const ceilTo5 = (t) => Math.ceil(t / 5) * 5;
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

// One stop per city in turn (cities by name, stops by id), until all are
// placed: the booked order S1 is planted with.
function roundRobin(rows, city) {
  const byCity = new Map();
  for (const r of rows.slice().sort((a, b) => a.scheduled_visit_id - b.scheduled_visit_id)) {
    if (!byCity.has(city(r))) byCity.set(city(r), []);
    byCity.get(city(r)).push(r);
  }
  const queues = [...byCity.keys()].sort().map((c) => byCity.get(c));
  const out = [];
  while (out.length < rows.length) for (const q of queues) if (q.length > 0) out.push(q.shift());
  return out;
}

// The planter generate() hands to buildRouting. It keeps what it planted
// (moved visits, scenario properties) for its rules and absences.
function createPlant() {
  const reassigned = new Set();
  const s1Properties = new Set();
  const explicitRules = new Map();

  function coordinates(properties, point) {
    return properties.map((p) => {
      const offset = S2.estate[p.property_id];
      if (!offset) return p;
      const at = point([S2.estateKm[0] + offset[0], S2.estateKm[1] + offset[1]]);
      return { ...p, geo_lat_e6: at.lat, geo_lon_e6: at.lon };
    });
  }

  function schedule(rows, routes, { asOf, city }) {
    const byId = new Map(rows.map((r) => [r.scheduled_visit_id, r]));
    const take = (id, iso) => {
      const r = byId.get(id);
      if (!r || r.visit_date !== iso) throw new Error(`scenario: scheduled visit ${id} is not booked on ${iso}`);
      const from = routes.get(crewDayKey(r));
      from.splice(from.indexOf(r), 1);
      return r;
    };
    const setDay = (crewId, iso, ordered) => {
      const key = crewDayKey({ visit_date: iso, crew_id: crewId });
      const left = routes.get(key) || [];
      if (left.length > 0) throw new Error(`scenario: crew ${crewId} on ${iso} keeps visits ${left.map((r) => r.scheduled_visit_id).join(', ')} the plan does not place`);
      for (const r of ordered) {
        if (r.crew_id !== crewId) reassigned.add(r.scheduled_visit_id);
        r.crew_id = crewId;
      }
      routes.set(key, ordered);
    };

    // S1: one visit joins crew 4's day; the day is booked city by city in turn.
    const s1Day = dayOf(asOf, S1.dayOffset);
    const s1Key = crewDayKey({ visit_date: s1Day, crew_id: S1.crewId });
    const joined = S1.join.map((id) => take(id, s1Day));
    const own = routes.get(s1Key).splice(0);
    const s1Rows = own.concat(joined);
    setDay(S1.crewId, s1Day, roundRobin(s1Rows, city));
    for (const r of s1Rows) s1Properties.add(r.property_id);

    // S2: crew 2's day in the planted order; the afternoon stop is cancelled.
    const s2Day = dayOf(asOf, S2.dayOffset);
    const s2Rows = S2.route.map((id) => take(id, s2Day));
    setDay(S2.crewId, s2Day, s2Rows);
    const cancelled = byId.get(S2.cancelled);
    cancelled.status = 'cancelled';
    cancelled.status_changed_on = asOf;
    for (const pid of [S2.bestFill, S2.runnerUp, S2.cadenceDecoy]) explicitRules.set(pid, []);
    explicitRules.set(S2.morningDecoy, [{ rule_type: 'time_of_day', value: 'morning' }]);

    // S3: the zone's three crews' days in the planted orders.
    const s3Day = dayOf(asOf, S3.dayOffset);
    const s3Rows = new Map(S3.zoneCrews.map((c) => [c, S3.routes[c].map((id) => take(id, s3Day))]));
    for (const c of S3.zoneCrews) setDay(c, s3Day, s3Rows.get(c));
    for (const rowsOfCrew of s3Rows.values()) {
      for (const r of rowsOfCrew) {
        explicitRules.set(r.property_id, S3.morning.includes(r.property_id) ? [{ rule_type: 'time_of_day', value: 'morning' }] : []);
      }
    }
  }

  // S1's stops keep their drawn rules but no time window: the engine starts
  // a long day at 08:00, later than its booked start, so a booked window
  // would test the timing, not the order.
  function rules(pid, drawn) {
    if (explicitRules.has(pid)) return explicitRules.get(pid);
    if (s1Properties.has(pid)) return drawn.filter((r) => r.rule_type !== 'time_of_day');
    return drawn;
  }

  function absences({ asOf }) {
    const day = dayOf(asOf, S3.dayOffset);
    return S3.absent.map((staffId) => ({ staff_id: staffId, absence_date: day, reported_on: asOf }));
  }

  return { coordinates, schedule, rules, absences, reassigned };
}

// ---- the mirror and the checks -----------------------------------------------

// Headcount of a crew on a day: its open memberships less that day's absences.
function presentOn(tables, crewId, iso) {
  const away = new Set(tables.staff_absences.filter((a) => a.absence_date === iso).map((a) => a.staff_id));
  return tables.crew_memberships.filter((m) => m.crew_id === crewId && m.end_date === null && !away.has(m.staff_id));
}

const serviceFor = (labour, present) => Math.max(MIN_SCHEDULED, Math.round(labour / present / SLOT_MINUTES) * SLOT_MINUTES);

// Each S2 candidate with why it is in or out. Candidates are each property's
// next booked visit in (gap day, gap day + 14], less the property that
// cancelled and any property with a visit on the gap day.
function s2Candidates(tables, asOf) {
  const day = dayOf(asOf, S2.dayOffset);
  const dayNo = toDay(day);
  const place = new Map(tables.properties.map((p) => [p.property_id, { lat: p.geo_lat_e6, lon: p.geo_lon_e6 }]));
  const plans = new Map(tables.plans.map((p) => [p.plan_id, p]));
  const route = tables.scheduled_visits.filter((v) => v.crew_id === S2.crewId && v.visit_date === day).sort((a, b) => a.route_order - b.route_order);
  const k = route.findIndex((v) => v.scheduled_visit_id === S2.cancelled);
  if (k < 1 || k > route.length - 2) throw new Error(`scenario S2: visit ${S2.cancelled} is not between two stops on crew ${S2.crewId} on ${day}`);
  const prev = route[k - 1];
  const next = route[k + 1];
  const prevEnd = minutesOf(prev.scheduled_start) + prev.scheduled_minutes;
  const nextStart = minutesOf(next.scheduled_start);
  const present = presentOn(tables, S2.crewId, day).length;
  const rules = new Map();
  for (const r of tables.service_rules) rules.set(`${r.property_id}|${r.rule_type}`, r.value);
  const visitedToday = new Set(tables.scheduled_visits.filter((v) => v.visit_date === day && v.status === 'scheduled').map((v) => v.property_id));
  const lastDone = new Map();
  const later = (m, pid, iso) => { if (!m.has(pid) || m.get(pid) < iso) m.set(pid, iso); };
  for (const v of tables.visits) if (v.status === 'completed') later(lastDone, v.property_id, v.visit_date);
  for (const v of tables.scheduled_visits) if (v.status === 'scheduled' && v.visit_date < day) later(lastDone, v.property_id, v.visit_date);
  const nextVisit = new Map();
  for (const v of tables.scheduled_visits.slice().sort((a, b) => (a.visit_date < b.visit_date ? -1 : a.visit_date > b.visit_date ? 1 : a.scheduled_visit_id - b.scheduled_visit_id))) {
    if (v.status !== 'scheduled' || v.visit_date <= day || toDay(v.visit_date) > dayNo + S2.horizonDays) continue;
    if (!nextVisit.has(v.property_id)) nextVisit.set(v.property_id, v);
  }
  const direct = travelMinutes(place.get(prev.property_id), place.get(next.property_id));
  const out = [];
  for (const [pid, v] of nextVisit) {
    if (pid === route[k].property_id || visitedToday.has(pid)) continue;
    const svc = serviceFor(v.labour_minutes, present);
    const tin = travelMinutes(place.get(prev.property_id), place.get(pid));
    const tout = travelMinutes(place.get(pid), place.get(next.property_id));
    const earliest = Math.max(ceilTo5(prevEnd + tin), EARLIEST_START);
    const latest = nextStart - tout - svc;
    const fits = earliest <= latest;
    const days = rules.get(`${pid}|day_of_week`);
    const window = rules.get(`${pid}|time_of_day`);
    const dayOk = !days || days.split('|').includes(DAY_NAMES[isoWeekday(dayNo) - 1]);
    let windowOk = !window;
    for (let s = earliest; !windowOk && s <= latest; s += 5) windowOk = s >= WINDOWS[window][0] && s < WINDOWS[window][1];
    const cadence = CADENCE_DAYS[plans.get(v.plan_id).frequency];
    const prevDate = lastDone.get(pid) || null;
    const cadenceOk = prevDate === null || 2 * (dayNo - toDay(prevDate)) >= cadence;
    out.push({
      pid, fits, dayOk, windowOk, cadenceOk,
      valid: fits && dayOk && windowOk && cadenceOk,
      flexible: !days && !window,
      daysMovedUp: toDay(v.visit_date) - dayNo,
      extraDrive: tin + tout - direct,
    });
  }
  return { out, prev, next, cancelled: route[k], prevEnd, nextStart };
}

// The routing figures the generator can work out without the engine.
function routingFigures(tables, { asOf }) {
  const asOfDay = toDay(asOf);
  const s1 = tables.scheduled_visits.filter((v) => v.crew_id === S1.crewId && v.visit_date === dayOf(asOf, S1.dayOffset) && v.status === 'scheduled');
  const s2 = s2Candidates(tables, asOf).out.filter((c) => c.valid);
  const top = s2.slice().sort((a, b) => a.daysMovedUp - b.daysMovedUp || a.extraDrive - b.extraDrive || a.pid - b.pid)[0];
  return {
    'scheduled-stops-next-14d': tables.scheduled_visits.filter((v) => v.status === 'scheduled' && toDay(v.visit_date) > asOfDay && toDay(v.visit_date) <= asOfDay + 14).length,
    'route-optimize-s1-drive': s1.reduce((sum, v) => sum + v.travel_minutes_from_previous, 0),
    'route-change-s2-top': top ? top.pid : null,
    'route-change-s2-count': s2.length,
    s3Orphans: tables.scheduled_visits.filter((v) => v.crew_id === S3.crewId && v.visit_date === dayOf(asOf, S3.dayOffset) && v.status === 'scheduled').length,
  };
}

// What is wrong with the planted scenarios in `tables`, as messages.
function checkScenarios(tables, { asOf }) {
  const problems = [];
  const fail = (msg) => problems.push(`scenario ${msg}`);
  const city = new Map(tables.properties.map((p) => [p.property_id, p.city]));
  const dayRows = (crewId, offset) => tables.scheduled_visits
    .filter((v) => v.crew_id === crewId && v.visit_date === dayOf(asOf, offset))
    .sort((a, b) => a.route_order - b.route_order);
  const rulesOf = (pid) => tables.service_rules.filter((r) => r.property_id === pid).map((r) => `${r.rule_type}=${r.value}`).join(';');

  // S1
  const s1 = dayRows(S1.crewId, S1.dayOffset);
  if (s1.length !== S1.stops || s1.some((v) => v.status !== 'scheduled')) fail(`S1: crew ${S1.crewId} does not have ${S1.stops} booked stops`);
  const zigzag = roundRobin(s1, (v) => city.get(v.property_id)).map((v) => v.scheduled_visit_id).join();
  if (s1.map((v) => v.scheduled_visit_id).join() !== zigzag) fail('S1: the day is not booked city by city in turn');
  if (s1.some((v, i) => i > 0 && city.get(v.property_id) === city.get(s1[i - 1].property_id))) fail('S1: two stops in a row are in one city');
  if (new Set(s1.map((v) => city.get(v.property_id))).size < 2) fail('S1: the day has one city');

  // S2
  const gap = s2Candidates(tables, asOf);
  const c = gap.cancelled;
  if (c.scheduled_visit_id !== S2.cancelled || c.status !== 'cancelled' || c.status_changed_on !== asOf) fail(`S2: visit ${S2.cancelled} is not cancelled on as_of`);
  if (c.arrival_window !== 'afternoon' || gap.prevEnd + 5 < NOON) fail('S2: the gap is not wholly in the afternoon');
  if (dayRows(S2.crewId, S2.dayOffset).map((v) => v.scheduled_visit_id).join() !== S2.route.join()) fail('S2: crew 2\'s day is not the planted route');
  const by = new Map(gap.out.map((x) => [x.pid, x]));
  const valid = gap.out.filter((x) => x.valid).map((x) => x.pid).sort((a, b) => a - b);
  if (valid.join() !== [S2.bestFill, S2.runnerUp].sort((a, b) => a - b).join()) fail(`S2: valid fills are ${valid.join(', ')}, not the best fill and runner-up`);
  const best = by.get(S2.bestFill);
  const runner = by.get(S2.runnerUp);
  const morning = by.get(S2.morningDecoy);
  const early = by.get(S2.cadenceDecoy);
  if (!best || city.get(S2.bestFill) !== city.get(c.property_id) || best.daysMovedUp !== 3 || !best.flexible) fail('S2: the best fill is not same-city, 3 days ahead and flexible');
  if (!best || !runner || !(best.daysMovedUp < runner.daysMovedUp && best.extraDrive <= runner.extraDrive && runner.flexible)) fail('S2: the runner-up could outrank the best fill');
  if (!morning || !morning.fits || morning.windowOk || !morning.dayOk || !morning.cadenceOk || rulesOf(S2.morningDecoy) !== 'time_of_day=morning') fail('S2: the morning decoy is not left out by its time rule alone');
  if (!early || !early.fits || early.cadenceOk || !early.windowOk || !early.dayOk) fail('S2: the cadence decoy is not left out by its cadence alone');
  const fits = gap.out.filter((x) => x.fits).map((x) => x.pid).sort((a, b) => a - b);
  const planted = [S2.bestFill, S2.runnerUp, S2.morningDecoy, S2.cadenceDecoy].sort((a, b) => a - b);
  if (fits.join() !== planted.join()) fail(`S2: homes that fit the gap are ${fits.join(', ')}, not only the planted four`);

  // S3
  const s3Day = dayOf(asOf, S3.dayOffset);
  const lead = tables.staff.find((s) => S3.absent.includes(s.staff_id) && s.role === 'crew_lead');
  const present7 = presentOn(tables, S3.crewId, s3Day);
  if (!lead || present7.some((m) => m.staff_id === lead.staff_id) || present7.length !== 1) fail('S3: crew 7 is not out (lead and one cleaner absent)');
  for (const crewId of S3.zoneCrews) {
    if (dayRows(crewId, S3.dayOffset).map((v) => v.scheduled_visit_id).join() !== S3.routes[crewId].join()) fail(`S3: crew ${crewId}'s day is not the planted route`);
    if (crewId !== S3.crewId && presentOn(tables, crewId, s3Day).length !== 3) fail(`S3: crew ${crewId} is short-handed`);
  }
  const orphans = dayRows(S3.crewId, S3.dayOffset).filter((v) => v.status === 'scheduled');
  const o6 = orphans.find((v) => v.property_id === S3.orphanMorning);
  if (orphans.length !== 6 || !o6 || o6.arrival_window !== 'morning') fail('S3: crew 7 does not have six booked stops with the morning-only one among them');
  for (const pid of S3.morning) if (rulesOf(pid) !== 'time_of_day=morning') fail(`S3: property ${pid} is not morning-only`);
  return problems;
}

// targets.json `routing`: a whole number for each id but the S3 split.
function checkRoutingTargets(routing, where) {
  const ids = Object.keys(routing || {}).sort();
  const bad = ids.join() !== ROUTING_TARGET_IDS.slice().sort().join()
    || !ROUTING_TARGET_IDS.every((id) => {
      const v = routing[id];
      if (id === 'route-change-s3-crosszone') {
        return v !== null && typeof v === 'object' && Object.keys(v).sort().join() === S3_KEYS.slice().sort().join()
          && S3_KEYS.every((key) => Number.isSafeInteger(v[key]) && v[key] >= 0);
      }
      return Number.isSafeInteger(v) && v >= 0;
    });
  if (bad) throw new Error(`${where}: routing must give a whole number for ${ROUTING_TARGET_IDS.filter((id) => id !== 'route-change-s3-crosszone').join(', ')} and { ${S3_KEYS.join(', ')} } for route-change-s3-crosszone`);
  return routing;
}

// The routing targets the generator can check: every one but S3's split,
// which only the engine works out (Story 14.4); its parts must add up to
// crew 7's booked stops.
function missedRoutingTargets(tables, routing, { asOf }) {
  const got = routingFigures(tables, { asOf });
  const missed = [];
  for (const id of ROUTING_TARGET_IDS.filter((x) => x !== 'route-change-s3-crosszone')) {
    if (got[id] !== routing[id]) missed.push(`${id} ${got[id]} (target ${routing[id]})`);
  }
  if (routing['route-change-s2-top'] !== S2.bestFill) missed.push(`route-change-s2-top target ${routing['route-change-s2-top']} is not the planted best fill ${S2.bestFill}`);
  const s3 = routing['route-change-s3-crosszone'];
  if (s3.in_zone + s3.cross_zone + s3.unplaced !== got.s3Orphans) missed.push(`route-change-s3-crosszone adds up to ${s3.in_zone + s3.cross_zone + s3.unplaced}, not crew 7's ${got.s3Orphans} stops`);
  return missed;
}

module.exports = {
  createPlant,
  checkScenarios,
  checkRoutingTargets,
  missedRoutingTargets,
  routingFigures,
  s2Candidates,
  roundRobin,
  ROUTING_TARGET_IDS,
  S1,
  S2,
  S3,
};
