'use strict';

// The measured retro (Story 5.2): the pure half. PR-body line parsing, per-PR
// metrics, budget checks and the markdown table. No I/O here; the CLI in
// kit/retro/cli.js runs gh.
//
// Budgets: review rounds per PR (the review script's ROUND_BUDGET), no
// "same class twice" stop, fix PRs at most 25% of PRs with a known Kind, and
// every reviewed PR names its Kind. A PR body with none of the review lines
// predates the tooling: it is listed, but never counted as a breach.
//
// Ported from CanonCRM's scripts/p3-retro.ts. Changes: no Kind inference (an
// unknown Kind stays unknown), no user-visible, groundwork-run or test-line
// budgets, a stop-line check, and pre-tooling PRs kept out of the breach math.

const { ROUND_BUDGET } = require('../review');

const BUDGET = { reviewRounds: ROUND_BUDGET, maxFixShare: 0.25 };
const KINDS = ['user-visible', 'groundwork', 'fix', 'infra', 'docs'];

// The lines kit/review writes. Matched on whole lines; GitHub's web editor
// saves CRLF, so bodies are normalised first.
const KIND_LINE = new RegExp(`^Kind: (${KINDS.join('|')})[ \\t]*$`, 'm');
const ANY_KIND_LINE = /^Kind:/m;
const ROUNDS_LINE = /^Review rounds: (\d+)\/\d+[ \t]*$/m;
const HEAD_LINE = /^Reviewed head: [0-9a-f]{7,40}[ \t]*$/m;
const FALLBACK_LINE = /^Review: same-model fallback[ \t]*$/m;
const EXEMPT_LINE = /^Review: exempt\b(?: — (.*?))?[ \t]*$/m;
const FOLLOWUP_LINE = /^Review follow-up: #(\d+)[ \t]*$/m;
const STOP_LINE = /^Review stop: (.*?)[ \t]*$/m;
const TOOLING_LINES = [ANY_KIND_LINE, ROUNDS_LINE, HEAD_LINE, FALLBACK_LINE, EXEMPT_LINE, FOLLOWUP_LINE, STOP_LINE];

function parseBody(text) {
  const body = (text || '').replace(/\r\n/g, '\n');
  const exempt = EXEMPT_LINE.exec(body);
  const rounds = ROUNDS_LINE.exec(body);
  const followup = FOLLOWUP_LINE.exec(body);
  const stop = STOP_LINE.exec(body);
  return {
    tooled: TOOLING_LINES.some((line) => line.test(body)),
    kind: KIND_LINE.exec(body)?.[1] ?? null,
    reviewRounds: rounds ? Number(rounds[1]) : null,
    fallback: FALLBACK_LINE.test(body),
    exempt: exempt ? (exempt[1] || '').trim() || 'no reason given' : null,
    followup: followup ? Number(followup[1]) : null,
    stop: stop ? stop[1] : null,
  };
}

// gh's JSON for one merged PR -> a table row.
function toRow(pr) {
  const parsed = parseBody(pr.body);
  return {
    number: pr.number,
    title: pr.title || '',
    mergedAt: pr.mergedAt,
    ...parsed,
    commits: Array.isArray(pr.commits) ? pr.commits.length : 0,
    hoursToMerge: (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 3_600_000,
    fix: parsed.kind === null ? null : parsed.kind === 'fix',
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;

// Rows in merge order, budget breaches and the counts behind them. Each breach
// is { pr?, rule, reason }; a window-wide breach has no pr.
function summarize(rows) {
  const ordered = [...rows].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.number - b.number);
  const tooled = ordered.filter((r) => r.tooled);
  const breaches = [];
  for (const r of tooled) {
    if (r.reviewRounds !== null && r.reviewRounds > BUDGET.reviewRounds) {
      breaches.push({ pr: r.number, rule: 'review-rounds', reason: `took ${r.reviewRounds} review rounds (budget ${BUDGET.reviewRounds})` });
    }
    if (r.stop !== null) {
      breaches.push({ pr: r.number, rule: 'same-class-twice', reason: `review stopped: ${r.stop}` });
    }
    if (r.kind === null) {
      breaches.push({ pr: r.number, rule: 'missing-kind', reason: 'has review lines but no valid Kind line' });
    }
  }
  const known = tooled.filter((r) => r.kind !== null);
  const fixes = known.filter((r) => r.kind === 'fix').length;
  const fixShare = known.length ? fixes / known.length : 0;
  if (fixShare > BUDGET.maxFixShare) {
    breaches.push({ rule: 'fix-share', reason: `fix share ${pct(fixShare)} of ${known.length} PRs with a known Kind (budget ${pct(BUDGET.maxFixShare)}): work is shipping before it works` });
  }
  const missingKind = ordered.filter((r) => r.kind === null).map((r) => ({ pr: r.number, preTooling: !r.tooled }));
  return {
    rows: ordered,
    summary: {
      prs: ordered.length,
      tooled: tooled.length,
      preTooling: ordered.length - tooled.length,
      knownKind: known.length,
      fixes,
      fixShare,
      missingKind,
      breaches,
    },
  };
}

// Pipes and newlines would break a markdown table cell.
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function reviewerNote(r) {
  if (!r.tooled) return 'pre-tooling';
  const notes = [];
  if (r.exempt) notes.push(`exempt (${r.exempt})`);
  if (r.fallback) notes.push('same-model fallback');
  return notes.join(', ') || '—';
}

// The table, the breaches under it, then one summary line.
function renderReport({ rows, summary }, { notMerged = [] } = {}) {
  const lines = ['| PR | Kind | Rounds | Reviewer | Commits | Hours | Fix | Title |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const rounds = r.reviewRounds === null ? '—' : `${r.reviewRounds}/${BUDGET.reviewRounds}`;
    const fix = r.fix === null ? '—' : r.fix ? 'yes' : 'no';
    lines.push(`| #${r.number} | ${r.kind ?? '—'} | ${rounds} | ${cell(reviewerNote(r))} | ${r.commits} | ${r.hoursToMerge.toFixed(1)} | ${fix} | ${cell(r.title)} |`);
  }
  lines.push('');
  if (summary.breaches.length) {
    lines.push('Budget breaches:');
    for (const b of summary.breaches) lines.push(`- ${b.pr === undefined ? '' : `#${b.pr}: `}${b.reason}`);
  } else {
    lines.push('No budget breaches.');
  }
  if (summary.missingKind.length) {
    const list = summary.missingKind.map((m) => `#${m.pr}${m.preTooling ? ' (pre-tooling)' : ''}`).join(', ');
    lines.push('', `Missing a Kind line: ${summary.missingKind.length} PR(s): ${list}. Pre-tooling PRs predate the review lines and are not breaches.`);
  }
  if (notMerged.length) lines.push('', `Skipped, not merged: ${notMerged.map((n) => `#${n}`).join(', ')}.`);
  lines.push('', `${summary.prs} PRs (${summary.tooled} reviewed by the tooling, ${summary.preTooling} pre-tooling); ` +
    `${summary.fixes} fix of ${summary.knownKind} with a known Kind (${pct(summary.fixShare)}); ${summary.breaches.length} breach(es).`);
  return lines.join('\n');
}

const USAGE = 'usage: npm run retro -- --since YYYY-MM-DD | --prs 11,12,14 [--json]';

// A real calendar date: 2026-02-30 is refused, not rolled over.
function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

// Exactly one of --since or --prs, each with a value; --json optional.
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.json = true;
    } else if (a === '--since' || a === '--prs') {
      const value = argv[++i];
      if (args.since !== undefined || args.prs !== undefined) return { error: 'give one of --since or --prs, once' };
      if (a === '--since') {
        if (!value || !isDate(value)) return { error: '--since needs a date, YYYY-MM-DD' };
        args.since = value;
      } else {
        const parts = (value || '').split(',');
        if (!value || !parts.every((p) => /^[1-9]\d*$/.test(p))) return { error: '--prs needs PR numbers, comma-separated: 11,12,14' };
        args.prs = [...new Set(parts.map(Number))];
      }
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }
  if (args.since === undefined && args.prs === undefined) return { error: 'give --since or --prs' };
  return args;
}

module.exports = {
  BUDGET,
  KINDS,
  USAGE,
  parseBody,
  toRow,
  summarize,
  renderReport,
  parseArgs,
};
