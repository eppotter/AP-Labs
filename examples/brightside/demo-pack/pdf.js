'use strict';

// A small, text-only PDF writer for the v0 demo pack (plan brightside-v1, D4,
// Story 18.3). No dependency: it writes a PDF 1.4 file by hand with the two
// standard Helvetica fonts, one uncompressed content stream per page and a
// correct cross-reference table.
//
//   const bytes = writePdf({ title, pages: [[{ text, size?, bold? }, ...], ...] });
//
// Deterministic: no date, no id and no producer, so the same pages give the
// same bytes. Printable ASCII only (a line with anything else throws), so
// every reader extracts the text exactly as written. A line longer than
// MAX_LINE_CHARS throws instead of running off the page: write shorter lines.

const PAGE_WIDTH = 612; // US Letter, in points
const PAGE_HEIGHT = 792;
const MARGIN = 60;
const MAX_LINE_CHARS = 90;
const DEFAULT_SIZE = 11;

// A PDF literal string: backslash, ( and ) escaped.
const pdfString = (s) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

function checkLine(line) {
  if (!line || typeof line.text !== 'string') throw new TypeError('each line needs a text');
  if (!/^[\x20-\x7e]*$/.test(line.text)) throw new RangeError(`not printable ASCII: ${JSON.stringify(line.text)}`);
  if (line.text.length > MAX_LINE_CHARS) throw new RangeError(`line over ${MAX_LINE_CHARS} characters: ${line.text}`);
}

// One page's content stream: each line below the last, by its font size.
function pageContent(lines) {
  const out = ['BT'];
  let y = PAGE_HEIGHT - MARGIN;
  let first = true;
  for (const line of lines) {
    checkLine(line);
    const size = line.size || DEFAULT_SIZE;
    const lead = Math.round(size * 1.45);
    y -= first ? size : lead;
    if (y < MARGIN) throw new RangeError('the page is full: move lines to another page');
    first = false;
    if (!line.text) continue; // a blank line only moves down
    out.push(`/${line.bold ? 'F2' : 'F1'} ${size} Tf`);
    out.push(`1 0 0 1 ${MARGIN} ${y} Tm`);
    out.push(`${pdfString(line.text)} Tj`);
  }
  out.push('ET');
  return `${out.join('\n')}\n`;
}

function writePdf({ title, pages }) {
  if (!Array.isArray(pages) || !pages.length) throw new TypeError('a PDF needs at least one page');
  checkLine({ text: title });
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
  pages.forEach((lines, i) => {
    const content = pageContent(lines);
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

// The text a reader takes from the pages: each line on its own line, pages
// separated by a blank line. What the demo pack measures against the caps.
const pdfText = (pages) => pages.map((lines) => lines.map((l) => l.text).join('\n')).join('\n\n');

module.exports = { writePdf, pdfText, MAX_LINE_CHARS };
