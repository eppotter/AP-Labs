'use strict';

// Cross-model review (Stories 1.1-1.4): the pure half. Rubric, round prompts,
// verdict parsing, PR-body lines, follow-up text, exemptions, Refuter verdicts and argument parsing. No I/O here; the CLI in
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

// The rubric is a first line saying where the diff comes from, then a body
// both reviewers share. Codex runs git itself; Claude gets the diff on stdin.
const CODEX_DIFF_LINE = "Review this branch's changes against origin/main (git diff origin/main...HEAD) and read AGENTS.md.";
const STDIN_DIFF_LINE = 'Review the diff supplied on stdin and read AGENTS.md.';
const RUBRIC_BODY = `Label a finding [P1] only if it is blocking: it loses or corrupts data, breaks auth, permissions or a safety invariant in AGENTS.md, or breaks the main path this branch delivers for today's data and usage.
Everything else is [P2]: edge cases far beyond today's data, hardening, polish, style, missing tests for non-blocking cases.
Report each finding as "- [P1|P2] <title> — <path>:<line>" with a short explanation.
End your reply with exactly one final line: "VERDICT: CLEAN" if there is no [P1], or "VERDICT: BLOCKING" if there is at least one.
Every finding, including non-blocking ones, must be a line in exactly the "- [P1|P2] <title> — <path>:<line>" format; findings in any other form are ignored.`;
const RUBRIC = `${CODEX_DIFF_LINE}\n${RUBRIC_BODY}`;

// Claude's stdin in rounds 2 and 3: the full diff, then this header line, then
// the diff since the last reviewed head, so "the commits after <head>" can be read.
const sinceHeader = (head) => `===== Changes since ${head} (git diff ${head}..HEAD) =====`;

function claudeStdin(fullDiff, previousHead, sinceDiff) {
  if (!previousHead) return fullDiff;
  const since = sinceDiff ?? `(unavailable: ${previousHead} is not in this repository)\n`;
  return `${fullDiff}${fullDiff.endsWith('\n') || !fullDiff ? '' : '\n'}${sinceHeader(previousHead)}\n${since}`;
}

function promptFor(state, { diffOnStdin = false } = {}) {
  const rubric = `${diffOnStdin ? STDIN_DIFF_LINE : CODEX_DIFF_LINE}\n${RUBRIC_BODY}`;
  const previous = state.rounds[state.rounds.length - 1];
  if (!previous) return rubric;
  const seen = state.rounds.flatMap((r) => r.findings).map((f) => `- [${f.priority}] ${f.title} — ${f.file}`);
  const where = diffOnStdin ? ` (their diff is on stdin after the line "${sinceHeader(previous.head)}")` : '';
  return `${rubric}

This is round ${state.rounds.length + 1} of ${ROUND_BUDGET}. Report [P1] findings only; non-blocking items go to a follow-up issue.
Earlier rounds reviewed up to ${previous.head} and reported:
${seen.join('\n') || '(nothing)'}
Do not re-raise the [P2]s. For each earlier [P1], check whether it is fixed: if it is still present, report it again as a [P1] line (an earlier P1 you do not re-report counts as fixed). Then look at the commits after ${previous.head}${where} and how they interact with the rest of the diff.`;
}

// A finding's path is made repo-relative: an absolute repo-root prefix and any
// leading ./ are stripped; a path that is already relative is kept as-is.
const FINDING = /^- \[(P\d)\] (.+?) — `?([^\s`]+?)(?::\d[\d-]*)?`?(?:[ \t].*)?$/gm;

function parseFindings(verdict, repoRoot = '') {
  const root = repoRoot.replace(/\/+$/, '');
  const relative = (file) => {
    let f = root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
    while (f.startsWith('./')) f = f.slice(2);
    return f;
  };
  // Reviewers wrap the path in backticks and add an explanation on the same
  // line as often as they follow the rubric's bare format; accept both.
  return [...verdict.matchAll(FINDING)].map((m) => ({
    priority: m[1] === 'P1' ? 'P1' : 'P2',
    title: m[2],
    file: relative(m[3]),
  }));
}

// Lines that look like findings but do not parse. A round with any of these
// does not count: a finding must never be lost silently.
function unparsedFindingLines(verdict) {
  return verdict.split('\n').filter((l) => /^- \[P\d\]/.test(l) && !new RegExp(FINDING.source).test(l));
}

// The state file is untrusted input: anything but the expected shape stops the run.
function isValidState(state) {
  return Boolean(state) && typeof state.branch === 'string' && Array.isArray(state.rounds) &&
    state.rounds.every((r) => r && typeof r.head === 'string' && Array.isArray(r.findings) && r.findings.every(isValidFinding)) &&
    (state.followup === undefined || (Number.isInteger(state.followup) && state.followup > 0));
}

// A P1 recorded before Story 1.4 has no id or verdict; one recorded since has both.
function isValidFinding(f) {
  return Boolean(f) && typeof f === 'object' && (f.id === undefined || typeof f.id === 'string') &&
    (f.verdict === undefined || f.verdict === 'pending' || REFUTER_VERDICTS.includes(f.verdict)) &&
    (f.note === undefined || typeof f.note === 'string');
}

// Reviewers paraphrase the rubric's "No blocking findings."; accept "no" with up
// to two words before "issues" or "findings" ("I found no new blocking issues").
// The machine-readable last word the rubric asks for: 'CLEAN', 'BLOCKING' or
// null when the reviewer left it out (then the phrase heuristic below applies).
function verdictLine(verdict) {
  const all = [...verdict.matchAll(/^\s*VERDICT:\s*(CLEAN|BLOCKING)\s*$/gim)];
  return all.length ? all[all.length - 1][1].toUpperCase() : null;
}

// A bullet that reads like a blocking finding written as prose: it says P1 or
// blocking (not "no", "non-" or "not" blocking, and not about a fixed P1) and
// names a repo path. Under a CLEAN verdict such a line fails the attempt.
const PROSE_BLOCKER = /(?<!\b(?:no|not|non|nothing|zero)[\s-]+(?:new\s+)?)\b(?:P1|blocking)\b/i;
const REPO_PATH = /(?:^|[\s`(])(?:(?:[\w.-]+\/)+[\w.-]*\w\.[A-Za-z]{1,5}|[\w-]{2,}[\w.-]*\.[A-Za-z]{1,5})(?::\d+)?(?=$|[\s`),.;:])/;
const SETTLED = /\b(?:fixed|resolved|addressed|no longer)\b/i;

function proseBlockerLines(verdict) {
  return verdict.split('\n').filter((l) => /^\s*[-*]\s/.test(l) && !/^\s*[-*]\s+\[P\d\]/.test(l) &&
    PROSE_BLOCKER.test(l) && REPO_PATH.test(l) && !SETTLED.test(l));
}

const isClean = (verdict) => /\bno\s+(?:[\w-]+\s+){0,2}(?:issues|findings)\b/i.test(verdict);

// A reviewer's output is usable when every finding-like line parses and it has
// findings or says it is clean. Anything else is a failed attempt.
function readVerdict(verdict, repoRoot = '') {
  if (!verdict.trim()) return { error: 'No verdict written' };
  const unparsed = unparsedFindingLines(verdict);
  if (unparsed.length) return { error: `Could not parse ${unparsed.length} finding line(s):\n${unparsed.join('\n')}` };
  const findings = parseFindings(verdict, repoRoot);
  const said = verdictLine(verdict);
  // BLOCKING with no parseable [P1] means the blocker was written in prose: a
  // failed attempt, never a pass. CLEAN next to a [P1] line: the P1 still counts.
  if (said === 'BLOCKING' && !findings.some((f) => f.priority === 'P1')) {
    return { error: 'Verdict says BLOCKING but no [P1] line could be read' };
  }
  if (said === 'CLEAN') {
    const prose = proseBlockerLines(verdict);
    if (prose.length) return { error: `Verdict says CLEAN but ${prose.length} line(s) read like an unformatted blocking finding:\n${prose.join('\n')}` };
  }
  if (!findings.length && said !== 'CLEAN' && !isClean(verdict)) return { error: 'Could not read findings or a clean verdict' };
  return { findings };
}

// Files that drew a blocking finding in each of the last two rounds: the "same
// class twice" stop. A P1 the Refuter could not reproduce does not count.
function repeatedBlockingFiles(rounds) {
  if (rounds.length < 2) return [];
  const blocking = (r) => new Set(r.findings.filter((f) => f.priority === 'P1' && f.verdict !== 'not-reproduced').map((f) => f.file));
  const last = blocking(rounds[rounds.length - 1]);
  return [...blocking(rounds[rounds.length - 2])].filter((f) => last.has(f));
}

const ROUNDS_LINE = /^Review rounds:.*$/m;
const HEAD_LINE = /^Reviewed head:.*$/m;
const FALLBACK_LINE = /^Review: same-model fallback$/m;
const FOLLOWUP_LINE = /^Review follow-up:.*$/m;
const STOP_LINE = /^Review stop:.*$/m;
const EXEMPT_LINE = /^Review: exempt\b.*$/m;
const REFUTER_LINE = /^Refuter:.*$/m;
const KIND_LINE = /^Kind: (user-visible|groundwork|fix|infra|docs)$/m;

// Replaces an existing line in place, otherwise appends it as its own paragraph.
const withLine = (body, pattern, line) => (pattern.test(body) ? body.replace(pattern, () => line) : `${body.trimEnd()}\n\n${line}\n`);

function pickReviewer({ trailers, codexAvailable, claudeAvailable }) {
  let codexAuthors = 0;
  let claudeAuthors = 0;
  for (const trailer of trailers) {
    const harness = trailer.trim().toLowerCase().split(/\s+/, 1)[0];
    if (harness === 'codex') codexAuthors++;
    if (harness === 'claude-code') claudeAuthors++;
  }
  const author = codexAuthors > claudeAuthors ? 'codex' : 'claude';
  const preferred = author === 'codex' ? 'claude' : 'codex';
  const other = preferred === 'codex' ? 'claude' : 'codex';
  const available = (name) => name === 'codex' ? codexAvailable : claudeAvailable;
  if (available(preferred)) return { reviewer: preferred, fallback: false };
  if (available(other)) return { reviewer: other, fallback: true };
  return { reviewer: preferred, fallback: false };
}

// Removing the line only tidies the blank lines around it: blank-line runs
// elsewhere (code fences, say) are left alone.
function withFallbackLine(body, fallback) {
  if (fallback) return FALLBACK_LINE.test(body) ? body : `${body.trimEnd()}\n\nReview: same-model fallback\n`;
  return body.replace(/(^|\n)(\n*)Review: same-model fallback(?:\n|$)(\n*)/,
    (m, lead, before, after) => (lead ? `${lead}${before.length + after.length ? '\n' : ''}` : ''));
}

// A counted round means the PR was reviewed after all: drop a stale exempt line.
function withoutExemptLine(body) {
  return body.replace(/(^|\n)(\n*)Review: exempt\b[^\n]*(?:\n|$)(\n*)/,
    (m, lead, before, after) => (lead ? `${lead}${before.length + after.length ? '\n' : ''}` : ''));
}

function withRoundsLine(body, rounds) {
  return withLine(body, ROUNDS_LINE, `Review rounds: ${rounds}/${ROUND_BUDGET}`);
}

function withFollowupLine(body, issue) {
  if (!Number.isInteger(issue) || issue <= 0) throw new Error(`not an issue number: ${issue}`);
  return withLine(body, FOLLOWUP_LINE, `Review follow-up: #${issue}`);
}

// The follow-up issue a PR body already names, if any.
function followupFromBody(body) {
  const m = /^Review follow-up: #(\d+)\s*$/m.exec(body);
  return m ? Number(m[1]) : undefined;
}

// Only written when the stop fires; an earlier stop line stays as the record.
function withStopLine(body, files) {
  return files.length ? withLine(body, STOP_LINE, `Review stop: same class twice — ${files.join(', ')}`) : body;
}

function withExemptLine(body, reason) {
  return withLine(body, EXEMPT_LINE, `Review: exempt — ${reason}`);
}

// GitHub's web editor saves CRLF; a Kind line typed there still counts.
const hasKindLine = (body) => KIND_LINE.test(body.replace(/\r\n/g, '\n'));

const KIND_HELP = 'The PR body needs a Kind line before review. Add one on a line of its own, exactly one of:\n' +
  '  Kind: user-visible\n  Kind: groundwork\n  Kind: fix\n  Kind: infra\n  Kind: docs\n' +
  'Edit the body on GitHub, or save it to a file, add the line and run: gh pr edit <number> --body-file <file>';

// Non-blocking findings parked in one follow-up issue per PR: the issue body
// carries round 1's items, later rounds add theirs as comments.
function followupItems({ round, head, findings }) {
  return `Round ${round} on ${head}:\n${findings.map((f) => `- [ ] ${f.title} — ${f.file}`).join('\n')}\n`;
}

function followupIssue({ pr, branch, round, head, findings }) {
  return {
    title: `Review follow-ups for PR #${pr} (${branch})`,
    body: `Non-blocking review findings parked from PR #${pr}. Tick each one when it is fixed or dropped.\n\n${followupItems({ round, head, findings })}`,
  };
}

// `git diff --numstat -z --no-renames` output -> [{ file, added, deleted }];
// added and deleted are null for a binary file.
function parseNumstat(text) {
  return text.split('\0').filter(Boolean).map((record) => {
    const [added, deleted, ...file] = record.split('\t');
    const count = (n) => (n === '-' ? null : Number(n));
    return { file: file.join('\t'), added: count(added), deleted: count(deleted) };
  });
}

// Process, security and dependency paths: never exempt as docs or config.
const PROTECTED_DIRS = new Set(['.github', '.claude', '.codex', '.agents', '_bmad', '.aplabs']);
const PROTECTED_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'package.json']);
const LOCKFILE = /(^|[-.])lock(\.(json|ya?ml)|b)?$|^npm-shrinkwrap\.json$/;
const CONFIG_EXEMPT_LINES = 10;

function isProtectedPath(file) {
  const parts = file.split('/');
  const base = parts[parts.length - 1];
  return parts.slice(0, -1).some((p) => PROTECTED_DIRS.has(p)) || PROTECTED_FILES.has(base) || LOCKFILE.test(base);
}

const isDocsPath = (file) => /\.mdx?$/i.test(file) || file.startsWith('docs/');

function isConfigPath(file) {
  const base = file.split('/').pop();
  return /\.(json|ya?ml|toml)$/i.test(base) || base === '.gitignore' || base === '.editorconfig';
}

// The commit a `git revert` message says it undoes, or null.
function revertedCommit(message) {
  const m = /^This reverts commit ([0-9a-f]{40})\.?$/m.exec(message);
  return m ? m[1] : null;
}

// Why a PR needs no review round, or null. commits are origin/main..HEAD, each
// with verifiedRevert: the CLI sets it only when the commit's diff is exactly
// the reverse of the commit its message names. A "Revert" title alone is
// forgeable and never exempts. changes come from parseNumstat on origin/main...HEAD.
function exemptionFor({ commits, changes }) {
  if (commits.length && commits.every((c) => c.verifiedRevert)) return 'revert';
  if (!changes.length || changes.some((c) => isProtectedPath(c.file))) return null;
  if (changes.every((c) => isDocsPath(c.file))) return 'docs only';
  const lines = changes.reduce((n, c) => n + (c.added ?? Infinity) + (c.deleted ?? Infinity), 0);
  if (changes.every((c) => isConfigPath(c.file)) && lines <= CONFIG_EXEMPT_LINES) {
    return `config changes of ${CONFIG_EXEMPT_LINES} lines or fewer`;
  }
  return null;
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

// The Refuter (Story 1.4): each P1 is tested before it blocks. A counted round
// gives its P1s ids R<round>-<n> and verdict 'pending'; `--refute` records the
// result. not-reproduced is kept as a record but no longer blocks.
const REFUTER_VERDICTS = ['confirmed', 'not-reproduced', 'cannot-verify'];
const REFUTE_USAGE = 'npm run review -- --refute <id> <confirmed|not-reproduced|cannot-verify> [--note "<evidence>"]';

function withRefuterIds(round, findings) {
  let n = 0;
  return findings.map((f) => (f.priority === 'P1' ? { ...f, id: `R${round}-${++n}`, verdict: 'pending' } : f));
}

const findP1 = (rounds, id) => rounds.flatMap((r) => r.findings).find((f) => f.priority === 'P1' && f.id === id);

// P1s that still block: the latest round's unless not reproduced (pending blocks
// until the Refuter has run), plus escalated ones from any round, which only
// the human clears. An earlier round's other P1s were checked by the round after it.
function blockingFindings(rounds) {
  const last = rounds.length - 1;
  return rounds.flatMap((r, i) => r.findings.filter((f) => f.priority === 'P1' &&
    (i === last ? f.verdict !== 'not-reproduced' : f.verdict === 'cannot-verify')));
}

// Counts every P1 on the branch; one recorded before Story 1.4 counts as pending.
function withRefuterLine(body, rounds) {
  const p1s = rounds.flatMap((r) => r.findings).filter((f) => f.priority === 'P1');
  const count = (verdict) => p1s.filter((f) => (f.verdict ?? 'pending') === verdict).length;
  return withLine(body, REFUTER_LINE, `Refuter: ${count('confirmed')} confirmed, ${count('not-reproduced')} not reproduced, ` +
    `${count('cannot-verify')} escalated, ${count('pending')} pending`);
}

// What the CLI prints after a round with P1s: each pending one and what to do with it.
function refuterBlock(findings, head) {
  const pending = findings.filter((f) => f.priority === 'P1' && f.verdict === 'pending');
  if (!pending.length) return '';
  return `\nRefuter: test each P1 before fixing it.\n${pending.map((f) => `  ${f.id}  ${f.title} — ${f.file}`).join('\n')}\n` +
    `Delegate each to the Refuter agent (.claude/agents/refuter.md) with the head SHA (${head}), then record the result with ` +
    `${REFUTE_USAGE}`;
}

const USAGE = `usage: npm run review [-- --over-budget "<the human's reason>"]\n       ${REFUTE_USAGE}`;

// Strict flags: any argument other than `--over-budget <text>` must not start a
// paid round. `--refute` takes the whole argument list and never starts one.
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.includes('--refute')) return parseRefute(argv);
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

function parseRefute(argv) {
  const [flag, id, verdict, ...rest] = argv;
  if (flag !== '--refute' || !id || !verdict) return { error: '--refute needs a P1 id and a verdict' };
  if (!/^R\d+-\d+$/.test(id)) return { error: `not a P1 id: ${id} (they look like R1-2)` };
  if (!REFUTER_VERDICTS.includes(verdict)) return { error: `verdict must be one of ${REFUTER_VERDICTS.join(', ')}, not ${verdict}` };
  if (!rest.length) return { refute: { id, verdict } };
  if (rest[0] !== '--note' || rest.length !== 2 || !rest[1].trim()) return { error: '--refute takes only --note "<evidence>" after the verdict' };
  return { refute: { id, verdict, note: rest[1] } };
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
  RUBRIC_BODY,
  CODEX_DIFF_LINE,
  STDIN_DIFF_LINE,
  USAGE,
  promptFor,
  claudeStdin,
  proseBlockerLines,
  parseFindings,
  unparsedFindingLines,
  isValidState,
  isClean,
  readVerdict,
  verdictLine,
  repeatedBlockingFiles,
  withRoundsLine,
  withReviewedHeadLine,
  REFUTER_VERDICTS,
  withRefuterIds,
  findP1,
  blockingFindings,
  withRefuterLine,
  refuterBlock,
  pickReviewer,
  withFallbackLine,
  withFollowupLine,
  followupFromBody,
  withStopLine,
  withExemptLine,
  hasKindLine,
  KIND_HELP,
  followupItems,
  followupIssue,
  parseNumstat,
  isProtectedPath,
  exemptionFor,
  revertedCommit,
  withoutExemptLine,
  parseArgs,
  sanitizeBranch,
};
