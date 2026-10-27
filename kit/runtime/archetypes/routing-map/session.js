'use strict';

// Routing-map sessions (Story 15.4, AD-R16). In memory only: a session holds
// what the person picked (view, day, crew, zone) and the options last shown;
// for Routing's views never person data, a position or a name (Plan a route's
// exception is below). Its id, from crypto.randomUUID, is
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
// Street tiles (Story 15.10): each accepted click also gets an AbortSignal
// (signal(s)), aborted when a newer click comes in, when the view closes
// (Back or Close) or when the session is dropped, so the tile fetch for a
// draw nobody will see stops at once.
//
// Plan a route (Story 15.14, AD-R27) keeps its own state on the session too
// (screen 'route-editor'): the input, travel, distance, the order and its
// version, the names its list shows, and the crew and day's map positions
// and mosaic (AD-R12 amended), so a reorder reads nothing. They live in
// memory only, for the session's life, and go when it is dropped, closed or
// pruned; nothing here writes them anywhere. An expired session's lookup
// says which screen it was, so the person is told in that screen's words.
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

  // The draw in flight, if any, has nobody left to show to.
  const stopWork = (s) => {
    if (s.work) s.work.abort();
  };

  function remove(id) {
    const s = sessions.get(id);
    if (!s) return;
    stopWork(s);
    s.plan = null;
    sessions.delete(id);
  }

  function prune() {
    for (const [id, s] of sessions) if (!alive(s)) remove(id);
    // Still full: the oldest go first (a Map keeps insertion order).
    while (sessions.size >= max) remove(sessions.keys().next().value);
  }

  // A new session for this user's view. Returns it.
  function open({
    userId, viewId, moduleId, picks, screen = 'views',
  }) {
    prune();
    const s = {
      id: crypto.randomUUID(),
      userId,
      viewId,
      moduleId,
      screen,
      picks: { ...picks },
      options: null,
      seq: 0,
      expires: now() + ttlMs,
      work: null,
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
      remove(id);
      return { status: STATUS.EXPIRED, screen: s.screen };
    }
    if (s.userId !== userId || s.viewId !== viewId) return { status: STATUS.NOT_YOURS, sameUser: s.userId === userId };
    return { status: STATUS.OK, session: s };
  }

  // An accepted click: the session lives another 15 minutes and the click
  // takes the next number (and a fresh signal; the previous click's is
  // aborted). Returns that number.
  function next(s) {
    stopWork(s);
    s.work = new AbortController();
    s.seq += 1;
    s.expires = now() + ttlMs;
    return s.seq;
  }

  // The AbortSignal of the session's newest click.
  const signal = (s) => (s.work ? s.work.signal : AbortSignal.abort());

  // True when this session is still held but its 15 minutes have run out
  // (not when it was dropped or closed).
  const expired = (s) => sessions.get(s.id) === s && !alive(s);

  // True while number is the newest request and the session still exists.
  const isCurrent = (s, number) => sessions.get(s.id) === s && s.seq === number && alive(s);

  function drop(id) {
    remove(id);
  }

  // The view closed: its session goes, and its draw in flight stops.
  function closed({ userId, viewId }) {
    for (const [id, s] of sessions) if (s.userId === userId && s.viewId === viewId) remove(id);
  }

  return {
    open, lookup, next, signal, isCurrent, expired, drop, closed, get size() { return sessions.size; },
  };
}

module.exports = {
  createSessions, STATUS, TTL_MS, MAX_SESSIONS, ID_PATTERN,
};
