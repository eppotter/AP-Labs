'use strict';

// The measured retro: body-line parsing, budgets and the table, then the CLI
// in process against a stub gh (test/fixtures/retro/). No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BUDGET, parseBody, toRow, summarize, renderReport, parseArgs } = require('../../kit/lib/retro');
const { main } = require('../../kit/retro/cli');

const fixtures = path.join(__dirname, '../fixtures/retro');
const PRS = JSON.parse(fs.readFileSync(path.join(fixtures, 'prs.json'), 'utf8'));
const byNumber = (n) => PRS.find((p) => p.number === n);
const tmps = [];
test.after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('parseBody reads every review line, CRLF included', () => {
  assert.deepEqual(parseBody(byNumber(12).body), {
    tooled: true, kind: 'groundwork', reviewRounds: 4, fallback: false, exempt: null, followup: 42,
    stop: 'same class twice — kit/a.js',
  });
  assert.equal(parseBody(byNumber(13).body).kind, 'fix');
  assert.equal(parseBody(byNumber(13).body).reviewRounds, 1);
  assert.equal(parseBody(byNumber(14).body).exempt, 'docs only');
  assert.equal(parseBody(byNumber(15).body).fallback, true);
});

test('a body with no review lines is pre-tooling; an unknown Kind is not a Kind', () => {
  assert.deepEqual(parseBody(byNumber(3).body), {
    tooled: false, kind: null, reviewRounds: null, fallback: false, exempt: null, followup: null, stop: null,
  });
  assert.equal(parseBody(null).tooled, false);
  const odd = parseBody('Kind: feature\n');
  assert.equal(odd.tooled, true);
  assert.equal(odd.kind, null);
  assert.equal(parseBody('Code Review: looks fine\nWe ran a Review rounds discussion').tooled, false);
});

test('toRow counts commits and hours from open to merge', () => {
  const r = toRow(byNumber(12));
  assert.equal(r.commits, 12);
  assert.equal(r.hoursToMerge, 48);
  assert.equal(r.fix, false);
  assert.equal(toRow(byNumber(13)).fix, true);
  assert.equal(toRow(byNumber(3)).fix, null);
});

test('budgets: rounds over budget, a stop line and a missing Kind breach; pre-tooling PRs do not', () => {
  const { rows, summary } = summarize(PRS.filter((p) => p.mergedAt).map(toRow));
  assert.deepEqual(rows.map((r) => r.number), [3, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(summary.breaches.map((b) => [b.pr, b.rule]), [
    [12, 'review-rounds'], [12, 'same-class-twice'], [16, 'missing-kind'],
  ]);
  assert.deepEqual(summary.missingKind, [{ pr: 3, preTooling: true }, { pr: 16, preTooling: false }]);
  assert.equal(summary.prs, 7);
  assert.equal(summary.tooled, 6);
  assert.equal(summary.preTooling, 1);
  assert.equal(summary.knownKind, 5);
  assert.equal(summary.fixes, 1);
  assert.equal(summary.fixShare, 0.2);
});

test('fix share over budget among PRs with a known Kind is a window breach', () => {
  const rows = [3, 13, 14, 16].map((n) => toRow(byNumber(n)));
  const { summary } = summarize(rows);
  assert.equal(summary.knownKind, 2, 'pre-tooling #3 and Kind-less #16 are left out');
  assert.equal(summary.fixShare, 0.5);
  assert.ok(summary.fixShare > BUDGET.maxFixShare);
  const share = summary.breaches.find((b) => b.rule === 'fix-share');
  assert.ok(share);
  assert.equal(share.pr, undefined);
  // Exactly at budget is not a breach.
  const atBudget = summarize([13, 11, 14, 15].map((n) => toRow(byNumber(n)))).summary;
  assert.equal(atBudget.fixShare, 0.25);
  assert.equal(atBudget.breaches.length, 0);
});

test('renderReport: a row per PR, breaches and the missing Kind list under it, a summary line last', () => {
  const report = renderReport(summarize(PRS.filter((p) => p.mergedAt).map(toRow)), { notMerged: [17] });
  const lines = report.split('\n');
  assert.equal(lines.filter((l) => /^\| #\d+ /.test(l)).length, 7);
  assert.ok(lines.includes('| #3 | — | — | pre-tooling | 2 | 6.0 | — | Pre-tooling scaffold |'));
  assert.ok(lines.includes('| #12 | groundwork | 4/3 | — | 12 | 48.0 | no | Over budget \\| stopped |'));
  assert.ok(lines.includes('| #14 | docs | — | exempt (docs only) | 1 | 0.5 | no | Docs refresh |'));
  assert.ok(lines.includes('| #15 | user-visible | 2/3 | same-model fallback | 4 | 12.0 | no | User-visible change |'));
  assert.match(report, /^- #12: .*4 review rounds/m);
  assert.match(report, /^- #16: /m);
  assert.doesNotMatch(report, /^- #3: /m, 'pre-tooling is listed, not a breach');
  assert.match(report, /#3 \(pre-tooling\), #16/);
  assert.match(report, /#17/);
  assert.match(lines.at(-1), /^7 PRs .* 3 breach\(es\)\.$/);
  assert.match(renderReport(summarize([toRow(byNumber(11))])), /No budget breaches\./);
});

test('parseArgs: one of --since or --prs, strict values', () => {
  assert.deepEqual(parseArgs(['--since', '2026-10-01']), { json: false, since: '2026-10-01' });
  assert.deepEqual(parseArgs(['--prs', '11,12,11', '--json']), { json: true, prs: [11, 12] });
  for (const argv of [[], ['--since'], ['--since', '2026-02-30'], ['--since', '10/01/2026'], ['--prs', '11,,12'],
    ['--prs', '0'], ['--since', '2026-10-01', '--prs', '11'], ['--repo', 'x/y']]) {
    assert.ok(parseArgs(argv).error, argv.join(' '));
  }
});

function run(argv, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-retro-'));
  tmps.push(tmp);
  const calls = path.join(tmp, 'calls.txt');
  const env = { PATH: process.env.PATH, APLABS_GH_BIN: path.join(fixtures, 'fake-gh.sh'),
    FAKE_RETRO_PRS: path.join(fixtures, 'prs.json'), FAKE_RETRO_CALLS: calls, ...extra };
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  let code;
  try {
    code = main(argv, env);
  } finally {
    console.log = log;
    console.error = error;
  }
  return { code, out: out.join('\n'), err: err.join('\n'), calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

test('cli --since lists merged PRs from the date and prints the report', () => {
  const r = run(['--since', '2026-10-01']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.calls.trim(), 'pr list --state merged --search merged:>=2026-10-01 --limit 200 --json number,title,body,createdAt,mergedAt,commits');
  assert.match(r.out, /^\| PR \| Kind \|/);
  assert.match(r.out, /Skipped, not merged: #17\./);
});

test('cli --prs views each PR; --json prints the machine-readable result', () => {
  const r = run(['--prs', '12,13', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls.trim().split('\n').map((l) => l.split(' ').slice(0, 3).join(' ')), ['pr view 12', 'pr view 13']);
  const result = JSON.parse(r.out);
  assert.deepEqual(result.rows.map((row) => row.number), [12, 13]);
  assert.deepEqual(result.summary.breaches.map((b) => b.rule), ['review-rounds', 'same-class-twice', 'fix-share']);
  assert.deepEqual(result.notMerged, []);
});

test('cli: usage errors exit 2 without calling gh; gh failures exit 1 with a plain message', () => {
  const usage = run(['--since', 'yesterday']);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /usage: npm run retro/);
  assert.equal(usage.calls, '');

  const down = run(['--since', '2026-10-01'], { FAKE_RETRO_FAIL: 'HTTP 502: bad gateway' });
  assert.equal(down.code, 1);
  assert.match(down.err, /pr list failed: HTTP 502: bad gateway/);

  assert.equal(run(['--prs', '99']).code, 1);
  assert.match(run(['--prs', '11'], { FAKE_RETRO_RAW: 'not json' }).err, /not JSON/);
  assert.match(run(['--prs', '11'], { APLABS_GH_BIN: path.join(os.tmpdir(), 'no-such-gh') }).err, /not found/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-retro-'));
  tmps.push(dir);
  const full = path.join(dir, 'full.json');
  fs.writeFileSync(full, JSON.stringify(Array.from({ length: 200 }, () => byNumber(11))));
  const truncated = run(['--since', '2026-10-01'], { FAKE_RETRO_PRS: full });
  assert.equal(truncated.code, 1);
  assert.match(truncated.err, /narrow --since/);
});
