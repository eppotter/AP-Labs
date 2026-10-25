'use strict';

// Job schedules (Story 11.1, Q1, B3): a five-field cron expression evaluated
// in UTC, written in-house (no dependency).
//
//   minute hour day-of-month month day-of-week
//   0-59   0-23 1-31         1-12  0-7 (0 and 7 are Sunday)
//
// Each field is a list (`,`) of items; an item is `*`, a number, a range
// `a-b`, or `*` or a range with a step (`*/n`, `a-b/n`). Nothing else: no
// names (JAN, MON), no seconds, no time zones, no `@daily`, no `a/n`.
//
// Refused, besides bad syntax (scheduleProblem):
//   - limiting both day of month and day of week. Classic cron ORs them, which
//     surprises people; with at most one limited, "the day matches" is plain.
//     A field that covers its whole range (1-31, 0-6) limits nothing.
//   - running more often than every MIN_INTERVAL_MINUTES. Checked on the
//     times of day, counting the gap across midnight as if every day ran, so
//     the check can only refuse more, never less.
//   - never running: no run in the next SEARCH_YEARS (30 February).
//
// nextRun walks day by day, so the search is at most about 1,830 days of
// cheap set lookups, whatever the expression.

const SEARCH_YEARS = 5;
const MIN_INTERVAL_MINUTES = 5;
const MINUTE_MS = 60 * 1000;
const DAY_MINUTES = 24 * 60;

const FIELDS = Object.freeze([
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
]);

class ScheduleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScheduleError';
  }
}

const NUMBER = /^(0|[1-9][0-9]?)$/;
const ITEM = /^(?:(\*)|([0-9]+)(?:-([0-9]+))?)(?:\/([0-9]+))?$/;

function number(text, field) {
  if (!NUMBER.test(text)) throw new ScheduleError(`${field.name} "${text}" is not a number from ${field.min} to ${field.max}`);
  const n = Number(text);
  if (n < field.min || n > field.max) throw new ScheduleError(`${field.name} ${n} is outside ${field.min} to ${field.max}`);
  return n;
}

// One field's text to a sorted array of the values it allows.
function parseField(text, field) {
  const values = new Set();
  for (const item of text.split(',')) {
    const m = ITEM.exec(item);
    if (!m) throw new ScheduleError(`${field.name} "${text}" is not valid (use numbers, *, lists, ranges and steps; ${field.min} to ${field.max})`);
    const [, star, from, to, step] = m;
    let lo = field.min;
    let hi = field.max;
    if (!star) {
      lo = number(from, field);
      hi = to === undefined ? lo : number(to, field);
      if (hi < lo) throw new ScheduleError(`${field.name} range ${lo}-${hi} runs backwards`);
      // "5/10" (a start with a step) reads too many ways: refused.
      if (step !== undefined && to === undefined) throw new ScheduleError(`${field.name} "${item}": a step needs * or a range (for example */10 or 0-30/10)`);
    }
    let by = 1;
    if (step !== undefined) {
      if (!NUMBER.test(step) || Number(step) < 1 || Number(step) > field.max - field.min + 1) {
        throw new ScheduleError(`${field.name} step "${step}" must be from 1 to ${field.max - field.min + 1}`);
      }
      by = Number(step);
    }
    for (let v = lo; v <= hi; v += by) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

// Parses an expression. Returns a frozen { minutes, hours, days, months,
// weekdays, dayLimited, weekdayLimited } of value sets; throws ScheduleError.
function parseSchedule(expr) {
  if (typeof expr !== 'string') throw new ScheduleError('the schedule must be text: five fields');
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new ScheduleError(`"${expr}" must have five fields: minute hour day-of-month month day-of-week (UTC)`);
  const [minutes, hours, days, months, rawWeekdays] = parts.map((p, i) => parseField(p, FIELDS[i]));
  const weekdays = [...new Set(rawWeekdays.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return Object.freeze({
    minutes: new Set(minutes),
    hours: new Set(hours),
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays),
    // Sorted minutes of the day the schedule runs at.
    times: Object.freeze(hours.flatMap((h) => minutes.map((m) => h * 60 + m))),
    dayLimited: days.length < 31,
    weekdayLimited: weekdays.length < 7,
  });
}

// The smallest gap between two runs, in minutes, counting the gap from the
// last run of a day to the first of the next as if every day ran.
function minGapMinutes(s) {
  const t = s.times;
  let gap = DAY_MINUTES - t[t.length - 1] + t[0];
  for (let i = 1; i < t.length; i++) gap = Math.min(gap, t[i] - t[i - 1]);
  return gap;
}

const dayMatches = (s, d) => s.months.has(d.getUTCMonth() + 1) && s.days.has(d.getUTCDate()) && s.weekdays.has(d.getUTCDay());

// The first run strictly after `after` (a Date), or null when there is none
// in the next `years` years.
function nextRun(s, after, { years = SEARCH_YEARS } = {}) {
  const start = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  const limit = Date.UTC(start.getUTCFullYear() + years, start.getUTCMonth(), start.getUTCDate(), 23, 59);
  let day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let from = start.getUTCHours() * 60 + start.getUTCMinutes();
  while (day.getTime() <= limit) {
    if (dayMatches(s, day)) {
      const t = s.times.find((m) => m >= from);
      if (t !== undefined) {
        const run = day.getTime() + t * MINUTE_MS;
        return run <= limit ? new Date(run) : null;
      }
    }
    day = new Date(day.getTime() + DAY_MINUTES * MINUTE_MS);
    from = 0;
  }
  return null;
}

// Why an expression is refused, or null when it is fine. now: a Date.
function scheduleProblem(expr, now) {
  let s;
  try {
    s = parseSchedule(expr);
  } catch (e) {
    if (e instanceof ScheduleError) return e.message;
    throw e;
  }
  if (s.dayLimited && s.weekdayLimited) return 'it limits both day of month and day of week; limit only one';
  if (minGapMinutes(s) < MIN_INTERVAL_MINUTES) return `it can run more often than every ${MIN_INTERVAL_MINUTES} minutes`;
  if (!nextRun(s, now)) return `it never runs (no time in the next ${SEARCH_YEARS} years matches)`;
  return null;
}

module.exports = { parseSchedule, nextRun, scheduleProblem, minGapMinutes, ScheduleError, SEARCH_YEARS, MIN_INTERVAL_MINUTES, FIELDS };
