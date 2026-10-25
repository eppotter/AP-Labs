'use strict';

// The approval entry (Story 10.2, AD-15). Made when a Push click shows the
// preview, kept in the store's `approval` namespace for 30 minutes under an
// opaque token: 128 bits from the CSPRNG, the only thing the Approve and
// Cancel buttons carry.
//
//   { person, module, runId, destination, listName, rows, skipped, skippedIds,
//     idempotencyKey, originalKey, retry }
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
//   skippedIds       those rows' row ids, as strings (id-shaped, never contact
//                    data): the push leaves them out, so the write gets exactly
//                    the rows the preview said will send, whatever the
//                    connector's apply re-checks (review R1-1).
//
//   originalKey      the first push's idempotency key (equal to
//                    idempotencyKey on a preview's entry).
//   retry            false on a preview's entry; true on a retry entry.
//
// A partly failed push that is safe to retry (details.retrySafe === true) is
// offered "Retry the failed ones" (decision 6, DEP-013, review R2-1):
// retryEntry() stores, under a new token for 30 minutes, an entry for the
// same person and list holding ONLY the failed rows, under its own key
// derived from the first push's: sha256 of the canonical JSON
// [originalKey, "retry", sortedFailedIds]. So a retry never re-sends a row
// that went, whether or not the connector honours its per-item keys, and a
// second retry of the same failed set reuses the same key (replay-safe; the
// same key with other input would be an IdempotencyConflict).
//
// Every function here is synchronous: nothing can run between a check and a
// consume (AD-7).

const crypto = require('node:crypto');

const NS = 'approval';
const TOKEN = /^[0-9a-f]{32}$/;
const ENTRY_KEYS = Object.freeze(['person', 'module', 'runId', 'destination', 'listName', 'rows', 'skipped', 'skippedIds', 'idempotencyKey', 'originalKey', 'retry']);
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
  person, module, runId, destination, listName, rows, skipped = [], skippedIds = [], idempotencyKey: key,
}) {
  const token = newToken();
  store.set(NS, token, Object.freeze({
    person,
    module,
    runId,
    destination,
    listName,
    rows: Object.freeze(copyRows(rows).map(Object.freeze)),
    skipped: reasonsOf(skipped),
    skippedIds: Object.freeze(skippedIds.map((id) => String(id))),
    idempotencyKey: key,
    originalKey: key,
    retry: false,
  }));
  return token;
}

// The row ids (as strings) of the rows a connector's refs name, matched by
// row id: a ref is the value of the write.send field that carries the row
// id. null when that field isn't sent, or a ref names no row, several rows
// or the same row twice: the caller then fails closed. Used for the dry
// run's skipped refs (review R1-1) and a PartialFailure's failedRefs (R2-1).
function rowIdsForRefs(mod, rows, refs) {
  if (!refs.length) return [];
  if (!Object.values(mod.write.send).includes(mod.row_id)) return null;
  const ids = [];
  for (const raw of refs) {
    const ref = raw !== undefined && raw !== null ? String(raw) : null;
    const hits = ref === null ? [] : rows.filter((r) => String(r[mod.row_id]) === ref);
    if (hits.length !== 1) return null;
    ids.push(String(hits[0][mod.row_id]));
  }
  return new Set(ids).size === ids.length ? ids : null;
}

// A retry's key: sha256 of the canonical JSON [originalKey, "retry", ids sorted].
function retryKey(originalKey, failedIds) {
  const ids = failedIds.map((id) => String(id)).sort();
  return crypto.createHash('sha256').update(JSON.stringify([String(originalKey), 'retry', ids])).digest('hex');
}

// The retry entry for a partly failed push: the same person and list, only
// the rows whose row ids are failedIds, under the derived retry key. Returns
// the new token.
function retryEntry(store, stored, mod, failedIds) {
  const failed = new Set(failedIds.map((id) => String(id)));
  const rows = stored.rows.filter((r) => failed.has(String(r[mod.row_id])));
  if (rows.length !== failed.size) throw new Error('retry rows must match the failed ids one to one');
  const token = newToken();
  store.set(NS, token, Object.freeze({
    person: stored.person,
    module: stored.module,
    runId: stored.runId,
    destination: stored.destination,
    listName: stored.listName,
    rows: Object.freeze(copyRows(rows).map(Object.freeze)),
    skipped: Object.freeze([]),
    skippedIds: Object.freeze([]),
    idempotencyKey: retryKey(stored.originalKey, [...failed]),
    originalKey: stored.originalKey,
    retry: true,
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
  newToken, idempotencyKey, retryKey, rowIdsForRefs, copyRows, create, retryEntry, lookup, cancel, NS, TOKEN, STATUS, ENTRY_KEYS, ACTION,
};
