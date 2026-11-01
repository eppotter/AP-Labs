'use strict';

// Brightside's appointment emails (plan brightside-v1, D14, GRD-010, Story
// 20.1): two fixed templates, a reminder and a change notice. No AI writes
// or polishes them, so the preview is exactly what is sent and no customer
// name or appointment goes to the AI (GRD-005).
//
//   const { subject, body } = render({ first_name, kind, visit_date, window, crew_name, package_name,
//     before_date, before_window, before_crew_name, reason });
//
// What an email may hold, and nothing else (D14): the first name, the service
// date, the arrival window (morning or afternoon, the fixture's vocabulary),
// the crew's name, the package, for a change what it was before and a fixed
// reason line, and the fixed sign-off with the synthetic office phone
// 555-0100 (GRD-007's range). Never a street address, postal code,
// coordinate, price, another customer, a staff name or a route's other
// stops: render refuses any field it doesn't name.
//
// A reminder takes no before values and no reason. A change notice takes all
// three before values (from scheduled_visits, status 'scheduled', SQLsmith
// P1-5) and a reason key, and is refused when the date, the window and the
// crew are all unchanged (a move within the same window is not a change).
// Each refusal throws an Error naming the field, never its value.

const KINDS = Object.freeze(['reminder', 'change']);
const WINDOWS = Object.freeze(['morning', 'afternoon']);

// The reason line by the route skill (the routing-map screen) the change came
// from (D14).
const REASONS = Object.freeze({
  'route-editor': "we've improved the day's route",
  cancellation: 'an earlier slot opened up',
  'crew-out': 'our team for that day is unavailable',
  'add-stop': "we've adjusted the day's schedule",
});

const FIELDS = Object.freeze([
  'first_name', 'kind', 'visit_date', 'window', 'crew_name', 'package_name',
  'before_date', 'before_window', 'before_crew_name', 'reason',
]);
const BEFORE = Object.freeze(['before_date', 'before_window', 'before_crew_name']);

const PHONE = '555-0100';
const REPLY = `Reply to this email, or call us on ${PHONE}, and we'll find a time that suits you.`;
const SIGN_OFF = 'The Brightside Home Cleaning team';

// Longest text field values, in characters.
const MAX = Object.freeze({ first_name: 40, crew_name: 60, package_name: 60 });

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const absent = (v) => v === undefined || v === null;

// A one-line plain text value: no control characters (line breaks included),
// trimmed, not empty, at most max characters.
function text(fields, name) {
  const v = fields[name];
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  const t = v.trim();
  if (!t) throw new Error(`${name} must not be empty`);
  if (/\p{Cc}/u.test(t)) throw new Error(`${name} must be one line of plain text`);
  if (Array.from(t).length > MAX[name]) throw new Error(`${name} must be at most ${MAX[name]} characters`);
  return t;
}

// A calendar date "YYYY-MM-DD".
function date(fields, name) {
  const v = fields[name];
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${name} must be a date (YYYY-MM-DD)`);
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) throw new Error(`${name} must be a real date`);
  return v;
}

function windowOf(fields, name) {
  const v = fields[name];
  if (!WINDOWS.includes(v)) throw new Error(`${name} must be one of ${WINDOWS.join(', ')}`);
  return v;
}

// "Thursday, October 1, 2026": fixed words, no locale data.
function longDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// The checked fields: { kind, first_name, visit_date, window, crew_name,
// package_name } and, for a change, { before: { date, window, crew_name }, reason }.
function check(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('the email fields must be an object');
  const extra = Object.keys(fields).filter((k) => !FIELDS.includes(k));
  if (extra.length) throw new Error(`fields not allowed in an email: ${extra.join(', ')} (allowed: ${FIELDS.join(', ')})`);
  if (!KINDS.includes(fields.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const out = {
    kind: fields.kind,
    first_name: text(fields, 'first_name'),
    visit_date: date(fields, 'visit_date'),
    window: windowOf(fields, 'window'),
    crew_name: text(fields, 'crew_name'),
    package_name: text(fields, 'package_name'),
  };
  if (out.kind === 'reminder') {
    const given = [...BEFORE, 'reason'].filter((k) => !absent(fields[k]));
    if (given.length) throw new Error(`a reminder takes no ${given.join(', ')}`);
    return out;
  }
  const before = { date: date(fields, 'before_date'), window: windowOf(fields, 'before_window'), crew_name: text(fields, 'before_crew_name') };
  if (!Object.hasOwn(REASONS, fields.reason)) throw new Error(`reason must be one of ${Object.keys(REASONS).join(', ')}`);
  if (before.date === out.visit_date && before.window === out.window && before.crew_name === out.crew_name) {
    throw new Error('a change notice needs a changed date, window or crew');
  }
  return { ...out, before, reason: fields.reason };
}

function reminder(f) {
  const when = longDate(f.visit_date);
  return {
    subject: `Reminder: your ${f.package_name} on ${when}`,
    body: [
      `Hi ${f.first_name},`,
      '',
      `This is a reminder of your ${f.package_name} on ${when}. ${f.crew_name} will arrive in the ${f.window}.`,
      '',
      `Need to change it? ${REPLY}`,
      '',
      SIGN_OFF,
    ].join('\n'),
  };
}

function change(f) {
  const when = longDate(f.visit_date);
  const changed = [];
  if (f.before.date !== f.visit_date) changed.push(`- Day: ${when} (before: ${longDate(f.before.date)})`);
  if (f.before.window !== f.window) changed.push(`- Arrival window: ${f.window} (before: ${f.before.window})`);
  if (f.before.crew_name !== f.crew_name) changed.push(`- Crew: ${f.crew_name} (before: ${f.before.crew_name})`);
  return {
    subject: `Your ${f.package_name} has changed: now ${when}`,
    body: [
      `Hi ${f.first_name},`,
      '',
      `We've changed your ${f.package_name}. It is now on ${when}, in the ${f.window}, with ${f.crew_name}.`,
      '',
      'What changed:',
      ...changed,
      '',
      `Why: ${REASONS[f.reason]}.`,
      '',
      'Sorry for the change.',
      '',
      REPLY,
      '',
      SIGN_OFF,
    ].join('\n'),
  };
}

// { kind, subject, body } for the fields, or throws (an unknown field, a
// missing or malformed one, a change that changes nothing).
function render(fields) {
  const f = check(fields);
  return Object.freeze({ kind: f.kind, ...(f.kind === 'reminder' ? reminder(f) : change(f)) });
}

module.exports = Object.freeze({
  render, KINDS, WINDOWS, REASONS, FIELDS, PHONE,
});
