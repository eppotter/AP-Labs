'use strict';

// Cut a template release (Story 11.5):
//
//   npm run template:release -- vX.Y.Z [--push]
//
// Refuses, naming every reason, unless:
//   - this is the template, not a fork (no .aplabs/profile.yml);
//   - the worktree is clean, on main, and main is origin/main (after a fetch);
//   - the version is vX.Y.Z, higher than the newest v* tag (here or on
//     origin), and the tag exists neither here nor on origin;
//   - CHANGELOG.md has its "## vX.Y.Z" entry with "What changed" and "What a
//     fork must do" (written and reviewed in a normal PR first: this command
//     never writes the changelog, Q19);
//   - every check on main's head passed, and the test, clean-bones and
//     container jobs are among them, read through gh (APLABS_GH_BIN, as
//     `npm run land` does). A missing, failed or still-running check refuses.
//
// Then it creates the annotated tag locally on main's head. It pushes that
// one tag (never --tags) only with --push, which a human passes: the
// Orchestrator never does (AGENTS.md). package.json's version is left alone:
// the tag is the version (Q19).
//
// Exit codes: 0 tagged, 1 refused or failed, 2 usage.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('../lib/template');

const USAGE = 'usage: npm run template:release -- vX.Y.Z [--push]';

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let version;
  let push = false;
  for (const a of argv) {
    if (a === '--push') push = true;
    else if (a.startsWith('-')) return { error: `unknown argument: ${a}` };
    else if (version !== undefined) return { error: `one version only, not ${a}` };
    else version = a;
  }
  if (version === undefined) return { error: 'no version' };
  return { version, push };
}

// The tag names on origin, or { error }.
function remoteTags(root) {
  const r = lib.git(root, ['ls-remote', '--tags', '--refs', 'origin']);
  if (!r.ok) return { error: `could not list origin's tags: ${r.stderr || 'git ls-remote failed'}` };
  return { tags: r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')[1].replace(/^refs\/tags\//, '')) };
}

// The check runs on sha, read with gh. Returns { runs } or { error }.
function checkRuns(root, sha, env) {
  const ghBin = env.APLABS_GH_BIN || 'gh';
  const r = spawnSync(ghBin, ['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error || r.status !== 0) return { error: `could not read the checks on main's head with gh: ${r.error ? r.error.message : (r.stderr || '').trim() || `exit ${r.status}`}` };
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return { error: 'gh printed something that is not JSON for the checks on main\'s head' };
  }
  if (!doc || !Array.isArray(doc.check_runs)) return { error: 'gh\'s answer for the checks on main\'s head has no check_runs list' };
  if (Number(doc.total_count) > doc.check_runs.length) return { error: `main's head has ${doc.total_count} checks, more than one page; check them by hand` };
  return { runs: doc.check_runs };
}

function main(argv, env = process.env, deps = {}) {
  const out = deps.out || ((s) => console.log(s));
  const err = deps.err || ((s) => console.error(s));
  const cwd = deps.cwd || process.cwd();
  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.error) {
    err(`template:release: ${args.error}\n${USAGE}`);
    return 2;
  }
  const { version, push } = args;
  const root = lib.repoRoot(cwd);
  if (!root) {
    err('template:release: not inside a git repository');
    return 2;
  }
  const refuse = (reasons) => {
    err(`template:release: refusing to release ${version}:\n${reasons.map((r) => `- ${r}`).join('\n')}`);
    return 1;
  };

  // A fork never cuts template releases; nothing else is worth checking there.
  if (lib.isFork(root)) return refuse([`this is a fork (${lib.PROFILE_REL} exists); releases are cut in the template`]);

  const reasons = [];
  const status = lib.git(root, ['status', '--porcelain']);
  if (!status.ok) reasons.push(`could not read git status: ${status.stderr}`);
  else if (status.stdout.trim()) reasons.push('the worktree is not clean (commit or remove the changes first)');
  const branch = lib.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch.ok || branch.stdout.trim() !== 'main') reasons.push(`not on main (on ${branch.ok ? branch.stdout.trim() : 'a detached HEAD'})`);

  let head = null;
  const fetch = lib.git(root, ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  if (!fetch.ok) {
    reasons.push(`could not fetch main from origin: ${fetch.stderr || 'git fetch failed'}`);
  } else {
    const local = lib.git(root, ['rev-parse', '--verify', 'HEAD']);
    const remote = lib.git(root, ['rev-parse', '--verify', 'refs/remotes/origin/main']);
    if (!local.ok || !remote.ok) reasons.push('could not read HEAD or origin/main');
    else if (local.stdout.trim() !== remote.stdout.trim()) reasons.push(`the local head ${local.stdout.trim().slice(0, 12)} is not origin/main ${remote.stdout.trim().slice(0, 12)}`);
    else head = remote.stdout.trim();
  }

  if (!lib.parseVersion(version)) {
    reasons.push(`not a version: ${version} (expected vX.Y.Z, for example v0.2.0)`);
  } else {
    const local = lib.git(root, ['tag', '--list', 'v*']);
    const localTags = local.ok ? local.stdout.split('\n').filter(Boolean) : [];
    const remote = remoteTags(root);
    if (remote.error) reasons.push(remote.error);
    const remoteList = remote.tags || [];
    if (remoteList.includes(version)) reasons.push(`the tag ${version} already exists on origin`);
    else if (localTags.includes(version)) reasons.push(`the tag ${version} already exists here (delete the local tag, or pick the next version)`);
    const newest = lib.newestVersion([...localTags, ...remoteList]);
    if (newest && lib.compareVersions(version, newest) <= 0) reasons.push(`${version} is not higher than the newest tag, ${newest}`);
  }

  let changelog = null;
  try {
    changelog = fs.readFileSync(path.join(root, lib.CHANGELOG_REL), 'utf8');
  } catch {
    // Reported as missing.
  }
  if (lib.parseVersion(version)) reasons.push(...lib.changelogProblems(changelog, version));

  if (head) {
    const checks = checkRuns(root, head, env);
    if (checks.error) reasons.push(checks.error);
    else reasons.push(...lib.checkRunProblems(checks.runs));
  } else {
    reasons.push('the checks on main\'s head were not read (fix the reasons above first)');
  }

  if (reasons.length) return refuse(reasons);

  const tag = lib.git(root, ['tag', '-a', version, '-m', `AP Labs template ${version}`, head]);
  if (!tag.ok) {
    err(`template:release: could not create the tag ${version}: ${tag.stderr || 'git tag failed'}`);
    return 1;
  }
  out(`template:release: tagged ${version} on main at ${head.slice(0, 12)} (local only).`);
  if (!push) {
    out(`template:release: not pushed. A human pushes it: git push origin refs/tags/${version}`);
    return 0;
  }
  const pushed = lib.git(root, ['push', 'origin', `refs/tags/${version}`]);
  if (!pushed.ok) {
    err(`template:release: the tag ${version} is created here but the push failed: ${pushed.stderr || 'git push failed'}`);
    return 1;
  }
  out(`template:release: pushed ${version} to origin.`);
  return 0;
}

module.exports = { main, parseArgs, USAGE };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
