'use strict';

// What a file must be before the AI reads it (plan brightside-v0, D5, Story
// 16.8). No new dependency: the checks read the file's own bytes.
//
//   sniff(bytes)            'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | null,
//                           from the first bytes only (the name and Slack's
//                           mimetype are never trusted)
//   pdfPageCount(bytes)     the page count, or null when it can't be read
//   imageSize(bytes, kind)  { width, height }, or null
//   checkFileBlock(file)    throws FileRefused unless the file is one the AI
//                           may be sent: { kind: 'pdf' | 'image', mediaType,
//                           data (a Buffer) }. Returns { kind, mediaType,
//                           pages }. Used by kit/runtime/llm readFile, on its
//                           own, whatever the caller checked before.
//
// The PDF page count reads the page tree: the catalog's /Pages object and its
// /Count, and every object whose /Type is /Page, in the file's plain objects
// and in its compressed object streams (inflated with node:zlib, each capped,
// so a small file can't inflate without bound). The count is the larger of
// /Count and the leaf pages found, so a file that lies in /Count is counted
// high, never low. No catalog, no /Count, an encrypted file (/Encrypt) or a
// count under 1: null, and the file is refused.
//
// Limits (each checked against the Claude API reference, 2026-10-30):
//   - MAX_FILE_BYTES 5 MB, our own cap (D5). A 5 MB file is about 6.7 MB as
//     base64, under the API's 10 MB per image (base64) and 128 MB per
//     request (platform.claude.com/docs/en/build-with-claude/vision, "Image
//     limits"; .../api/overview, "Request size limits").
//   - MAX_IMAGE_PIXELS 8,000: the API refuses an image wider or taller
//     (vision, "Request limits").
//   - MAX_PDF_PAGES: our cap, below the API's 600 pages (100 under a 1M
//     context window; .../build-with-claude/pdf-support). Set so a PDF at the
//     cap prices at no more than half the default hourly limit (D5, review
//     B2, A6): see kit/runtime/llm readFileWorstCase. The plan's 100 pages
//     priced at about $1.60 with the API's current per-page image cost, so
//     the cap went down to 60.

const zlib = require('node:zlib');
const { FileRefused } = require('../errors');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PAGES = 60;
const MAX_IMAGE_PIXELS = 8000;
const IMAGE_MEDIA_TYPES = Object.freeze({
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
});
const PDF_MEDIA_TYPE = 'application/pdf';
// Object streams: at most this many inflated, each to at most this many bytes.
const MAX_OBJECT_STREAMS = 2000;
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_INFLATED_TOTAL = 64 * 1024 * 1024;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniff(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const head6 = bytes.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// --- PDF ------------------------------------------------------------------------------------

// Bounded runs, so a long run of digits or spaces can't make a match backtrack far.
const OBJ_HEAD = /(?<![0-9])(\d{1,10})[ \t\r\n\f\0]{1,16}\d{1,5}[ \t\r\n\f\0]{1,16}obj\b/g;
const OBJ_END = /\bendobj\b/g;
const PAGE_LEAF = /\/Type\s*\/Page(?![A-Za-z0-9])/;

// The stream bytes of an object body (latin1), or null.
function streamOf(body) {
  const start = body.search(/\bstream\r?\n/);
  if (start < 0) return null;
  const from = body.indexOf('\n', start) + 1;
  const end = body.lastIndexOf('endstream');
  if (end < from) return null;
  return Buffer.from(body.slice(from, end).replace(/\r?\n$/, ''), 'latin1');
}

// The objects packed in an object stream (PDF 1.5), added to objects.
function unpackObjectStream(body, objects, budget) {
  if (!/\/Filter\s*\/FlateDecode/.test(body) || /\/DecodeParms/.test(body)) return;
  const n = Number((body.match(/\/N\s+(\d+)/) || [])[1]);
  const first = Number((body.match(/\/First\s+(\d+)/) || [])[1]);
  const raw = streamOf(body);
  if (!raw || !Number.isSafeInteger(n) || !Number.isSafeInteger(first)) return;
  let data;
  try {
    data = zlib.inflateSync(raw, { maxOutputLength: Math.min(MAX_INFLATED_BYTES, budget.left) });
  } catch {
    return;
  }
  budget.left -= data.length;
  const text = data.toString('latin1');
  const nums = text.slice(0, first).trim().split(/\s+/).map(Number);
  if (nums.length < 2 * n) return;
  for (let i = 0; i < n; i += 1) {
    const num = nums[2 * i];
    const at = first + nums[2 * i + 1];
    const next = i + 1 < n ? first + nums[2 * i + 3] : text.length;
    if (!Number.isSafeInteger(num) || !(at >= first) || !(next >= at)) return;
    if (!objects.has(num)) objects.set(num, text.slice(at, next));
  }
}

function pdfPageCount(bytes) {
  if (sniff(bytes) !== 'pdf') return null;
  const text = bytes.toString('latin1');
  if (/\/Encrypt\b/.test(text)) return null;
  const objects = new Map();
  const streams = [];
  // Each object's body runs from its header to the next endobj. Found in
  // one pass over each list, so a crafted file can't make this quadratic.
  const ends = [...text.matchAll(OBJ_END)].map((m) => m.index);
  let e = 0;
  for (const m of text.matchAll(OBJ_HEAD)) {
    const from = m.index + m[0].length;
    while (e < ends.length && ends[e] < from) e += 1;
    if (e >= ends.length) break;
    const body = text.slice(from, ends[e]);
    objects.set(Number(m[1]), body);
    if (/\/Type\s*\/ObjStm\b/.test(body.slice(0, 2000))) streams.push(body);
  }
  const budget = { left: MAX_INFLATED_TOTAL };
  for (const body of streams.slice(0, MAX_OBJECT_STREAMS)) {
    if (budget.left <= 0) break;
    unpackObjectStream(body, objects, budget);
  }
  let count = null;
  let leaves = 0;
  for (const body of objects.values()) {
    const dict = body.split(/\bstream\r?\n/)[0];
    if (PAGE_LEAF.test(dict)) leaves += 1;
    if (!/\/Type\s*\/Catalog\b/.test(dict)) continue;
    const ref = dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
    const root = ref && objects.get(Number(ref[1]));
    const c = root && /\/Type\s*\/Pages\b/.test(root) && root.match(/\/Count\s+(\d+)/);
    if (c) count = Math.max(count || 0, Number(c[1]));
  }
  if (count === null) return null;
  const pages = Math.max(count, leaves);
  return Number.isSafeInteger(pages) && pages >= 1 ? pages : null;
}

// --- Images ---------------------------------------------------------------------------------

function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) {
      i += 1;
      m = b[i + 1];
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m === 0xda || m === 0xd9) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const chunk = b.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const [b0, b1, b2, b3] = [b[21], b[22], b[23], b[24]];
    return { width: 1 + (b0 | ((b1 & 0x3f) << 8)), height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) };
  }
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  return null;
}

function imageSize(bytes, kind) {
  if (!Buffer.isBuffer(bytes) || sniff(bytes) !== kind) return null;
  let size = null;
  if (kind === 'png') {
    if (bytes.length >= 24 && bytes.subarray(12, 16).toString('latin1') === 'IHDR') size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (kind === 'gif') {
    size = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  } else if (kind === 'jpeg') {
    size = jpegSize(bytes);
  } else if (kind === 'webp') {
    size = webpSize(bytes);
  }
  return size && size.width > 0 && size.height > 0 ? size : null;
}

// --- The block the AI is sent ---------------------------------------------------------------

// Throws FileRefused unless file may be sent to the AI. Checked on its own
// (review B7): type, size, signature, pages or pixels.
function checkFileBlock(file) {
  if (!file || typeof file !== 'object' || !Buffer.isBuffer(file.data)) throw new TypeError('readFile() needs file: { kind, mediaType, data: Buffer }');
  const { kind, mediaType, data } = file;
  if (kind !== 'pdf' && kind !== 'image') throw new FileRefused('type');
  if (!data.length) throw new FileRefused('empty');
  if (data.length > MAX_FILE_BYTES) throw new FileRefused('size', MAX_FILE_BYTES);
  const found = sniff(data);
  if (kind === 'pdf') {
    if (mediaType !== PDF_MEDIA_TYPE || found !== 'pdf') throw new FileRefused('signature');
    const pages = pdfPageCount(data);
    if (pages === null) throw new FileRefused('pages_unreadable');
    if (pages > MAX_PDF_PAGES) throw new FileRefused('pages', MAX_PDF_PAGES);
    return { kind, mediaType, pages };
  }
  if (!found || found === 'pdf' || IMAGE_MEDIA_TYPES[found] !== mediaType) throw new FileRefused('signature');
  const size = imageSize(data, found);
  if (!size) throw new FileRefused('signature');
  if (size.width > MAX_IMAGE_PIXELS || size.height > MAX_IMAGE_PIXELS) throw new FileRefused('pixels', MAX_IMAGE_PIXELS);
  return { kind, mediaType, pages: 0 };
}

module.exports = {
  sniff, pdfPageCount, imageSize, checkFileBlock, MAX_FILE_BYTES, MAX_PDF_PAGES, MAX_IMAGE_PIXELS, IMAGE_MEDIA_TYPES, PDF_MEDIA_TYPE,
};
