'use strict';

// Reading a file an admin uploaded through Add context (plan brightside-v0,
// D5, D7, Story 16.8). New outbound code, a T3 engine floor (kit/lib/tier
// ENGINE_T3): the one place the bot downloads from Slack.
//
//   const files = createSlackFiles({ token, log });   // app/index, at boot
//   const file = await files.fetchFile({ client, fileId, person });
//   // { name, ext, kind: 'pdf' | 'image' | 'text' | 'csv', mediaType, bytes }
//
// fetchFile, in order, each failure a FileRefused (kit/runtime/errors) and
// nothing kept:
//   1. files.info (needs files:read) through the Slack client. Slack's
//      file_not_found or file_deleted: not_found; any other failure:
//      info_failed (logged with Slack's error code only).
//   2. The owner: the file's user must be the person submitting (not_owner).
//   3. The type, by the name's extension (typeOf): PDF, PNG, JPEG, GIF, WebP,
//      .csv, .txt or .md. An office file (.xlsx among them) is docx ("save
//      it as a PDF first");
//      anything else is type. Slack's mimetype and filetype are never used.
//   4. The size Slack reports: at most MAX_FILE_BYTES (5 MB).
//   5. The download of url_private_download (download): the URL must be
//      https://files.slack.com (no user, no password, no other port), or no
//      request is made and no header leaves. The bot token goes in the
//      Authorization header, only to that host. redirect: 'error', so a
//      redirect is refused, never followed (review A7). The body is cut off
//      past 5 MB, whatever Content-Length says (size), and the whole download
//      has 20 seconds (download_failed). It fails closed (PR #274 review): a
//      status other than 2xx, a web page instead of the file (what Slack
//      answers a token it won't accept), a body whose length is not the size
//      files.info reported, or, for a .txt, .md or .csv file, a content type
//      other than text/* or application/octet-stream (an error body in JSON,
//      say) is download_failed.
//   6. The signature: a PDF or an image's first bytes must match the type its
//      name says (signature; kit/runtime/llm/file-check sniff). The file's
//      pages and pixels are checked by the AI service itself (readFile).
//   7. The name kept with the entry (fileName): at most MAX_NAME_CHARS (255,
//      the knowledge store's cap), a longer one shortened with its extension
//      kept (PR #274 review). Never sent to the AI and never logged.
// readText(bytes) reads a .txt or .md file: UTF-8 only (fatal decoding), no
// NUL byte (encoding).
// readCsv(bytes) reads a .csv file (plan brightside-v1, D3, Story 18.2) as
// text, never summarised and with no AI call: UTF-8 only, a leading BOM
// dropped, no NUL byte (encoding); RFC 4180 (fields split on commas; a
// quoted field may hold commas, line breaks and "" for a quote; a row ends
// with CRLF, LF or a lone CR; blank lines are skipped). A quote left open, or
// a quote out of place, is csv_quote. A header row, then 1 to MAX_CSV_ROWS
// (200) data rows (none: csv_no_rows), at most MAX_CSV_COLUMNS (30) columns,
// and every row with the header's column count (csv_ragged). It returns
// { text, rows, columns }: text is the table written back as CSV with LF
// line breaks (a field quoted only when it holds a comma, a quote or a line
// break), and must fit the knowledge store's file cap (6,000 characters,
// escaped as the store measures them). Over any cap: csv_too_big.
//
// The bot keeps no copy of the file and never deletes it: it stays in the
// admin's own Slack files (review B12, a DEP row). Logs carry a reason and
// Slack's error code, never the file's name, its URL or the token.

const { FileRefused } = require('../errors');
const { sniff, MAX_FILE_BYTES } = require('../llm/file-check');
const { promptChars, CAPS } = require('../knowledge/store');

const FILES_HOST = 'files.slack.com';
const DOWNLOAD_TIMEOUT_MS = 20 * 1000;
// The knowledge store's cap on a file name (MAX_FILE_NAME_CHARS there).
const MAX_NAME_CHARS = 255;
// What a text file may be served as (PR #274 review): anything else, an error
// body in JSON for one, is refused rather than stored as context.
const TEXT_CONTENT_TYPE = /^\s*(text\/[a-z0-9.+-]+|application\/octet-stream)\s*(;|$)/i;

// A file name of at most MAX_NAME_CHARS: a longer one keeps its extension and
// loses the end of its stem, cut on a whole character.
function fileName(name, ext) {
  const full = String(name);
  if (full.length <= MAX_NAME_CHARS) return full;
  const tail = `….${ext}`;
  let stem = '';
  for (const ch of Array.from(full.slice(0, full.length - ext.length - 1))) {
    if (stem.length + ch.length + tail.length > MAX_NAME_CHARS) break;
    stem += ch;
  }
  return `${stem}${tail}`;
}

// What each extension is read as. format: what its first bytes must be.
const READABLE = Object.freeze({
  pdf: Object.freeze({ kind: 'pdf', format: 'pdf', mediaType: 'application/pdf' }),
  png: Object.freeze({ kind: 'image', format: 'png', mediaType: 'image/png' }),
  jpg: Object.freeze({ kind: 'image', format: 'jpeg', mediaType: 'image/jpeg' }),
  jpeg: Object.freeze({ kind: 'image', format: 'jpeg', mediaType: 'image/jpeg' }),
  gif: Object.freeze({ kind: 'image', format: 'gif', mediaType: 'image/gif' }),
  webp: Object.freeze({ kind: 'image', format: 'webp', mediaType: 'image/webp' }),
  txt: Object.freeze({ kind: 'text', format: null, mediaType: 'text/plain' }),
  md: Object.freeze({ kind: 'text', format: null, mediaType: 'text/markdown' }),
  csv: Object.freeze({ kind: 'csv', format: null, mediaType: 'text/csv' }),
});
// The kinds downloaded as text (their content type checked, step 5).
const TEXT_KINDS = Object.freeze(['text', 'csv']);
// A CSV's caps (D3): data rows under the header, columns, and the store's cap
// on a file entry's escaped characters.
const MAX_CSV_ROWS = 200;
const MAX_CSV_COLUMNS = 30;
const MAX_CSV_CHARS = CAPS.file;
// The extensions the form's file_input offers (Slack's filetypes).
const FILETYPES = Object.freeze(Object.keys(READABLE));
// Office files: refused with "save it as a PDF first" (a DEP row).
const OFFICE = Object.freeze(['docx', 'doc', 'docm', 'dotx', 'odt', 'rtf', 'pages', 'xlsx', 'xls', 'ods', 'numbers', 'pptx', 'ppt', 'odp', 'key']);

const extOf = (name) => {
  const m = typeof name === 'string' ? /\.([A-Za-z0-9]{1,10})$/.exec(name.trim()) : null;
  return m ? m[1].toLowerCase() : null;
};

// The type a file name says, or a FileRefused (type or docx). Instant: the
// form's own check beside the field uses it too (D13).
function typeOf(name) {
  const ext = extOf(name);
  if (ext && Object.hasOwn(READABLE, ext)) return { ext, ...READABLE[ext] };
  return new FileRefused(ext && OFFICE.includes(ext) ? 'docx' : 'type');
}

// A Slack API error's code, or null.
const slackCode = (err) => (err && err.data && typeof err.data.error === 'string' ? err.data.error : null);

// Downloads url with the bot token (see the header, step 5). Returns a Buffer.
// expectedBytes: the size files.info reported (the body must be exactly
// that long), or null. text: a .txt, .md or .csv file, whose content type must be
// text/* or application/octet-stream.
async function download(url, {
  token, fetch = globalThis.fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_FILE_BYTES, log, expectedBytes = null, text = false,
}) {
  const refuse = (why, reason = 'download_failed', max = null) => {
    log.info('file download refused', { reason: why });
    return new FileRefused(reason, max);
  };
  let u;
  try {
    u = new URL(url);
  } catch {
    throw refuse('url');
  }
  if (u.protocol !== 'https:' || u.hostname !== FILES_HOST || u.username || u.password || u.port) throw refuse('host');
  const controller = new AbortController();
  let timedOut = false;
  // Tests may shorten the limit, never lengthen it.
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.min(timeoutMs, DOWNLOAD_TIMEOUT_MS));
  try {
    let res;
    try {
      res = await fetch(u.href, {
        method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: controller.signal,
      });
    } catch {
      throw refuse(timedOut ? 'timeout' : 'fetch');
    }
    if (!(res.status >= 200 && res.status <= 299)) {
      controller.abort();
      throw refuse(`status ${res.status}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (/^\s*text\/html/i.test(contentType)) {
      controller.abort();
      throw refuse('html');
    }
    if (text && !TEXT_CONTENT_TYPE.test(contentType)) {
      controller.abort();
      throw refuse('content type');
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort();
      throw refuse('too big', 'size', maxBytes);
    }
    const chunks = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        let step;
        try {
          step = await reader.read();
        } catch {
          throw refuse(timedOut ? 'timeout' : 'body');
        }
        if (step.done) break;
        total += step.value.length;
        if (total > maxBytes) {
          controller.abort();
          throw refuse('too big', 'size', maxBytes);
        }
        chunks.push(Buffer.from(step.value));
      }
    }
    if (expectedBytes !== null && total !== expectedBytes) throw refuse('length');
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

// A .txt or .md file's text: UTF-8 (a leading BOM dropped, TextDecoder's
// default), no NUL byte.
function readText(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FileRefused('encoding');
  }
  if (text.includes('\0')) throw new FileRefused('encoding');
  return text;
}

// The rows of a CSV's text (RFC 4180, see the header), each an array of
// fields. Stops with csv_too_big past the header and MAX_CSV_ROWS rows, so a
// 5 MB file is never all held as rows.
function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false; // inside a quoted field
  let closed = false; // just after a quoted field's closing quote
  let blank = true; // nothing on this line yet
  const endField = () => {
    row.push(field);
    field = '';
    closed = false;
  };
  const endRow = () => {
    if (blank) return;
    endField();
    rows.push(row);
    if (rows.length > MAX_CSV_ROWS + 1) throw new FileRefused('csv_too_big');
    row = [];
    blank = true;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else if (ch === '\r') {
        // A line break inside a quoted field is kept, as LF.
        field += '\n';
        if (text[i + 1] === '\n') i += 1;
      } else {
        field += ch;
      }
    } else if (ch === ',') {
      blank = false;
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
    } else if (closed || (ch === '"' && field)) {
      // Text after a closing quote, or a quote inside an unquoted field.
      throw new FileRefused('csv_quote');
    } else if (ch === '"') {
      blank = false;
      quoted = true;
    } else {
      blank = false;
      field += ch;
    }
  }
  if (quoted) throw new FileRefused('csv_quote');
  endRow();
  return rows;
}

// One field written back: quoted only when it holds a comma, a quote or a
// line break.
const csvField = (f) => (/[",\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f);

// A .csv file read as text (see the header). Returns { text, rows, columns }:
// rows counts the data rows, not the header.
function readCsv(bytes) {
  const rows = csvRows(readText(bytes));
  if (!rows.length) throw new FileRefused('empty');
  const columns = rows[0].length;
  if (columns > MAX_CSV_COLUMNS) throw new FileRefused('csv_too_big');
  if (rows.length === 1) throw new FileRefused('csv_no_rows');
  if (rows.some((r) => r.length !== columns)) throw new FileRefused('csv_ragged');
  const text = rows.map((r) => r.map(csvField).join(',')).join('\n');
  if (promptChars(text) > MAX_CSV_CHARS) throw new FileRefused('csv_too_big');
  return Object.freeze({ text, rows: rows.length - 1, columns });
}

// token: the bot token (only ever sent to files.slack.com). fetch: a test
// seam. timeoutMs: tests may shorten it.
function createSlackFiles({
  token, fetch = globalThis.fetch, log, timeoutMs = DOWNLOAD_TIMEOUT_MS,
}) {
  async function info(client, fileId) {
    if (!client || !client.files || typeof client.files.info !== 'function') throw new FileRefused('not_set_up');
    try {
      const res = await client.files.info({ file: fileId });
      if (!res || !res.file || typeof res.file !== 'object') throw new Error('no file in the answer');
      return res.file;
    } catch (err) {
      const code = slackCode(err);
      log.info('file refused', { reason: 'files.info', code: code || 'error' });
      throw new FileRefused(code === 'file_not_found' || code === 'file_deleted' ? 'not_found' : 'info_failed');
    }
  }

  // See the header. person: the submitting person's Slack id.
  async function fetchFile({ client, fileId, person }) {
    if (typeof token !== 'string' || !token) throw new FileRefused('not_set_up');
    if (typeof fileId !== 'string' || !/^F[A-Z0-9]{2,}$/.test(fileId)) throw new FileRefused('not_found');
    const file = await info(client, fileId);
    if (typeof person !== 'string' || file.user !== person) {
      log.info('file refused', { reason: 'not_owner' });
      throw new FileRefused('not_owner');
    }
    const type = typeOf(file.name);
    if (type instanceof FileRefused) throw type;
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new FileRefused('info_failed');
    if (file.size > MAX_FILE_BYTES) throw new FileRefused('size', MAX_FILE_BYTES);
    const bytes = await download(file.url_private_download, {
      token, fetch, timeoutMs, log, expectedBytes: file.size, text: TEXT_KINDS.includes(type.kind),
    });
    if (!bytes.length) throw new FileRefused('empty');
    if (type.format && sniff(bytes) !== type.format) {
      log.info('file refused', { reason: 'signature', ext: type.ext });
      throw new FileRefused('signature');
    }
    return Object.freeze({
      name: fileName(file.name, type.ext), ext: type.ext, kind: type.kind, mediaType: type.mediaType, bytes,
    });
  }

  return Object.freeze({ fetchFile });
}

module.exports = {
  createSlackFiles, download, readText, readCsv, typeOf, extOf, fileName, MAX_NAME_CHARS, FILETYPES, READABLE, OFFICE, FILES_HOST, DOWNLOAD_TIMEOUT_MS, MAX_FILE_BYTES,
  MAX_CSV_ROWS, MAX_CSV_COLUMNS, MAX_CSV_CHARS,
};
