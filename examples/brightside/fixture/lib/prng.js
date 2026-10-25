'use strict';

// The fixture's only source of randomness: sfc32, seeded through splitmix32.
// Integer arithmetic only (Math.imul, >>> 0), so one seed gives the same
// sequence on every platform and Node version. Never Math.random, the clock or
// the OS: the seed files must be byte-identical for one seed (fixture-tables.md).

function splitmix32(state) {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function createRng(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError(`seed must be an integer from 0 to ${0xffffffff}, got ${seed}`);
  }
  const init = splitmix32(seed);
  let a = init();
  let b = init();
  let c = init();
  let d = init();

  // sfc32: one 32-bit unsigned integer per call.
  function u32() {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  }
  // Discard the first outputs so nearby seeds diverge.
  for (let i = 0; i < 12; i++) u32();

  const rng = {
    u32,
    // A float in [0, 1).
    next: () => u32() / 0x100000000,
    // An integer in [min, max], both inclusive.
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`bad int range [${min}, ${max}]`);
      }
      return min + Math.floor(rng.next() * (max - min + 1));
    },
    chance: (p) => rng.next() < p,
    pick(list) {
      if (list.length === 0) throw new RangeError('pick from an empty list');
      return list[rng.int(0, list.length - 1)];
    },
    // Pick from [[value, weight], ...] with integer weights.
    weighted(pairs) {
      const total = pairs.reduce((sum, [, w]) => sum + w, 0);
      let roll = rng.int(1, total);
      for (const [value, w] of pairs) {
        roll -= w;
        if (roll <= 0) return value;
      }
      throw new RangeError('weighted: no positive weights');
    },
  };
  return rng;
}

// A seed for a separate, named stream: FNV-1a over the label, mixed with the
// fixture seed through splitmix32. A new stream (createRng(deriveSeed(seed,
// 'label'))) draws nothing from the main one, so adding it leaves every
// earlier draw, and every earlier seed file, unchanged.
function deriveSeed(seed, label) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError(`seed must be an integer from 0 to ${0xffffffff}, got ${seed}`);
  }
  if (typeof label !== 'string' || label === '') throw new TypeError('label must be a non-empty string');
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return splitmix32((seed ^ h) >>> 0)();
}

module.exports = { createRng, deriveSeed };
