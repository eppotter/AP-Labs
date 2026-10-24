'use strict';

// Story 7.1: Brightside's reference tables (fixture-tables.md). Every random
// choice comes from the seeded rng passed in, in a fixed order, so one seed
// gives the same rows every time.

const { toDay, toIso } = require('./days');
const W = require('./words');

const HISTORY_START = '2024-10-01';
const AS_OF = '2026-09-30';

// Service zones in declared order. `index` is the zone's digit in its postal
// codes (00Z..: unassigned real-world range), and each city belongs to exactly
// one zone, so a property's zone can be read back from its city or postal code.
const ZONES = [
  { zone_id: 'north', name: 'North', weight: 24, cities: ['Fernhill', 'Northvale', 'Pinecrest'] },
  { zone_id: 'south', name: 'South', weight: 22, cities: ['Clayfield', 'Riverbend', 'Southmere'] },
  { zone_id: 'east', name: 'East', weight: 20, cities: ['Eastbrook', 'Harborview', 'Sunridge'] },
  { zone_id: 'west', name: 'West', weight: 18, cities: ['Stonegate', 'Westfall', 'Willowmere'] },
  { zone_id: 'central', name: 'Central', weight: 16, cities: ['Centerpoint', 'Midtown', 'Oldmarket'] },
].map((z, index) => ({ ...z, index }));

// Fixed price list: a catalogue, not sampled data.
const PACKAGES = [
  { package_id: 'deep', name: 'Deep clean', base_price_cents: 26000 },
  { package_id: 'move_out', name: 'Move-out clean', base_price_cents: 34000 },
  { package_id: 'standard', name: 'Standard clean', base_price_cents: 14000 },
];

const ADD_ONS = [
  { add_on_id: 'baseboards', name: 'Baseboards', price_cents: 2500 },
  { add_on_id: 'fridge', name: 'Inside fridge', price_cents: 3000 },
  { add_on_id: 'laundry', name: 'Laundry fold', price_cents: 2000 },
  { add_on_id: 'oven', name: 'Inside oven', price_cents: 3500 },
  { add_on_id: 'windows', name: 'Interior windows', price_cents: 4500 },
];

const CREWS_PER_ZONE = 3;
const CREW_SIZE = 3;
const CREW_LETTERS = ['A', 'B', 'C'];
// Crew turnover, simulated in weekly steps.
const WEEKLY_LEAVE_CHANCE = 0.012;
const LEAVER_STAYS_CHANCE = 0.5; // a leaver can rejoin another crew later
const REHIRE_CHANCE = 0.35; // a vacancy filled from those leavers

const SECOND_PROPERTY_CHANCE = 0.08;
const OPENING_BOOK_CHANCE = 0.4; // clients onboarded in the first 90 days
const OPENING_BOOK_DAYS = 90;

// Plain code-unit order: never localeCompare, whose order depends on the locale.
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function personName(rng) {
  return {
    first: rng.pick(W.FIRST_NAMES),
    last: rng.pick(W.LAST_PREFIXES) + rng.pick(W.LAST_SUFFIXES),
  };
}

function uniqueStaffName(rng, taken) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const { first, last } = personName(rng);
    const name = `${first} ${last}`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
  throw new Error('could not find an unused staff name in 1000 tries');
}

function buildCrews() {
  const crews = [];
  for (const zone of ZONES) {
    for (let i = 0; i < CREWS_PER_ZONE; i++) {
      crews.push({ crew_id: crews.length + 1, zone_id: zone.zone_id, name: `${zone.name} crew ${CREW_LETTERS[i]}` });
    }
  }
  return crews;
}

// Each crew has CREW_SIZE slots. A staff member is in exactly one slot, on the
// bench (left, may rejoin later) or gone, so their periods never overlap.
function buildMemberships(rng, crews) {
  const start = toDay(HISTORY_START);
  const asOf = toDay(AS_OF);
  const taken = new Set();
  const periods = [];
  const slots = [];
  for (const crew of crews) {
    for (let s = 0; s < CREW_SIZE; s++) {
      const period = { crew_id: crew.crew_id, slot: s, staff_name: uniqueStaffName(rng, taken), start, end: null };
      periods.push(period);
      slots.push(period);
    }
  }
  let bench = [];
  for (let day = start + 7; day <= asOf; day += 7) {
    const leavers = [];
    for (let i = 0; i < slots.length; i++) {
      if (!rng.chance(WEEKLY_LEAVE_CHANCE)) continue;
      const current = slots[i];
      current.end = day - 1;
      if (rng.chance(LEAVER_STAYS_CHANCE)) leavers.push(current.staff_name);
      let staff;
      if (bench.length > 0 && rng.chance(REHIRE_CHANCE)) {
        staff = bench.splice(rng.int(0, bench.length - 1), 1)[0];
      } else {
        staff = uniqueStaffName(rng, taken);
      }
      const next = { crew_id: current.crew_id, slot: current.slot, staff_name: staff, start: day, end: null };
      periods.push(next);
      slots[i] = next;
    }
    // Leavers become available from the next step, after their end date.
    bench = bench.concat(leavers);
  }
  periods.sort((a, b) => a.start - b.start || a.crew_id - b.crew_id || a.slot - b.slot);
  return periods.map((p, i) => ({
    membership_id: i + 1,
    crew_id: p.crew_id,
    staff_name: p.staff_name,
    start_date: toIso(p.start),
    end_date: p.end === null ? null : toIso(p.end),
  }));
}

function buildClientsAndProperties(rng, clientCount) {
  const start = toDay(HISTORY_START);
  const asOf = toDay(AS_OF);
  const zonePick = ZONES.map((z) => [z, z.weight]);
  const clients = [];
  const properties = [];
  for (let id = 1; id <= clientCount; id++) {
    const zone = rng.weighted(zonePick);
    const { first, last } = personName(rng);
    const domain = rng.pick(W.EMAIL_DOMAINS);
    const phone = `555-01${String(rng.int(0, 99)).padStart(2, '0')}`;
    const created = rng.chance(OPENING_BOOK_CHANCE)
      ? rng.int(start, start + OPENING_BOOK_DAYS - 1)
      : rng.int(start, asOf);
    clients.push({
      client_id: id,
      zone_id: zone.zone_id,
      first_name: first,
      last_name: last,
      // The client id makes every address unique by construction.
      email: `${first}.${last}.${id}@${domain}`.toLowerCase(),
      phone,
      created_on: toIso(created),
    });
    const count = rng.chance(SECOND_PROPERTY_CHANCE) ? 2 : 1;
    for (let p = 0; p < count; p++) {
      const cityIndex = rng.int(0, zone.cities.length - 1);
      properties.push({
        property_id: properties.length + 1,
        client_id: id,
        street_address: `${rng.int(1, 9999)} ${rng.pick(W.STREET_NAMES)} ${rng.pick(W.STREET_SUFFIXES)}`,
        city: zone.cities[cityIndex],
        postal_code: `00${zone.index}${cityIndex}${rng.int(0, 9)}`,
      });
    }
  }
  return { clients, properties };
}

// Draw order is fixed: crews (no draws), memberships, then clients and
// properties. Changing it changes every seed file.
function buildReference(rng, { clients: clientCount }) {
  const crews = buildCrews();
  const crewMemberships = buildMemberships(rng, crews);
  const { clients, properties } = buildClientsAndProperties(rng, clientCount);
  return {
    zones: ZONES.map(({ zone_id, name }) => ({ zone_id, name })).sort((a, b) => byText(a.zone_id, b.zone_id)),
    packages: PACKAGES.slice().sort((a, b) => byText(a.package_id, b.package_id)),
    add_ons: ADD_ONS.slice().sort((a, b) => byText(a.add_on_id, b.add_on_id)),
    crews,
    crew_memberships: crewMemberships,
    clients,
    properties,
  };
}

module.exports = { buildReference, ZONES, HISTORY_START, AS_OF };
