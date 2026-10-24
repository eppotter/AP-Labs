'use strict';

// Cross-model review (Story 1.1): the pure half. Rubric, round prompts,
// verdict parsing, PR-body lines and argument parsing. No I/O here; the CLI in
// kit/review/cli.js does git, gh, codex and the state file.
//
// Budget: three rounds per branch. Round 1 asks for P1 and P2; rounds 2 and 3
// ask for P1 only and list what earlier rounds already reported. A fourth needs
// the human's go (--over-budget "<reason>").
//
// Ported from CanonCRM's scripts/codex-review.ts. Changes: no CanonCRM folder
// names in parseFindings (paths are made repo-relative instead), a
// `Reviewed head:` PR-body line, and state keyed per branch.

const ROUND_BUDGET = 3;

const RUBRIC = `Review this branch's changes against origin/main (git diff origin/main...HEAD) and read AGENTS.md.
Label a finding [P1] only if it is blocking: it loses or corrupts data, breaks auth, permissions or a safety invariant in AGENTS.md, or breaks the main path this branch delivers for today's data and usage.
Everything else is [P2]: edge cases far beyond today's data, hardening, polish, style, missing tests for non-blocking cases.
Report each finding as "- [P1|P2] <title> — <path>:<line>" with a short explanation. Say "No blocking findings." if there is no P1.`;

function promptFor(state) {
  const previous = state.rounds[state.rounds.length - 1];
  if (!previous) return RUBRIC;
  const seen = state.rounds.flatMap((r) => r.findings).map((f) => `- [${f.priority}] ${f.title} — ${f.file}`);
  return `${RUBRIC}

This is round ${state.rounds.length + 1} of ${ROUND_BUDGET}. Report [P1] findings only; non-blocking items go to a follow-up issue.
Earlier rounds reviewed up to ${previous.head} and reported:
${seen.join('\n') || '(nothing)'}
Do not re-raise those. Check that the P1s were fixed, then look at the commits after ${previous.head} and how they interact with the rest of the diff.`;
}

// A finding's path is made repo-relative: an absolute repo-root prefix and any
// leading ./ are stripped; a path that is already relative is kept as-is.
function parseFindings(verdict, repoRoot = '') {
  const root = repoRoot.replace(/\/+$/, '');
  const relative = (file) => {
    let f = root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
    while (f.startsWith('./')) f = f.slice(2);
    return f;
  };
  return [...verdict.matchAll(/^- \[(P\d)\] (.+?) — (\S+?)(?::\d[\d-]*)?\s*$/gm)].map((m) => ({
    priority: m[1] === 'P1' ? 'P1' : 'P2',
    title: m[2],
    file: relative(m[3]),
  }));
}

const isClean = (verdict) => /no blocking findings|no (actionable |discrete )?(issues|findings)/i.test(verdict);

// Files that drew a blocking finding in each of the last two rounds: the "same class twice" stop.
function repeatedBlockingFiles(rounds) {
  if (rounds.length < 2) return [];
  const blocking = (r) => new Set(r.findings.filter((f) => f.priority === 'P1').map((f) => f.file));
  const last = blocking(rounds[rounds.length - 1]);
  return [...blocking(rounds[rounds.length - 2])].filter((f) => last.has(f));
}

const ROUNDS_LINE = /^Review rounds:.*$/m;
const HEAD_LINE = /^Reviewed head:.*$/m;

function withRoundsLine(body, rounds) {
  const line = `Review rounds: ${rounds}/${ROUND_BUDGET}`;
  return ROUNDS_LINE.test(body) ? body.replace(ROUNDS_LINE, () => line) : `${body.trimEnd()}\n\n${line}\n`;
}

// Replaces an existing line in place; otherwise goes right under the rounds
// line, or at the end when there is none.
function withReviewedHeadLine(body, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a full commit sha: ${sha}`);
  const line = `Reviewed head: ${sha}`;
  if (HEAD_LINE.test(body)) return body.replace(HEAD_LINE, () => line);
  if (ROUNDS_LINE.test(body)) return body.replace(ROUNDS_LINE, (rounds) => `${rounds}\n${line}`);
  return `${body.trimEnd()}\n\n${line}\n`;
}

const USAGE = `usage: npm run review [-- --over-budget "<the human's reason>"]`;

// Strict flags: any argument other than `--over-budget <text>` must not start a paid round.
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let overBudget;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--over-budget') return { error: `unknown argument: ${argv[i]}` };
    overBudget = argv[++i];
    if (!overBudget || !overBudget.trim() || overBudget.startsWith('-')) {
      return { error: "--over-budget needs the human's reason as its value" };
    }
  }
  return { overBudget };
}

// Branch name -> state file stem. Unsafe bytes become %XX, and % itself is
// unsafe, so two different branches never share a file (and a budget).
function sanitizeBranch(branch) {
  if (!branch) throw new Error('no branch name');
  return [...Buffer.from(branch, 'utf8')]
    .map((b) => (/[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
}

module.exports = {
  ROUND_BUDGET,
  RUBRIC,
  USAGE,
  promptFor,
  parseFindings,
  isClean,
  repeatedBlockingFiles,
  withRoundsLine,
  withReviewedHeadLine,
  parseArgs,
  sanitizeBranch,
};
