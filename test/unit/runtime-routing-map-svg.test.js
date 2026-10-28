'use strict';

// Story 15.3 (AD-R14): the route map as SVG. renderSvg(view, model) is pure
// and deterministic, writes no text, font or reference, and draws each view's
// features where the model's pixel points say. Models come from
// test/fixtures/routing-map/*.json (synthetic, no client data).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderSvg, imageSize, VIEWS } = require('../../kit/runtime/routing-map');
const {
  PALETTE, MAX_COLOR, FLAGS, FLAG_COLORS,
} = require('../../kit/runtime/routing-map/svg');
const { numberPath, boldNumberPath } = require('../../kit/runtime/routing-map/glyphs');
const { RoutingFault, ROUTING_PROBLEMS } = require('../../kit/runtime/errors');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'routing-map');
const load = (view) => require(path.join(FIXTURES, `${view}.json`));
const clone = (v) => JSON.parse(JSON.stringify(v));
const model = (view) => clone(load(view).model);

// --- reading the SVG back -----------------------------------------------------------

// Every self-closing element as { name, attrs }.
function elements(svg) {
  return [...svg.matchAll(/<([a-z]+)((?:\s+[a-z0-9-]+="[^"]*")*)\s*\/>/g)].map((m) => ({
    name: m[1],
    attrs: Object.fromEntries([...m[2].matchAll(/([a-z0-9-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
  }));
}
const find = (svg, name, where = {}) => elements(svg).filter((e) => e.name === name && Object.entries(where).every(([k, v]) => e.attrs[k] === String(v)));
const pointOf = (m, node) => m.points.find((p) => p.node === node);
const crewOf = (m, crewId) => m.crews.find((c) => c.crewId === crewId);
const fillOf = (m, crewId) => PALETTE[crewOf(m, crewId).color % PALETTE.length].fill;

function faultOf(fn) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof RoutingFault, `not a RoutingFault: ${e && e.message}`);
    assert.ok(ROUTING_PROBLEMS.includes(e.details.problem));
    return { field: e.details.field, problem: e.details.problem, message: e.message };
  }
  assert.fail('expected a RoutingFault');
}
const refuses = (view, m, field, problem) => {
  const f = faultOf(() => renderSvg(view, m));
  assert.deepEqual({ field: f.field, problem: f.problem }, { field, problem });
  assert.doesNotMatch(f.message, /property:|crew:|depot:/, 'never a node id in the words');
};

// Asserts a numbered marker for each stop of each route, in order, at its point.
function assertNumberedRoutes(svg, m, routes, dx) {
  for (const r of routes) {
    r.stops.forEach((node, i) => {
      const p = pointOf(m, node);
      assert.equal(find(svg, 'circle', { cx: p.x + dx, cy: p.y, r: 11, fill: fillOf(m, r.crewId) }).length, 1, `${r.crewId} stop ${i + 1}`);
      assert.equal(find(svg, 'path', { d: numberPath(i + 1, p.x + dx, p.y) }).length, 1, `number ${i + 1} on ${r.crewId}`);
    });
    const line = find(svg, 'polyline', { stroke: fillOf(m, r.crewId) }).filter((e) => e.attrs.points.startsWith(`${pointOf(m, crewOf(m, r.crewId).baseNode).x + dx},`));
    const want = [crewOf(m, r.crewId).baseNode, ...r.stops].map((n) => `${pointOf(m, n).x + dx},${pointOf(m, n).y}`).join(' ');
    if (r.stops.length) assert.deepEqual(line.map((l) => l.attrs.points), [want], `${r.crewId}'s line from its base through its stops`);
  }
}

function assertBase(svg, m, crewId, dx) {
  const p = pointOf(m, crewOf(m, crewId).baseNode);
  assert.equal(find(svg, 'rect', { x: p.x + dx - 8, y: p.y - 8, width: 16, height: 16, fill: fillOf(m, crewId) }).length, 1, `${crewId}'s base square`);
}

// --- every view -----------------------------------------------------------------

test('the four views, each fixture: byte-identical twice, no text, font, reference or href', () => {
  assert.deepEqual(VIEWS, ['compare', 'change', 'zone', 'gap', 'route']);
  for (const view of VIEWS) {
    const fx = load(view);
    assert.equal(fx.view, view);
    const a = renderSvg(view, fx.model);
    const b = renderSvg(view, clone(fx.model));
    assert.equal(a, b, view);
    assert.match(a, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+" viewBox="0 0 \d+ \d+">\n/);
    const body = a.replace(' xmlns="http://www.w3.org/2000/svg"', '');
    for (const bad of [/<text/i, /font/i, /href/i, /url\(/i, /https?:/i, /<image/i, /<use/i, /<style/i, /<script/i, /foreignObject/i, /@import/i, /xlink/i]) {
      assert.doesNotMatch(body, bad, `${view}: ${bad}`);
    }
    // No id, name or label from the model is written into the image.
    assert.doesNotMatch(a, /property|crew|depot|\bhq\b|north|south|\bc\d\b|\bp\d+\b/, `${view}: no id text`);
    const size = imageSize(view, fx.model.frame);
    assert.match(a, new RegExp(`width="${size.width}" height="${size.height}"`));
  }
});

test('the SVG is identical under two time zones and locales (no clock, no locale)', () => {
  const script = `
    const { renderSvg, VIEWS } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'kit/runtime/routing-map'))});
    const out = VIEWS.map((v) => renderSvg(v, require(${JSON.stringify(FIXTURES)} + '/' + v + '.json').model)).join('');
    process.stdout.write(require('node:crypto').createHash('sha256').update(out).digest('hex'));`;
  const run = (env) => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  const a = run({ TZ: 'America/New_York', LANG: 'en_US.UTF-8' });
  const b = run({ TZ: 'Pacific/Auckland', LANG: 'de_DE.UTF-8' });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.stdout.length, 64);
});

test('compare: two panels (booked left, optimized right), numbered stops, one line color per crew, bases marked', () => {
  const m = model('compare');
  const svg = renderSvg('compare', m);
  const w = m.frame.width;
  assert.deepEqual(imageSize('compare', m.frame), { width: 2 * w, height: m.frame.height });
  assert.equal(find(svg, 'line', { x1: w, y1: 0, x2: w, y2: m.frame.height }).length, 1, 'the divider between the panels');
  assertNumberedRoutes(svg, m, m.booked, 0);
  assertNumberedRoutes(svg, m, m.optimized, w);
  for (const dx of [0, w]) for (const c of m.crews) assertBase(svg, m, c.crewId, dx);
  const strokes = find(svg, 'polyline').map((e) => e.attrs.stroke);
  assert.deepEqual(strokes, [PALETTE[0].fill, PALETTE[1].fill, PALETTE[0].fill, PALETTE[1].fill]);
  assert.notEqual(PALETTE[0].fill, PALETTE[1].fill);
  assert.equal(find(svg, 'circle', { r: 11 }).length, 16);
  assert.equal(find(svg, 'circle', { r: 16 }).length, 0, 'nothing ringed');
});

test('change: before and after panels, moved stops ringed, the cross-zone recommendation dashed, unplaced stops hollow', () => {
  const m = model('change');
  const svg = renderSvg('change', m);
  const w = m.frame.width;
  assertNumberedRoutes(svg, m, m.before, 0);
  assertNumberedRoutes(svg, m, m.after, w);
  for (const node of m.moved) {
    const p = pointOf(m, node);
    for (const dx of [0, w]) assert.equal(find(svg, 'circle', { cx: p.x + dx, cy: p.y, r: 16, fill: 'none', stroke: '#000000' }).length, 1, `${node} ringed at ${dx}`);
  }
  assert.equal(find(svg, 'circle', { r: 16 }).length, 2 * m.moved.length);
  const [rec] = m.crossZone;
  const from = pointOf(m, crewOf(m, rec.crewId).baseNode);
  const to = pointOf(m, rec.node);
  assert.deepEqual(find(svg, 'line', { 'stroke-dasharray': '2 7' }).map((e) => e.attrs), [{
    x1: String(from.x + w), y1: String(from.y), x2: String(to.x + w), y2: String(to.y),
    stroke: fillOf(m, rec.crewId), 'stroke-width': '3', 'stroke-dasharray': '2 7', 'stroke-linecap': 'round',
  }], 'one dashed line from the recommended crew\'s base, in the after panel');
  assertBase(svg, m, rec.crewId, w);
  const [u] = m.unplaced;
  const up = pointOf(m, u);
  assert.equal(find(svg, 'circle', { cx: up.x + w, cy: up.y, r: 11, fill: '#FFFFFF', stroke: '#000000' }).length, 1, 'the unplaced stop is hollow');
  assert.equal(find(svg, 'circle', { cx: up.x, cy: up.y, fill: '#FFFFFF' }).length, 0, 'only in the after panel');
  // The crew that is out keeps its base square in both panels, and no line after.
  assertBase(svg, m, 'c2', 0);
  assertBase(svg, m, 'c2', w);
});

// Whether (x, y) is inside or on a convex polygon given counter-clockwise or
// clockwise, by the sign of every edge's cross product.
function insideConvex(poly, x, y) {
  let sign = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign && Math.sign(c) !== sign) return false;
      sign = Math.sign(c);
    }
  }
  return true;
}

test('zone: one color per crew, and each zone the padded convex hull of its own crews\' points', () => {
  const m = model('zone');
  const svg = renderSvg('zone', m);
  assertNumberedRoutes(svg, m, m.routes, 0);
  for (const c of m.crews) assertBase(svg, m, c.crewId, 0);
  const strokes = find(svg, 'polyline').map((e) => e.attrs.stroke);
  assert.equal(new Set(strokes).size, m.crews.length, 'a color per crew');
  const hulls = find(svg, 'polygon', { 'fill-opacity': '0.05' }).map((e) => e.attrs.points.split(' ').map((p) => p.split(',').map(Number)));
  assert.equal(hulls.length, m.zones.length);
  m.zones.forEach((z, i) => {
    const own = m.routes.filter((r) => z.crewIds.includes(r.crewId)).flatMap((r) => [crewOf(m, r.crewId).baseNode, ...r.stops]);
    const other = m.routes.filter((r) => !z.crewIds.includes(r.crewId)).flatMap((r) => [crewOf(m, r.crewId).baseNode, ...r.stops]);
    for (const n of own) {
      const p = pointOf(m, n);
      // Padded: a point 20 pixels out every way is still inside.
      for (const [ox, oy] of [[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20]]) assert.ok(insideConvex(hulls[i], p.x + ox, p.y + oy), `${z.zoneId} holds ${n} (+${ox},${oy})`);
    }
    for (const n of other) assert.ok(!insideConvex(hulls[i], pointOf(m, n).x, pointOf(m, n).y), `${z.zoneId} leaves out ${n}`);
  });
});

test('zone: one crew alone, or a single stop, still gets a padded hull', () => {
  const m = model('zone');
  m.routes = [{ crewId: 'c3', stops: [] }];
  m.zones = [{ zoneId: 'south', crewIds: ['c3'] }, { zoneId: 'north', crewIds: ['c1', 'c2'] }];
  const svg = renderSvg('zone', m);
  const hulls = find(svg, 'polygon', { 'fill-opacity': '0.05' });
  assert.equal(hulls.length, 1, 'a zone with nothing drawn has no hull');
  assert.equal(hulls[0].attrs.points.split(' ').length, 8, 'the octagon around one base');
});

test('gap: the gap\'s two neighbours double-ringed, up to five candidates as diamonds numbered by rank', () => {
  const m = model('gap');
  const svg = renderSvg('gap', m);
  assertNumberedRoutes(svg, m, m.routes, 0);
  assertBase(svg, m, 'c1', 0);
  for (const n of [m.gap.before, m.gap.after]) {
    const p = pointOf(m, n);
    for (const r of [17, 22]) assert.equal(find(svg, 'circle', { cx: p.x, cy: p.y, r, fill: 'none' }).length, 1, `${n} ring ${r}`);
  }
  assert.equal(find(svg, 'circle', { r: 17 }).length, 2);
  const diamonds = find(svg, 'polygon', { fill: '#333333' });
  assert.equal(diamonds.length, 5);
  for (const c of m.candidates) {
    const p = pointOf(m, c.node);
    assert.ok(diamonds.some((d) => d.attrs.points === `${p.x},${p.y - 14} ${p.x + 14},${p.y} ${p.x},${p.y + 14} ${p.x - 14},${p.y}`), `diamond for rank ${c.rank}`);
    assert.equal(find(svg, 'path', { d: numberPath(c.rank, p.x, p.y), stroke: '#FFFFFF' }).length, 1, `rank ${c.rank} drawn as its number`);
  }
  // A gap at the end of the day has one neighbour; fewer candidates are fine.
  m.gap.after = null;
  m.candidates = m.candidates.slice(0, 2);
  const svg2 = renderSvg('gap', m);
  assert.equal(find(svg2, 'circle', { r: 17 }).length, 1);
  assert.equal(find(svg2, 'polygon', { fill: '#333333' }).length, 2);
});

test('beyond the palette the colors repeat and the line\'s dashes vary; the color index is capped', () => {
  const m = model('compare');
  m.crews[1].color = PALETTE.length; // the eighth color
  const svg = renderSvg('compare', m);
  const lines = find(svg, 'polyline');
  assert.equal(lines[0].attrs.stroke, lines[1].attrs.stroke, 'same color as the first');
  assert.equal(lines[0].attrs['stroke-dasharray'], undefined);
  assert.equal(lines[1].attrs['stroke-dasharray'], '12 6');
  m.crews[1].color = MAX_COLOR;
  assert.ok(renderSvg('compare', m));
  m.crews[1].color = MAX_COLOR + 1;
  refuses('compare', m, 'crews[1].color', 'out_of_range');
});

// --- refusals --------------------------------------------------------------------

test('a node missing from the points is refused as no_position, wherever the model names it', () => {
  const cases = [
    ['compare', (m) => { m.points = m.points.filter((p) => p.node !== 'property:p3'); }, 'booked[0].stops[2]'],
    ['compare', (m) => { m.optimized[1].stops.push('property:zz'); }, 'optimized[1].stops[4]'],
    ['compare', (m) => { m.points = m.points.filter((p) => p.node !== 'crew:c2'); }, 'crews[1].baseNode'],
    ['change', (m) => { m.moved.push('property:zz'); }, 'moved[2]'],
    ['change', (m) => { m.unplaced = ['property:zz']; }, 'unplaced[0]'],
    ['change', (m) => { m.crossZone[0].node = 'property:zz'; }, 'crossZone[0].node'],
    ['gap', (m) => { m.gap.before = 'property:zz'; }, 'gap.before'],
    ['gap', (m) => { m.gap.after = 'property:zz'; }, 'gap.after'],
    ['gap', (m) => { m.candidates[4].node = 'property:zz'; }, 'candidates[4].node'],
  ];
  for (const [view, edit, field] of cases) {
    const m = model(view);
    edit(m);
    refuses(view, m, field, 'no_position');
  }
});

test('more than 99 stops on a crew is refused; 99 are drawn', () => {
  const m = model('compare');
  const many = Array.from({ length: 100 }, (_, i) => `property:x${i}`);
  m.points.push(...many.map((node, i) => ({ node, x: 10 + (i % 50) * 10, y: 20 + Math.floor(i / 50) * 300 })));
  m.booked[0].stops = many.slice(0, 99);
  const svg = renderSvg('compare', m);
  assert.equal(find(svg, 'path', { d: numberPath(99, 10 + 48 * 10, 320) }).length, 1, 'the 99th stop numbered 99');
  m.booked[0].stops = many;
  refuses('compare', m, 'booked[0].stops', 'out_of_range');
});

test('an unknown view is refused, as is a model of the wrong shape', () => {
  for (const view of ['map', '', 'Compare', undefined, 3]) refuses(view, model('compare'), 'view', 'out_of_range');
  assert.throws(() => imageSize('map', { width: 600, height: 400 }), RoutingFault);
  refuses('compare', null, 'model', 'not_object');
  refuses('compare', [], 'model', 'not_object');
  // The model of another view.
  refuses('compare', model('zone'), 'model', 'unknown_key');
  // A name, or any other key, is refused at every level.
  const named = (edit, field, view = 'compare') => { const m = model(view); edit(m); refuses(view, m, field, 'unknown_key'); };
  named((m) => { m.clientName = 'x'; }, 'model');
  named((m) => { m.points[0].label = 'x'; }, 'points[0]');
  named((m) => { m.crews[0].name = 'x'; }, 'crews[0]');
  named((m) => { m.booked[0].names = []; }, 'booked[0]');
  named((m) => { m.frame.scale = 1; }, 'frame');
  named((m) => { m.gap.reason = 'x'; }, 'gap', 'gap');
  named((m) => { m.candidates[0].client = 'x'; }, 'candidates[0]', 'gap');
  named((m) => { m.zones[0].name = 'x'; }, 'zones[0]', 'zone');
  named((m) => { m.crossZone[0].city = 'x'; }, 'crossZone[0]', 'change');
  const missing = model('change');
  delete missing.unplaced;
  refuses('change', missing, 'unplaced', 'missing');
});

test('the frame, the points and the ids are checked', () => {
  const edits = [
    [(m) => { m.frame.width = 199; }, 'frame.width', 'out_of_range'],
    [(m) => { m.frame.height = 2001; }, 'frame.height', 'out_of_range'],
    [(m) => { m.frame.padding = 201; }, 'frame.padding', 'out_of_range'],
    [(m) => { m.frame.width = 600.5; }, 'frame.width', 'not_integer'],
    [(m) => { m.points[0].x = 601; }, 'points[0].x', 'out_of_range'],
    [(m) => { m.points[0].y = -1; }, 'points[0].y', 'out_of_range'],
    [(m) => { m.points[1].x = 1.5; }, 'points[1].x', 'not_integer'],
    [(m) => { m.points[1].node = m.points[0].node; }, 'points[1].node', 'duplicate'],
    [(m) => { m.points[1].node = 'p1'; }, 'points[1].node', 'bad_node'],
    [(m) => { m.points = {}; }, 'points', 'not_list'],
    [(m) => { m.crews[1].crewId = 'c1'; }, 'crews[1].crewId', 'duplicate'],
    [(m) => { m.crews[1].crewId = 'c 2'; }, 'crews[1].crewId', 'bad_id'],
    [(m) => { m.crews[0].color = -1; }, 'crews[0].color', 'out_of_range'],
    [(m) => { m.booked[0].crewId = 'c9'; }, 'booked[0].crewId', 'unknown_crew'],
    [(m) => { m.booked[1].crewId = 'c1'; }, 'booked[1].crewId', 'duplicate'],
    [(m) => { delete m.booked[0].stops; }, 'booked[0].stops', 'missing'],
    [(m) => { m.booked[0].stops[0] = 7; }, 'booked[0].stops[0]', 'not_text'],
  ];
  for (const [edit, field, problem] of edits) {
    const m = model('compare');
    edit(m);
    refuses('compare', m, field, problem);
  }
  const gap = model('gap');
  gap.candidates.push({ node: 'property:p1', rank: 5 });
  refuses('gap', gap, 'candidates', 'out_of_range');
  const ranks = model('gap');
  ranks.candidates[1].rank = 1;
  refuses('gap', ranks, 'candidates[1].rank', 'duplicate');
  const rank6 = model('gap');
  rank6.candidates[0].rank = 6;
  refuses('gap', rank6, 'candidates[0].rank', 'out_of_range');
  const zone = model('zone');
  zone.zones[1].crewIds.push('c1');
  refuses('zone', zone, 'zones[1].crewIds[1]', 'duplicate');
  const zone2 = model('zone');
  zone2.zones[0].crewIds.push('c9');
  refuses('zone', zone2, 'zones[0].crewIds[2]', 'unknown_crew');
  const cz = model('change');
  cz.crossZone[0].crewId = 'c9';
  refuses('change', cz, 'crossZone[0].crewId', 'unknown_crew');
});

test('the renderer never changes its model', () => {
  for (const view of VIEWS) {
    const m = model(view);
    const before = JSON.stringify(m);
    renderSvg(view, m);
    assert.equal(JSON.stringify(m), before, view);
  }
});

// --- glyphs ------------------------------------------------------------------------

test('numbers 1 to 99 are distinct digit paths of whole pixels; anything else is a programming error', () => {
  const seen = new Set();
  for (let n = 1; n <= 99; n += 1) {
    const d = numberPath(n, 100, 100);
    assert.match(d, /^(M\d+ \d+L\d+ \d+)+$/, String(n));
    assert.ok(!seen.has(d), `${n} is distinct`);
    seen.add(d);
  }
  for (const bad of [0, 100, 1.5, '7', -1]) assert.throws(() => numberPath(bad, 0, 0), RangeError);
  // Centred: a one-digit number spans x-3..x+3, a two-digit one x-7..x+7.
  const xs = (d) => [...d.matchAll(/[ML](\d+) /g)].map((m) => Number(m[1]));
  assert.deepEqual([Math.min(...xs(numberPath(8, 100, 100))), Math.max(...xs(numberPath(8, 100, 100)))], [97, 103]);
  assert.deepEqual([Math.min(...xs(numberPath(88, 100, 100))), Math.max(...xs(numberPath(88, 100, 100)))], [93, 107]);
});

// --- Story 15.10: the street map's background (AD-R21) ---------------------------------------

// sha256 of each fixture's plain SVG as drawn before street tiles (computed
// with main's svg.js at Story 15.9): the plain map has not moved a byte.
const PLAIN_SVG_SHA256 = Object.freeze({
  compare: 'f46b7bce79841b2d171015f8f48e7235c432fdff501cbfdc064ac66167ba1d22',
  change: '4cea0276d478a01a29b4715c32b55ddce3db8b841fd4107fc03ebb47236fcda1',
  zone: '0cbf86c1f14bdae8012babba645d5ca62b71c9e00c8392158aea11cddeb0bc45',
  gap: '6fe1f9d8b5fbcdd40a8fb36ca61d9b4a09d2f986e0df6ad7ca8386b037118aa3',
  // Story 15.13: the route view, pinned when it was added; re-pinned by
  // Story 15.18 (its new look and the fixture's flagged stops).
  route: '365aa1c6ce24fc8217f0219ef4b4eb087bad308eac6e41080892b1687ebdd3a3',
});

test('Story 15.10: with no base or base plain, every fixture\'s SVG is byte for byte what it was before street tiles', () => {
  const sha = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');
  for (const view of VIEWS) {
    assert.equal(sha(renderSvg(view, model(view))), PLAIN_SVG_SHA256[view], view);
    assert.equal(renderSvg(view, model(view), { base: 'plain' }), renderSvg(view, model(view)), view);
    assert.equal(renderSvg(view, model(view), {}), renderSvg(view, model(view)), view);
  }
});

test('Story 15.10: base streets swaps the white background for a translucent white wash, set by attribute; nothing else changes', () => {
  for (const view of VIEWS) {
    // Plan a route's map washes the streets more (Story 15.18).
    const wash = view === 'route' ? '0.6' : '0.45';
    const plain = renderSvg(view, model(view));
    const streets = renderSvg(view, model(view), { base: 'streets' });
    const { width, height } = imageSize(view, model(view).frame);
    const [bg] = elements(streets);
    assert.deepEqual(bg, {
      name: 'rect', attrs: { x: '0', y: '0', width: String(width), height: String(height), fill: '#FFFFFF', 'fill-opacity': wash },
    });
    assert.ok(!/url\(|style|href|<image/i.test(streets), `${view}: no url(, style or reference`);
    const rest = (svg) => svg.split('\n').slice(2).join('\n');
    assert.equal(rest(streets), rest(plain), `${view}: only the background differs`);
  }
});

test('Story 15.10: an unknown option or base is refused with fixed words', () => {
  assert.deepEqual(faultOf(() => renderSvg('gap', model('gap'), { base: 'satellite' })).problem, 'out_of_range');
  assert.deepEqual(faultOf(() => renderSvg('gap', model('gap'), { tiles: [] })).problem, 'unknown_key');
  assert.deepEqual(faultOf(() => renderSvg('gap', model('gap'), 'streets')).problem, 'not_object');
});

// --- Story 15.13: the route view, Plan a route's map (AD-R28; its look Story 15.18, AD-R29) ---

// A route stop is a node or { node, flag }.
const nodeOf = (s) => (typeof s === 'string' ? s : s.node);
const stopNodes = (m) => m.route.stops.map(nodeOf);

// The Office's marker at its point: the dark navy rounded square with a white
// ring, the white house and its navy door.
function officeAt(svg, p) {
  const square = find(svg, 'rect', {
    x: p.x - 15, y: p.y - 15, width: 30, height: 30, rx: 6, fill: '#1D3557', stroke: '#FFFFFF', 'stroke-width': 3,
  });
  const house = find(svg, 'polygon', { fill: '#FFFFFF' })
    .filter((e) => e.attrs.points === `${p.x - 8},${p.y + 9} ${p.x + 8},${p.y + 9} ${p.x + 8},${p.y - 1} ${p.x},${p.y - 9} ${p.x - 8},${p.y - 1}`);
  const door = find(svg, 'rect', {
    x: p.x - 3, y: p.y + 2, width: 6, height: 7, fill: '#1D3557',
  });
  return { square: square.length, house: house.length, door: door.length };
}

// A stop's pin at its point: the disc with its white ring, the bold filled
// number, and the two halo discs a pixel below.
function pinAt(svg, p, n, colors) {
  return {
    disc: find(svg, 'circle', {
      cx: p.x, cy: p.y, r: 17, fill: colors.fill, stroke: '#FFFFFF', 'stroke-width': 3,
    }).length,
    number: find(svg, 'path', { d: boldNumberPath(n, p.x, p.y), fill: colors.ink }).length,
    halo: find(svg, 'circle', { cx: p.x, cy: p.y + 1, fill: '#000000' }).length,
  };
}
const ringsAt = (svg, p) => find(svg, 'circle', {
  cx: p.x, cy: p.y, r: 21, fill: 'none', 'stroke-width': 5,
}).map((e) => e.attrs.stroke);

// Each chevron: a white stroked open V, as its three points.
function chevrons(svg) {
  return find(svg, 'path', { fill: 'none', stroke: '#FFFFFF' })
    .map((e) => [...e.attrs.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) })));
}

test('route: one panel; the Office square, pins numbered in the order given, the cased closed line in the crew\'s color', () => {
  const m = model('route');
  const svg = renderSvg('route', m);
  assert.deepEqual(imageSize('route', m.frame), { width: m.frame.width, height: m.frame.height }, 'one panel');
  assert.equal(find(svg, 'line').length, 0, 'no panel divider');
  const office = pointOf(m, m.depot);
  assert.deepEqual(officeAt(svg, office), { square: 1, house: 1, door: 1 }, 'the Office marker, once');
  assert.equal(find(svg, 'rect', { width: 16, height: 16 }).length, 0, 'no crew base square');
  // Pins numbered 1..n in the given order, in the crew's color, with a halo.
  const colors = PALETTE[crewOf(m, m.route.crewId).color];
  assert.equal(colors.fill, PALETTE[2].fill);
  stopNodes(m).forEach((node, i) => {
    assert.deepEqual(pinAt(svg, pointOf(m, node), i + 1, colors), { disc: 1, number: 1, halo: 2 }, `stop ${i + 1}`);
  });
  // Numerals are filled shapes, never strokes, and there is no <text>.
  for (const p of find(svg, 'path').filter((e) => e.attrs.fill !== 'none')) assert.equal(p.attrs.stroke, undefined);
  assert.doesNotMatch(svg, /<text|font|href|url\(|<image/i);
  // The line: a 10 px white casing, then the 6 px line in the crew's color,
  // both Office -> stops -> Office with round joins.
  const want = [m.depot, ...stopNodes(m), m.depot].map((n) => `${pointOf(m, n).x},${pointOf(m, n).y}`).join(' ');
  assert.deepEqual(find(svg, 'polyline').map((e) => e.attrs), [
    {
      points: want, fill: 'none', stroke: '#FFFFFF', 'stroke-width': '10', 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    },
    {
      points: want, fill: 'none', stroke: colors.fill, 'stroke-width': '6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    },
  ]);
  // Drawing order: line, pins, then the Office on top of the line's two ends.
  const body = svg.split('\n');
  const lastCircle = body.map((l, i) => (l.startsWith('<circle') ? i : -1)).at(-1);
  assert.ok(body.findIndex((l) => l.startsWith('<polyline')) < body.findIndex((l) => l.startsWith('<circle')));
  assert.ok(body.findIndex((l) => l.includes('fill="#1D3557" stroke')) > lastCircle);
});

test('route: one chevron at the middle of each leg, pointing along travel; a leg too short for one gets none', () => {
  const m = model('route');
  const svg = renderSvg('route', m);
  const loop = [m.depot, ...stopNodes(m), m.depot].map((n) => pointOf(m, n));
  const got = chevrons(svg);
  assert.equal(got.length, loop.length - 1, 'one per leg');
  got.forEach(([armA, tip, armB], i) => {
    const a = loop[i];
    const b = loop[i + 1];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const along = (p) => (p.x - mid.x) * (b.x - a.x) + (p.y - mid.y) * (b.y - a.y);
    assert.ok(Math.hypot(tip.x - mid.x, tip.y - mid.y) <= 3, `leg ${i + 1}: at the middle`);
    assert.ok(along(tip) > 0, `leg ${i + 1}: the tip points toward the next stop`);
    assert.ok(along(armA) < 0 && along(armB) < 0, `leg ${i + 1}: the arms trail behind`);
  });
  for (const e of find(svg, 'path', { stroke: '#FFFFFF' })) {
    assert.deepEqual([e.attrs['stroke-width'], e.attrs['stroke-linecap'], e.attrs['stroke-linejoin']], ['2', 'round', 'round']);
    assert.match(e.attrs.d, /^M-?\d+(\.\d)?,-?\d+(\.\d)?(L-?\d+(\.\d)?,-?\d+(\.\d)?){2}$/, 'to a tenth of a pixel');
  }
  // Reversed, every chevron turns round.
  const back = model('route');
  back.route.stops.reverse();
  const turned = chevrons(renderSvg('route', back));
  assert.equal(turned.length, got.length);
  // Two stops 30 px apart: their leg has no chevron, the others keep theirs.
  const close = model('route');
  close.points.push({ node: 'property:near', x: 210, y: 70 });
  close.route.stops.splice(1, 0, 'property:near');
  assert.equal(chevrons(renderSvg('route', close)).length, close.route.stops.length + 1 - 1);
});

test('route: a stop flagged soft gets an orange outer ring and one flagged hard a red one, under its pin; none or no flag, no ring', () => {
  const m = model('route');
  const svg = renderSvg('route', m);
  const ring = (node) => ringsAt(svg, pointOf(m, node));
  assert.deepEqual(m.route.stops.map((s) => (typeof s === 'string' ? 'plain' : s.flag)), ['plain', 'plain', 'soft', 'none', 'hard', 'plain'], 'the fixture');
  assert.deepEqual(stopNodes(m).map(ring), [[], [], ['#F08C00'], [], ['#E03131'], []]);
  assert.deepEqual(FLAG_COLORS, { soft: '#F08C00', hard: '#E03131' });
  assert.deepEqual(FLAGS, ['none', 'soft', 'hard']);
  // The ring is drawn before (under) its pin's disc.
  const lines = svg.split('\n');
  const p = pointOf(m, 'property:p5');
  assert.ok(lines.findIndex((l) => l.includes(`cx="${p.x}" cy="${p.y}" r="21"`)) < lines.findIndex((l) => l.includes(`cx="${p.x}" cy="${p.y}" r="17"`)));
  // { node } alone, and { node, flag: 'none' }, draw as the bare node does.
  const bare = model('route');
  bare.route.stops = stopNodes(bare);
  const objects = model('route');
  objects.route.stops = stopNodes(objects).map((node, i) => (i % 2 ? { node } : { node, flag: 'none' }));
  assert.equal(renderSvg('route', objects), renderSvg('route', bare));
  assert.doesNotMatch(svg, /soft|hard|flag/, 'no flag word is written');
});

test('route: any other flag value is refused, naming the field, never the value', () => {
  const edits = [
    [(m) => { m.route.stops[2].flag = 'late'; }, 'route.stops[2].flag', 'out_of_range'],
    [(m) => { m.route.stops[2].flag = 'HARD'; }, 'route.stops[2].flag', 'out_of_range'],
    [(m) => { m.route.stops[2].flag = ''; }, 'route.stops[2].flag', 'out_of_range'],
    [(m) => { m.route.stops[2].flag = 2; }, 'route.stops[2].flag', 'not_text'],
    [(m) => { m.route.stops[2].flag = null; }, 'route.stops[2].flag', 'not_text'],
    [(m) => { m.route.stops[2].label = 'late'; }, 'route.stops[2]', 'unknown_key'],
    [(m) => { delete m.route.stops[2].node; }, 'route.stops[2].node', 'missing'],
    [(m) => { m.route.stops[2].node = 'property:zz'; }, 'route.stops[2].node', 'no_position'],
    [(m) => { m.route.stops[2].node = 'place:p3'; }, 'route.stops[2].node', 'bad_node'],
    [(m) => { m.route.stops[2] = { node: 'property:p1', flag: 'soft' }; }, 'route.stops[2]', 'duplicate'],
    [(m) => { m.route.stops[2] = { node: m.depot }; }, 'route.stops[2]', 'duplicate'],
    [(m) => { m.route.stops[2] = ['property:p3', 'soft']; }, 'route.stops[2]', 'not_text'],
  ];
  for (const [edit, field, problem] of edits) {
    const m = model('route');
    edit(m);
    refuses('route', m, field, problem);
  }
});

test('route: the order given is the order drawn; a reorder renumbers the stops and redraws the loop', () => {
  const m = model('route');
  const reordered = model('route');
  reordered.route.stops = [...m.route.stops].reverse();
  const a = renderSvg('route', m);
  const b = renderSvg('route', reordered);
  assert.notEqual(a, b);
  const last = pointOf(m, stopNodes(m).at(-1));
  assert.equal(find(b, 'path', { d: boldNumberPath(1, last.x, last.y) }).length, 1, 'the last stop is now 1');
  const want = [m.depot, ...stopNodes(reordered), m.depot].map((n) => `${pointOf(m, n).x},${pointOf(m, n).y}`).join(' ');
  assert.deepEqual(find(b, 'polyline').map((e) => e.attrs.points), [want, want]);
  // The flags travel with their stops.
  const p5 = pointOf(m, 'property:p5');
  assert.deepEqual(ringsAt(b, p5), ['#E03131']);
  assert.equal(renderSvg('route', clone(reordered)), b, 'byte-identical twice');
});

test('route: no stops draws only the Office; one stop draws an out-and-back loop; a crew past the palette gets its dashes', () => {
  const none = model('route');
  none.route.stops = [];
  const svg = renderSvg('route', none);
  assert.deepEqual(officeAt(svg, pointOf(none, none.depot)), { square: 1, house: 1, door: 1 });
  assert.equal(find(svg, 'polyline').length + find(svg, 'circle').length + find(svg, 'path').length, 0);
  const one = model('route');
  one.route.stops = ['property:p3'];
  const o = pointOf(one, one.depot);
  const p = pointOf(one, 'property:p3');
  assert.deepEqual(find(renderSvg('route', one), 'polyline').map((e) => e.attrs.points), [`${o.x},${o.y} ${p.x},${p.y} ${o.x},${o.y}`, `${o.x},${o.y} ${p.x},${p.y} ${o.x},${o.y}`]);
  assert.equal(chevrons(renderSvg('route', one)).length, 2, 'out and back');
  const dashed = model('route');
  dashed.crews[1].color = PALETTE.length + 2;
  const line = find(renderSvg('route', dashed), 'polyline', { stroke: PALETTE[2].fill })[0].attrs;
  assert.equal(line['stroke-dasharray'], '12 6');
  assert.equal(find(renderSvg('route', dashed), 'polyline', { stroke: '#FFFFFF' })[0].attrs['stroke-dasharray'], undefined, 'the casing is solid');
});

test('route: the model is checked, and every refusal names the field, never a value', () => {
  const edits = [
    [(m) => { delete m.depot; }, 'depot', 'missing'],
    [(m) => { delete m.route; }, 'route', 'missing'],
    [(m) => { m.depot = 'depot:zz'; }, 'depot', 'no_position'],
    [(m) => { m.depot = 'office:hq'; }, 'depot', 'bad_node'],
    [(m) => { m.depot = 7; }, 'depot', 'not_text'],
    [(m) => { m.route = []; }, 'route', 'not_object'],
    [(m) => { m.route.label = 'Office'; }, 'route', 'unknown_key'],
    [(m) => { m.route.crewId = 'c9'; }, 'route.crewId', 'unknown_crew'],
    [(m) => { delete m.route.stops; }, 'route.stops', 'missing'],
    [(m) => { m.route.stops = 'property:p1'; }, 'route.stops', 'not_list'],
    [(m) => { m.route.stops[2] = 'property:zz'; }, 'route.stops[2]', 'no_position'],
    [(m) => { m.route.stops[2] = m.depot; }, 'route.stops[2]', 'duplicate'],
    [(m) => { m.route.stops[3] = m.route.stops[0]; }, 'route.stops[3]', 'duplicate'],
    [(m) => { m.officeLabel = 'Office'; }, 'model', 'unknown_key'],
    [(m) => { m.routes = []; }, 'model', 'unknown_key'],
  ];
  for (const [edit, field, problem] of edits) {
    const m = model('route');
    edit(m);
    refuses('route', m, field, problem);
  }
  // The depot: kind is a node the renderer accepts (Brightside's Office is depot:office).
  const office = model('route');
  for (const p of office.points) if (p.node === 'depot:hq') p.node = 'depot:office';
  for (const c of office.crews) c.baseNode = 'depot:office';
  office.depot = 'depot:office';
  assert.equal(renderSvg('route', office), renderSvg('route', model('route')), 'same drawing; the id is never written');
  // The route view's model is not another view's, nor the reverse.
  refuses('route', model('zone'), 'model', 'unknown_key');
  refuses('gap', model('route'), 'model', 'unknown_key');
  // More than 99 stops is refused; 99 are drawn.
  const many = model('route');
  const points = Array.from({ length: 100 }, (_, i) => ({ node: `property:q${i}`, x: 10 + (i % 50) * 10, y: 50 + Math.floor(i / 50) * 100 }));
  many.points.push(...points);
  many.route.stops = points.map((p) => p.node);
  refuses('route', many, 'route.stops', 'out_of_range');
  many.route.stops.pop();
  assert.equal(find(renderSvg('route', many), 'circle', { r: 17 }).length, 99);
});

test('route: over the street map the background is a stronger wash (0.6) and nothing else changes', () => {
  const plain = renderSvg('route', model('route'));
  const streets = renderSvg('route', model('route'), { base: 'streets' });
  assert.deepEqual(elements(streets)[0].attrs, {
    x: '0', y: '0', width: '600', height: '400', fill: '#FFFFFF', 'fill-opacity': '0.6',
  });
  assert.equal(streets.split('\n').slice(2).join('\n'), plain.split('\n').slice(2).join('\n'));
});

test('route: the alt text the Slack image takes is "Route map: Planned route, <crew>, <n> stops"', () => {
  const image = require('../../kit/runtime/slack/image');
  const m = model('route');
  const alt = image.altText({ view: 'Planned route', crew: 'Crew 2', stops: m.route.stops.length });
  assert.equal(alt, 'Route map: Planned route, Crew 2, 6 stops');
  assert.equal(image.isAltText(alt), true);
});

// --- Story 15.18: Routing's four views are untouched ------------------------------------------

// sha256 of each of Routing's four views' SVG over street tiles (the wash),
// computed with main's svg.js before Story 15.18: with PLAIN_SVG_SHA256
// above, the four views have not moved a byte, plain or over streets.
const STREETS_SVG_SHA256 = Object.freeze({
  compare: 'a7a6baade72d1785171b2470e61d0d9e5664d84c9ffe9f3ad7668cda156f321c',
  change: '261447d09a3cd24d3492ce41f370892b859f7767a37ff3a28505456ddd4d9a70',
  zone: '52088863b6a79ea232512043323a811483087ba0fd9c0c8a672879ccacea9db5',
  gap: 'ffe913c94358cd9762d2da607c55e0717a0b01c948522c6ae92090c0c10b24d1',
});

test('Story 15.18: Routing\'s four views are byte-identical to before, plain and over streets', () => {
  const sha = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');
  for (const view of ['compare', 'change', 'zone', 'gap']) {
    assert.equal(sha(renderSvg(view, model(view))), PLAIN_SVG_SHA256[view], `${view} plain`);
    assert.equal(sha(renderSvg(view, model(view), { base: 'streets' })), STREETS_SVG_SHA256[view], `${view} over streets`);
  }
});

// --- Story 15.18: the bold filled numerals ----------------------------------------------------

test('bold numbers 1 to 99 are distinct filled paths of whole-pixel boxes, centred; anything else is a programming error', () => {
  const seen = new Set();
  for (let n = 1; n <= 99; n += 1) {
    const d = boldNumberPath(n, 100, 100);
    assert.match(d, /^(M\d+ \d+H\d+V\d+H\d+Z)+$/, String(n));
    assert.ok(!seen.has(d), `${n} is distinct`);
    seen.add(d);
  }
  for (const bad of [0, 100, 1.5, '7', -1]) assert.throws(() => boldNumberPath(bad, 0, 0), RangeError);
  // A one-digit number spans x-4..x+5, a two-digit one x-10..x+10; both y-7..y+8.
  const box = (d) => {
    const xs = [...d.matchAll(/M(\d+) |H(\d+)/g)].map((m) => Number(m[1] || m[2]));
    const ys = [...d.matchAll(/M\d+ (\d+)|V(\d+)/g)].map((m) => Number(m[1] || m[2]));
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  };
  assert.deepEqual(box(boldNumberPath(8, 100, 100)), [96, 105, 93, 108]);
  assert.deepEqual(box(boldNumberPath(88, 100, 100)), [90, 110, 93, 108]);
  // Inside the pin: every corner of a two-digit number is within the disc's inner edge (17 - 1.5).
  const corners = (d) => [...d.matchAll(/M(\d+) (\d+)H(\d+)V(\d+)/g)].flatMap((m) => [[+m[1], +m[2]], [+m[3], +m[4]]]);
  for (const [x, y] of corners(boldNumberPath(88, 100, 100))) assert.ok(Math.hypot(x - 100, y - 100) < 15.5, `${x},${y}`);
});
