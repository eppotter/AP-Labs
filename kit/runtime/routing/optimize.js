'use strict';

// Optimize a day (Story 12.3, AD-R5, AD-R6, AD-R11). optimizeDay takes the
// input contract and { travel, rules, budget, returnToBase } and returns a
// suggested plan as plain data. It is pure: no clock, randomness or I/O, and
// the same input gives byte-identical JSON.
//
// Objective (AD-R5): plans compare by the integer tuple
//   (hardBreaks, softPenalty, driveMinutes, aimFinishMinutes, orderKey)
// first position first. softPenalty and aimFinishMinutes are the rule
// registry's two soft positions, so aim-finish lateness is never summed with
// another soft rule. orderKey is the stopId order crew by crew (crews in
// compareIds order), so equal plans always break the tie by stopId.
//
// Solver (AD-R6):
//   1. Construction. Locked stops go on their own crew first, in start order;
//      then every other stop, in stopId order, at its cheapest insertion that
//      breaks no hard rule, on an available crew of its own zone. A stop with
//      no such insertion goes to unplaced[] with a reason.
//   2. Improvement. First-improvement local search in a fixed move order:
//      relocate, swap and 2-opt within each crew, then relocate between crews
//      of the same zone. Every move evaluated costs one unit of `budget`
//      (default 20 000); the search stops at the budget or a local optimum.
//      Never wall clock, so a slower machine gives the same answer.
//   3. The booked order. When the booked order breaks no hard rule and the
//      result is not strictly better on (hardBreaks, softPenalty, driveMinutes,
//      aimFinishMinutes), the booked order comes back with the reason "booked
//      order is already best". For that comparison an unplaced stop counts as
//      a hard break, so a plan that drops a stop never beats a booked order
//      that serves it.
//
// Timing. Times are whole minutes after local midnight. A crew's first stop
// starts at limits.defaultStart; any other stop at its arrival (the previous
// finish plus the drive), rounded up to limits.startRoundTo. When that slot
// breaks a rule the solver looks for the first later slot (or, for a first
// stop, any slot from limits.earliestStart) that breaks fewer, without
// naming any rule. A locked stop always starts at its booked start; arriving
// after it is a hard break. Drive minutes count the leg from the crew's base
// to the first stop and every leg after it; the return to base only with
// opts.returnToBase (data-design §6).
//
// Zones and locks. A stop's zone is its booked crew's zone; it never moves to
// a crew of another zone. A locked stop keeps its crew and start. A crew with
// available false gets no stops; its unlocked stops go to its zone's other
// crews, and its locked ones to unplaced[].
//
// Output rows hold ids, minutes and reasons built from rule labels, crew ids,
// clock times and minutes only (AD-R11), never a place.

const { RoutingFault } = require('../errors');
const { compareIds } = require('../scoring');
const { validateInput } = require('./contract');
const { v1Registry } = require('./rules');

const DEFAULT_BUDGET = 20000;
const BOOKED_BEST = 'booked order is already best';
const POSITIONS = Object.freeze(['hard', 'soft', 'drive', 'aim']);
const ZERO = Object.freeze({ hard: 0, soft: 0, drive: 0, aim: 0 });

const fault = (field, problem) => new RoutingFault({ field, problem });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function clock(minutes) {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function checkOpts(opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw fault('opts', 'not_object');
  if (typeof opts.travel !== 'function') throw fault('opts.travel', 'not_function');
  const registry = opts.rules === undefined ? v1Registry() : opts.rules;
  if (registry === null || typeof registry !== 'object' || typeof registry.evaluate !== 'function' || typeof registry.resolve !== 'function') {
    throw fault('opts.rules', 'not_function');
  }
  const budget = opts.budget === undefined ? DEFAULT_BUDGET : opts.budget;
  if (!Number.isSafeInteger(budget)) throw fault('opts.budget', 'not_integer');
  if (budget < 0) throw fault('opts.budget', 'out_of_range');
  if (opts.returnToBase !== undefined && typeof opts.returnToBase !== 'boolean') throw fault('opts.returnToBase', 'not_true_false');
  return { travel: opts.travel, registry, budget, returnToBase: opts.returnToBase === true };
}

const add = (a, b) => ({ hard: a.hard + b.hard, soft: a.soft + b.soft, drive: a.drive + b.drive, aim: a.aim + b.aim });
const sub = (a, b) => ({ hard: a.hard - b.hard, soft: a.soft - b.soft, drive: a.drive - b.drive, aim: a.aim - b.aim });

function compareCost(a, b) {
  for (const k of POSITIONS) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return 0;
}

// The day as the solver sees it: crews in compareIds order, stops with their
// input index (for fault paths), stopId rank, zone and booked crew index.
function model(input, { travel, registry, returnToBase }) {
  const { limits } = input;
  const ctx = Object.freeze({ day: input.day, limits });
  const crews = [...input.crews].sort((a, b) => compareIds(a.crewId, b.crewId));
  const crewIndex = new Map(crews.map((c, i) => [c.crewId, i]));
  const stops = input.stops.map((stop, i) => ({ stop, at: `stops[${i}]`, crew: crewIndex.get(stop.currentCrewId), rank: 0 }));
  [...stops].sort((a, b) => compareIds(a.stop.stopId, b.stop.stopId)).forEach((s, r) => { s.rank = r; });
  // Every stop's rule instances are checked once, up front, so a bad rule
  // fails before any solving (registry.resolve throws RoutingFault).
  for (const s of stops) {
    registry.resolve(s.stop, s.at);
    s.own = new Set(s.stop.rules.map((r) => r.ruleId));
  }
  const available = crews.map((c, i) => i).filter((i) => crews[i].available);
  const roundUp = (t) => Math.ceil(t / limits.startRoundTo) * limits.startRoundTo;
  const memo = new Map();

  function tally(ci, si, start) {
    const { stop, at } = stops[si];
    return registry.evaluate(stop, { crewId: crews[ci].crewId, start, finish: start + stop.serviceMinutes }, ctx, at);
  }

  const keyOf = (t) => ({ hard: t.hardBreaks, soft: t.softPenalty });
  const lessKey = (a, b) => a.hard < b.hard || (a.hard === b.hard && a.soft < b.soft);

  // The start a stop takes on a crew, given the earliest it can begin (floor,
  // ignored for a first stop). Memoized: the same stop, crew and floor always
  // give the same slot, so the local search re-evaluates cheaply.
  function slotFor(ci, si, floor, first) {
    const memoKey = first ? `${ci}:${si}:first` : `${ci}:${si}:${floor}`;
    const hit = memo.get(memoKey);
    if (hit) return hit;
    const { stop } = stops[si];
    let slot;
    if (stop.locked) {
      const late = !first && floor > stop.start;
      const start = late ? roundUp(floor) : stop.start;
      const t = tally(ci, si, start);
      slot = { start, late, hard: t.hardBreaks + (late ? 1 : 0), soft: t.softPenalty, aim: t.aimFinishMinutes };
    } else {
      let from = roundUp(floor);
      let best = null;
      if (first) {
        const t = tally(ci, si, limits.defaultStart);
        best = { start: limits.defaultStart, t, key: keyOf(t) };
        from = roundUp(limits.earliestStart);
      }
      if (!best || best.key.hard > 0 || best.key.soft > 0) {
        for (let start = from; ; start += limits.startRoundTo) {
          const t = tally(ci, si, start);
          const key = keyOf(t);
          if (!best || lessKey(key, best.key)) best = { start, t, key };
          if (best.key.hard === 0 && best.key.soft === 0) break;
          if (start + limits.startRoundTo > limits.latestFinish) break;
        }
      }
      slot = { start: best.start, late: false, hard: best.t.hardBreaks, soft: best.t.softPenalty, aim: best.t.aimFinishMinutes };
    }
    memo.set(memoKey, slot);
    return slot;
  }

  // One crew's route (stop indexes in order): its cost and each stop's slot.
  function route(ci, order) {
    const crew = crews[ci];
    let cost = ZERO;
    let prevNode = crew.baseNode;
    let prevFinish = 0;
    const slots = order.map((si, k) => {
      const { stop } = stops[si];
      const leg = travel(prevNode, stop.node);
      const slot = slotFor(ci, si, prevFinish + leg, k === 0);
      cost = add(cost, { hard: slot.hard, soft: slot.soft, drive: leg, aim: slot.aim });
      prevNode = stop.node;
      prevFinish = slot.start + stop.serviceMinutes;
      return { si, start: slot.start, late: slot.late, leg };
    });
    if (returnToBase && order.length > 0) cost = add(cost, { hard: 0, soft: 0, drive: travel(prevNode, crew.baseNode), aim: 0 });
    return { cost, slots };
  }

  return { input, ctx, crews, crewIndex, stops, available, route, tally };
}

// --- plans -----------------------------------------------------------------

// A plan: one stop order per crew (index = crew index), each route's cost,
// and the total.
function makePlan(m, routes) {
  const costs = routes.map((order, ci) => (order.length === 0 ? ZERO : m.route(ci, order).cost));
  return { routes, costs, total: costs.reduce(add, ZERO) };
}

function withRoutes(m, plan, changes) {
  const routes = plan.routes.slice();
  const costs = plan.costs.slice();
  let total = plan.total;
  for (const [ci, order] of changes) {
    const cost = order.length === 0 ? ZERO : m.route(ci, order).cost;
    total = add(sub(total, costs[ci]), cost);
    routes[ci] = order;
    costs[ci] = cost;
  }
  return { routes, costs, total };
}

// orderKey: crew by crew, the stopId ranks in route order, shorter first.
function compareOrder(m, a, b) {
  for (let ci = 0; ci < a.length; ci += 1) {
    const [x, y] = [a[ci], b[ci]];
    for (let k = 0; k < Math.min(x.length, y.length); k += 1) {
      const d = m.stops[x[k]].rank - m.stops[y[k]].rank;
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  }
  return 0;
}

const better = (m, cand, cur) => {
  const c = compareCost(cand.total, cur.total);
  return c !== 0 ? c < 0 : compareOrder(m, cand.routes, cur.routes) < 0;
};

// The booked order: each crew's stops by routeOrder (then stopId). A stop on
// a crew that is out today is a hard break.
function bookedPlan(m) {
  const routes = m.crews.map(() => []);
  m.stops.forEach((s, si) => routes[s.crew].push(si));
  const NONE = Number.MAX_SAFE_INTEGER;
  for (const order of routes) {
    order.sort((a, b) => {
      const [x, y] = [m.stops[a], m.stops[b]];
      return (x.stop.routeOrder ?? NONE) - (y.stop.routeOrder ?? NONE) || x.rank - y.rank;
    });
  }
  const costs = routes.map((order, ci) => {
    if (order.length === 0) return ZERO;
    if (!m.crews[ci].available) return { hard: order.length, soft: 0, drive: 0, aim: 0 };
    return m.route(ci, order).cost;
  });
  return { routes, costs, total: costs.reduce(add, ZERO) };
}

// --- explaining a slot -----------------------------------------------------

// The first hard break a route makes, as plain words, preferring the stop
// being placed (si) over the stops it would push.
function hardBreakWords(m, ci, order, si) {
  const { slots } = m.route(ci, order);
  const found = [];
  for (const slot of slots) {
    const { stop } = m.stops[slot.si];
    if (slot.late) found.push({ si: slot.si, words: `its locked start of ${clock(stop.start)} can't be kept` });
    const t = m.tally(ci, slot.si, slot.start);
    const check = t.checks.find((c) => !c.ok && c.strength === 'hard');
    if (check) found.push({ si: slot.si, words: `${check.label}: ${check.reason}` });
  }
  const own = found.find((f) => f.si === si);
  if (own) return own.words;
  const other = found[0];
  return other ? `it would make stop ${m.stops[other.si].stop.stopId} break one (${other.words})` : 'it breaks a hard rule';
}

// --- 1. construction ---------------------------------------------------------

function construct(m) {
  let plan = makePlan(m, m.crews.map(() => []));
  const unplaced = [];
  const order = m.stops.map((s, si) => si);
  const locked = order.filter((si) => m.stops[si].stop.locked)
    .sort((a, b) => m.stops[a].stop.start - m.stops[b].stop.start || m.stops[a].rank - m.stops[b].rank);
  const free = order.filter((si) => !m.stops[si].stop.locked).sort((a, b) => m.stops[a].rank - m.stops[b].rank);

  for (const si of locked) {
    const { stop, crew: ci } = m.stops[si];
    if (!m.crews[ci].available) {
      unplaced.push({ si, reason: `locked to crew ${stop.currentCrewId}, which is not working today` });
      continue;
    }
    const next = [...plan.routes[ci], si];
    const cand = withRoutes(m, plan, [[ci, next]]);
    if (cand.costs[ci].hard > 0) {
      unplaced.push({ si, reason: `locked to crew ${stop.currentCrewId} at ${clock(stop.start)}, but that can't be kept without breaking a hard rule (${hardBreakWords(m, ci, next, si)})` });
      continue;
    }
    plan = cand;
  }

  for (const si of free) {
    const { stop, crew: home } = m.stops[si];
    const zoneId = m.crews[home].zoneId;
    const targets = m.available.filter((ci) => m.crews[ci].zoneId === zoneId);
    if (targets.length === 0) {
      unplaced.push({ si, reason: `no crew in zone ${zoneId} is working today` });
      continue;
    }
    let best = null;
    let fail = null;
    for (const ci of targets) {
      const current = plan.routes[ci];
      for (let pos = 0; pos <= current.length; pos += 1) {
        const next = [...current.slice(0, pos), si, ...current.slice(pos)];
        const cost = m.route(ci, next).cost;
        if (cost.hard === 0) {
          const delta = sub(cost, plan.costs[ci]);
          if (!best || compareCost(delta, best.delta) < 0) best = { ci, next, delta };
        } else if (!fail || cost.hard < fail.hard) {
          fail = { ci, next, hard: cost.hard };
        }
      }
    }
    if (best) {
      plan = withRoutes(m, plan, [[best.ci, best.next]]);
      continue;
    }
    const names = targets.map((ci) => m.crews[ci].crewId).join(', ');
    unplaced.push({ si, reason: `no slot on crew ${names} keeps every hard rule (${hardBreakWords(m, fail.ci, fail.next, si)})` });
  }
  return { plan, unplaced };
}

// --- 2. improvement ----------------------------------------------------------

const without = (order, i) => [...order.slice(0, i), ...order.slice(i + 1)];
const insertAt = (order, pos, si) => [...order.slice(0, pos), si, ...order.slice(pos)];

// Every move, in the one fixed order: per crew (compareIds order) relocate,
// swap, 2-opt; then relocate between crews of the same zone. A locked stop
// may change place within its crew's order but never leaves its crew.
function* moves(m, routes) {
  for (const ci of m.available) {
    const order = routes[ci];
    const n = order.length;
    for (let i = 0; i < n; i += 1) {
      const rest = without(order, i);
      for (let j = 0; j < n; j += 1) if (j !== i) yield [[ci, insertAt(rest, j, order[i])]];
    }
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const next = order.slice();
        [next[i], next[j]] = [next[j], next[i]];
        yield [[ci, next]];
      }
    }
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 2; j < n; j += 1) {
        yield [[ci, [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)]]];
      }
    }
  }
  for (const from of m.available) {
    for (const to of m.available) {
      if (from === to || m.crews[from].zoneId !== m.crews[to].zoneId) continue;
      const order = routes[from];
      for (let i = 0; i < order.length; i += 1) {
        if (m.stops[order[i]].stop.locked) continue;
        const rest = without(order, i);
        for (let pos = 0; pos <= routes[to].length; pos += 1) yield [[from, rest], [to, insertAt(routes[to], pos, order[i])]];
      }
    }
  }
}

function improve(m, start, budget) {
  let plan = start;
  let evaluations = 0;
  let improved = true;
  while (improved && evaluations < budget) {
    improved = false;
    for (const changes of moves(m, plan.routes)) {
      if (evaluations >= budget) break;
      evaluations += 1;
      const cand = withRoutes(m, plan, changes);
      if (better(m, cand, plan)) {
        plan = cand;
        improved = true;
        break;
      }
    }
  }
  return { plan, evaluations };
}

// --- 3. output ---------------------------------------------------------------

const costOut = (c) => ({ hardBreaks: c.hard, softPenalty: c.soft, driveMinutes: c.drive, aimFinishMinutes: c.aim });

function rowReason(m, ci, slot, prevSi) {
  const { stop, own } = m.stops[slot.si];
  const crew = m.crews[ci];
  const parts = [];
  if (stop.locked) parts.push(`locked: keeps crew ${crew.crewId} and its ${clock(stop.start)} start`);
  else if (stop.currentCrewId !== crew.crewId) parts.push(`moved from crew ${stop.currentCrewId} to crew ${crew.crewId}, both in zone ${crew.zoneId}`);
  else parts.push(`stays on crew ${crew.crewId}`);
  parts.push(prevSi === null ? `${slot.leg} minutes' drive from the crew's base` : `${slot.leg} minutes' drive from stop ${m.stops[prevSi].stop.stopId}`);
  for (const check of m.tally(ci, slot.si, slot.start).checks) {
    if (!check.ok || own.has(check.ruleId)) parts.push(`${check.label}: ${check.reason}`);
  }
  return parts.join('; ');
}

function plansOut(m, plan) {
  return m.available.map((ci) => {
    const { slots } = m.route(ci, plan.routes[ci]);
    return {
      crewId: m.crews[ci].crewId,
      zoneId: m.crews[ci].zoneId,
      stops: slots.map((slot, k) => ({
        stopId: m.stops[slot.si].stop.stopId,
        routeOrder: k + 1,
        start: slot.start,
        travelMinutesFromPrevious: slot.leg,
        reason: rowReason(m, ci, slot, k === 0 ? null : slots[k - 1].si),
      })),
    };
  });
}

function movesOut(m, plan) {
  const out = [];
  for (const ci of m.available) {
    for (const si of plan.routes[ci]) {
      const { stop } = m.stops[si];
      if (stop.currentCrewId === m.crews[ci].crewId) continue;
      out.push({ stopId: stop.stopId, fromCrew: stop.currentCrewId, toCrew: m.crews[ci].crewId, crossZone: false, reason: `moved from crew ${stop.currentCrewId} to crew ${m.crews[ci].crewId}, both in zone ${m.crews[ci].zoneId}` });
    }
  }
  return out.sort((a, b) => compareIds(a.stopId, b.stopId));
}

// Why the suggested plan beats the booked one, from the first position of
// the tuple where they differ.
function betterWords(result, booked) {
  if (booked.hard > 0) return `the booked order breaks ${plural(booked.hard, 'hard rule')}; this plan breaks none`;
  if (result.soft !== booked.soft) return `lower soft-rule penalty than booked (${result.soft} against ${booked.soft})`;
  if (result.drive !== booked.drive) return `${plural(booked.drive - result.drive, 'fewer minute')} of driving than booked`;
  return `${plural(booked.aim - result.aim, 'fewer minute')} past the aim-finish time than booked`;
}

function optimizeDay(input, opts = {}) {
  validateInput(input);
  const options = checkOpts(opts);
  const m = model(input, options);
  const booked = bookedPlan(m);
  const built = construct(m);
  const { plan, evaluations } = improve(m, built.plan, options.budget);
  const unplaced = built.unplaced
    .map(({ si, reason }) => ({ stopId: m.stops[si].stop.stopId, reason }))
    .sort((a, b) => compareIds(a.stopId, b.stopId));
  const resultKey = { ...plan.total, hard: plan.total.hard + unplaced.length };
  const keepBooked = booked.total.hard === 0 && compareCost(resultKey, booked.total) >= 0;
  if (keepBooked) {
    return {
      day: input.day,
      source: 'booked',
      reason: BOOKED_BEST,
      plans: plansOut(m, booked),
      moves: [],
      unplaced: [],
      cost: costOut(booked.total),
      booked: costOut(booked.total),
      evaluations,
    };
  }
  const why = [betterWords(plan.total, booked.total)];
  if (unplaced.length > 0) why.push(`${plural(unplaced.length, 'stop')} could not be placed`);
  return {
    day: input.day,
    source: 'suggested',
    reason: why.join('; '),
    plans: plansOut(m, plan),
    moves: movesOut(m, plan),
    unplaced,
    cost: costOut(plan.total),
    booked: costOut(booked.total),
    evaluations,
  };
}

// The construction step's plans alone, for the budget-0 test; app code
// calls optimizeDay through the routing index.
function constructionPlans(input, opts = {}) {
  validateInput(input);
  const m = model(input, checkOpts(opts));
  return plansOut(m, construct(m).plan);
}

module.exports = { optimizeDay, constructionPlans, DEFAULT_BUDGET, BOOKED_BEST };
