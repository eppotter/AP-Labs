'use strict';

// Brightside's routing adapter (Story 14.3, AD-R2, data-design §4): maps
// Brightside's tables to the routing engine's input contract and fetches the
// drive times the engine will read. The engine (kit/runtime/routing) never
// reads a client table; this file is the only place that knows Brightside's.
//
//   const adapter = createAdapter({ data, routing });
//   const { input, travel } = await adapter.dayInput({ day, crewIds? });
//   sdk.routing.optimizeDay(input, { travel })      // or placeOrphans
//   const gap = await adapter.gapInput({ day, crewId });
//   sdk.routing.fillGap(gap.input, { travel: gap.travel, horizonDays: routing.gap_fill.horizon_days })
//
// The routing map (Story 15.5, AD-R16, AD-R17): the same object is the
// routing-map archetype's adapter (modules/routing/adapter.js re-exports
// createAdapter): asOf(), input({ day, view, scope }) and labels({ day,
// nodeIds, scope }). labels.sql returns only a crew's name, or a property's
// client name and city, and is filtered by the scope (a crew lead's labels
// name no other crew).
//
// data is a full data object from createData (it has travelMatrix). A
// module's or job's ctx.data has only run and describe, so it is refused
// (sdk.travelMatrix rejects with RoutingFault data_unavailable). routing is
// the loaded profile's routing block (limits, gap_fill, max_pairs).
//
// Travel comes only from travelMatrix: the adapter's SQL (day.sql,
// crews.sql, candidates.sql) never names a coordinate column, and passes the
// query guardrail with the four coordinate columns forbidden. Node ids are
// kind-prefixed, property:<property_id> and crew:<crew_id>. Only the
// rectangles the engine reads are fetched, each call within max_pairs:
//   day   per zone, [the zone's crew bases, its stops] x [its stops]
//         (optimize never moves a stop across zones), plus, when a crew is
//         out, [every base, every stop] x [its stops] and [its stops] x
//         [every stop] (placeOrphans may recommend another zone's crew)
//   gap   per gap, the rows of [previous, ...candidates] x [...candidates,
//         next] that fillGap reads: previous to each candidate and to next,
//         each candidate to next. The candidate-to-candidate block is never
//         read and, with every property's next visit a candidate, would
//         exceed max_pairs, so it is not fetched.
//
// Brightside's mapping (the fixture's own rules, Story 14.2, data-design §6):
//   - a crew is out (available: false) when its lead is absent or nobody is
//     present; a crew with no lead on the day counts as out too. Pending Dana
//     Reyes's confirmation (GRD-008, DEP-028).
//   - headcount: memberships covering the day, less that day's absences.
//   - service time on a working crew: labour_minutes / headcount present,
//     rounded to routing.limits.slot_minutes, at least 30. An out crew's
//     stops keep their booked scheduled_minutes. A gap-fill candidate's
//     service time uses the gap crew's headcount that day.
//   - rules: preferred_crew -> preferred-crew (crew id), day_of_week
//     ('MON|THU') -> day-of-week ISO day numbers, time_of_day morning or
//     afternoon -> time-of-day { startFrom, startBefore } split at noon
//     within the profile's day limits; each with its row's strength.
//     flexible is true when a candidate has no hard day or time rule.
//   - cadence: weekly 7, biweekly 14, monthly 30 days.
//   - candidates: each property's next booked visit within
//     routing.gap_fill.horizon_days after the gap day, less every property
//     with a visit on the gap day; prevVisitDate is the latest non-cancelled
//     visit before the gap day across history and schedule.
//   - starts round to 5 minutes (limits.startRoundTo), as the booked
//     schedule's do.

const fs = require('node:fs');
const path = require('node:path');
const sdk = require('#sdk');

const { routing: engine, RoutingFault } = sdk;

const SQL = Object.freeze({
  day: fs.readFileSync(path.join(__dirname, 'day.sql'), 'utf8'),
  crews: fs.readFileSync(path.join(__dirname, 'crews.sql'), 'utf8'),
  candidates: fs.readFileSync(path.join(__dirname, 'candidates.sql'), 'utf8'),
  labels: fs.readFileSync(path.join(__dirname, 'labels.sql'), 'utf8'),
});
const AS_OF_SQL = "SELECT value FROM fixture_meta WHERE key = 'as_of'";

const START_ROUND_TO = 5;
const MIN_SERVICE_MINUTES = 30;
const NOON = 12 * 60;
const CADENCE_DAYS = Object.freeze({ weekly: 7, biweekly: 14, monthly: 30 });
const ISO_DAYS = Object.freeze({ MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 7 });
const STRENGTHS = Object.freeze(['hard', 'soft']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS = /^\d+$/;
const NODE_ID = /^(crew|property):(\d+)$/;

const fault = (field, problem) => new RoutingFault({ field, problem });
const propertyNode = (id) => `property:${id}`;
const crewNode = (id) => `crew:${id}`;
const compareIds = (a, b) => {
  if (DIGITS.test(a) && DIGITS.test(b)) {
    const [x, y] = [BigInt(a), BigInt(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};
const unique = (list) => [...new Set(list)];

// The profile's day limits as the contract's, and the two time windows.
function limitsOf(routing) {
  const l = routing && routing.limits;
  if (!l) throw fault('routing.limits', 'missing');
  return Object.freeze({
    earliestStart: l.earliest_start,
    defaultStart: l.default_start,
    aimFinish: l.aim_finish,
    latestFinish: l.latest_finish,
    startRoundTo: START_ROUND_TO,
  });
}

function windowsOf(limits) {
  return Object.freeze({
    morning: Object.freeze({ startFrom: limits.earliestStart, startBefore: NOON }),
    afternoon: Object.freeze({ startFrom: NOON, startBefore: limits.latestFinish }),
  });
}

function strengthOf(value, field) {
  if (!STRENGTHS.includes(value)) throw fault(field, 'bad_strength');
  return value;
}

// 'MON|THU' as ISO day numbers [1, 4].
function isoDaysOf(value) {
  const days = String(value).split('|').map((name) => ISO_DAYS[name.trim()]);
  if (days.length === 0 || days.some((d) => d === undefined)) throw fault('service_rules.day_of_week', 'out_of_range');
  return unique(days).sort((a, b) => a - b);
}

// A row's pivoted rules as rule instances (AD-R4), each with its strength.
function rulesOf(row, windows) {
  const rules = [];
  if (row.preferred_crew !== null && row.preferred_crew !== undefined) {
    rules.push({ ruleId: 'preferred-crew', value: String(row.preferred_crew), strength: strengthOf(row.preferred_crew_strength, 'service_rules.preferred_crew') });
  }
  if (row.allowed_days !== null && row.allowed_days !== undefined) {
    rules.push({ ruleId: 'day-of-week', value: isoDaysOf(row.allowed_days), strength: strengthOf(row.allowed_days_strength, 'service_rules.day_of_week') });
  }
  if (row.time_window !== null && row.time_window !== undefined) {
    const window = windows[row.time_window];
    if (!window) throw fault('service_rules.time_of_day', 'out_of_range');
    rules.push({ ruleId: 'time-of-day', value: { ...window }, strength: strengthOf(row.time_window_strength, 'service_rules.time_of_day') });
  }
  return rules;
}

const FIXED_DAY_RULES = new Set(['day-of-week', 'time-of-day']);
const isFlexible = (rules) => !rules.some((r) => FIXED_DAY_RULES.has(r.ruleId) && r.strength === 'hard');

// labour over the people present, to the slot, at least 30 minutes.
function serviceFor(labour, present, slot) {
  return Math.max(MIN_SERVICE_MINUTES, Math.round(labour / present / slot) * slot);
}

function checkDay(day) {
  if (typeof day !== 'string' || !ISO_DATE.test(day)) throw fault('day', 'bad_date');
  return day;
}

function createAdapter({ data, routing } = {}) {
  if (!data || typeof data.run !== 'function') throw fault('data', 'data_unavailable');
  const limits = limitsOf(routing);
  const windows = windowsOf(limits);
  const slot = routing.limits.slot_minutes;
  const maxPairs = routing.max_pairs;
  const horizonDays = routing.gap_fill && routing.gap_fill.horizon_days;
  if (!Number.isSafeInteger(slot) || slot < 1) throw fault('routing.limits.slot_minutes', 'out_of_range');
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 1) throw fault('routing.max_pairs', 'out_of_range');
  if (!Number.isSafeInteger(horizonDays) || horizonDays < 1) throw fault('routing.gap_fill.horizon_days', 'out_of_range');

  async function asOf() {
    const rows = await data.run(AS_OF_SQL);
    if (rows.length !== 1 || typeof rows[0].value !== 'string' || !ISO_DATE.test(rows[0].value)) throw fault('asOf', 'bad_date');
    return rows[0].value;
  }

  async function crewsOn(day) {
    const rows = await data.run(SQL.crews, { day }, { declared: ['day'] });
    return rows.map((r) => ({
      crewId: String(r.crew_id),
      zoneId: String(r.zone_id),
      baseNode: crewNode(r.crew_id),
      headcountPlanned: r.headcount_planned,
      headcountPresent: r.headcount_present,
      available: r.leads_present > 0 && r.headcount_present > 0,
    }));
  }

  // A booked visit as a stop. Service time from the crew's headcount that
  // day, or the booked minutes when the crew is out.
  function stopOf(row, crew) {
    const rules = rulesOf(row, windows);
    return {
      stopId: String(row.scheduled_visit_id),
      node: propertyNode(row.property_id),
      currentCrewId: String(row.crew_id),
      labourMinutes: row.labour_minutes,
      serviceMinutes: crew.available ? serviceFor(row.labour_minutes, crew.headcountPresent, slot) : row.scheduled_minutes,
      locked: false,
      rules,
      routeOrder: row.route_order,
      start: row.start_minutes,
    };
  }

  async function bookedDay(day) {
    checkDay(day);
    const as = await asOf();
    const crews = await crewsOn(day);
    const rows = await data.run(SQL.day, { day }, { declared: ['day'] });
    const crewById = new Map(crews.map((c) => [c.crewId, c]));
    const stops = [];
    const cancelled = [];
    for (const row of rows) {
      const crew = crewById.get(String(row.crew_id));
      if (!crew) throw fault('scheduled_visits.crew_id', 'unknown_crew');
      const stop = stopOf(row, crew);
      if (row.status === 'scheduled') stops.push(stop);
      else cancelled.push({ stopId: stop.stopId, node: stop.node, currentCrewId: stop.currentCrewId, start: stop.start, serviceMinutes: stop.serviceMinutes });
    }
    return { asOf: as, crews, stops, cancelled };
  }

  // Reads every rectangle, each split to stay within max_pairs, into one
  // travel function. A pair two rectangles share is kept once.
  async function travelFor(rects) {
    const rows = new Map();
    for (const [fromIds, toIds] of rects) {
      const from = unique(fromIds);
      const to = unique(toIds);
      if (from.length === 0 || to.length === 0) continue;
      for (let t = 0; t < to.length; t += maxPairs) {
        const toPart = to.slice(t, t + maxPairs);
        const step = Math.max(1, Math.floor(maxPairs / toPart.length));
        for (let f = 0; f < from.length; f += step) {
          for (const row of await sdk.travelMatrix(data, from.slice(f, f + step), toPart)) {
            rows.set(`${row.from_node}\u0000${row.to_node}`, row);
          }
        }
      }
    }
    return engine.travel.fromMatrix([...rows.values()]);
  }

  // The day's input for optimizeDay and placeOrphans. crewIds (optional)
  // keeps only those crews and their stops.
  async function dayInput({ day, crewIds } = {}) {
    const booked = await bookedDay(day);
    let { crews, stops } = booked;
    if (crewIds !== undefined) {
      if (!Array.isArray(crewIds)) throw fault('crewIds', 'not_list');
      const keep = new Set(crewIds.map(String));
      crews = crews.filter((c) => keep.has(c.crewId));
      if (crews.length !== keep.size) throw fault('crewIds', 'unknown_crew');
      stops = stops.filter((s) => keep.has(s.currentCrewId));
    }
    const input = { day, asOf: booked.asOf, limits: { ...limits }, crews, stops };
    engine.validateInput(input);

    const crewById = new Map(crews.map((c) => [c.crewId, c]));
    const rects = [];
    for (const zone of unique(crews.map((c) => c.zoneId))) {
      const zoneStops = stops.filter((s) => crewById.get(s.currentCrewId).zoneId === zone).map((s) => s.node);
      const bases = crews.filter((c) => c.zoneId === zone).map((c) => c.baseNode);
      rects.push([[...bases, ...zoneStops], zoneStops]);
    }
    const orphans = stops.filter((s) => !crewById.get(s.currentCrewId).available).map((s) => s.node);
    if (orphans.length > 0) {
      const all = stops.map((s) => s.node);
      rects.push([[...crews.map((c) => c.baseNode), ...all], orphans]);
      rects.push([orphans, all]);
    }
    return { input, travel: await travelFor(rects) };
  }

  // A candidate's service time on the gap crews: the gap crew's headcount
  // that day; with more than one gap crew (the map's gap view for a
  // dispatcher), the longest of theirs, so a fill is never suggested that
  // would not fit the crew with the fewest people. The booked minutes when
  // every gap crew is out.
  function candidateService(row, gapCrews) {
    const working = gapCrews.filter((c) => c.available);
    if (!working.length) return row.scheduled_minutes;
    return Math.max(...working.map((c) => serviceFor(row.labour_minutes, c.headcountPresent, slot)));
  }

  // The gap day's input for fillGap: every crew and booked stop that day (so
  // a property visited that day is never offered), the gap crews' cancelled
  // visits, and the candidates. gapCrewIds: the crews whose gaps are filled,
  // or null for every crew with a cancelled visit that day.
  async function gapDay(day, gapCrewIds) {
    const booked = await bookedDay(day);
    let gapCrews;
    if (gapCrewIds === null) {
      const withGaps = new Set(booked.cancelled.map((c) => c.currentCrewId));
      gapCrews = booked.crews.filter((c) => withGaps.has(c.crewId));
    } else {
      gapCrews = gapCrewIds.map((id) => {
        const crew = booked.crews.find((c) => c.crewId === String(id));
        if (!crew) throw fault('crewId', 'unknown_crew');
        return crew;
      });
    }
    const gapIds = new Set(gapCrews.map((c) => c.crewId));
    const cancelled = booked.cancelled.filter((c) => gapIds.has(c.currentCrewId));
    const rows = gapCrews.length
      ? await data.run(SQL.candidates, { day, horizon_days: horizonDays }, { declared: ['day', 'horizon_days'] })
      : [];
    const candidates = rows.map((row) => {
      const cadenceDays = CADENCE_DAYS[row.frequency];
      if (!cadenceDays) throw fault('plans.frequency', 'out_of_range');
      const rules = rulesOf(row, windows);
      return {
        stopId: String(row.scheduled_visit_id),
        node: propertyNode(row.property_id),
        currentCrewId: String(row.crew_id),
        labourMinutes: row.labour_minutes,
        serviceMinutes: candidateService(row, gapCrews),
        locked: false,
        rules,
        plannedDate: row.visit_date,
        cadenceDays,
        prevVisitDate: row.prev_visit_date === null || row.prev_visit_date === undefined ? null : row.prev_visit_date,
        flexible: isFlexible(rules),
      };
    });
    const input = { day, asOf: booked.asOf, limits: { ...limits }, crews: booked.crews, stops: booked.stops, candidates, cancelled };
    engine.validateInput(input);

    // Each gap's neighbours, as fillGap finds them: the crew's remaining
    // stops and cancelled visits in start order; a run of cancelled visits
    // is one gap, between the stop before it (or the crew's base) and the
    // stop after it (or the end of the day).
    const candNodes = candidates.map((c) => c.node);
    const rects = [];
    for (const crew of gapCrews) {
      const seq = [
        ...booked.stops.filter((s) => s.currentCrewId === crew.crewId).map((stop) => ({ stop, cancelled: false })),
        ...cancelled.filter((s) => s.currentCrewId === crew.crewId).map((stop) => ({ stop, cancelled: true })),
      ].sort((a, b) => a.stop.start - b.stop.start || compareIds(a.stop.stopId, b.stop.stopId));
      for (let k = 0; k < seq.length; k += 1) {
        if (!seq[k].cancelled || (k > 0 && seq[k - 1].cancelled)) continue;
        let end = k;
        while (end + 1 < seq.length && seq[end + 1].cancelled) end += 1;
        const prev = k > 0 ? seq[k - 1].stop.node : crew.baseNode;
        const next = end + 1 < seq.length ? seq[end + 1].stop.node : null;
        rects.push([[prev], next === null ? candNodes : [...candNodes, next]]);
        if (next !== null) rects.push([candNodes, [next]]);
        k = end;
      }
    }
    return { input, travel: await travelFor(rects) };
  }

  // The gap day's input for one crew's gaps. A candidate's service time uses
  // crewId's headcount.
  async function gapInput({ day, crewId } = {}) {
    if (crewId === undefined || crewId === null) throw fault('crewId', 'missing');
    return gapDay(day, [crewId]);
  }

  // --- The routing map (Story 15.5, AD-R16): the routing-map archetype's
  // adapter contract (kit/runtime/archetypes/routing-map), over dayInput,
  // gapDay and labels.sql.

  const leadOf = (scope) => (scope && scope.all !== true && typeof scope.crewId === 'string' ? scope.crewId : null);
  const isUnknownCrew = (err) => err instanceof RoutingFault && ['crewIds', 'crewId'].includes(err.details.field)
    && err.details.problem === 'unknown_crew';

  // { input, travel } for one map view. compare and zone are cut to a crew
  // lead's crew; change and gap are not (the engine needs the other crews to
  // place a sick crew's stops, and a lead's gap candidates come from every
  // crew). A dispatcher's gap view fills every crew's gaps (the archetype
  // shows the picked crew's). A lead whose crew is not in the day gets the
  // whole day, so the archetype's configuration check refuses them (never
  // an empty map).
  async function input({ day, view, scope } = {}) {
    const lead = leadOf(scope);
    if (view === 'gap') {
      if (lead === null) return gapDay(day, null);
      try {
        return await gapDay(day, [lead]);
      } catch (err) {
        if (!isUnknownCrew(err)) throw err;
        return dayInput({ day });
      }
    }
    if (lead !== null && (view === 'compare' || view === 'zone')) {
      try {
        return await dayInput({ day, crewIds: [lead] });
      } catch (err) {
        if (!isUnknownCrew(err)) throw err;
      }
    }
    return dayInput({ day });
  }

  // Per asked node id, { crewName } for a crew and { clientName, city } for
  // a property, and nothing else (labels.sql). Filtered by scope: a crew
  // lead's labels name no other crew. An id the data does not know is left
  // out (the archetype then shows "Crew <id>" or "a stop").
  async function labels({ nodeIds, scope } = {}) {
    if (!Array.isArray(nodeIds)) throw fault('nodeIds', 'not_list');
    const crewIds = [];
    const propertyIds = [];
    for (const node of nodeIds) {
      const m = NODE_ID.exec(typeof node === 'string' ? node : '');
      if (!m) throw fault('nodeIds', 'bad_node');
      (m[1] === 'crew' ? crewIds : propertyIds).push(m[2]);
    }
    const lead = leadOf(scope);
    const out = {};
    if (!nodeIds.length || (lead !== null && !DIGITS.test(lead))) return out;
    const rows = await data.run(SQL.labels, {
      crew_ids: unique(crewIds).join(','), property_ids: unique(propertyIds).join(','), crew_id: lead === null ? '' : lead,
    }, { declared: ['crew_ids', 'property_ids', 'crew_id'] });
    for (const r of rows) {
      out[r.node] = r.node.startsWith('crew:') ? { crewName: r.crew_name } : { clientName: r.client_name, city: r.city };
    }
    return out;
  }

  return Object.freeze({
    asOf, input, labels, dayInput, gapInput,
  });
}

module.exports = { createAdapter, SQL, isoDaysOf, serviceFor, isFlexible, CADENCE_DAYS };
