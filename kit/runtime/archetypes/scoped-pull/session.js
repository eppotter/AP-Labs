'use strict';

// Form sessions (Story 9.3, AD-7). Each open form is one entry in the store's
// `session` namespace, keyed by a 128-bit random id carried in the form's
// buttons and bound to the person who opened it. Keying by id, never by
// person + module, lets one person hold two forms on the same module.
//
// Every click re-sets the entry, so the 30-minute TTL counts from the last
// activity. Confirm consumes it (kit/runtime/store: get and delete in one
// synchronous call, leaving a `done` marker), so a double click or a replay
// finds no session and is told the list is running or done.
//
// Every function here is synchronous: nothing can run between a check and a
// consume.

const crypto = require('node:crypto');

const NS = 'session';
const ID_PATTERN = /^[0-9a-f]{32}$/;

// The outcome of looking a click's session up.
const STATUS = Object.freeze({
  OK: 'ok',
  EXPIRED: 'expired',
  NOT_YOURS: 'not-yours',
  RUNNING: 'running',
  DONE: 'done',
});

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

// Opens a session for person (a Slack id) on a module. Returns its id.
function open(store, { person, module, values = null }) {
  const id = newId();
  store.set(NS, id, { person, module, values });
  return id;
}

// What a click on session id by person finds. A consumed session reads as
// running or done; an unknown, malformed or expired one as expired. A session
// another person holds is refused before anything about it is used.
function lookup(store, id, person) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { status: STATUS.EXPIRED };
  const s = store.get(NS, id);
  if (s === undefined) {
    const marker = store.done(NS, id);
    if (!marker) return { status: STATUS.EXPIRED };
    const owner = marker.person || (marker.result && marker.result.person);
    if (owner !== person) return { status: STATUS.NOT_YOURS };
    return { status: marker.state === 'done' ? STATUS.DONE : STATUS.RUNNING };
  }
  if (s.person !== person) return { status: STATUS.NOT_YOURS };
  return { status: STATUS.OK, session: s };
}

// Records activity (and the checked values, or null to clear them), which
// restarts the 30-minute clock.
function save(store, id, session, values) {
  const next = { ...session, values };
  store.set(NS, id, next);
  return next;
}

// Confirm: looks the session up and, when it is this person's and holds
// checked values, consumes it in the same synchronous call. Returns the
// lookup, plus consumed: true only when this call consumed it.
function consume(store, id, person) {
  const found = lookup(store, id, person);
  if (found.status !== STATUS.OK || !found.session.values) return found;
  store.consume(NS, id);
  // The store's marker says only "running"; this one also names the person,
  // so a replay by someone else is refused, not told about the run.
  store.set('done', `${NS}:${id}`, { state: 'running', person });
  return { ...found, consumed: true };
}

// Records that a consumed session's run finished, for "already done".
function finish(store, id, person) {
  store.finish(NS, id, { person });
}

module.exports = {
  open, lookup, save, consume, finish, STATUS, ID_PATTERN,
};
