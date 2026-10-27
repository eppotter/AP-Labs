'use strict';

// Evaluate one crew's day in a given order (Story 15.12, AD-R24). The route
// editor hands the engine an order a person chose; evaluateOrder times it and
// checks it against the rules, exactly as optimizeDay would time and cost that
// order, and reports what it breaks. It never reorders, never drops a stop and
// never refuses an order for breaking a rule: a breaking order is allowed and
// flagged. Pure (AD-R1): no clock, randomness, I/O or async; the same input
// gives byte-identical JSON.
//
//   evaluateOrder(input, { travel, rules?, returnToBase, crewId, order })
//
//   order         exactly the stops whose currentCrewId is crewId, each once,
//                 as stopIds. Anything else throws RoutingFault naming the
//                 field (opts.order[i] or opts.order), never a value.
//   returnToBase  required, true or false: whether the drive back to the
//                 crew's baseNode (a depot:<id> for the editor) is counted.
//
// Timing is optimize.js's own route (its shared model): the first stop at
// limits.defaultStart (or the first start that breaks fewer rules), each next
// stop at its arrival rounded up to limits.startRoundTo (or the first later
// start that breaks fewer). A stop with no start that finishes in the crew day
// keeps its arrival time and gets a crew-day-limits break. Times are minutes
// after local midnight and may pass 1440 (the next day); they stay integers.
//
// Output:
//   stops[]   { stopId, routeOrder, start, finish, travelMinutesFromPrevious,
//               breaks: [{ ruleId, label, strength, reason }] }
//   leaveAt   the first stop's start less the drive to it (null with no stops)
//   finish    the last stop's finish (null with no stops)
//   returnMinutes, backAt, lateBack
//             the drive back to base, the time back and whether that is after
//             limits.latestFinish; with returnToBase false: 0, null, false
//   cost      the AD-R5 tuple { hardBreaks, softPenalty, driveMinutes,
//               aimFinishMinutes }: hard breaks listed on the stops plus a late
//               return; for an order where every stop has a start inside the
//               crew day it equals optimizeDay's cost for that order.
//
// Reasons are built from rule labels, crew ids, clock times and minutes only
// (AD-R11), never a place.

const { RoutingFault } = require('../errors');
const { validateInput } = require('./contract');
const { shared } = require('./optimize');

const { checkOpts, model, costOut, clock } = shared;

const fault = (field, problem) => new RoutingFault({ field, problem });
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;

const LOCKED = Object.freeze({ ruleId: 'locked-start', label: 'locked start', strength: 'hard' });
const DAY_LIMITS = Object.freeze({ ruleId: 'crew-day-limits', label: 'crew day limits', strength: 'hard' });

// The crew and the order, checked against the day. Returns the crew index and
// the order as stop indexes into the model.
function checkOrder(m, opts) {
  if (!has(opts, 'crewId')) throw fault('opts.crewId', 'missing');
  if (typeof opts.crewId !== 'string') throw fault('opts.crewId', 'not_text');
  const ci = m.crewIndex.get(opts.crewId);
  if (ci === undefined) throw fault('opts.crewId', 'unknown_crew');
  if (!has(opts, 'order')) throw fault('opts.order', 'missing');
  if (!Array.isArray(opts.order)) throw fault('opts.order', 'not_list');
  const byId = new Map(m.stops.map((s, si) => [s.stop.stopId, si]));
  const seen = new Set();
  const order = opts.order.map((stopId, i) => {
    const at = `opts.order[${i}]`;
    if (typeof stopId !== 'string') throw fault(at, 'not_text');
    const si = byId.get(stopId);
    if (si === undefined) throw fault(at, 'unknown_stop');
    if (m.stops[si].crew !== ci) throw fault(at, 'other_crew_stop');
    if (seen.has(si)) throw fault(at, 'duplicate');
    seen.add(si);
    return si;
  });
  const own = m.stops.filter((s) => s.crew === ci).length;
  if (order.length !== own) throw fault('opts.order', 'missing_stop');
  return { ci, order };
}

// What one placed stop breaks: every failing rule check on its slot, a locked
// start it could not keep, and, when no start fitted the crew day and no rule
// says so, a crew-day-limits break in the solver's own words.
function breaksOf(m, ci, slot) {
  const { stop } = m.stops[slot.si];
  const t = m.tally(ci, slot.si, slot.start);
  const breaks = [];
  if (slot.late) breaks.push({ ...LOCKED, reason: `starts at ${clock(slot.start)}, after its locked start of ${clock(stop.start)}` });
  for (const c of t.checks) {
    if (!c.ok) breaks.push({ ruleId: c.ruleId, label: c.label, strength: c.strength, reason: c.reason });
  }
  if (slot.overDay && !t.checks.some((c) => !c.ok && c.ruleId === DAY_LIMITS.ruleId)) {
    const by = clock(m.limits.latestFinish);
    breaks.push({ ...DAY_LIMITS, reason: `no start leaves time to finish by ${by}${m.returnToBase ? ' and drive back to the base' : ''}` });
  }
  return { breaks, soft: t.softPenalty, aim: t.aimFinishMinutes };
}

function evaluateOrder(input, opts) {
  validateInput(input);
  const options = checkOpts(opts);
  if (!has(opts, 'returnToBase')) throw fault('opts.returnToBase', 'missing');
  const m = model(input, options);
  const { ci, order } = checkOrder(m, opts);
  const crew = m.crews[ci];
  const cost = { hard: 0, soft: 0, drive: 0, aim: 0 };
  const { slots } = m.route(ci, order);
  const stops = slots.map((slot, k) => {
    const { stop } = m.stops[slot.si];
    const { breaks, soft, aim } = breaksOf(m, ci, slot);
    cost.hard += breaks.filter((b) => b.strength === 'hard').length;
    cost.soft += soft;
    cost.aim += aim;
    cost.drive += slot.leg;
    return {
      stopId: stop.stopId,
      routeOrder: k + 1,
      start: slot.start,
      finish: slot.start + stop.serviceMinutes,
      travelMinutesFromPrevious: slot.leg,
      breaks,
    };
  });
  const last = stops.length > 0 ? stops[stops.length - 1] : null;
  const finish = last ? last.finish : null;
  let returnMinutes = 0;
  let backAt = null;
  let lateBack = false;
  if (m.returnToBase && last) {
    returnMinutes = options.travel(m.stops[slots[slots.length - 1].si].stop.node, crew.baseNode);
    backAt = finish + returnMinutes;
    lateBack = backAt > m.limits.latestFinish;
    cost.drive += returnMinutes;
    if (lateBack) cost.hard += 1;
  }
  return {
    day: input.day,
    crewId: crew.crewId,
    stops,
    leaveAt: last ? stops[0].start - stops[0].travelMinutesFromPrevious : null,
    finish,
    returnMinutes,
    backAt,
    lateBack,
    cost: costOut(cost),
  };
}

module.exports = { evaluateOrder };
