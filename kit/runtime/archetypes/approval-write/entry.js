'use strict';

// The approval entry (Story 10.2, AD-15). Made when a Push click shows the
// preview, kept in the store's `approval` namespace for 30 minutes under an
// opaque token: 128 bits from the CSPRNG, the only thing the Approve and
// Cancel buttons carry.
//
//   { person, module, runId, destination, listName, rows, skipped, idempotencyKey }
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
//   skipped          the reasons the preview's dry-run plan gave for the rows
//                    the tool would refuse (one per skipped row, no refs), so
//                    the push's reply counts them (Story 10.3, Q5).
//
// A partly failed push that is safe to retry (details.retrySafe === true) is
// offered "Retry the failed ones": recreate() stores the SAME entry (person,
// rows, key, list) under a new token for 30 minutes (decision 6, DEP-013), so
// the retry sends the same input under the same key and the connector skips
// what already went.
//
// Every function here is synchronous: nothing can run between a check and a
// consume (AD-7).

const crypto = require('node:crypto');

const NS = 'approval';
const TOKEN = /^[0-9a-f]{32}$/;
const ENTRY_KEYS = Object.freeze(['person', 'module', 'runId', 'destination', 'listName', 'rows', 'skipped', 'idempotencyKey']);
// The longest skip reason kept (the preview shows the same cut).
const REASON_MAX = 60;

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
// The skip reasons as short strings, one per skipped row (no refs).
function reasonsOf(skipped) {
  return Object.freeze((Array.isArray(skipped) ? skipped : []).map((s) => {
    const raw = s && typeof s.reason === 'string' && s.reason.trim() ? s.reason.trim() : 'refused by the tool';
    return Array.from(raw.replace(/[\r\n\t]+/g, ' ')).slice(0, REASON_MAX).join('');
  }));
}

function create(store, {
  person, module, runId, destination, listName, rows, skipped = [], idempotencyKey: key,
}) {
  const token = newToken();
  store.set(NS, token, Object.freeze({
    person, module, runId, destination, listName, rows: Object.freeze(copyRows(rows).map(Object.freeze)), skipped: reasonsOf(skipped), idempotencyKey: key,
  }));
  return token;
}

// The same entry (same person, rows, list and key) under a new token, for
// "Retry the failed ones". Returns the new token.
function recreate(store, stored) {
  const token = newToken();
  store.set(NS, token, Object.freeze({
    person: stored.person,
    module: stored.module,
    runId: stored.runId,
    destination: stored.destination,
    listName: stored.listName,
    rows: Object.freeze(copyRows(stored.rows).map(Object.freeze)),
    skipped: Object.freeze([...stored.skipped]),
    idempotencyKey: stored.idempotencyKey,
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
// the same call, marked as cancelled (an Approve after it is "no longer
// valid", never "already done"). Returns the lookup.
function cancel(store, token, person) {
  const found = lookup(store, token, person);
  if (found.status === STATUS.OK) store.consume(NS, token, { person, action: ACTION.cancel });
  return found;
}

// What consumed a token, in its done marker.
const ACTION = Object.freeze({ approve: 'approve', cancel: 'cancel' });

module.exports = {
  newToken, idempotencyKey, copyRows, create, recreate, lookup, cancel, NS, TOKEN, STATUS, ENTRY_KEYS, ACTION,
};
