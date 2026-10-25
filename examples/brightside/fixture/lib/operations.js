'use strict';

// Brightside's operations data: labour (staff, pay_rates, timesheets), home
// details (columns appended to properties) and the schedule (columns appended
// to visits; crew_memberships gains staff_id).
//
// It runs after the reference and activity tables are final and only reads
// them. Every draw comes from its own stream (the rng passed in, seeded with
// deriveSeed(seed, OPERATIONS_STREAM)), never the main one, so no earlier draw
// moves: every existing column keeps its values byte for byte. Draw order
// inside the stream is fixed: staff, home details, then each crew-day's
// route and timesheets in date then crew order.
//
// The model, in short:
// - Each crew has three slots; slot 0 is the crew lead. A person's role is the
//   role of the slot they hold, so a crew always has exactly one lead.
// - Pay: cleaners are hired at $17.00-20.00, leads at $22.00-25.00, in 25-cent
//   steps; a 2-5% raise on each hire anniversary; a move into the lead slot is
//   a promotion (+$3.00, at least $22.00); a move out of it caps the rate at
//   the cleaner maximum. Cleaners stay within $17.00-24.00, leads $22.00-30.00.
// - A home's size follows its price: a plan's size factor (its start price
//   over the package base) picks the size band, and about one home in five is
//   a band off (priced as smaller or bigger than it is). Rooms follow size.
// - A visit's scheduled minutes are the crew's planned time on site: labour
//   minutes from the package, square feet, bathrooms, pets and add-ons,
//   divided by the crew's headcount, rounded up to 15. Every member works
//   every completed visit. Each home has a hidden difficulty, so some homes
//   overrun every time, and any visit can overrun.
// - A crew's day is one route through its visits, grouped by city. Travel is
//   5-15 minutes inside a city and longer between cities; the first stop's
//   travel is from the crew's base. A long day starts earlier (never before
//   06:00) and runs late: the data keeps every visit, so overloaded days show.
//   A plan that cannot fit 06:00 to 23:00 even then is squeezed (see below).

const { toDay, toIso } = require('./days');

const OPERATIONS_STREAM = 'labour/homes/schedule';

const ROLE_LEAD = 'crew_lead';
const ROLE_CLEANER = 'cleaner';
const RATE_STEP = 25;
const RATE_BOUNDS = { [ROLE_CLEANER]: [1700, 2400], [ROLE_LEAD]: [2200, 3000] };
const HIRE_RATE = { [ROLE_CLEANER]: [1700, 2000], [ROLE_LEAD]: [2200, 2500] };
const RAISE_PCT = [2, 5];
const PROMOTION_CENTS = 300;
// Staff already on a crew at history start were hired up to six years before.
const PRIOR_TENURE_DAYS = [30, 2190];

// Mirrors activity.js: the plan price is base * size% * frequency discount%.
const FREQUENCY_DISCOUNT = { weekly: 90, biweekly: 95, monthly: 100 };
const SIZE_BANDS = [90, 100, 110, 125, 150];
const SIZE_WEIGHTS = [[90, 2], [100, 4], [110, 3], [125, 2], [150, 1]];
const BAND_SQFT = { 90: 1100, 100: 1450, 110: 1800, 125: 2300, 150: 3100 };
const MISMATCH_CHANCE = 0.2;
const HOME_TYPES = ['apartment', 'condo', 'townhouse', 'house'];
// Weights by square feet: [upper bound, [apartment, condo, townhouse, house]].
const TYPE_BY_SQFT = [[900, [6, 3, 0, 1]], [1400, [3, 4, 3, 3]], [2200, [1, 2, 4, 6]], [Infinity, [0, 1, 2, 9]]];
const MAX_BEDROOMS = { apartment: 3, condo: 3, townhouse: 4, house: 6 };
const HALF_BATH_CHANCE = { apartment: 0.1, condo: 0.2, townhouse: 0.5, house: 0.55 };
const PET_CHANCE = 0.45;
const ACCESS = {
  apartment: [['client_home', 4], ['door_code_on_file', 3], ['key', 3], ['lockbox', 1]],
  condo: [['client_home', 3], ['door_code_on_file', 3], ['key', 2], ['lockbox', 2]],
  townhouse: [['client_home', 3], ['door_code_on_file', 2], ['key', 2], ['lockbox', 3]],
  house: [['client_home', 3], ['door_code_on_file', 2], ['key', 2], ['lockbox', 3]],
};
// A home's hidden difficulty, as a percentage of the expected time.
const DIFFICULTY = [[92, 3], [100, 8], [110, 3], [125, 1]];

// Labour minutes (the whole crew's) for a visit.
const PACKAGE_LABOUR = {
  standard: { base: 36, perSqft: 0.065 },
  deep: { base: 75, perSqft: 0.11 },
  move_out: { base: 95, perSqft: 0.14 },
};
const BATHROOM_LABOUR = 12;
const PET_LABOUR = 15;
const ADD_ON_LABOUR = { baseboards: 30, fridge: 20, laundry: 25, oven: 30, windows: 35 };
const SLOT_MINUTES = 15;
const MIN_SCHEDULED = 30;

const DAY_START = 8 * 60;
const EARLIEST_START = 6 * 60;
const AIM_TO_FINISH = 18 * 60;
const LATEST_FINISH = 23 * 60;
const NOON = 12 * 60;
const MIDNIGHT = 24 * 60;
const TRAVEL = {
  base: { central: [5, 20], other: [10, 35] },
  sameCity: [5, 12],
  otherCity: { central: [10, 25], other: [15, 35] },
};
const ARRIVAL_JITTER = [-10, 10];
// Actual time on site as a % of planned: mostly close, sometimes a real overrun.
const DURATION_NOISE = [[[88, 108], 75], [[108, 130], 20], [[130, 160], 5]];
const LEAVE_EARLY_CHANCE = 0.3;
const LEAVE_EARLY_MAX = 10;
const MIN_ON_SITE = 20;

const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const k = typeof key === 'function' ? key(row) : row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
};

const roundToStep = (cents) => Math.round(cents / RATE_STEP) * RATE_STEP;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ceilTo = (v, step) => Math.ceil(v / step) * step;
const pad2 = (n) => String(n).padStart(2, '0');

function clockTime(minuteOfDay) {
  return `${pad2(Math.floor(minuteOfDay / 60))}:${pad2(minuteOfDay % 60)}:00`;
}

// A local timestamp `minute` minutes after the start of `day` (may pass midnight).
function timestamp(day, minute) {
  const extra = Math.floor(minute / MIDNIGHT);
  return `${toIso(day + extra)} ${clockTime(minute - extra * MIDNIGHT)}`;
}

function shuffled(rng, list) {
  const pool = list.slice();
  const out = [];
  while (pool.length > 0) out.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
  return out;
}

// ---- staff and pay --------------------------------------------------------

// The slot each membership holds. The reference generator fills slots in
// order at history start and refills a slot the day after it empties; rows
// sharing a start date and crew are in slot order. Replaying that gives each
// membership its slot exactly. Slot 0 is the crew lead.
function membershipRoles(memberships, historyStart) {
  const start = toDay(historyStart);
  const role = new Map();
  for (const rows of groupBy(memberships, 'crew_id').values()) {
    const slots = [];
    const byStart = groupBy(rows.slice().sort((a, b) => a.membership_id - b.membership_id), 'start_date');
    for (const [startDate, joining] of [...byStart].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const day = toDay(startDate);
      let free;
      if (day === start) free = joining.map((_, i) => i);
      else {
        free = slots.map((m, i) => (m.end_date !== null && toDay(m.end_date) === day - 1 ? i : -1)).filter((i) => i >= 0);
      }
      if (free.length !== joining.length) {
        throw new Error(`crew ${joining[0].crew_id}: ${joining.length} membership(s) start ${startDate} but ${free.length} slot(s) are free`);
      }
      joining.forEach((m, i) => {
        slots[free[i]] = m;
        role.set(m.membership_id, free[i] === 0 ? ROLE_LEAD : ROLE_CLEANER);
      });
    }
  }
  return role;
}

function hireRate(rng, role) {
  const [lo, hi] = HIRE_RATE[role];
  return lo + rng.int(0, (hi - lo) / RATE_STEP) * RATE_STEP;
}

function rateForRole(rate, from, to) {
  if (from === to) return rate;
  if (to === ROLE_LEAD) return Math.min(RATE_BOUNDS[ROLE_LEAD][1], Math.max(rate + PROMOTION_CENTS, RATE_BOUNDS[ROLE_LEAD][0]));
  return Math.min(rate, RATE_BOUNDS[ROLE_CLEANER][1]);
}

function buildStaff(rng, memberships, { historyStart, asOf }) {
  const historyDay = toDay(historyStart);
  const roles = membershipRoles(memberships, historyStart);
  const byName = groupBy(memberships.slice().sort((a, b) => a.membership_id - b.membership_id), 'staff_name');
  const staff = [];
  const payRates = [];
  const staffIdOf = new Map();
  for (const [name, own] of byName) {
    const staffId = staff.length + 1;
    staffIdOf.set(name, staffId);
    const periods = own.slice().sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.membership_id - b.membership_id));
    const firstStart = toDay(periods[0].start_date);
    const hire = firstStart === historyDay ? firstStart - rng.int(PRIOR_TENURE_DAYS[0], PRIOR_TENURE_DAYS[1]) : firstStart;
    const lastEnd = periods[periods.length - 1].end_date;
    const end = lastEnd === null ? null : toDay(lastEnd);
    const until = end === null ? asOf : end;

    let role = roles.get(periods[0].membership_id);
    let rate = hireRate(rng, role);
    // Events after hire: anniversaries (raise) and role changes (a new slot).
    const events = new Map();
    for (let d = hire + 365; d <= until; d += 365) events.set(d, { raise: true, role: null });
    for (const m of periods.slice(1)) {
      const d = toDay(m.start_date);
      const ev = events.get(d) || { raise: false, role: null };
      ev.role = roles.get(m.membership_id);
      events.set(d, ev);
    }
    const rows = [{ start: hire, role, rate }];
    for (const d of [...events.keys()].sort((a, b) => a - b)) {
      const ev = events.get(d);
      let nextRole = role;
      let nextRate = rate;
      if (ev.role !== null && ev.role !== role) {
        nextRate = rateForRole(nextRate, role, ev.role);
        nextRole = ev.role;
      }
      if (ev.raise) {
        const pct = rng.int(RAISE_PCT[0], RAISE_PCT[1]);
        nextRate = Math.min(RATE_BOUNDS[nextRole][1], roundToStep((nextRate * (100 + pct)) / 100));
      }
      if (nextRole === role && nextRate === rate) continue;
      role = nextRole;
      rate = nextRate;
      rows.push({ start: d, role, rate });
    }
    rows.forEach((r, i) => {
      const next = rows[i + 1];
      payRates.push({
        rate_id: payRates.length + 1,
        staff_id: staffId,
        start_date: toIso(r.start),
        end_date: next ? toIso(next.start - 1) : end === null ? null : toIso(end),
        role: r.role,
        hourly_rate_cents: r.rate,
      });
    });
    staff.push({
      staff_id: staffId,
      name,
      role,
      hire_date: toIso(hire),
      end_date: end === null ? null : toIso(end),
      hourly_rate_cents: rate,
    });
  }
  const crewMemberships = memberships.map((m) => ({ ...m, staff_id: staffIdOf.get(m.staff_name) }));
  return { staff, payRates, crewMemberships };
}

// ---- home details ---------------------------------------------------------

const nearestBand = (pct) => SIZE_BANDS.reduce((best, b) => (Math.abs(b - pct) < Math.abs(best - pct) ? b : best), SIZE_BANDS[0]);

// The size band a property's price implies: its first plan's start price over
// the package base and frequency discount, else its first quoted one-off.
function priceBands(tables) {
  const base = new Map(tables.packages.map((p) => [p.package_id, p.base_price_cents]));
  const bands = new Map();
  for (const p of tables.plans) {
    if (bands.has(p.property_id)) continue;
    bands.set(p.property_id, nearestBand((p.start_price_cents * 10000) / (base.get(p.package_id) * FREQUENCY_DISCOUNT[p.frequency])));
  }
  const visitOf = new Map(tables.visits.map((v) => [v.visit_id, v]));
  const invoiceById = new Map(tables.invoices.map((i) => [i.invoice_id, i]));
  for (const l of tables.invoice_lines) {
    if (l.package_id === null) continue;
    const v = visitOf.get(invoiceById.get(l.invoice_id).visit_id);
    if (v.plan_id !== null || bands.has(v.property_id)) continue;
    bands.set(v.property_id, nearestBand((l.amount_cents * 100) / base.get(l.package_id)));
  }
  return bands;
}

function buildHomes(rng, tables) {
  const bands = priceBands(tables);
  const difficulty = new Map();
  const properties = tables.properties.map((p) => {
    let band = bands.has(p.property_id) ? bands.get(p.property_id) : rng.weighted(SIZE_WEIGHTS);
    if (rng.chance(MISMATCH_CHANCE)) {
      const i = SIZE_BANDS.indexOf(band) + (rng.chance(0.5) ? 1 : -1);
      band = SIZE_BANDS[clamp(i, 0, SIZE_BANDS.length - 1)];
    }
    const sqft = clamp(Math.round((BAND_SQFT[band] * rng.int(85, 115)) / 1000) * 10, 450, 5000);
    const weights = TYPE_BY_SQFT.find(([upTo]) => sqft < upTo)[1];
    const homeType = rng.weighted(HOME_TYPES.map((t, i) => [t, weights[i]]).filter(([, w]) => w > 0));
    const bedrooms = clamp(Math.round(sqft / 600 + (rng.next() - 0.5) * 1.2), 1, MAX_BEDROOMS[homeType]);
    const full = clamp(Math.round(bedrooms * 0.6 + rng.next() * 0.8), 1, 4);
    const half = rng.chance(HALF_BATH_CHANCE[homeType]) ? 1 : 0;
    const hasPets = rng.chance(PET_CHANCE);
    const access = rng.weighted(ACCESS[homeType]);
    difficulty.set(p.property_id, rng.weighted(DIFFICULTY));
    return {
      ...p,
      home_type: homeType,
      square_feet: sqft,
      bedrooms,
      bathrooms: `${full}.${half ? 5 : 0}`,
      has_pets: hasPets ? 'true' : 'false',
      access_method: access,
    };
  });
  return { properties, difficulty };
}

// ---- schedule and timesheets ----------------------------------------------

function labourMinutes(visit, home, addOns) {
  const pkg = PACKAGE_LABOUR[visit.package_id];
  if (!pkg) throw new Error(`visit ${visit.visit_id}: no labour model for package ${visit.package_id}`);
  let minutes = pkg.base + home.square_feet * pkg.perSqft + Number(home.bathrooms) * BATHROOM_LABOUR;
  if (home.has_pets === 'true') minutes += PET_LABOUR;
  for (const a of addOns) minutes += (ADD_ON_LABOUR[a.add_on_id] ?? 20) * a.quantity;
  return minutes;
}

function travelRange(spec, zoneId) {
  return spec[zoneId === 'central' ? 'central' : 'other'];
}

function buildSchedule(rng, tables, { properties, difficulty, crewMemberships, staffIdOf }) {
  const home = new Map(properties.map((p) => [p.property_id, p]));
  const crewZone = new Map(tables.crews.map((c) => [c.crew_id, c.zone_id]));
  const invoiceOfVisit = new Map(tables.invoices.map((i) => [i.visit_id, i.invoice_id]));
  const addOnsOf = groupBy(tables.invoice_lines.filter((l) => l.add_on_id !== null), 'invoice_id');
  const membersOf = groupBy(crewMemberships, 'crew_id');
  const membersOn = (crewId, iso) => (membersOf.get(crewId) || [])
    .filter((m) => m.start_date <= iso && (m.end_date === null || m.end_date >= iso))
    .map((m) => staffIdOf.get(m.staff_name))
    .sort((a, b) => a - b);

  const schedule = new Map();
  const timesheets = [];
  const crewDays = [...groupBy(tables.visits, (v) => `${v.visit_date}|${String(v.crew_id).padStart(6, '0')}`)]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [, visits] of crewDays) {
    const { crew_id: crewId, visit_date: iso } = visits[0];
    const zoneId = crewZone.get(crewId);
    const day = toDay(iso);
    const members = membersOn(crewId, iso);
    if (members.length === 0) throw new Error(`crew ${crewId} has no members on ${iso}`);

    // Route: cities in a random order, visits in a random order within each.
    const byCity = groupBy(visits.slice().sort((a, b) => a.visit_id - b.visit_id), (v) => home.get(v.property_id).city);
    const cities = shuffled(rng, [...byCity.keys()].sort());
    const route = cities.flatMap((c) => shuffled(rng, byCity.get(c)));
    const stops = route.map((v, i) => {
      const addOns = v.status === 'completed' ? addOnsOf.get(invoiceOfVisit.get(v.visit_id)) || [] : [];
      const crewMinutes = labourMinutes(v, home.get(v.property_id), addOns) / members.length;
      const sameCity = i > 0 && home.get(route[i - 1].property_id).city === home.get(v.property_id).city;
      const [lo, hi] = i === 0 ? travelRange(TRAVEL.base, zoneId) : sameCity ? TRAVEL.sameCity : travelRange(TRAVEL.otherCity, zoneId);
      return {
        visit: v,
        routeOrder: i + 1,
        travel: rng.int(lo, hi),
        minutes: Math.max(MIN_SCHEDULED, Math.round(crewMinutes / SLOT_MINUTES) * SLOT_MINUTES),
      };
    });
    let planned = stops.reduce((s, x) => s + x.travel + x.minutes, 0);
    // A day whose plan cannot fit between EARLIEST_START and LATEST_FINISH is
    // squeezed: every slot shrinks in proportion (never below the minimum),
    // and the crew works the squeezed slots. Rare: 30 of about 10,400 crew-days
    // with the recorded seed.
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
    if (cursor > MIDNIGHT) throw new Error(`crew ${crewId} on ${iso}: ${stops.length} visits need ${planned} minutes and do not fit in the day`);

    // The day as worked: the crew rides together; a stop starts when the crew
    // gets there, never much before its slot; a cancelled stop is skipped.
    let free = dayStart;
    for (const s of stops) {
      schedule.set(s.visit.visit_id, {
        arrival_window: s.start < NOON ? 'morning' : 'afternoon',
        scheduled_start: clockTime(s.start),
        scheduled_minutes: s.minutes,
        route_order: s.routeOrder,
        travel_minutes_from_previous: s.travel,
      });
      if (s.visit.status !== 'completed') continue;
      const arrival = Math.max(free + s.travel, s.start + rng.int(ARRIVAL_JITTER[0], ARRIVAL_JITTER[1]));
      if (arrival >= MIDNIGHT) throw new Error(`crew ${crewId} on ${iso}: visit ${s.visit.visit_id} would start after midnight`);
      const range = DURATION_NOISE[rng.weighted(DURATION_NOISE.map(([, w], i) => [i, w]))][0];
      const pct = rng.int(range[0], range[1]) * difficulty.get(s.visit.property_id);
      const onSite = Math.max(MIN_ON_SITE, Math.round((s.minutes * pct) / 10000));
      for (const staffId of members) {
        const early = rng.chance(LEAVE_EARLY_CHANCE) ? rng.int(1, LEAVE_EARLY_MAX) : 0;
        const minutes = Math.max(MIN_ON_SITE, onSite - early);
        timesheets.push({
          visit_id: s.visit.visit_id,
          staff_id: staffId,
          clock_in: timestamp(day, arrival),
          clock_out: timestamp(day, arrival + minutes),
          minutes,
        });
      }
      free = arrival + onSite;
    }
  }
  timesheets.sort((a, b) => a.visit_id - b.visit_id || a.staff_id - b.staff_id);
  timesheets.forEach((t, i) => { t.timesheet_id = i + 1; });
  const visits = tables.visits.map((v) => ({ ...v, ...schedule.get(v.visit_id) }));
  return {
    visits,
    timesheets: timesheets.map(({ timesheet_id, visit_id, staff_id, clock_in, clock_out, minutes }) => ({
      timesheet_id, visit_id, staff_id, clock_in, clock_out, minutes,
    })),
  };
}

// Returns the new tables and the three extended ones. `tables` is read, never
// changed: the extended tables are new row objects with the columns appended.
function buildOperations(rng, tables, { historyStart, asOf }) {
  const { staff, payRates, crewMemberships } = buildStaff(rng, tables.crew_memberships, { historyStart, asOf: toDay(asOf) });
  const staffIdOf = new Map(staff.map((s) => [s.name, s.staff_id]));
  const { properties, difficulty } = buildHomes(rng, tables);
  const { visits, timesheets } = buildSchedule(rng, tables, { properties, difficulty, crewMemberships, staffIdOf });
  return { staff, pay_rates: payRates, crew_memberships: crewMemberships, properties, visits, timesheets };
}

module.exports = {
  buildOperations,
  OPERATIONS_STREAM,
  ROLE_LEAD,
  ROLE_CLEANER,
  RATE_BOUNDS,
  HOME_TYPES,
  ACCESS_METHODS: ['client_home', 'door_code_on_file', 'key', 'lockbox'],
  EARLIEST_START,
  MIDNIGHT,
  TRAVEL_BOUNDS: [5, 35],
  SLOT_MINUTES,
  MIN_SCHEDULED,
};
