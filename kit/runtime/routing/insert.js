'use strict';

// Add a stop (Story 19.5, plan brightside-v1 D8): where one new stop would go.
// insertStop takes the input contract, the new stop and { travel, rules?,
// returnToBase, order? } and returns the cheapest place for it on its own crew
// (stop.currentCrewId), and the two cheapest other crews of that crew's zone.
// It never reorders the stops already booked and never saves anything. Pure
// (AD-R1): no clock, randomness, I/O or async; the same input gives
// byte-identical JSON, and neither argument is changed.
//
//   insertStop(input, stop, { travel, rules?, returnToBase, order? })
//
//   stop          a stop of the contract (stopId, node, currentCrewId,
//                 labourMinutes, serviceMinutes, locked false, rules[]),
//                 not in input.stops; its faults name stop.<field>, never a
//                 value. A locked stop is refused: a new stop has no booked
//                 start. Its crew must be working (available true).
//   returnToBase  required, true or false, as for evaluateOrder.
//   order         the crew's stops in the order to insert into (a person's
//                 reorder in the editor); exactly that crew's stops, each
//                 once. Absent: the booked order (routeOrder, then stopId).
//                 Every other crew is taken in its booked order.
//
// Cost is the AD-R5 tuple of the crew's whole route (optimize.js's timing and
// cost, the shared helpers), so "cheapest" means fewest hard breaks, then soft
// penalty, then drive minutes, then minutes past the aim finish; of equal
// places the first wins. Every position from first to last is tried.
//
// The stop fits when its cheapest place adds no hard break to the route and
// the stop itself breaks no hard rule there. When nothing fits (a window no
// start meets, a day already full) the stop is placed last and flagged:
// fits false, with the reason in the solver's words.
//
// Other crews: every other working crew of the same zone, each at its own
// cheapest place, kept only where the stop fits; the two cheapest by what
// they add (then crewId). The stop's service minutes are taken as given on
// every crew.
//
// Output:
//   day, crewId, stopId
//   fits, reason
//   position      the stop's place in the new order, 1 being first
//   start         its start there, minutes after local midnight
//   order[]       the crew's stopIds with the new stop in its place
//   before, after, added   the route's AD-R5 cost without the stop, with it,
//                 and the difference (each { hardBreaks, softPenalty,
//                 driveMinutes, aimFinishMinutes })
//   others[]      at most 2: { crewId, position, start, added, reason }
//
// Reasons are built from rule labels, crew ids, clock times and minutes only
// (AD-R11), never a place.

const { RoutingFault } = require('../errors');
const { compareIds } = require('../scoring');
const { validateInput } = require('./contract');
const { shared } = require('./optimize');

const {
  checkOpts, model, compareCost, sub, clock, plural, hardBreakWords, costOut, ZERO,
} = shared;

const OTHERS = 2;
// The lengths a new stop may take, in minutes: 30 to 240 in steps of 15. Add
// a stop's form offers exactly these and an adapter's addStop() accepts only
// these (Story 19.5), so the two read this one list and cannot drift.
const ADD_STOP_LENGTHS = Object.freeze(Array.from({ length: 15 }, (_, i) => 30 + 15 * i));
const NONE = Number.MAX_SAFE_INTEGER;

const fault = (field, problem) => new RoutingFault({ field, problem });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
const insertAt = (order, pos, si) => [...order.slice(0, pos), si, ...order.slice(pos)];

// The day with the new stop as its last stop, checked by the contract. A
// fault on the stop names stop.<field>, not its place in the list.
function withStop(input, stop) {
  if (!isObject(stop)) throw fault('stop', 'not_object');
  const n = input.stops.length;
  const day = { ...input, stops: [...input.stops, stop] };
  // insertStop reads neither; a candidate's id is no concern of a new stop.
  delete day.candidates;
  delete day.cancelled;
  try {
    validateInput(day);
  } catch (err) {
    const prefix = `stops[${n}]`;
    if (err instanceof RoutingFault && typeof err.details.field === 'string' && err.details.field.startsWith(prefix)) {
      throw fault(`stop${err.details.field.slice(prefix.length)}`, err.details.problem);
    }
    throw err;
  }
  if (stop.locked) throw fault('stop.locked', 'locked');
  return day;
}

// A crew's stops (indexes into the model) in booked order, the new stop left out.
function bookedOrder(m, ci, newSi) {
  return m.stops.map((s, si) => si)
    .filter((si) => si !== newSi && m.stops[si].crew === ci)
    .sort((a, b) => {
      const [x, y] = [m.stops[a], m.stops[b]];
      return (x.stop.routeOrder ?? NONE) - (y.stop.routeOrder ?? NONE) || x.rank - y.rank;
    });
}

// opts.order as stop indexes: exactly crew ci's booked stops, each once.
function givenOrder(m, ci, newSi, order) {
  if (!Array.isArray(order)) throw fault('opts.order', 'not_list');
  const byId = new Map(m.stops.map((s, si) => [s.stop.stopId, si]));
  const seen = new Set();
  const out = order.map((stopId, i) => {
    const at = `opts.order[${i}]`;
    if (typeof stopId !== 'string') throw fault(at, 'not_text');
    const si = byId.get(stopId);
    if (si === undefined || si === newSi) throw fault(at, 'unknown_stop');
    if (m.stops[si].crew !== ci) throw fault(at, 'other_crew_stop');
    if (seen.has(si)) throw fault(at, 'duplicate');
    seen.add(si);
    return si;
  });
  if (out.length !== bookedOrder(m, ci, newSi).length) throw fault('opts.order', 'missing_stop');
  return out;
}

// The cheapest place for stop si on crew ci, from first to last: the route's
// cost without it (base) and, for the best place, the new order, its cost,
// what it adds and the stop's start. Of equal costs the first place wins.
function cheapestOn(m, ci, order, si) {
  const base = order.length ? m.route(ci, order).cost : ZERO;
  let best = null;
  for (let pos = 0; pos <= order.length; pos += 1) {
    const next = insertAt(order, pos, si);
    const { cost, slots } = m.route(ci, next);
    const added = sub(cost, base);
    if (!best || compareCost(added, best.added) < 0) best = { pos, next, cost, added, slot: slots[pos] };
  }
  return { base, best };
}

// True when the stop's own slot breaks no hard rule (and no start was out of
// the crew day) and the route gains no hard break.
function fitsAt(m, ci, place, si) {
  if (place.added.hard > 0) return false;
  if (place.slot.overDay) return false;
  const t = m.tally(ci, si, place.slot.start);
  return t.hardBreaks === 0;
}

const driveWords = (minutes) => (minutes >= 0
  ? `adds ${plural(minutes, 'minute')} of driving`
  : `saves ${plural(-minutes, 'minute')} of driving`);

function insertStop(input, stop, opts) {
  validateInput(input);
  const options = checkOpts(opts);
  if (!has(opts, 'returnToBase')) throw fault('opts.returnToBase', 'missing');
  const day = withStop(input, stop);
  const m = model(day, options);
  const si = m.stops.length - 1;
  const ci = m.stops[si].crew;
  const crew = m.crews[ci];
  if (!crew.available) throw fault('stop.currentCrewId', 'not_working');
  const order = has(opts, 'order') ? givenOrder(m, ci, si, opts.order) : bookedOrder(m, ci, si);

  const { base, best } = cheapestOn(m, ci, order, si);
  const fits = fitsAt(m, ci, best, si);
  let place = best;
  let reason;
  if (fits) {
    reason = `the cheapest place on crew ${crew.crewId} is stop ${best.pos + 1} of ${order.length + 1}, `
      + `starting at ${clock(best.slot.start)}; it ${driveWords(best.added.drive)}`;
  } else {
    // Nothing keeps every hard rule: last, flagged, with the solver's words.
    const next = [...order, si];
    const { cost, slots } = m.route(ci, next);
    place = {
      pos: order.length, next, cost, added: sub(cost, base), slot: slots[order.length],
    };
    reason = `no place on crew ${crew.crewId} keeps every hard rule, so it is placed last (${hardBreakWords(m, ci, next, si)})`;
  }

  const others = m.available
    .filter((cj) => cj !== ci && m.crews[cj].zoneId === crew.zoneId)
    .map((cj) => ({ cj, place: cheapestOn(m, cj, bookedOrder(m, cj, si), si).best }))
    .filter(({ cj, place: p }) => fitsAt(m, cj, p, si))
    .sort((a, b) => compareCost(a.place.added, b.place.added) || compareIds(m.crews[a.cj].crewId, m.crews[b.cj].crewId))
    .slice(0, OTHERS)
    .map(({ cj, place: p }) => ({
      crewId: m.crews[cj].crewId,
      position: p.pos + 1,
      start: p.slot.start,
      added: costOut(p.added),
      reason: `could go on crew ${m.crews[cj].crewId} as stop ${p.pos + 1} of ${p.next.length}, `
        + `starting at ${clock(p.slot.start)}; it ${driveWords(p.added.drive)}`,
    }));

  return {
    day: input.day,
    crewId: crew.crewId,
    stopId: stop.stopId,
    fits,
    reason,
    position: place.pos + 1,
    start: place.slot.start,
    order: place.next.map((x) => m.stops[x].stop.stopId),
    before: costOut(base),
    after: costOut(place.cost),
    added: costOut(place.added),
    others,
  };
}

module.exports = { insertStop, OTHERS, ADD_STOP_LENGTHS };
