'use strict';

// A broken day: place the orphans (Story 12.4, AD-R7, AD-R11). placeOrphans
// takes the input contract and { travel, rules, budget, returnToBase } and
// returns what to do when one or more crews are out. It is pure: no clock,
// randomness or I/O, and the same input gives byte-identical JSON.
//
// Orphans are the stops booked on a crew with available false. Every other
// crew keeps its booked day (routeOrder, then stopId); V1 only inserts, it
// never re-sequences a receiving crew (architecture-routing.md, Deferred).
//
//   1. Order. Orphans are taken hardest first: fewest crews of their own
//      zone with a slot that keeps every hard rule (counted once, on the
//      booked day), then stopId.
//   2. Place. Each orphan goes to the cheapest insertion, under the AD-R5
//      tuple, that leaves the receiving crew's whole route free of hard
//      breaks, on a working crew of its own zone. The receiving crew's
//      existing stops keep their order; their starts may move, but only
//      where every one of their own hard rules still holds (the route's cost
//      has no hard break, a locked stop keeps its start).
//   3. Cross-zone. With no such slot in its zone, the cheapest one on a crew
//      of another zone goes to moves[] with crossZone: true and
//      recommendation: true. It is not put in that crew's plan and is not
//      counted as placed; a dispatcher decides.
//   4. Unplaced. With no slot anywhere, or a stop locked to the crew that is
//      out, the stop goes to unplaced[] with a reason ending "call to
//      rebook". Moving it to another day is out of scope.
//
// shifted[] lists every existing stop whose start differs from the start the
// same timing gives the crew's booked day without the orphans, each with
// "call to confirm the new time". Timing, slot search and costs are
// optimize.js's (the shared helpers), so both entry points agree on a route.
// There is no local search here, so opts.budget is checked but not used.
//
// Output rows hold ids, minutes and reasons built from rule labels, crew ids,
// clock times and minutes only (AD-R11), never a place.

const { compareIds } = require('../scoring');
const { validateInput } = require('./contract');
const { shared } = require('./optimize');

const { checkOpts, model, bookedPlan, makePlan, withRoutes, compareCost, sub, clock, plural, hardBreakWords, plansOut, costOut } = shared;

const CONFIRM = 'call to confirm the new time';
const REBOOK = 'call to rebook';

const insertAt = (order, pos, si) => [...order.slice(0, pos), si, ...order.slice(pos)];

// The cheapest insertion of stop si on any of the target crews that leaves
// the route with no hard break (crews in compareIds order, then position;
// the first of equal costs wins), and the least-broken failure for the
// reason when there is none.
function cheapest(m, plan, si, targets) {
  let best = null;
  let fail = null;
  for (const ci of targets) {
    const current = plan.routes[ci];
    for (let pos = 0; pos <= current.length; pos += 1) {
      const next = insertAt(current, pos, si);
      const cost = m.route(ci, next).cost;
      if (cost.hard === 0) {
        const delta = sub(cost, plan.costs[ci]);
        if (!best || compareCost(delta, best.delta) < 0) best = { ci, next, delta };
      } else if (!fail || cost.hard < fail.hard) {
        fail = { ci, next, hard: cost.hard };
      }
    }
  }
  return { best, fail };
}

const startsOf = (m, ci, order) => new Map(m.route(ci, order).slots.map((s) => [s.si, s.start]));

// How many existing stops on crew ci would start at another time if its
// route became next.
function shiftCount(m, ci, before, next, orphan) {
  const after = startsOf(m, ci, next);
  let n = 0;
  for (const [si, start] of before) if (si !== orphan && after.get(si) !== start) n += 1;
  return n;
}

function inZoneWords(m, inZone, fail, si, zoneId) {
  if (inZone.length === 0) return `no other crew in zone ${zoneId} is working today`;
  const names = inZone.map((ci) => m.crews[ci].crewId).join(', ');
  return `no slot on crew ${names} keeps every hard rule (${hardBreakWords(m, fail.ci, fail.next, si)})`;
}

function placeOrphans(input, opts = {}) {
  validateInput(input);
  const options = checkOpts(opts);
  const m = model(input, options);
  const booked = bookedPlan(m);
  const out = m.crews.map((c, ci) => ci).filter((ci) => !m.crews[ci].available);
  let plan = makePlan(m, booked.routes.map((order, ci) => (m.crews[ci].available ? order : [])));
  const start = plan;
  const before = new Map(m.available.map((ci) => [ci, startsOf(m, ci, plan.routes[ci])]));

  const orphans = out.flatMap((ci) => booked.routes[ci]);
  const isOrphan = new Set(orphans);
  const zoneOf = (si) => m.crews[m.stops[si].crew].zoneId;
  const inZoneOf = (si) => m.available.filter((ci) => m.crews[ci].zoneId === zoneOf(si));
  const offZoneOf = (si) => m.available.filter((ci) => m.crews[ci].zoneId !== zoneOf(si));
  const outWords = (si) => `crew ${m.stops[si].stop.currentCrewId} is not working today`;

  const unplaced = [];
  const moves = [];
  const placedOn = new Map();

  const free = [];
  for (const si of orphans) {
    const { stop } = m.stops[si];
    if (stop.locked) {
      unplaced.push({ si, reason: `locked to crew ${stop.currentCrewId} at ${clock(stop.start)}, and ${outWords(si)}; ${REBOOK}` });
    } else {
      free.push(si);
    }
  }

  // 1. Hardest first: fewest feasible crews in the stop's zone on the booked
  // day, then stopId.
  const feasible = new Map(free.map((si) => [si, inZoneOf(si).filter((ci) => cheapest(m, start, si, [ci]).best).length]));
  free.sort((a, b) => feasible.get(a) - feasible.get(b) || m.stops[a].rank - m.stops[b].rank);

  for (const si of free) {
    const { stop } = m.stops[si];
    const inZone = inZoneOf(si);
    const own = cheapest(m, plan, si, inZone);
    // 2. In its zone: into the plan.
    if (own.best) {
      const { ci, next } = own.best;
      plan = withRoutes(m, plan, [[ci, next]]);
      placedOn.set(si, ci);
      continue;
    }
    const zoneId = zoneOf(si);
    const why = inZoneWords(m, inZone, own.fail, si, zoneId);
    const offZone = offZoneOf(si);
    const other = cheapest(m, plan, si, offZone);
    // 3. Another zone: a recommendation only.
    if (other.best) {
      const { ci, next, delta } = other.best;
      const crew = m.crews[ci];
      const at = startsOf(m, ci, next).get(si);
      const shifts = shiftCount(m, ci, startsOf(m, ci, plan.routes[ci]), next, si);
      const effect = [delta.drive >= 0 ? `${plural(delta.drive, 'more minute')} of driving` : `${plural(-delta.drive, 'fewer minute')} of driving`];
      if (shifts > 0) effect.push(`${shifts} of its stops would start at a new time`);
      moves.push({
        stopId: stop.stopId,
        fromCrew: stop.currentCrewId,
        toCrew: crew.crewId,
        crossZone: true,
        recommendation: true,
        start: at,
        reason: `${outWords(si)} and ${why}; crew ${crew.crewId} in zone ${crew.zoneId} could take it at ${clock(at)} (${effect.join(', ')}): a recommendation only, not in any crew's plan`,
      });
      continue;
    }
    // 4. Nowhere.
    const elsewhere = offZone.length === 0
      ? 'no crew in another zone is working today'
      : `no crew in another zone has a slot that keeps every hard rule either (${hardBreakWords(m, other.fail.ci, other.fail.next, si)})`;
    unplaced.push({ si, reason: `${outWords(si)}; ${why}, and ${elsewhere}; ${REBOOK}` });
  }

  // Rows for the orphans placed in their zone.
  for (const [si, ci] of placedOn) {
    const { stop } = m.stops[si];
    const crew = m.crews[ci];
    const at = startsOf(m, ci, plan.routes[ci]).get(si);
    moves.push({
      stopId: stop.stopId,
      fromCrew: stop.currentCrewId,
      toCrew: crew.crewId,
      crossZone: false,
      recommendation: false,
      start: at,
      reason: `${outWords(si)}; moved to crew ${crew.crewId}, also in zone ${crew.zoneId}, at ${clock(at)}`,
    });
  }
  moves.sort((a, b) => compareIds(a.stopId, b.stopId));

  // Existing stops whose time moved, with the orphans now ahead of them.
  const shifted = [];
  for (const ci of m.available) {
    const order = plan.routes[ci];
    const now = startsOf(m, ci, order);
    const ahead = [];
    for (const si of order) {
      if (isOrphan.has(si)) {
        ahead.push(m.stops[si].stop.stopId);
        continue;
      }
      const was = before.get(ci).get(si);
      if (now.get(si) === was) continue;
      const stops = ahead.length === 1 ? `stop ${ahead[0]}` : `stops ${ahead.join(', ')}`;
      shifted.push({
        stopId: m.stops[si].stop.stopId,
        crewId: m.crews[ci].crewId,
        previousStart: was,
        start: now.get(si),
        reason: `now starts at ${clock(now.get(si))} instead of ${clock(was)}, after ${stops} joined crew ${m.crews[ci].crewId}; ${CONFIRM}`,
      });
    }
  }
  shifted.sort((a, b) => compareIds(a.stopId, b.stopId));

  const unplacedOut = unplaced
    .map(({ si, reason }) => ({ stopId: m.stops[si].stop.stopId, reason }))
    .sort((a, b) => compareIds(a.stopId, b.stopId));
  const recommended = moves.filter((mv) => mv.recommendation).length;
  const crewsOut = out.map((ci) => m.crews[ci].crewId);
  let reason;
  if (crewsOut.length === 0) {
    reason = 'every crew is working today; nothing to place';
  } else {
    const who = crewsOut.length === 1 ? `crew ${crewsOut[0]} is` : `crews ${crewsOut.join(', ')} are`;
    reason = `${who} not working today: ${plural(orphans.length, 'stop')} to place; ${placedOn.size} placed in their zone, `
      + `${recommended} recommended for another zone, ${unplacedOut.length} to rebook; ${plural(shifted.length, 'existing stop')} to confirm a new time`;
  }

  return {
    day: input.day,
    reason,
    crewsOut,
    orphans: orphans.length,
    placed: placedOn.size,
    plans: plansOut(m, plan),
    moves,
    shifted,
    unplaced: unplacedOut,
    cost: costOut(plan.total),
  };
}

module.exports = { placeOrphans, CONFIRM, REBOOK };
