'use strict';

// The mock email tool's outbox: an append-only JSON-lines file that stands in
// for the email system (AD-15). The mock writes to it, the Outbox module reads
// it, and the connector keeps its idempotency keys in it, so a repeated key
// adds nothing even after a restart.
//
// One record per line, appended with one write:
//   { at, type: 'list',    operation: 'createList',  key, payload: { listId, name } }
//   { at, type: 'contact', operation: 'addContacts', key, payload: { listId, external_ref, email, first_name } }
//   { at, type: 'done',    operation, key, slot, input, result }   the contract's ledger (deps.idempotency)
// A contact's key is the write's key, its listId and its external_ref.
//
// The file and its directory are created on first write, owner-only: contacts
// are client data. A file that was created wider is narrowed to 0o600 on the
// next write.
//
// Fail closed. A misread outbox must never cause a duplicate send, so every
// write (and every idempotency lookup) refuses when the file can't be read or
// holds a line that isn't a complete JSON record: a torn line (a crash
// mid-write, or a last line with no newline) or a corrupt one. The error names
// the line number, never its content; a person repairs the file (checks
// whether that write reached the tool, then fixes or removes the line) before
// writes resume. Only the Outbox module's read-only view skips such lines.
//
// One writer at a time, across processes. A bot and a CLI can both write, so
// each check-then-append runs inside transaction(), which holds an exclusive
// lockfile (<file>.lock, holding the owner's pid) and reads the file once.
// A lock whose pid has exited, or older than lockStaleMs, is stale and taken
// over. A live lock is waited on for up to lockWaitMs, then the write fails
// loudly (a retry with the same key is safe). One residual gap: taking over a
// stale lock is rename-then-check, so two processes taking over the same stale
// lock in the same instant could, in theory, both proceed. This is a mock; a
// real store would use the vendor's own idempotency.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// var/outbox/email.jsonl under APLABS_VAR_DIR, else under var/ in the
// directory the app runs from (the repo root with `npm start`).
function outboxPath(env = process.env) {
  return path.join(path.resolve(env.APLABS_VAR_DIR || 'var'), 'outbox', 'email.jsonl');
}

const isRecord = (r) => r && typeof r === 'object' && !Array.isArray(r);

// Every record in the file ([] when there is no file). Throws when the file
// can't be read, or (unless lenient) when a line is torn or corrupt. lenient
// skips such lines: for read-only views only, never on a write path.
function readRecords(file, { lenient = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`the outbox ${file} can't be read (${err.code || err.message}): writes are refused`);
  }
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    // The last piece has no newline after it: a write cut short.
    const complete = i < lines.length - 1;
    let record;
    try { record = complete ? JSON.parse(line) : undefined; } catch (_) { record = undefined; }
    if (isRecord(record)) { out.push(record); continue; }
    if (lenient) continue;
    throw new Error(`the outbox ${file} has a torn or corrupt line ${i + 1}: writes are refused until it is repaired `
      + '(check whether that write reached the email tool, then fix or remove the line)');
  }
  return out;
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readIfThere(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// The exclusive lockfile: acquire() returns a release function.
function lockfile(lock, { waitMs, staleMs }) {
  // Who holds it: { pid, stale, text }, or null when it is gone. Content that
  // isn't a lock record (one being written, or garbage) is held until it is old.
  function holder() {
    let text;
    let stat;
    try {
      text = fs.readFileSync(lock, 'utf8');
      stat = fs.statSync(lock);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    let pid;
    try { ({ pid } = JSON.parse(text)); } catch (_) { pid = undefined; }
    const known = Number.isInteger(pid) && pid > 0;
    const stale = Date.now() - stat.mtimeMs > staleMs || (known && !alive(pid));
    return { pid: known ? pid : undefined, stale, text };
  }

  // Moves the stale lock aside, then checks it was the one judged stale; a
  // fresh lock moved by mistake is put back.
  function takeOver(text) {
    const aside = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
    try {
      fs.renameSync(lock, aside);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (readIfThere(aside) !== text) {
      try { fs.linkSync(aside, lock); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    fs.rmSync(aside, { force: true });
  }

  return function acquire() {
    const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: crypto.randomBytes(8).toString('hex') });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        fs.writeFileSync(lock, mine, { flag: 'wx', mode: 0o600 });
        return () => { if (readIfThere(lock) === mine) fs.rmSync(lock, { force: true }); };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      const held = holder();
      if (!held) continue;
      if (held.stale) { takeOver(held.text); continue; }
      if (Date.now() >= deadline) {
        throw new Error(`the outbox is locked by another process (pid ${held.pid ?? 'unknown'}): one writer at a time. `
          + `Retry with the same key; if nothing is writing, remove ${lock}`);
      }
      pause(20);
    }
  };
}

// opts: lockWaitMs (default 2000), lockStaleMs (default 30000).
function openOutbox(file, { lockWaitMs = 2000, lockStaleMs = 30_000 } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('the outbox needs a file path');
  const acquire = lockfile(`${file}.lock`, { waitMs: lockWaitMs, staleMs: lockStaleMs });
  const records = () => readRecords(file);

  // Owner-only, even for a file that was created wider.
  function narrow() {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (stat.mode & 0o077) fs.chmodSync(file, 0o600);
  }

  // Runs fn(tx) holding the lock, with the file read once: tx.records (every
  // record), tx.find(type, key) (the first record of a type under a key) and
  // tx.append(record). fn is synchronous; the lock is released when it returns
  // or throws. Refuses (throws) on an unreadable, torn or corrupt file.
  function transaction(fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const release = acquire();
    try {
      narrow();
      const all = readRecords(file);
      const byKey = new Map();
      const index = (r) => { const k = `${r.type}\u0000${r.key}`; if (!byKey.has(k)) byKey.set(k, r); };
      all.forEach(index);
      const tx = Object.freeze({
        records: all,
        find: (type, key) => byKey.get(`${type}\u0000${key}`),
        append(record) {
          const full = { at: new Date().toISOString(), ...record };
          fs.appendFileSync(file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
          all.push(full);
          index(full);
        },
      });
      const result = fn(tx);
      if (result && typeof result.then === 'function') throw new Error('an outbox transaction must be synchronous');
      return result;
    } finally {
      release();
    }
  }

  const append = (record) => transaction((tx) => tx.append(record));

  // The first record of a type under a key, or undefined.
  const find = (type, key) => records().find((r) => r.type === type && r.key === key);

  // deps.idempotency for the contract: { get(slot), set(slot, { input, result }) }.
  // slot is the contract's "<operation>\u0000<key>".
  const ledger = Object.freeze({
    get(slot) {
      const done = records().find((r) => r.type === 'done' && r.slot === slot);
      return done ? { input: done.input, result: done.result } : undefined;
    },
    set(slot, { input, result }) {
      const [operation, ...rest] = slot.split('\u0000');
      append({ type: 'done', operation, key: rest.join('\u0000'), slot, input, result });
    },
  });

  return Object.freeze({ file, records, find, append, transaction, ledger });
}

// The latest lists, newest first, each with its contact count and the first
// few contacts (email and first name only). total: how many lists there are.
function summarise(records, { lists = 5, sample = 3 } = {}) {
  const all = records.filter((r) => r.type === 'list' && r.payload);
  const contacts = new Map();
  for (const r of records) {
    if (r.type !== 'contact' || !r.payload) continue;
    const id = r.payload.listId;
    if (!contacts.has(id)) contacts.set(id, []);
    contacts.get(id).push(r.payload);
  }
  const latest = all.slice(-lists).reverse().map((r) => {
    const members = contacts.get(r.payload.listId) || [];
    return {
      listId: r.payload.listId,
      name: r.payload.name,
      at: r.at,
      count: members.length,
      sample: members.slice(0, sample).map((c) => ({ email: c.email, first_name: c.first_name })),
    };
  });
  return { total: all.length, lists: latest };
}

module.exports = { openOutbox, outboxPath, readRecords, summarise };
