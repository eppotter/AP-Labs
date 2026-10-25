'use strict';

// The rules for the operations data (lib/operations.js): staff and pay,
// home details, the schedule and timesheets. The generator refuses to write
// output that breaks one; the SQL checks in checks/ test the same rules on the
// built database. Kept apart from rules.js so each rule there still reports
// once when an operations table depends on the row it breaks. Keys, foreign
// keys, NOT NULL and unique columns are checked in rules.js for every table.

const { toDay } = require('./days');
const {
  ROLE_LEAD, ROLE_CLEANER, RATE_BOUNDS, HOME_TYPES, ACCESS_METHODS,
  EARLIEST_START, TRAVEL_BOUNDS, SLOT_MINUTES, MIN_SCHEDULED,
} = require('./operations');

const BATHROOMS = /^[1-5]\.[05]$/;
const TIME = /^(\d\d):(\d\d):00$/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d\d):(\d\d):00$/;

const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const k = typeof key === 'function' ? key(row) : row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
};

const covers = (row, iso) => row.start_date <= iso && (row.end_date === null || row.end_date >= iso);

function minuteOf(ts) {
  const m = TIMESTAMP.exec(ts);
  if (!m) return null;
  return toDay(m[1]) * 1440 + Number(m[2]) * 60 + Number(m[3]);
}

function checkOperations(tables, { asOf }) {
  const problems = [];
  const fail = (msg) => problems.push(msg);
  if (!tables.staff) return problems;

  // Staff: one row per crew_memberships name; employment spans the memberships.
  const membershipsOf = groupBy(tables.crew_memberships, 'staff_id');
  for (const s of tables.staff) {
    const where = `staff ${s.staff_id}`;
    if (s.role !== ROLE_LEAD && s.role !== ROLE_CLEANER) fail(`${where}: role ${s.role} is not ${ROLE_CLEANER} or ${ROLE_LEAD}`);
    const own = membershipsOf.get(s.staff_id) || [];
    if (own.length === 0) { fail(`${where}: has no crew membership`); continue; }
    for (const m of own) if (m.staff_name !== s.name) fail(`crew_memberships ${m.membership_id}: staff_name ${m.staff_name} is not staff ${s.staff_id}'s name`);
    const firstStart = own.reduce((min, m) => (m.start_date < min ? m.start_date : min), own[0].start_date);
    if (s.hire_date > firstStart) fail(`${where}: hired after their first crew membership starts`);
    const open = own.some((m) => m.end_date === null);
    const lastEnd = own.reduce((max, m) => (m.end_date !== null && m.end_date > max ? m.end_date : max), '');
    if (open ? s.end_date !== null : s.end_date !== lastEnd) fail(`${where}: end_date ${s.end_date} does not match their crew memberships`);
    if (s.end_date !== null && s.end_date > asOf) fail(`${where}: end_date after as_of ${asOf}`);
  }

  // Pay: contiguous periods from hire_date to end_date, rates within the
  // role's bounds, and staff's role and rate are the latest period's.
  const staffById = new Map(tables.staff.map((s) => [s.staff_id, s]));
  const ratesOf = groupBy(tables.pay_rates, 'staff_id');
  for (const s of tables.staff) {
    const periods = (ratesOf.get(s.staff_id) || []).slice().sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
    const where = `pay_rates for staff ${s.staff_id}`;
    if (periods.length === 0) { fail(`${where}: none`); continue; }
    if (periods[0].start_date !== s.hire_date) fail(`${where}: the first period does not start on hire_date`);
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      const bounds = RATE_BOUNDS[p.role];
      if (!bounds) fail(`pay_rates ${p.rate_id}: role ${p.role} is not ${ROLE_CLEANER} or ${ROLE_LEAD}`);
      else if (p.hourly_rate_cents < bounds[0] || p.hourly_rate_cents > bounds[1]) fail(`pay_rates ${p.rate_id}: ${p.hourly_rate_cents} is outside ${p.role} bounds`);
      if (p.end_date !== null && p.end_date < p.start_date) fail(`pay_rates ${p.rate_id}: ends before it starts`);
      const next = periods[i + 1];
      if (next && (p.end_date === null || toDay(next.start_date) !== toDay(p.end_date) + 1)) fail(`pay_rates ${next.rate_id}: does not start the day after the previous period ends`);
    }
    const last = periods[periods.length - 1];
    if (last.end_date !== s.end_date) fail(`${where}: the last period does not end on end_date`);
    if (last.role !== s.role || last.hourly_rate_cents !== s.hourly_rate_cents) fail(`staff ${s.staff_id}: role and rate are not the latest pay period's`);
  }
  const roleOn = (staffId, iso) => ((ratesOf.get(staffId) || []).find((p) => covers(p, iso)) || {}).role;

  // One crew lead per crew on every date a membership starts.
  const crewMembers = groupBy(tables.crew_memberships, 'crew_id');
  for (const [crewId, rows] of crewMembers) {
    for (const iso of new Set(rows.map((m) => m.start_date))) {
      const leads = rows.filter((m) => covers(m, iso) && roleOn(m.staff_id, iso) === ROLE_LEAD).length;
      if (leads !== 1) fail(`crews ${crewId}: ${leads} crew leads on ${iso}`);
    }
  }

  // Home details: values in range, and rooms that fit the floor area.
  for (const p of tables.properties) {
    const where = `properties ${p.property_id}`;
    if (!HOME_TYPES.includes(p.home_type)) fail(`${where}: home_type ${p.home_type} is not one of ${HOME_TYPES.join(', ')}`);
    if (!(p.square_feet >= 400 && p.square_feet <= 6000)) fail(`${where}: square_feet ${p.square_feet} is outside 400 to 6000`);
    if (!(p.bedrooms >= 1 && p.bedrooms <= 6)) fail(`${where}: bedrooms ${p.bedrooms} is outside 1 to 6`);
    if (!BATHROOMS.test(p.bathrooms)) fail(`${where}: bathrooms ${p.bathrooms} is not 1.0 to 5.5 in halves`);
    else if (Number(p.bathrooms) > p.bedrooms + 2) fail(`${where}: more bathrooms than the bedrooms allow`);
    if (p.square_feet < p.bedrooms * 250) fail(`${where}: ${p.bedrooms} bedrooms do not fit ${p.square_feet} square feet`);
    if (p.has_pets !== 'true' && p.has_pets !== 'false') fail(`${where}: has_pets ${p.has_pets} is not true or false`);
    if (!ACCESS_METHODS.includes(p.access_method)) fail(`${where}: access_method ${p.access_method} is not one of ${ACCESS_METHODS.join(', ')}`);
  }

  // The schedule: route_order is 1..n per crew-day, and each stop starts no
  // earlier than the previous one ends plus the travel between them.
  for (const day of groupBy(tables.visits, (v) => `${v.crew_id}|${v.visit_date}`).values()) {
    const route = day.slice().sort((a, b) => a.route_order - b.route_order);
    if (route.some((v, i) => v.route_order !== i + 1)) fail(`crew ${day[0].crew_id} on ${day[0].visit_date}: route_order is not 1 to ${route.length}`);
    let prevEnd = null;
    for (const v of route) {
      const where = `visits ${v.visit_id}`;
      const m = TIME.exec(v.scheduled_start);
      if (!m) { fail(`${where}: scheduled_start ${v.scheduled_start} is not HH:MM:00`); continue; }
      const start = Number(m[1]) * 60 + Number(m[2]);
      if (v.arrival_window !== (start < 720 ? 'morning' : 'afternoon')) fail(`${where}: arrival_window ${v.arrival_window} disagrees with scheduled_start ${v.scheduled_start}`);
      if (!(v.scheduled_minutes >= MIN_SCHEDULED && v.scheduled_minutes % SLOT_MINUTES === 0)) fail(`${where}: scheduled_minutes ${v.scheduled_minutes} is not a whole number of ${SLOT_MINUTES}-minute slots from ${MIN_SCHEDULED}`);
      const travel = v.travel_minutes_from_previous;
      if (!(travel >= TRAVEL_BOUNDS[0] && travel <= TRAVEL_BOUNDS[1])) fail(`${where}: travel ${travel} is outside ${TRAVEL_BOUNDS[0]} to ${TRAVEL_BOUNDS[1]} minutes`);
      if (prevEnd === null ? start < EARLIEST_START : start < prevEnd + travel) fail(`${where}: starts before the crew can get there`);
      prevEnd = start + v.scheduled_minutes;
    }
  }

  // Timesheets: completed visits only, by the crew's members that day, on the
  // visit date, with consistent times and nobody in two places at once.
  const visits = new Map(tables.visits.map((v) => [v.visit_id, v]));
  const sheetsOf = groupBy(tables.timesheets, 'visit_id');
  for (const v of tables.visits) {
    if (v.status === 'completed' && !sheetsOf.has(v.visit_id)) fail(`visits ${v.visit_id}: completed but has no timesheet`);
  }
  const memberships = groupBy(tables.crew_memberships, 'staff_id');
  for (const t of tables.timesheets) {
    const where = `timesheets ${t.timesheet_id}`;
    const v = visits.get(t.visit_id);
    if (!v || !staffById.has(t.staff_id)) continue; // reported as a foreign key
    if (v.status !== 'completed') fail(`${where}: visit ${v.visit_id} is ${v.status}`);
    if (!(memberships.get(t.staff_id) || []).some((m) => m.crew_id === v.crew_id && covers(m, v.visit_date))) {
      fail(`${where}: staff ${t.staff_id} is not on crew ${v.crew_id} on ${v.visit_date}`);
    }
    const inAt = minuteOf(t.clock_in);
    const outAt = minuteOf(t.clock_out);
    if (inAt === null || outAt === null) { fail(`${where}: clock_in or clock_out is not a timestamp`); continue; }
    if (t.clock_in.slice(0, 10) !== v.visit_date) fail(`${where}: clock_in is not on visit ${v.visit_id}'s date`);
    if (outAt <= inAt) fail(`${where}: clock_out is not after clock_in`);
    else if (t.minutes !== outAt - inAt) fail(`${where}: minutes ${t.minutes} is not clock_out - clock_in`);
  }
  for (const [staffId, sheets] of groupBy(tables.timesheets, 'staff_id')) {
    const sorted = sheets.map((t) => ({ t, inAt: minuteOf(t.clock_in), outAt: minuteOf(t.clock_out) }))
      .filter((x) => x.inAt !== null && x.outAt !== null)
      .sort((a, b) => a.inAt - b.inAt || a.t.timesheet_id - b.t.timesheet_id);
    let latest = -Infinity;
    for (const x of sorted) {
      if (x.inAt < latest) fail(`timesheets ${x.t.timesheet_id}: staff ${staffId} is already clocked in elsewhere`);
      latest = Math.max(latest, x.outAt);
    }
  }
  return problems;
}

module.exports = { checkOperations };
