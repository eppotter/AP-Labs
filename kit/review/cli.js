'use strict';

// One cross-model review round with the budget built in (Story 1.1):
//
//   npm run review [-- --over-budget "<the human's reason>"]
//
// Needs an open PR for the branch, so every round is visible to the retro.
// Chooses the other model from Agent trailers, falls back read-only when its
// binary is missing, counts rounds per branch, and updates the PR body.
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
  const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = (...a) => run('git', a);

  const branch = git('branch', '--show-current');
  if (!branch) {
    console.error('Not on a branch (detached HEAD). Check out the PR branch first.');
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
  fs.rmSync(verdictPath, { force: true });
  const log = fs.openSync(logPath, 'w');
  const runReviewer = (reviewer) => {
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
  const initial = pickReviewer({ trailers, codexAvailable: true, claudeAvailable: true });
  let selection = initial;
  let result;
  try {
    result = runReviewer(selection.reviewer);
    if (result.error && result.error.code === 'ENOENT') {
      selection = pickReviewer({ trailers, codexAvailable: selection.reviewer !== 'codex', claudeAvailable: selection.reviewer !== 'claude' });
      result = runReviewer(selection.reviewer);
    }
  } finally {
    fs.closeSync(log);
  }
  if (result.status !== 0 || !fs.existsSync(verdictPath)) {
    const why = result.error ? result.error.message : `exited ${result.status}`;
    console.error(`${selection.reviewer} ${why}; this round does not count. Log: ${logPath}`);
    return 1;
  }
  const verdict = fs.readFileSync(verdictPath, 'utf8');
  const findings = parseFindings(verdict, repoRoot);
  const unparsed = unparsedFindingLines(verdict);
  if (unparsed.length) {
    console.error(`Could not parse ${unparsed.length} finding line(s) in ${verdictPath}; this round does not count.\n${unparsed.join('\n')}`);
    return 1;
  }
  if (!findings.length && !isClean(verdict)) {
    console.error(`Could not read findings or a clean verdict from ${verdictPath}; this round does not count.\n${verdict}`);
    return 1;
  }
  state.rounds.push({ head, at: new Date().toISOString(), findings, reviewer: selection.reviewer, fallback: selection.fallback,
    ...(overBudget ? { overBudget } : {}) });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);

  const p1 = findings.filter((f) => f.priority === 'P1').length;
  console.log(verdict.trim());
  console.log(`\nRound ${round}/${ROUND_BUDGET} on ${head.slice(0, 12)} (reviewer: ${selection.reviewer}${selection.fallback ? ', same-model fallback' : ''}): ${p1} blocking, ${findings.length - p1} non-blocking.` +
    (overBudget ? ` Over budget with the human's go: ${overBudget}.` : ''));
  if (findings.length > p1) console.log('File the non-blocking ones in one issue: gh issue create --label review-followup.');
  const repeated = repeatedBlockingFiles(state.rounds);
  if (repeated.length) {
    console.log(`Same class twice: ${repeated.join(', ')} drew blocking findings in two rounds running. ` +
      'Stop patching. Write the shared premise in the PR body, then restructure or cut it from scope.');
  }
  if (p1 === 0) console.log('No blocking findings: the review is done. Do not run another round.');

  const bodyPath = path.join(dir, `${stem}.pr-body.md`);
  fs.writeFileSync(bodyPath, withFallbackLine(withReviewedHeadLine(withRoundsLine(pr.body || '', round), head), selection.fallback));
  try {
    run(ghBin, ['pr', 'edit', String(pr.number), '--body-file', bodyPath]);
  } catch {
    console.error(`Round ${round} counted, but the PR body was not updated. Run: ${ghBin} pr edit ${pr.number} --body-file ${bodyPath}`);
    return 1;
  }
  return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
