'use strict';

// A small, text-only PDF writer for the v0 demo pack (plan brightside-v1, D4,
// Stories 18.3 and the demo pack rebuild). No dependency: it writes a PDF 1.4
// file by hand with the two standard Helvetica fonts, one uncompressed
// content stream per page and a correct cross-reference table.
//
//   const bytes = writePdf({ title, pages: [[item, ...], ...], footer? });
//   const pages = paginate([[item, ...], ...]);  blocks flowed onto pages
//
// A page is a list of items, each placed below the last:
//   { text, size?, bold?, x? }        one line, x points in from the margin
//   { cells: [{ text, x, right?, bold? }], size?, bold? }
//                                     a table row: several texts on one
//                                     baseline. A right-aligned cell ends at
//                                     x and may hold only digits, $ , . % + -
//                                     and spaces (their widths are fixed).
//   { rule: true, size? }             a ruled line across the text width
//   { text: '' }                      a blank line
// footer(i, n) → string: a line at the bottom of page i (0-based) of n.
//
// Deterministic: no date, no id and no producer, so the same pages give the
// same bytes. Printable ASCII only (anything else throws), so every reader
// extracts the text exactly as written. A line longer than MAX_LINE_CHARS, or
// a page too full, throws instead of running off the page.
//
// pdfExtract(bytes) reads the text back out of a file this writes: each
// baseline's texts left to right, joined by " | ", one line per baseline,
// pages separated by a blank line. The demo pack measures it against the
// hub's caps.

const PAGE_WIDTH = 612; // US Letter, in points
const PAGE_HEIGHT = 792;
const MARGIN = 60;
const TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const FOOTER_Y = 36;
const MAX_LINE_CHARS = 90;
const DEFAULT_SIZE = 11;
const CELL_JOIN = ' | ';

// Helvetica and Helvetica-Bold widths (per 1,000 em) of the characters a
// right-aligned cell may hold: the same in both fonts.
const NUMERIC_WIDTHS = Object.freeze({
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
  $: 556, ',': 278, '.': 278, '%': 889, '+': 584, '-': 333, ' ': 278,
});

// A PDF literal string: backslash, ( and ) escaped.
const pdfString = (s) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

function checkText(text) {
  if (typeof text !== 'string') throw new TypeError('each line needs a text');
  if (!/^[\x20-\x7e]*$/.test(text)) throw new RangeError(`not printable ASCII: ${JSON.stringify(text)}`);
  if (text.length > MAX_LINE_CHARS) throw new RangeError(`line over ${MAX_LINE_CHARS} characters: ${text}`);
}

function numericWidth(text, size) {
  let w = 0;
  for (const ch of text) {
    if (!(ch in NUMERIC_WIDTHS)) throw new RangeError(`a right-aligned cell holds only figures: ${JSON.stringify(text)}`);
    w += NUMERIC_WIDTHS[ch];
  }
  return (w * size) / 1000;
}

// 2 decimals at most, no trailing zeros: positions stay byte-stable.
const num = (n) => String(Math.round(n * 100) / 100);

function showText(out, { text, x, y, size, bold }) {
  out.push('BT', `/${bold ? 'F2' : 'F1'} ${size} Tf`, `1 0 0 1 ${num(x)} ${num(y)} Tm`, `${pdfString(text)} Tj`, 'ET');
}

// One page's content stream: each item below the last, by its font size.
function pageContent(items, footerText) {
  const out = [];
  let y = PAGE_HEIGHT - MARGIN;
  let first = true;
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new TypeError('each item is an object');
    const size = item.size || DEFAULT_SIZE;
    if (item.rule) {
      y -= first ? 2 : Math.round(size * 0.6);
      if (y < MARGIN) throw new RangeError('the page is full: move items to another page');
      out.push('0.5 w', `${MARGIN} ${num(y)} m ${MARGIN + TEXT_WIDTH} ${num(y)} l S`);
      first = false;
      continue;
    }
    y -= first ? size : Math.round(size * 1.45);
    if (y < MARGIN) throw new RangeError('the page is full: move items to another page');
    first = false;
    if (item.cells) {
      if (!Array.isArray(item.cells) || !item.cells.length) throw new TypeError('a row needs cells');
      for (const cell of item.cells) {
        checkText(cell.text);
        if (typeof cell.x !== 'number' || cell.x < 0 || cell.x > TEXT_WIDTH) throw new RangeError(`a cell's x is 0 to ${TEXT_WIDTH}`);
        if (!cell.text) continue;
        const x = MARGIN + (cell.right ? cell.x - numericWidth(cell.text, size) : cell.x);
        showText(out, {
          text: cell.text, x, y, size, bold: cell.bold ?? item.bold,
        });
      }
      continue;
    }
    checkText(item.text);
    if (!item.text) continue; // a blank line only moves down
    showText(out, {
      text: item.text, x: MARGIN + (item.x || 0), y, size, bold: item.bold,
    });
  }
  if (footerText) {
    checkText(footerText);
    showText(out, {
      text: footerText, x: MARGIN, y: FOOTER_Y, size: 8, bold: false,
    });
  }
  return `${out.join('\n')}\n`;
}

function writePdf({ title, pages, footer }) {
  if (!Array.isArray(pages) || !pages.length) throw new TypeError('a PDF needs at least one page');
  checkText(title);
  // Objects: 1 catalog, 2 page tree, 3 and 4 fonts, 5 info, then per page
  // its page object and its content stream.
  const pageIds = pages.map((_, i) => 6 + 2 * i);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title ${pdfString(title)} >>`,
  ];
  pages.forEach((items, i) => {
    const content = pageContent(items, footer ? footer(i, pages.length) : '');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  });
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// The height an item takes below the one before it (the first on a page
// takes less), as pageContent places it.
const stepOf = (item, first) => {
  const size = item.size || DEFAULT_SIZE;
  if (item.rule) return first ? 2 : Math.round(size * 0.6);
  return first ? size : Math.round(size * 1.45);
};

// Flows blocks (each a list of items kept together on one page) onto pages:
// a block that does not fit what is left of a page starts the next one, and
// blank lines at the top of a page are dropped. A block taller than a whole
// page throws.
function paginate(blocks) {
  const room = PAGE_HEIGHT - 2 * MARGIN;
  const pages = [[]];
  let used = 0;
  for (const block of blocks) {
    let items = block;
    let height = items.reduce((h, it, i) => h + stepOf(it, used === 0 && i === 0), 0);
    if (used + height > room && pages.at(-1).length) {
      pages.push([]);
      used = 0;
      items = block.slice(block.findIndex((it) => it.rule || it.cells || it.text));
      height = items.reduce((h, it, i) => h + stepOf(it, i === 0), 0);
    }
    if (height > room) throw new RangeError('a block is taller than a page: split it');
    pages.at(-1).push(...items);
    used += height;
  }
  return pages;
}

// The text of a PDF writePdf made, read from its bytes (see the header).
// Reads its own output only: uncompressed streams of BT/Tf/Tm/Tj/ET.
function pdfExtract(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const pages = [];
  const streamRe = /stream\n([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    const texts = [];
    const textRe = /1 0 0 1 ([\d.]+) ([\d.]+) Tm\n\(((?:\\.|[^\\)])*)\) Tj/g;
    let t;
    while ((t = textRe.exec(m[1]))) {
      texts.push({ x: Number(t[1]), y: Number(t[2]), text: t[3].replace(/\\(.)/g, '$1') });
    }
    const lines = new Map();
    for (const tx of texts) {
      if (!lines.has(tx.y)) lines.set(tx.y, []);
      lines.get(tx.y).push(tx);
    }
    pages.push([...lines.entries()].sort((a, b) => b[0] - a[0])
      .map(([, row]) => row.sort((a, b) => a.x - b.x).map((r) => r.text).join(CELL_JOIN))
      .join('\n'));
  }
  return pages.join('\n\n');
}

module.exports = {
  writePdf, pdfExtract, paginate, MAX_LINE_CHARS, TEXT_WIDTH, CELL_JOIN,
};
