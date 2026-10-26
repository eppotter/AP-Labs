'use strict';

// The route map as SVG (Story 15.3, AD-R14). renderSvg(view, model) is pure:
// no clock, randomness, I/O or async, integer arithmetic only, so the same
// model gives byte-identical SVG on every machine. The SVG holds no <text>,
// no font, no style sheet, no href and no external reference: numbers are
// digit paths (glyphs.js), and no id, name or label from the model is ever
// written into it, only shapes, whole-pixel positions and fixed colors.
//
// The model is plain data. Positions are pixels from mapPoints (AD-R13),
// never coordinates; the renderer has no way to turn them back.
//
//   frame       { width, height, padding }  the frame mapPoints drew into:
//               width and height 200..2000, padding 0..200
//   points[]    { node, x, y }  whole pixels inside the frame; node is a
//               kind-prefixed id (property:<id>, crew:<id>)
//   crews[]     { crewId, color, baseNode }  color is the crew's index in
//               compareIds order (the caller's order, so a crew keeps its
//               color when others are filtered out); baseNode is drawn as a
//               square
//   a route     { crewId, stops: [node, ...] }  in visit order, numbered 1..n
//               (at most 99), drawn as one line from the crew's base
//
// Views, each refusing any other key:
//   compare     booked[], optimized[]: two panels side by side, booked left
//   change      before[], after[] (two panels, before left), moved[] (stops
//               ringed in both panels), crossZone[] { node, crewId } (a dashed
//               line from that crew's base, after panel), unplaced[] (hollow
//               markers, after panel)
//   zone        routes[], zones[] { zoneId, crewIds[] }: one color per crew,
//               each zone the padded convex hull of its crews' bases and stops
//   gap         routes[], gap { crewId, before, after|null } (the gap's two
//               neighbours double-ringed; after is null for a gap at the
//               end of the day),
//               candidates[] { node, rank } (at most five diamonds, numbered by
//               rank 1..5)
//
// Every refusal is a RoutingFault naming the field's path, never its value: a
// node missing from points is no_position, more than 99 stops on a crew or an
// unknown view is out_of_range.

const { RoutingFault } = require('../errors');
const { numberPath, MAX_NUMBER } = require('./glyphs');

const VIEWS = Object.freeze(['compare', 'change', 'zone', 'gap']);
const TWO_PANELS = Object.freeze({ compare: ['booked', 'optimized'], change: ['before', 'after'] });
const VIEW_KEYS = Object.freeze({
  compare: ['booked', 'optimized'],
  change: ['before', 'after', 'moved', 'crossZone', 'unplaced'],
  zone: ['routes', 'zones'],
  gap: ['routes', 'gap', 'candidates'],
});
const COMMON_KEYS = Object.freeze(['frame', 'points', 'crews']);

const FRAME = Object.freeze({ minSide: 200, maxSide: 2000, maxPadding: 200 });
const MAX_CANDIDATES = 5;

// Okabe-Ito, a color-blind-safe palette (yellow left out: too faint on white).
// ink is the digit color that reads on the fill.
const PALETTE = Object.freeze([
  { fill: '#0072B2', ink: '#FFFFFF' },
  { fill: '#E69F00', ink: '#000000' },
  { fill: '#009E73', ink: '#FFFFFF' },
  { fill: '#CC79A7', ink: '#000000' },
  { fill: '#56B4E9', ink: '#000000' },
  { fill: '#D55E00', ink: '#FFFFFF' },
  { fill: '#000000', ink: '#FFFFFF' },
]);
// Beyond the palette the colors repeat and the line's dashes vary.
const ROUTE_DASHES = Object.freeze([null, '12 6', '12 4 2 4']);
const MAX_COLOR = PALETTE.length * ROUTE_DASHES.length - 1;
const CROSS_ZONE_DASH = '2 7';

const STOP_R = 11;
const RING_R = 16;
const NEIGHBOUR_R = [17, 22];
const BASE_HALF = 8;
const DIAMOND = 14;
// The hull pads each point by this octagon (whole pixels, about 28 out).
const OCTAGON = Object.freeze([[28, 0], [20, 20], [0, 28], [-20, 20], [-28, 0], [-20, -20], [0, -28], [20, -20]]);

const ID = /^[A-Za-z0-9_-]+$/;
const NODE = /^(property|crew):[A-Za-z0-9_-]+$/;

const fault = (field, problem) => new RoutingFault({ field, problem });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;

// --- checking the model ---------------------------------------------------------

function object(value, field, keys) {
  if (!isObject(value)) throw fault(field, 'not_object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw fault(field, 'unknown_key');
  return value;
}

function need(obj, key, field) {
  if (!has(obj, key)) throw fault(field, 'missing');
  return obj[key];
}

function list(value, field) {
  if (!Array.isArray(value)) throw fault(field, 'not_list');
  return value;
}

function integer(obj, key, field, min, max) {
  const v = need(obj, key, field);
  if (!Number.isInteger(v)) throw fault(field, 'not_integer');
  if (v < min || v > max) throw fault(field, 'out_of_range');
  return v;
}

function id(obj, key, field) {
  const v = need(obj, key, field);
  if (typeof v !== 'string') throw fault(field, 'not_text');
  if (!ID.test(v)) throw fault(field, 'bad_id');
  return v;
}

function nodeId(value, field) {
  if (value === undefined) throw fault(field, 'missing');
  if (typeof value !== 'string') throw fault(field, 'not_text');
  if (!NODE.test(value)) throw fault(field, 'bad_node');
  return value;
}

// A node that must have a position: the pixel point it is drawn at.
function placed(value, field, pts) {
  const node = nodeId(value, field);
  const p = pts.get(node);
  if (!p) throw fault(field, 'no_position');
  return p;
}

function checkFrame(value) {
  const frame = object(value, 'frame', ['width', 'height', 'padding']);
  return {
    width: integer(frame, 'width', 'frame.width', FRAME.minSide, FRAME.maxSide),
    height: integer(frame, 'height', 'frame.height', FRAME.minSide, FRAME.maxSide),
    padding: integer(frame, 'padding', 'frame.padding', 0, FRAME.maxPadding),
  };
}

function checkPoints(value, frame) {
  const pts = new Map();
  list(value, 'points').forEach((raw, i) => {
    const at = `points[${i}]`;
    const p = object(raw, at, ['node', 'x', 'y']);
    const node = nodeId(p.node, `${at}.node`);
    if (pts.has(node)) throw fault(`${at}.node`, 'duplicate');
    pts.set(node, { x: integer(p, 'x', `${at}.x`, 0, frame.width), y: integer(p, 'y', `${at}.y`, 0, frame.height) });
  });
  return pts;
}

function checkCrews(value, pts) {
  const crews = new Map();
  list(value, 'crews').forEach((raw, i) => {
    const at = `crews[${i}]`;
    const c = object(raw, at, ['crewId', 'color', 'baseNode']);
    const crewId = id(c, 'crewId', `${at}.crewId`);
    if (crews.has(crewId)) throw fault(`${at}.crewId`, 'duplicate');
    const color = integer(c, 'color', `${at}.color`, 0, MAX_COLOR);
    crews.set(crewId, { color, base: placed(c.baseNode, `${at}.baseNode`, pts) });
  });
  return crews;
}

function crewOf(obj, key, field, crews) {
  const crewId = id(obj, key, field);
  const crew = crews.get(crewId);
  if (!crew) throw fault(field, 'unknown_crew');
  return { crewId, crew };
}

function checkRoutes(value, field, ctx) {
  const seen = new Set();
  return list(value, field).map((raw, i) => {
    const at = `${field}[${i}]`;
    const r = object(raw, at, ['crewId', 'stops']);
    const { crewId, crew } = crewOf(r, 'crewId', `${at}.crewId`, ctx.crews);
    if (seen.has(crewId)) throw fault(`${at}.crewId`, 'duplicate');
    seen.add(crewId);
    const stops = list(need(r, 'stops', `${at}.stops`), `${at}.stops`);
    if (stops.length > MAX_NUMBER) throw fault(`${at}.stops`, 'out_of_range');
    return { crewId, crew, stops: stops.map((s, j) => placed(s, `${at}.stops[${j}]`, ctx.pts)) };
  });
}

function checkNodes(value, field, pts) {
  return list(value, field).map((n, i) => placed(n, `${field}[${i}]`, pts));
}

function checkCrossZone(value, ctx) {
  return list(value, 'crossZone').map((raw, i) => {
    const at = `crossZone[${i}]`;
    const r = object(raw, at, ['node', 'crewId']);
    const { crew } = crewOf(r, 'crewId', `${at}.crewId`, ctx.crews);
    return { crew, at: placed(r.node, `${at}.node`, ctx.pts) };
  });
}

function checkZones(value, ctx) {
  const zoneIds = new Set();
  const crewIds = new Set();
  return list(value, 'zones').map((raw, i) => {
    const at = `zones[${i}]`;
    const z = object(raw, at, ['zoneId', 'crewIds']);
    const zoneId = id(z, 'zoneId', `${at}.zoneId`);
    if (zoneIds.has(zoneId)) throw fault(`${at}.zoneId`, 'duplicate');
    zoneIds.add(zoneId);
    const members = list(need(z, 'crewIds', `${at}.crewIds`), `${at}.crewIds`).map((c, j) => {
      const field = `${at}.crewIds[${j}]`;
      if (typeof c !== 'string') throw fault(field, 'not_text');
      if (!ID.test(c)) throw fault(field, 'bad_id');
      if (!ctx.crews.has(c)) throw fault(field, 'unknown_crew');
      if (crewIds.has(c)) throw fault(field, 'duplicate');
      crewIds.add(c);
      return c;
    });
    return { crewIds: members };
  });
}

function checkGap(value, ctx) {
  const g = object(value, 'gap', ['crewId', 'before', 'after']);
  crewOf(g, 'crewId', 'gap.crewId', ctx.crews);
  const before = placed(g.before, 'gap.before', ctx.pts);
  if (!Object.prototype.hasOwnProperty.call(g, 'after')) throw fault('gap.after', 'missing');
  const after = g.after === null ? null : placed(g.after, 'gap.after', ctx.pts);
  return { before, after };
}

function checkCandidates(value, ctx) {
  const items = list(value, 'candidates');
  if (items.length > MAX_CANDIDATES) throw fault('candidates', 'out_of_range');
  const ranks = new Set();
  return items.map((raw, i) => {
    const at = `candidates[${i}]`;
    const c = object(raw, at, ['node', 'rank']);
    const rank = integer(c, 'rank', `${at}.rank`, 1, MAX_CANDIDATES);
    if (ranks.has(rank)) throw fault(`${at}.rank`, 'duplicate');
    ranks.add(rank);
    return { rank, at: placed(c.node, `${at}.node`, ctx.pts) };
  });
}

// The model, checked, as what the drawing needs: pixel points and color
// indexes, with every id left behind.
function checkModel(view, model) {
  if (typeof view !== 'string' || !VIEWS.includes(view)) throw fault('view', 'out_of_range');
  const keys = [...COMMON_KEYS, ...VIEW_KEYS[view]];
  object(model, 'model', keys);
  for (const key of keys) need(model, key, key);
  const frame = checkFrame(model.frame);
  const pts = checkPoints(model.points, frame);
  const ctx = { pts, crews: checkCrews(model.crews, pts) };
  if (view === 'compare') {
    return { frame, panels: [{ routes: checkRoutes(model.booked, 'booked', ctx) }, { routes: checkRoutes(model.optimized, 'optimized', ctx) }] };
  }
  if (view === 'change') {
    const before = checkRoutes(model.before, 'before', ctx);
    const after = checkRoutes(model.after, 'after', ctx);
    const moved = checkNodes(model.moved, 'moved', pts);
    const crossZone = checkCrossZone(model.crossZone, ctx);
    const unplaced = checkNodes(model.unplaced, 'unplaced', pts);
    return { frame, panels: [{ routes: before, moved }, { routes: after, moved, crossZone, unplaced }] };
  }
  if (view === 'zone') {
    const routes = checkRoutes(model.routes, 'routes', ctx);
    const zones = checkZones(model.zones, ctx);
    return { frame, panels: [{ routes, zones }] };
  }
  const routes = checkRoutes(model.routes, 'routes', ctx);
  const gap = checkGap(model.gap, ctx);
  const candidates = checkCandidates(model.candidates, ctx);
  return { frame, panels: [{ routes, gap, candidates }] };
}

// --- drawing ---------------------------------------------------------------------

// One element; attrs is a list of [name, value] pairs in a fixed order, and
// every value is a whole number or a constant from this file.
function el(name, attrs) {
  return `<${name}${attrs.filter(([, v]) => v !== null).map(([k, v]) => ` ${k}="${v}"`).join('')}/>`;
}

const pointList = (ps, dx) => ps.map((p) => `${p.x + dx},${p.y}`).join(' ');
const paletteOf = (crew) => PALETTE[crew.color % PALETTE.length];
const dashOf = (crew) => ROUTE_DASHES[Math.floor(crew.color / PALETTE.length)];

function routeLine(route, dx) {
  if (!route.stops.length) return [];
  return [el('polyline', [
    ['points', pointList([route.crew.base, ...route.stops], dx)], ['fill', 'none'], ['stroke', paletteOf(route.crew).fill],
    ['stroke-width', 4], ['stroke-linejoin', 'round'], ['stroke-linecap', 'round'], ['stroke-dasharray', dashOf(route.crew)],
  ])];
}

function base(crew, dx) {
  const { x, y } = crew.base;
  return el('rect', [['x', x + dx - BASE_HALF], ['y', y - BASE_HALF], ['width', BASE_HALF * 2], ['height', BASE_HALF * 2], ['fill', paletteOf(crew).fill], ['stroke', '#000000'], ['stroke-width', 2]]);
}

function stopMarker(p, n, colors, dx) {
  const cx = p.x + dx;
  return [
    el('circle', [['cx', cx], ['cy', p.y], ['r', STOP_R], ['fill', colors.fill], ['stroke', '#FFFFFF'], ['stroke-width', 2]]),
    el('path', [['d', numberPath(n, cx, p.y)], ['fill', 'none'], ['stroke', colors.ink], ['stroke-width', 2], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]),
  ];
}

const hollow = (p, stroke, dx) => el('circle', [['cx', p.x + dx], ['cy', p.y], ['r', STOP_R], ['fill', '#FFFFFF'], ['stroke', stroke], ['stroke-width', 3]]);
const ring = (p, r, width, dx) => el('circle', [['cx', p.x + dx], ['cy', p.y], ['r', r], ['fill', 'none'], ['stroke', '#000000'], ['stroke-width', width]]);
const dashed = (a, b, stroke, width, dash, dx) => el('line', [['x1', a.x + dx], ['y1', a.y], ['x2', b.x + dx], ['y2', b.y], ['stroke', stroke], ['stroke-width', width], ['stroke-dasharray', dash], ['stroke-linecap', 'round']]);

function diamond(p, rank, dx) {
  const cx = p.x + dx;
  const { y } = p;
  const corners = `${cx},${y - DIAMOND} ${cx + DIAMOND},${y} ${cx},${y + DIAMOND} ${cx - DIAMOND},${y}`;
  return [
    el('polygon', [['points', corners], ['fill', '#333333'], ['stroke', '#FFFFFF'], ['stroke-width', 2]]),
    el('path', [['d', numberPath(rank, cx, y)], ['fill', 'none'], ['stroke', '#FFFFFF'], ['stroke-width', 2], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]),
  ];
}

// The convex hull (monotone chain, integer cross products) of the points
// padded by the octagon, counter-clockwise from the lowest x then y.
function paddedHull(ps) {
  const seen = new Set();
  const all = [];
  for (const p of ps) {
    for (const [ox, oy] of OCTAGON) {
      const q = [p.x + ox, p.y + oy];
      const key = `${q[0]},${q[1]}`;
      if (!seen.has(key)) { seen.add(key); all.push(q); }
    }
  }
  all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts) => {
    const out = [];
    for (const p of pts) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(all), ...half([...all].reverse())];
}

function hull(zone, routes, dx) {
  const ps = [];
  for (const r of routes) if (zone.crewIds.includes(r.crewId)) ps.push(r.crew.base, ...r.stops);
  if (!ps.length) return [];
  const corners = paddedHull(ps).map(([x, y]) => `${x + dx},${y}`).join(' ');
  return [el('polygon', [['points', corners], ['fill', '#000000'], ['fill-opacity', '0.05'], ['stroke', '#666666'], ['stroke-width', 2], ['stroke-linejoin', 'round']])];
}

// One panel's elements, in drawing order (later on top).
function panel(p, dx) {
  const out = [];
  for (const zone of p.zones || []) out.push(...hull(zone, p.routes, dx));
  for (const r of p.routes) out.push(...routeLine(r, dx));
  for (const z of p.crossZone || []) out.push(dashed(z.crew.base, z.at, paletteOf(z.crew).fill, 3, CROSS_ZONE_DASH, dx));
  const bases = [];
  for (const crew of [...p.routes.map((r) => r.crew), ...(p.crossZone || []).map((z) => z.crew)]) if (!bases.includes(crew)) bases.push(crew);
  for (const crew of bases) out.push(base(crew, dx));
  for (const r of p.routes) r.stops.forEach((s, i) => out.push(...stopMarker(s, i + 1, paletteOf(r.crew), dx)));
  for (const z of p.crossZone || []) out.push(hollow(z.at, paletteOf(z.crew).fill, dx));
  for (const u of p.unplaced || []) out.push(hollow(u, '#000000', dx));
  for (const m of p.moved || []) out.push(ring(m, RING_R, 3, dx));
  if (p.gap) {
    for (const n of [p.gap.before, p.gap.after].filter(Boolean)) for (const r of NEIGHBOUR_R) out.push(ring(n, r, 2, dx));
  }
  for (const c of [...(p.candidates || [])].sort((a, b) => a.rank - b.rank)) out.push(...diamond(c.at, c.rank, dx));
  return out;
}

// The image's size in pixels: the frame, or two frames side by side for the
// two-panel views (compare, change).
function imageSize(view, frame) {
  if (!VIEWS.includes(view)) throw fault('view', 'out_of_range');
  return { width: TWO_PANELS[view] ? frame.width * 2 : frame.width, height: frame.height };
}

function renderSvg(view, model) {
  const drawing = checkModel(view, model);
  const { frame } = drawing;
  const { width, height } = imageSize(view, frame);
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    el('rect', [['x', 0], ['y', 0], ['width', width], ['height', height], ['fill', '#FFFFFF']]),
  ];
  drawing.panels.forEach((p, i) => lines.push(...panel(p, i * frame.width)));
  if (drawing.panels.length === 2) lines.push(el('line', [['x1', frame.width], ['y1', 0], ['x2', frame.width], ['y2', height], ['stroke', '#999999'], ['stroke-width', 2]]));
  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}

module.exports = { renderSvg, imageSize, VIEWS, PALETTE, MAX_COLOR, MAX_CANDIDATES };
