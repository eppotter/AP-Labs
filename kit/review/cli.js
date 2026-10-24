'use strict';

// One cross-model review round with the budget built in (Stories 1.1-1.3):
//
//   npm run review [-- --over-budget "<the human's reason>"]
//
// Needs an open PR for the branch with a Kind line, so every round is visible
// to the retro. Revert, docs-only and tiny config PRs are exempt: no round.
// Chooses the other model from Agent trailers, falls back to the same model
// when that reviewer is missing or gives no usable verdict, counts rounds per
// branch, files non-blocking findings in one follow-up issue per PR, and
// updates the PR body.
//
// State lives in <git-dir>/aplabs/review/<branch>.json, never in tracked
// files. A reviewer run that fails or says nothing readable does not count.
// Exit codes: 0 round done, 1 round failed (not counted), 2 refused or usage,
// 3 budget spent.
//
// Reviewer and gh binaries can be overridden so tests need no model or network.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  ROUND_BUDGET,
  USAGE,
  promptFor,
  isValidState,
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
  exemptionFor,
  parseArgs,
  sanitizeBranch,
} = require('../lib/review');

function main(argv, env = process.env, cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    return 2;
  }
  const { overBudget } = args;
  const codexBin = env.APLABS_REVIEW_CODEX_BIN || 'codex';
  const claudeBin = env.APLABS_REVIEW_CLAUDE_BIN || 'claude';
  const ghBin = env.APLABS_GH_BIN || 'gh';
  const raw = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (cmd, cmdArgs) => raw(cmd, cmdArgs).trim();
  const git = (...a) => run('git', a);

  const branch = git('branch', '--show-current');
  if (!branch) {
    console.error('Not on a branch (detached HEAD). Check out the PR branch first.');
    return 2;
  }
  try {
    git('rev-parse', '--verify', '--quiet', 'origin/main^{commit}');
  } catch {
    console.error('No origin/main to diff against. fetch origin first: git fetch origin main');
    return 2;
  }
  const head = git('rev-parse', 'HEAD');
  const trailers = git('log', '--format=%(trailers:key=Agent,valueonly)', 'origin/main..HEAD').split('\n').filter(Boolean);
  const repoRoot = git('rev-parse', '--show-toplevel');
  const dir = path.join(git('rev-parse', '--absolute-git-dir'), 'aplabs', 'review');
  fs.mkdirSync(dir, { recursive: true });
  const stem = sanitizeBranch(branch);
  const statePath = path.join(dir, `${stem}.json`);
  let state = { branch, rounds: [] };
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!isValidState(state)) throw new Error('bad shape');
    } catch {
      // Never reset the budget by accident: an unreadable state file stops here.
      console.error(`Cannot read review state ${statePath}. Fix or remove it by hand.`);
      return 1;
    }
  }
  const saveState = () => {
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath);
  };

  let pr;
  try {
    pr = JSON.parse(run(ghBin, ['pr', 'view', '--json', 'number,body,state']));
  } catch {
    pr = null;
  }
  if (!pr || (pr.state && pr.state !== 'OPEN')) {
    console.error('No open PR for this branch. Open a draft first (gh pr create --draft) so the retro sees every round.');
    return 2;
  }
  if (!hasKindLine(pr.body || '')) {
    console.error(KIND_HELP.replace('<number>', String(pr.number)));
    return 2;
  }
  const bodyPath = path.join(dir, `${stem}.pr-body.md`);
  const editBody = (text) => {
    fs.writeFileSync(bodyPath, text);
    try {
      run(ghBin, ['pr', 'edit', String(pr.number), '--body-file', bodyPath]);
      return true;
    } catch {
      return false;
    }
  };

  const exempt = exemptionFor({
    subjects: git('log', '--format=%s', 'origin/main..HEAD').split('\n').filter(Boolean),
    changes: parseNumstat(raw('git', ['diff', '--numstat', '-z', '--no-renames', '--no-textconv', 'origin/main...HEAD'])),
  });
  if (exempt) {
    console.log(`Exempt from review (${exempt}): no reviewer run, no round counted.`);
    if (!editBody(withExemptLine(pr.body || '', exempt))) {
      console.error(`The PR body was not updated. Run: ${ghBin} pr edit ${pr.number} --body-file ${bodyPath}`);
      return 1;
    }
    return 0;
  }

  const previous = state.rounds[state.rounds.length - 1];
  if (previous && previous.head === head) {
    console.error(`Round ${state.rounds.length} already reviewed ${head}. Commit the fixes first.`);
    return 2;
  }
  const round = state.rounds.length + 1;
  if (round > ROUND_BUDGET && !overBudget) {
    console.error(`Review budget spent (${ROUND_BUDGET} rounds). Split the PR, shrink its scope, or park it and tell the human. ` +
      `A further round needs their go: rerun with --over-budget "<what they said>" and record it in the PR body.`);
    return 3;
  }

  const verdictPath = path.join(dir, `${stem}.round-${round}.md`);
  const logPath = path.join(dir, `${stem}.round-${round}.log`);
  const runReviewer = (reviewer, log) => {
    if (reviewer === 'codex') {
      return spawnSync(codexBin, ['exec', '--sandbox', 'read-only', '-o', verdictPath, 'review', promptFor(state)],
        { cwd, env, stdio: ['ignore', log, log] });
    }
    let diff;
    try {
      diff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', 'origin/main...HEAD'],
        { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return { status: 1, error };
    }
    const result = spawnSync(claudeBin, [
      '--print', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--no-chrome',
      '--disable-slash-commands', promptFor(state, { diffOnStdin: true }),
    ], { cwd, env, input: diff, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (result.stderr) fs.writeSync(log, result.stderr);
    if (result.stdout) fs.writeFileSync(verdictPath, result.stdout);
    return result;
  };
  // One attempt: { verdict, findings } or { error }. Output lands in verdictPath and logPath.
  const attempt = (reviewer) => {
    fs.rmSync(verdictPath, { force: true });
    const log = fs.openSync(logPath, 'w');
    let result;
    try {
      result = runReviewer(reviewer, log);
    } finally {
      fs.closeSync(log);
    }
    if (result.error) return { error: result.error.code === 'ENOENT' ? 'not found' : result.error.message };
    if (result.status !== 0) return { error: `exited ${result.status}` };
    const verdict = fs.existsSync(verdictPath) ? fs.readFileSync(verdictPath, 'utf8') : '';
    return { verdict, ...readVerdict(verdict, repoRoot) };
  };

  // The preferred reviewer gets one try; any failure hands the round to the
  // other model once, labelled as a same-model fallback. The failed attempt's
  // files are kept under .attempt-1.
  const initial = pickReviewer({ trailers, codexAvailable: true, claudeAvailable: true });
  let selection = initial;
  let outcome = attempt(selection.reviewer);
  if (outcome.error) {
    const kept = (file) => file.replace(/\.(md|log)$/, '.attempt-1.$1');
    for (const file of [verdictPath, logPath]) if (fs.existsSync(file)) fs.renameSync(file, kept(file));
    const failures = [`${selection.reviewer}: ${outcome.error} (log: ${kept(logPath)})`];
    selection = pickReviewer({ trailers, codexAvailable: initial.reviewer !== 'codex', claudeAvailable: initial.reviewer !== 'claude' });
    console.error(`${failures[0]}; trying ${selection.reviewer} as a same-model fallback.`);
    outcome = attempt(selection.reviewer);
    if (outcome.error) {
      failures.push(`${selection.reviewer}: ${outcome.error} (log: ${logPath})`);
      console.error(`${failures.join('\n')}\nNo reviewer gave a usable verdict; this round does not count.`);
      return 1;
    }
  }
  const { verdict, findings } = outcome;
  state.rounds.push({ head, at: new Date().toISOString(), findings, reviewer: selection.reviewer, fallback: selection.fallback,
    ...(overBudget ? { overBudget } : {}) });
  saveState();

  const p1 = findings.filter((f) => f.priority === 'P1').length;
  console.log(verdict.trim());
  console.log(`\nRound ${round}/${ROUND_BUDGET} on ${head.slice(0, 12)} (reviewer: ${selection.reviewer}${selection.fallback ? ', same-model fallback' : ''}): ${p1} blocking, ${findings.length - p1} non-blocking.` +
    (overBudget ? ` Over budget with the human's go: ${overBudget}.` : ''));
  const repeated = repeatedBlockingFiles(state.rounds);
  if (repeated.length) {
    console.log(`Same class twice: ${repeated.join(', ')} drew blocking findings in two rounds running. ` +
      'Stop patching. Write the shared premise in the PR body, then restructure or cut it from scope.');
  }
  if (p1 === 0) console.log('No blocking findings: the review is done. Do not run another round.');

  let ok = true;
  const p2s = findings.filter((f) => f.priority === 'P2');
  const followup = state.followup ?? followupFromBody(pr.body || '');
  if (p2s.length) {
    const filed = fileFollowups({ run, ghBin, dir, stem, pr: pr.number, branch, round, head, findings: p2s, issue: followup });
    if (filed.issue) {
      state.followup = filed.issue;
      saveState();
      console.log(`Filed ${p2s.length} non-blocking finding(s) in follow-up issue #${filed.issue}.`);
    } else {
      console.error(`Round ${round} counted, but its non-blocking findings were not filed. Run:\n${filed.retry.join('\n')}` +
        (followup ? '' : '\nThen add "Review follow-up: #<issue>" to the PR body so later rounds comment on that issue.'));
      ok = false;
    }
  }

  let text = withFallbackLine(withReviewedHeadLine(withRoundsLine(pr.body || '', round), head), selection.fallback);
  if (state.followup) text = withFollowupLine(text, state.followup);
  if (!editBody(withStopLine(text, repeated))) {
    console.error(`Round ${round} counted, but the PR body was not updated. Run: ${ghBin} pr edit ${pr.number} --body-file ${bodyPath}`);
    return 1;
  }
  return ok ? 0 : 1;
}

// Files a round's P2s: a comment on the PR's follow-up issue when it has one,
// otherwise a new issue labelled review-followup. Returns { issue } or
// { retry: [commands] }.
function fileFollowups({ run, ghBin, dir, stem, pr, branch, round, head, findings, issue }) {
  const file = path.join(dir, `${stem}.round-${round}.followup.md`);
  if (issue) {
    fs.writeFileSync(file, followupItems({ round, head, findings }));
    const cmd = ['issue', 'comment', String(issue), '--body-file', file];
    try {
      run(ghBin, cmd);
      return { issue };
    } catch {
      return { retry: [shellJoin([ghBin, ...cmd])] };
    }
  }
  const { title, body } = followupIssue({ pr, branch, round, head, findings });
  fs.writeFileSync(file, body);
  const labelCmd = ['label', 'create', 'review-followup', '--description', 'Non-blocking review findings parked for later'];
  const issueCmd = ['issue', 'create', '--title', title, '--label', 'review-followup', '--body-file', file];
  let labelled = false;
  try {
    const labels = JSON.parse(run(ghBin, ['label', 'list', '--json', 'name', '--limit', '1000']));
    labelled = labels.some((l) => l.name === 'review-followup');
    if (!labelled) run(ghBin, labelCmd);
    labelled = true;
  } catch (error) {
    labelled = /already exists/i.test(String(error.stderr || ''));
  }
  const retry = [...(labelled ? [] : [`${shellJoin([ghBin, ...labelCmd])}  # skip if it says the label already exists`]),
    shellJoin([ghBin, ...issueCmd])];
  if (!labelled) return { retry };
  try {
    const m = /\/issues\/(\d+)\s*$/.exec(run(ghBin, issueCmd));
    if (m) return { issue: Number(m[1]) };
  } catch {
    // Reported below with the command to retry.
  }
  return { retry };
}

// Quotes arguments so a printed retry command can be pasted into a shell.
const shellJoin = (argv) => argv.map((a) => (/^[\w@%+=:,./#-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

module.exports = { main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
