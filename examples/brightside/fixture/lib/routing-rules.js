'use strict';

// The rules for the routing data (lib/routing.js): coordinates, the booked
// schedule, the customers' rules and staff absences. The generator refuses
// to write output that breaks one; the SQL checks test the same rules on the
// built database:
//   synthetic-coordinates            every coordinate inside the fixture box
//   integrity-scheduled-route-order  route_order 1..n per crew-day
//   integrity-scheduled-schedule     times fit the day and the drives
//   integrity-scheduled-after-as-of  dates after as_of, statuses set by then
//   integrity-scheduled-cadence      each active plan's dates follow its cadence
//   integrity-rules                  rule values valid; booked visits keep
//                                    every hard rule
//   integrity-staff-absences         absences after as_of, reported by then,
//                                    on a membership that covers the day
// Two rules here go further than SQL can: each booked drive is travelMatrix's
// figure for its two places (SQL would have to read coordinates), and a
// booked visit is on its plan's own crew unless the planted scenarios moved
// it (SQL allows any crew of the plan crew's zone; it cannot know which
// visits were planted). Keys, foreign keys, NOT NULL and unique columns are
// checked in rules.js.

const { toDay, toIso } = require('./days');
const { scheduleDays } = require('./activity');
const { EARLIEST_START, LATEST_FINISH, NOON, SLOT_MINUTES, MIN_SCHEDULED } = require('./operations');
const { travelMinutes, isoWeekday, BOX, MIN_TRAVEL_MINUTES, SCHEDULE_HORIZON_DAYS, DAY_NAMES, RULE_STRENGTH } = require('./routing');

const TIME = /^(\d\d):(\d\d):00$/;
const STATUSES = new Set(['scheduled', 'cancelled']);

const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const k = typeof key === 'function' ? key(row) : row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
};

const inBox = (lat, lon) => Number.isSafeInteger(lat) && Number.isSafeInteger(lon)
  && lat >= BOX.latMin && lat <= BOX.latMax && lon >= BOX.lonMin && lon <= BOX.lonMax;

function checkCoordinates(tables, fail) {
  for (const p of tables.properties) {
    if (!inBox(p.geo_lat_e6, p.geo_lon_e6)) fail(`properties ${p.property_id}: coordinates outside the synthetic box`);
  }
  for (const c of tables.crews) {
    if (!inBox(c.base_geo_lat_e6, c.base_geo_lon_e6)) fail(`crews ${c.crew_id}: base coordinates outside the synthetic box`);
  }
}

function checkSchedule(tables, fail) {
  const place = new Map(tables.properties.map((p) => [p.property_id, { lat: p.geo_lat_e6, lon: p.geo_lon_e6 }]));
  const base = new Map(tables.crews.map((c) => [c.crew_id, { lat: c.base_geo_lat_e6, lon: c.base_geo_lon_e6 }]));
  for (const day of groupBy(tables.scheduled_visits, (v) => `${v.crew_id}|${v.visit_date}`).values()) {
    const route = day.slice().sort((a, b) => a.route_order - b.route_order);
    const at = `crew ${day[0].crew_id} on ${day[0].visit_date}`;
    if (route.some((v, i) => v.route_order !== i + 1)) { fail(`${at}: scheduled route_order is not 1 to ${route.length}`); continue; }
    let prevEnd = null;
    let from = base.get(day[0].crew_id);
    for (const v of route) {
      const where = `scheduled_visits ${v.scheduled_visit_id}`;
      const to = place.get(v.property_id);
      if (from && to && v.travel_minutes_from_previous !== travelMinutes(from, to)) fail(`${where}: travel is not travelMatrix's figure for its two places`);
      from = to;
      const m = TIME.exec(v.scheduled_start);
      if (!m) { fail(`${where}: scheduled_start ${v.scheduled_start} is not HH:MM:00`); continue; }
      const start = Number(m[1]) * 60 + Number(m[2]);
      if (v.arrival_window !== (start < NOON ? 'morning' : 'afternoon')) fail(`${where}: arrival_window ${v.arrival_window} disagrees with scheduled_start ${v.scheduled_start}`);
      if (!(v.scheduled_minutes >= MIN_SCHEDULED && v.scheduled_minutes % SLOT_MINUTES === 0)) fail(`${where}: scheduled_minutes ${v.scheduled_minutes} is not a whole number of ${SLOT_MINUTES}-minute slots from ${MIN_SCHEDULED}`);
      if (!(Number.isSafeInteger(v.labour_minutes) && v.labour_minutes > 0)) fail(`${where}: labour_minutes ${v.labour_minutes} is not a positive whole number`);
      const travel = v.travel_minutes_from_previous;
      if (!(Number.isSafeInteger(travel) && travel >= MIN_TRAVEL_MINUTES)) fail(`${where}: travel ${travel} is under ${MIN_TRAVEL_MINUTES} minutes`);
      if (prevEnd === null ? start < EARLIEST_START + travel : start < prevEnd + travel) fail(`${where}: starts before the crew can get there`);
      if (start + v.scheduled_minutes > LATEST_FINISH) fail(`${where}: ends after 23:00`);
      prevEnd = start + v.scheduled_minutes;
    }
  }
}

function checkDates(tables, asOf, fail) {
  const horizonEnd = toIso(toDay(asOf) + SCHEDULE_HORIZON_DAYS);
  for (const v of tables.scheduled_visits) {
    const where = `scheduled_visits ${v.scheduled_visit_id}`;
    if (!(v.visit_date > asOf && v.visit_date <= horizonEnd)) fail(`${where}: visit_date ${v.visit_date} is outside after ${asOf} to ${horizonEnd}`);
    if (!STATUSES.has(v.status)) fail(`${where}: status ${v.status} is not scheduled or cancelled`);
    if (!(v.status_changed_on <= asOf)) fail(`${where}: status_changed_on ${v.status_changed_on} is after as_of ${asOf}`);
  }
}

// Each active plan has exactly its cadence dates after as_of through the
// horizon, on its property, package and crew; an ended plan has none. The
// first is the next cadence date after the plan's last history visit.
function checkCadence(tables, asOf, reassigned, fail) {
  const zoneOf = new Map(tables.crews.map((c) => [c.crew_id, c.zone_id]));
  const asOfDay = toDay(asOf);
  const horizonEnd = asOfDay + SCHEDULE_HORIZON_DAYS;
  const history = groupBy(tables.visits.filter((v) => v.plan_id !== null), 'plan_id');
  const booked = groupBy(tables.scheduled_visits, 'plan_id');
  for (const plan of tables.plans) {
    const where = `plan ${plan.plan_id}`;
    const own = (booked.get(plan.plan_id) || []).slice().sort((a, b) => (a.visit_date < b.visit_date ? -1 : a.visit_date > b.visit_date ? 1 : 0));
    if (plan.end_date !== null) {
      if (own.length > 0) fail(`${where}: ended ${plan.end_date} but has booked visits`);
      continue;
    }
    const past = (history.get(plan.plan_id) || []).slice().sort((a, b) => (a.visit_date < b.visit_date ? -1 : 1));
    const last = past[past.length - 1];
    const want = scheduleDays({ start: toDay(plan.start_date), frequency: plan.frequency }, horizonEnd).filter((d) => d > asOfDay).map(toIso);
    if (own.map((v) => v.visit_date).join() !== want.join()) fail(`${where}: booked dates do not follow its ${plan.frequency} cadence`);
    if (last && want.length > 0 && scheduleDays({ start: toDay(plan.start_date), frequency: plan.frequency }, toDay(want[0])).map(toIso).slice(-2)[0] !== last.visit_date) {
      fail(`${where}: the first booked date is not the next cadence date after its last visit`);
    }
    for (const v of own) {
      if (v.property_id !== plan.property_id || v.package_id !== plan.package_id) fail(`scheduled_visits ${v.scheduled_visit_id}: not plan ${plan.plan_id}'s property and package`);
      if (last && v.crew_id !== last.crew_id && !(reassigned.has(v.scheduled_visit_id) && zoneOf.get(v.crew_id) === zoneOf.get(last.crew_id))) {
        fail(`scheduled_visits ${v.scheduled_visit_id}: not plan ${plan.plan_id}'s crew`);
      }
    }
  }
  for (const v of tables.scheduled_visits) {
    if (v.plan_id === null || v.plan_id === undefined) fail(`scheduled_visits ${v.scheduled_visit_id}: has no plan`);
  }
}

const DAY_VALUE = new RegExp(`^(${DAY_NAMES.join('|')})(\\|(${DAY_NAMES.join('|')}))*$`);
const WINDOWS = new Set(['morning', 'afternoon']);

// Each rule's value is valid for its type, at its type's strength, and every
// booked (scheduled) visit of the property keeps it: on one of its days, in
// its window, on its preferred crew. A preferred crew is in the property's
// zone. Days are in week order with no repeat.
function checkServiceRules(tables, fail) {
  const crews = new Map(tables.crews.map((c) => [c.crew_id, c]));
  const zones = new Set((tables.zones || []).map((z) => z.zone_id));
  const clientZone = new Map(tables.clients.map((c) => [c.client_id, c.zone_id]));
  const zoneOfProperty = new Map(tables.properties.map((p) => [p.property_id, clientZone.get(p.client_id)]));
  const booked = groupBy(tables.scheduled_visits.filter((v) => v.status === 'scheduled'), 'property_id');
  for (const r of tables.service_rules) {
    const where = `service_rules ${r.rule_id}`;
    if (!(r.rule_type in RULE_STRENGTH)) { fail(`${where}: rule_type ${r.rule_type} is not preferred_crew, day_of_week or time_of_day`); continue; }
    if (r.strength !== RULE_STRENGTH[r.rule_type]) fail(`${where}: ${r.rule_type} is ${RULE_STRENGTH[r.rule_type]}, not ${r.strength}`);
    const visits = booked.get(r.property_id) || [];
    if (r.rule_type === 'preferred_crew') {
      const crew = /^\d+$/.test(r.value) ? crews.get(Number(r.value)) : undefined;
      if (!crew) { fail(`${where}: preferred_crew ${r.value} is not a crew`); continue; }
      // A crew whose zone is unknown is a foreign-key finding (rules.js).
      if (zones.has(crew.zone_id) && crew.zone_id !== zoneOfProperty.get(r.property_id)) fail(`${where}: preferred crew ${r.value} is not in the property's zone`);
      if (visits.some((v) => v.crew_id !== crew.crew_id)) fail(`${where}: a booked visit is not on preferred crew ${r.value}`);
    } else if (r.rule_type === 'day_of_week') {
      const days = String(r.value).split('|');
      const order = days.map((d) => DAY_NAMES.indexOf(d));
      if (!DAY_VALUE.test(r.value) || order.some((d, i) => i > 0 && d <= order[i - 1])) { fail(`${where}: day_of_week ${r.value} is not ISO day names in week order`); continue; }
      for (const v of visits) {
        if (!days.includes(DAY_NAMES[isoWeekday(toDay(v.visit_date)) - 1])) fail(`${where}: scheduled_visits ${v.scheduled_visit_id} on ${v.visit_date} is not on ${r.value}`);
      }
    } else {
      if (!WINDOWS.has(r.value)) { fail(`${where}: time_of_day ${r.value} is not morning or afternoon`); continue; }
      for (const v of visits) {
        if (v.arrival_window !== r.value) fail(`${where}: scheduled_visits ${v.scheduled_visit_id} is booked in the ${v.arrival_window}, not the ${r.value}`);
      }
    }
  }
}

// Each absence is after as_of through the horizon, reported on or before
// as_of, by someone whose membership covers the day (end_date inclusive).
function checkAbsences(tables, asOf, fail) {
  const horizonEnd = toIso(toDay(asOf) + SCHEDULE_HORIZON_DAYS);
  const memberships = groupBy(tables.crew_memberships, 'staff_id');
  for (const a of tables.staff_absences) {
    const where = `staff_absences ${a.absence_id}`;
    if (!(a.absence_date > asOf && a.absence_date <= horizonEnd)) fail(`${where}: absence_date ${a.absence_date} is outside after ${asOf} to ${horizonEnd}`);
    if (!(a.reported_on <= asOf)) fail(`${where}: reported_on ${a.reported_on} is after as_of ${asOf}`);
    const covers = (memberships.get(a.staff_id) || []).some((m) => m.start_date <= a.absence_date && (m.end_date === null || m.end_date >= a.absence_date));
    if (!covers) fail(`${where}: staff ${a.staff_id} has no membership on ${a.absence_date}`);
  }
}

// `reassigned` holds the scheduled_visit_ids the planted scenarios moved to
// another crew of the same zone; with none planted, every visit is on its
// plan's crew.
function checkRouting(tables, { asOf, reassigned = new Set() }) {
  const problems = [];
  const fail = (msg) => problems.push(msg);
  if (!tables.scheduled_visits) return problems;
  checkCoordinates(tables, fail);
  checkSchedule(tables, fail);
  checkDates(tables, asOf, fail);
  checkCadence(tables, asOf, reassigned, fail);
  if (tables.service_rules) checkServiceRules(tables, fail);
  if (tables.staff_absences) checkAbsences(tables, asOf, fail);
  return problems;
}

module.exports = { checkRouting };
