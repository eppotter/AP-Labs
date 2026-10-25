'use strict';

// Scheduled jobs declared as data (Story 11.1, CAP-12, AD-16).
//
//   <app>/jobs.json      a list of { name, schedule, run, enabled }
//                        (kit/runtime/schema/jobs.schema.json)
//   <app>/jobs/<run>     the job file: exports an async run(ctx)
//
// No jobs.json means no jobs. The template ships none (kit/templates/job.md).
//
// Turning on (Q2, Q6): a job runs only when the profile's jobs.enabled is
// true, its own enabled is true, and APLABS_JOBS_OFF is unset. Any non-empty
// APLABS_JOBS_OFF means off, including "0" (fail safe, like APLABS_WRITES_OFF).
//
// Checked at startup, every problem at once, each naming the job and field:
//   - the schema and unique names, even with jobs off (Q5);
//   - the schedule (kit/runtime/jobs/schedule: UTC cron, 5-minute minimum, not
//     both day fields, runs within 5 years);
//   - the run path (B1): relative, no `..`, and after fs.realpathSync inside
//     <app>/jobs/ itself, so neither an absolute path nor a symlink can point
//     at a connector or anywhere else. The file must exist, even with jobs off.
//   - with jobs on, each enabled job's file is loaded and must export run(ctx).
//     With jobs off no job file is loaded (B2): its top-level code never runs.
//     loadJobs({ loadAll: true }) loads every entry's file, for npm test.
//
// What a job gets (Q3): ctx = { log, data, now, name }, frozen. log is the
// redacting logger (each line names the job), data the read-only query runner
// (run, describe; guardrails included; the parameter names a job passes are
// its declared ones), now the injected clock (a Date). No
// Slack client, no store, no connector. Job code is trusted, reviewed app code
// and is not sandboxed (AD-1); npm run check refuses Slack, #sdk and connector
// imports under <app>/jobs/ (kit/verify/job-imports.js).
//
// Running (Q4): each run logs one line at start and one at finish or failure,
// with the job name and duration in milliseconds; a failure logs the error
// through the redacting logger. A job that throws or rejects is logged and
// the app keeps running; its next run happens on schedule. A run still going
// when the next is due skips that next run ("still running"). Missed runs are
// never made up: the next run is always computed from the clock's now.
// Timers are armed for at most 24 hours and re-armed (B3), never for the full
// delay. One process only (AD-8: stop-then-start deploys).
//
// Stopping: stop() clears every timer and schedules nothing new. A run in
// progress is not awaited.

const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const { parseSchedule, nextRun, scheduleProblem } = require('./schedule');
const { DataUnavailable } = require('../errors');

const OFF_ENV = 'APLABS_JOBS_OFF';
const JOBS_FILE = 'jobs.json';
const JOBS_DIR = 'jobs';
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
const SCHEMA_FILE = path.join(__dirname, '../schema/jobs.schema.json');
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

let _validate = null;
function validator() {
  if (!_validate) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    _validate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')));
  }
  return _validate;
}

// { on, reason }: reason is 'APLABS_JOBS_OFF' or 'profile' when off, else null.
// The env var wins the wording: it is the stronger switch.
function jobsSwitch({ profile, env = process.env }) {
  if (typeof env[OFF_ENV] === 'string' && env[OFF_ENV] !== '') return { on: false, reason: OFF_ENV };
  if (!(profile && profile.jobs && profile.jobs.enabled === true)) return { on: false, reason: 'profile' };
  return { on: true, reason: null };
}

// The startup line's words: "on (n scheduled)", "off (profile)" or
// "off (APLABS_JOBS_OFF)".
function jobsWords(state, jobs = []) {
  if (!state.on) return `off (${state.reason})`;
  return `on (${jobs.filter((j) => j.enabled).length} scheduled)`;
}

const inside = (child, parent) => child.startsWith(`${parent}${path.sep}`);
const label = (entry, i) => (entry && typeof entry.name === 'string' && NAME.test(entry.name) ? `job "${entry.name}"` : `entry [${i}]`);

function schemaProblems(list) {
  const validate = validator();
  if (validate(list)) return [];
  const seen = new Set();
  const out = [];
  for (const e of validate.errors) {
    const m = /^\/(\d+)(?:\/([^/]+))?/.exec(e.instancePath);
    let text;
    if (!m) {
      text = `${JOBS_FILE}: ${e.message} (it is a list of { name, schedule, run, enabled })`;
    } else {
      const who = label(list[Number(m[1])], m[1]);
      if (e.keyword === 'additionalProperties') text = `${JOBS_FILE}: ${who}: unknown field "${e.params.additionalProperty}"`;
      else if (e.keyword === 'required') text = `${JOBS_FILE}: ${who}: field "${e.params.missingProperty}" is required`;
      else if (m[2]) text = `${JOBS_FILE}: ${who}: field "${m[2]}" ${e.message}`;
      else text = `${JOBS_FILE}: ${who}: ${e.message}`;
    }
    if (!seen.has(text)) { seen.add(text); out.push(text); }
  }
  return out;
}

// Resolves a run path inside <app>/jobs/ (B1). Returns { file } or { problem }.
function resolveRun(appDir, run) {
  const parts = run.split('/');
  if (path.isAbsolute(run) || /^[A-Za-z]:/.test(run)) return { problem: 'must be relative to jobs/, not an absolute path' };
  if (parts.some((p) => p === '..')) return { problem: 'must stay inside jobs/ (no "..")' };
  if (parts.some((p) => p === '' || p === '.')) return { problem: 'must be a plain relative path such as nightly-check.js' };
  const dir = path.join(appDir, JOBS_DIR);
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return { problem: `names ${run}, but the app has no ${JOBS_DIR}/ folder` };
  }
  let real;
  try {
    real = fs.realpathSync(path.join(dir, run));
  } catch {
    return { problem: `names ${run}, which does not exist in ${JOBS_DIR}/` };
  }
  if (!inside(real, realDir)) return { problem: `names ${run}, which resolves outside ${JOBS_DIR}/ (a symlink?): job files must live in ${JOBS_DIR}/` };
  if (!fs.statSync(real).isFile()) return { problem: `names ${run}, which is not a file` };
  return { file: real };
}

// Loads one job file. Returns { run } or { problem }.
function loadRun(file) {
  let mod;
  try {
    mod = require(file);
  } catch (err) {
    return { problem: `could not be loaded (${err && err.message ? String(err.message).split('\n')[0] : 'error'})` };
  }
  if (!mod || typeof mod.run !== 'function') return { problem: 'must export an async run(ctx)' };
  return { run: mod.run };
}

// Reads and checks <app>/jobs.json. Returns { jobs, problems, state }. jobs:
// frozen [{ name, schedule, cron, file, enabled, run? }]; run is set only for
// the jobs whose files were loaded (jobs on and the entry enabled, or loadAll).
// now: the clock's Date, for the "never runs" check.
function loadJobs({ appDir, profile, env = process.env, now = new Date(), loadAll = false }) {
  const state = jobsSwitch({ profile, env });
  const problems = [];
  const file = path.join(appDir, JOBS_FILE);
  if (!fs.existsSync(file)) return { jobs: [], problems, state };
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`${JOBS_FILE}: cannot be read (${err.code || err.message})`);
    return { jobs: [], problems, state };
  }
  const schema = schemaProblems(list);
  if (schema.length) return { jobs: [], problems: schema, state };

  const names = new Set();
  const jobs = [];
  list.forEach((entry, i) => {
    const who = label(entry, i);
    const before = problems.length;
    if (names.has(entry.name)) problems.push(`${JOBS_FILE}: ${who}: field "name" is used by another job`);
    names.add(entry.name);
    const why = scheduleProblem(entry.schedule, now);
    if (why) problems.push(`${JOBS_FILE}: ${who}: field "schedule" ${why}`);
    const where = resolveRun(appDir, entry.run);
    if (where.problem) problems.push(`${JOBS_FILE}: ${who}: field "run" ${where.problem}`);
    if (problems.length > before) return;
    const job = { name: entry.name, schedule: entry.schedule, cron: parseSchedule(entry.schedule), file: where.file, enabled: entry.enabled };
    if (loadAll || (state.on && entry.enabled)) {
      const loaded = loadRun(where.file);
      if (loaded.problem) {
        problems.push(`${JOBS_FILE}: ${who}: jobs/${entry.run} ${loaded.problem}`);
        return;
      }
      job.run = loaded.run;
    }
    jobs.push(Object.freeze(job));
  });
  return { jobs: problems.length ? [] : Object.freeze(jobs), problems, state };
}

const realTimers = Object.freeze({
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  },
  clear: (t) => clearTimeout(t),
});

// A job's frozen ctx. log lines name the job; data is the read-only runner.
function jobContext({ job, log, data, now }) {
  const named = (fields) => ({ ...(fields && typeof fields === 'object' ? fields : {}), job: job.name });
  return Object.freeze({
    name: job.name,
    now: () => now(),
    log: Object.freeze({
      info: (msg, fields) => log.info(msg, named(fields)),
      warn: (msg, fields) => log.warn(msg, named(fields)),
      error: (msg, fields) => log.error(msg, named(fields)),
    }),
    data: Object.freeze({
      // A job has no person's input: the names it passes are its declared ones.
      run: (sql, params = {}) => {
        if (!data) return Promise.reject(new DataUnavailable('no data source'));
        const declared = params && typeof params === 'object' ? Object.keys(params) : [];
        return data.run(sql, params, { declared });
      },
      describe: () => (data ? data.describe() : { source: null, label: null, available: false, problem: 'no data source' }),
    }),
  });
}

// Schedules the enabled jobs. now() returns a Date; timers { set(fn, ms),
// clear(t) } (injected by tests with a fake clock). Returns { start, stop,
// scheduled(): [{ name, next }] }.
function createScheduler({ jobs, log, data = null, now = () => new Date(), timers = realTimers }) {
  const active = jobs.filter((j) => j.enabled && typeof j.run === 'function').map((job) => ({
    job, next: null, timer: null, running: false, ctx: jobContext({ job, log, data, now }),
  }));
  let stopped = false;

  const elapsed = (start) => now().getTime() - start;

  function fire(s) {
    if (s.running) {
      log.warn('job skipped: still running', { job: s.job.name });
      return;
    }
    s.running = true;
    const start = now().getTime();
    log.info('job started', { job: s.job.name });
    Promise.resolve()
      .then(() => s.job.run(s.ctx))
      .then(
        () => log.info('job finished', { job: s.job.name, ms: elapsed(start) }),
        (err) => log.error('job failed', { job: s.job.name, ms: elapsed(start), err }),
      )
      .catch(() => {})
      .finally(() => { s.running = false; });
  }

  function arm(s) {
    if (stopped) return;
    const wait = Math.max(0, s.next.getTime() - now().getTime());
    s.timer = timers.set(() => tick(s), Math.min(wait, MAX_TIMER_MS));
  }

  // Woken by a timer: not due yet re-arms (at most 24 hours); due fires once
  // and computes the next run from now, so nothing missed is made up.
  function tick(s) {
    s.timer = null;
    if (stopped) return;
    const t = now();
    if (t.getTime() < s.next.getTime()) return arm(s);
    fire(s);
    plan(s, t);
  }

  function plan(s, from) {
    const next = nextRun(s.job.cron, from);
    if (!next) {
      s.next = null;
      log.warn('job has no next run; not scheduled', { job: s.job.name });
      return;
    }
    s.next = next;
    arm(s);
  }

  return {
    start() {
      for (const s of active) if (!s.timer && !stopped) plan(s, now());
    },
    stop() {
      stopped = true;
      for (const s of active) {
        if (s.timer) timers.clear(s.timer);
        s.timer = null;
      }
    },
    scheduled: () => active.map((s) => ({ name: s.job.name, next: s.next, running: s.running })),
  };
}

module.exports = { loadJobs, jobsSwitch, jobsWords, createScheduler, jobContext, resolveRun, OFF_ENV, JOBS_FILE, JOBS_DIR, MAX_TIMER_MS };
