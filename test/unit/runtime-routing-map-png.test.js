'use strict';

// Story 15.3 (AD-R14, F11): SVG to PNG through @resvg/resvg-js. Same SVG,
// same bytes on one machine (no cross-platform hash is pinned); the PNG has
// the frame's size; system fonts are off; over MAX_PNG_BYTES is refused; the
// rasterizer is required lazily and a load failure is a fixed-text
// RoutingFault. The lockfile holds the Linux binary the Docker image needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const map = require('../../kit/runtime/routing-map');
const {
  rasterize: rasterizeSvg, createRasterizer, composeBasemap, isTile, pngSize, MAX_PNG_BYTES, MEASURED_PNG_BYTES, MAX_PNG_CEILING,
  SLACK_UPLOAD_BYTES, PNG_CAP, ROUTE_SCALES,
} = require('../../kit/runtime/routing-map/png');
const { RoutingFault } = require('../../kit/runtime/errors');

const REPO = path.join(__dirname, '..', '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'routing-map');
const RESVG = ['@resvg', 'resvg-js'].join('/'); // spelled apart: only png.js names it in a require
const load = (view) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${view}.json`), 'utf8'));

const UNAVAILABLE = 'routing input refused: "map image" renderer_unavailable';
const TOO_LARGE = 'routing input refused: "map image" image_too_large';
const FAILED = 'routing input refused: "map image" renderer_failed';

function faultOf(fn) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof RoutingFault, `not a RoutingFault: ${e && e.message}`);
    return e;
  }
  assert.fail('expected a RoutingFault');
}

// A PNG-shaped buffer of `length` bytes declaring width x height.
function fakePng(width, height, length = 33) {
  const b = Buffer.alloc(length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

// A stand-in for the module: records each Resvg's options, renders `png`.
function stubModule(png, calls = []) {
  return {
    Resvg: class {
      constructor(svg, opts) { calls.push({ svg, opts }); }
      render() { return { asPng: () => (typeof png === 'function' ? png() : png) }; }
    },
  };
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect x="0" y="0" width="300" height="200" fill="#FFFFFF"/></svg>';

// The PNG size renderPng draws a view at when it fits: Plan a route's map
// (route) at 2x (Story 15.18), Routing's four views at the image size.
const drawnSize = (view, frame) => {
  const size = map.imageSize(view, frame);
  return view === 'route' ? { width: size.width * 2, height: size.height * 2 } : size;
};
const scalesOf = (view) => (view === 'route' ? { scales: ROUTE_SCALES } : undefined);

test('each fixture rasterizes twice to the same bytes, at the image size, under MAX_PNG_BYTES', () => {
  for (const view of map.VIEWS) {
    const { model } = load(view);
    const a = map.renderPng(view, model);
    const b = map.renderPng(view, JSON.parse(JSON.stringify(model)));
    assert.ok(Buffer.isBuffer(a));
    assert.ok(a.equals(b), `${view}: identical bytes`);
    assert.deepEqual(pngSize(a), drawnSize(view, model.frame), view);
    assert.ok(a.length < MAX_PNG_BYTES, `${view}: ${a.length} bytes`);
    assert.ok(a.length > 1000, `${view}: something was drawn`);
  }
  // A one-panel view is exactly the frame.
  const { model } = load('zone');
  assert.deepEqual(pngSize(map.renderPng('zone', model)), { width: model.frame.width, height: model.frame.height });
});

test('system fonts are off: text in an SVG draws nothing', () => {
  const blank = rasterizeSvg(SVG, { width: 300, height: 200 });
  const withText = rasterizeSvg(SVG.replace('</svg>', '<text x="20" y="100" font-size="40" fill="#000000">Hello 42</text></svg>'), { width: 300, height: 200 });
  assert.ok(blank.equals(withText), 'no font was found, so no glyph was drawn');
  const calls = [];
  const rasterize = createRasterizer({ load: () => stubModule(fakePng(300, 200), calls) });
  rasterize(SVG, { width: 300, height: 200 });
  assert.equal(calls[0].opts.font.loadSystemFonts, false);
  assert.deepEqual(calls[0].opts.fitTo, { mode: 'original' });
  assert.ok(!('fontFiles' in calls[0].opts.font) && !('fontDirs' in calls[0].opts.font));
});

test('a PNG over MAX_PNG_BYTES is refused with fixed words; exactly MAX_PNG_BYTES is not', () => {
  const ok = createRasterizer({ load: () => stubModule(fakePng(300, 200, MAX_PNG_BYTES)) });
  assert.equal(ok(SVG, { width: 300, height: 200 }).length, MAX_PNG_BYTES);
  const big = createRasterizer({ load: () => stubModule(fakePng(300, 200, MAX_PNG_BYTES + 1)) });
  const e = faultOf(() => big(SVG, { width: 300, height: 200 }));
  assert.deepEqual(e.details, { field: 'map image', problem: 'image_too_large' });
  assert.equal(e.message, TOO_LARGE);
  // Story 15.10 (AD-R21): the cap is twice the measured maximum, never over 4 MB.
  assert.equal(MAX_PNG_BYTES, Math.min(2 * MEASURED_PNG_BYTES, 4 * 1024 * 1024));
});

test('a rasterizer that throws, returns no PNG or the wrong size gives renderer_failed, never its own words', () => {
  const throws = createRasterizer({ load: () => stubModule(() => { throw new Error('resvg said /home/x/secret.svg'); }) });
  const cases = [
    throws,
    createRasterizer({ load: () => stubModule('not a png') }),
    createRasterizer({ load: () => stubModule(Buffer.from('not a png at all, long enough to read')) }),
    createRasterizer({ load: () => stubModule(fakePng(301, 200)) }),
  ];
  for (const r of cases) {
    const e = faultOf(() => r(SVG, { width: 300, height: 200 }));
    assert.equal(e.message, FAILED);
  }
  assert.equal(faultOf(() => rasterizeSvg(42)).details.problem, 'not_text');
});

test('a rasterizer that cannot load is a fixed-text RoutingFault, every time, and load is tried once', () => {
  let tries = 0;
  const rasterize = createRasterizer({ load: () => { tries += 1; throw new Error('Cannot find module /Users/x/node_modules/native.node'); } });
  for (let i = 0; i < 3; i += 1) {
    const e = faultOf(() => rasterize(SVG, { width: 300, height: 200 }));
    assert.deepEqual(e.details, { field: 'map image', problem: 'renderer_unavailable' });
    assert.equal(e.message, UNAVAILABLE);
  }
  assert.equal(tries, 1);
  const empty = createRasterizer({ load: () => ({}) });
  assert.equal(faultOf(() => empty(SVG)).message, UNAVAILABLE);
});

test('the public entry rasterizes only what renderSvg drew: no rasterize export', () => {
  assert.equal('rasterize' in map, false);
  assert.deepEqual(Object.keys(map).sort(), ['MAX_PNG_BYTES', 'VIEWS', 'imageSize', 'renderPng', 'renderSvg']);
});

test('an SVG with a reference, a style or foreign content is refused before the rasterizer sees it', () => {
  const UNSAFE = 'routing input refused: "map image" unsafe_svg';
  const pieces = [
    '<image href="/etc/passwd" width="10" height="10"/>',
    '<IMAGE x="0"/>',
    '<a href="#x"><rect width="1" height="1"/></a>',
    '<rect xlink:title="x" width="1" height="1"/>',
    '<rect fill="url(#g)" width="1" height="1"/>',
    '<use x="0"/>',
    '<style>rect{fill:red}</style>',
    '<rect style="@import \'x.css\'" width="1" height="1"/>',
    '<foreignObject width="1" height="1"></foreignObject>',
    '<script>1</script>',
  ];
  for (const piece of pieces) {
    const calls = [];
    const stubbed = createRasterizer({ load: () => stubModule(fakePng(300, 200), calls) });
    const svg = SVG.replace('</svg>', `${piece}</svg>`);
    const e = faultOf(() => stubbed(svg, { width: 300, height: 200 }));
    assert.deepEqual(e.details, { field: 'map image', problem: 'unsafe_svg' }, piece);
    assert.equal(e.message, UNSAFE);
    assert.equal(calls.length, 0, `${piece}: the rasterizer never saw it`);
    assert.equal(faultOf(() => rasterizeSvg(svg, { width: 300, height: 200 })).message, UNSAFE);
  }
  // Every fixture renderSvg draws passes the check (the first test rasterizes them).
});

// In a child process, so the module cache and the require hook stay there.
function child(script) {
  const r = spawnSync(process.execPath, ['-e', script], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('the rasterizer is required lazily: loading the renderer does not load it, the first PNG does', () => {
  const out = child(`
    const loaded = () => Object.keys(require.cache).some((k) => k.includes(${JSON.stringify(`${path.sep}@resvg${path.sep}`)}));
    const map = require('./kit/runtime/routing-map');
    const before = loaded();
    map.renderSvg('gap', require('./test/fixtures/routing-map/gap.json').model);
    const afterSvg = loaded();
    map.renderPng('gap', require('./test/fixtures/routing-map/gap.json').model);
    process.stdout.write(JSON.stringify({ before, afterSvg, afterPng: loaded() }));`);
  assert.deepEqual(out, { before: false, afterSvg: false, afterPng: true });
});

test('when the require itself fails (stubbed), renderPng throws the fixed-text fault and the SVG still renders', () => {
  const out = child(`
    const Module = require('node:module');
    const real = Module._load;
    Module._load = function (request, ...rest) {
      if (request === ${JSON.stringify(RESVG)}) throw new Error('stubbed: no binary for this platform');
      return real.call(this, request, ...rest);
    };
    const map = require('./kit/runtime/routing-map');
    const { model } = require('./test/fixtures/routing-map/compare.json');
    const svg = map.renderSvg('compare', model).length > 0;
    let fault = null;
    try { map.renderPng('compare', model); } catch (e) { fault = { name: e.constructor.name, code: e.code, message: e.message, details: e.details }; }
    process.stdout.write(JSON.stringify({ svg, fault }));`);
  assert.deepEqual(out, {
    svg: true,
    fault: { name: 'RoutingFault', code: 'ROUTING_FAULT', message: UNAVAILABLE, details: { field: 'map image', problem: 'renderer_unavailable' } },
  });
});

test('the error words for the renderer faults are fixed and name no value', () => {
  const { messageFor } = require('../../kit/runtime/messages');
  for (const problem of ['renderer_unavailable', 'renderer_failed', 'image_too_large', 'unsafe_svg', 'unknown_key']) {
    const words = messageFor(new RoutingFault({ field: 'map image', problem }), { admin: 'Sam' });
    assert.match(words, /"map image"/);
    assert.match(words, /please tell Sam/);
  }
});

test('the container smoke script passes outside the image (CI runs it inside)', () => {
  // --skip-network: outside the image the OpenStreetMap step would reach the
  // real server; its no-network check is tested in process below.
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/smoke-routing-map.js'), '--skip-network'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const view of map.VIEWS) assert.match(r.stdout, new RegExp(`ok - ${view} \\d+x\\d+, \\d+ bytes`));
  assert.match(r.stdout, /ok - compare with streets 1200x400, \d+ bytes \(cap \d+\)/);
  assert.match(r.stdout, /skipped - the no-network fetch/);
  assert.match(r.stdout, /routing-map smoke: PASSED/);
});

// --- the dependency, offline ------------------------------------------------------

test('the lockfile holds the Linux x64 glibc binary the Docker image installs, pinned with the package', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const version = pkg.dependencies[RESVG];
  assert.match(version, /^\d+\.\d+\.\d+$/, 'pinned to an exact version');
  const main = lock.packages[`node_modules/${RESVG}`];
  assert.equal(main.version, version);
  assert.equal(main.license, 'MPL-2.0');
  const linux = `${RESVG}-linux-x64-gnu`;
  assert.equal(main.optionalDependencies[linux], version);
  const entry = lock.packages[`node_modules/${linux}`];
  assert.ok(entry, `${linux} is in package-lock.json`);
  assert.equal(entry.version, version);
  assert.deepEqual(entry.os, ['linux']);
  assert.deepEqual(entry.cpu, ['x64']);
  assert.deepEqual(entry.libc, ['glibc']);
  assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.match(entry.integrity, /^sha512-/);
  // The image runs `npm ci --ignore-scripts`: the binary must need no install script.
  for (const [key, p] of Object.entries(lock.packages)) {
    if (key.startsWith(`node_modules/${RESVG}`)) assert.ok(!p.hasInstallScript, `${key} has no install script`);
  }
});

test('THIRD_PARTY_NOTICES.md names the rasterizer and its licence', () => {
  const text = fs.readFileSync(path.join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(text, /@resvg\/resvg-js/);
  assert.match(text, /MPL-2\.0/);
});

// --- Story 15.10: street tiles under the plot (AD-R21) ---------------------------------------

const { FRAME } = require('../../kit/runtime/archetypes/routing-map/views');
const smokeScript = require('../../scripts/smoke-routing-map');
const { createFakeTiles } = require('../fixtures/fake-tiles');

const TILES = path.join(FIXTURES, 'tiles');
const tile = (name) => fs.readFileSync(path.join(TILES, name));
const STREETS = ['a', 'b', 'c', 'd'].map((n) => tile(`streets-${n}.png`));
const PLAIN_TILES = [tile('grid.png'), tile('stripes.png')];
const DATA_PNG = 'data:image/png;base64,';
const panelsOf = (view) => (['compare', 'change'].includes(view) ? 2 : 1);

// The tiles covering frame from (ox, oy), the given PNGs in turn.
function basemapFor(frame, { ox = -91, oy = -77, pngs = PLAIN_TILES } = {}) {
  const cols = Math.ceil((frame.width - ox) / 256);
  const rows = Math.ceil((frame.height - oy) / 256);
  const tiles = [];
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) tiles.push({ col, row, png: pngs[(col * 3 + row) % pngs.length] });
  return { tiles, ox, oy };
}
const layoutOf = (view, frame) => ({ frame: { width: frame.width, height: frame.height }, panels: panelsOf(view) });
const hrefsOf = (svg) => [...svg.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

test('Story 15.10: with no basemap each fixture\'s PNG is byte-identical to the plain rasterize of the unchanged SVG (one machine)', () => {
  for (const view of map.VIEWS) {
    const { model } = load(view);
    const plain = rasterizeSvg(map.renderSvg(view, model), map.imageSize(view, model.frame), scalesOf(view));
    assert.ok(map.renderPng(view, model).equals(plain), view);
    assert.ok(map.renderPng(view, model, {}).equals(plain), view);
    assert.ok(map.renderPng(view, model, { basemap: null }).equals(plain), view);
  }
});

test('Story 15.10: composeBasemap puts the same tiles under every panel, under the wash, each a PNG data URI; the plot is untouched', () => {
  for (const view of map.VIEWS) {
    const { model } = load(view);
    const basemap = basemapFor(model.frame);
    const svg = map.renderSvg(view, model, { base: 'streets' });
    const out = composeBasemap(svg, basemap, layoutOf(view, model.frame));
    const want = basemap.tiles.length * panelsOf(view);
    assert.equal((out.match(/<image/g) || []).length, want, `${view}: tiles x panels images`);
    assert.equal(hrefsOf(out).length, want);
    for (const h of hrefsOf(out)) assert.ok(h.startsWith(DATA_PNG), `${view}: a PNG data URI`);
    assert.ok(!/https?:|file:|\.\.\/|\/etc\//.test(hrefsOf(out).join(' ')), 'no http(s) or path href');
    // One clipped layer per panel, before the wash and the plot.
    const lines = out.split('\n');
    assert.equal(lines[0], svg.split('\n')[0]);
    const layers = lines.filter((l) => l.startsWith('<svg x='));
    assert.deepEqual(layers, Array.from({ length: panelsOf(view) }, (_, p) => `<svg x="${p * model.frame.width}" y="0" width="${model.frame.width}" height="${model.frame.height}">`));
    const washAt = lines.findIndex((l) => l.includes(`fill-opacity="${view === 'route' ? '0.6' : '0.45'}"`));
    const lastImage = lines.map((l, i) => (l.startsWith('<image') ? i : -1)).filter((i) => i >= 0).at(-1);
    assert.ok(lastImage < washAt, `${view}: every tile is under the wash`);
    assert.equal(out.replace(/<svg x=[^\n]*\n(<image[^\n]*\n)*<\/svg>\n/g, ''), svg, `${view}: the plot SVG is unchanged around the tiles`);
    // Both panels hold the same tiles at the same panel offsets.
    if (panelsOf(view) === 2) {
      const [left, right] = out.split('<svg x=').slice(1).map((chunk) => chunk.slice(chunk.indexOf('\n'), chunk.indexOf('</svg>')));
      assert.equal(left, right);
    }
  }
});

test('Story 15.10: <image, href and url( in the plot SVG are still refused (unsafe_svg), with or without a basemap', () => {
  const { model } = load('gap');
  const svg = map.renderSvg('gap', model, { base: 'streets' });
  const basemap = basemapFor(model.frame);
  for (const piece of ['<image href="/etc/passwd" width="1" height="1"/>', `<image href="${DATA_PNG}AAAA"/>`, '<a href="https://x.example"/>', '<rect fill="url(#g)"/>']) {
    const bad = svg.replace('</svg>', `${piece}</svg>`);
    const calls = [];
    const r = createRasterizer({ load: () => stubModule(fakePng(600, 400), calls) });
    assert.equal(faultOf(() => r(bad, { width: 600, height: 400 })).details.problem, 'unsafe_svg', piece);
    assert.equal(faultOf(() => r.streets(bad, basemap, layoutOf('gap', model.frame), { width: 600, height: 400 })).details.problem, 'unsafe_svg', piece);
    assert.equal(faultOf(() => composeBasemap(bad, basemap, layoutOf('gap', model.frame))).details.problem, 'unsafe_svg', piece);
    assert.equal(calls.length, 0, `${piece}: the rasterizer never saw it`);
  }
  // A composed SVG is refused by the plain path: it is never rasterized as plain.
  const composed = composeBasemap(svg, basemap, layoutOf('gap', model.frame));
  assert.equal(faultOf(() => rasterizeSvg(composed, map.imageSize('gap', model.frame))).details.problem, 'unsafe_svg');
});

test('Story 15.10: a tile that is not a checked 256x256 PNG, or tiles that are not a whole grid covering the frame, are basemap_invalid', () => {
  const { model } = load('zone');
  const svg = map.renderSvg('zone', model, { base: 'streets' });
  const layout = layoutOf('zone', model.frame);
  const good = basemapFor(model.frame);
  const withTile = (png) => ({ ...good, tiles: good.tiles.map((t, i) => (i === 2 ? { ...t, png } : t)) });
  const lyingHeader = Buffer.from(PLAIN_TILES[0]);
  lyingHeader.writeUInt32BE(512, 16);
  const oversize = Buffer.concat([PLAIN_TILES[0], Buffer.alloc(256 * 1024)]);
  const badSignature = Buffer.from(PLAIN_TILES[0]);
  badSignature[1] = 0x51;
  const cases = [
    ['a 128x128 PNG', withTile(tile('small.png'))],
    ['a 512-wide header', withTile(lyingHeader)],
    ['over 256 KB', withTile(oversize)],
    ['not a PNG', withTile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))],
    ['a bad signature', withTile(badSignature)],
    ['a string', withTile(PLAIN_TILES[0].toString('base64'))],
    ['a tile missing', { ...good, tiles: good.tiles.slice(1) }],
    ['a tile twice', { ...good, tiles: [...good.tiles.slice(1), good.tiles[1]] }],
    ['tile numbers', { ...good, tiles: good.tiles.map((t) => ({ ...t, z: 13, x: 1, y: 2 })) }],
    ['a mosaic key', { ...good, tx0: 2417 }],
    ['a url', { ...good, tiles: good.tiles.map((t) => ({ ...t, url: 'https://tiles.example.org/1/2/3.png' })) }],
    ['too few columns', basemapFor({ width: model.frame.width - 256, height: model.frame.height })],
    ['an offset out of range', { ...good, ox: -256 }],
    ['a positive offset', { ...good, oy: 1 }],
    ['no tiles', { ...good, tiles: [] }],
    ['not an object', null],
    ['a negative column', { ...good, tiles: good.tiles.map((t, i) => (i === 0 ? { ...t, col: -1 } : t)) }],
  ];
  for (const [what, basemap] of cases) {
    const e = faultOf(() => composeBasemap(svg, basemap, layout));
    assert.deepEqual(e.details, { field: 'basemap', problem: 'basemap_invalid' }, what);
    assert.equal(e.message, 'routing input refused: "basemap" basemap_invalid', what);
    if (basemap !== null) assert.throws(() => map.renderPng('zone', model, { basemap }), RoutingFault, what);
  }
  assert.equal(isTile(PLAIN_TILES[0]), true);
  assert.equal(isTile(tile('small.png')), false);
  // The layout must match the SVG drawn.
  assert.equal(faultOf(() => composeBasemap(svg, good, { ...layout, panels: 2 })).details.problem, 'out_of_range');
  assert.equal(faultOf(() => composeBasemap(svg, good, { frame: { width: 0, height: 1 }, panels: 1 })).details.problem, 'out_of_range');
});

test('Story 15.10: with tiles, the same model and tile bytes give byte-identical PNGs twice, at the frame\'s dimensions; the tiles show', () => {
  for (const view of map.VIEWS) {
    const { model } = load(view);
    const basemap = basemapFor(model.frame, { pngs: STREETS });
    const copy = { ...basemap, tiles: basemap.tiles.map((x) => ({ ...x, png: Buffer.from(x.png) })) };
    const a = map.renderPng(view, model, { basemap });
    const b = map.renderPng(view, JSON.parse(JSON.stringify(model)), { basemap: copy });
    assert.ok(a.equals(b), `${view}: identical bytes`);
    assert.deepEqual(pngSize(a), drawnSize(view, model.frame), view);
    assert.ok(!a.equals(map.renderPng(view, model)), `${view}: not the plain map`);
    assert.ok(a.length <= MAX_PNG_BYTES, `${view}: ${a.length} bytes`);
  }
});

test('Story 15.10: the rasterizer gets only the checked tile bytes as data URIs, never a path or a URL', () => {
  const calls = [];
  const r = createRasterizer({ load: () => stubModule(fakePng(1200, 400), calls) });
  const { model } = load('compare');
  const basemap = basemapFor(model.frame);
  r.streets(map.renderSvg('compare', model, { base: 'streets' }), basemap, layoutOf('compare', model.frame), { width: 1200, height: 400 });
  assert.equal(calls.length, 1);
  const seen = calls[0].svg;
  assert.equal(hrefsOf(seen).length, basemap.tiles.length * 2);
  for (const h of hrefsOf(seen)) {
    assert.ok(h.startsWith(DATA_PNG));
    assert.ok(PLAIN_TILES.some((p) => p.toString('base64') === h.slice(DATA_PNG.length)), 'the checked bytes, as they came');
  }
  assert.equal(seen.replaceAll('xmlns="http://www.w3.org/2000/svg"', '').match(/https?:|xlink|file:/), null, 'no other reference');
});

test('Story 15.10: a composed PNG over the cap is refused (image_too_large); the plain map still fits', () => {
  const { model } = load('gap');
  const small = createRasterizer({ maxBytes: 50 * 1024 });
  const svg = map.renderSvg('gap', model, { base: 'streets' });
  const e = faultOf(() => small.streets(svg, basemapFor(model.frame, { pngs: STREETS }), layoutOf('gap', model.frame), map.imageSize('gap', model.frame)));
  assert.deepEqual(e.details, { field: 'map image', problem: 'image_too_large' });
  assert.ok(small(map.renderSvg('gap', model), map.imageSize('gap', model.frame)).length <= 50 * 1024);
});

test('Story 15.10: MAX_PNG_BYTES is twice the four views\' measured maximum over dense street tiles, at most 4 MB and under Slack\'s upload check', (t) => {
  const image = require('../../kit/runtime/slack/image');
  assert.equal(MAX_PNG_BYTES, Math.min(2 * MEASURED_PNG_BYTES, MAX_PNG_CEILING));
  assert.ok(MAX_PNG_BYTES <= 4 * 1024 * 1024);
  assert.ok(MAX_PNG_BYTES <= image.MAX_PNG_BYTES, 'the Slack upload never refuses a PNG the renderer allows');
  // Re-measure at the archetype's frame on the worst grid (4 x 4 tiles): a
  // view grown more than a tenth past the measurement means re-measuring.
  const big = createRasterizer({ maxBytes: 64 * 1024 * 1024 });
  let max = 0;
  for (const view of map.VIEWS) {
    const model = { ...load(view).model, frame: { ...FRAME } };
    const basemap = basemapFor(FRAME, { ox: -100, oy: -230, pngs: STREETS });
    assert.equal(basemap.tiles.length, 16);
    const png = big.streets(map.renderSvg(view, model, { base: 'streets' }), basemap, layoutOf(view, FRAME), map.imageSize(view, FRAME));
    t.diagnostic(`${view}: ${png.length} bytes with streets (cap ${MAX_PNG_BYTES})`);
    max = Math.max(max, png.length);
  }
  assert.ok(max <= MEASURED_PNG_BYTES * 1.1, `measured ${max}, recorded ${MEASURED_PNG_BYTES}`);
  assert.ok(max > MEASURED_PNG_BYTES * 0.5, 'the recorded measurement is not stale');
});

test('Story 15.10: the smoke script\'s no-network step: fetchMosaic against the OpenStreetMap template gives null when the host cannot be reached', async () => {
  const unreachable = createFakeTiles({ host: 'not-the-tile-host.example' });
  const got = await smokeScript.offline({ fetch: unreachable.fetch });
  assert.equal(got.basemap, null);
  assert.equal(got.reason, 'fetch_failed');
  assert.ok(unreachable.requests.length > 0, 'it tried');
  assert.ok(unreachable.requests.every((q) => q.url.startsWith('https://tile.openstreetmap.org/12/')));
});

test('Story 15.10: the smoke script\'s no-network step: a fetch that never answers gives null within the 8 s budget (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-02T15:00:00Z') });
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const pending = smokeScript.offline({ fetch: hang });
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(8000);
  const got = await pending;
  assert.equal(got.basemap, null);
  assert.equal(got.reason, 'timeout');
});

// --- Story 15.13: the route view (AD-R28) ---------------------------------------------------

test('Story 15.13: the route view rasterizes plain and over the synthetic street tiles, byte-identical twice, under MAX_PNG_BYTES', (t) => {
  const { model } = load('route');
  const plain = map.renderPng('route', model);
  assert.ok(plain.equals(map.renderPng('route', JSON.parse(JSON.stringify(model)))));
  assert.deepEqual(pngSize(plain), { width: model.frame.width * 2, height: model.frame.height * 2 }, 'drawn at 2x (Story 15.18)');
  assert.ok(plain.equals(rasterizeSvg(map.renderSvg('route', model), map.imageSize('route', model.frame), { scales: ROUTE_SCALES })), 'the plain path is the plain rasterize');
  t.diagnostic(`route: ${plain.length} bytes plain (cap ${MAX_PNG_BYTES})`);
  assert.ok(plain.length < MAX_PNG_BYTES);
  // At the archetype's frame on the worst grid (4 x 4 dense street tiles).
  const big = { ...model, frame: { ...FRAME } };
  const basemap = basemapFor(FRAME, { ox: -100, oy: -230, pngs: STREETS });
  assert.equal(basemap.tiles.length, 16);
  const a = map.renderPng('route', big, { basemap });
  const b = map.renderPng('route', JSON.parse(JSON.stringify(big)), { basemap: { ...basemap, tiles: basemap.tiles.map((x) => ({ ...x, png: Buffer.from(x.png) })) } });
  assert.ok(a.equals(b), 'identical bytes over the same tiles');
  assert.deepEqual(pngSize(a), { width: FRAME.width * 2, height: FRAME.height * 2 }, 'at 2x: under the cap over dense tiles (Story 15.18)');
  assert.ok(!a.equals(map.renderPng('route', big)), 'not the plain map');
  t.diagnostic(`route: ${a.length} bytes with streets at 2x (cap ${PNG_CAP})`);
  assert.ok(a.length < PNG_CAP, `${a.length} bytes`);
});

test('Story 15.13: unsafe_svg holds for the route view: a reference added to its SVG is refused, plain or over tiles', () => {
  const { model } = load('route');
  const size = map.imageSize('route', model.frame);
  const basemap = basemapFor(model.frame);
  for (const base of ['plain', 'streets']) {
    const svg = map.renderSvg('route', model, { base });
    for (const piece of ['<image href="/etc/passwd" width="1" height="1"/>', '<a href="https://x.example"/>', '<rect fill="url(#g)"/>', '<style>*{}</style>']) {
      const bad = svg.replace('</svg>', `${piece}</svg>`);
      const calls = [];
      const r = createRasterizer({ load: () => stubModule(fakePng(size.width, size.height), calls) });
      const e = faultOf(() => (base === 'plain' ? r(bad, size) : r.streets(bad, basemap, layoutOf('route', model.frame), size)));
      assert.equal(e.details.problem, 'unsafe_svg', `${base}: ${piece}`);
      assert.equal(calls.length, 0, 'the rasterizer never saw it');
    }
  }
});

// --- Story 15.18: Plan a route's map at 2x (AD-R29) ------------------------------------------

const ORIGINAL = Object.freeze({ fitTo: { mode: 'original' }, font: { loadSystemFonts: false }, logLevel: 'off' });

test('Story 15.18: the cap is the smaller of MAX_PNG_BYTES and the Slack upload\'s 1 MB check (not raised), and it is the default', () => {
  const image = require('../../kit/runtime/slack/image');
  assert.equal(SLACK_UPLOAD_BYTES, image.MAX_PNG_BYTES, 'the same number as the upload check');
  assert.equal(image.MAX_PNG_BYTES, 1024 * 1024, 'the upload check is still 1 MB');
  assert.equal(PNG_CAP, Math.min(MAX_PNG_BYTES, SLACK_UPLOAD_BYTES));
  const ok = createRasterizer({ load: () => stubModule(fakePng(300, 200, PNG_CAP)) });
  assert.equal(ok(SVG, { width: 300, height: 200 }).length, PNG_CAP);
  const big = createRasterizer({ load: () => stubModule(fakePng(300, 200, PNG_CAP + 1)) });
  assert.equal(faultOf(() => big(SVG, { width: 300, height: 200 })).message, TOO_LARGE);
});

test('Story 15.18: with no scales the rasterizer is called exactly as before (Routing\'s four views); with scales, at resvg\'s zoom, sized up', () => {
  const calls = [];
  const r = createRasterizer({ load: () => stubModule(() => fakePng(300, 200), calls) });
  r(SVG, { width: 300, height: 200 });
  r(SVG, { width: 300, height: 200 }, { scales: [1] });
  assert.deepEqual(calls.map((c) => c.opts), [ORIGINAL, ORIGINAL]);
  const zoomed = [];
  const z = createRasterizer({ load: () => stubModule(() => fakePng(450, 300), zoomed) });
  assert.deepEqual(pngSize(z(SVG, { width: 300, height: 200 }, { scales: [1.5] })), { width: 450, height: 300 });
  assert.deepEqual(zoomed[0].opts, { ...ORIGINAL, fitTo: { mode: 'zoom', value: 1.5 } });
  // A PNG not of the size times the scale is refused.
  const wrong = createRasterizer({ load: () => stubModule(fakePng(300, 200)) });
  assert.equal(faultOf(() => wrong(SVG, { width: 300, height: 200 }, { scales: [2] })).message, FAILED);
  // An odd side times 1.5 rounds up, as resvg sizes it.
  const odd = '<svg xmlns="http://www.w3.org/2000/svg" width="333" height="201" viewBox="0 0 333 201"><rect x="0" y="0" width="10" height="10" fill="#000000"/></svg>';
  assert.deepEqual(pngSize(rasterizeSvg(odd, { width: 333, height: 201 }, { scales: [1.5] })), { width: 500, height: 302 });
  assert.deepEqual(ROUTE_SCALES, [2, 1.5, 1]);
});

test('Story 15.18: scales other than a falling list drawn from 2, 1.5 and 1 are refused before anything is drawn', () => {
  const calls = [];
  const r = createRasterizer({ load: () => stubModule(fakePng(300, 200), calls) });
  for (const bad of [{ scales: [] }, { scales: [3] }, { scales: [1, 2] }, { scales: [2, 2] }, { scales: '2' }, { scales: [2], more: 1 }, [2], null]) {
    const e = faultOf(() => r(SVG, { width: 300, height: 200 }, bad));
    assert.deepEqual(e.details, { field: 'scales', problem: 'out_of_range' }, JSON.stringify(bad));
    const s = faultOf(() => r.streets(SVG, {}, {}, { width: 300, height: 200 }, bad));
    assert.equal(s.details.field, 'scales');
  }
  assert.equal(calls.length, 0);
});

// The route view over dense synthetic tiles at the archetype's frame, at
// each scale alone, with no cap: the sizes the ladder chooses between.
function routeOverTiles() {
  const model = { ...load('route').model, frame: { ...FRAME } };
  const basemap = basemapFor(FRAME, { ox: -100, oy: -50, pngs: STREETS });
  const svg = map.renderSvg('route', model, { base: 'streets' });
  const layout = { ...layoutOf('route', FRAME), pixelated: true };
  const size = map.imageSize('route', FRAME);
  const free = createRasterizer({ maxBytes: 64 * 1024 * 1024 });
  const at = Object.fromEntries(ROUTE_SCALES.map((z) => [z, free.streets(svg, basemap, layout, size, { scales: [z] })]));
  return {
    model, basemap, svg, layout, size, at,
  };
}

test('Story 15.18: the route view rasterizes at 2x: the PNG is twice the frame\'s width and height, plain and over tiles; measured under the cap', (t) => {
  const r = routeOverTiles();
  for (const z of ROUTE_SCALES) t.diagnostic(`route over dense synthetic tiles (${r.basemap.tiles.length}), ${z}x: ${r.at[z].length} bytes (cap ${PNG_CAP})`);
  const png = map.renderPng('route', r.model, { basemap: r.basemap });
  assert.deepEqual(pngSize(png), { width: 2 * FRAME.width, height: 2 * FRAME.height });
  assert.ok(png.equals(r.at[2]), 'the 2x drawing');
  assert.ok(png.length <= PNG_CAP);
  const plain = map.renderPng('route', r.model);
  assert.deepEqual(pngSize(plain), { width: 2 * FRAME.width, height: 2 * FRAME.height });
  t.diagnostic(`route plain at 2x: ${plain.length} bytes`);
});

test('Story 15.18: a 2x PNG over the cap is re-drawn at 1.5x', () => {
  const r = routeOverTiles();
  const capped = createRasterizer({ maxBytes: r.at[2].length - 1 });
  const png = capped.streets(r.svg, r.basemap, r.layout, r.size, { scales: ROUTE_SCALES });
  assert.ok(png.equals(r.at[1.5]));
  assert.deepEqual(pngSize(png), { width: 1050, height: 840 });
});

test('Story 15.18: a 1.5x PNG over the cap is re-drawn at 1x', () => {
  const r = routeOverTiles();
  const capped = createRasterizer({ maxBytes: r.at[1.5].length - 1 });
  const png = capped.streets(r.svg, r.basemap, r.layout, r.size, { scales: ROUTE_SCALES });
  assert.ok(png.equals(r.at[1]));
  assert.deepEqual(pngSize(png), { width: FRAME.width, height: FRAME.height });
});

test('Story 15.18: a 1x PNG over the cap is image_too_large, and the plain map (what the archetype then draws) still fits', () => {
  const r = routeOverTiles();
  const capped = createRasterizer({ maxBytes: r.at[1].length - 1 });
  const e = faultOf(() => capped.streets(r.svg, r.basemap, r.layout, r.size, { scales: ROUTE_SCALES }));
  assert.deepEqual(e.details, { field: 'map image', problem: 'image_too_large' });
  const plain = capped(map.renderSvg('route', r.model), r.size, { scales: ROUTE_SCALES });
  assert.deepEqual(pngSize(plain), { width: 2 * FRAME.width, height: 2 * FRAME.height });
});

test('Story 15.18: pixelated tiles carry image-rendering="optimizeSpeed" and pass every compose check; Routing\'s views never ask for it', () => {
  const { model } = load('route');
  const basemap = basemapFor(model.frame);
  const svg = map.renderSvg('route', model, { base: 'streets' });
  const out = composeBasemap(svg, basemap, { ...layoutOf('route', model.frame), pixelated: true });
  const images = out.split('\n').filter((l) => l.startsWith('<image'));
  assert.equal(images.length, basemap.tiles.length);
  for (const l of images) assert.match(l, /^<image x="-?\d+" y="-?\d+" width="256" height="256" image-rendering="optimizeSpeed" href="data:image\/png;base64,/);
  assert.equal(composeBasemap(svg, basemap, layoutOf('route', model.frame)).includes('image-rendering'), false, 'not without it');
  assert.equal(faultOf(() => composeBasemap(svg, basemap, { ...layoutOf('route', model.frame), pixelated: 'yes' })).details.field, 'layout');
  for (const view of ['compare', 'change', 'zone', 'gap']) {
    const m = load(view).model;
    const size = map.imageSize(view, m.frame);
    const calls = [];
    const stub = createRasterizer({ load: () => stubModule(() => fakePng(size.width, size.height), calls) });
    stub.streets(map.renderSvg(view, m, { base: 'streets' }), basemapFor(m.frame), layoutOf(view, m.frame), size);
    assert.equal(calls[0].svg.includes('image-rendering'), false, view);
    assert.deepEqual(calls[0].opts, ORIGINAL, view);
  }
});
