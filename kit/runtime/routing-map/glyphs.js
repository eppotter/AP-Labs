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

// --- bold filled numerals (Story 15.18, AD-R29) -----------------------------------
//
// Plan a route's pins carry bold numbers drawn as filled shapes, not strokes:
// each digit is a few whole-pixel rectangles on a BOLD_W x BOLD_H box with
// BOLD_T thick bars, every rectangle wound the same way (clockwise), so the
// overlaps fill under the default nonzero rule. Still no <text> and no font.
//
//   bars (x, y, width, height), BOLD_T = 3:
//     a top (0,0,9,3)   g middle (0,6,9,3)   d bottom (0,12,9,3)
//     f upper left (0,0,3,9)   b upper right (6,0,3,9)
//     e lower left (0,6,3,9)   c lower right (6,6,3,9)
// A 1 is a centred bar with a short flag at its top left.

const BOLD_W = 9;
const BOLD_H = 15;
const BOLD_T = 3;
const BOLD_GAP = 2;
const BOLD_MID = (BOLD_H - BOLD_T) / 2;
const BARS = Object.freeze({
  a: [0, 0, BOLD_W, BOLD_T],
  b: [BOLD_W - BOLD_T, 0, BOLD_T, BOLD_MID + BOLD_T],
  c: [BOLD_W - BOLD_T, BOLD_MID, BOLD_T, BOLD_H - BOLD_MID],
  d: [0, BOLD_H - BOLD_T, BOLD_W, BOLD_T],
  e: [0, BOLD_MID, BOLD_T, BOLD_H - BOLD_MID],
  f: [0, 0, BOLD_T, BOLD_MID + BOLD_T],
  g: [0, BOLD_MID, BOLD_W, BOLD_T],
});
const ONE = Object.freeze([[BOLD_T, 0, BOLD_T, BOLD_H], [1, 1, BOLD_T - 1, BOLD_T]]);

const box = ([x, y, w, h], left, top) => `M${left + x} ${top + y}H${left + x + w}V${top + y + h}H${left + x}Z`;

function boldDigitPath(digit, left, top) {
  const bars = digit === 1 ? ONE : [...DIGITS[digit]].map((s) => BARS[s]);
  return bars.map((b) => box(b, left, top)).join('');
}

// The filled path data for a whole number 1..99 centred on (cx, cy), all
// integers; the same contract as numberPath.
function boldNumberPath(n, cx, cy) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_NUMBER) throw new RangeError('boldNumberPath takes a whole number from 1 to 99');
  const digits = String(n).split('').map(Number);
  const width = digits.length * BOLD_W + (digits.length - 1) * BOLD_GAP;
  const left = cx - Math.floor(width / 2);
  const top = cy - Math.floor(BOLD_H / 2);
  return digits.map((d, i) => boldDigitPath(d, left + i * (BOLD_W + BOLD_GAP), top)).join('');
}

module.exports = {
  numberPath, boldNumberPath, DIGIT_W, DIGIT_H, BOLD_W, BOLD_H, MAX_NUMBER,
};
