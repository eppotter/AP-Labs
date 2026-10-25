'use strict';

// kit/runtime/jobs/schedule (Story 11.1, Q1, B3): the in-house five-field cron
// parser, evaluated in UTC, and the bounded next-run search.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSchedule, nextRun, scheduleProblem, minGapMinutes, ScheduleError, SEARCH_YEARS, MIN_INTERVAL_MINUTES } = require('../../kit/runtime/jobs/schedule');

const at = (iso) => new Date(iso);
const next = (expr, from) => {
  const d = nextRun(parseSchedule(expr), at(from));
  return d && d.toISOString();
};

test('the limits are the plan\'s: a 5-year search and a 5-minute minimum', () => {
  assert.equal(SEARCH_YEARS, 5);
  assert.equal(MIN_INTERVAL_MINUTES, 5);
});

test('a plain time runs next at that minute, in UTC, strictly after the start', () => {
  assert.equal(next('30 9 * * *', '2026-03-10T08:00:00Z'), '2026-03-10T09:30:00.000Z');
  assert.equal(next('30 9 * * *', '2026-03-10T09:30:00Z'), '2026-03-11T09:30:00.000Z', 'never the same minute again');
  assert.equal(next('30 9 * * *', '2026-03-10T09:29:59.999Z'), '2026-03-10T09:30:00.000Z');
});

test('UTC: a daylight-saving change elsewhere moves nothing', () => {
  // 29 March 2026 is the EU clock change; the job stays at 01:30 UTC.
  assert.equal(next('30 1 * * *', '2026-03-29T00:00:00Z'), '2026-03-29T01:30:00.000Z');
  assert.equal(next('30 1 * * *', '2026-03-29T01:30:00Z'), '2026-03-30T01:30:00.000Z');
});

test('a list, a range and a step', () => {
  assert.equal(next('0 6,18 * * *', '2026-03-10T07:00:00Z'), '2026-03-10T18:00:00.000Z', 'list');
  assert.equal(next('0 9-11 * * *', '2026-03-10T11:30:00Z'), '2026-03-11T09:00:00.000Z', 'range');
  assert.equal(next('*/15 * * * *', '2026-03-10T07:16:00Z'), '2026-03-10T07:30:00.000Z', 'step on *');
  assert.equal(next('10-40/10 8 * * *', '2026-03-10T08:21:00Z'), '2026-03-10T08:30:00.000Z', 'step on a range');
  assert.equal(next('10-40/10 8 * * *', '2026-03-10T08:40:00Z'), '2026-03-11T08:10:00.000Z');
  assert.equal(next('0 0 1,15 * *', '2026-03-02T00:00:00Z'), '2026-03-15T00:00:00.000Z');
});

test('month and weekday boundaries', () => {
  assert.equal(next('0 0 * 1 *', '2026-12-31T23:59:00Z'), '2027-01-01T00:00:00.000Z', 'year wrap into January');
  assert.equal(next('0 0 * 12 *', '2026-01-15T00:00:00Z'), '2026-12-01T00:00:00.000Z', 'December');
  assert.equal(next('0 0 31 * *', '2026-04-01T00:00:00Z'), '2026-05-31T00:00:00.000Z', 'April has no 31st');
  // 2026-03-15 is a Sunday.
  assert.equal(next('0 9 * * 0', '2026-03-10T00:00:00Z'), '2026-03-15T09:00:00.000Z', 'Sunday is 0');
  assert.equal(next('0 9 * * 7', '2026-03-10T00:00:00Z'), '2026-03-15T09:00:00.000Z', 'and 7');
  assert.equal(next('0 9 * * 6', '2026-03-10T00:00:00Z'), '2026-03-14T09:00:00.000Z', 'Saturday is 6');
  assert.equal(next('0 9 * * 1-5', '2026-03-13T10:00:00Z'), '2026-03-16T09:00:00.000Z', 'weekdays skip the weekend');
  assert.equal(next('59 23 * * *', '2026-02-28T23:59:00Z'), '2026-03-01T23:59:00.000Z', 'end of February');
});

test('29 February runs in the next leap year; 30 February never runs', () => {
  assert.equal(next('0 12 29 2 *', '2026-03-01T00:00:00Z'), '2028-02-29T12:00:00.000Z');
  assert.equal(next('0 12 30 2 *', '2026-03-01T00:00:00Z'), null);
  assert.equal(next('0 0 31 4 *', '2026-01-01T00:00:00Z'), null, '31 April');
});

test('the search stops 5 years ahead', () => {
  // 29 February from just after 2028's: next is 2032, inside 5 years.
  assert.equal(next('0 0 29 2 *', '2028-03-01T00:00:00Z'), '2032-02-29T00:00:00.000Z');
  assert.equal(nextRun(parseSchedule('0 0 29 2 *'), at('2028-03-01T00:00:00Z'), { years: 3 }), null, 'past the bound: none');
});

test('invalid expressions are refused, saying why', () => {
  const bad = {
    '': /five fields/,
    '* * * *': /five fields/,
    '* * * * * *': /five fields/,
    '60 * * * *': /minute.*0 to 59/,
    '0 24 * * *': /hour.*0 to 23/,
    '0 0 0 * *': /day of month.*1 to 31/,
    '0 0 * 13 *': /month.*1 to 12/,
    '0 0 * * 8': /day of week.*0 to 7/,
    '0 0 * JAN *': /month/,
    '0 0 * * MON': /day of week/,
    '5-1 * * * *': /range/,
    '*/0 * * * *': /step/,
    '1,,2 * * * *': /minute/,
    '-1 * * * *': /minute/,
    '+5 * * * *': /minute/,
    '5/10 * * * *': /minute/,
    '@daily': /five fields/,
    '0 0 * * * UTC': /five fields/,
    '1.5 * * * *': /minute/,
  };
  for (const [expr, why] of Object.entries(bad)) {
    assert.throws(() => parseSchedule(expr), (e) => e instanceof ScheduleError && why.test(e.message), JSON.stringify(expr));
  }
  assert.throws(() => parseSchedule(42), ScheduleError);
});

test('a schedule may not limit both day of month and day of week', () => {
  assert.match(scheduleProblem('0 9 1 * 1', at('2026-01-01T00:00:00Z')), /both day of month and day of week/);
  assert.match(scheduleProblem('0 9 1-7 * 1-5', at('2026-01-01T00:00:00Z')), /both day of month and day of week/);
  // A field that covers its whole range limits nothing.
  assert.equal(scheduleProblem('0 9 1-31 * 1', at('2026-01-01T00:00:00Z')), null);
  assert.equal(scheduleProblem('0 9 1 * 0-6', at('2026-01-01T00:00:00Z')), null);
});

test('a schedule that can run more often than every 5 minutes is refused', () => {
  const t = at('2026-01-01T00:00:00Z');
  for (const expr of ['* * * * *', '*/4 * * * *', '0,3 * * * *', '0-10 9 * * *', '58 23 * * *,']) {
    assert.ok(scheduleProblem(expr, t), expr);
  }
  assert.match(scheduleProblem('*/4 * * * *', t), /more often than every 5 minutes/);
  assert.match(scheduleProblem('0,57 0 * * *', t) || '', /^$/, 'a 57-minute gap and a 23-hour wrap are fine');
  assert.match(scheduleProblem('0 0,23 * * *', t) || '', /^$/);
  // Across midnight: 23:58 then 00:00 the next day is 2 minutes.
  assert.match(scheduleProblem('0,58 0,23 * * *', t), /more often than every 5 minutes/);
  for (const expr of ['*/5 * * * *', '0 * * * *', '0 9 * * 1-5', '0,5,10 * * * *']) {
    assert.equal(scheduleProblem(expr, t), null, expr);
  }
  assert.equal(minGapMinutes(parseSchedule('*/5 * * * *')), 5);
  assert.equal(minGapMinutes(parseSchedule('0 9 * * *')), 1440);
});

test('a schedule with no run in the next 5 years is refused as "never runs"', () => {
  assert.match(scheduleProblem('0 0 30 2 *', at('2026-01-01T00:00:00Z')), /never runs/);
  assert.match(scheduleProblem('nonsense', at('2026-01-01T00:00:00Z')), /five fields/);
});

test('the search is bounded in time, even for the sparsest schedule', () => {
  const started = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) nextRun(parseSchedule('0 0 30 2 *'), at('2026-01-01T00:00:00Z'));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2000, `50 full searches took ${ms}ms`);
});
