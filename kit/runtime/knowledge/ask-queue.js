'use strict';

// The review queue (plan brightside-v1, D11, Story 19.6): the data questions
// Ask declined, kept so SQLsmith can turn the ones that recur into signed
// query rules. `npm run query-rules -- --queue` lists them; `--new QR-NNN
// --from <id>` scaffolds a rule from one; `--done <id>` clears it.
//
//   const queue = createAskQueue({ clientId, varDir, log });
//   await queue.add({ hub, reason, question });  // the stored entry
//   await queue.list();                          // [entry], oldest first
//   await queue.get(id);                         // entry | null
//   await queue.remove(id);                      // true | false
//
// Where: <var dir>/ask-queue/<client id>/<id>.json (the var dir as the
// knowledge store resolves it, varDirFor). Never .aplabs/** or the repo.
//
// An entry is exactly { id, at, hub, reason, question }. reason is one of
// no_rule, guard, hidden_column, no_key (D10's refusal causes). question is
// the person's words on one line, at most 500 characters. Nothing else is
// ever stored: never a row, the SQL, a figure or the person's Slack id, even
// when the caller passes them (add() reads only the three fields it keeps).
//
// Writes. This module is the only writer. Each entry goes to a temporary
// file (mode 0600, folders 0700) and is renamed into place. Ids are random
// (16 hex characters), never taken from input, and every path is checked to
// stay inside the client's queue folder. Adds and removes run one at a time.
// At most 200 entries: adding the 201st drops the oldest, logged by id.
//
// Reads never throw for a bad file: a missing folder is no entries, and a
// file that isn't a well-formed entry is skipped (logged by id). Symlinks
// are never followed.
//
// Logs: the entry id, the hub and the reason. Never the question.

const nodeFs = require('node:fs/promises');
const { constants: FS } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { clientDirName } = require('./store');

const CLIENT_SLUG = /^[a-z][a-z0-9-]*$/;
const HUB = /^[a-z][a-z0-9-]{0,63}$/;
const ENTRY_ID = /^[0-9a-f]{16}$/;
const ENTRY_FILE = /^([0-9a-f]{16})\.json$/;
const REASONS = Object.freeze(['no_rule', 'guard', 'hidden_column', 'no_key']);
const MAX_QUESTION_CHARS = 500;
const MAX_ENTRIES = 200;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const KEYS = Object.freeze(['id', 'at', 'hub', 'reason', 'question']);

// One line, control and format characters as spaces, at most 500 characters.
function cleanQuestion(q) {
  const flat = String(q).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, MAX_QUESTION_CHARS).join('').trim();
}

function parseEntry(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw).sort();
  if (keys.join() !== [...KEYS].sort().join()) return null;
  if (raw.id !== id || !HUB.test(String(raw.hub)) || !REASONS.includes(raw.reason)) return null;
  if (typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) return null;
  if (typeof raw.question !== 'string' || !raw.question || raw.question.length > MAX_QUESTION_CHARS * 2) return null;
  return Object.freeze({
    id: raw.id, at: raw.at, hub: raw.hub, reason: raw.reason, question: raw.question,
  });
}

// deps: fs (node:fs/promises-shaped), now (ms), newId, for tests.
function createAskQueue({
  clientId, varDir, log, fs = nodeFs, now = () => Date.now(), newId = () => crypto.randomBytes(8).toString('hex'), maxEntries = MAX_ENTRIES,
}) {
  if (typeof clientId !== 'string' || !CLIENT_SLUG.test(clientId)) throw new TypeError('the ask queue needs the client id (a slug)');
  if (typeof varDir !== 'string' || !path.isAbsolute(varDir)) throw new TypeError('the ask queue needs an absolute var dir');
  if (!log || typeof log.info !== 'function') throw new TypeError('the ask queue needs a log');
  const root = path.join(path.resolve(varDir), 'ask-queue', clientDirName(clientId));

  function entryPath(id) {
    if (typeof id !== 'string' || !ENTRY_ID.test(id)) throw new TypeError('not a review queue id');
    const p = path.resolve(root, `${id}.json`);
    if (path.dirname(p) !== root) throw new TypeError('review queue path outside the queue');
    return p;
  }

  let queue = Promise.resolve();
  function serial(job) {
    const run = queue.then(job);
    queue = run.then(() => {}, () => {});
    return run;
  }

  // 'ok', 'missing' or 'not_folder' for the queue folder (never a symlink).
  async function folderState() {
    let st;
    try {
      st = await fs.lstat(root);
    } catch (err) {
      if (err && err.code === 'ENOENT') return 'missing';
      throw err;
    }
    return st.isDirectory() ? 'ok' : 'not_folder';
  }

  async function readFile(p) {
    const handle = await fs.open(p, FS.O_RDONLY | FS.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('not a regular file');
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }

  async function read() {
    const state = await folderState();
    if (state === 'missing') return [];
    if (state !== 'ok') {
      log.error('review queue folder is not a folder; none read');
      return [];
    }
    const entries = [];
    for (const name of await fs.readdir(root)) {
      const m = ENTRY_FILE.exec(name);
      if (!m) continue;
      let entry = null;
      try {
        entry = parseEntry(JSON.parse(await readFile(entryPath(m[1]))), m[1]);
      } catch {
        entry = null;
      }
      if (entry) entries.push(entry);
      else log.warn('review queue entry skipped', { id: m[1] });
    }
    return entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  async function unlink(id) {
    try {
      await fs.unlink(entryPath(id));
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw err;
    }
  }

  // Stores { hub, reason, question } and nothing else the caller passes.
  async function add(input = {}) {
    const { hub, reason, question } = input;
    if (typeof hub !== 'string' || !HUB.test(hub)) throw new TypeError('a review queue entry needs the hub id (a slug)');
    if (!REASONS.includes(reason)) throw new TypeError(`a review queue reason is one of ${REASONS.join(', ')}`);
    if (typeof question !== 'string') throw new TypeError('a review queue entry needs the question');
    const text = cleanQuestion(question);
    if (!text) throw new TypeError('a review queue entry needs the question');
    const id = newId();
    const final = entryPath(id);
    return serial(async () => {
      await fs.mkdir(root, { recursive: true, mode: DIR_MODE });
      if (await folderState() !== 'ok') throw new Error('review queue folder is not a real folder');
      const entry = Object.freeze({
        id, at: new Date(now()).toISOString(), hub, reason, question: text,
      });
      const tmp = path.join(root, `.${id}.${crypto.randomBytes(6).toString('hex')}.tmp`);
      try {
        await fs.writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' });
        await fs.rename(tmp, final);
      } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }
      log.info('review queue entry added', { id, hub, reason });
      const count = (await fs.readdir(root)).filter((n) => ENTRY_FILE.test(n)).length;
      if (count <= maxEntries) return entry;
      const held = await read();
      for (const old of held.slice(0, Math.max(0, held.length - maxEntries))) {
        await unlink(old.id);
        log.warn('review queue full; oldest entry dropped', { id: old.id, hub: old.hub });
      }
      return entry;
    });
  }

  const list = () => serial(read);

  async function get(id) {
    entryPath(id);
    return (await list()).find((e) => e.id === id) || null;
  }

  async function remove(id) {
    entryPath(id);
    return serial(async () => {
      const removed = await unlink(id);
      if (removed) log.info('review queue entry cleared', { id });
      return removed;
    });
  }

  return Object.freeze({
    add, list, get, remove, root,
  });
}

module.exports = {
  createAskQueue, cleanQuestion, REASONS, MAX_QUESTION_CHARS, MAX_ENTRIES, FILE_MODE, DIR_MODE,
};
