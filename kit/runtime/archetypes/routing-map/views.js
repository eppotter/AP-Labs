'use strict';

// The four routing-map views (Story 15.4, AD-R16, AD-R17): what each draws
// and lists, cut to the person's scope. Pure and synchronous: the engine runs
// here (kit/runtime/routing, itself pure), nothing is read, logged or sent.
//
//   compare  booked vs optimized for one crew's day (the input cut to that
//            crew, so the optimizer only reorders it), with both drive totals
//   change   before vs after for the crews of one zone (a crew lead: their
//            crew) when a crew is out: moved stops ringed, a cross-zone
//            recommendation dashed, stops to rebook hollow
//   zone     the booked routes of one zone's crews (a crew lead: their crew),
//            one color per crew, the zone's padded outline
//   gap      the first gap a cancellation leaves on one crew, and up to five
//            ranked visits that could be moved up into it
//
// planView(...) returns a plan: the node ids to place (mapPoints), the node
// ids to name (adapter.labels) and build(points, labels), which gives the
// map model, the text list and the alt text's parts. A view with nothing to
// draw (no stops, no crew out, no gap) returns { empty } words instead.
//
// Scope (AD-R17) is applied here, before any node id leaves: a crew lead's
// lists hold only their crew. Stops moved off their crew show as "moved to
// another crew" with no destination; stops moved onto it show in full; gap
// candidates booked on other crews (or on none) are counted, never named or
// drawn, and the visible ones are renumbered 1..n. A dispatcher's lists hold
// the picked crew or zone. Node ids, crew ids and minutes only reach the
// renderer; the text holds crew names, client names, cities, clock times,
// minutes and the engine's reasons (rule labels, crew ids, times), never a
// coordinate, address or postal code (the labels hold none).

const engine = require('../../routing');
const { compareIds } = require('../../scoring');
const { RoutingFault } = require('../../errors');
const { escapeText } = require('../../messages');
const { MAX_COLOR } = require('../../routing-map/svg');
const { visible } = require('./audience');

const VIEWS = Object.freeze(['compare', 'change', 'zone', 'gap']);
const VIEW_LABELS = Object.freeze({
  compare: 'Booked vs optimized', change: 'Route change', zone: 'Zone', gap: 'Gap fill',
});
// The frame mapPoints draws into, per panel (a two-panel image is twice as
// wide). Inside mapPoints's bounds (200..2000, padding 0..200).
const FRAME = Object.freeze({ width: 700, height: 560, padding: 40 });
const MAX_CANDIDATES = 5;
const SEP = ' · ';
const SUGGEST_ONLY = '_Suggestion only: nothing has been changed. Call each customer to confirm before moving a visit._';
const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
// A crew or zone label the alt text accepts (kit/runtime/slack/image LABEL).
const ALT_LABEL = /^[A-Za-z0-9][A-Za-z0-9 '’&()./-]{0,59}$/;

const pad2 = (n) => String(n).padStart(2, '0');
const clock = (m) => (Number.isInteger(m) ? `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}` : '--:--');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const crewNode = (crewId) => `crew:${crewId}`;

function weekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
const dayWords = (day) => `${weekday(day)} ${day}`;

// --- the day as the views read it -----------------------------------------------

function dayOf(input) {
  const crews = [...input.crews].sort((a, b) => compareIds(a.crewId, b.crewId));
  const color = new Map(crews.map((c, i) => [c.crewId, i % (MAX_COLOR + 1)]));
  const crewById = new Map(crews.map((c) => [c.crewId, c]));
  const stopById = new Map();
  for (const list of [input.stops, input.cancelled || [], input.candidates || []]) for (const s of list) stopById.set(s.stopId, s);
  return { input, crews, color, crewById, stopById };
}

// A crew's booked stops, in booked order: routeOrder, then start, then id.
function booked(d, crewId) {
  const rank = (v) => (Number.isInteger(v) ? v : Number.MAX_SAFE_INTEGER);
  return d.input.stops.filter((s) => s.currentCrewId === crewId)
    .sort((a, b) => rank(a.routeOrder) - rank(b.routeOrder) || rank(a.start) - rank(b.start) || compareIds(a.stopId, b.stopId));
}

const nodeOf = (d, stopId) => {
  const s = d.stopById.get(stopId);
  if (!s) throw new RoutingFault({ field: 'stopId', problem: 'missing' });
  return s.node;
};

const modelCrew = (d, crewId) => ({ crewId, color: d.color.get(crewId), baseNode: d.crewById.get(crewId).baseNode });

// The crews and zones the pick select offers this scope, in compareIds order.
function choices(input, scope) {
  const crews = input.crews.map((c) => c.crewId).filter((id) => visible(scope, id)).sort(compareIds);
  const zones = scope.all === true ? [...new Set(input.crews.map((c) => c.zoneId))].sort(compareIds) : [];
  return { crews, zones };
}

// Which select a view offers: a crew lead always picks (only) their crew.
const pickKind = (view, scope) => (scope.all === true && (view === 'zone' || view === 'change') ? 'zone' : 'crew');

// The crew or zone this view draws: a crew lead's own crew, whatever the
// click said; a dispatcher's pick when the day has it, else the first.
function resolvePick(view, scope, picks, opts) {
  if (scope.all !== true) return { kind: 'crew', id: scope.crewId };
  const kind = pickKind(view, scope);
  const list = kind === 'zone' ? opts.zones : opts.crews;
  const wanted = kind === 'zone' ? picks.zone : picks.crew;
  return { kind, id: list.includes(wanted) ? wanted : (list[0] === undefined ? null : list[0]) };
}

// --- naming, from the adapter's labels ------------------------------------------

function namer(labels) {
  const of = (node) => (labels.get(node) || {});
  const crew = (crewId) => {
    const name = of(crewNode(crewId)).crewName;
    return name ? escapeText(name) : `Crew ${escapeText(crewId)}`;
  };
  const place = (node) => {
    const l = of(node);
    const parts = [l.clientName, l.city].filter((v) => typeof v === 'string' && v);
    return parts.length ? escapeText(parts.join(', ')) : 'a stop';
  };
  // For the alt text and the select: a plain label, or a safe fallback.
  const crewLabel = (crewId) => {
    const name = of(crewNode(crewId)).crewName;
    if (typeof name === 'string' && ALT_LABEL.test(name)) return name;
    return ALT_LABEL.test(`Crew ${crewId}`) ? `Crew ${crewId}` : 'Crew';
  };
  return { crew, place, crewLabel };
}

const zoneLabel = (zoneId) => (ALT_LABEL.test(`Zone ${zoneId}`) ? `Zone ${zoneId}` : 'Zone');

const row = (...parts) => parts.filter((p) => p !== null && p !== undefined && p !== '').join(SEP);

// One crew's route as rows: number, start, crew, place, drive minutes, reason.
function routeRows(n, crewId, stops) {
  return stops.map((s, i) => `${i + 1}. ${row(clock(s.start), n.crew(crewId), n.place(s.node), `${s.drive} min drive`, escapeText(s.reason))}`);
}

// --- the views ----------------------------------------------------------------------

function compare(d, { travel, pick }) {
  const crewId = pick.id;
  const stops = booked(d, crewId);
  const base = { day: d.input.day, crewId };
  if (!stops.length) return { empty: (n) => `${n.crew(crewId)} has no stops booked on ${dayWords(base.day)}.`, labelNodes: [crewNode(crewId)] };
  const cut = { ...d.input, crews: [d.crewById.get(crewId)], stops };
  delete cut.cancelled;
  delete cut.candidates;
  const result = engine.optimizeDay(cut, { travel });
  const plan = result.plans.find((p) => p.crewId === crewId) || { stops: [] };
  const optimized = plan.stops.map((s) => ({
    node: nodeOf(d, s.stopId), start: s.start, drive: s.travelMinutesFromPrevious, reason: s.reason,
  }));
  const unplaced = result.unplaced.map((u) => ({ node: nodeOf(d, u.stopId), reason: u.reason }));
  const bookedNodes = stops.map((s) => s.node);
  return {
    nodes: [crewNode(crewId), ...bookedNodes].map(String),
    placeNodes: bookedNodes,
    crewIds: [crewId],
    build: (n) => ({
      model: {
        crews: [modelCrew(d, crewId)],
        booked: [{ crewId, stops: bookedNodes }],
        optimized: [{ crewId, stops: optimized.map((s) => s.node) }],
      },
      title: `*Booked vs optimized: ${n.crew(crewId)}, ${dayWords(base.day)}*`,
      lines: [
        `Driving: booked ${result.booked.driveMinutes} min, optimized ${result.cost.driveMinutes} min. ${escapeText(result.reason)}.`,
        ...routeRows(n, crewId, optimized),
        ...unplaced.map((u) => `Not placed: ${row(n.place(u.node), escapeText(u.reason))}`),
      ],
      alt: { crew: n.crewLabel(crewId), stops: optimized.length },
    }),
  };
}

function change(d, { travel, scope, pick }) {
  const result = engine.placeOrphans(d.input, { travel });
  const lead = scope.all !== true;
  const shown = (crewId) => (lead ? crewId === scope.crewId : (d.crewById.get(crewId) || {}).zoneId === pick.id);
  const viewCrews = d.crews.map((c) => c.crewId).filter(shown);
  const words = lead ? null : zoneLabel(pick.id);
  if (!result.crewsOut.length) {
    return {
      empty: (n) => `No crew is out on ${dayWords(d.input.day)}, so there's no route change to show for ${lead ? n.crew(scope.crewId) : escapeText(words)}.`,
      labelNodes: lead ? [crewNode(scope.crewId)] : [],
    };
  }
  const before = viewCrews.map((crewId) => ({ crewId, stops: booked(d, crewId).map((s) => s.node) }));
  const plans = new Map(result.plans.map((p) => [p.crewId, p]));
  const afterStops = new Map(viewCrews.map((crewId) => [crewId, ((plans.get(crewId) || {}).stops || []).map((s) => ({
    node: nodeOf(d, s.stopId), start: s.start, drive: s.travelMinutesFromPrevious, reason: s.reason,
  }))]));
  const after = viewCrews.map((crewId) => ({ crewId, stops: afterStops.get(crewId).map((s) => s.node) }));

  const moved = [];
  const crossZone = [];
  const crossRows = [];
  const movedOff = [];
  const extraCrews = [];
  for (const m of result.moves) {
    const node = nodeOf(d, m.stopId);
    const from = shown(m.fromCrew);
    const to = shown(m.toCrew);
    if (!from && !to) continue;
    if (lead && from && !to) {
      // Moved off a lead's crew: no destination, no line (AD-R17 b).
      moved.push(node);
      movedOff.push(node);
    } else if (m.crossZone) {
      // Dashed from the receiving crew's base. For a crew lead this is only
      // ever a recommendation onto their own crew, shown in full.
      crossZone.push({ node, crewId: m.toCrew });
      crossRows.push({ node, toCrew: m.toCrew, start: m.start, reason: m.reason });
      if (!viewCrews.includes(m.toCrew) && !extraCrews.includes(m.toCrew)) extraCrews.push(m.toCrew);
    } else {
      moved.push(node);
    }
  }
  const unplaced = result.unplaced
    .filter((u) => shown((d.stopById.get(u.stopId) || {}).currentCrewId))
    .map((u) => ({ node: nodeOf(d, u.stopId), reason: u.reason }));
  const shifted = result.shifted.filter((s) => shown(s.crewId))
    .map((s) => ({ node: nodeOf(d, s.stopId), crewId: s.crewId, previousStart: s.previousStart, start: s.start, reason: s.reason }));
  const modelCrews = [...viewCrews, ...extraCrews.sort(compareIds)];
  const placeNodes = [...before.flatMap((r) => r.stops), ...after.flatMap((r) => r.stops), ...crossZone.map((z) => z.node)];
  const out = result.crewsOut.filter(shown);
  return {
    nodes: [...modelCrews.map(crewNode), ...placeNodes],
    placeNodes,
    crewIds: modelCrews,
    build: (n) => ({
      model: {
        crews: modelCrews.map((c) => modelCrew(d, c)),
        before,
        after,
        moved: [...new Set(moved)],
        crossZone,
        unplaced: unplaced.map((u) => u.node),
      },
      title: `*Route change: ${lead ? n.crew(scope.crewId) : escapeText(words)}, ${dayWords(d.input.day)}*`,
      lines: [
        ...(lead ? [] : [`${escapeText(result.reason)}.`]),
        ...(out.length ? [`Not working: ${out.map((c) => n.crew(c)).join(', ')}.`] : []),
        ...viewCrews.flatMap((c) => routeRows(n, c, afterStops.get(c))),
        ...movedOff.map((node) => `Moved: ${row(n.place(node), 'moved to another crew')}`),
        ...crossRows.map((z) => `Recommended for another zone, not placed: ${row(clock(z.start), n.crew(z.toCrew), n.place(z.node), escapeText(z.reason))}`),
        ...unplaced.map((u) => `To rebook: ${row(n.place(u.node), escapeText(u.reason))}`),
        ...shifted.map((s) => `New time: ${row(`${clock(s.previousStart)} to ${clock(s.start)}`, n.crew(s.crewId), n.place(s.node), escapeText(s.reason))}`),
      ],
      alt: { crew: lead ? n.crewLabel(scope.crewId) : zoneLabel(pick.id), stops: after.reduce((k, r) => k + r.stops.length, 0) },
    }),
  };
}

function zone(d, { travel, scope, pick }) {
  const lead = scope.all !== true;
  const viewCrews = d.crews.filter((c) => (lead ? c.crewId === scope.crewId : c.zoneId === pick.id)).map((c) => c.crewId);
  const routes = viewCrews.map((crewId) => {
    let prev = crewNode(crewId);
    const stops = booked(d, crewId).map((s) => {
      const drive = travel(prev, s.node);
      prev = s.node;
      return { node: s.node, start: s.start, drive, reason: 'as booked' };
    });
    return { crewId, stops };
  });
  const count = routes.reduce((k, r) => k + r.stops.length, 0);
  const zoneId = lead ? d.crewById.get(scope.crewId).zoneId : pick.id;
  const what = (n) => (lead ? n.crew(scope.crewId) : escapeText(zoneLabel(zoneId)));
  if (!count) return { empty: (n) => `No stops are booked for ${what(n)} on ${dayWords(d.input.day)}.`, labelNodes: lead ? [crewNode(scope.crewId)] : [] };
  const placeNodes = routes.flatMap((r) => r.stops.map((s) => s.node));
  return {
    nodes: [...viewCrews.map(crewNode), ...placeNodes],
    placeNodes,
    crewIds: viewCrews,
    build: (n) => ({
      model: {
        crews: viewCrews.map((c) => modelCrew(d, c)),
        routes: routes.map((r) => ({ crewId: r.crewId, stops: r.stops.map((s) => s.node) })),
        zones: [{ zoneId, crewIds: viewCrews }],
      },
      title: `*${lead ? 'Your crew' : escapeText(zoneLabel(zoneId))}: ${lead ? n.crew(scope.crewId) : plural(viewCrews.length, 'crew')}, ${dayWords(d.input.day)}*`,
      lines: routes.flatMap((r) => routeRows(n, r.crewId, r.stops)),
      alt: { crew: lead ? n.crewLabel(scope.crewId) : zoneLabel(zoneId), stops: count },
    }),
  };
}

function gap(d, { travel, scope, pick, gapFill }) {
  const crewId = pick.id;
  const lead = scope.all !== true;
  const result = engine.fillGap(d.input, { travel, horizonDays: gapFill.horizon_days, limit: gapFill.limit });
  const gaps = result.gaps.filter((g) => g.crewId === crewId);
  if (!gaps.length) {
    return {
      empty: (n) => `No visit was cancelled on ${n.crew(crewId)} on ${dayWords(d.input.day)}, so there's no gap to fill.`,
      labelNodes: [crewNode(crewId)],
    };
  }
  const g = gaps[0];
  const route = booked(d, crewId).map((s) => s.node);
  const ranked = g.candidates.filter((c) => !lead || c.fromCrew === crewId);
  const hidden = g.candidates.length - ranked.length;
  // Renumbered 1..n, so no gap in the numbers shows a hidden one.
  const cands = ranked.slice(0, MAX_CANDIDATES).map((c, i) => ({
    rank: i + 1, node: nodeOf(d, c.stopId), start: c.start, fromCrew: c.fromCrew, plannedDate: c.plannedDate,
    daysMovedUp: c.daysMovedUp, extra: c.extraDriveMinutes, reason: c.reason,
  }));
  const beforeNode = g.after === null ? crewNode(crewId) : nodeOf(d, g.after);
  const afterNode = g.before === null ? null : nodeOf(d, g.before);
  const cancelled = g.cancelled.map((id) => nodeOf(d, id));
  const placeNodes = [...route, ...cands.map((c) => c.node)];
  const crewsNamed = lead ? [crewId] : [...new Set([crewId, ...cands.map((c) => c.fromCrew).filter((c) => typeof c === 'string')])];
  return {
    nodes: [crewNode(crewId), ...placeNodes],
    placeNodes: [...placeNodes, ...cancelled],
    crewIds: crewsNamed,
    build: (n) => ({
      model: {
        crews: [modelCrew(d, crewId)],
        routes: [{ crewId, stops: route }],
        gap: { crewId, before: beforeNode, after: afterNode },
        candidates: cands.map((c) => ({ node: c.node, rank: c.rank })),
      },
      title: `*Gap fill: ${n.crew(crewId)}, ${dayWords(d.input.day)}*`,
      lines: [
        `Gap: ${clock(g.from)} to ${clock(g.to)} (${g.minutes} min), after ${g.after === null ? 'the start of the day' : n.place(beforeNode)}, `
          + `before ${afterNode === null ? 'the end of the day' : n.place(afterNode)}.`,
        `Cancelled: ${cancelled.map((c) => n.place(c)).join('; ')}.`,
        ...cands.map((c) => `${c.rank}. ${row(clock(c.start), n.place(c.node), `booked ${c.fromCrew === null ? 'on no crew' : `on ${n.crew(c.fromCrew)}`} for ${c.plannedDate} (${plural(c.daysMovedUp, 'day')} earlier)`, `${c.extra} min extra drive`, escapeText(c.reason))}`),
        ...(cands.length ? [] : ['No visit can be moved up into this gap.']),
        ...(hidden > 0 ? [`${plural(hidden, 'more visit')} booked on other crews could fill it; ${hidden === 1 ? 'it is' : 'they are'} not shown here.`] : []),
        ...(gaps.length > 1 ? [`${plural(gaps.length - 1, 'more gap')} on this crew today; only the first is shown.`] : []),
      ],
      alt: { crew: n.crewLabel(crewId), stops: route.length },
    }),
  };
}

const PLANS = Object.freeze({
  compare, change, zone, gap,
});

// The plan for one view: { empty, labelNodes } or { nodes, placeNodes,
// crewIds, build }. gapFill: the profile's routing.gap_fill.
function planView({ view, input, travel, scope, pick, gapFill }) {
  if (!VIEWS.includes(view)) throw new RoutingFault({ field: 'view', problem: 'out_of_range' });
  engine.validateInput(input);
  const d = dayOf(input);
  return PLANS[view](d, {
    travel, scope, pick, gapFill,
  });
}

// The whole text list: title, rows, the suggest-only line.
function textOf(built) {
  return [built.title, ...built.lines, SUGGEST_ONLY].join('\n');
}

module.exports = {
  planView, choices, resolvePick, pickKind, namer, zoneLabel, textOf, dayWords, clock,
  VIEWS, VIEW_LABELS, FRAME, MAX_CANDIDATES, SUGGEST_ONLY, ALT_LABEL,
};
