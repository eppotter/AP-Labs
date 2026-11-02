'use strict';

// The route row source (Story 20.3, plan brightside-v1 D14, D14a, AD-15
// amended): a named, gated second way rows reach the approval-write push.
// Every other approval-write module pushes the rows of a scoped-pull run
// record. A module whose manifest declares write.source "route" (and only
// such a module) pushes instead the visits a route skill's result changed.
// Route skills never save, so only the route session knows booked and
// suggested; this file carries what it knows to the preview, and nothing
// else.
//
// The record (store namespace `route`, 30 minutes, under a 128-bit token):
//
//   { person, session, module, skill, visits, held }
//
//   person    the Slack user who pressed Notify affected customers
//   session   the route session (kit/runtime/archetypes/routing-map) it
//             came from; take() must name the same one
//   module    the route-sourced module the person may open on that hub
//   skill     the routing-map screen the change came from: route-editor,
//             cancellation, crew-out or add-stop (its reason line, D14)
//   visits    [{ id, before: { date, window, crewId }, after: { date,
//             window, crewId, crewName } }]: the visits the route changed,
//             by the route session's own reading (before window or crew
//             may be null when the session doesn't know them)
//   held      [{ id, reason }]: visits the route touched but placed nowhere
//             (reason 'rebook' or 'cross-zone'), listed in the preview and
//             never emailed
//
// Ids are the module's row ids (scheduled_visits.scheduled_visit_id), whole
// numbers as text. take() consumes the record: one preview per press.
//
// The rows (rowsFor). The module's query binds $visit_ids, the record's ids
// as one string ("12,40,7"), from the record only, never from a click, and
// returns per visit its write.fields, among them the before values from the
// booking (before_date, before_window, before_crew_id: scheduled_visits with
// status 'scheduled', SQLsmith P1-5). The engine adds the after values from
// the record (after_date, after_window, after_crew_id, after_crew_name) and
// change_reason (the skill). Then, by the booking's own before values, a
// visit whose date, window and crew all equal the route's is not a change
// (a move within the same window, D14) and is held, listed, never sent; a
// visit the query doesn't return (cancelled, gone) is held too; and the
// record's held visits are held with their reason. Held rows use the
// module's write.hold field (Story 20.2), so the preview lists them and the
// connector never sees them.
//
// Startup (checkRouteModule): the module declares exactly one input,
// visit_ids (a required string with a pattern of comma-separated ids), the
// engine binds it; write.hold is declared; write.fields holds the before
// fields (which the query returns) and the route fields (which it must not:
// the engine sets them); the list name uses only {run_date}.

const crypto = require('node:crypto');
const { NOTICE_WORDS } = require('../../messages');

const NS = 'route';
const SOURCE = 'route';
const TOKEN = /^[0-9a-f]{32}$/;
const PARAM = 'visit_ids';
const SKILLS = Object.freeze(['route-editor', 'cancellation', 'crew-out', 'add-stop']);
const WINDOWS = Object.freeze(['morning', 'afternoon']);
const BEFORE_FIELDS = Object.freeze(['before_date', 'before_window', 'before_crew_id']);
const ROUTE_FIELDS = Object.freeze(['after_date', 'after_window', 'after_crew_id', 'after_crew_name', 'change_reason']);
// What a change is, for the push key (entry.changeKey): before, then after.
const CHANGE_FIELDS = Object.freeze([...BEFORE_FIELDS, 'after_date', 'after_window', 'after_crew_id']);
const HELD_REASONS = Object.freeze({ rebook: NOTICE_WORDS.rebook, 'cross-zone': NOTICE_WORDS.crossZone });
const VISIT_ID = /^[1-9][0-9]{0,9}$/;
const CREW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// At most this many visits in one record (the visits to email plus the held
// ones), and the ids as one string at most this long (the input's max_length).
const MAX_VISITS = 50;
const MAX_IDS_TEXT = 500;
const MAX_NAME = 100;

const isRouteSourced = (mod) => Boolean(mod && mod.write && mod.write.source === SOURCE);

class RouteRecordError extends Error {}
const bad = (what) => {
  throw new RouteRecordError(`route record: ${what}`);
};

const isDate = (v) => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const optional = (v, ok) => v === null || ok(v);
const isWindow = (v) => WINDOWS.includes(v);
const isCrew = (v) => typeof v === 'string' && CREW_ID.test(v);
const isName = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= MAX_NAME && !/\p{Cc}/u.test(v);

// A checked, frozen copy of the visits and held lists; throws on anything
// malformed (a programming fault: the routing-map archetype builds them).
function checked({ skill, visits, held }) {
  if (!SKILLS.includes(skill)) bad('skill');
  if (!Array.isArray(visits) || !Array.isArray(held)) bad('lists');
  const seen = new Set();
  const id = (v) => {
    if (typeof v !== 'string' || !VISIT_ID.test(v)) bad('id');
    if (seen.has(v)) bad('an id given twice');
    seen.add(v);
    return v;
  };
  const out = visits.map((v) => {
    if (!v || !v.before || !v.after) bad('visit');
    const { before: b, after: a } = v;
    if (!isDate(b.date) || !optional(b.window, isWindow) || !optional(b.crewId, isCrew)) bad('before');
    if (!isDate(a.date) || !isWindow(a.window) || !isCrew(a.crewId) || !optional(a.crewName, isName)) bad('after');
    return Object.freeze({
      id: id(v.id),
      before: Object.freeze({ date: b.date, window: b.window, crewId: b.crewId }),
      after: Object.freeze({
        date: a.date, window: a.window, crewId: a.crewId, crewName: a.crewName,
      }),
    });
  });
  const kept = held.map((h) => {
    if (!h || !Object.hasOwn(HELD_REASONS, h.reason)) bad('held reason');
    return Object.freeze({ id: id(h.id), reason: h.reason });
  });
  return { visits: Object.freeze(out), held: Object.freeze(kept) };
}

// The ids as the one string the query binds: "12,40,7".
const idsText = (record) => [...record.visits.map((v) => v.id), ...record.held.map((h) => h.id)].join(',');

// Whether a change set fits one record: { ok } or { tooMany: MAX_VISITS }.
function fits({ visits, held }) {
  const n = visits.length + held.length;
  const text = [...visits, ...held].map((v) => v.id).join(',');
  return n <= MAX_VISITS && text.length <= MAX_IDS_TEXT ? { ok: true } : { tooMany: MAX_VISITS };
}

// Stores the record; returns its token. Throws RouteRecordError on a
// malformed one, or when it doesn't fit.
function put(store, {
  person, session, module, skill, visits, held = [],
}) {
  if (typeof person !== 'string' || !person) bad('person');
  if (typeof session !== 'string' || !session) bad('session');
  if (typeof module !== 'string' || !module) bad('module');
  const lists = checked({ skill, visits, held });
  if (!fits(lists).ok) bad('too many visits');
  const token = crypto.randomBytes(16).toString('hex');
  store.set(NS, token, Object.freeze({
    person, session, module, skill, ...lists,
  }));
  return token;
}

// The record for this person and route session, consumed; null when it is
// expired, unknown, malformed, another person's or another session's (all
// alike: nothing about it is told).
function take(store, token, { person, session }) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const record = store.get(NS, token);
  if (record === undefined || record.person !== person || record.session !== session) return null;
  store.consume(NS, token, { person });
  return record;
}

const text = (v) => (v === null || v === undefined ? null : String(v));

// The rows to preview, in the record's order (the changed visits, then the
// held ones), each with exactly the module's write.fields. queryRows: what
// the module's query returned for idsText(record). Throws RouteRecordError
// when the query broke its grain (a visit twice) or named a visit the record
// doesn't hold.
function rowsFor(mod, record, queryRows) {
  const rowId = mod.row_id;
  const hold = mod.write.hold;
  const wanted = new Set([...record.visits.map((v) => v.id), ...record.held.map((h) => h.id)]);
  const byId = new Map();
  for (const r of queryRows) {
    const id = text(r[rowId]);
    if (!wanted.has(id)) bad('the query returned a visit the record does not hold');
    if (byId.has(id)) bad('the query returned a visit twice');
    byId.set(id, r);
  }
  const blank = (id) => ({ ...Object.fromEntries(mod.write.fields.map((f) => [f, null])), [rowId]: id });
  const base = (id) => {
    const q = byId.get(id);
    if (!q) return { row: { ...blank(id), [hold]: NOTICE_WORDS.notBooked() }, found: false };
    const row = Object.fromEntries(mod.write.fields.map((f) => [f, q[f] === undefined ? null : q[f]]));
    for (const f of ROUTE_FIELDS) row[f] = null;
    return { row, found: true };
  };
  const rows = [];
  for (const v of record.visits) {
    const { row, found } = base(v.id);
    if (found) {
      Object.assign(row, {
        after_date: v.after.date,
        after_window: v.after.window,
        after_crew_id: v.after.crewId,
        after_crew_name: v.after.crewName,
        change_reason: record.skill,
      });
      // The booking's own before values decide (D14, SQLsmith P1-5).
      const same = text(row.before_date) === v.after.date && text(row.before_window) === v.after.window
        && text(row.before_crew_id) === v.after.crewId;
      const already = typeof row[hold] === 'string' && row[hold].trim() !== '';
      if (same && !already) row[hold] = NOTICE_WORDS.notChanged();
    }
    rows.push(row);
  }
  for (const h of record.held) {
    const { row } = base(h.id);
    row[hold] = HELD_REASONS[h.reason]();
    rows.push(row);
  }
  return rows;
}

// Whether name appears in code as a whole identifier.
const identifierIn = (code, name) => new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_]|$)`, 'i').test(code);

// Every startup problem with a route-sourced module, as sentences naming the
// field. code: its SQL with comments blanked (scoped-pull codeText).
function checkRouteModule(mod, code) {
  if (!isRouteSourced(mod)) return [];
  const problems = [];
  const block = mod.write;
  const params = mod.parameters || [];
  const p = params[0];
  if (params.length !== 1 || !p || p.name !== PARAM || p.type !== 'string' || p.required !== true || !p.pattern || p.enum) {
    problems.push(`field "parameters" must declare exactly one input, "${PARAM}": a required string with a pattern (the engine binds it from the route record, never from a form)`);
  }
  if (block.hold === undefined) problems.push('field "write.hold" is required with write.source "route": unchanged, unbooked and held visits are listed with it, never sent');
  for (const f of BEFORE_FIELDS) {
    if (!block.fields.includes(f)) problems.push(`field "write.fields" must include "${f}" with write.source "route" (the booking's before value)`);
  }
  for (const f of ROUTE_FIELDS) {
    if (!block.fields.includes(f)) problems.push(`field "write.fields" must include "${f}" with write.source "route" (set by the engine from the route record)`);
    else if (identifierIn(code, f)) problems.push(`field "query" must not return "${f}": the engine sets it from the route record`);
  }
  if (/\{(?!run_date\})[^}]*\}/.test(block.list_name)) problems.push('field "write.list_name" may use only {run_date} with write.source "route"');
  return problems;
}

module.exports = {
  put, take, rowsFor, idsText, fits, checkRouteModule, isRouteSourced, RouteRecordError,
  NS, SOURCE, PARAM, SKILLS, BEFORE_FIELDS, ROUTE_FIELDS, CHANGE_FIELDS, MAX_VISITS, MAX_IDS_TEXT,
};
