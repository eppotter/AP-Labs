'use strict';

// Story 16.8 (plan brightside-v0, D5, D7, review A7, B12): reading an uploaded
// file from Slack (kit/runtime/slack/files). files.info, the owner, size and
// type checks, then the download, against the fake Slack app (its files.info
// and its file server, which refuse and answer as Slack does). No test calls
// Slack: every request goes to the fake's fetch, which records it.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSlackFiles, download, readText, readCsv, typeOf, fileName, FILETYPES, FILES_HOST, DOWNLOAD_TIMEOUT_MS, MAX_FILE_BYTES, MAX_NAME_CHARS,
  MAX_CSV_ROWS, MAX_CSV_COLUMNS, MAX_CSV_CHARS,
} = require('../../kit/runtime/slack/files');
const { promptChars } = require('../../kit/runtime/knowledge/store');
const { FileRefused } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');
const { FakeSlackApp, invalidElements } = require('../fixtures/fake-slack');
const {
  pdf, png, jpeg, gif, webp,
} = require('../fixtures/upload-files');

const ADA = 'UADA';
const MARCUS = 'UMARCUS';

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return {
    lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'),
  };
}

function setup({ timeoutMs } = {}) {
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  const files = createSlackFiles({
    token: app.botToken, fetch: app.fetch, log, ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { app, log, files };
}

const refusedAs = (reason) => (err) => err instanceof FileRefused && err.reason === reason;
const fetchFile = (files, app, fileId, person = ADA) => files.fetchFile({ client: app.client, fileId, person });

test('a PDF Ada uploaded: files.info, then the download with the bot token to files.slack.com only; the bytes come back', async () => {
  const { app, files, log } = setup();
  const bytes = pdf({ pages: 2 });
  app.addSlackFile({
    id: 'F0PRICES', name: 'Prices 2026.pdf', user: ADA, mimetype: 'application/pdf', bytes,
  });
  const got = await fetchFile(files, app, 'F0PRICES');
  assert.deepEqual([got.kind, got.ext, got.mediaType, got.name], ['pdf', 'pdf', 'application/pdf', 'Prices 2026.pdf']);
  assert.ok(got.bytes.equals(bytes));
  assert.equal(app.fetches.length, 1);
  const [req] = app.fetches;
  assert.equal(new URL(req.url).hostname, FILES_HOST);
  assert.equal(req.headers.Authorization, `Bearer ${app.botToken}`);
  assert.equal(req.redirect, 'error');
  // Nothing about the file or the token is logged.
  assert.ok(!JSON.stringify(log.lines).includes('Prices'));
  assert.ok(!JSON.stringify(log.lines).includes(app.botToken));
});

test('each type is read by its name: PDF, PNG, JPG/JPEG, GIF, WebP, .txt, .md and .csv; the filetypes offered are exactly these', async () => {
  assert.deepEqual(FILETYPES, ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'md', 'csv']);
  const { app, files } = setup();
  const cases = [
    ['a.png', png(), 'image', 'image/png'], ['b.JPG', jpeg(), 'image', 'image/jpeg'], ['c.jpeg', jpeg(), 'image', 'image/jpeg'],
    ['d.gif', gif(), 'image', 'image/gif'], ['e.webp', webp(), 'image', 'image/webp'], ['f.txt', Buffer.from('hello'), 'text', 'text/plain'],
    ['g.md', Buffer.from('# hi'), 'text', 'text/markdown'], ['h.CSV', Buffer.from('a,b\n1,2\n'), 'csv', 'text/csv'],
  ];
  for (const [i, [name, bytes, kind, mediaType]] of cases.entries()) {
    app.addSlackFile({
      id: `F0T${i}`, name, user: ADA, bytes,
    });
    const got = await fetchFile(files, app, `F0T${i}`);
    assert.deepEqual([got.kind, got.mediaType], [kind, mediaType], name);
  }
});

test('typeOf: an office file is "save it as a PDF first"; any other unknown extension, or none, is a refused type', () => {
  for (const name of ['notes.docx', 'old.DOC', 'sheet.xlsx', 'deck.pptx']) assert.equal(typeOf(name).reason, 'docx', name);
  for (const name of ['run.exe', 'archive.zip', 'noext', 'page.html', '']) assert.equal(typeOf(name).reason, 'type', name);
  assert.match(messageFor(new FileRefused('docx')), /Save it as a PDF first/);
  // Story 18.2: .xlsx stays refused, and the words point a sheet to .csv.
  assert.match(messageFor(new FileRefused('docx')), /For a sheet, you can save it as a \.csv instead\./);
  assert.match(messageFor(new FileRefused('type')), /\.csv files/);
});

test('a file owned by someone else is refused before any download', async () => {
  const { app, files } = setup();
  app.addSlackFile({
    id: 'F0MARCUS', name: 'his.pdf', user: MARCUS, bytes: pdf(),
  });
  await assert.rejects(fetchFile(files, app, 'F0MARCUS', ADA), refusedAs('not_owner'));
  assert.deepEqual(app.fetches, []);
});

test('Slack\'s size over 5 MB is refused before any download; a .docx is refused by its name before any download', async () => {
  const { app, files } = setup();
  app.addSlackFile({
    id: 'F0BIG', name: 'big.pdf', user: ADA, bytes: pdf(), size: MAX_FILE_BYTES + 1,
  });
  await assert.rejects(fetchFile(files, app, 'F0BIG'), (err) => refusedAs('size')(err) && err.details.max === MAX_FILE_BYTES);
  app.addSlackFile({
    id: 'F0DOCX', name: 'notes.docx', user: ADA, bytes: Buffer.from('PK\x03\x04'),
  });
  await assert.rejects(fetchFile(files, app, 'F0DOCX'), refusedAs('docx'));
  assert.deepEqual(app.fetches, []);
});

test('signatures: a PNG renamed .pdf, and a PDF named .png with an image mimetype, are refused; Slack\'s mimetype is never trusted', async () => {
  const { app, files } = setup();
  app.addSlackFile({
    id: 'F0FAKEPDF', name: 'contract.pdf', user: ADA, mimetype: 'application/pdf', bytes: png(),
  });
  await assert.rejects(fetchFile(files, app, 'F0FAKEPDF'), refusedAs('signature'));
  app.addSlackFile({
    id: 'F0FAKEPNG', name: 'scan.png', user: ADA, mimetype: 'image/png', bytes: pdf(),
  });
  await assert.rejects(fetchFile(files, app, 'F0FAKEPNG'), refusedAs('signature'));
  // A real PDF whose Slack mimetype says image: read as the PDF its bytes are.
  app.addSlackFile({
    id: 'F0REALPDF', name: 'doc.pdf', user: ADA, mimetype: 'image/png', bytes: pdf(),
  });
  assert.equal((await fetchFile(files, app, 'F0REALPDF')).mediaType, 'application/pdf');
  // A JPEG named .png: its bytes are not a PNG.
  app.addSlackFile({
    id: 'F0JPGPNG', name: 'photo.png', user: ADA, bytes: jpeg(),
  });
  await assert.rejects(fetchFile(files, app, 'F0JPGPNG'), refusedAs('signature'));
});

test('files.info failing: file_not_found and file_deleted are "gone"; anything else, or a missing files:read scope, is info_failed', async () => {
  const { app, files, log } = setup();
  await assert.rejects(fetchFile(files, app, 'F0NOPE'), refusedAs('not_found'));
  app.addSlackFile({
    id: 'F0GONE', name: 'a.pdf', user: ADA, bytes: pdf(),
  });
  await app.client.files.delete({ file: 'F0GONE' });
  await assert.rejects(fetchFile(files, app, 'F0GONE'), refusedAs('not_found'));
  app.addSlackFile({
    id: 'F0OK', name: 'b.pdf', user: ADA, bytes: pdf(),
  });
  app.filesInfoFail = Object.assign(new Error('An API error occurred: ratelimited'), { data: { ok: false, error: 'ratelimited' } });
  await assert.rejects(fetchFile(files, app, 'F0OK'), refusedAs('info_failed'));
  app.filesInfoFail = null;
  app.scopes.delete('files:read');
  await assert.rejects(fetchFile(files, app, 'F0OK'), refusedAs('info_failed'));
  assert.deepEqual(log.lines.filter((l) => l.msg === 'file refused').map((l) => l.fields.code), ['file_not_found', 'file_deleted', 'ratelimited', 'missing_scope']);
  // A malformed id never reaches Slack.
  await assert.rejects(fetchFile(files, app, '../etc'), refusedAs('not_found'));
  assert.deepEqual(app.fetches, []);
});

test('no bot token, or no files client: "reading files isn\'t set up"; nothing is fetched', async () => {
  const app = new FakeSlackApp({ views: true });
  const files = createSlackFiles({ token: null, fetch: app.fetch, log: quietLog() });
  await assert.rejects(files.fetchFile({ client: app.client, fileId: 'F0X', person: ADA }), refusedAs('not_set_up'));
  const withToken = createSlackFiles({ token: 't', fetch: app.fetch, log: quietLog() });
  await assert.rejects(withToken.fetchFile({ client: {}, fileId: 'F0X', person: ADA }), refusedAs('not_set_up'));
  assert.deepEqual(app.fetches, []);
});

// --- The download (review A7) ---------------------------------------------------------------

test('a URL whose host is not files.slack.com, an http: URL, a user or a port: refused with no request made and no header sent', async () => {
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  for (const url of [
    'https://files.slack.com.evil.example/x', 'https://evil.example/files-pri/x', 'http://files.slack.com/files-pri/x',
    'https://user:pw@files.slack.com/x', 'https://files.slack.com:8443/x', 'not a url', 'https://FILES.slack.com.evil.example/x',
  ]) {
    await assert.rejects(download(url, { token: app.botToken, fetch: app.fetch, log }), refusedAs('download_failed'), url);
  }
  assert.deepEqual(app.fetches, []);
});

test('any redirect is refused, never followed: the token reaches no other host (and the fake shows what following would have sent)', async () => {
  const { app, files } = setup();
  app.addSlackFile({
    id: 'F0REDIR', name: 'r.pdf', user: ADA, bytes: pdf(),
  });
  for (const to of ['https://evil.example/steal', 'https://files.slack.com/files-pri/other']) {
    app.downloadAs.F0REDIR = { redirect: to };
    app.fetches.length = 0;
    await assert.rejects(fetchFile(files, app, 'F0REDIR'), refusedAs('download_failed'));
    assert.equal(app.fetches.length, 1, 'one request, to files.slack.com, and no second one');
    assert.equal(new URL(app.fetches[0].url).hostname, FILES_HOST);
  }
  // The fake follows a redirect when asked to, as fetch does by default: so
  // the test above would see a second request if the engine followed one.
  app.fetches.length = 0;
  app.downloadAs.F0REDIR = { redirect: 'https://evil.example/steal' };
  const info = await app.client.files.info({ file: 'F0REDIR' });
  await app.fetch(info.file.url_private_download, { headers: { Authorization: 'Bearer x' } });
  assert.deepEqual(app.fetches.map((f) => new URL(f.url).hostname), [FILES_HOST, 'evil.example']);
});

test('a body past 5 MB with no Content-Length is cut off and refused; so is a Content-Length over 5 MB', async () => {
  const { app, files } = setup();
  const over = Buffer.concat([pdf(), Buffer.alloc(MAX_FILE_BYTES)]);
  app.addSlackFile({
    id: 'F0STREAM', name: 's.pdf', user: ADA, bytes: over, size: 1000,
  });
  app.downloadAs.F0STREAM = { noLength: true };
  await assert.rejects(fetchFile(files, app, 'F0STREAM'), (err) => refusedAs('size')(err) && err.details.max === MAX_FILE_BYTES);
  // A Content-Length that says 1,000 but a body past 5 MB: still cut off.
  app.downloadAs.F0STREAM = { length: 1000 };
  await assert.rejects(fetchFile(files, app, 'F0STREAM'), refusedAs('size'));
  app.addSlackFile({
    id: 'F0LEN', name: 'l.pdf', user: ADA, bytes: pdf(), size: 1000,
  });
  app.downloadAs.F0LEN = { length: MAX_FILE_BYTES + 1 };
  await assert.rejects(fetchFile(files, app, 'F0LEN'), refusedAs('size'));
});

test('a slow body past 20 seconds is refused (the clock is frozen and moved; nothing waits)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { app, files } = setup();
  app.addSlackFile({
    id: 'F0SLOW', name: 'slow.pdf', user: ADA, bytes: pdf(),
  });
  app.downloadAs.F0SLOW = { slowMs: 60 * 1000 };
  const pending = assert.rejects(fetchFile(files, app, 'F0SLOW'), refusedAs('download_failed'));
  for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);
  t.mock.timers.tick(DOWNLOAD_TIMEOUT_MS + 1);
  await pending;
  assert.equal(DOWNLOAD_TIMEOUT_MS, 20 * 1000);
});

test('a slow body inside the limit arrives whole', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { app, files } = setup();
  const bytes = pdf();
  app.addSlackFile({
    id: 'F0OKSLOW', name: 'ok.pdf', user: ADA, bytes,
  });
  app.downloadAs.F0OKSLOW = { slowMs: 5000 };
  const pending = fetchFile(files, app, 'F0OKSLOW');
  for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);
  t.mock.timers.tick(5000);
  assert.ok((await pending).bytes.equals(bytes));
});

test('a web page instead of the file (Slack\'s answer to a token it won\'t take), or a failing status, is download_failed', async () => {
  const app = new FakeSlackApp({ views: true });
  const wrongToken = createSlackFiles({ token: 'not-the-bot-token', fetch: app.fetch, log: quietLog() });
  app.addSlackFile({
    id: 'F0TXT', name: 'notes.txt', user: ADA, bytes: Buffer.from('plain words'),
  });
  await assert.rejects(fetchFile(wrongToken, app, 'F0TXT'), refusedAs('download_failed'));
  const { files } = { files: createSlackFiles({ token: app.botToken, fetch: app.fetch, log: quietLog() }) };
  app.downloadAs.F0TXT = { html: true };
  await assert.rejects(fetchFile(files, app, 'F0TXT'), refusedAs('download_failed'));
  app.downloadAs.F0TXT = { status: 500 };
  await assert.rejects(fetchFile(files, app, 'F0TXT'), refusedAs('download_failed'));
  const failing = createSlackFiles({ token: app.botToken, fetch: async () => { throw new TypeError('fetch failed'); }, log: quietLog() });
  await assert.rejects(fetchFile(failing, app, 'F0TXT'), refusedAs('download_failed'));
});

// --- Text files ------------------------------------------------------------------------------

test('readText: UTF-8 is read as it is (a BOM dropped); invalid UTF-8 or a NUL byte is refused', () => {
  assert.equal(readText(Buffer.from('Prices: $120 — café\n')), 'Prices: $120 — café\n');
  assert.equal(readText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')])), 'hi');
  assert.throws(() => readText(Buffer.from([0x68, 0xff, 0xfe, 0x69])), refusedAs('encoding'));
  assert.throws(() => readText(Buffer.from('a\0b')), refusedAs('encoding'));
  assert.throws(() => readText(png()), refusedAs('encoding'));
});

// --- CSV files (plan brightside-v1, D3, Story 18.2) -------------------------------------------

// A CSV of `rows` data rows and `cols` columns, each cell `cell`.
const csvOf = ({ rows = 1, cols = 2, cell = 'x' } = {}) => {
  const line = (v) => Array.from({ length: cols }, () => v).join(',');
  const header = Array.from({ length: cols }, (_, i) => `c${i}`).join(',');
  return Buffer.from([header, ...Array.from({ length: rows }, () => line(cell))].join('\n'));
};
const csvTooBig = refusedAs('csv_too_big');

test('readCsv: a header and rows come back as LF text, with the data rows and the columns counted', () => {
  const got = readCsv(Buffer.from('zone,billed\r\nNorth,120\r\nSouth,95\r\n'));
  assert.deepEqual({ ...got }, { text: 'zone,billed\nNorth,120\nSouth,95', rows: 2, columns: 2 });
  assert.ok(Object.isFrozen(got));
});

test('readCsv: 200 data rows are read; 201 are too big', () => {
  assert.equal(readCsv(csvOf({ rows: MAX_CSV_ROWS })).rows, 200);
  assert.equal(MAX_CSV_ROWS, 200);
  assert.throws(() => readCsv(csvOf({ rows: MAX_CSV_ROWS + 1 })), csvTooBig);
});

test('readCsv: 30 columns are read; 31 are too big', () => {
  assert.equal(readCsv(csvOf({ cols: MAX_CSV_COLUMNS })).columns, 30);
  assert.equal(MAX_CSV_COLUMNS, 30);
  assert.throws(() => readCsv(csvOf({ cols: MAX_CSV_COLUMNS + 1 })), csvTooBig);
});

test('readCsv: 6,000 escaped characters are read; 6,001 are too big, and a < counts 4', () => {
  assert.equal(MAX_CSV_CHARS, 6000);
  // "a\n<" is 3 characters and 6 escaped ("a\n&lt;"); pad the cell with "y".
  const at = (escaped) => Buffer.from(`a\n<${'y'.repeat(escaped - 6)}`);
  const ok = readCsv(at(6000));
  assert.equal(ok.text.length, 5997);
  assert.equal(promptChars(ok.text), 6000);
  assert.throws(() => readCsv(at(6001)), csvTooBig);
  assert.equal(messageFor(new FileRefused('csv_too_big')), 'That CSV is too big for a note: at most 200 rows, 30 columns and about 6,000 characters. Keep the rows you need, or split it.');
});

test('readCsv: a ragged row, an unterminated quote or a quote out of place is refused', () => {
  assert.throws(() => readCsv(Buffer.from('a,b\n1,2\n3\n')), refusedAs('csv_ragged'));
  assert.throws(() => readCsv(Buffer.from('a,b\n1,2,3\n')), refusedAs('csv_ragged'));
  assert.throws(() => readCsv(Buffer.from('a,b\n1,"open\n2,3\n')), refusedAs('csv_quote'));
  assert.throws(() => readCsv(Buffer.from('a,b\n"x"y,2\n')), refusedAs('csv_quote'));
  assert.throws(() => readCsv(Buffer.from('a,b\nx"y,2\n')), refusedAs('csv_quote'));
});

test('readCsv: quoted commas, quotes and line breaks are kept (a CRLF inside a quote as LF)', () => {
  const got = readCsv(Buffer.from('name,note\r\n"Smith, J","said ""hi""\r\nthen left"\r\nplain,""\r\n'));
  assert.equal(got.rows, 2);
  assert.equal(got.text, 'name,note\n"Smith, J","said ""hi""\nthen left"\nplain,');
});

test('readCsv: a BOM is dropped; CRLF and a lone CR are stored as LF; blank lines skipped', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  assert.equal(readCsv(Buffer.concat([bom, Buffer.from('zone,n\r\nNorth,1\r\n')])).text, 'zone,n\nNorth,1');
  assert.equal(readCsv(Buffer.from('zone,n\rNorth,1\r\n\r\nSouth,2\n\n')).text, 'zone,n\nNorth,1\nSouth,2');
});

test('readCsv: invalid UTF-8 or a NUL byte is encoding; header only is csv_no_rows; nothing at all is empty', () => {
  assert.throws(() => readCsv(Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xff, 0x2c, 0x31])), refusedAs('encoding'));
  assert.throws(() => readCsv(Buffer.from('a,b\n1,\0\n')), refusedAs('encoding'));
  assert.throws(() => readCsv(Buffer.from('a,b\r\n')), refusedAs('csv_no_rows'));
  assert.throws(() => readCsv(Buffer.from('\r\n\n')), refusedAs('empty'));
  for (const reason of ['csv_ragged', 'csv_quote', 'csv_no_rows']) assert.match(messageFor(new FileRefused(reason)), /nothing was added/i, reason);
});

test('a .csv download is checked as text: a JSON content type is refused; text/csv, text/plain and octet-stream are read', async () => {
  const { app, files } = setup();
  const body = 'zone,n\nNorth,1\n';
  app.addSlackFile({
    id: 'F0CSV', name: 'zones.csv', user: ADA, mimetype: 'text/csv', bytes: Buffer.from(body),
  });
  app.downloadAs.F0CSV = { contentType: 'application/json; charset=utf-8' };
  await assert.rejects(fetchFile(files, app, 'F0CSV'), refusedAs('download_failed'));
  for (const contentType of ['text/csv', 'text/plain; charset=utf-8', 'application/octet-stream']) {
    app.downloadAs.F0CSV = { contentType };
    assert.equal((await fetchFile(files, app, 'F0CSV')).bytes.toString(), body, contentType);
  }
});

// --- The fake refuses what Slack refuses ------------------------------------------------------

test('the Slack fake: file_input outside an input block, max_files over 10, unknown filetypes; a file_input view without files:read', async () => {
  const input = (element) => ({
    type: 'modal', title: { type: 'plain_text', text: 'Add context' }, submit: { type: 'plain_text', text: 'Add' }, blocks: [{ type: 'input', block_id: 'f', label: { type: 'plain_text', text: 'File' }, element }],
  });
  assert.equal(invalidElements(input({ type: 'file_input', action_id: 'v', max_files: 1, filetypes: FILETYPES })), null);
  // Story 18.2: the fake takes csv, as Slack does (filetypes are extensions).
  assert.equal(invalidElements(input({ type: 'file_input', action_id: 'v', max_files: 1, filetypes: ['csv'] })), null);
  assert.match(invalidElements(input({ type: 'file_input', action_id: 'v', max_files: 11 })), /max_files is 1 to 10/);
  assert.match(invalidElements(input({ type: 'file_input', action_id: 'v', max_files: 0 })), /max_files/);
  assert.match(invalidElements(input({ type: 'file_input', action_id: 'v', filetypes: ['application/pdf'] })), /filetypes/);
  assert.match(invalidElements(input({ type: 'file_input', action_id: 'v', filetypes: ['.pdf'] })), /filetypes/);
  assert.match(invalidElements(input({ type: 'file_input', action_id: 'v', filetypes: [] })), /filetypes/);
  assert.match(invalidElements({ blocks: [{ type: 'actions', elements: [{ type: 'file_input', action_id: 'v' }] }] }), /belongs in an input block/);
  assert.match(invalidElements({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' }, accessory: { type: 'file_input', action_id: 'v' } }] }), /belongs in an input block/);
  const app = new FakeSlackApp({ views: true });
  app.scopes.delete('files:read');
  await assert.rejects(app.client.views.update({ view_id: 'V1', view: input({ type: 'file_input', action_id: 'v' }) }), (err) => err.data.error === 'missing_scope');
  await assert.rejects(app.client.files.info({ file: 'F1' }), (err) => err.data.error === 'missing_scope');
  app.scopes.add('files:read');
  await assert.rejects(app.client.files.info({ file: 'F1' }), (err) => err.data.error === 'file_not_found');
  await assert.rejects(app.client.files.info({}), (err) => err.data.error === 'invalid_arguments');
});

// --- Fail closed (PR #274 review) -------------------------------------------------------------

test('a .txt download answered with a JSON error body (content type application/json, status 200) is refused, never stored as text', async () => {
  const { app, files } = setup();
  const json = '{"ok":false,"error":"file_not_found"}';
  app.addSlackFile({
    id: 'F0JSON', name: 'notes.txt', user: ADA, mimetype: 'text/plain', bytes: Buffer.from(json),
  });
  app.downloadAs.F0JSON = { contentType: 'application/json; charset=utf-8' };
  await assert.rejects(fetchFile(files, app, 'F0JSON'), refusedAs('download_failed'));
  // text/* and application/octet-stream are what a text file may come as.
  for (const contentType of ['text/plain; charset=utf-8', 'text/markdown', 'application/octet-stream']) {
    app.downloadAs.F0JSON = { contentType };
    assert.equal((await fetchFile(files, app, 'F0JSON')).bytes.toString(), json, contentType);
  }
  // No content type at all: refused.
  app.downloadAs.F0JSON = { contentType: ' ' };
  await assert.rejects(fetchFile(files, app, 'F0JSON'), refusedAs('download_failed'));
});

test('a body whose length is not the size files.info reported is refused (a short or a different body, with a 2xx status)', async () => {
  const { app, files } = setup();
  const bytes = Buffer.from('Opening hours: 8 to 6.');
  app.addSlackFile({
    id: 'F0LEN2', name: 'hours.txt', user: ADA, mimetype: 'text/plain', bytes,
  });
  app.downloadAs.F0LEN2 = { body: 'Opening hours' };
  await assert.rejects(fetchFile(files, app, 'F0LEN2'), refusedAs('download_failed'));
  app.downloadAs.F0LEN2 = { body: '{"error":"internal"}', okStatus: 203 };
  await assert.rejects(fetchFile(files, app, 'F0LEN2'), refusedAs('download_failed'));
  // files.info saying a different size than what is served.
  app.addSlackFile({
    id: 'F0SIZE', name: 'p.pdf', user: ADA, bytes: pdf(), size: 10,
  });
  await assert.rejects(fetchFile(files, app, 'F0SIZE'), refusedAs('download_failed'));
  // The body at the reported size is read.
  delete app.downloadAs.F0LEN2;
  assert.ok((await fetchFile(files, app, 'F0LEN2')).bytes.equals(bytes));
});

test('a status other than 2xx is refused (a 3xx, 4xx or 5xx)', async () => {
  const { app, files } = setup();
  app.addSlackFile({
    id: 'F0ST', name: 'n.txt', user: ADA, mimetype: 'text/plain', bytes: Buffer.from('x'),
  });
  for (const status of [304, 404, 500]) {
    app.downloadAs.F0ST = { status };
    await assert.rejects(fetchFile(files, app, 'F0ST'), refusedAs('download_failed'), String(status));
  }
});

test('a file name over 255 characters is shortened with its extension kept; a short one is kept as it is', async () => {
  assert.equal(MAX_NAME_CHARS, 255);
  assert.equal(fileName('Prices.pdf', 'pdf'), 'Prices.pdf');
  const long = `${'Prices for 2026 '.repeat(30)}.pdf`;
  const short = fileName(long, 'pdf');
  assert.ok(short.length <= 255);
  assert.ok(short.endsWith('….pdf'));
  assert.ok(long.startsWith(short.slice(0, -5)));
  // Never cuts an emoji (two UTF-16 units) in half.
  const emoji = fileName(`${'😀'.repeat(200)}.png`, 'png');
  assert.ok(emoji.length <= 255 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji));
  const { app, files } = setup();
  app.addSlackFile({
    id: 'F0LONG', name: long, user: ADA, bytes: pdf(),
  });
  assert.equal((await fetchFile(files, app, 'F0LONG')).name, short);
});
