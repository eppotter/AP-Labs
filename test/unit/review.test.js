'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ROUND_BUDGET,
  RUBRIC,
  promptFor,
  parseFindings,
  unparsedFindingLines,
  isValidState,
  isClean,
  readVerdict,
  repeatedBlockingFiles,
  withRoundsLine,
  withReviewedHeadLine,
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
  assert.match(prompt, /Do not re-raise those/);
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
