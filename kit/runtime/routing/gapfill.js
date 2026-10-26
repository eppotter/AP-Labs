'use strict';

// Fill a gap with ranked candidates (Story 12.5, AD-R8, AD-R11). fillGap
// takes the input contract plus input.cancelled[] (the day's cancelled
// visits) and { travel, rules, budget, returnToBase, limit, horizonDays,
// exclude, weights }, and returns, for each gap a cancellation leaves, up to
// `limit` visits from later days that could be moved up into it. It is pure:
// no clock, randomness or I/O, and the same input gives byte-identical JSON.
//
//   input.cancelled[]  { stopId, node, currentCrewId, start, serviceMinutes }
//                      the visits cancelled on input.day; start is the booked
//                      start, so the engine knows where each one sat
//
// Gaps. On each crew, the day's remaining stops and its cancelled visits are
// put in booked-start order (then stopId); every run of cancelled visits with
// no remaining stop between them is one gap (adjacent cancellations merge).
// A gap runs from the previous stop's end (or the crew day's earliest start)
// to the next stop's start (or the crew day's latest finish). The remaining
// stops keep their booked starts, so on a crew with a gap every stop must
// carry `start`.
//
// Candidates come only from input.candidates. One is left out, with a reason,
// when the caller excluded it (opts.exclude), its property cancelled today or
// already has a visit today, it is not planned within (day, day + horizonDays],
// it is locked, or moving it up breaks its cadence (fewer than half its
// cadenceDays since prevVisitDate). The rest are tried in the gap: travel in
// (from the previous stop, or the crew's base) + service + travel out (to the
// next stop; to the base only with returnToBase at the end of the day) must
// fit inside the gap, so no later stop ever shifts, and some start in it must
// keep every hard rule. Start times step by limits.startRoundTo from the
// earliest arrival; the first start that keeps every rule is taken, else the
// first that keeps every hard rule with the least soft penalty.
//
// Travel is read for the gap's two neighbours and the candidates only: the
// adapter's rectangle is from [previous, ...candidates] to [...candidates,
// next], which holds the previous-to-next leg a candidate's extra drive is
// measured against.
//
// Ranking goes through kit/runtime/scoring's rank() with the spec below
// (row_id stopId), so routing has no second scoring formula. Its default
// weights may be overridden by opts.weights (the profile's
// routing.gap_fill.weights): an unknown input name is refused, and weights
// that fail scoring's checkScoring throw. Each gap shows its top `limit`
// (default 5); a candidate offered in more than one gap lists the others in
// alsoOfferedFor[] (gap ids), and the caller may pass exclude[] to drop it.
//
// Output rows hold ids, dates, minutes and reasons built from rule labels,
// crew ids, clock times and minutes only (AD-R11), never a place.

const scoring = require('../scoring');
const { RoutingFault } = require('../errors');
const { validateInput, ID, NODE } = require('./contract');
const { shared } = require('./optimize');

const { checkOpts, model, clock, plural } = shared;
const { compareIds } = scoring;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const DEFAULT_HORIZON = 14;
const MAX_HORIZON = 90;
const DAY_MINUTES = 1440;

// The ranking spec. A gap's candidates are ranked the way a scoped-pull
// module ranks its query's rows (declared inputs, fixed weights and ranges,
// a reason per row), and checkScoring accepts a scoring block only on such a
// module, so the spec declares that archetype. days_moved_up's max is the
// horizon, set per call.
const RANKING = Object.freeze({
  id: 'routing-gap-fill',
  archetype: 'scoped-pull',
  row_id: 'stopId',
  inputs: Object.freeze([
    Object.freeze({ name: 'extra_drive_minutes', label: 'Extra drive minutes', weight: -4, min: 0, max: 120 }),
    Object.freeze({ name: 'flexible', label: 'Flexible (no hard day or time rule)', weight: 1, min: 0, max: 1 }),
    Object.freeze({ name: 'days_moved_up', label: 'Days the visit moves up', weight: -2, min: 0, max: DEFAULT_HORIZON }),
    Object.freeze({ name: 'window_fit', label: 'Keeps every customer rule', weight: 1, min: 0, max: 1 }),
  ]),
});

const fault = (field, problem) => new RoutingFault({ field, problem });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;

// Days since 1970-01-01 of a YYYY-MM-DD date, by arithmetic alone (the
// days-from-civil method), so no clock or time zone is ever involved. The
// contract has already checked the date.
function dayNumber(iso) {
  let y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// --- options ---------------------------------------------------------------

function intOpt(opts, key, def, min, max) {
  if (opts[key] === undefined) return def;
  if (!Number.isSafeInteger(opts[key])) throw fault(`opts.${key}`, 'not_integer');
  if (opts[key] < min || opts[key] > max) throw fault(`opts.${key}`, 'out_of_range');
  return opts[key];
}

function excludeOpt(opts) {
  if (opts.exclude === undefined) return new Set();
  if (!Array.isArray(opts.exclude)) throw fault('opts.exclude', 'not_list');
  opts.exclude.forEach((v, i) => {
    if (typeof v !== 'string') throw fault(`opts.exclude[${i}]`, 'not_text');
    if (!ID.test(v)) throw fault(`opts.exclude[${i}]`, 'bad_id');
  });
  return new Set(opts.exclude);
}

// The ranking spec with the caller's weights (by input name) over the
// defaults, checked by scoring's own checkScoring.
function rankingSpec(weights, horizon) {
  if (weights !== undefined && !isObject(weights)) throw fault('opts.weights', 'not_object');
  const given = weights || {};
  const names = new Set(RANKING.inputs.map((i) => i.name));
  for (const name of Object.keys(given)) {
    if (!names.has(name)) throw fault(`opts.weights.${ID.test(name) ? name : '?'}`, 'unknown_weight');
    if (typeof given[name] !== 'number' || !Number.isFinite(given[name])) throw fault(`opts.weights.${name}`, 'bad_weights');
  }
  const inputs = RANKING.inputs.map((i) => ({
    ...i,
    weight: has(given, i.name) ? given[i.name] : i.weight,
    max: i.name === 'days_moved_up' ? horizon : i.max,
  }));
  const spec = { id: RANKING.id, archetype: RANKING.archetype, row_id: RANKING.row_id, scoring: { inputs } };
  if (scoring.checkScoring(spec).length > 0) throw fault('opts.weights', 'bad_weights');
  return spec;
}

// --- the cancelled visits ------------------------------------------------------

function checkCancelled(input, crewIds) {
  if (!has(input, 'cancelled')) throw fault('cancelled', 'missing');
  if (!Array.isArray(input.cancelled)) throw fault('cancelled', 'not_list');
  const ids = new Set([...input.stops, ...(input.candidates || [])].map((s) => s.stopId));
  input.cancelled.forEach((c, i) => {
    const at = `cancelled[${i}]`;
    if (!isObject(c)) throw fault(at, 'not_object');
    for (const key of ['stopId', 'node', 'currentCrewId']) {
      if (!has(c, key)) throw fault(`${at}.${key}`, 'missing');
      if (typeof c[key] !== 'string') throw fault(`${at}.${key}`, 'not_text');
    }
    if (!ID.test(c.stopId)) throw fault(`${at}.stopId`, 'bad_id');
    if (ids.has(c.stopId)) throw fault(`${at}.stopId`, 'duplicate');
    ids.add(c.stopId);
    if (!NODE.test(c.node)) throw fault(`${at}.node`, 'bad_node');
    if (!crewIds.has(c.currentCrewId)) throw fault(`${at}.currentCrewId`, 'unknown_crew');
    for (const key of ['start', 'serviceMinutes']) {
      if (!has(c, key)) throw fault(`${at}.${key}`, 'missing');
      if (!Number.isSafeInteger(c[key])) throw fault(`${at}.${key}`, 'not_integer');
      if (c[key] < 0 || c[key] > DAY_MINUTES) throw fault(`${at}.${key}`, 'out_of_range');
    }
  });
}

// --- gaps ------------------------------------------------------------------------

// Every gap on every working crew with a cancellation, crews in compareIds
// order, gaps in day order.
function findGaps(m, input) {
  const { limits } = input;
  const gaps = [];
  const stopAt = new Map(input.stops.map((s, i) => [s.stopId, `stops[${i}]`]));
  for (const crew of m.crews) {
    const cancelled = input.cancelled.filter((c) => c.currentCrewId === crew.crewId);
    if (cancelled.length === 0) continue;
    const remaining = input.stops.filter((s) => s.currentCrewId === crew.crewId);
    for (const s of remaining) if (!has(s, 'start')) throw fault(`${stopAt.get(s.stopId)}.start`, 'missing');
    const seq = [
      ...remaining.map((stop) => ({ stop, cancelled: false })),
      ...cancelled.map((stop) => ({ stop, cancelled: true })),
    ].sort((a, b) => a.stop.start - b.stop.start || compareIds(a.stop.stopId, b.stop.stopId));
    for (let k = 0; k < seq.length; k += 1) {
      if (!seq[k].cancelled || (k > 0 && seq[k - 1].cancelled)) continue;
      let end = k;
      while (end + 1 < seq.length && seq[end + 1].cancelled) end += 1;
      const prev = k > 0 ? seq[k - 1].stop : null;
      const next = end + 1 < seq.length ? seq[end + 1].stop : null;
      gaps.push({
        crew,
        cancelled: seq.slice(k, end + 1).map((e) => e.stop.stopId),
        prev,
        next,
        from: prev ? prev.start + prev.serviceMinutes : limits.earliestStart,
        to: next ? next.start : limits.latestFinish,
      });
      k = end;
    }
  }
  return gaps;
}

// --- one candidate in one gap ------------------------------------------------------

function tryCandidate(ctx, gap, cand, at) {
  const { input, travel, registry, returnToBase, limits } = ctx;
  const { crew } = gap;
  const fromNode = gap.prev ? gap.prev.node : crew.baseNode;
  let toNode = null;
  if (gap.next) toNode = gap.next.node;
  else if (returnToBase) toNode = crew.baseNode;
  const travelIn = travel(fromNode, cand.node);
  const travelOut = toNode === null ? 0 : travel(cand.node, toNode);
  const direct = toNode === null ? 0 : travel(fromNode, toNode);
  const step = limits.startRoundTo;
  const roundUp = (t) => Math.ceil(t / step) * step;
  const earliest = Math.max(roundUp(gap.from + travelIn), roundUp(limits.earliestStart));
  const latestStart = gap.to - travelOut - cand.serviceMinutes;
  if (earliest > latestStart) {
    const need = travelIn + cand.serviceMinutes + travelOut;
    return {
      ok: false,
      reason: `${travelIn} minutes' drive in, ${cand.serviceMinutes} on site and ${travelOut} out need ${plural(need, 'minute')}; `
        + `the gap from ${clock(gap.from)} to ${clock(gap.to)} has ${plural(Math.max(0, gap.to - gap.from), 'minute')}`,
    };
  }
  const own = new Set(cand.rules.map((r) => r.ruleId));
  let best = null;
  for (let start = earliest; start <= latestStart; start += step) {
    const t = registry.evaluate(cand, { crewId: crew.crewId, start, finish: start + cand.serviceMinutes }, ctx.ruleCtx, at);
    if (!best || t.hardBreaks < best.t.hardBreaks || (t.hardBreaks === best.t.hardBreaks && t.softPenalty < best.t.softPenalty)) best = { start, t };
    if (t.hardBreaks === 0 && t.softPenalty === 0) break;
  }
  if (best.t.hardBreaks > 0) {
    const check = best.t.checks.find((c) => !c.ok && c.strength === 'hard');
    return { ok: false, reason: `no start in the gap keeps every hard rule (${check.label}: ${check.reason})` };
  }
  const windowFit = best.t.checks.every((c) => c.ok || !own.has(c.ruleId));
  return {
    ok: true,
    start: best.start,
    travelIn,
    travelOut,
    extraDrive: travelIn + travelOut - direct,
    windowFit,
    daysMovedUp: dayNumber(cand.plannedDate) - dayNumber(input.day),
  };
}

// Why a candidate is left out before any drive is read, or null.
function filterWords(ctx, cand) {
  const { input, exclude, cancelledNodes, visitedNodes, horizon } = ctx;
  if (exclude.has(cand.stopId)) return 'left out at the caller\'s request';
  if (cancelledNodes.has(cand.node)) return `its property cancelled a visit on ${input.day}`;
  if (visitedNodes.has(cand.node)) return `its property already has a visit on ${input.day}`;
  const ahead = dayNumber(cand.plannedDate) - dayNumber(input.day);
  if (ahead <= 0) return `planned for ${cand.plannedDate}, not after ${input.day}`;
  if (ahead > horizon) return `planned for ${cand.plannedDate}, more than ${plural(horizon, 'day')} after ${input.day}`;
  if (cand.locked) return 'locked to its booked day and start';
  if (cand.prevVisitDate !== null) {
    const since = dayNumber(input.day) - dayNumber(cand.prevVisitDate);
    if (2 * since < cand.cadenceDays) {
      return `moving it up would leave ${plural(since, 'day')} since its last visit on ${cand.prevVisitDate}, `
        + `under half its ${cand.cadenceDays}-day cadence`;
    }
  }
  return null;
}

function rowReason(gap, fit, scored, cand) {
  const drive = fit.extraDrive >= 0
    ? `${plural(fit.extraDrive, 'more minute')} of driving`
    : `${plural(-fit.extraDrive, 'fewer minute')} of driving`;
  return `${scored.reason}; could start at ${clock(fit.start)} on crew ${gap.crew.crewId} `
    + `(${fit.travelIn} minutes' drive in, ${fit.travelOut} out, ${drive}); `
    + `moves up ${plural(fit.daysMovedUp, 'day')} from ${cand.plannedDate}; call to confirm`;
}

function gapWords(gap) {
  const which = gap.cancelled.length === 1 ? `stop ${gap.cancelled[0]}` : `stops ${gap.cancelled.join(', ')}`;
  return `the ${Math.max(0, gap.to - gap.from)}-minute gap on crew ${gap.crew.crewId} `
    + `from ${clock(gap.from)} to ${clock(gap.to)} (cancelled ${which})`;
}

// --- the entry point -----------------------------------------------------------------

function fillGap(input, opts = {}) {
  validateInput(input);
  const options = checkOpts(opts);
  const limit = intOpt(opts, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
  const horizon = intOpt(opts, 'horizonDays', DEFAULT_HORIZON, 1, MAX_HORIZON);
  const exclude = excludeOpt(opts);
  const spec = rankingSpec(opts.weights, horizon);
  const m = model(input, options);
  checkCancelled(input, new Set(m.crewIndex.keys()));
  const candidates = (input.candidates || [])
    .map((cand, i) => ({ cand, at: `candidates[${i}]` }))
    .sort((a, b) => compareIds(a.cand.stopId, b.cand.stopId));
  // A candidate's rule instances are checked once, up front, like the day's.
  for (const { cand, at } of candidates) options.registry.resolve(cand, at);

  const ctx = {
    input,
    limits: input.limits,
    travel: options.travel,
    registry: options.registry,
    returnToBase: options.returnToBase,
    ruleCtx: Object.freeze({ day: input.day, limits: input.limits }),
    exclude,
    horizon,
    cancelledNodes: new Set(input.cancelled.map((c) => c.node)),
    visitedNodes: new Set(input.stops.map((s) => s.node)),
  };

  const gaps = findGaps(m, input).map((gap) => {
    const gapId = gap.cancelled[0];
    const base = {
      gapId,
      crewId: gap.crew.crewId,
      cancelled: gap.cancelled,
      after: gap.prev ? gap.prev.stopId : null,
      before: gap.next ? gap.next.stopId : null,
      from: gap.from,
      to: gap.to,
      minutes: Math.max(0, gap.to - gap.from),
      considered: candidates.length,
    };
    if (!gap.crew.available) {
      return {
        ...base,
        valid: 0,
        candidates: [],
        excluded: [],
        reason: `crew ${gap.crew.crewId} is not working today, so ${gapWords(gap)} is not filled; place its stops instead`,
      };
    }
    const excluded = [];
    const fits = new Map();
    for (const { cand, at } of candidates) {
      const why = filterWords(ctx, cand);
      if (why !== null) {
        excluded.push({ stopId: cand.stopId, reason: why });
        continue;
      }
      const fit = tryCandidate(ctx, gap, cand, at);
      if (!fit.ok) excluded.push({ stopId: cand.stopId, reason: fit.reason });
      else fits.set(cand.stopId, { cand, fit });
    }
    const rows = [...fits.values()].map(({ cand, fit }) => ({
      stopId: cand.stopId,
      extra_drive_minutes: fit.extraDrive,
      flexible: cand.flexible,
      days_moved_up: fit.daysMovedUp,
      window_fit: fit.windowFit,
    }));
    const ranked = rows.length === 0 ? [] : scoring.rank(rows, spec, { limit });
    const out = ranked.map((scored, k) => {
      const { cand, fit } = fits.get(scored.row.stopId);
      return {
        stopId: cand.stopId,
        rank: k + 1,
        score: scored.score,
        fromCrew: has(cand, 'currentCrewId') ? cand.currentCrewId : null,
        plannedDate: cand.plannedDate,
        daysMovedUp: fit.daysMovedUp,
        start: fit.start,
        travelInMinutes: fit.travelIn,
        travelOutMinutes: fit.travelOut,
        extraDriveMinutes: fit.extraDrive,
        flexible: cand.flexible,
        windowFit: fit.windowFit,
        alsoOfferedFor: [],
        reason: rowReason(gap, fit, scored, cand),
      };
    });
    const reason = out.length === 0
      ? `no candidate fits ${gapWords(gap)}: none of ${plural(candidates.length, 'candidate')} passed (each is listed with its reason); nothing to offer`
      : `${fits.size} of ${plural(candidates.length, 'candidate')} fit ${gapWords(gap)}; showing the top ${out.length}`;
    return { ...base, valid: fits.size, candidates: out, excluded, reason };
  });

  // A candidate offered in more than one gap names the others.
  const offeredIn = new Map();
  for (const gap of gaps) {
    for (const row of gap.candidates) {
      if (!offeredIn.has(row.stopId)) offeredIn.set(row.stopId, []);
      offeredIn.get(row.stopId).push(gap.gapId);
    }
  }
  for (const gap of gaps) {
    for (const row of gap.candidates) {
      row.alsoOfferedFor = offeredIn.get(row.stopId).filter((id) => id !== gap.gapId).sort(compareIds);
    }
  }

  let reason;
  if (gaps.length === 0) reason = 'no visit was cancelled on a crew today; no gap to fill';
  else {
    const offered = gaps.reduce((n, g) => n + g.candidates.length, 0);
    const offer = offered === 0
      ? 'no candidate to offer'
      : `${plural(offered, 'candidate row')} offered, best first in each gap; call to confirm before moving a visit`;
    reason = `${plural(gaps.length, 'gap')} from ${plural(input.cancelled.length, 'cancelled visit')}; ${offer}`;
  }
  return { day: input.day, reason, gaps };
}

module.exports = { fillGap, RANKING, DEFAULT_LIMIT, DEFAULT_HORIZON, dayNumber };
