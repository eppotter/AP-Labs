'use strict';

// kit/runtime/jobs (Story 11.1): jobs.json is checked at startup, job files stay
// inside <app>/jobs/, nothing loads while jobs are off, and the scheduler runs
// each job on a fake clock: on time, logged, never overlapping, never catching
// up, with timers capped at 24 hours.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateProfile } = require('../../kit/lib/profile');
const { createLog } = require('../../kit/runtime/log');
const { configuredAppDirs } = require('../../kit/verify/write-path');
const {
  loadJobs, jobsSwitch, jobsWords, createScheduler, jobContext, OFF_ENV, MAX_TIMER_MS,
} = require('../../kit/runtime/jobs');
const { parseSchedule } = require('../../kit/runtime/jobs/schedule');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(__dirname, '../fixtures/runtime/jobs');
const NOW = new Date('2026-03-10T08:00:00Z');

const profile = (enabled) => validateProfile({
  schema_version: 1, client: { id: 'j', name: 'J' }, users: [{ id: 'a', name: 'A', role: 'admin' }],
  ...(enabled === undefined ? {} : { jobs: { enabled } }),
});
const ON = profile(true);

function tmpApp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-jobs-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const JOB = "module.exports = { run: async (ctx) => { ctx.log.info('ran'); } };\n";
const entry = (over = {}) => ({ name: 'nightly', schedule: '0 2 * * *', run: 'nightly.js', enabled: true, ...over });
function app(t, entries, files = { 'jobs/nightly.js': JOB }) {
  const dir = tmpApp(t);
  put(dir, 'jobs.json', JSON.stringify(entries));
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  return dir;
}
const load = (appDir, opts = {}) => loadJobs({ appDir, profile: ON, env: {}, now: NOW, ...opts });

// A fake clock: now() and timers, fired in time order by advance(ms).
const flush = () => new Promise((r) => setImmediate(r));
function fakeClock(iso = '2026-03-10T08:00:00Z') {
  let t = Date.parse(iso);
  let seq = 0;
  const pending = [];
  const armed = [];
  return {
    now: () => new Date(t),
    armed,
    pending: () => pending.map((h) => h.at - t),
    timers: {
      set(fn, ms) { const h = { at: t + ms, fn, id: seq++ }; pending.push(h); armed.push(ms); return h; },
      clear(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    },
    // Moves the clock without firing anything (the process was asleep).
    jump(ms) { t += ms; },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at || a.id - b.id);
        const h = pending[0];
        if (!h || h.at > end) break;
        pending.shift();
        t = Math.max(t, h.at);
        h.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}
function capture(clock) {
  const lines = [];
  const log = createLog({ write: (line) => lines.push(JSON.parse(line)), now: clock ? clock.now : undefined });
  return { log, lines, msgs: () => lines.map((l) => l.msg) };
}
const job = (name, run, schedule = '*/5 * * * *') => ({ name, schedule, cron: parseSchedule(schedule), file: `/x/${name}.js`, enabled: true, run });

// --- the registry -------------------------------------------------------------

test('no jobs.json means no jobs', (t) => {
  const r = load(tmpApp(t));
  assert.deepEqual(r.jobs, []);
  assert.deepEqual(r.problems, []);
});

test('a valid jobs.json with jobs on loads each enabled job\'s run(ctx)', () => {
  const r = load(path.join(FIXTURES, 'app'));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.jobs.map((j) => [j.name, j.enabled, typeof j.run]), [['heartbeat', true, 'function'], ['paused', false, 'undefined']]);
  assert.equal(jobsWords(r.state, r.jobs), 'on (1 scheduled)');
});

test('the switch: profile, entry and APLABS_JOBS_OFF must all allow it; any non-empty value is off, including "0"', () => {
  assert.deepEqual(jobsSwitch({ profile: ON, env: {} }), { on: true, reason: null });
  assert.deepEqual(jobsSwitch({ profile: profile(false), env: {} }), { on: false, reason: 'profile' });
  assert.deepEqual(jobsSwitch({ profile: profile(), env: {} }), { on: false, reason: 'profile' }, 'default off');
  for (const v of ['1', '0', 'false', 'no', ' ']) {
    assert.deepEqual(jobsSwitch({ profile: ON, env: { [OFF_ENV]: v } }), { on: false, reason: OFF_ENV }, JSON.stringify(v));
  }
  assert.deepEqual(jobsSwitch({ profile: ON, env: { [OFF_ENV]: '' } }), { on: true, reason: null }, 'empty is unset');
  assert.equal(OFF_ENV, 'APLABS_JOBS_OFF');
  assert.equal(jobsWords({ on: false, reason: 'profile' }), 'off (profile)');
  assert.equal(jobsWords({ on: false, reason: OFF_ENV }), 'off (APLABS_JOBS_OFF)');
});

test('jobs off loads no job code: a job whose top-level code throws is never evaluated (B2)', () => {
  const dir = path.join(FIXTURES, 'off-app');
  const before = globalThis.__aplabsJobFixtureLoads || 0;
  for (const opts of [{ env: { [OFF_ENV]: '1' } }, { env: { [OFF_ENV]: '0' } }, { profile: profile(false) }, { profile: profile() }]) {
    const r = load(dir, opts);
    assert.deepEqual(r.problems, [], JSON.stringify(opts));
    assert.equal(r.state.on, false);
    assert.equal(r.jobs[0].run, undefined);
  }
  assert.equal(globalThis.__aplabsJobFixtureLoads || 0, before, 'the file was never required');
  // With jobs on, the same file is loaded and its throw stops startup, naming the job.
  const on = load(dir);
  assert.equal(globalThis.__aplabsJobFixtureLoads, before + 1);
  assert.equal(on.problems.length, 1);
  assert.match(on.problems[0], /^jobs\.json: job "loud": jobs\/throws-on-load\.js could not be loaded \(top-level job code ran\)/);
});

test('with jobs off, each run file is still checked to exist', (t) => {
  const dir = app(t, [entry({ run: 'missing.js' })], {});
  fs.mkdirSync(path.join(dir, 'jobs'));
  const r = load(dir, { env: { [OFF_ENV]: '1' } });
  assert.deepEqual(r.problems, ['jobs.json: job "nightly": field "run" names missing.js, which does not exist in jobs/']);
  const noDir = app(t, [entry()], {});
  assert.match(load(noDir, { env: { [OFF_ENV]: '1' } }).problems[0], /job "nightly": field "run" names nightly\.js, but the app has no jobs\/ folder/);
});

test('with jobs on, a job file that does not export run(ctx) stops startup, naming the job', (t) => {
  for (const text of ['module.exports = {};\n', 'module.exports = { run: 42 };\n', 'exports.go = async () => {};\n']) {
    const r = load(app(t, [entry()], { 'jobs/nightly.js': text }));
    assert.deepEqual(r.problems, ['jobs.json: job "nightly": jobs/nightly.js must export an async run(ctx)'], text);
    assert.deepEqual(r.jobs, []);
  }
  // A disabled entry's file is not loaded at startup; loadAll (npm test) checks it.
  const dir = app(t, [entry({ enabled: false })], { 'jobs/nightly.js': 'module.exports = {};\n' });
  assert.deepEqual(load(dir).problems, []);
  assert.match(load(dir, { loadAll: true }).problems[0], /must export an async run\(ctx\)/);
});

test('the schema: unknown and missing fields, bad names and a non-list fail naming the entry and field', (t) => {
  const p = (list) => load(app(t, list)).problems;
  assert.deepEqual(p([{ ...entry(), owner: 'me' }]), ['jobs.json: job "nightly": unknown field "owner"']);
  assert.deepEqual(p([{ name: 'nightly', schedule: '0 2 * * *', run: 'nightly.js' }]), ['jobs.json: job "nightly": field "enabled" is required']);
  assert.deepEqual(p([entry({ enabled: 'yes' })]), ['jobs.json: job "nightly": field "enabled" must be boolean']);
  assert.match(p([entry({ name: 'Nightly_Job' })])[0], /^jobs\.json: entry \[0\]: field "name" must match pattern/);
  assert.match(p([entry({ run: 'nightly.sh' })])[0], /^jobs\.json: job "nightly": field "run" must match pattern/);
  assert.match(p({ name: 'nightly' })[0], /^jobs\.json: must be array/);
  const bad = tmpApp(t);
  put(bad, 'jobs.json', '[{ "name": ');
  assert.match(load(bad).problems[0], /^jobs\.json: cannot be read/);
});

test('a duplicate name is refused', (t) => {
  const r = load(app(t, [entry(), entry({ schedule: '0 3 * * *' })]));
  assert.deepEqual(r.problems, ['jobs.json: job "nightly": field "name" is used by another job']);
});

test('an invalid, too frequent, never-running or both-day-field schedule stops startup, naming the job', (t) => {
  const p = (schedule) => load(app(t, [entry({ schedule })])).problems;
  assert.match(p('0 25 * * *')[0], /^jobs\.json: job "nightly": field "schedule" hour 25 is outside 0 to 23/);
  assert.match(p('every day')[0], /job "nightly": field "schedule" .*five fields/);
  assert.match(p('*/2 * * * *')[0], /job "nightly": field "schedule" it can run more often than every 5 minutes/);
  assert.match(p('0 0 30 2 *')[0], /job "nightly": field "schedule" it never runs/);
  assert.match(p('0 9 1 * 1')[0], /job "nightly": field "schedule" it limits both day of month and day of week/);
});

test('a run path leaving jobs/ stops startup, naming the job: "..", absolute, symlink, into a connector (B1)', (t) => {
  const conn = { 'connectors/email/connector.js': JOB, 'jobs/ok.js': JOB };
  const p = (run, files = conn) => load(app(t, [entry({ run })], files)).problems;
  assert.match(p('../connectors/email/connector.js')[0], /^jobs\.json: job "nightly": field "run" must stay inside jobs\/ \(no "\.\."\)/);
  assert.match(p('sub/../../connectors/email/connector.js')[0], /no "\.\."/);
  const abs = tmpApp(t);
  put(abs, 'x.js', JOB);
  assert.match(p(path.join(abs, 'x.js'))[0], /field "run" must be relative to jobs\/, not an absolute path/);
  assert.match(p('./ok.js')[0], /field "run" must be a plain relative path/);

  // A symlink in jobs/ to a connector's file, and a symlinked folder.
  const dir = app(t, [entry({ run: 'link.js' }), entry({ name: 'via-dir', run: 'conn/connector.js' })], conn);
  fs.symlinkSync(path.join(dir, 'connectors/email/connector.js'), path.join(dir, 'jobs/link.js'));
  fs.symlinkSync(path.join(dir, 'connectors/email'), path.join(dir, 'jobs/conn'));
  const r = load(dir);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /^jobs\.json: job "nightly": field "run" names link\.js, which resolves outside jobs\//);
  assert.match(r.problems[1], /^jobs\.json: job "via-dir": field "run" names conn\/connector\.js, which resolves outside jobs\//);

  // A symlinked jobs/ folder itself is fine: containment is checked against its real path.
  const real = app(t, [], { 'elsewhere/nightly.js': JOB });
  const linked = app(t, [entry()], {});
  fs.symlinkSync(path.join(real, 'elsewhere'), path.join(linked, 'jobs'));
  assert.deepEqual(load(linked).problems, []);
  // A link that stays inside jobs/ is fine too.
  const inner = app(t, [entry({ run: 'alias.js' })]);
  fs.symlinkSync(path.join(inner, 'jobs/nightly.js'), path.join(inner, 'jobs/alias.js'));
  assert.deepEqual(load(inner).problems, []);
});

test('every problem is listed at once', (t) => {
  const r = load(app(t, [entry({ schedule: '* * * * *' }), entry({ name: 'two', run: '../x.js' })]));
  assert.equal(r.problems.length, 2);
  assert.deepEqual(r.jobs, []);
});

// --- what a job gets -----------------------------------------------------------

test('ctx is read-only: { log, data, now, name }, frozen, with no Slack, store or connector (Q3)', async () => {
  const clock = fakeClock();
  const { log, lines } = capture(clock);
  const calls = [];
  const data = { run: async (...a) => { calls.push(a); return [{ n: 1 }]; }, describe: () => ({ available: true }), close() {}, open() {} };
  const ctx = jobContext({ job: { name: 'nightly' }, log, data, now: clock.now });
  assert.deepEqual(Object.keys(ctx).sort(), ['data', 'log', 'name', 'now']);
  assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.log) && Object.isFrozen(ctx.data));
  assert.deepEqual(Object.keys(ctx.data).sort(), ['describe', 'run']);
  assert.throws(() => { 'use strict'; ctx.data.run = null; }, TypeError);
  assert.equal(ctx.name, 'nightly');
  assert.equal(ctx.now().toISOString(), '2026-03-10T08:00:00.000Z');
  await ctx.data.run('SELECT 1 AS n WHERE 1 = $one', { one: 1 });
  assert.deepEqual(calls, [['SELECT 1 AS n WHERE 1 = $one', { one: 1 }, { declared: ['one'] }]]);
  ctx.log.info('hello', { job: 'spoofed', count: 2 });
  assert.equal(lines[0].job, 'nightly', 'the job name cannot be overwritten');
  assert.equal(lines[0].count, 2);
  // No data source: unavailable, never a crash.
  const none = jobContext({ job: { name: 'x' }, log, data: null, now: clock.now });
  await assert.rejects(none.data.run('SELECT 1'), (e) => e.code === 'DATA_UNAVAILABLE');
});

// --- the scheduler, on a fake clock ------------------------------------------------

test('an enabled job runs on time and logs start and finish with its duration', async () => {
  const clock = fakeClock('2026-03-10T08:01:00Z');
  const { log, lines, msgs } = capture(clock);
  const runs = [];
  const s = createScheduler({ jobs: [job('tick', async (ctx) => { runs.push(ctx.now().toISOString()); })], log, now: clock.now, timers: clock.timers });
  s.start();
  assert.equal(s.scheduled()[0].next.toISOString(), '2026-03-10T08:05:00.000Z');
  await clock.advance(3 * 60 * 1000 + 59 * 1000);
  assert.deepEqual(runs, [], 'not before its minute');
  await clock.advance(1000);
  assert.deepEqual(runs, ['2026-03-10T08:05:00.000Z']);
  await clock.advance(10 * 60 * 1000);
  assert.deepEqual(runs, ['2026-03-10T08:05:00.000Z', '2026-03-10T08:10:00.000Z', '2026-03-10T08:15:00.000Z']);
  assert.deepEqual(msgs().slice(0, 2), ['job started', 'job finished']);
  assert.equal(lines[0].job, 'tick');
  assert.equal(lines[1].job, 'tick');
  assert.equal(typeof lines[1].ms, 'number');
  s.stop();
});

test('a job disabled by its entry, or with no loaded run, is never scheduled', async () => {
  const clock = fakeClock();
  const { log } = capture(clock);
  let ran = 0;
  const off = { ...job('off', async () => { ran++; }), enabled: false };
  const unloaded = { ...job('unloaded', null) };
  const s = createScheduler({ jobs: [off, unloaded], log, now: clock.now, timers: clock.timers });
  s.start();
  assert.deepEqual(s.scheduled(), []);
  await clock.advance(60 * 60 * 1000);
  assert.equal(ran, 0);
});

test('a job that throws or rejects is logged and redacted; the app keeps running and the next run happens', async () => {
  const clock = fakeClock('2026-03-10T08:04:00Z');
  const { log, lines } = capture(clock);
  log.registerSecret('sekret-value-123');
  let n = 0;
  const s = createScheduler({
    jobs: [
      job('throws', () => { n++; throw new Error('boom with sekret-value-123'); }),
      job('rejects', async () => { throw new Error('nope'); }),
    ],
    log, now: clock.now, timers: clock.timers,
  });
  s.start();
  await clock.advance(60 * 1000);
  await clock.advance(5 * 60 * 1000);
  assert.equal(n, 2, 'the next run still happened');
  const failed = lines.filter((l) => l.msg === 'job failed');
  assert.equal(failed.length, 4);
  assert.equal(failed[0].level, 'error');
  assert.equal(failed[0].job, 'throws');
  assert.equal(typeof failed[0].ms, 'number');
  assert.match(failed[0].err.message, /boom with \[redacted\]/);
  assert.ok(!JSON.stringify(lines).includes('sekret-value-123'));
  assert.equal(failed[1].job, 'rejects');
  s.stop();
});

test('a slow job skips its next run, logged "still running"; no overlap (Q4)', async () => {
  const clock = fakeClock('2026-03-10T08:04:00Z');
  const { log, lines } = capture(clock);
  let release;
  let started = 0;
  const s = createScheduler({
    jobs: [job('slow', () => { started++; return new Promise((r) => { release = r; }); })],
    log, now: clock.now, timers: clock.timers,
  });
  s.start();
  await clock.advance(60 * 1000); // 08:05: starts
  await clock.advance(5 * 60 * 1000); // 08:10: still running
  assert.equal(started, 1);
  const skipped = lines.filter((l) => l.msg === 'job skipped: still running');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].job, 'slow');
  assert.equal(skipped[0].level, 'warn');
  release();
  await flush();
  await clock.advance(5 * 60 * 1000); // 08:15: runs again
  assert.equal(started, 2);
  assert.equal(lines.filter((l) => l.msg === 'job finished').length, 1);
  s.stop();
});

test('missed runs are not made up: after a long pause the job runs once, then on schedule', async () => {
  const clock = fakeClock('2026-03-10T08:04:00Z');
  const { log } = capture(clock);
  const runs = [];
  const s = createScheduler({ jobs: [job('tick', async (ctx) => { runs.push(ctx.now().toISOString()); })], log, now: clock.now, timers: clock.timers });
  s.start();
  clock.jump(2 * 60 * 60 * 1000 + 30 * 1000); // asleep through 24 due runs
  await clock.advance(0);
  assert.deepEqual(runs, ['2026-03-10T10:04:30.000Z'], 'one run, not 24');
  assert.equal(s.scheduled()[0].next.toISOString(), '2026-03-10T10:05:00.000Z');
  s.stop();
});

test('a run more than 25 days away never fires early; timers are capped at 24 hours (B3)', async () => {
  const clock = fakeClock('2026-03-10T08:00:00Z');
  const { log } = capture(clock);
  const runs = [];
  // Next run: 1 May 2026, about 52 days away; well past setTimeout's 24.8-day limit.
  const s = createScheduler({ jobs: [job('monthly', async (ctx) => { runs.push(ctx.now().toISOString()); }, '0 9 1 5 *')], log, now: clock.now, timers: clock.timers });
  s.start();
  assert.equal(MAX_TIMER_MS, 24 * 60 * 60 * 1000);
  assert.deepEqual(clock.pending(), [MAX_TIMER_MS]);
  await clock.advance(51 * 24 * 60 * 60 * 1000);
  assert.deepEqual(runs, [], 'no early fire after 51 days');
  assert.ok(clock.armed.length >= 52 && clock.armed.every((ms) => ms <= MAX_TIMER_MS), 'every timer at most 24 hours');
  await clock.advance(2 * 24 * 60 * 60 * 1000);
  assert.deepEqual(runs, ['2026-05-01T09:00:00.000Z']);
  s.stop();
});

test('stop() schedules nothing new and does not wait for a run in progress', async () => {
  const clock = fakeClock('2026-03-10T08:04:00Z');
  const { log } = capture(clock);
  let started = 0;
  const s = createScheduler({ jobs: [job('slow', () => { started++; return new Promise(() => {}); })], log, now: clock.now, timers: clock.timers });
  s.start();
  await clock.advance(60 * 1000);
  assert.equal(started, 1);
  assert.equal(s.stop(), undefined, 'returns at once, nothing awaited');
  assert.deepEqual(clock.pending(), []);
  await clock.advance(60 * 60 * 1000);
  assert.equal(started, 1);
  s.start();
  assert.deepEqual(clock.pending(), [], 'a stopped scheduler stays stopped');
});

test('real timers never hold the process open', () => {
  const script = `
    const { createScheduler } = require(${JSON.stringify(path.join(ROOT, 'kit/runtime/jobs'))});
    const { parseSchedule } = require(${JSON.stringify(path.join(ROOT, 'kit/runtime/jobs/schedule'))});
    const log = { info() {}, warn() {}, error() {} };
    createScheduler({ jobs: [{ name: 't', enabled: true, cron: parseSchedule('*/5 * * * *'), run: async () => {} }], log }).start();
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
});

// --- the template -----------------------------------------------------------

// The app dirs this checkout runs or checks: package.json aplabs.appDirs,
// <repo>/app and APLABS_APP_DIR.
function appDirs() {
  const dirs = [...configuredAppDirs(ROOT).dirs, path.join(ROOT, 'app')];
  if (process.env.APLABS_APP_DIR) dirs.push(path.resolve(ROOT, process.env.APLABS_APP_DIR));
  return [...new Set(dirs)].filter((d) => fs.existsSync(d));
}

test('the template ships no jobs (N14)', () => {
  for (const dir of appDirs()) {
    const file = path.join(dir, 'jobs.json');
    if (!fs.existsSync(file)) continue;
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(list, [], `${path.relative(ROOT, file)} has entries: the template ships no jobs`);
  }
});

test('every app dir\'s jobs.json loads cleanly with every job file checked (a fork\'s jobs, in npm test)', () => {
  for (const dir of appDirs()) {
    const r = loadJobs({ appDir: dir, profile: ON, env: {}, loadAll: true });
    assert.deepEqual(r.problems, [], path.relative(ROOT, dir));
  }
});

// --- Story 15.1: engine jobs (AD-R15) ------------------------------------------

const { engineJobsFor, createEngineJobs, ENGINE_JOBS } = require('../../kit/runtime/jobs');

const mapCheck = (environments = ['dev']) => ({ id: 'map-check', archetype: 'handler', environments });
const plain = { id: 'echo', archetype: 'handler', environments: ['dev', 'prod'] };

test('engine jobs: the map-file sweep is a registered engine job, needed whenever a map module shows in this environment', () => {
  assert.deepEqual(ENGINE_JOBS.map((j) => [j.name, j.everyMs]), [['sweep-map-files', 5 * 60 * 1000]]);
  assert.deepEqual(engineJobsFor({ modules: [plain, mapCheck()], env: 'dev' }), ['sweep-map-files']);
  assert.deepEqual(engineJobsFor({ modules: [{ id: 'r', archetype: 'routing-map', environments: ['prod'] }], env: 'prod' }), ['sweep-map-files']);
  assert.deepEqual(engineJobsFor({ modules: [plain, mapCheck()], env: 'prod' }), [], 'hidden in prod: not enabled there');
  assert.deepEqual(engineJobsFor({ modules: [plain], env: 'dev' }), []);
  assert.deepEqual(engineJobsFor({ modules: [], env: 'dev' }), []);
});

test('engine jobs: the need never reads the jobs switch (profile jobs.enabled, APLABS_JOBS_OFF)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'kit/runtime/jobs/index.js'), 'utf8');
  const body = src.slice(src.indexOf('function engineJobsFor('), src.indexOf('function createEngineJobs('));
  assert.ok(body.length > 0);
  assert.ok(!/jobsSwitch|OFF_ENV|APLABS_JOBS_OFF|profile/.test(body.replace(/\/\/[^\n]*/g, '')));
});

test('engine jobs: run at start(), then every everyMs on the timers; stop() clears them; running() tells the hub', async () => {
  const clock = fakeClock();
  const runs = [];
  const store = { expiredMapFiles: () => { runs.push(clock.now().toISOString()); return []; } };
  const jobs = createEngineJobs({
    names: ['sweep-map-files'], store, client: {}, log: capture(clock).log, timers: clock.timers, now: () => clock.now().getTime(),
  });
  assert.deepEqual(jobs.names, ['sweep-map-files']);
  assert.equal(jobs.running('sweep-map-files'), false);
  jobs.start();
  await flush();
  assert.equal(jobs.running('sweep-map-files'), true);
  assert.equal(jobs.running('other'), false);
  await clock.advance(11 * 60 * 1000);
  assert.deepEqual(runs, ['2026-03-10T08:00:00.000Z', '2026-03-10T08:05:00.000Z', '2026-03-10T08:10:00.000Z']);
  jobs.stop();
  assert.equal(jobs.running('sweep-map-files'), false);
  assert.deepEqual(clock.pending(), []);
  await clock.advance(10 * 60 * 1000);
  assert.equal(runs.length, 3);
  jobs.start();
  assert.equal(runs.length, 3, 'a stopped runner never starts again');
});

test('engine jobs: none needed runs nothing; an unknown name is refused', () => {
  const clock = fakeClock();
  const jobs = createEngineJobs({ names: [], store: {}, client: {}, log: capture(clock).log, timers: clock.timers });
  jobs.start();
  assert.deepEqual(clock.pending(), []);
  assert.equal(jobs.running('sweep-map-files'), false);
  assert.throws(() => createEngineJobs({ names: ['nope'], store: {}, client: {}, log: capture(clock).log }), /unknown engine job: nope/);
});
