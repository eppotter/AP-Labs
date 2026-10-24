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
  // Commits real file content: { path: text }.
  const commitFiles = (files, msg = 'change') => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
      git('add', file);
    }
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const verdict = (text) => {
    const file = path.join(tmp, `verdict-${Math.random().toString(16).slice(2)}.md`);
    fs.writeFileSync(file, text);
    return file;
  };
  const openPr = (body = 'What this does: tests.\nKind: infra') => fs.writeFileSync(path.join(gh, 'pr.json'), JSON.stringify({ number: 7, body, state: 'OPEN' }));
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
  const ghFile = (name) => fs.readFileSync(path.join(gh, name), 'utf8');
  const ghFlag = (name) => fs.writeFileSync(path.join(gh, name), '');
  return { tmp, repo, gh, codex, claude, git, commit, commitFiles, ghFile, ghFlag, verdict, openPr, review, stateDir, statePath, state, ghCalls, body,
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
  assert.match(r.out, /Filed 1 non-blocking finding\(s\) in follow-up issue #42\./);
  assert.doesNotMatch(r.out, /fake codex chatter/, 'codex output goes to the log, not the terminal');
  assert.doesNotMatch(r.out, /No blocking findings: the review is done/);

  assert.equal(t.body(), `What this does: tests.\nKind: infra\n\nReview rounds: 1/3\nReviewed head: ${head}\n\nReview follow-up: #42\n\n` +
    'Refuter: 0 confirmed, 0 not reproduced, 0 escalated, 1 pending\n');
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
  t.openPr('Existing body\nKind: fix');
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
  t.openPr('Intro\nKind: fix\n\nReview: same-model fallback\n');
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
  assert.match(prompt2, /Do not re-raise the \[P2\]s/);
  assert.match(prompt2, new RegExp(`commits after ${h1}`));
  assert.match(r2.out, /Same class twice: kit\/a\.js/);
  assert.equal(t.body(), `What this does: tests.\nKind: infra\n\nReview rounds: 2/3\nReviewed head: ${h2}\n\nReview follow-up: #42\n\n` +
    'Refuter: 0 confirmed, 0 not reproduced, 0 escalated, 2 pending\n\nReview stop: same class twice — kit/a.js\n');

  const h3 = t.commit('three');
  const r3 = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r3.code, 0, r3.err);
  assert.match(t.codexArgs(), /round 3 of 3/);
  assert.match(t.codexArgs(), /- \[P1\] Still loses rows — kit\/a\.js/);
  assert.match(t.codexArgs(), new RegExp(`commits after ${h2}`));
  assert.match(r3.out, /No blocking findings: the review is done/);
  assert.equal(t.body(), `What this does: tests.\nKind: infra\n\nReview rounds: 3/3\nReviewed head: ${h3}\n\nReview follow-up: #42\n\n` +
    'Refuter: 0 confirmed, 0 not reproduced, 0 escalated, 2 pending\n\nReview stop: same class twice — kit/a.js\n');

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
  t.openPr(`Intro\nKind: fix\nReview rounds: 9/3\nReviewed head: ${'0'.repeat(40)}\nOutro`);
  const head = t.commit();
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) }).code, 0);
  assert.equal(t.body(), `Intro\nKind: fix\nReview rounds: 1/3\nReviewed head: ${head}\nOutro`);
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

const P2_ONLY = '- [P2] Tidy names — kit/c.js:2\nNo blocking findings.\n';
const lines = (n) => Array.from({ length: n }, (_, i) => `k${i}: ${i}`).join('\n') + '\n';

test('a PR body without a Kind line is refused before any reviewer run, with the fix spelled out', () => {
  const t = setup();
  for (const body of ['What this does: tests.', 'What this does: tests.\nKind: feature', 'What this does: tests.\nKind: fix (small)']) {
    t.openPr(body);
    t.commit();
    const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
    assert.equal(r.code, 2, body);
    assert.match(r.err, /needs a Kind line/);
    assert.match(r.err, /Kind: user-visible\n {2}Kind: groundwork\n {2}Kind: fix\n {2}Kind: infra\n {2}Kind: docs/);
    assert.match(r.err, /gh pr edit 7 --body-file <file>/);
  }
  assert.ok(!t.codexRan());
  assert.ok(!t.claudeRan());
  assert.equal(t.state(), null);
  assert.doesNotMatch(t.ghCalls(), /pr edit|issue|label/);
});

test('a missing origin/main exits 2 with the fetch command, before anything uses it', () => {
  const t = setup();
  t.openPr();
  t.commit();
  t.git('update-ref', '-d', 'refs/remotes/origin/main');
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 2);
  assert.match(r.err, /fetch origin first: git fetch origin main/);
  assert.doesNotMatch(r.err, /^\s+at /m, 'no stack trace');
  assert.equal(t.ghCalls(), '', 'checked before gh is called');
  assert.ok(!t.codexRan());
  assert.equal(t.state(), null);
});

test('P2s are filed in one labelled follow-up issue; later rounds comment on it', () => {
  const t = setup();
  t.openPr();
  const h1 = t.commit('one');
  const r1 = t.review([], { FAKE_CODEX_VERDICT: t.verdict(P1_VERDICT) });
  assert.equal(r1.code, 0, r1.err);
  const calls1 = t.ghCalls();
  assert.match(calls1, /^label list --json name --limit 1000$/m);
  assert.match(calls1, /^label create review-followup /m);
  assert.ok(calls1.indexOf('label create') < calls1.indexOf('issue create'), 'the label exists before the issue');
  const args = t.ghFile('issue-42.args').split('\n');
  assert.equal(args[args.indexOf('--label') + 1], 'review-followup');
  assert.equal(args[args.indexOf('--title') + 1], `Review follow-ups for PR #7 (${BRANCH})`);
  assert.match(t.ghFile('issue-42.md'), new RegExp(`Round 1 on ${h1}:\\n- \\[ \\] Rename var — kit/b\\.js\\n$`));
  assert.doesNotMatch(t.ghFile('issue-42.md'), /Loses rows/, 'P1s are not parked');
  assert.equal(t.state().followup, 42);
  assert.match(t.body(), /^Review follow-up: #42$/m);

  const h2 = t.commit('two');
  const r2 = t.review([], { FAKE_CODEX_VERDICT: t.verdict(P2_ONLY) });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(t.ghCalls().match(/^issue create/gm).length, 1, 'never a second issue');
  assert.match(t.ghCalls(), /^issue comment 42 --body-file /m);
  assert.equal(t.ghFile('issue-42.comments.md'), `Round 2 on ${h2}:\n- [ ] Tidy names — kit/c.js\n`);
  assert.equal(t.body().match(/^Review follow-up: #42$/gm).length, 1, 'the body line is replaced, not repeated');

  t.commit('three');
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) }).code, 0);
  assert.equal(t.ghCalls().match(/^issue /gm).length, 2, 'a round with no P2 files nothing');
});

test('an existing label is not recreated, and a create race that says "already exists" is tolerated', () => {
  const t = setup();
  t.openPr();
  fs.writeFileSync(path.join(t.gh, 'labels.json'), JSON.stringify([{ name: 'bug' }, { name: 'review-followup' }]));
  t.commit();
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(P2_ONLY) }).code, 0);
  assert.doesNotMatch(t.ghCalls(), /label create/);
  assert.match(t.ghCalls(), /^issue create/m);

  const u = setup();
  u.openPr();
  u.ghFlag('label-exists-error');
  u.commit();
  const r = u.review([], { FAKE_CODEX_VERDICT: u.verdict(P2_ONLY) });
  assert.equal(r.code, 0, r.err);
  assert.equal(u.state().followup, 42);
});

test('a failed follow-up issue still counts the round, exits 1 and prints the command to retry', () => {
  const t = setup();
  t.openPr();
  t.ghFlag('issue-create-fails');
  const head = t.commit();
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(P1_VERDICT) });
  assert.equal(r.code, 1);
  assert.equal(t.state().rounds.length, 1, 'the round counts');
  assert.equal(t.state().followup, undefined);
  const file = path.join(t.stateDir, 'feat%2Freview-me.round-1.followup.md');
  assert.ok(r.err.includes(`issue create --title 'Review follow-ups for PR #7 (${BRANCH})' --label review-followup --body-file ${file}`), r.err);
  assert.doesNotMatch(r.err, /label create/, 'the label step worked, so it is not in the retry');
  assert.match(r.err, /add "Review follow-up: #<issue>" to the PR body/);
  assert.match(fs.readFileSync(file, 'utf8'), /- \[ \] Rename var — kit\/b\.js/);
  assert.equal(t.body(), `What this does: tests.\nKind: infra\n\nReview rounds: 1/3\nReviewed head: ${head}\n\n` +
    'Refuter: 0 confirmed, 0 not reproduced, 0 escalated, 1 pending\n', 'the body is still updated');

  const u = setup();
  u.openPr();
  u.ghFlag('label-create-fails');
  u.commit();
  const r2 = u.review([], { FAKE_CODEX_VERDICT: u.verdict(P2_ONLY) });
  assert.equal(r2.code, 1);
  assert.match(r2.err, /label create review-followup --description 'Non-blocking review findings parked for later'/);
  assert.match(r2.err, /issue create --title/);
  assert.doesNotMatch(u.ghCalls(), /issue create/, 'no unlabelled issue is filed');
  assert.equal(u.state().rounds.length, 1);
});

test('a follow-up named in the PR body is reused when the state has none', () => {
  const t = setup();
  t.openPr('What this does: tests.\nKind: fix\n\nReview follow-up: #9\n');
  const head = t.commit();
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(P2_ONLY) }).code, 0);
  assert.doesNotMatch(t.ghCalls(), /issue create/);
  assert.equal(t.ghFile('issue-9.comments.md'), `Round 1 on ${head}:\n- [ ] Tidy names — kit/c.js\n`);
  assert.equal(t.state().followup, 9);
});

test('a failed follow-up comment exits 1 with the comment command to retry', () => {
  const t = setup();
  t.openPr();
  t.commit('one');
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(P2_ONLY) }).code, 0);
  t.ghFlag('comment-fails');
  t.commit('two');
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(P2_ONLY) });
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(`issue comment 42 --body-file ${path.join(t.stateDir, 'feat%2Freview-me.round-2.followup.md')}`), r.err);
  assert.doesNotMatch(r.err, /add "Review follow-up/);
  assert.equal(t.state().rounds.length, 2);
});

test('the same-cause stop is written into the PR body and replaced in place', () => {
  const t = setup();
  t.openPr('Intro\nKind: fix\nReview stop: same class twice — old.js\nOutro');
  t.commit('one');
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict('- [P1] A — kit/a.js:1\n- [P1] B — kit/b.js:1\n') }).code, 0);
  t.commit('two');
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict('- [P1] A again — kit/a.js:2\n- [P1] B again — kit/b.js:2\n') });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Same class twice: kit\/a\.js, kit\/b\.js/);
  assert.match(t.body(), /^Intro\nKind: fix\nReview stop: same class twice — kit\/a\.js, kit\/b\.js\nOutro/);
});

test('exempt PRs run no reviewer, count no round and say why in the body', () => {
  const cases = [
    ['docs only', (t) => t.commitFiles({ 'README.md': '# Hi\n', 'docs/guide.md': 'Guide\n', 'docs/img.svg': '<svg/>\n' })],
    ['config changes of 10 lines or fewer', (t) => t.commitFiles({ 'config/a.yml': lines(6), '.gitignore': 'node_modules/\ndist/\n' })],
    ['revert', (t) => {
      t.commitFiles({ 'kit/a.js': 'module.exports = 1;\n' }, 'Add a');
      t.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      t.git('revert', '--no-edit', 'HEAD');
    }],
  ];
  for (const [reason, make] of cases) {
    const t = setup();
    t.openPr();
    make(t);
    const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
    assert.equal(r.code, 0, `${reason}: ${r.err}`);
    assert.match(r.out, new RegExp(`Exempt from review \\(${reason}\\)`));
    assert.equal(t.body(), `What this does: tests.\nKind: infra\n\nReview: exempt — ${reason}\n`);
    assert.ok(!t.codexRan(), reason);
    assert.ok(!t.claudeRan(), reason);
    assert.equal(t.state(), null, `${reason}: no round counted`);
  }
});

test('a commit merely titled Revert is reviewed: the exemption is verified, not trusted', () => {
  const t = setup();
  t.openPr();
  t.commitFiles({ 'kit/a.js': 'module.exports = 1;\n' }, 'Add a');
  t.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  t.commitFiles({ '.github/ci.yml': 'on: never\n' }, 'Revert "Add a"');
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /Exempt from review/);
  assert.ok(t.codexRan(), 'forged revert is reviewed');
});

test('reverting a commit that is not on main is reviewed', () => {
  const t = setup();
  t.openPr();
  t.commitFiles({ 'kit/a.js': 'module.exports = 1;\n' }, 'Add a');
  t.git('revert', '--no-edit', 'HEAD');
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /Exempt from review/);
  assert.ok(t.codexRan(), 'a revert of a branch-only commit is reviewed');
});

test('process, dependency, binary and larger changes are never exempt', () => {
  const cases = {
    'agent instructions': { 'AGENTS.md': 'Rules\n' },
    'docs under .github': { '.github/PULL_REQUEST_TEMPLATE.md': 'Template\n' },
    'package.json': { 'package.json': '{}\n' },
    lockfile: { 'package-lock.json': '{}\n' },
    'claude settings': { '.claude/settings.json': '{}\n' },
    'eleven config lines': { 'config/a.yml': lines(11) },
    'binary config': { 'a.json': Buffer.from([0, 1, 2, 0]) },
    'code next to docs': { 'README.md': 'Hi\n', 'kit/a.js': 'x\n' },
  };
  for (const [name, files] of Object.entries(cases)) {
    const t = setup();
    t.openPr();
    t.commitFiles(files);
    const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    assert.ok(t.codexRan(), `${name} is reviewed`);
    assert.doesNotMatch(t.body(), /exempt/, name);
    assert.equal(t.state().rounds.length, 1, name);
  }
});

test('a reviewer that fails or gives no usable verdict hands the round to the other model once', () => {
  const failures = {
    'non-zero exit': { FAKE_CODEX_VERDICT: CLEAN_VERDICT, FAKE_CODEX_EXIT: '1' },
    'empty verdict': { FAKE_CODEX_VERDICT: '' },
    'vague verdict': { FAKE_CODEX_VERDICT: 'Looks fine, I think.\n' },
    'unparseable finding': { FAKE_CODEX_VERDICT: '- [P1] no path here\n' },
  };
  for (const [name, codex] of Object.entries(failures)) {
    const t = setup();
    t.openPr();
    t.commit('change\n\nAgent: claude-code claude-opus-5-5');
    const extra = { ...codex, FAKE_CLAUDE_VERDICT: t.verdict(P2_ONLY) };
    extra.FAKE_CODEX_VERDICT = t.verdict(codex.FAKE_CODEX_VERDICT);
    const r = t.review([], extra);
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    assert.match(r.err, /^codex: [^]*; trying claude as a same-model fallback\.$/m, name);
    assert.match(r.out, /reviewer: claude, same-model fallback/, name);
    assert.deepEqual([t.state().rounds[0].reviewer, t.state().rounds[0].fallback], ['claude', true], name);
    assert.match(t.body(), /^Review: same-model fallback$/m, name);
    const file = (suffix) => path.join(t.stateDir, `feat%2Freview-me.round-1${suffix}`);
    assert.match(fs.readFileSync(file('.attempt-1.log'), 'utf8'), /fake codex chatter/, `${name}: failed attempt log kept`);
    assert.equal(fs.readFileSync(file('.md'), 'utf8'), P2_ONLY, `${name}: the fallback's verdict is the round's`);
    if (codex.FAKE_CODEX_VERDICT) assert.equal(fs.readFileSync(file('.attempt-1.md'), 'utf8'), codex.FAKE_CODEX_VERDICT, name);
  }
});

test('both reviewers failing exits 1 without counting the round', () => {
  const t = setup();
  t.openPr();
  t.commit('change\n\nAgent: codex gpt-6-luna');
  const r = t.review([], {
    FAKE_CLAUDE_VERDICT: t.verdict('Hmm.\n'),
    FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT),
    FAKE_CODEX_EXIT: '3',
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /^claude: Could not read findings or a clean verdict \(log: .*round-1\.attempt-1\.log\)/m);
  assert.match(r.err, /^codex: exited 3 \(log: .*round-1\.log\)$/m);
  assert.match(r.err, /No reviewer gave a usable verdict; this round does not count\./);
  assert.equal(t.state(), null);
  assert.doesNotMatch(t.ghCalls(), /pr edit|issue/);
});

test('main is exported for in-process use', (t) => {
  t.mock.method(console, 'error', () => {});
  const { main } = require(cli);
  assert.equal(typeof main, 'function');
  assert.equal(main(['--bogus'], {}), 2);
});

const REFUTE_HINT = 'npm run review -- --refute <id> <confirmed|not-reproduced|cannot-verify> [--note "<evidence>"]';

test('a round with P1s gives each an id, prints the Refuter block and is not done', () => {
  const t = setup();
  t.openPr();
  const head = t.commit();
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict('- [P1] A — kit/a.js:1\n- [P2] B — kit/b.js:1\n- [P1] C — kit/c.js:1\n') });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(t.state().rounds[0].findings.map((f) => [f.id, f.verdict]), [['R1-1', 'pending'], [undefined, undefined], ['R1-2', 'pending']]);
  const summary = r.out.indexOf('Round 1/3');
  const block = r.out.indexOf('Refuter: test each P1 before fixing it.');
  assert.ok(summary >= 0 && block > summary, 'the Refuter block follows the summary');
  assert.match(r.out, /^ {2}R1-1 {2}A — kit\/a\.js$/m);
  assert.match(r.out, /^ {2}R1-2 {2}C — kit\/c\.js$/m);
  assert.ok(r.out.includes(`Delegate each to the Refuter agent (.claude/agents/refuter.md) with the head SHA (${head}), then record the result with ${REFUTE_HINT}`));
  assert.doesNotMatch(r.out, /the review is done/);
  assert.match(t.body(), /^Refuter: 0 confirmed, 0 not reproduced, 0 escalated, 2 pending$/m);

  const clean = setup();
  clean.openPr();
  clean.commit();
  const c = clean.review([], { FAKE_CODEX_VERDICT: clean.verdict(P2_ONLY) });
  assert.doesNotMatch(c.out, /Refuter/);
  assert.doesNotMatch(clean.body(), /Refuter/, 'no P1, no Refuter line');
  assert.match(c.out, /the review is done/);
});

test('--refute records verdicts without a reviewer run or a round, updates the body, and says when the review is done', () => {
  const t = setup();
  t.openPr();
  t.commit();
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict('- [P1] A — kit/a.js:1\n- [P1] B — kit/b.js:1\n') }).code, 0);
  t.resetCodex();
  const calls = t.ghCalls();

  const r1 = t.review(['--refute', 'R1-1', 'not-reproduced', '--note', 'node --test test/a.test.js: 4 pass, 0 fail']);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /Recorded R1-1 \(A — kit\/a\.js\): not-reproduced\./);
  assert.match(r1.out, /Still blocking: R1-2 \(pending\)\./);
  assert.doesNotMatch(r1.out, /the review is done/);
  assert.ok(!t.codexRan() && !t.claudeRan(), 'no reviewer run');
  const s = t.state();
  assert.equal(s.rounds.length, 1, 'no round counted');
  assert.equal(s.rounds[0].findings[0].verdict, 'not-reproduced');
  assert.equal(s.rounds[0].findings[0].note, 'node --test test/a.test.js: 4 pass, 0 fail');
  assert.equal(t.body().match(/^Refuter: 0 confirmed, 1 not reproduced, 0 escalated, 1 pending$/gm).length, 1);
  assert.doesNotMatch(t.ghCalls().slice(calls.length), /issue|label/);

  const r2 = t.review(['--refute', 'R1-2', 'not-reproduced']);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, /No blocking findings: the review is done/);
  assert.equal(t.body().match(/^Refuter: 0 confirmed, 2 not reproduced, 0 escalated, 0 pending$/gm).length, 1, 'replaced in place');

  const r3 = t.review(['--refute', 'R1-2', 'confirmed']);
  assert.equal(r3.code, 0, r3.err);
  assert.match(r3.out, /Still blocking: R1-2 \(confirmed\)/);
  assert.equal(t.state().rounds[0].findings[1].note, undefined);
  assert.match(t.body(), /^Refuter: 1 confirmed, 1 not reproduced, 0 escalated, 0 pending$/m);
});

test('cannot-verify is escalated, keeps blocking after later clean rounds, and works over budget for earlier rounds', () => {
  const t = setup();
  t.openPr();
  t.commit('one');
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict('- [P1] Needs live auth — kit/auth.js:1\n') }).code, 0);
  const r = t.review(['--refute', 'R1-1', 'cannot-verify', '--note', 'needs a live OAuth token']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /R1-1 is escalated to the human: the Refuter could not verify it\. Tell them; do not drop it\./);
  assert.match(r.out, /Still blocking: R1-1 \(cannot-verify\)/);
  assert.match(t.body(), /^Refuter: 0 confirmed, 0 not reproduced, 1 escalated, 0 pending$/m);

  for (const n of ['two', 'three']) {
    t.commit(n);
    const c = t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) });
    assert.equal(c.code, 0, c.err);
    assert.doesNotMatch(c.out, /the review is done/);
    assert.match(c.out, /Not done: R1-1 escalated to the human and still open\./);
  }
  t.commit('four');
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(CLEAN_VERDICT) }).code, 3, 'budget spent');
  t.resetCodex();
  const late = t.review(['--refute', 'R1-1', 'not-reproduced', '--note', 'the human checked it live']);
  assert.equal(late.code, 0, late.err);
  assert.match(late.out, /the review is done/);
  assert.ok(!t.codexRan());
  assert.equal(t.state().rounds.length, 3);
});

test('--refute usage errors and unknown ids exit 2 before gh or a reviewer', () => {
  const t = setup();
  t.openPr();
  t.commit();
  for (const args of [['--refute'], ['--refute', 'R1-1'], ['--refute', 'R1-1', 'maybe'], ['--refute', 'R1-1', 'confirmed', '--note']]) {
    const r = t.review(args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /usage:/);
  }
  const none = t.review(['--refute', 'R1-1', 'confirmed']);
  assert.equal(none.code, 2, 'no state yet');
  assert.match(none.err, /No P1 R1-1/);
  assert.equal(t.ghCalls(), '');

  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(P1_VERDICT) }).code, 0);
  const calls = t.ghCalls();
  const unknown = t.review(['--refute', 'R1-2', 'confirmed']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /No P1 R1-2/);
  assert.equal(t.ghCalls(), calls, 'refused before gh');
  assert.equal(t.state().rounds[0].findings[0].verdict, 'pending');
});

test('a failed PR-body update after --refute keeps the verdict and exits 1', () => {
  const t = setup();
  t.openPr();
  t.commit();
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict(P1_VERDICT) }).code, 0);
  t.ghFlag('edit-fails');
  const r = t.review(['--refute', 'R1-1', 'confirmed']);
  assert.equal(r.code, 1);
  assert.match(r.err, /R1-1 recorded, but the PR body was not updated/);
  assert.equal(t.state().rounds[0].findings[0].verdict, 'confirmed');
});

test('the same-cause stop skips a file whose earlier P1 was not reproduced', () => {
  const t = setup();
  t.openPr();
  t.commit('one');
  assert.equal(t.review([], { FAKE_CODEX_VERDICT: t.verdict('- [P1] A — kit/a.js:1\n') }).code, 0);
  assert.equal(t.review(['--refute', 'R1-1', 'not-reproduced']).code, 0);
  t.commit('two');
  const r = t.review([], { FAKE_CODEX_VERDICT: t.verdict('- [P1] A again — kit/a.js:2\n') });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /Same class twice/);
  assert.doesNotMatch(t.body(), /Review stop/);
  assert.match(r.out, /^ {2}R2-1 {2}A again — kit\/a\.js$/m);
});
