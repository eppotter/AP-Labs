'use strict';

// Routing-map sessions (Story 15.4, AD-R16). In memory only: a session holds
// what the person picked (view, day, crew, zone) and the options last shown,
// never person data, a position or a name. Its id, from crypto.randomUUID, is
// the view's private_metadata and nothing else.
//
// A session is bound to the Slack user who opened it and the view it lives in
// (lookup refuses a click from another user or another view). It expires 15
// minutes after its last accepted click (TTL_MS), the same as a map file's
// record, so an expired session is told so and never draws again.
//
// Request order (F4): every accepted click takes the next number of the
// session's sequence (next), which only goes up. A draw holds its number and
// asks isCurrent(session, number) before it uploads and again before it shows
// its map: a newer click makes it abandon, whatever order the work finishes.
//
// Every function is synchronous, so nothing runs between a check and a
// change. The clock is now(), Date.now by default (node:test mock.timers
// moves it).

const crypto = require('node:crypto');

const TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 1000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const STATUS = Object.freeze({
  OK: 'ok',
  EXPIRED: 'expired',
  NOT_YOURS: 'not-yours',
});

function createSessions({ now = () => Date.now(), ttlMs = TTL_MS, max = MAX_SESSIONS } = {}) {
  const sessions = new Map();

  const alive = (s) => s.expires > now();

  function prune() {
    for (const [id, s] of sessions) if (!alive(s)) sessions.delete(id);
    // Still full: the oldest go first (a Map keeps insertion order).
    while (sessions.size >= max) sessions.delete(sessions.keys().next().value);
  }

  // A new session for this user's view. Returns it.
  function open({ userId, viewId, moduleId, picks }) {
    prune();
    const s = {
      id: crypto.randomUUID(),
      userId,
      viewId,
      moduleId,
      picks: { ...picks },
      options: null,
      seq: 0,
      expires: now() + ttlMs,
    };
    sessions.set(s.id, s);
    return s;
  }

  // The session a click names, checked against the clicking user and view.
// NOT_YOURS says whether it is the same user (their own other view) or not.
  function lookup(id, { userId, viewId }) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { status: STATUS.EXPIRED };
    const s = sessions.get(id);
    if (!s) return { status: STATUS.EXPIRED };
    if (!alive(s)) {
      sessions.delete(id);
      return { status: STATUS.EXPIRED };
    }
    if (s.userId !== userId || s.viewId !== viewId) return { status: STATUS.NOT_YOURS, sameUser: s.userId === userId };
    return { status: STATUS.OK, session: s };
  }

  // An accepted click: the session lives another 15 minutes and the click
  // takes the next number. Returns that number.
  function next(s) {
    s.seq += 1;
    s.expires = now() + ttlMs;
    return s.seq;
  }

  // True while number is the newest request and the session still exists.
  const isCurrent = (s, number) => sessions.get(s.id) === s && s.seq === number && alive(s);

  function drop(id) {
    sessions.delete(id);
  }

  // The view closed: its session goes.
  function closed({ userId, viewId }) {
    for (const [id, s] of sessions) if (s.userId === userId && s.viewId === viewId) sessions.delete(id);
  }

  return {
    open, lookup, next, isCurrent, drop, closed, get size() { return sessions.size; },
  };
}

module.exports = {
  createSessions, STATUS, TTL_MS, MAX_SESSIONS, ID_PATTERN,
};
