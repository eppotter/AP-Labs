'use strict';

// Which booked visits a route skill's result changes (Story 20.3, plan
// brightside-v1 D14): the input of "Notify affected customers (N)", which
// hands them to the approval-write route row source
// (kit/runtime/archetypes/approval-write/route-source.js). Pure and
// synchronous: nothing is read, logged or sent here.
//
// A visit is changed when its date, its arrival window (morning or
// afternoon: a start before 12:00 is morning) or its crew differs. A move
// within the same window is not a change. The after values are the
// suggestion's; the before values here are the route session's reading of
// the booking (the stop's booked start and crew), and the booking itself
// (scheduled_visits, status 'scheduled') decides again when the notices are
// previewed (route-source rowsFor).
//
// The route skills:
//   Plan a route, Add a stop, and Customer cancellation's Fill with #n (the
//   editor's plan, ofPlan): every stop of the crew's day, timed in the
//   current order. Its window is the new one only when the current order
//   moves its start across noon compared with the booked order timed the
//   same way (from the Office): the timing model's own offset from the
//   booked times is never a change, so a day shown as booked changes
//   nothing. The stop Fill with #n moved up changes its date (and its crew
//   when it was booked on another). An added stop (Add a stop) is not a
//   booked visit, so it is never emailed (DEP: a booking confirmation).
//   Customer cancellation's cancelled visit is not on the day at all.
//   Crew out (the Route change view, ofCrewOut): each stop placed on another
//   crew of its zone changes crew (and its window when its new start crosses
//   noon); each other stop of the zone whose start moved across noon changes
//   window. A stop recommended for another zone is not placed, and a stop to
//   rebook has no slot: both are held (listed, never emailed).
//
// Only a visit id the booking can name (a whole number) is ever returned.
// Each visit: { id, before: { date, window, crewId }, after: { date, window,
// crewId, crewName } }; held: [{ id, reason: 'rebook' | 'cross-zone' }].

const NOON = 12 * 60;
const VISIT_ID = /^[1-9][0-9]{0,9}$/;

const windowOf = (m) => (Number.isInteger(m) ? (m < NOON ? 'morning' : 'afternoon') : null);
const isVisit = (id) => typeof id === 'string' && VISIT_ID.test(id);

function changed(before, after) {
  if (before.date !== after.date) return true;
  if (before.window !== null && before.window !== after.window) return true;
  return before.crewId !== null && before.crewId !== after.crewId;
}

// The editor's plan (./editor.js): p as it stands; startsOf(order, input):
// Map stopId -> start, the engine's timing of that order on that input.
// crewName: the crew's name from the labels, or null when they gave none.
function ofPlan(p, startsOf, crewName) {
  const added = p.added ? p.added.stopId : null;
  const now = startsOf(p.order, p.input);
  const baseInput = added ? { ...p.input, stops: p.input.stops.filter((st) => st.stopId !== added) } : p.input;
  const baseOrder = added ? (p.bookedBase || p.booked).filter((id) => id !== added) : p.booked;
  const base = startsOf(baseOrder, baseInput);
  const stopOf = new Map(p.input.stops.map((st) => [st.stopId, st]));
  const visits = [];
  for (const id of p.order) {
    if (id === added || !isVisit(id)) continue;
    const filled = Boolean(p.filled && p.filled.stopId === id);
    const st = stopOf.get(id);
    const before = filled
      ? { date: p.filled.from, window: null, crewId: typeof p.filled.fromCrew === 'string' ? p.filled.fromCrew : null }
      : { date: p.day, window: windowOf(st && st.start), crewId: p.crewId };
    const nowWindow = windowOf(now.get(id));
    const window = filled || before.window === null || nowWindow !== windowOf(base.get(id)) ? nowWindow : before.window;
    const after = {
      date: p.day, window, crewId: p.crewId, crewName,
    };
    if (window && changed(before, after)) visits.push({ id, before, after });
  }
  return { visits, held: [] };
}

// Crew out's Route change (./views.js change): result is placeOrphans's,
// day the day, stopOf(id) the input's stop (its booked start and crew),
// shown(crewId) whether the view shows that crew (the out crew's zone).
// Crew names are added by the caller from the labels (named).
function ofCrewOut({
  result, day, stopOf, shown,
}) {
  const visits = [];
  const held = [];
  for (const m of result.moves) {
    if (!isVisit(m.stopId) || !shown(m.fromCrew)) continue;
    if (m.crossZone || m.recommendation) {
      held.push({ id: m.stopId, reason: 'cross-zone' });
      continue;
    }
    if (!shown(m.toCrew)) continue;
    const st = stopOf(m.stopId);
    const before = { date: day, window: windowOf(st && st.start), crewId: m.fromCrew };
    const after = {
      date: day, window: windowOf(m.start), crewId: m.toCrew, crewName: null,
    };
    if (after.window && changed(before, after)) visits.push({ id: m.stopId, before, after });
  }
  for (const s of result.shifted) {
    if (!isVisit(s.stopId) || !shown(s.crewId)) continue;
    const st = stopOf(s.stopId);
    const booked = windowOf(st && st.start);
    const nowWindow = windowOf(s.start);
    if (!booked || !nowWindow || nowWindow === windowOf(s.previousStart)) continue;
    const before = { date: day, window: booked, crewId: s.crewId };
    const after = {
      date: day, window: nowWindow, crewId: s.crewId, crewName: null,
    };
    if (changed(before, after)) visits.push({ id: s.stopId, before, after });
  }
  for (const u of result.unplaced) {
    const st = stopOf(u.stopId);
    if (isVisit(u.stopId) && st && shown(st.currentCrewId)) held.push({ id: u.stopId, reason: 'rebook' });
  }
  return { visits, held };
}

// The change set with each after crew's name from the labels (a Map of node
// id to { crewName }); a crew the labels don't name gets null, so its
// notice can't render and nothing is sent for it.
function named(set, labels) {
  const nameOf = (crewId) => {
    const l = labels.get(`crew:${crewId}`) || {};
    return typeof l.crewName === 'string' && l.crewName.trim() ? l.crewName : null;
  };
  return {
    visits: set.visits.map((v) => ({ ...v, after: { ...v.after, crewName: nameOf(v.after.crewId) } })),
    held: set.held.slice(),
  };
}

module.exports = {
  ofPlan, ofCrewOut, named, windowOf, NOON,
};
