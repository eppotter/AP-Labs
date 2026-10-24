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
// A contact's key is the write's key plus its external_ref.
//
// The file and its directory are created on first write, owner-only: contacts
// are client data. A line that isn't valid JSON is a write a crash cut short;
// it never completed, so it is skipped, and the next record starts on a new line.
// Every read re-reads the file: a mock, small by design, one writer per process.

const fs = require('node:fs');
const path = require('node:path');

// var/outbox/email.jsonl under APLABS_VAR_DIR, else under var/ in the
// directory the app runs from (the repo root with `npm start`).
function outboxPath(env = process.env) {
  return path.join(path.resolve(env.APLABS_VAR_DIR || 'var'), 'outbox', 'email.jsonl');
}

function readRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && !Array.isArray(record)) out.push(record);
    } catch (_) {
      // A torn write: skipped (see above).
    }
  }
  return out;
}

function endsWithNewline(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

function openOutbox(file) {
  if (typeof file !== 'string' || !file) throw new Error('the outbox needs a file path');
  const records = () => readRecords(file);

  function append(record) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
    fs.appendFileSync(file, endsWithNewline(file) ? line : `\n${line}`, { mode: 0o600 });
  }

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

  return Object.freeze({ file, records, find, append, ledger });
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
