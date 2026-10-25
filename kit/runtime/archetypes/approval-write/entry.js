'use strict';

// The approval entry (Story 10.2, AD-15). Made when a Push click shows the
// preview, kept in the store's `approval` namespace for 30 minutes under an
// opaque token: 128 bits from the CSPRNG, the only thing the Approve and
// Cancel buttons carry.
//
//   { person, module, runId, destination, listName, rows, idempotencyKey }
//
//   rows             a COPY of the approved rows' push fields (and the score,
//                    for a scored list), taken from the run record at preview
//                    time. The push reads only these (AD-17's "its own saved
//                    copy"): never the run record, never the button. So the
//                    record expiring can't change what is pushed.
//   idempotencyKey   sha256 of the canonical JSON [listName, sortedIds]:
//                    the rows' row ids as strings, sorted. The same rows to
//                    the same list (same run date) get the same key, so the
//                    connector writes them once.
//   module           the module id, so every click re-checks the person may
//                    still use it (N12).
//
// Every function here is synchronous: nothing can run between a check and a
// consume (AD-7).

const crypto = require('node:crypto');

const NS = 'approval';
const TOKEN = /^[0-9a-f]{32}$/;
const ENTRY_KEYS = Object.freeze(['person', 'module', 'runId', 'destination', 'listName', 'rows', 'idempotencyKey']);

// What a click's token finds: the entry (this person's, still live) or not.
// Expired, unknown, malformed, used and another person's all read the same.
const STATUS = Object.freeze({ OK: 'ok', INVALID: 'invalid' });

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

// sha256 of the canonical JSON [listName, ids as strings, sorted].
function idempotencyKey(listName, rowIds) {
  const ids = rowIds.map((id) => String(id)).sort();
  return crypto.createHash('sha256').update(JSON.stringify([String(listName), ids])).digest('hex');
}

// A deep copy of the rows: plain values only, so nothing the run record holds
// is shared with the entry.
function copyRows(rows) {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === undefined ? null : JSON.parse(JSON.stringify(v))])));
}

// Stores a new entry; returns its token.
function create(store, {
  person, module, runId, destination, listName, rows, idempotencyKey: key,
}) {
  const token = newToken();
  store.set(NS, token, Object.freeze({
    person, module, runId, destination, listName, rows: Object.freeze(copyRows(rows).map(Object.freeze)), idempotencyKey: key,
  }));
  return token;
}

function lookup(store, token, person) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return { status: STATUS.INVALID };
  const entry = store.get(NS, token);
  if (entry === undefined || entry.person !== person) return { status: STATUS.INVALID };
  return { status: STATUS.OK, entry };
}

// Cancel: looks the token up and, when it is this person's, consumes it in
// the same call. Returns the lookup.
function cancel(store, token, person) {
  const found = lookup(store, token, person);
  if (found.status === STATUS.OK) store.consume(NS, token);
  return found;
}

module.exports = {
  newToken, idempotencyKey, copyRows, create, lookup, cancel, NS, TOKEN, STATUS, ENTRY_KEYS,
};
