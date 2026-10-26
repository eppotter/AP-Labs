'use strict';

// Stop and rank numbers as built-in digit paths (Story 15.3, AD-R14), so the
// map's SVG has no <text> element and needs no font. Each digit is a
// seven-segment figure, DIGIT_W wide and DIGIT_H tall, drawn as straight
// strokes on whole-pixel corners: the same number at the same place is always
// the same path text.
//
//    a          corners: TL (0,0)  TR (W,0)
//  f   b                 ML (0,H/2) MR (W,H/2)
//    g                   BL (0,H)  BR (W,H)
//  e   c
//    d

const DIGIT_W = 6;
const DIGIT_H = 10;
const DIGIT_GAP = 2;
const MAX_NUMBER = 99;

const HALF = DIGIT_H / 2;
const SEGMENTS = Object.freeze({
  a: [0, 0, DIGIT_W, 0],
  b: [DIGIT_W, 0, DIGIT_W, HALF],
  c: [DIGIT_W, HALF, DIGIT_W, DIGIT_H],
  d: [0, DIGIT_H, DIGIT_W, DIGIT_H],
  e: [0, HALF, 0, DIGIT_H],
  f: [0, 0, 0, HALF],
  g: [0, HALF, DIGIT_W, HALF],
});

const DIGITS = Object.freeze(['abcdef', null, 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg']);

// The path data for one digit with its top-left corner at (x, y). A 1 is one
// stroke down the middle of its box, so it does not lean right.
function digitPath(digit, x, y) {
  if (digit === 1) return `M${x + DIGIT_W / 2} ${y}L${x + DIGIT_W / 2} ${y + DIGIT_H}`;
  return [...DIGITS[digit]].map((s) => {
    const [x1, y1, x2, y2] = SEGMENTS[s];
    return `M${x + x1} ${y + y1}L${x + x2} ${y + y2}`;
  }).join('');
}

// The path data for a whole number 1..99 centred on (cx, cy), all integers.
// Callers check the range first; anything else here is a programming error.
function numberPath(n, cx, cy) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_NUMBER) throw new RangeError('numberPath takes a whole number from 1 to 99');
  const digits = String(n).split('').map(Number);
  const width = digits.length * DIGIT_W + (digits.length - 1) * DIGIT_GAP;
  const left = cx - Math.floor(width / 2);
  const top = cy - HALF;
  return digits.map((d, i) => digitPath(d, left + i * (DIGIT_W + DIGIT_GAP), top)).join('');
}

module.exports = { numberPath, DIGIT_W, DIGIT_H, MAX_NUMBER };
