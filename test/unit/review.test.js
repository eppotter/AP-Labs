'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ROUND_BUDGET,
  RUBRIC,
  RUBRIC_BODY,
  CODEX_DIFF_LINE,
  STDIN_DIFF_LINE,
  promptFor,
  claudeStdin,
  proseBlockerLines,
  parseFindings,
  unparsedFindingLines,
  isValidState,
  isClean,
  readVerdict,
  VERDICT_REMINDER,
  withVerdictReminder,
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
} = require('../../kit/lib/review');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const round = (head, findings) => ({ head, at: '2026-01-01T00:00:00.000Z', findings });
const p1 = (file, title = 'breaks it') => ({ priority: 'P1', title, file });
const p2 = (file, title = 'polish') => ({ priority: 'P2', title, file });

test('budget is three rounds', () => {
  assert.equal(ROUND_BUDGET, 3);
});

test('rubric scopes the diff and carries the adapted P1 wording', () => {
  assert.match(RUBRIC, /origin\/main\.\.\.HEAD/);
  assert.match(RUBRIC, /breaks auth, permissions or a safety invariant in AGENTS\.md/);
  assert.doesNotMatch(RUBRIC, /tenant/i);
});

test('round 1 prompt is the rubric alone', () => {
  assert.equal(promptFor({ branch: 'x', rounds: [] }), RUBRIC);
});

test('Claude prompt says the diff arrives on stdin', () => {
  const prompt = promptFor({ rounds: [] }, { diffOnStdin: true });
  assert.match(prompt, /diff supplied on stdin/);
  assert.doesNotMatch(prompt, /asks the reviewer to run git/i);
});

test('reviewer selection uses majority harness, treats ties and no trailers as Claude-authored, and falls back', () => {
  const available = { codexAvailable: true, claudeAvailable: true };
  assert.deepEqual(pickReviewer({ trailers: ['codex gpt-6-luna', 'codex gpt-6-luna', 'claude-code opus'], ...available }),
    { reviewer: 'claude', fallback: false });
  assert.deepEqual(pickReviewer({ trailers: ['claude-code opus', 'claude-code opus', 'codex gpt-6-luna'], ...available }),
    { reviewer: 'codex', fallback: false });
  for (const trailers of [[], ['codex gpt-6-luna', 'claude-code opus']]) {
    assert.deepEqual(pickReviewer({ trailers, ...available }), { reviewer: 'codex', fallback: false });
  }
  assert.deepEqual(pickReviewer({ trailers: ['codex gpt-6-luna'], codexAvailable: true, claudeAvailable: false }),
    { reviewer: 'codex', fallback: true });
  assert.deepEqual(pickReviewer({ trailers: [], codexAvailable: false, claudeAvailable: true }),
    { reviewer: 'claude', fallback: true });
});

test('fallback body line is added once and removed cleanly', () => {
  const fallback = withFallbackLine('Intro\n', true);
  assert.equal(fallback, 'Intro\n\nReview: same-model fallback\n');
  assert.equal(withFallbackLine(fallback, true), fallback);
  assert.equal(withFallbackLine(`${fallback}Outro\n`, false), 'Intro\n\nOutro\n');
});

test('later rounds ask for P1 only, list earlier findings and point past the last head', () => {
  const prompt = promptFor({ branch: 'x', rounds: [round(SHA_A, [p1('a.js', 'drops rows')]), round(SHA_B, [p2('b.js', 'naming')])] });
  assert.ok(prompt.startsWith(RUBRIC));
  assert.match(prompt, /round 3 of 3/);
  assert.match(prompt, /Report \[P1\] findings only/);
  assert.match(prompt, /- \[P1\] drops rows — a\.js/);
  assert.match(prompt, /- \[P2\] naming — b\.js/);
  assert.match(prompt, /Do not re-raise the \[P2\]s/);
  assert.match(prompt, /if it is still present, report it again as a \[P1\] line/);
  assert.match(prompt, new RegExp(`commits after ${SHA_B}`));
});

test('a later round with nothing found before says so', () => {
  assert.match(promptFor({ branch: 'x', rounds: [round(SHA_A, [])] }), /reported:\n\(nothing\)/);
});

test('parseFindings reads priority, title and a repo-relative path', () => {
  const verdict = [
    'Some preamble.',
    '- [P1] Loses rows on retry — /repo/root/kit/lib/x.js:12',
    '- [P2] Rename var — ./kit/review/cli.js:3-9',
    '- [P3] Typo — docs/a.md',
    '- [P1] Outside root — /elsewhere/y.js:1',
    '* [P1] not a list item we read — z.js:1',
  ].join('\n');
  assert.deepEqual(parseFindings(verdict, '/repo/root'), [
    { priority: 'P1', title: 'Loses rows on retry', file: 'kit/lib/x.js' },
    { priority: 'P2', title: 'Rename var', file: 'kit/review/cli.js' },
    { priority: 'P2', title: 'Typo', file: 'docs/a.md' },
    { priority: 'P1', title: 'Outside root', file: '/elsewhere/y.js' },
  ]);
});

test('parseFindings does not strip by folder name, only by repo root', () => {
  assert.deepEqual(parseFindings('- [P1] t — /a/b/src/x.js:1', '/a'), [{ priority: 'P1', title: 't', file: 'b/src/x.js' }]);
  assert.deepEqual(parseFindings('- [P1] t — /a/b/src/x.js:1'), [{ priority: 'P1', title: 't', file: '/a/b/src/x.js' }]);
  assert.deepEqual(parseFindings('- [P1] t — /a/b/x.js:1', '/a/'), [{ priority: 'P1', title: 't', file: 'b/x.js' }]);
  assert.deepEqual(parseFindings('- [P1] t — /ab/x.js:1', '/a'), [{ priority: 'P1', title: 't', file: '/ab/x.js' }]);
});

test('isClean recognises a clean verdict', () => {
  assert.ok(isClean('No blocking findings.'));
  assert.ok(isClean('I found no actionable issues.'));
  assert.ok(isClean('There are no discrete findings'));
  assert.ok(!isClean('Here are my thoughts on the code.'));
  assert.ok(!isClean(''));
});

test('repeatedBlockingFiles flags a file with P1s in the last two rounds only', () => {
  assert.deepEqual(repeatedBlockingFiles([round(SHA_A, [p1('a.js')])]), []);
  assert.deepEqual(repeatedBlockingFiles([round(SHA_A, [p1('a.js'), p1('b.js')]), round(SHA_B, [p1('a.js'), p2('b.js')])]), ['a.js']);
  assert.deepEqual(repeatedBlockingFiles([round(SHA_A, [p1('a.js')]), round(SHA_B, []), round(SHA_A, [p1('a.js')])]), []);
});

test('withRoundsLine replaces in place or appends', () => {
  assert.equal(withRoundsLine('Body', 1), 'Body\n\nReview rounds: 1/3\n');
  assert.equal(withRoundsLine('', 1), '\n\nReview rounds: 1/3\n');
  assert.equal(withRoundsLine('Top\nReview rounds: 1/3\nBottom', 2), 'Top\nReview rounds: 2/3\nBottom');
});

test('withReviewedHeadLine replaces in place, sits under the rounds line, or appends', () => {
  assert.equal(withReviewedHeadLine('Body', SHA_A), `Body\n\nReviewed head: ${SHA_A}\n`);
  assert.equal(withReviewedHeadLine('Review rounds: 1/3\nEnd', SHA_A), `Review rounds: 1/3\nReviewed head: ${SHA_A}\nEnd`);
  assert.equal(withReviewedHeadLine(`A\nReviewed head: ${SHA_A}\nB`, SHA_B), `A\nReviewed head: ${SHA_B}\nB`);
  assert.equal(withReviewedHeadLine(withRoundsLine('Body', 1), SHA_A), `Body\n\nReview rounds: 1/3\nReviewed head: ${SHA_A}\n`);
});

test('withReviewedHeadLine wants a full 40-hex sha', () => {
  assert.throws(() => withReviewedHeadLine('', 'abc123'));
  assert.throws(() => withReviewedHeadLine('', 'A'.repeat(40)));
});

test('PR-body helpers do not expand $ patterns from the body', () => {
  assert.equal(withRoundsLine("Review rounds: 0/3\ncost $& $1 $'", 1), "Review rounds: 1/3\ncost $& $1 $'");
});

test('parseArgs: no args, help, over-budget', () => {
  assert.deepEqual(parseArgs([]), { overBudget: undefined });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.deepEqual(parseArgs(['-h']), { help: true });
  assert.deepEqual(parseArgs(['--over-budget', 'Ely said go: one more pass']), { overBudget: 'Ely said go: one more pass' });
});

test('parseArgs rejects unknown, missing, empty and dash-led values', () => {
  for (const argv of [['--foo'], ['extra'], ['--over-budget'], ['--over-budget', ''], ['--over-budget', '   '],
    ['--over-budget', '--foo'], ['--over-budget', '-x'], ['--over-budget', 'ok', '--nope']]) {
    assert.ok(parseArgs(argv).error, `expected an error for ${JSON.stringify(argv)}`);
  }
});

test('sanitizeBranch keeps safe chars and encodes the rest injectively', () => {
  assert.equal(sanitizeBranch('review/story-1-1_x.y'), 'review%2Fstory-1-1_x.y');
  assert.notEqual(sanitizeBranch('a/b'), sanitizeBranch('a_b'));
  assert.notEqual(sanitizeBranch('a/b'), sanitizeBranch('a%2Fb'));
  assert.match(sanitizeBranch('feat/ü ~x'), /^[A-Za-z0-9._%-]+$/);
  assert.throws(() => sanitizeBranch(''));
});

test('parseFindings accepts backticked paths with an explanation on the same line', () => {
  const verdict = 'No blocking findings.\n\n- [P2] Reject malformed state — `kit/review/cli.js:60` If the state file has the wrong shape, refuse.\n- [P1] Bare form — lib/a.js:3\n';
  assert.deepEqual(parseFindings(verdict), [
    { priority: 'P2', title: 'Reject malformed state', file: 'kit/review/cli.js' },
    { priority: 'P1', title: 'Bare form', file: 'lib/a.js' },
  ]);
  assert.deepEqual(unparsedFindingLines(verdict), []);
});

test('unparsedFindingLines catches finding-like lines the parser cannot read', () => {
  assert.deepEqual(unparsedFindingLines('- [P1] No path at all\n- [P2] ok — a.js:1\n'), ['- [P1] No path at all']);
});

test('isValidState accepts only the expected shape', () => {
  assert.equal(isValidState({ branch: 'b', rounds: [] }), true);
  assert.equal(isValidState({ branch: 'b', rounds: [{ head: 'x', findings: [] }] }), true);
  for (const bad of [null, {}, { branch: 'b' }, { branch: 'b', rounds: {} }, { branch: 1, rounds: [] }, { branch: 'b', rounds: [{ head: 'x' }] }]) {
    assert.equal(isValidState(bad), false, JSON.stringify(bad));
  }
});

test('withFallbackLine removal tidies only the blank lines next to the removed line', () => {
  const fence = '```\na\n\n\nb\n```\n';
  assert.equal(withFallbackLine(`Intro\n\nReview: same-model fallback\n\n${fence}`, false), `Intro\n\n${fence}`);
  assert.equal(withFallbackLine(`${fence}\nReview: same-model fallback\n`, false), `${fence}\n`);
  assert.equal(withFallbackLine('Review: same-model fallback\n\nBody\n', false), 'Body\n');
  assert.equal(withFallbackLine('A\nReview: same-model fallback\nB', false), 'A\nB');
  assert.equal(withFallbackLine('A\n\n\n\nB', false), 'A\n\n\n\nB', 'nothing to remove leaves the body alone');
});

test('readVerdict accepts findings or a clean verdict and names every other outcome', () => {
  assert.deepEqual(readVerdict('- [P2] x — a.js:1\n'), { findings: [{ priority: 'P2', title: 'x', file: 'a.js' }] });
  assert.deepEqual(readVerdict('No blocking findings.\n'), { findings: [] });
  assert.match(readVerdict('').error, /No verdict written/);
  assert.match(readVerdict('  \n').error, /No verdict written/);
  assert.match(readVerdict('Some thoughts.\n').error, /Could not read findings or a clean verdict/);
  assert.match(readVerdict('No blocking findings.\n- [P1] no path\n').error, /Could not parse 1 finding line\(s\):\n- \[P1\] no path/);
});

test('follow-up, stop and exempt body lines replace in place or append', () => {
  assert.equal(withFollowupLine('Body', 42), 'Body\n\nReview follow-up: #42\n');
  assert.equal(withFollowupLine('A\nReview follow-up: #42\nB', 43), 'A\nReview follow-up: #43\nB');
  assert.throws(() => withFollowupLine('Body', 0));
  assert.equal(followupFromBody('A\nReview follow-up: #42\nB'), 42);
  assert.equal(followupFromBody('A\r\nReview follow-up: #42\r\nB'), 42);
  assert.equal(followupFromBody('Review follow-up: soon'), undefined);

  assert.equal(withStopLine('Body', []), 'Body', 'no stop, no line');
  assert.equal(withStopLine('Body', ['a.js', 'b.js']), 'Body\n\nReview stop: same class twice — a.js, b.js\n');
  assert.equal(withStopLine('A\nReview stop: same class twice — a.js\nB', ['c.js']), 'A\nReview stop: same class twice — c.js\nB');

  assert.equal(withExemptLine('Body', 'docs only'), 'Body\n\nReview: exempt — docs only\n');
  assert.equal(withExemptLine('A\nReview: exempt — revert\nB', 'docs only'), 'A\nReview: exempt — docs only\nB');
  assert.equal(withExemptLine('Review: same-model fallback', 'revert'), 'Review: same-model fallback\n\nReview: exempt — revert\n');
});

test('hasKindLine wants one of the five kinds on a line of its own', () => {
  for (const kind of ['user-visible', 'groundwork', 'fix', 'infra', 'docs']) {
    assert.ok(hasKindLine(`What this does: x.\nKind: ${kind}\n`), kind);
  }
  assert.ok(hasKindLine('Intro\r\nKind: fix\r\nMore'), 'CRLF bodies from the GitHub editor count');
  for (const body of ['', 'Kind: feature', 'kind: fix', ' Kind: fix', 'Kind: fix ', 'Kind:fix', 'The Kind: fix line']) {
    assert.ok(!hasKindLine(body), JSON.stringify(body));
  }
  assert.match(KIND_HELP, /Kind: user-visible\n {2}Kind: groundwork\n {2}Kind: fix\n {2}Kind: infra\n {2}Kind: docs/);
  assert.match(KIND_HELP, /gh pr edit <number> --body-file <file>/);
});

test('follow-up issue lists each P2 as a checkbox with the round and head', () => {
  const findings = [p2('kit/b.js', 'Rename var'), p2('docs/a.md', 'Typo')];
  const issue = followupIssue({ pr: 7, branch: 'feat/x', round: 1, head: SHA_A, findings });
  assert.equal(issue.title, 'Review follow-ups for PR #7 (feat/x)');
  assert.match(issue.body, /parked from PR #7/);
  assert.ok(issue.body.endsWith(`Round 1 on ${SHA_A}:\n- [ ] Rename var — kit/b.js\n- [ ] Typo — docs/a.md\n`));
  assert.equal(followupItems({ round: 2, head: SHA_B, findings: [findings[0]] }), `Round 2 on ${SHA_B}:\n- [ ] Rename var — kit/b.js\n`);
});

test('parseNumstat reads counts, binaries and odd file names', () => {
  assert.deepEqual(parseNumstat('3\t1\tREADME.md\0-\t-\tlogo.png\x001\t0\ta\tb.json\0'), [
    { file: 'README.md', added: 3, deleted: 1 },
    { file: 'logo.png', added: null, deleted: null },
    { file: 'a\tb.json', added: 1, deleted: 0 },
  ]);
  assert.deepEqual(parseNumstat(''), []);
});

test('protected paths cover process, security and dependency files at any depth', () => {
  for (const f of ['.github/workflows/ci.yml', '.claude/settings.json', '.codex/config.toml', '.agents/skills/x.md',
    '_bmad/a.yaml', '.aplabs/rules.json', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'package-lock.json', 'yarn.lock',
    'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json', 'examples/x/package.json', 'sub/.claude/x.md', 'docs/AGENTS.md']) {
    assert.ok(isProtectedPath(f), f);
  }
  for (const f of ['README.md', 'docs/a.md', 'config/clock.json', 'docs/deadlock.md', 'tsconfig.json']) {
    assert.ok(!isProtectedPath(f), f);
  }
});

test('exemptionFor: reverts, docs-only and small config changes are exempt; protected paths never are', () => {
  const ch = (file, added = 1, deleted = 0) => ({ file, added, deleted });
  const docs = [ch('README.md'), ch('docs/guide.mdx'), ch('docs/diagram.svg'), ch('kit/NOTES.MD')];
  const rev = (verifiedRevert) => ({ verifiedRevert });
  assert.equal(exemptionFor({ commits: [rev(true)], changes: [ch('kit/a.js', 50, 50)] }), 'revert');
  assert.equal(exemptionFor({ commits: [rev(true), rev(true)], changes: [ch('.github/ci.yml')] }), 'revert');
  assert.equal(exemptionFor({ commits: [rev(true), rev(false)], changes: [ch('kit/a.js')] }), null);
  assert.equal(exemptionFor({ commits: [rev(false)], changes: [ch('kit/a.js')] }), null, 'a forged Revert title is not verified');
  assert.equal(exemptionFor({ commits: [], changes: [] }), null, 'nothing to classify is not exempt');
  assert.equal(exemptionFor({ commits: [rev(false)], changes: [] }), null);

  assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: docs }), 'docs only');
  assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: [...docs, ch('AGENTS.md')] }), null);
  assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: [ch('.github/PULL_REQUEST_TEMPLATE.md')] }), null);
  assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: [ch('CLAUDE.md')] }), null);
  assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: [...docs, ch('kit/a.js')] }), null);

  const small = 'config changes of 10 lines or fewer';
  assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: [ch('a.json', 4, 1), ch('b.yml', 2, 0), ch('c.yaml', 1, 0), ch('d.toml', 1, 0),
    ch('.gitignore', 1, 0)] }), small, 'exactly 10 lines');
  assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: [ch('sub/.editorconfig', 2, 2)] }), small);
  assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: [ch('a.json', 6, 5)] }), null, '11 lines');
  assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: [ch('a.json', 1, 0), { file: 'b.json', added: null, deleted: null }] }), null,
    'a binary disqualifies');
  for (const file of ['package.json', 'package-lock.json', '.github/dependabot.yml', '.claude/settings.json', '_bmad/config.yaml',
    '.aplabs/rules.json', '.codex/config.toml', '.agents/x.yaml']) {
    assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: [ch(file)] }), null, file);
  }
  assert.equal(exemptionFor({ commits: [{ verifiedRevert: false }], changes: [ch('README.md'), ch('a.json')] }), null, 'docs plus config is neither');
});

test('isValidState accepts an optional positive integer follow-up issue', () => {
  assert.equal(isValidState({ branch: 'b', rounds: [], followup: 42 }), true);
  for (const followup of [0, -1, 1.5, '42', null]) {
    assert.equal(isValidState({ branch: 'b', rounds: [], followup }), false, JSON.stringify(followup));
  }
});

test('revertedCommit reads the sha a git revert message names', () => {
  const sha = 'a'.repeat(40);
  assert.equal(revertedCommit(`Revert "Add x"\n\nThis reverts commit ${sha}.\n`), sha);
  assert.equal(revertedCommit('Revert "Add x"\n\nNo sha here.'), null);
  assert.equal(revertedCommit(`This reverts commit ${'a'.repeat(39)}.`), null);
});

test('withoutExemptLine drops a stale exempt line and nothing else', () => {
  assert.equal(withoutExemptLine('A\n\nReview: exempt — docs only\n'), 'A\n\n');
  assert.equal(withoutExemptLine('A\nReview: exempt — revert\nB'), 'A\nB');
  assert.equal(withoutExemptLine('A\n```\n\n\n\n```\nB'), 'A\n```\n\n\n\n```\nB');
});

test('isClean accepts the common paraphrases of a clean verdict', () => {
  for (const v of ['No blocking findings.', 'I found no blocking issues in the branch changes.', 'No issues found.']) assert.ok(isClean(v), v);
  assert.ok(!isClean('Looks interesting, some thoughts below.'));
});

test('isClean accepts up to two words between "no" and issues/findings, as Codex writes them', () => {
  for (const v of ['I found no blocking issues in the branch changes.',
    'I found no new blocking issues in the subsequent commits or their interaction with the rest of the diff.',
    'No new findings.', 'There are no P1-level findings.']) {
    assert.ok(isClean(v), v);
  }
  for (const v of ['I have no idea whether these issues matter.', 'No time to check all findings.', 'Issues found below.',
    'Know issues: none listed', 'There are notable issues.']) {
    assert.ok(!isClean(v), v);
  }
});

test('rubric says every finding must use the exact line format or be ignored', () => {
  assert.match(RUBRIC, /Every finding, including non-blocking ones, must be a line in exactly the "- \[P1\|P2\] <title> — <path>:<line>" format; findings in any other form are ignored\./);
});

const refuted = (file, verdict, id = 'R1-1') => ({ ...p1(file), id, verdict });

test('withRefuterIds numbers a round\'s P1s R<round>-<n> in order, pending, and leaves P2s alone', () => {
  assert.deepEqual(withRefuterIds(2, [p1('a.js'), p2('b.js'), p1('c.js')]), [
    { ...p1('a.js'), id: 'R2-1', verdict: 'pending' },
    p2('b.js'),
    { ...p1('c.js'), id: 'R2-2', verdict: 'pending' },
  ]);
  assert.deepEqual(withRefuterIds(1, []), []);
});

test('findP1 finds a P1 by id in any round', () => {
  const rounds = [round(SHA_A, [refuted('a.js', 'pending', 'R1-1')]), round(SHA_B, [refuted('b.js', 'pending', 'R2-1')])];
  assert.equal(findP1(rounds, 'R1-1').file, 'a.js');
  assert.equal(findP1(rounds, 'R2-1').file, 'b.js');
  assert.equal(findP1(rounds, 'R3-1'), undefined);
});

test('blockingFindings: latest round P1s block unless not reproduced; escalated ones block from any round', () => {
  assert.deepEqual(REFUTER_VERDICTS, ['confirmed', 'not-reproduced', 'cannot-verify']);
  const latest = (verdict) => blockingFindings([round(SHA_A, [refuted('a.js', verdict)])]);
  assert.equal(latest('pending').length, 1, 'pending blocks');
  assert.equal(latest('confirmed').length, 1);
  assert.equal(latest('cannot-verify').length, 1);
  assert.equal(latest('not-reproduced').length, 0);
  assert.equal(blockingFindings([round(SHA_A, [p1('a.js')])]).length, 1, 'a P1 with no verdict blocks');
  assert.deepEqual(blockingFindings([round(SHA_A, [p2('a.js')])]), []);
  assert.deepEqual(blockingFindings([]), []);

  const earlier = (verdict) => blockingFindings([round(SHA_A, [refuted('a.js', verdict)]), round(SHA_B, [])]);
  assert.equal(earlier('cannot-verify').length, 1, 'an escalation is never dropped by a later round');
  for (const v of ['pending', 'confirmed', 'not-reproduced']) assert.equal(earlier(v).length, 0, v);
});

test('repeatedBlockingFiles ignores P1s that were not reproduced', () => {
  const twice = (a, b) => repeatedBlockingFiles([round(SHA_A, [refuted('a.js', a)]), round(SHA_B, [refuted('a.js', b, 'R2-1')])]);
  assert.deepEqual(twice('confirmed', 'pending'), ['a.js']);
  assert.deepEqual(twice('cannot-verify', 'confirmed'), ['a.js']);
  assert.deepEqual(twice('not-reproduced', 'pending'), []);
  assert.deepEqual(twice('confirmed', 'not-reproduced'), []);
});

test('withRefuterLine counts every P1 on the branch and replaces the line in place', () => {
  const rounds = [
    round(SHA_A, [refuted('a.js', 'confirmed', 'R1-1'), refuted('b.js', 'not-reproduced', 'R1-2'), p2('c.js')]),
    round(SHA_B, [refuted('d.js', 'cannot-verify', 'R2-1'), refuted('e.js', 'pending', 'R2-2'), p1('legacy.js')]),
  ];
  const line = 'Refuter: 1 confirmed, 1 not reproduced, 1 escalated, 2 pending';
  assert.equal(withRefuterLine('Body', rounds), `Body\n\n${line}\n`);
  assert.equal(withRefuterLine('A\nRefuter: 0 confirmed, 0 not reproduced, 0 escalated, 9 pending\nB', rounds), `A\n${line}\nB`);
});

test('refuterBlock lists pending P1s with the exact Refuter instruction', () => {
  const block = refuterBlock([refuted('kit/a.js', 'pending', 'R1-1'), p2('kit/b.js'), refuted('kit/c.js', 'confirmed', 'R1-2')], SHA_A);
  assert.match(block, /^\nRefuter: test each P1 before fixing it\.\n {2}R1-1 {2}breaks it — kit\/a\.js\n/);
  assert.doesNotMatch(block, /R1-2|kit\/b\.js/);
  assert.ok(block.endsWith(`Delegate each to the Refuter agent (.claude/agents/refuter.md) with the head SHA (${SHA_A}), then record the result with ` +
    'npm run review -- --refute <id> <confirmed|not-reproduced|cannot-verify> [--note "<evidence>"]'));
  assert.equal(refuterBlock([p2('kit/b.js')], SHA_A), '');
});

test('parseArgs reads --refute with an optional note and rejects everything else', () => {
  assert.deepEqual(parseArgs(['--refute', 'R1-2', 'confirmed']), { refute: { id: 'R1-2', verdict: 'confirmed' } });
  assert.deepEqual(parseArgs(['--refute', 'R12-1', 'not-reproduced', '--note', 'ran node --test: 0 failures']),
    { refute: { id: 'R12-1', verdict: 'not-reproduced', note: 'ran node --test: 0 failures' } });
  for (const argv of [['--refute'], ['--refute', 'R1-1'], ['--refute', 'R1-1', 'maybe'], ['--refute', 'X1', 'confirmed'],
    ['--refute', 'R1-1', 'confirmed', '--note'], ['--refute', 'R1-1', 'confirmed', '--note', ' '],
    ['--refute', 'R1-1', 'confirmed', '--other', 'x'], ['--refute', 'R1-1', 'confirmed', '--note', 'a', 'b'],
    ['--over-budget', 'go', '--refute', 'R1-1', 'confirmed'], ['--refute', 'R1-1', 'pending']]) {
    assert.ok(parseArgs(argv).error, `expected an error for ${JSON.stringify(argv)}`);
  }
});

test('isValidState checks Refuter fields on findings', () => {
  const state = (finding) => ({ branch: 'b', rounds: [{ head: 'x', findings: [finding] }] });
  for (const verdict of ['pending', 'confirmed', 'not-reproduced', 'cannot-verify']) {
    assert.equal(isValidState(state({ ...p1('a.js'), id: 'R1-1', verdict, note: 'n' })), true, verdict);
  }
  assert.equal(isValidState(state(p1('a.js'))), true, 'a pre-Refuter P1');
  for (const bad of [{ ...p1('a.js'), verdict: 'maybe' }, { ...p1('a.js'), id: 3 }, { ...p1('a.js'), note: 1 }, null]) {
    assert.equal(isValidState(state(bad)), false, JSON.stringify(bad));
  }
});

test('the VERDICT line decides when present; the phrase heuristic is only a fallback', () => {
  assert.equal(verdictLine('All good.\nVERDICT: CLEAN\n'), 'CLEAN');
  assert.equal(verdictLine('verdict: blocking'), 'BLOCKING');
  assert.equal(verdictLine('No VERDICT here'), null);
  const prose = 'No blocking or non-blocking defects were identified.\nVERDICT: CLEAN\n';
  assert.deepEqual(readVerdict(prose), { findings: [] }, 'paraphrase plus CLEAN line reads as clean');
  assert.match(readVerdict('Something is wrong in the gate.\nVERDICT: BLOCKING\n').error, /BLOCKING but no \[P1\]/);
  const mixed = '- [P1] Data loss — kit/a.js:1\nVERDICT: CLEAN\n';
  assert.equal(readVerdict(mixed).findings[0].priority, 'P1', 'a listed P1 counts even under a CLEAN line');
  assert.ok(readVerdict('- [P2] Nit — kit/a.js:2\nVERDICT: CLEAN\n').findings.length === 1);
});

test('the rubric asks for the VERDICT line', () => {
  assert.match(RUBRIC, /VERDICT: CLEAN/);
  assert.match(RUBRIC, /VERDICT: BLOCKING/);
});

test('the rubric is a diff line plus a shared body; only the first line differs between reviewers', () => {
  assert.equal(RUBRIC, `${CODEX_DIFF_LINE}\n${RUBRIC_BODY}`);
  const codex = promptFor({ rounds: [] });
  const claude = promptFor({ rounds: [] }, { diffOnStdin: true });
  assert.equal(codex.split('\n')[0], CODEX_DIFF_LINE);
  assert.equal(claude.split('\n')[0], STDIN_DIFF_LINE);
  assert.equal(codex.split('\n').slice(1).join('\n'), RUBRIC_BODY);
  assert.equal(claude.split('\n').slice(1).join('\n'), RUBRIC_BODY);
  assert.match(RUBRIC_BODY.split('\n').at(-2), /^End your reply with exactly one final line: "VERDICT: CLEAN" if there is no \[P1\], or "VERDICT: BLOCKING" if there is at least one\.$/);
});

test('later Claude rounds point at the since-head section on stdin; Codex prompts are unchanged', () => {
  const state = { rounds: [round(SHA_A, [p1('a.js', 'drops rows')])] };
  const claude = promptFor(state, { diffOnStdin: true });
  assert.ok(claude.startsWith(`${STDIN_DIFF_LINE}\n${RUBRIC_BODY}`));
  assert.ok(claude.includes(`commits after ${SHA_A} (their diff is on stdin after the line "===== Changes since ${SHA_A} (git diff ${SHA_A}..HEAD) =====")`));
  assert.ok(promptFor(state).endsWith(`Then look at the commits after ${SHA_A} and how they interact with the rest of the diff.`));
  assert.doesNotMatch(promptFor(state), /stdin/);
});

test('claudeStdin: the full diff alone in round 1, then a header and the diff since the last head', () => {
  assert.equal(claudeStdin('full\n', undefined, null), 'full\n');
  assert.equal(claudeStdin('full\n', SHA_A, 'since\n'), `full\n===== Changes since ${SHA_A} (git diff ${SHA_A}..HEAD) =====\nsince\n`);
  assert.equal(claudeStdin('full', SHA_A, ''), `full\n===== Changes since ${SHA_A} (git diff ${SHA_A}..HEAD) =====\n`);
  assert.match(claudeStdin('full\n', SHA_A, null), /=====\n\(unavailable: a{40} is not in this repository\)\n$/);
});

test('a CLEAN verdict with a blocking finding written as a prose bullet is a failed attempt', () => {
  for (const line of ['- P1: drops rows in kit/a.js:3', '* Blocking: kit/lib/x.js loses data on retry', '- P1 in `index.js` line 3']) {
    const r = readVerdict(`Looked at the diff.\n${line}\nVERDICT: CLEAN\n`);
    assert.match(r.error, /Verdict says CLEAN but 1 line\(s\) read like an unformatted blocking finding:\n/, line);
    assert.ok(r.error.endsWith(line), line);
  }
});

test('the prose-finding guard ignores negations, settled P1s, formatted lines and lines without a path', () => {
  const ok = [
    '- No blocking issues in kit/a.js',
    '- no new blocking issues found in kit/a.js',
    '- non-blocking: rename in kit/b.js',
    '- Not blocking: kit/b.js could be tidier',
    '- The earlier P1 in kit/a.js is fixed',
    '- R1-1 (kit/a.js) resolved by the retry guard',
    '- Blocking issue with the gate, but no file named',
    '- e.g. P1 vs P2',
    'P1 mentioned in kit/a.js outside a bullet',
  ];
  for (const line of ok) {
    assert.deepEqual(proseBlockerLines(line), [], line);
    assert.deepEqual(readVerdict(`${line}\nVERDICT: CLEAN\n`), { findings: [] }, line);
  }
  assert.deepEqual(readVerdict('- [P2] Nit — kit/a.js:2\nVERDICT: CLEAN\n').findings.length, 1);
  assert.deepEqual(proseBlockerLines('- P1: kit/a.js drops rows'), ['- P1: kit/a.js drops rows']);
  const noLine = readVerdict('No blocking findings.\n- Blocking: kit/a.js drops rows\n');
  assert.deepEqual(noLine, { findings: [] }, 'the guard applies only under a VERDICT: CLEAN line');
});

test('isClean accepts "defects", "problems" and "bugs" paraphrases (Codex on #57)', () => {
  for (const v of ['No blocking or non-blocking defects were found in the diff.', 'No problems found.', 'I found no bugs.']) assert.ok(isClean(v), v);
});

// Issue #81: on PR #80 Codex reasoned aloud inside a finding line and the
// parser filed it as a P2. This is that line, verbatim from the round's -o file.
const PR80_LINE = '- [P2] Redact credentials from connector initialization errors — `kit/runtime/connectors/contract.js:179` — If `connect()` throws while initializing, the error is caught and sanitized by the caller, but credentials read earlier in the loop are not added to `seen` until after each registration; more importantly, `log.registerSecret` failures or errors that embed credentials can escape before `session` is assigned and may expose details. Wait, credentials are added before connect. The notable issue is `connect()` synchronous throw is caught yes. No finding? Need actual issue. Key inFlight race: ledger.get async concurrent both call, then inFlight check after await; first sets after awaiting ledger get, event scheduling second likewise; first resumes sets inFlight and starts run; likely fine. Durable store not atomic across process (not exactly guarantee). check suite output. Final no findings likely. Verify code concern generated error constructor. Output exact requested.';

test('a finding line that reasons aloud is never filed: the attempt fails (#81, PR #80)', () => {
  const r = readVerdict(`${PR80_LINE}\n`);
  assert.equal(r.findings, undefined);
  assert.match(r.error, /1 finding line\(s\) read like reasoning, not a finding:\n- \[P2\] Redact credentials/);
  assert.match(readVerdict(`${PR80_LINE}\nVERDICT: CLEAN\n`).error, /read like reasoning/);
});

test('hedges in a finding line fail the attempt; plain explanations still parse', () => {
  const hedged = [
    '- [P2] Retry drops the id — kit/a.js:3 — The message omits it. Wait, it is added later.',
    '- [P2] Retry drops the id — kit/a.js:3 — Hmm, maybe not.',
    '- [P2] Retry drops the id — kit/a.js:3 — No finding? Probably fine.',
    '- [P2] Race in the ledger — kit/a.js:3 — likely fine on one process.',
    '- [P2] Does the retry drop the id? — kit/a.js:3',
    '- [P1] Data loss — kit/a.js:3 — Actually, never mind, the guard catches it.',
  ];
  for (const line of hedged) assert.match(readVerdict(`${line}\nVERDICT: CLEAN\n`).error ?? '', /read like reasoning/, line);
  const plain = [
    '- [P2] Retry drops the id — `kit/a.js:3` — The error says "write failed" without naming the connector, so two connectors are ambiguous.',
    '- [P1] Gate skips approval — kit/a.js:3 — `approve()` returns early when the plan is missing, so a write runs unapproved; is that path reachable? Yes, from the CLI.',
    '- [P2] Wait timeout is hard-coded — kit/a.js:3 — The 30 s wait cannot be configured.',
  ];
  for (const line of plain) assert.equal(readVerdict(`${line}\nVERDICT: CLEAN\n`).findings?.length, 1, line);
});

test('only the final structured output counts: reasoning and tool traces in a Codex transcript are ignored (#81)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const transcript = fs.readFileSync(path.join(__dirname, '../fixtures/review/codex-transcript-reasoning.log'), 'utf8');
  assert.deepEqual(readVerdict(transcript), {
    findings: [{ priority: 'P2', title: 'Retry message drops the connector id', file: 'kit/runtime/connectors/suite.js' }],
  });
  const clean = transcript.replace(/^codex\n[\s\S]*$/m, 'codex\nNo blocking findings.\nVERDICT: CLEAN\ntokens used\n9\n');
  assert.deepEqual(readVerdict(clean), { findings: [] }, 'a [P1] and a BLOCKING line in the reasoning do not count');
});

test('thinking blocks are ignored and findings must come before the VERDICT line', () => {
  const thinking = '<thinking>\n- [P1] Maybe data loss — kit/a.js:1\nVERDICT: BLOCKING\n</thinking>\nNo blocking findings.\nVERDICT: CLEAN\n';
  assert.deepEqual(readVerdict(thinking), { findings: [] });
  const after = readVerdict('- [P2] Nit — kit/a.js:2\nVERDICT: CLEAN\n- [P1] Data loss — kit/b.js:1\n');
  assert.match(after.error, /1 finding line\(s\) after the VERDICT line:\n- \[P1\] Data loss/);
});

test('the rubric asks for one sentence per finding and no reasoning in the finding line (#81)', () => {
  assert.match(RUBRIC_BODY, /one sentence per finding; no reasoning in the finding line/i);
});

// Malformed Codex verdicts (samples in the shape of real replies, test/fixtures/review/).
const sample = (name) => require('node:fs').readFileSync(require('node:path').join(__dirname, '../fixtures/review', name), 'utf8');

test('BLOCKING with only [P2] lines reads as CLEAN with those P2s and a one-line note', () => {
  const r = readVerdict(sample('codex-blocking-p2-only.md'));
  assert.deepEqual(r.findings, [{ priority: 'P2', title: 'Retry message names the wrong reviewer', file: 'kit/review/cli.js' }]);
  assert.equal(r.error, undefined);
  assert.equal(r.retry, undefined);
  assert.match(r.note, /^Verdict said BLOCKING but listed only \[P2\] findings; read as CLEAN with 1 non-blocking finding\(s\)\.$/);
});

test('BLOCKING with only [P2] lines and a prose blocker bullet is a retryable failure, never a pass', () => {
  const r = readVerdict('- [P2] Nit — kit/a.js:2\n- Blocking: kit/b.js drops rows on retry\nVERDICT: BLOCKING\n');
  assert.match(r.error, /Verdict says BLOCKING but 1 line\(s\) read like an unformatted blocking finding/);
  assert.equal(r.retry, true);
  assert.equal(r.findings, undefined);
});

test('a reply with no VERDICT line and no readable finding is a retryable failure', () => {
  const r = readVerdict(sample('codex-no-verdict.md'));
  assert.match(r.error, /Could not read findings or a clean verdict/);
  assert.equal(r.retry, true);
  assert.equal(readVerdict('Some thoughts.\n').retry, true);
});

test('BLOCKING with no finding lines at all is a retryable failure', () => {
  const r = readVerdict(sample('codex-blocking-prose.md'));
  assert.match(r.error, /Verdict says BLOCKING but no \[P1\] line could be read/);
  assert.equal(r.retry, true);
});

test('CLEAN with a listed [P1] keeps the P1 and is never retried (a retry could lose it)', () => {
  const r = readVerdict(sample('codex-clean-with-p1.md'));
  assert.deepEqual(r.findings.map((f) => f.priority), ['P1']);
  assert.equal(r.retry, undefined);
  assert.match(r.note, /^Verdict said CLEAN but listed 1 \[P1\] finding\(s\); read as BLOCKING: the P1s count\.$/);
  const prose = readVerdict('- [P1] Data loss — kit/a.js:1\n- Blocking: kit/b.js drops rows\nVERDICT: CLEAN\n');
  assert.match(prose.error, /Verdict says CLEAN but 1 line/);
  assert.equal(prose.retry, undefined, 'a reply with a readable P1 is never retried');
});

test('malformed and reasoning-aloud finding lines are never retried: they go straight to the fallback', () => {
  assert.equal(readVerdict('- [P1] no path here\n').retry, undefined);
  assert.equal(readVerdict(`${PR80_LINE}\n`).retry, undefined);
  assert.equal(readVerdict('- [P2] Nit — kit/a.js:2\nVERDICT: CLEAN\n- [P1] Data loss — kit/b.js:1\n').retry, undefined);
  assert.equal(readVerdict('').retry, undefined);
});

test('the retry prompt is the round prompt plus the VERDICT reminder', () => {
  const state = { branch: 'b', rounds: [] };
  const reminded = withVerdictReminder(promptFor(state));
  assert.ok(reminded.startsWith(promptFor(state)));
  assert.ok(reminded.endsWith(`\n\n${VERDICT_REMINDER}`));
  assert.match(VERDICT_REMINDER, /^End with exactly one VERDICT line/);
});
