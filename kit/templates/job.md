# Adding a scheduled job

A scheduled job is a small piece of code the bot runs on a timetable, with no person asking: a nightly check, an hourly tally written to the log. It is one line of data in `app/jobs.json` and one file in `app/jobs/`. No engine file (`kit/**`, `profiles/_schema/**`) changes. The template ships no jobs.

Jobs read; they never write or post. A job can't push to a connector or send a Slack message. A fork that wants a scheduled report in a channel, or a scheduled push, plans it on its own.

## Steps

1. Add an entry to `app/jobs.json` (create the file as a list if it isn't there):

   ```json
   [
     { "name": "nightly-check", "schedule": "30 2 * * *", "run": "nightly-check.js", "enabled": true }
   ]
   ```

2. Write the job file, `app/jobs/nightly-check.js`:

   ```js
   'use strict';

   async function run(ctx) {
     const rows = await ctx.data.run('SELECT count(*) AS open_jobs FROM jobs WHERE status = $status LIMIT 1', { status: 'open' });
     ctx.log.info('nightly check', { open_jobs: rows.length ? rows[0].open_jobs : null });
   }

   module.exports = { run };
   ```

3. Switch jobs on in the profile (`.aplabs/profile.yml`), reviewed like any profile change:

   ```yaml
   jobs:
     enabled: true
   ```

4. Run `npm run check && npm test`. Then start the app: the startup line says `jobs: on (1 scheduled)`.

## The entry

| Field | What it is |
|---|---|
| `name` | A unique kebab-case slug (`nightly-check`). Every log line for the job names it. |
| `schedule` | Five-field cron, in **UTC**: `minute hour day-of-month month day-of-week`. Numbers, `*`, lists (`1,15`), ranges (`9-17`) and steps (`*/15`, `0-30/10`). No names (`MON`, `JAN`), no seconds, no time zones, no `@daily`. Day of week is 0 to 7, where 0 and 7 are Sunday. |
| `run` | The job file, relative to `app/jobs/`. It must stay inside `app/jobs/`: no `..`, no absolute path, and no symlink that leads out (into a connector's folder, say). |
| `enabled` | This job's own switch. |

`30 2 * * *` is 02:30 UTC every day. `0 9 * * 1-5` is 09:00 UTC on weekdays. `0 6 1 * *` is 06:00 UTC on the first of each month.

The app refuses to start, naming the job and the field, when:

- a field is wrong, a name is used twice, or the `run` file is missing or outside `app/jobs/`;
- the schedule can run more often than **every 5 minutes** (`*/2 * * * *`, or `58 23` and `0 0` back to back across midnight);
- it limits **both** day of month and day of week (`0 9 1 * 1`). Pick one;
- it never runs (no time in the next 5 years matches, such as 30 February);
- with jobs on, the file doesn't export `run(ctx)`, or throws while loading.

`jobs.json` is checked even when jobs are off, so a broken entry is caught before anyone turns jobs on.

## Turning jobs on and off

A job runs only when all three allow it: the profile's `jobs.enabled` is `true` (default `false`), its entry's `enabled` is `true`, and `APLABS_JOBS_OFF` is not set. Any non-empty value of `APLABS_JOBS_OFF` means off, including `0`. With jobs off, no job file is loaded at all: only the entries and each file's existence are checked. The startup line says `jobs: on (n scheduled)`, `off (profile)` or `off (APLABS_JOBS_OFF)`.

## What a job gets

`run(ctx)` gets `ctx = { log, data, now, name }`, and nothing else:

- `ctx.log`: the redacting logger (`info`, `warn`, `error`). Each line names the job. **Never log query rows**: log counts and ids.
- `ctx.data`: the read-only query runner (`run(sql, params)`, `describe()`), with the same guardrails as modules (the SQL checker and the profile's forbidden columns). Pass values as named parameters (`$status`), never by building SQL text. **Put a `LIMIT` on every job query**: no one is waiting on the answer, so keep it small.
- `ctx.now()`: the clock, as a `Date`.
- `ctx.name`: the job's name.

There is no Slack client, no store and no connector. `npm run check` fails a file under `app/jobs/` that imports `@slack/`, `#sdk` or a connectors path, naming the file and line, and the write-path check fails one that reaches a connector's `write`. Job code is trusted, reviewed app code and is not sandboxed: these checks are tripwires, and review reads every job.

## How runs behave

- Each run logs `job started`, then `job finished` or `job failed`, with the job name and the duration in milliseconds. A failure's error goes through the redacting logger.
- A job that throws or rejects is logged and the bot keeps running. The next run still happens on schedule.
- No overlap: if a run is still going when the next is due, that next run is skipped and logged (`job skipped: still running`).
- No catch-up: runs missed while the bot was down are not made up. A restart during a job's minute skips that run.
- One process only: run exactly one copy of the bot (stop the old one before starting the new one), or each job runs once per copy.
- On shutdown (SIGTERM or SIGINT) the scheduler stops first. A run in progress is not waited for.
