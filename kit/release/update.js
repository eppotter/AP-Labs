'use strict';

// Take a template update into a fork (Story 11.6):
//
//   npm run template:update -- vX.Y.Z
//
// Refuses, naming every reason, unless: this is a fork (.aplabs/profile.yml
// and a readable .aplabs/template-version); the template is the `upstream`
// remote (Q17); the worktree is clean, on main, and main is origin/main (after
// a fetch; review N11); the version is newer than the recorded one; and the
// engine check passes, so the fork has not edited kit/ or profiles/_schema/
// since its recorded release (each edited file is named). It also refuses,
// before changing anything, when the fork's profile schema_version is newer
// than the release's (Q18), and when the package rule can't apply (below).
//
// Then, on a new branch template/vX.Y.Z made from main, it merges the
// release's tag with a merge commit (no squash, no rebase) and, before
// committing, takes every path the merge changed (`git diff --no-renames
// --name-only main...MERGE_HEAD`, plus the conflicted paths; review B9)
// through kit/lib/fork's updateRule:
//   - .aplabs/** or the fork's app dir (app/, or APLABS_APP_DIR): abort;
//   - under a root the fork deleted on purpose (derived from what it deleted
//     since its recorded release): removed again;
//   - the fork's ledger, its build files (docs/ledger/) and planning docs
//     (UPDATE_RULES.forkOwned): reset to the fork's main;
//   - package.json and package-lock.json: the package rule (B10): the
//     template's package.json with the fork's appended dependencies
//     re-applied, and the template's lockfile, regenerated with
//     `npm install --package-lock-only --ignore-scripts` when the fork
//     appended any; abort if the template now ships one the fork appended;
//   - anything else: the template's version, and a conflict there aborts.
// An abort leaves the fork as it was: the merge is undone, the branch deleted
// and main checked out again, and the reason names the paths.
//
// It runs the profile migrations (kit/lib/template/migrations) from the
// fork's schema_version to the release's, checks the result against the
// release's schema, writes .aplabs/template-version (the only other .aplabs/
// write), and commits the merge. It then runs `npm ci` when the lockfile
// changed and `npm run check && npm test`. If they fail it keeps the branch
// for inspection, returns to main and opens no PR. If they pass it pushes the
// branch to origin and opens a PR in the fork with gh (APLABS_GH_BIN), whose
// body lists every path handled, the package files and the profile diff.
//
// Exit codes: 0 PR opened, 1 refused, aborted or failed, 2 usage.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Ajv2020 = require('ajv/dist/2020');
const YAML = require('yaml');
const lib = require('../lib/template');
const fork = require('../lib/fork');
const migrations = require('../lib/template/migrations');

const USAGE = 'usage: npm run template:update -- vX.Y.Z';
const SCHEMA_REL = 'profiles/_schema/profile.schema.json';
const MIGRATIONS_REL = 'kit/lib/template/migrations/index.js';

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let version;
  for (const a of argv) {
    if (a.startsWith('-')) return { error: `unknown argument: ${a}` };
    if (version !== undefined) return { error: `one version only, not ${a}` };
    version = a;
  }
  if (version === undefined) return { error: 'no version' };
  return { version };
}

const slash = (p) => p.split(path.sep).join('/');
const splitZ = (out) => out.split('\0').filter(Boolean);

// The steps that run by default, each overridable in tests (deps).
function runShell(command, root, env) {
  const r = spawnSync('bash', ['-c', command], { cwd: root, env, stdio: 'inherit' });
  return { ok: !r.error && r.status === 0, detail: r.error ? r.error.message : `exit ${r.status}` };
}
const DEFAULTS = Object.freeze({
  runChecks: (root, env) => runShell('npm run check && npm test', root, env),
  npmCi: (root, env) => runShell('npm ci', root, env),
  regenLock: (root, env) => runShell('npm install --package-lock-only --ignore-scripts', root, env),
  // The release's own steps, read from the merged tree (not this process's
  // copy, which is the fork's old engine).
  migrationSteps: (root) => {
    const file = path.join(root, MIGRATIONS_REL);
    delete require.cache[require.resolve(file)];
    return require(file).STEPS;
  },
});

function main(argv, env = process.env, deps = {}) {
  const out = deps.out || ((s) => console.log(s));
  const err = deps.err || ((s) => console.error(s));
  const cwd = deps.cwd || process.cwd();
  const step = { ...DEFAULTS, ...deps };
  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.error) {
    err(`template:update: ${args.error}\n${USAGE}`);
    return 2;
  }
  const { version } = args;
  const root = lib.repoRoot(cwd);
  if (!root) {
    err('template:update: not inside a git repository');
    return 2;
  }
  const g = (a, opts = {}) => lib.git(root, a, { env, ...opts });
  const refuse = (reasons) => {
    err(`template:update: refusing to update to ${version}:\n${reasons.map((r) => `- ${r}`).join('\n')}`);
    return 1;
  };

  // ---- 1. may it run? -------------------------------------------------
  if (!lib.isFork(root)) return refuse([`this is not a fork (no ${lib.PROFILE_REL}); updates run in a fork`]);
  const read = lib.readRecord(root);
  if (read.missing) return refuse([`${lib.NO_RECORD}, then take updates`]);
  if (read.error) return refuse([read.error]);
  const from = read.record.version;

  const reasons = [];
  if (!lib.parseVersion(version)) reasons.push(`not a version: ${version} (expected vX.Y.Z, for example v0.3.0)`);
  else if (lib.compareVersions(version, from) <= 0) reasons.push(`${version} is not newer than the recorded ${from}`);

  const hasUpstream = g(['remote', 'get-url', 'upstream']).ok;
  if (!hasUpstream) reasons.push('there is no `upstream` remote: add the template as `upstream` (git remote add upstream <template repo url>)');

  const status = g(['status', '--porcelain']);
  if (!status.ok) reasons.push(`could not read git status: ${status.stderr}`);
  else if (status.stdout.trim()) reasons.push('the worktree is not clean (commit or remove the changes first)');
  const branch = g(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const onMain = branch.ok && branch.stdout.trim() === 'main';
  if (!onMain) reasons.push(`not on main (on ${branch.ok ? branch.stdout.trim() : 'a detached HEAD'})`);

  const fetch = g(['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  if (!fetch.ok) {
    reasons.push(`could not fetch main from origin: ${fetch.stderr || 'git fetch failed'}`);
  } else {
    const local = g(['rev-parse', '--verify', 'refs/heads/main']);
    const remote = g(['rev-parse', '--verify', 'refs/remotes/origin/main']);
    if (!local.ok || !remote.ok) reasons.push('could not read main or origin/main');
    else if (local.stdout.trim() !== remote.stdout.trim()) reasons.push(`the local main ${local.stdout.trim().slice(0, 12)} is not origin/main ${remote.stdout.trim().slice(0, 12)} (pull or push first)`);
  }

  // The engine check (npm run template:check), naming each edited file when
  // the recorded tag can be read.
  let mine = null;
  try {
    mine = lib.worktreeFingerprint(root);
  } catch (e) {
    reasons.push(e.message);
  }
  if (mine && hasUpstream) {
    const tag = lib.resolveTag(root, from, { env });
    if (tag.error) {
      reasons.push(`could not read the recorded release: ${tag.error}`);
    } else {
      let theirs = null;
      try {
        theirs = lib.refFingerprint(root, tag.ref);
      } catch (e) {
        reasons.push(e.message);
      }
      if (theirs) {
        const diffs = lib.diffFiles(theirs.files, mine.files);
        if (diffs.length) {
          reasons.push(`the fork edited the engine since ${from} (npm run template:check fails); undo these and send the fix to the template:\n${diffs.map((d) => `    ${d.path} (${d.change})`).join('\n')}`);
        } else if (mine.sha256 !== read.record.engine_sha256) {
          reasons.push(`npm run template:check fails: ${lib.RECORD_REL}'s fingerprint is not ${from}'s (the record was edited)`);
        }
      }
    }
  } else if (mine && mine.sha256 !== read.record.engine_sha256) {
    reasons.push(`npm run template:check fails: the engine changed since ${from}`);
  }
  if (reasons.length) return refuse(reasons);

  // ---- 2. the release, and what can be judged before any change ---------
  const target = lib.resolveTag(root, version, { env });
  if (target.error) return refuse([target.error]);
  const targetSha = g(['rev-parse', '--verify', `${target.ref}^{commit}`]).stdout.trim();
  const fromRef = `refs/tags/${from}`;
  const work = `template/${version}`;
  if (g(['rev-parse', '--verify', '--quiet', `refs/heads/${work}`]).ok) return refuse([`the branch ${work} already exists here (delete it to try again)`]);
  const onOrigin = g(['ls-remote', '--heads', 'origin', work]);
  if (onOrigin.ok && onOrigin.stdout.trim()) return refuse([`the branch ${work} already exists on origin`]);

  const show = (ref, rel) => {
    const r = g(['show', `${ref}:${rel}`]);
    return r.ok ? r.stdout : null;
  };
  const json = (text) => {
    try {
      return text === null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  };

  // Q18: the fork's schema_version against the release's.
  const profileText = fs.readFileSync(path.join(root, lib.PROFILE_REL), 'utf8');
  let forkSv;
  try {
    forkSv = (YAML.parse(profileText) || {}).schema_version;
  } catch (e) {
    return refuse([`${lib.PROFILE_REL} is not valid YAML (${e.message.split('\n')[0]})`]);
  }
  const templateSv = migrations.schemaVersionOf(json(show(targetSha, SCHEMA_REL)));
  if (!Number.isInteger(forkSv)) return refuse([`${lib.PROFILE_REL} has no whole-number schema_version`]);
  if (templateSv === null) return refuse([`${version}'s ${SCHEMA_REL} names no schema_version`]);
  if (forkSv > templateSv) return refuse([`the fork's profile schema_version ${forkSv} is newer than ${version}'s (${templateSv}); a fork never runs ahead of its template`]);

  // B10: the package rule, judged before the merge so an abort changes
  // nothing. It applies only when the release changes the package files.
  let pkgPlan = { pkg: null, appended: [], problems: [] };
  const pkgChanged = fork.PACKAGE_FILES.some((rel) => show(fromRef, rel) !== show(targetSha, rel));
  if (pkgChanged) {
    const recordedPkg = json(show(fromRef, 'package.json'));
    const forkPkg = json(show('refs/heads/main', 'package.json'));
    const templatePkg = json(show(targetSha, 'package.json'));
    if (recordedPkg && forkPkg && templatePkg) pkgPlan = lib.packagePlan({ recordedPkg, forkPkg, templatePkg });
    else pkgPlan.problems.push('could not read package.json at the recorded release, on main and in the release');
  }
  if (pkgPlan.problems.length) return refuse(pkgPlan.problems);

  // ---- 3. branch and merge --------------------------------------------
  const mainSha = g(['rev-parse', '--verify', 'refs/heads/main']).stdout.trim();
  const abort = (why, paths = []) => {
    g(['merge', '--abort']);
    g(['reset', '--hard', '--quiet', 'HEAD']);
    g(['switch', '--quiet', 'main']);
    g(['branch', '-D', work]);
    err(`template:update: aborted the update to ${version}; the fork is unchanged and back on main.\n${why}${paths.length ? `\n${paths.map((p) => `    ${p}`).join('\n')}` : ''}`);
    return 1;
  };
  const sw = g(['switch', '--quiet', '-c', work, 'main']);
  if (!sw.ok) return refuse([`could not create the branch ${work}: ${sw.stderr}`]);
  const merge = g(['merge', '--no-ff', '--no-commit', '--no-edit', targetSha]);
  if (!g(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok) {
    return abort(`merging ${version} did not start: ${(merge.stderr || merge.stdout || 'git merge failed').trim().split('\n')[0]}`);
  }

  const conflicted = new Set(splitZ(g(['diff', '--name-only', '--diff-filter=U', '-z']).stdout));
  const changed = splitZ(g(['diff', '--no-renames', '--name-only', '-z', 'main...MERGE_HEAD']).stdout);
  const paths = [...new Set([...changed, ...conflicted])].sort();
  const roots = fork.deletedRoots(
    splitZ(g(['ls-tree', '-r', '--name-only', '-z', fromRef]).stdout),
    splitZ(g(['ls-tree', '-r', '--name-only', '-z', 'refs/heads/main']).stdout),
  );
  // The app dir: app/, and APLABS_APP_DIR too when it is set inside the repo.
  const appDirs = ['app'];
  if (env.APLABS_APP_DIR) {
    const rel = slash(path.relative(root, path.resolve(root, env.APLABS_APP_DIR)));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) appDirs.push(rel);
  }

  const byRule = { fork: [], package: [], 'fork-owned': [], deleted: [], template: [] };
  for (const rel of paths) byRule[fork.updateRule(rel, { deletedRoots: roots, appDir: appDirs })].push(rel);
  if (byRule.fork.length) {
    return abort(`${version} changes the fork's own files (.aplabs/ or the app dir ${appDirs.map((d) => `${d}/`).join(', ')}), which an update never writes:`, byRule.fork);
  }
  const otherConflicts = byRule.template.filter((p) => conflicted.has(p));
  if (otherConflicts.length) {
    return abort(`${version} conflicts with the fork outside the files an update resolves; merge by hand or fix it in the template:`, otherConflicts);
  }

  const conflicts = [];
  const note = (rel, how) => {
    if (conflicted.has(rel)) conflicts.push({ path: rel, how });
  };
  for (const rel of byRule.deleted) {
    g(['rm', '-q', '-f', '--ignore-unmatch', '--', rel]);
    fs.rmSync(path.join(root, rel), { force: true });
    note(rel, 'kept deleted (the fork deleted it on purpose)');
  }
  for (const rel of byRule['fork-owned']) {
    if (g(['cat-file', '-e', `refs/heads/main:${rel}`]).ok) g(['checkout', 'refs/heads/main', '--', rel]);
    else {
      g(['rm', '-q', '-f', '--ignore-unmatch', '--', rel]);
      fs.rmSync(path.join(root, rel), { force: true });
    }
    note(rel, 'kept the fork\'s version (fork-owned)');
  }

  let lockRegenerated = false;
  if (byRule.package.length) {
    if (pkgPlan.appended.length) {
      fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(pkgPlan.pkg, null, 2)}\n`);
    } else {
      g(['checkout', targetSha, '--', 'package.json']);
    }
    if (g(['cat-file', '-e', `${targetSha}:package-lock.json`]).ok) g(['checkout', targetSha, '--', 'package-lock.json']);
    if (pkgPlan.appended.length) {
      const regen = step.regenLock(root, env);
      if (!regen.ok) return abort(`could not regenerate package-lock.json with npm install --package-lock-only --ignore-scripts (${regen.detail})`);
      lockRegenerated = true;
    }
    g(['add', '--', 'package.json', 'package-lock.json']);
    for (const rel of byRule.package) note(rel, 'the template\'s, with the fork\'s appended dependencies re-applied');
  }

  // Q18: migrate the profile to the release's schema_version.
  let profileDiff = '';
  let applied = [];
  if (forkSv < templateSv) {
    let result;
    try {
      result = migrations.migrateProfile(profileText, { from: forkSv, to: templateSv, steps: step.migrationSteps(root) });
    } catch (e) {
      return abort(`could not migrate ${lib.PROFILE_REL}: ${e.message}`);
    }
    const problems = schemaProblems(root, result.text);
    if (problems.length) return abort(`the migrated ${lib.PROFILE_REL} does not pass ${version}'s schema:`, problems);
    fs.writeFileSync(path.join(root, lib.PROFILE_REL), result.text);
    profileDiff = g(['diff', '--', lib.PROFILE_REL]).stdout;
    g(['add', '--', lib.PROFILE_REL]);
    applied = result.applied;
  }

  const left = splitZ(g(['diff', '--name-only', '--diff-filter=U', '-z']).stdout);
  if (left.length) return abort('some conflicts are still unresolved:', left);

  // The engine must now be exactly the release's; then record it.
  let theirs;
  let now;
  try {
    theirs = lib.refFingerprint(root, targetSha);
    now = lib.worktreeFingerprint(root);
  } catch (e) {
    return abort(e.message);
  }
  if (theirs.sha256 !== now.sha256) {
    return abort(`after the merge the engine is not ${version}'s:`, lib.diffFiles(theirs.files, now.files).map((d) => `${d.path} (${d.change})`));
  }
  lib.writeRecord(root, { version, engine_sha256: now.sha256 });
  g(['add', '--', lib.RECORD_REL]);
  const commit = g(['commit', '--quiet', '-m', `Merge template ${version} into the fork (from ${from})`]);
  if (!commit.ok) return abort(`could not commit the merge: ${commit.stderr}`);
  const head = g(['rev-parse', 'HEAD']).stdout.trim();
  out(`template:update: merged ${version} on ${work} at ${head.slice(0, 12)}.`);

  // ---- 4. checks, push, PR --------------------------------------------
  const keep = (why) => {
    g(['switch', '--quiet', 'main']);
    err(`template:update: ${why}. Kept the branch ${work} (not pushed), opened no PR, and returned to main.`);
    return 1;
  };
  const lockChanged = !g(['diff', '--quiet', mainSha, 'HEAD', '--', 'package-lock.json']).ok;
  if (lockChanged) {
    const ci = step.npmCi(root, env);
    if (!ci.ok) return keep(`npm ci failed (${ci.detail})`);
  }
  const checks = step.runChecks(root, env);
  if (!checks.ok) return keep(`npm run check && npm test failed on ${work} (${checks.detail})`);

  const push = g(['push', '--quiet', '-u', 'origin', work]);
  if (!push.ok) return keep(`could not push ${work} to origin: ${push.stderr}`);

  const changelog = lib.changelogEntry(show(targetSha, lib.CHANGELOG_REL), version);
  const body = lib.updatePrBody({
    version, from, branch: work, changelog, conflicts,
    removed: byRule.deleted, reset: byRule['fork-owned'], deletedRoots: roots,
    packageFiles: byRule.package, appended: pkgPlan.appended, lockRegenerated, profileDiff, migrations: applied,
  });
  const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-update-'));
  const bodyFile = path.join(bodyDir, 'body.md');
  fs.writeFileSync(bodyFile, body);
  const gh = spawnSync(env.APLABS_GH_BIN || 'gh', ['pr', 'create', '--base', 'main', '--head', work, '--title', `Template update to ${version}`, '--body-file', bodyFile], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  fs.rmSync(bodyDir, { recursive: true, force: true });
  g(['switch', '--quiet', 'main']);
  if (gh.error || gh.status !== 0) {
    err(`template:update: pushed ${work}, but gh could not open the PR: ${gh.error ? gh.error.message : (gh.stderr || '').trim() || `exit ${gh.status}`}. Open it by hand.`);
    return 1;
  }
  out(`template:update: opened the PR for ${version}: ${(gh.stdout || '').trim()}`);
  return 0;
}

// The release's schema (read from the merged tree) against profile text:
// a list of problems, empty when it passes.
function schemaProblems(root, text) {
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(path.join(root, SCHEMA_REL), 'utf8'));
  } catch (e) {
    return [`could not read ${SCHEMA_REL}: ${e.message}`];
  }
  let validate;
  try {
    validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  } catch (e) {
    return [`${SCHEMA_REL} does not compile: ${e.message}`];
  }
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    return [`not valid YAML: ${e.message.split('\n')[0]}`];
  }
  if (validate(doc)) return [];
  return validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);
}

module.exports = { main, parseArgs, USAGE };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
