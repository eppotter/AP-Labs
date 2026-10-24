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
  repeatedBlockingFiles,
  withRoundsLine,
  withReviewedHeadLine,
  pickReviewer,
  withFallbackLine,
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
