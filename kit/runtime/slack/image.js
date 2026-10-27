'use strict';

// A map image shown inside a modal as a private Slack file (Story 15.1,
// AD-R12, AD-R15).
//
// uploadPng uploads the PNG with files.uploadV2 naming no conversation at
// all, so the file is shared nowhere: always filename route-map.png and title
// "Route map", nothing else. It reads the file id from Slack's answer the way
// deliverCsv reads its permalink (kit/runtime/archetypes/scoped-pull/deliver).
// imageBlock builds the block that shows it: slack_file { id } and alt text,
// never image_url and never a public link. The alt text comes from one fixed
// template, "Route map: <view label>, <crew label>, <n> stops" (altText), and
// isAltText refuses anything else, so no free text reaches Slack this way.
//
// createMapFiles({ store, client, log, sweeping }) is the lifecycle the hub
// uses (AD-R15):
//   ready()                 true only when the files can be cleaned up: a
//                           store, a Slack client that can upload and delete,
//                           and the sweep job running (sweeping()). When it
//                           is false the module shows "not available" and no
//                           modal opens (fail closed).
//   upload({ owner, png, alt })  checks the PNG and the alt text, uploads,
//                           records the file id in the store (15 minutes)
//                           and only then returns the image block. A record
//                           that fails deletes the file at once and throws.
//   release(owner, { keep, only, among })  deletes every file the owner
//                           recorded (except keep; or only that one; or only
//                           those of among still recorded), for a view
//                           switch, view_closed or a map that was not shown.
//   reuse(owner, id, alt)   Plan a route's list update (Story 15.14,
//                           AD-R27): the image block for a file already
//                           shown, so the list can change under the same
//                           picture without a new upload. Only while the
//                           file's record is live for this owner and the
//                           file is under 10 minutes old (REUSE_MS, by this
//                           process's upload time and now()): { block }, else
//                           { reason } ('not recorded' or 'too old'). Nothing
//                           is uploaded, recorded or deleted here.
//   filesOf(owner)          the file ids the owner has recorded now (Story
//                           15.4: a map that shows deletes only the files
//                           recorded before its upload, among, so an older
//                           click never deletes a newer click's file).
//   showing(fn)             runs fn (the views.update that shows the image
//                           block) and resolves the attempt it took. When
//                           Slack answers that the file is not usable yet
//                           (fileNotReady: invalid_arguments with an
//                           "invalid slack file" message on slack_file, seen
//                           live straight after an upload), it waits and
//                           tries again: SHOW_DELAYS (1, 2, 3, 4 s; showDelays
//                           and sleep are injectable). Any other error is
//                           thrown at once, unretried. When every try fails
//                           it throws NotAccepted (attempts, Slack's code and
//                           its messages, cut short; never a payload).
// deleteMapFiles deletes recorded files: a deleted file (or one Slack no
// longer has) loses its record; any other failure keeps the record for the
// next sweep and logs Slack's error code only. Nothing here logs the PNG, the
// alt text or a Slack payload.
//
// Which modules may show an image (F6): the routing-map archetype, and the
// dev-only map-check module (id map-check, archetype handler, environments
// exactly ["dev"]). The hub refuses an image from any other module.

const FILENAME = 'route-map.png';
const TITLE = 'Route map';
const MAX_ALT = 2000;
const MAX_PNG_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILE_ID = /^F[A-Z0-9]{1,40}$/;
// A view or crew label in the alt text: short words, no comma or line break.
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 '’&()./-]{0,59}$/;
const ALT = /^Route map: ([^,\n]+), ([^,\n]+), (0|[1-9][0-9]{0,3}) stops$/;
const MAX_STOPS = 9999;
// Slack's codes for a file that is already gone: the record goes too.
const GONE = new Set(['file_not_found', 'file_deleted']);
const MAP_CHECK = 'map-check';
// Waits between tries when Slack does not accept a fresh file yet (live check
// 2026-10-26: views.update 0.5 s after the upload failed). Total 10 s.
const SHOW_DELAYS = Object.freeze([1000, 2000, 3000, 4000]);
const NOT_READY = /invalid slack file/i;
// How long a shown file may be shown again in a list update (AD-R27): well
// inside its 15-minute record, so the sweep never deletes it while shown.
const REUSE_MS = 10 * 60 * 1000;
const MAX_MESSAGES = 3;
const MAX_MESSAGE = 200;

class ImageError extends Error {
  constructor(reason) {
    super(`map image refused: ${reason}`);
    this.name = 'ImageError';
    this.reason = reason;
  }
}

// Slack never accepted the file for the image block, after every try.
class NotAccepted extends Error {
  constructor({ attempts, reason, messages }) {
    super('map image not accepted by slack');
    this.name = 'NotAccepted';
    this.attempts = attempts;
    this.reason = reason;
    this.messages = messages;
  }
}

// Slack's response_metadata messages for a failed call (the Slack client's
// WebAPIPlatformError keeps the answer in err.data), at most 3, each cut to
// 200 characters of plain text.
function slackMessages(err) {
  const meta = err && err.data && err.data.response_metadata;
  const list = meta && Array.isArray(meta.messages) ? meta.messages : [];
  return list.filter((m) => typeof m === 'string').slice(0, MAX_MESSAGES)
    .map((m) => m.replace(/[^\x20-\x7e]/g, '').slice(0, MAX_MESSAGE));
}

// True when Slack refused the image block's file as not usable (yet): the
// error invalid_arguments with a message "invalid slack file" pointing at a
// slack_file. Nothing else is retried.
function fileNotReady(err) {
  if (!err || !err.data || err.data.error !== 'invalid_arguments') return false;
  return slackMessages(err).some((m) => NOT_READY.test(m) && m.includes('slack_file'));
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The one alt text template (F15).
function altText({ view, crew, stops }) {
  if (typeof view !== 'string' || !LABEL.test(view)) throw new ImageError('bad view label');
  if (typeof crew !== 'string' || !LABEL.test(crew)) throw new ImageError('bad crew label');
  if (!Number.isInteger(stops) || stops < 0 || stops > MAX_STOPS) throw new ImageError('bad stop count');
  return `Route map: ${view}, ${crew}, ${stops} stops`;
}

function isAltText(s) {
  if (typeof s !== 'string' || s.length > MAX_ALT) return false;
  const m = ALT.exec(s);
  return Boolean(m && LABEL.test(m[1]) && LABEL.test(m[2]));
}

function isPng(png) {
  return Buffer.isBuffer(png) && png.length > PNG_SIGNATURE.length && png.length <= MAX_PNG_BYTES
    && png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

// True for the modules allowed to show an image (F6).
function uploadsMapImages(mod) {
  if (!mod || typeof mod !== 'object') return false;
  if (mod.archetype === 'routing-map') return true;
  return mod.id === MAP_CHECK && mod.archetype === 'handler'
    && Array.isArray(mod.environments) && mod.environments.length === 1 && mod.environments[0] === 'dev';
}

// Slack's error code for a failed call, never the request or its payload.
function slackCode(err) {
  const code = err && ((err.data && err.data.error) || err.code);
  return typeof code === 'string' && /^[a-z0-9_.-]{1,60}$/i.test(code) ? code : 'slack call failed';
}

// The first file id in a files.uploadV2 answer: { files: [{ files: [{ id }] }] }.
function fileIdOf(res) {
  const outer = res && Array.isArray(res.files) ? res.files : [];
  for (const entry of outer) {
    const inner = entry && Array.isArray(entry.files) ? entry.files : [entry];
    for (const f of inner) {
      if (f && typeof f.id === 'string' && FILE_ID.test(f.id)) return f.id;
    }
  }
  return null;
}

// Uploads the PNG, shared nowhere. Returns the file id.
async function uploadPng({ client, png }) {
  if (!isPng(png)) throw new ImageError('not a PNG under 1 MB');
  const res = await client.files.uploadV2({ file: png, filename: FILENAME, title: TITLE });
  const id = fileIdOf(res);
  if (!id) throw new ImageError('no file id in the upload answer');
  return id;
}

function imageBlock({ id, alt }) {
  if (typeof id !== 'string' || !FILE_ID.test(id)) throw new ImageError('bad file id');
  if (!isAltText(alt)) throw new ImageError('alt text is not the fixed template');
  return { type: 'image', slack_file: { id }, alt_text: alt };
}

// Deletes each recorded file. Returns { deleted, kept }.
async function deleteMapFiles({
  store, client, log, ids, why,
}) {
  let deleted = 0;
  let kept = 0;
  for (const id of ids) {
    try {
      await client.files.delete({ file: id });
      store.removeMapFile(id);
      deleted += 1;
    } catch (err) {
      const reason = slackCode(err);
      if (GONE.has(reason)) {
        store.removeMapFile(id);
        deleted += 1;
        log.info('map file already gone', { why, reason });
      } else {
        kept += 1;
        log.warn('map file delete failed; kept for the next sweep', { why, reason });
      }
    }
  }
  return { deleted, kept };
}

const canStore = (store) => Boolean(store && ['addMapFile', 'mapFilesOf', 'expiredMapFiles', 'removeMapFile']
  .every((k) => typeof store[k] === 'function'));
const canFiles = (client) => Boolean(client && client.files
  && typeof client.files.uploadV2 === 'function' && typeof client.files.delete === 'function');

function createMapFiles({
  store, client, log, sweeping = () => false, showDelays = SHOW_DELAYS, sleep = wait, now = () => Date.now(),
}) {
  const ready = () => canStore(store) && canFiles(client) && sweeping() === true;
  // file id -> when this process uploaded it (for reuse); entries past the
  // reuse window are forgotten on the next upload.
  const uploadedAt = new Map();
  const forgetOld = () => {
    const t = now();
    for (const [id, at] of uploadedAt) if (t - at >= REUSE_MS) uploadedAt.delete(id);
  };

  async function upload({ owner, png, alt }) {
    if (!ready()) throw new ImageError('map files cannot be cleaned up here');
    if (!isAltText(alt)) throw new ImageError('alt text is not the fixed template');
    const id = await uploadPng({ client, png });
    try {
      store.addMapFile(id, owner);
    } catch (err) {
      log.error('map file not recorded; deleting it now', { reason: err.name || 'error' });
      await deleteNow(id);
      throw new ImageError('the file could not be recorded');
    }
    forgetOld();
    uploadedAt.set(id, now());
    return imageBlock({ id, alt });
  }

  // The image block for a file already shown, or why it cannot be reused.
  function reuse(owner, id, alt) {
    if (!canStore(store) || typeof owner !== 'string' || !owner || typeof id !== 'string') return { reason: 'not recorded' };
    if (!store.mapFilesOf(owner).includes(id)) return { reason: 'not recorded' };
    const at = uploadedAt.get(id);
    if (at === undefined || now() - at >= REUSE_MS) return { reason: 'too old' };
    return { block: imageBlock({ id, alt }) };
  }

  // A file no one will see: delete it now. A failure is logged; the file was
  // never recorded, so this is the one way it can outlive the sweep (the
  // named risk in AD-R15).
  async function deleteNow(id) {
    try {
      await client.files.delete({ file: id });
    } catch (err) {
      log.error('unrecorded map file delete failed', { reason: slackCode(err) });
    }
  }

  // keep: one id to leave; only: the one id to delete; among: delete only
  // these ids (those still recorded).
  async function release(owner, {
    keep = null, only = null, among = null, why = 'released',
  } = {}) {
    if (!canStore(store) || !canFiles(client) || typeof owner !== 'string' || !owner) return { deleted: 0, kept: 0 };
    const within = Array.isArray(among) ? new Set(among) : null;
    const ids = store.mapFilesOf(owner).filter((id) => id !== keep && (only === null || id === only) && (within === null || within.has(id)));
    if (!ids.length) return { deleted: 0, kept: 0 };
    return deleteMapFiles({ store, client, log, ids, why });
  }

  // Shows the image block (fn), trying again while Slack says the file is
  // not usable yet. Resolves the attempt that worked.
  async function showing(fn) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fn();
        return attempt;
      } catch (err) {
        if (!fileNotReady(err)) throw err;
        if (attempt > showDelays.length) {
          throw new NotAccepted({ attempts: attempt, reason: slackCode(err), messages: slackMessages(err) });
        }
        await sleep(showDelays[attempt - 1]);
      }
    }
  }

  const filesOf = (owner) => (canStore(store) && typeof owner === 'string' && owner ? store.mapFilesOf(owner).slice() : []);

  return {
    ready, upload, release, showing, filesOf, reuse,
  };
}

module.exports = {
  altText, isAltText, isPng, uploadsMapImages, uploadPng, imageBlock, fileIdOf, deleteMapFiles, createMapFiles, slackCode,
  fileNotReady, slackMessages, ImageError, NotAccepted, SHOW_DELAYS, FILENAME, TITLE, MAX_ALT, MAX_PNG_BYTES, MAP_CHECK, REUSE_MS,
};
