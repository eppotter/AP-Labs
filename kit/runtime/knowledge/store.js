'use strict';

// The added-context store (plan brightside-v0, D4, Story 16.4): what an admin
// adds in Slack for one hub, kept as small JSON files under the var dir, so it
// survives a restart when the var dir does.
//
//   const knowledge = createKnowledgeStore({ clientId, varDir, log });
//   await knowledge.add({ hub, kind, title, text, addedBy, file });  // the entry
//   await knowledge.list(hub);                                     // [entry]
//   await knowledge.remove({ hub, id, removedBy });                // true | false
//   await knowledge.forPrompt(hub);    // the hub's <added_context> blocks, or ''
//   const mine = knowledge.forHub(hub);  // the same four, bound to one hub
//
// Where: <var dir>/context/<client id>/<hub id>/<entry id>.json. The var dir
// is APLABS_VAR_DIR, resolved as kit/runtime/data resolves it (a relative one
// against the working directory), else <repo>/var (varDirFor). Not
// kit/runtime/store (in memory, gone on restart) and never .aplabs/** (reviewed
// repo files the runtime must not write).
//
// An entry: { id, hub, kind: "text" | "file", title, text, added_by,
// added_at, file: { name, type, bytes } | null }. Only text is kept, never
// the original file.
//
// Writes. This module is the only writer. Each write goes to a temporary file
// (mode 0600) and is renamed into place. Ids are random (32 hex characters),
// never taken from input. A path is built from the client id, the hub id and
// the entry id only: a hub id that is not a slug, or an entry id not in the
// store's format, is refused before any file access, and the built path is
// checked to stay inside the store folder. Adds and removes on one hub run one
// at a time (a per-hub queue), so two admins adding at once can't both slip
// under a cap (review B6).
//
// Caps (review B4, B5), each measured on the text as it sits in the prompt,
// after escaping (kit/runtime/llm/context escapeData: < becomes &lt;):
//   - a typed entry ("text"): at most 3,000 characters;
//   - an entry taken from a file ("file"): at most 6,000;
//   - a hub: at most 15,000 characters in all (each entry's text and its
//     title, escaped), and 20 entries.
// The title (at most 80 characters, one line) counts toward the hub's total,
// not the entry's own cap, so a typed entry can always hold Slack's 3,000.
// A new entry over a cap is refused with ContextRefused, whose words say why.
// Nothing is cut.
//
// Reads never stop boot or a call: a missing folder is no entries; an entry
// file that can't be read, or isn't a well-formed entry of this hub, is
// skipped and logged by id.
//
// Logs: the entry id, the hub, the kind, the size and the admin's Slack id.
// Never the text, the title or the file name.

const nodeFs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { RuntimeRefusal } = require('../errors');
const { escapeData, addedContextPrompt } = require('../llm/context');

const REPO = path.resolve(__dirname, '../../..');
// The profile's and the hub schema's slug.
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const ENTRY_ID = /^[0-9a-f]{32}$/;
const ENTRY_FILE = /^([0-9a-f]{32})\.json$/;
const SLACK_ID = /^[A-Z0-9]{2,32}$/;
const KINDS = Object.freeze(['text', 'file']);
const CAPS = Object.freeze({
  text: 3000, file: 6000, hubChars: 15000, hubEntries: 20,
});
const MAX_TITLE_CHARS = 80;
const MAX_FILE_NAME_CHARS = 255;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// The var dir: APLABS_VAR_DIR (a relative one resolved against the working
// directory, as kit/runtime/data does), else <repo>/var.
function varDirFor(env = process.env) {
  return env.APLABS_VAR_DIR ? path.resolve(env.APLABS_VAR_DIR) : path.join(REPO, 'var');
}

// The length a text takes in the prompt.
const promptChars = (text) => escapeData(text).length;
// What an entry counts toward its hub's total: its text and title, escaped.
const entryChars = (e) => promptChars(e.text) + promptChars(e.title);

// A new entry refused by a cap, or one with no text. reason is one of
// CONTEXT_REFUSALS; details: { reason, max }. words: what to tell the admin.
const CONTEXT_REFUSALS = Object.freeze(['empty', 'too_long', 'hub_full', 'too_many']);
const WORDS = Object.freeze({
  empty: () => 'There is nothing to add: the text is empty.',
  too_long: (max) => `That is too long to add. At most ${max.toLocaleString('en-US')} characters fit, and each <, > or & counts as 4 or 5. Shorten it and try again.`,
  hub_full: (max) => `This hub's added context is full (${max.toLocaleString('en-US')} characters in all). Remove an entry to make room, then try again.`,
  too_many: (max) => `This hub already holds ${max} entries, the most it can. Remove one to make room, then try again.`,
});
class ContextRefused extends RuntimeRefusal {
  constructor(reason, max = null) {
    if (!CONTEXT_REFUSALS.includes(reason)) throw new TypeError(`unknown ContextRefused reason "${reason}"`);
    super(`added context refused: ${reason}`, { reason, max });
    this.code = 'CONTEXT_REFUSED';
    this.reason = reason;
    this.words = WORDS[reason](max);
  }
}

// One line: control and format characters become spaces, runs collapse.
const oneLine = (s) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();

function checkTitle(title) {
  const t = typeof title === 'string' ? oneLine(title) : '';
  if (!t || [...t].length > MAX_TITLE_CHARS) throw new TypeError(`an entry needs a title of 1 to ${MAX_TITLE_CHARS} characters`);
  return t;
}

function checkFileMeta(kind, file) {
  if (kind === 'text') {
    if (file !== null && file !== undefined) throw new TypeError('a typed entry has no file');
    return null;
  }
  if (!file || typeof file !== 'object'
    || typeof file.name !== 'string' || !file.name || file.name.length > MAX_FILE_NAME_CHARS
    || typeof file.type !== 'string' || !file.type || file.type.length > 100
    || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
    throw new TypeError('an entry from a file needs file: { name, type, bytes }');
  }
  return Object.freeze({ name: file.name, type: file.type, bytes: file.bytes });
}

// A stored entry, checked: a frozen copy of the known fields, or null.
function parseEntry(raw, hub, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.id !== id || raw.hub !== hub || !KINDS.includes(raw.kind)) return null;
  if (typeof raw.text !== 'string' || !raw.text.trim() || promptChars(raw.text) > CAPS[raw.kind]) return null;
  if (typeof raw.added_by !== 'string' || !SLACK_ID.test(raw.added_by)) return null;
  if (typeof raw.added_at !== 'string' || Number.isNaN(Date.parse(raw.added_at))) return null;
  try {
    const title = checkTitle(raw.title);
    if (title !== raw.title) return null;
    const file = checkFileMeta(raw.kind, raw.file);
    return Object.freeze({
      id, hub, kind: raw.kind, title, text: raw.text, added_by: raw.added_by, added_at: raw.added_at, file,
    });
  } catch {
    return null;
  }
}

// clientId: the profile's client.id. varDir: an absolute path (varDirFor).
// deps: fs (node:fs/promises-shaped), now (ms), newId (an id in the store's
// format), for tests.
function createKnowledgeStore({
  clientId, varDir, log, fs = nodeFs, now = () => Date.now(), newId = () => crypto.randomBytes(16).toString('hex'),
}) {
  if (typeof clientId !== 'string' || !SLUG.test(clientId)) throw new TypeError('the knowledge store needs the client id (a slug)');
  if (typeof varDir !== 'string' || !path.isAbsolute(varDir)) throw new TypeError('the knowledge store needs an absolute var dir');
  const root = path.join(path.resolve(varDir), 'context', clientId);

  // Inside root, or a TypeError. Called before any file access.
  function inside(p) {
    if (!p.startsWith(`${root}${path.sep}`)) throw new TypeError('added context path outside the store');
    return p;
  }
  function hubDir(hub) {
    if (typeof hub !== 'string' || !SLUG.test(hub)) throw new TypeError('added context needs a hub id (a slug)');
    return inside(path.resolve(root, hub));
  }
  function entryPath(hub, id) {
    const dir = hubDir(hub);
    if (typeof id !== 'string' || !ENTRY_ID.test(id)) throw new TypeError('not an added-context entry id');
    const p = inside(path.resolve(dir, `${id}.json`));
    if (path.dirname(p) !== dir) throw new TypeError('added context path outside the hub');
    return p;
  }

  // The per-hub queue: each job starts when the one before it settles.
  const queues = new Map();
  function serial(hub, job) {
    const run = (queues.get(hub) || Promise.resolve()).then(job);
    const tail = run.then(() => {}, () => {});
    queues.set(hub, tail);
    tail.then(() => { if (queues.get(hub) === tail) queues.delete(hub); });
    return run;
  }

  // The hub's entries, oldest first. Never throws for a file problem.
  async function read(hub) {
    const dir = hubDir(hub);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      log.error('added context unreadable; none used', { hub, error: err && err.code });
      return [];
    }
    const entries = [];
    for (const name of names) {
      const m = ENTRY_FILE.exec(name);
      if (!m) continue; // a temporary file, or anything else: never read
      const id = m[1];
      let entry = null;
      try {
        entry = parseEntry(JSON.parse(await fs.readFile(entryPath(hub, id), 'utf8')), hub, id);
      } catch {
        entry = null;
      }
      if (entry) entries.push(entry);
      else log.warn('added context entry skipped', { hub, id });
    }
    return entries.sort((a, b) => a.added_at.localeCompare(b.added_at) || a.id.localeCompare(b.id));
  }

  async function writeEntry(hub, entry) {
    const dir = hubDir(hub);
    const final = entryPath(hub, entry.id);
    const tmp = inside(path.join(dir, `.${entry.id}.${crypto.randomBytes(6).toString('hex')}.tmp`));
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    try {
      await fs.writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' });
      await fs.rename(tmp, final);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  // Checks everything that needs no file first; the caps that need the hub's
  // entries run inside the hub's queue. Returns the stored entry.
  async function add({
    hub, kind, title, text, addedBy, file = null,
  } = {}) {
    hubDir(hub);
    if (!KINDS.includes(kind)) throw new TypeError(`an entry's kind is one of ${KINDS.join(', ')}`);
    if (typeof addedBy !== 'string' || !SLACK_ID.test(addedBy)) throw new TypeError('an entry needs the Slack id of who added it');
    const cleanTitle = checkTitle(title);
    const fileMeta = checkFileMeta(kind, file);
    if (typeof text !== 'string') throw new TypeError('an entry needs its text');
    if (!text.trim()) throw new ContextRefused('empty');
    const chars = promptChars(text);
    if (chars > CAPS[kind]) throw new ContextRefused('too_long', CAPS[kind]);
    const id = newId();
    entryPath(hub, id);

    return serial(hub, async () => {
      const held = await read(hub);
      if (held.length >= CAPS.hubEntries) throw new ContextRefused('too_many', CAPS.hubEntries);
      const total = held.reduce((sum, e) => sum + entryChars(e), 0);
      if (total + chars + promptChars(cleanTitle) > CAPS.hubChars) throw new ContextRefused('hub_full', CAPS.hubChars);
      const entry = Object.freeze({
        id, hub, kind, title: cleanTitle, text, added_by: addedBy, added_at: new Date(now()).toISOString(), file: fileMeta,
      });
      await writeEntry(hub, entry);
      log.info('added context stored', {
        id, hub, kind, chars, added_by: addedBy,
      });
      return entry;
    });
  }

  async function list(hub) {
    hubDir(hub);
    return read(hub);
  }

  // true when the entry was there and is gone; false when it was not there.
  async function remove({ hub, id, removedBy } = {}) {
    const p = entryPath(hub, id);
    if (typeof removedBy !== 'string' || !SLACK_ID.test(removedBy)) throw new TypeError('a removal needs the Slack id of who removed it');
    return serial(hub, async () => {
      try {
        await fs.unlink(p);
      } catch (err) {
        if (err && err.code === 'ENOENT') return false;
        throw err;
      }
      log.info('added context removed', { id, hub, removed_by: removedBy });
      return true;
    });
  }

  // The hub's entries as they go into its AI prompt (D2), or ''.
  async function forPrompt(hub) {
    return addedContextPrompt(await list(hub));
  }

  // The store bound to one hub, for its view (kit/runtime/slack/hub-view).
  function forHub(hub) {
    hubDir(hub);
    return Object.freeze({
      add: (entry = {}) => add({ ...entry, hub }),
      list: () => list(hub),
      remove: (r = {}) => remove({ ...r, hub }),
      forPrompt: () => forPrompt(hub),
    });
  }

  return Object.freeze({
    add, list, remove, forPrompt, forHub, root,
  });
}

module.exports = {
  createKnowledgeStore, varDirFor, promptChars, entryChars, ContextRefused, CONTEXT_REFUSALS, CAPS, KINDS, MAX_TITLE_CHARS, FILE_MODE,
};
