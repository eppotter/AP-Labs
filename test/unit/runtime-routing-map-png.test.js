'use strict';

// Story 15.3 (AD-R14, F11): SVG to PNG through @resvg/resvg-js. Same SVG,
// same bytes on one machine (no cross-platform hash is pinned); the PNG has
// the frame's size; system fonts are off; over 1 MB is refused; the
// rasterizer is required lazily and a load failure is a fixed-text
// RoutingFault. The lockfile holds the Linux binary the Docker image needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const map = require('../../kit/runtime/routing-map');
const { rasterize: rasterizeSvg, createRasterizer, pngSize, MAX_PNG_BYTES } = require('../../kit/runtime/routing-map/png');
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

test('each fixture rasterizes twice to the same bytes, at the image size, under 1 MB', () => {
  for (const view of map.VIEWS) {
    const { model } = load(view);
    const a = map.renderPng(view, model);
    const b = map.renderPng(view, JSON.parse(JSON.stringify(model)));
    assert.ok(Buffer.isBuffer(a));
    assert.ok(a.equals(b), `${view}: identical bytes`);
    const size = map.imageSize(view, model.frame);
    assert.deepEqual(pngSize(a), size, view);
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

test('a PNG over 1 MB is refused with fixed words; exactly 1 MB is not', () => {
  const ok = createRasterizer({ load: () => stubModule(fakePng(300, 200, MAX_PNG_BYTES)) });
  assert.equal(ok(SVG, { width: 300, height: 200 }).length, MAX_PNG_BYTES);
  const big = createRasterizer({ load: () => stubModule(fakePng(300, 200, MAX_PNG_BYTES + 1)) });
  const e = faultOf(() => big(SVG, { width: 300, height: 200 }));
  assert.deepEqual(e.details, { field: 'map image', problem: 'image_too_large' });
  assert.equal(e.message, TOO_LARGE);
  assert.equal(MAX_PNG_BYTES, 1048576);
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
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/smoke-routing-map.js')], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const view of map.VIEWS) assert.match(r.stdout, new RegExp(`ok - ${view} \\d+x\\d+, \\d+ bytes`));
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
