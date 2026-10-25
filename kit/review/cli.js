'use strict';

// One cross-model review round with the budget built in (Stories 1.1-1.4):
//
//   npm run review [-- --over-budget "<the human's reason>"]
//   npm run review -- --refute <id> <confirmed|not-reproduced|cannot-verify> [--note "<evidence>"]
//
// Needs an open PR for the branch with a Kind line, so every round is visible
// to the retro. Revert, docs-only and tiny config PRs are exempt: no round.
// Chooses the other model from Agent trailers, retries it once with a VERDICT
// reminder when its only fault is a missing or contradictory VERDICT line,
// falls back to the same model when that reviewer is missing or gives no
// usable verdict, counts rounds per
// branch, files non-blocking findings in one follow-up issue per PR, and
// updates the PR body. Each P1 gets an id for the Refuter; --refute records
// its verdict with no reviewer run and no round counted, even over budget.
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
  claudeStdin,
  isValidState,
  readVerdict,
  withVerdictReminder,
  repeatedBlockingFiles,
  withRoundsLine,
  withReviewedHeadLine,
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
  exemptionFor,
  revertedCommit,
  withoutExemptLine,
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
  const { overBudget, refute } = args;
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
  if (refute && !findP1(state.rounds, refute.id)) {
    console.error(`No P1 ${refute.id} in this branch's review state. The ids are printed after each round.`);
    return 2;
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

  if (refute) {
    const finding = findP1(state.rounds, refute.id);
    Object.assign(finding, { verdict: refute.verdict, refutedAt: new Date().toISOString() });
    if (refute.note) finding.note = refute.note;
    else delete finding.note;
    saveState();
    console.log(`Recorded ${refute.id} (${finding.title} — ${finding.file}): ${refute.verdict}.`);
    if (refute.verdict === 'cannot-verify') {
      console.log(`${refute.id} is escalated to the human: the Refuter could not verify it. Tell them; do not drop it.`);
    }
    const blocking = blockingFindings(state.rounds);
    console.log(blocking.length ? `Still blocking: ${blocking.map((f) => `${f.id ?? f.title} (${f.verdict ?? 'pending'})`).join(', ')}.` : DONE);
    if (!editBody(withRefuterLine(pr.body || '', state.rounds))) {
      console.error(`${refute.id} recorded, but the PR body was not updated. Run: ${ghBin} pr edit ${pr.number} --body-file ${bodyPath}`);
      return 1;
    }
    return 0;
  }

  const exempt = exemptionFor({
    commits: git('rev-list', 'origin/main..HEAD').split('\n').filter(Boolean).map((sha) => {
      const target = revertedCommit(git('log', '-1', '--format=%B', sha));
      if (!target) return { verifiedRevert: false };
      try {
        // Only a commit already on main can be reverted: a side commit shaped
        // like the inverse of this one would otherwise forge the exemption.
        git('merge-base', '--is-ancestor', target, 'origin/main');
        const diff = (a, b) => raw('git', ['diff', '--no-ext-diff', '--no-textconv', a, b]);
        const mine = diff(`${sha}^`, sha);
        return { verifiedRevert: mine.length > 0 && mine === diff(target, `${target}^`) };
      } catch {
        return { verifiedRevert: false };
      }
    }),
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
  const runReviewer = (reviewer, log, reminder) => {
    const prompt = (opts) => (reminder ? withVerdictReminder(promptFor(state, opts)) : promptFor(state, opts));
    if (reviewer === 'codex') {
      return spawnSync(codexBin, ['exec', '--sandbox', 'read-only', '-o', verdictPath, 'review', prompt()],
        { cwd, env, stdio: ['ignore', log, log] });
    }
    const gitDiff = (range) => execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', range],
      { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
    let input;
    try {
      const full = gitDiff('origin/main...HEAD');
      let since = null;
      if (previous) {
        try {
          since = gitDiff(`${previous.head}..HEAD`);
        } catch {
          // The last reviewed head is gone (a rebase, say): stdin says so.
        }
      }
      input = claudeStdin(full, previous?.head, since);
    } catch (error) {
      return { status: 1, error };
    }
    // Read-only tools, no prompts, no MCP servers, no saved session, no browser
    // and no slash commands; test/unit/review-cli.test.js pins this argv.
    // --restricted confines Read, Glob and Grep to the working directory (the
    // repo); proved live: the repo's AGENTS.md was readable, /etc/hosts was not.
    const result = spawnSync(claudeBin, [
      '--print', '--restricted', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--no-chrome',
      '--disable-slash-commands', prompt({ diffOnStdin: true }),
    ], { cwd, env, input, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (result.stderr) fs.writeSync(log, result.stderr);
    if (result.stdout) fs.writeFileSync(verdictPath, result.stdout);
    return result;
  };
  // One attempt: { verdict, findings } or { error }. Output lands in verdictPath and logPath.
  const attempt = (reviewer, reminder = false) => {
    fs.rmSync(verdictPath, { force: true });
    const log = fs.openSync(logPath, 'w');
    let result;
    try {
      result = runReviewer(reviewer, log, reminder);
    } finally {
      fs.closeSync(log);
    }
    if (result.error) return { error: result.error.code === 'ENOENT' ? 'not found' : result.error.message };
    if (result.status !== 0) return { error: `exited ${result.status}` };
    const verdict = fs.existsSync(verdictPath) ? fs.readFileSync(verdictPath, 'utf8') : '';
    return { verdict, ...readVerdict(verdict, repoRoot) };
  };

  // The preferred reviewer gets one try, plus one retry with a VERDICT reminder
  // when its only fault was the VERDICT line (readVerdict's retry). Any other
  // failure hands the round to the other model once, labelled as a same-model
  // fallback. Each failed attempt's files are kept under .attempt-<n>.
  const initial = pickReviewer({ trailers, codexAvailable: true, claudeAvailable: true });
  let selection = initial;
  let tries = 1;
  const keep = () => {
    const kept = (file) => file.replace(/\.(md|log)$/, `.attempt-${tries}.$1`);
    for (const file of [verdictPath, logPath]) if (fs.existsSync(file)) fs.renameSync(file, kept(file));
    return kept(logPath);
  };
  let outcome = attempt(selection.reviewer);
  let retried = false;
  if (outcome.error && outcome.retry) {
    console.error(`${selection.reviewer}: ${outcome.error} (log: ${keep()}); retrying ${selection.reviewer} once with a VERDICT reminder.`);
    tries++;
    retried = true;
    outcome = attempt(selection.reviewer, true);
  }
  if (outcome.error) {
    const failures = [`${selection.reviewer}: ${outcome.error} (log: ${keep()})`];
    selection = pickReviewer({ trailers, codexAvailable: initial.reviewer !== 'codex', claudeAvailable: initial.reviewer !== 'claude' });
    console.error(`${failures[0]}; trying ${selection.reviewer} as a same-model fallback.`);
    outcome = attempt(selection.reviewer);
    if (outcome.error) {
      failures.push(`${selection.reviewer}: ${outcome.error} (log: ${logPath})`);
      console.error(`${failures.join('\n')}\nNo reviewer gave a usable verdict; this round does not count.`);
      return 1;
    }
  }
  const { verdict } = outcome;
  if (outcome.note) console.error(`Note: ${outcome.note}`);
  const findings = withRefuterIds(round, outcome.findings);
  state.rounds.push({ head, at: new Date().toISOString(), findings, reviewer: selection.reviewer, fallback: selection.fallback,
    ...(retried ? { retried: true } : {}), ...(overBudget ? { overBudget } : {}) });
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
  if (p1) console.log(refuterBlock(findings, head));
  const blocking = blockingFindings(state.rounds);
  if (!blocking.length) console.log(DONE);
  else if (!p1) console.log(`Not done: ${blocking.map((f) => f.id).join(', ')} escalated to the human and still open.`);

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

  let text = withFallbackLine(withReviewedHeadLine(withRoundsLine(withoutExemptLine(pr.body || ''), round), head), selection.fallback);
  if (state.followup) text = withFollowupLine(text, state.followup);
  if (p1) text = withRefuterLine(text, state.rounds);
  if (!editBody(withStopLine(text, repeated))) {
    console.error(`Round ${round} counted, but the PR body was not updated. Run: ${ghBin} pr edit ${pr.number} --body-file ${bodyPath}`);
    return 1;
  }
  return ok ? 0 : 1;
}

const DONE = 'No blocking findings: the review is done. Do not run another round.';

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
