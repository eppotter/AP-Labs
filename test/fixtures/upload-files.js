'use strict';

// Files for the Add context upload tests (Story 16.8), built in code so no
// binary sits in the repo. Each is the smallest file of its kind that the
// engine's checks and the fakes read the way they read a real one.
//
//   pdf({ pages, text, padTo, objectStream, count, encrypt })
//       a PDF whose page tree holds pages leaves (count: a /Count that lies;
//       objectStream: the catalog, page tree and pages packed in a
//       compressed object stream, as PDF 1.5 writers do; padTo: padded with
//       a stream to that many bytes; encrypt: an /Encrypt entry)
//   png({ width, height, text })   a PNG header (IHDR, a tEXt chunk with
//                                  text, IEND)
//   jpeg({ width, height }), gif({ width, height }), webp({ width, height })

const zlib = require('node:zlib');

function pdf({
  pages = 1, text = 'Brightside Home Cleaning: a standard clean costs $120.', padTo = 0, objectStream = false, count, encrypt = false,
} = {}) {
  const firstPage = 4;
  const content = 3;
  const kids = Array.from({ length: pages }, (_, i) => `${firstPage + i} 0 R`).join(' ');
  const dicts = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids [${kids}] /Count ${count === undefined ? pages : count} >>`],
  ]);
  for (let i = 0; i < pages; i += 1) dicts.set(firstPage + i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R >>`);
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`;
  const parts = ['%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'];
  parts.push(`${content} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  if (objectStream) {
    const nums = [...dicts.keys()];
    let offset = 0;
    const header = [];
    const bodies = [];
    for (const n of nums) {
      header.push(`${n} ${offset}`);
      const body = `${dicts.get(n)}\n`;
      bodies.push(body);
      offset += body.length;
    }
    const head = `${header.join(' ')}\n`;
    const packed = zlib.deflateSync(Buffer.from(head + bodies.join(''), 'latin1')).toString('latin1');
    const id = firstPage + pages;
    parts.push(`${id} 0 obj\n<< /Type /ObjStm /N ${nums.length} /First ${head.length} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n${packed}\nendstream\nendobj\n`);
  } else {
    for (const [n, d] of dicts) parts.push(`${n} 0 obj\n${d}\nendobj\n`);
  }
  const trailer = `trailer\n<< /Root 1 0 R${encrypt ? ' /Encrypt 99 0 R' : ''} >>\n%%EOF\n`;
  let out = Buffer.from(parts.join(''), 'latin1');
  if (padTo > out.length) {
    const room = padTo - out.length - trailer.length - 64;
    const pad = `999 0 obj\n<< /Length ${room} >>\nstream\n${'A'.repeat(Math.max(0, room))}\nendstream\nendobj\n`;
    out = Buffer.concat([out, Buffer.from(pad, 'latin1')]);
  }
  out = Buffer.concat([out, Buffer.from(trailer, 'latin1')]);
  if (padTo > out.length) out = Buffer.concat([out, Buffer.from(' '.repeat(padTo - out.length), 'latin1')]);
  return out;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png({ width = 800, height = 600, text = '' } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(text ? [chunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1'))] : []),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpeg({ width = 800, height = 600 } = {}) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function gif({ width = 800, height = 600 } = {}) {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'latin1');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return Buffer.concat([head, Buffer.from([0x3b])]);
}

function webp({ width = 800, height = 600 } = {}) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

module.exports = {
  pdf, png, jpeg, gif, webp,
};
