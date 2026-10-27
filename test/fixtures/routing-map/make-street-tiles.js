'use strict';

// Draws the synthetic street tiles test/fixtures/routing-map/tiles/streets-*.png
// (Story 15.10, AD-R21): 256 x 256 PNGs as busy as a dense city tile, made
// to measure the composed map's PNG size (MAX_PNG_BYTES) and for the smoke
// script. They are drawn here from a seeded random walk, not taken from any
// map: land, parks, water, building blocks, roads with casings in a street
// map's colours, and short dark strokes standing in for labels (the busiest
// part of a real tile). Not OpenStreetMap imagery.
//
//   node test/fixtures/routing-map/make-street-tiles.js   writes the four files
//
// The committed files are what tests read; this script only says how they
// were made (resvg's output is not promised byte-identical across machines).

const fs = require('node:fs');
const path = require('node:path');

const SIZE = 256;
const COLORS = Object.freeze({
  land: '#F2EFE9',
  residential: '#E0DFDF',
  park: '#CDEBB0',
  water: '#AAD3DF',
  building: '#D9D0C9',
  buildingEdge: '#C4B6AB',
  casing: '#BBBBBB',
  minor: '#FFFFFF',
  primary: '#FCD6A4',
  motorway: '#E892A2',
  label: '#333333',
  rail: '#707070',
});

// A small seeded generator (mulberry32), so the same seed draws the same tile.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tileSvg(seed) {
  const r = random(seed);
  const n = (lo, hi) => Math.floor(lo + r() * (hi - lo));
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`];
  out.push(`<rect width="${SIZE}" height="${SIZE}" fill="${COLORS.land}"/>`);
  for (let i = 0; i < 6; i += 1) {
    out.push(`<rect x="${n(-40, 220)}" y="${n(-40, 220)}" width="${n(40, 140)}" height="${n(40, 140)}" fill="${COLORS.residential}"/>`);
  }
  for (let i = 0; i < 2; i += 1) {
    const pts = Array.from({ length: 6 }, () => `${n(0, SIZE)},${n(0, SIZE)}`).join(' ');
    out.push(`<polygon points="${pts}" fill="${COLORS.park}"/>`);
  }
  const wy = n(20, 230);
  out.push(`<path d="M-10 ${wy} C 80 ${wy + n(-60, 60)}, 170 ${wy + n(-60, 60)}, 270 ${wy + n(-30, 30)}" stroke="${COLORS.water}" stroke-width="${n(10, 26)}" fill="none"/>`);
  for (let i = 0; i < 140; i += 1) {
    const rot = n(-30, 30);
    out.push(`<rect x="${n(0, SIZE)}" y="${n(0, SIZE)}" width="${n(4, 18)}" height="${n(4, 16)}" transform="rotate(${rot})" fill="${COLORS.building}" stroke="${COLORS.buildingEdge}" stroke-width="0.7"/>`);
  }
  const road = (color, width, count) => {
    for (let i = 0; i < count; i += 1) {
      const a = [n(-20, 276), n(-20, 276)];
      const b = [n(-20, 276), n(-20, 276)];
      const c = [n(0, SIZE), n(0, SIZE)];
      const d = `M${a[0]} ${a[1]} Q${c[0]} ${c[1]} ${b[0]} ${b[1]}`;
      out.push(`<path d="${d}" stroke="${COLORS.casing}" stroke-width="${width + 2}" fill="none" stroke-linecap="round"/>`);
      out.push(`<path d="${d}" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round"/>`);
    }
  };
  road(COLORS.minor, 3, 22);
  road(COLORS.primary, 6, 4);
  road(COLORS.motorway, 8, 1);
  out.push(`<path d="M${n(0, SIZE)} -5 L${n(0, SIZE)} 261" stroke="${COLORS.rail}" stroke-width="1.5" stroke-dasharray="6 3" fill="none"/>`);
  // Labels: short dark strokes in rows, the way a street name's letters sit.
  for (let i = 0; i < 30; i += 1) {
    let x = n(0, 230);
    const y = n(8, 250);
    const letters = n(4, 12);
    for (let k = 0; k < letters; k += 1) {
      const h = n(5, 9);
      out.push(`<path d="M${x} ${y} l${n(-2, 3)} ${-h} l${n(1, 4)} ${n(0, h)}" stroke="${COLORS.label}" stroke-width="1" fill="none"/>`);
      x += n(4, 7);
    }
  }
  out.push('</svg>');
  return out.join('\n');
}

function drawTile(seed, Resvg) {
  const opts = { fitTo: { mode: 'original' }, font: { loadSystemFonts: false }, logLevel: 'off' };
  return Buffer.from(new Resvg(tileSvg(seed), opts).render().asPng());
}

const SEEDS = Object.freeze({ a: 11, b: 23, c: 37, d: 53 });

if (require.main === module) {
  const { Resvg } = require(['@resvg', 'resvg-js'].join('/'));
  for (const [name, seed] of Object.entries(SEEDS)) {
    const file = path.join(__dirname, 'tiles', `streets-${name}.png`);
    const png = drawTile(seed, Resvg);
    fs.writeFileSync(file, png);
    console.log(`${path.basename(file)} ${png.length} bytes`);
  }
}

module.exports = { tileSvg, SEEDS };
