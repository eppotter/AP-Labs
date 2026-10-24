'use strict';

// The review CLI end to end against a throwaway git repo, a stub reviewer and
// a stub gh (test/fixtures/review/). No model or network call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '../../kit/review/cli.js');
const fixtures = path.join(__dirname, '../fixtures/review');
const BRANCH = 'feat/review-me';
const P1_VERDICT = '- [P1] Loses rows on retry — kit/a.js:3\n- [P2] Rename var — kit/b.js:1\n';
const CLEAN_VERDICT = 'No blocking findings.\n';
const tmps = [];
test.after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-review-'));
  tmps.push(tmp);
  const repo = path.join(tmp, 'repo');
  const gh = path.join(tmp, 'gh');
  const codex = path.join(tmp, 'codex');
  const claude = path.join(tmp, 'claude');
  fs.mkdirSync(repo);
  fs.mkdirSync(gh);
  fs.mkdirSync(codex);
  fs.mkdirSync(claude);
  const env = {
    PATH: process.env.PATH,
    HOME: tmp,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    APLABS_REVIEW_CODEX_BIN: path.join(fixtures, 'fake-codex.sh'),
    APLABS_REVIEW_CLAUDE_BIN: path.join(fixtures, 'fake-claude.sh'),
    APLABS_GH_BIN: path.join(fixtures, 'fake-gh.sh'),
    FAKE_GH_DIR: gh,
    FAKE_CODEX_RECORD: codex,
    FAKE_CLAUDE_RECORD: claude,
  };
  const git = (...a) => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', BRANCH);
  const commit = (msg = 'change') => {
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const verdict = (text) => {
    const file = path.join(tmp, `verdict-${Math.random().toString(16).slice(2)}.md`);
    fs.writeFileSync(file, text);
    return file;
  };
  const openPr = (body = 'What this does: tests.') => fs.writeFileSync(path.join(gh, 'pr.json'), JSON.stringify({ number: 7, body, state: 'OPEN' }));
  const review = (args = [], extra = {}) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const stateDir = path.join(git('rev-parse', '--absolute-git-dir'), 'aplabs', 'review');
  const statePath = path.join(stateDir, 'feat%2Freview-me.json');
  const state = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null);
  const ghCalls = () => (fs.existsSync(path.join(gh, 'calls.txt')) ? fs.readFileSync(path.join(gh, 'calls.txt'), 'utf8') : '');
  const body = () => fs.readFileSync(path.join(gh, 'body-7.md'), 'utf8');
  const codexArgs = () => fs.readFileSync(path.join(codex, 'args.txt'), 'utf8');
  const codexRan = () => fs.existsSync(path.join(codex, 'args.txt'));
  const resetCodex = () => fs.rmSync(path.join(codex, 'args.txt'), { force: true });
  const claudeArgs = () => fs.readFileSync(path.join(claude, 'args.txt'), 'utf8').split('\0').filter(Boolean);
  const claudeRan = () => fs.existsSync(path.join(claude, 'args.txt'));
  return { tmp, repo, gh, codex, claude, git, commit, verdict, openPr, review, stateDir, statePath, state, ghCalls, body,
    codexArgs, codexRan, resetCodex, claudeArgs, claudeRan };
}

test('round 1: read-only codex with stdin closed, verdict and summary printed, PR body and state written', () => {
  const t = setup();
  t.openPr();
  const head = t.commit();
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(P1_VERDICT) });
  assert.equal(r.code, 0, r.err);

  const args = t.codexArgs().split('\n');
  assert.deepEqual(args.slice(0, 5), ['exec', '--sandbox', 'read-only', '-o', path.join(t.stateDir, 'feat%2Freview-me.round-1.md')]);
  assert.equal(args[5], 'review');
  assert.match(t.codexArgs(), /git diff origin\/main\.\.\.HEAD/);
  assert.doesNotMatch(t.codexArgs(), /round 2/);
  assert.equal(fs.readFileSync(path.join(t.gh, '../codex/stdin.txt'), 'utf8').trim(), 'closed');

  assert.match(r.out, /- \[P1\] Loses rows on retry — kit\/a\.js:3/);
  assert.match(r.out, new RegExp(`Round 1/3 on ${head.slice(0, 12)} \\(reviewer: codex\\): 1 blocking, 1 non-blocking\\.`));
  assert.match(r.out, /gh issue create --label review-followup/);
  assert.doesNotMatch(r.out, /fake codex chatter/, 'codex output goes to the log, not the terminal');
  assert.doesNotMatch(r.out, /No blocking findings: the review is done/);

  assert.equal(t.body(), `What this does: tests.\n\nReview rounds: 1/3\nReviewed head: ${head}\n`);
  assert.match(t.ghCalls(), /^pr edit 7 --body-file /m);
  const s = t.state();
  assert.equal(s.branch, BRANCH);
  assert.equal(s.rounds.length, 1);
  assert.equal(s.rounds[0].head, head);
  assert.deepEqual(s.rounds[0].findings.map((f) => f.file), ['kit/a.js', 'kit/b.js']);
  assert.match(t.git('status', '--porcelain'), /^$/, 'state never lands in tracked files');
});

test('Codex-authored commits use Claude with exact read-only flags and the three-dot diff on stdin', () => {
  const t = setup();
  t.openPr();
  t.commit('change\n\nAgent: codex gpt-6-luna');
  fs.mkdirSync(path.join(t.repo, 'kit'));
  fs.writeFileSync(path.join(t.repo, 'kit/a.js'), 'const value = 1;\n');
  t.git('add', 'kit/a.js');
  t.git('commit', '-q', '--amend', '-m', 'change\n\nAgent: codex gpt-6-luna');
  const head = t.git('rev-parse', 'HEAD');
  const r = t.review([], { FAKE_CLAUDE_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 0, r.err);
  const args = t.claudeArgs();
  assert.deepEqual(args.slice(0, 13), [
    '--print', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--no-chrome', '--disable-slash-commands',
  ]);
  assert.match(args.at(-1), /diff supplied on stdin/);
  assert.doesNotMatch(args.at(-1), /git diff origin\/main\.\.\.HEAD/);
  assert.match(fs.readFileSync(path.join(t.claude, 'stdin.txt'), 'utf8'), /const value = 1/);
  assert.equal(t.state().rounds[0].reviewer, 'claude');
  assert.equal(t.state().rounds[0].fallback, false);
  assert.match(r.out, new RegExp(`Round 1/3 on ${head.slice(0, 12)} \\(reviewer: claude\\):`));
});

test('Claude-authored commits use labelled Claude fallback when Codex is missing', () => {
  const t = setup();
  t.openPr();
  t.commit('change\n\nAgent: claude-code claude-opus-5-5');
  const r = t.review([], {
    APLABS_REVIEW_CODEX_BIN: path.join(t.tmp, 'missing-codex'),
    FAKE_CLAUDE_VERDICT: t.verdict(CLEAN_VERDICT),
  });
  assert.equal(r.code, 0, r.err);
  assert.match(t.body(), /Review: same-model fallback/);
  assert.match(r.out, /reviewer: claude, same-model fallback/);
  assert.deepEqual([t.state().rounds[0].reviewer, t.state().rounds[0].fallback], ['claude', true]);
});

test('Codex-authored commits use labelled Codex fallback when Claude is missing', () => {
  const t = setup();
  t.openPr();
  t.commit('change\n\nAgent: codex gpt-6-luna');
  const r = t.review([], {
    APLABS_REVIEW_CLAUDE_BIN: path.join(t.tmp, 'missing-claude'),
    FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT),
  });
  assert.equal(r.code, 0, r.err);
  assert.match(t.body(), /Review: same-model fallback/);
  assert.match(r.out, /reviewer: codex, same-model fallback/);
  assert.deepEqual([t.state().rounds[0].reviewer, t.state().rounds[0].fallback], ['codex', true]);
});

test('neither reviewer available exits without changing review state or PR body', () => {
  const t = setup();
  t.openPr('Existing body');
  t.commit('change\n\nAgent: codex gpt-6-luna');
  const r = t.review([], {
    APLABS_REVIEW_CLAUDE_BIN: path.join(t.tmp, 'missing-claude'),
    APLABS_REVIEW_CODEX_BIN: path.join(t.tmp, 'missing-codex'),
  });
  assert.equal(r.code, 1);
  assert.equal(t.state(), null);
  assert.doesNotMatch(t.ghCalls(), /pr edit/);
  assert.ok(!fs.existsSync(path.join(t.gh, 'body-7.md')));
});

test('failing Claude reviewer does not count a round', () => {
  const t = setup();
  t.openPr();
  t.commit('change\n\nAgent: codex gpt-6-luna');
  const r = t.review([], { FAKE_CLAUDE_VERDICT: t.verdict(CLEAN_VERDICT), FAKE_CLAUDE_EXIT: '1' });
  assert.equal(r.code, 1);
  assert.equal(t.state(), null);
  assert.doesNotMatch(t.ghCalls(), /pr edit/);
});

test('a successful non-fallback round removes a prior fallback body line', () => {
  const t = setup();
  t.openPr('Intro\n\nReview: same-model fallback\n');
  t.commit('change\n\nAgent: codex gpt-6-luna');
  const r = t.review([], { FAKE_CLAUDE_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(t.body(), /Review: same-model fallback/);
});

test('no open PR: refused with exit 2 before any reviewer run', () => {
  const t = setup();
  t.commit();
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 2);
  assert.match(r.err, /gh pr create --draft/);
  assert.ok(!t.codexRan());
  assert.equal(t.state(), null);

  fs.writeFileSync(path.join(t.gh, 'pr.json'), JSON.stringify({ number: 7, body: '', state: 'MERGED' }));
  const merged = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(merged.code, 2, 'a merged PR is not an open one');
  assert.ok(!t.codexRan());
});

test('rounds 2 and 3 ask for P1 only, list earlier findings, update the body in place; a 4th is refused', () => {
  const t = setup();
  t.openPr();
  const h1 = t.commit('one');
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(P1_VERDICT) }).code, 0);

  const h2 = t.commit('two');
  const r2 = t.review([], { FAKE_CODEX_VERDICT: t.verdict('- [P1] Still loses rows — kit/a.js:9\n') });
  assert.equal(r2.code, 0, r2.err);
  const prompt2 = t.codexArgs();
  assert.match(prompt2, /round 2 of 3\. Report \[P1\] findings only/);
  assert.match(prompt2, /- \[P1\] Loses rows on retry — kit\/a\.js/);
  assert.match(prompt2, /- \[P2\] Rename var — kit\/b\.js/);
  assert.match(prompt2, /Do not re-raise those/);
  assert.match(prompt2, new RegExp(`commits after ${h1}`));
  assert.match(r2.out, /Same class twice: kit\/a\.js/);
  assert.equal(t.body(), `What this does: tests.\n\nReview rounds: 2/3\nReviewed head: ${h2}\n`);

  const h3 = t.commit('three');
  const r3 = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r3.code, 0, r3.err);
  assert.match(t.codexArgs(), /round 3 of 3/);
  assert.match(t.codexArgs(), /- \[P1\] Still loses rows — kit\/a\.js/);
  assert.match(t.codexArgs(), new RegExp(`commits after ${h2}`));
  assert.match(r3.out, /No blocking findings: the review is done/);
  assert.equal(t.body(), `What this does: tests.\n\nReview rounds: 3/3\nReviewed head: ${h3}\n`);

  t.commit('four');
  t.resetCodex();
  const r4 = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r4.code, 3);
  assert.match(r4.err, /--over-budget/);
  assert.ok(!t.codexRan(), 'a refused round never starts the reviewer');
  assert.equal(t.state().rounds.length, 3);

  const r5 = t.review(['--over-budget', 'Ely: one more pass after the schema fix'], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r5.code, 0, r5.err);
  assert.match(r5.out, /Round 4\/3 .* Over budget with the human's go: Ely: one more pass after the schema fix\./);
  assert.match(t.body(), /^Review rounds: 4\/3$/m);
  assert.equal(t.state().rounds[3].overBudget, 'Ely: one more pass after the schema fix');
});

test('usage errors exit 2 and never start a paid round', () => {
  const t = setup();
  t.openPr();
  t.commit();
  for (const args of [['--foo'], ['--over-budget'], ['--over-budget', ''], ['--over-budget', '-x'], ['--over-budget', 'ok', 'extra']]) {
    const r = t.review(args, { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
    assert.equal(r.code, 2, `expected exit 2 for ${JSON.stringify(args)}`);
    assert.match(r.err, /usage:/);
  }
  assert.ok(!t.codexRan());
  assert.equal(t.ghCalls(), '', 'not even gh is called');
  assert.equal(t.state(), null);
});

test('re-reviewing the same head is refused: commit the fixes first', () => {
  const t = setup();
  t.openPr();
  t.commit();
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(P1_VERDICT) }).code, 0);
  t.resetCodex();
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 2);
  assert.match(r.err, /Commit the fixes first/);
  assert.ok(!t.codexRan());
  assert.equal(t.state().rounds.length, 1);
});

test('a failing or unreadable reviewer run does not count', () => {
  const t = setup();
  t.openPr();
  t.commit();

  const failed = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT), FAKE_CODEX_EXIT: '1' });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /does not count/);
  assert.equal(t.state(), null);

  const silent = t.review([]);
  assert.equal(silent.code, 1, 'no verdict file written');
  assert.equal(t.state(), null);

  const vague = t.review([], { FAKE_CODEX_VERDICT: t.verdict('Looks interesting, some thoughts below.\n') });
  assert.equal(vague.code, 1);
  assert.match(vague.err, /Could not read findings or a clean verdict/);
  assert.equal(t.state(), null);

  const missing = t.review([], { APLABS_REVIEW_CODEX_BIN: path.join(t.tmp, 'no-such-codex') });
  assert.equal(missing.code, 1);
  assert.equal(t.state(), null);

  assert.doesNotMatch(t.ghCalls(), /pr edit/, 'the PR body is untouched by a round that does not count');
  const ok = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(ok.code, 0, 'the same head can be reviewed once a real round succeeds');
  assert.match(ok.out, /Round 1\/3/);
});

test('state is kept per branch', () => {
  const t = setup();
  t.openPr();
  t.commit();
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) }).code, 0);
  t.git('checkout', '-q', '-b', 'feat_review-me');
  t.commit('other branch');
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Round 1\/3/, 'a look-alike branch name starts its own budget');
  assert.ok(fs.existsSync(path.join(t.stateDir, 'feat_review-me.json')));
  assert.equal(t.state().rounds.length, 1);
});

test('existing body lines are replaced in place', () => {
  const t = setup();
  t.openPr(`Intro\nReview rounds: 9/3\nReviewed head: ${'0'.repeat(40)}\nOutro`);
  const head = t.commit();
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) }).code, 0);
  assert.equal(t.body(), `Intro\nReview rounds: 1/3\nReviewed head: ${head}\nOutro`);
});

test('a corrupt state file stops the run instead of resetting the budget', () => {
  const t = setup();
  t.openPr();
  t.commit();
  fs.mkdirSync(t.stateDir, { recursive: true });
  fs.writeFileSync(t.statePath, '{not json');
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 1);
  assert.ok(!t.codexRan());
});

test('a state file with the wrong shape also stops the run', () => {
  const t = setup();
  t.openPr();
  t.commit();
  fs.mkdirSync(t.stateDir, { recursive: true });
  fs.writeFileSync(t.statePath, JSON.stringify({ branch: 'x', rounds: 'nope' }));
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 1);
  assert.ok(!t.codexRan());
});

test('a verdict with an unparseable finding line does not count', () => {
  const t = setup();
  t.openPr();
  t.commit();
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict('No blocking findings.\n- [P1] Something with no path\n') });
  assert.equal(r.code, 1);
  assert.match(r.err, /Could not parse 1 finding line/);
  assert.equal(t.state(), null);
});

test('a failed PR-body update is reported after the round is counted', () => {
  const t = setup();
  t.openPr();
  t.commit();
  fs.writeFileSync(path.join(t.gh, 'edit-fails'), '');
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 1);
  assert.match(r.err, /counted, but the PR body was not updated/);
  assert.equal(t.state().rounds.length, 1);
});

test('main is exported for in-process use', (t) => {
  t.mock.method(console, 'error', () => {});
  const { main } = require(cli);
  assert.equal(typeof main, 'function');
  assert.equal(main(['--bogus'], {}), 2);
});
