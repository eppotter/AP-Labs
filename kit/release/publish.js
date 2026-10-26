'use strict';

// Publish a template release to the distribution repo (plan template-dist,
// Story D.2). Clients never clone this repo: they clone the dist repo, whose
// commits are the releases' files minus the internal paths (kit/lib/dist
// EXCLUDED), with the ledger's rows emptied.
//
//   npm run template:publish -- vX.Y.Z [--first] [--push]
//   npm run template:publish -- --check
//
// Publishing refuses, naming every reason, unless:
//   - this is the template, not a fork (no .aplabs/profile.yml);
//   - a `dist` remote exists with remote.dist.tagOpt = --no-tags;
//   - vX.Y.Z is a local annotated tag whose object is origin's, and its
//     commit is reachable from origin/main;
//   - the distribution tree builds (kit/lib/dist buildDistTree): the deny
//     list loads from the tag's tree, nothing in it hits, and there is no
//     gitlink and no symlink into an excluded path;
//   - the parent rule holds: the dist commit's parent is the newest dist
//     tag's commit, the dist repo's main equals it, and vX.Y.Z is higher
//     (one line of releases, N6). An empty dist repo needs --first (a new
//     root commit), and --first refuses on a dist repo with any ref. A dist
//     remote that can't be reached always refuses: it is never taken for an
//     empty one.
//
// The dist repo lives in its own namespace here: it is fetched only with
// explicit refspecs and --no-tags into refs/dist/main and refs/dist/tags/v*,
// so its vX.Y.Z tags never enter refs/tags/, where this repo's own tags live.
// The commit and its annotated tag have a fixed identity and message (nothing
// is copied from source commit or tag messages) and the source commit's date,
// so the same release always builds the same commit. The tag is stored at
// refs/dist/tags/vX.Y.Z and refs/dist/main moves to the commit.
//
// A re-run for a tag already published with the same tree says so and exits
// 0; a different tree refuses. Without --push it prints the one push command
// for a human: Ely pushes, the Orchestrator never passes --push (AGENTS.md).
// With --push it runs it: atomic and fast-forward only, never forced.
//
// --check (no version, no remote) builds the distribution tree for HEAD,
// writes it into a temp git repo with node_modules linked, asserts its engine
// fingerprint is HEAD's, and runs `npm run check && npm test && npm run
// test:slow` there (the `dist` CI job). Shipped files that name an excluded
// path are printed as a warning only (N8).
//
// Exit codes: 0 published, already published or checked; 1 refused or
// failed; 2 usage.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('../lib/template');
const dist = require('../lib/dist');

const USAGE = 'usage: npm run template:publish -- vX.Y.Z [--first] [--push]\n       npm run template:publish -- --check';
const IDENTITY = Object.freeze({ name: 'AP Labs template', email: 'template@aplabs.invalid' });
const DIST_MAIN = 'refs/dist/main';
const DIST_TAGS = 'refs/dist/tags';
const FETCH_MAIN = `+refs/heads/main:${DIST_MAIN}`;
const FETCH_TAGS = `+refs/tags/v*:${DIST_TAGS}/v*`;
const CHECK_COMMAND = 'npm run check && npm test && npm run test:slow';
const ZERO = '0'.repeat(40);

const distTag = (v) => `${DIST_TAGS}/${v}`;
const pushCommand = (v) => `git push --atomic dist ${DIST_MAIN}:refs/heads/main ${distTag(v)}:refs/tags/${v}`;
const short = (s) => (s ? s.slice(0, 12) : 'none');

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let version;
  let first = false;
  let push = false;
  let check = false;
  for (const a of argv) {
    if (a === '--first') first = true;
    else if (a === '--push') push = true;
    else if (a === '--check') check = true;
    else if (a.startsWith('-')) return { error: `unknown argument: ${a}` };
    else if (version !== undefined) return { error: `one version only, not ${a}` };
    else version = a;
  }
  if (check) {
    if (version !== undefined || first || push) return { error: '--check takes no version, --first or --push' };
    return { check: true };
  }
  if (version === undefined) return { error: 'no version' };
  return { version, first, push };
}

// The env the --check test run gets: this one minus any APLABS_* setting (so
// nothing of this checkout governs the copy, as in CI) and node:test's
// parent marker.
function checkEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (k.startsWith('APLABS_') || k === 'NODE_TEST_CONTEXT') delete out[k];
  return out;
}

function runTestsDefault(dir, env) {
  const r = spawnSync('bash', ['-c', CHECK_COMMAND], { cwd: dir, env: checkEnv(env), stdio: 'inherit' });
  return { ok: !r.error && r.status === 0, detail: r.error ? r.error.message : `exit ${r.status}` };
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
    err(`template:publish: ${args.error}\n${USAGE}`);
    return 2;
  }
  const root = lib.repoRoot(cwd);
  if (!root) {
    err('template:publish: not inside a git repository');
    return 2;
  }
  const what = args.check ? 'check the distribution tree' : `publish ${args.version}`;
  const refuse = (reasons) => {
    err(`template:publish: refusing to ${what}:\n${reasons.map((r) => `- ${r}`).join('\n')}`);
    return 1;
  };
  if (lib.isFork(root)) return refuse([`this is a fork (${lib.PROFILE_REL} exists); releases are published from the template`]);
  const ctx = { root, env, out, err, refuse, excluded: deps.excluded, g: (a, o = {}) => lib.git(root, a, { env, ...o }) };
  if (args.check) return check(ctx, deps.runTests || runTestsDefault);
  return publish(ctx, args);
}

// ---- publish ------------------------------------------------------------

// The dist remote's refs, read with ls-remote: { main, tags: [names], any }
// or { error }.
function remoteState(g) {
  const r = g(['ls-remote', 'dist']);
  if (!r.ok) return { error: `could not fetch from the dist remote: ${(r.stderr || 'git ls-remote failed').split('\n')[0]} (an unreachable remote is never taken for an empty one)` };
  const refs = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')[1]);
  const tags = refs.filter((ref) => /^refs\/tags\/v[^^]*$/.test(ref)).map((ref) => ref.slice('refs/tags/'.length));
  return { main: refs.includes('refs/heads/main'), tags, any: refs.length > 0 };
}

const rev = (g, ref) => {
  const r = g(['rev-parse', '--verify', '--quiet', ref]);
  return r.ok ? r.stdout.trim() : null;
};

function publish(ctx, { version, first, push }) {
  const { g, out, err, refuse } = ctx;
  const reasons = [];

  // The dist remote, fetched only into refs/dist/*.
  let state = null;
  if (!g(['remote', 'get-url', 'dist']).ok) {
    reasons.push('there is no `dist` remote (add it once: git remote add --no-tags dist <dist repo url>)');
  } else {
    const tagOpt = g(['config', '--get', 'remote.dist.tagOpt']);
    if (!tagOpt.ok || tagOpt.stdout.trim() !== '--no-tags') {
      reasons.push('the `dist` remote would fetch its tags into refs/tags/ (remote.dist.tagOpt is not --no-tags); set it: git config remote.dist.tagOpt --no-tags');
    }
    const s = remoteState(g);
    if (s.error) {
      reasons.push(s.error);
    } else {
      const fetch = g(['fetch', '--quiet', '--no-tags', 'dist', ...(s.main ? [FETCH_MAIN] : []), FETCH_TAGS]);
      if (!fetch.ok) reasons.push(`could not fetch from the dist remote: ${(fetch.stderr || 'git fetch failed').split('\n')[0]}`);
      else state = s;
    }
  }

  // The source tag: annotated, origin's, on origin/main.
  const tagRef = `refs/tags/${version}`;
  let tagOk = false;
  if (!lib.parseVersion(version)) {
    reasons.push(`not a version: ${version} (expected vX.Y.Z, for example v0.2.0)`);
  } else {
    const tagReasons = [];
    const obj = rev(g, tagRef);
    if (!obj) {
      tagReasons.push(`there is no local tag ${version} (cut it with npm run template:release first)`);
    } else {
      const type = g(['cat-file', '-t', obj]);
      if (!type.ok || type.stdout.trim() !== 'tag') tagReasons.push(`${version} is a lightweight tag; releases are annotated tags (npm run template:release)`);
      const remote = g(['ls-remote', 'origin', tagRef]);
      if (!remote.ok) {
        tagReasons.push(`could not list origin's tag ${version}: ${(remote.stderr || 'git ls-remote failed').split('\n')[0]}`);
      } else {
        const line = remote.stdout.split('\n').find((l) => l.endsWith(`\t${tagRef}`));
        const theirs = line ? line.split('\t')[0] : null;
        if (!theirs) tagReasons.push(`the tag ${version} is not on origin (push it first: git push origin ${tagRef})`);
        else if (theirs !== obj) tagReasons.push(`the local tag ${version} (${short(obj)}) is not origin's (${short(theirs)})`);
      }
      const fetch = g(['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
      if (!fetch.ok) tagReasons.push(`could not fetch main from origin: ${(fetch.stderr || 'git fetch failed').split('\n')[0]}`);
      else if (!g(['merge-base', '--is-ancestor', `${tagRef}^{commit}`, 'refs/remotes/origin/main']).ok) {
        tagReasons.push(`the commit of ${version} is not on origin/main (only reviewed, merged work is published)`);
      }
    }
    reasons.push(...tagReasons);
    tagOk = Boolean(obj) && !tagReasons.some((r) => r.startsWith('there is no local tag'));
  }

  // The tree, from the tag (the deny list too).
  let built = null;
  if (tagOk) {
    built = dist.buildDistTree(ctx.root, tagRef, { env: ctx.env, excluded: ctx.excluded });
    reasons.push(...built.problems);
  }
  if (reasons.length) return refuse(reasons);

  const remoteMain = state.main ? rev(g, DIST_MAIN) : null;
  const finish = () => {
    if (!push) {
      out(`template:publish: not pushed. A human pushes it:\n  ${pushCommand(version)}`);
      return 0;
    }
    const pushed = g(['push', '--atomic', 'dist', `${DIST_MAIN}:refs/heads/main`, `${distTag(version)}:refs/tags/${version}`]);
    if (!pushed.ok) {
      err(`template:publish: ${version} is built here, but the push failed: ${pushed.stderr || 'git push failed'}`);
      return 1;
    }
    out(`template:publish: pushed ${version} and main to the dist remote.`);
    return 0;
  };

  // A re-run: the dist tag is already here (fetched, or built and not pushed).
  const existing = rev(g, `${distTag(version)}^{tree}`);
  if (existing) {
    if (existing !== built.tree) return refuse([`${version} is already published with a different tree; a published release never changes (fix by hand)`]);
    if (state.tags.includes(version)) {
      out(`template:publish: ${version} is already published (the same tree); nothing to do.`);
      return 0;
    }
    // Built here before and not pushed: the fetch reset refs/dist/main to the
    // remote's, so move it back onto the commit when that still fits.
    const commit = rev(g, `${distTag(version)}^{commit}`);
    const parent = rev(g, `${commit}^`);
    if (parent !== remoteMain) return refuse([`${version} is published here but not pushed, and the dist repo's main moved; fix by hand`]);
    const upd = g(['update-ref', DIST_MAIN, commit]);
    if (!upd.ok) return refuse([`could not update ${DIST_MAIN}: ${upd.stderr}`]);
    out(`template:publish: ${version} is already published here (the same tree), not pushed yet.`);
    return finish();
  }

  // The parent rule.
  const rules = [];
  const localTags = g(['for-each-ref', '--format=%(refname:strip=3)', `${DIST_TAGS}/`]).stdout.split('\n').filter(Boolean);
  for (const t of localTags.filter((x) => !state.tags.includes(x))) {
    rules.push(`${distTag(t)} is here but not on the dist remote: push it first (or delete it: git update-ref -d ${distTag(t)})`);
  }
  let parent = null;
  if (!state.any) {
    if (!first) rules.push('the dist remote is empty: the first release is published with --first (it makes a new root commit)');
  } else if (first) {
    rules.push('--first refuses: the dist remote already has refs (a second root commit would cut every fork off from updates)');
  } else {
    const newest = lib.newestVersion(state.tags);
    if (!newest) {
      rules.push('the dist remote has refs but no vX.Y.Z tag; fix by hand');
    } else {
      parent = rev(g, `${distTag(newest)}^{commit}`);
      if (remoteMain !== parent) rules.push(`the dist repo's main moved; fix by hand (its main is ${short(remoteMain)}, the newest dist tag ${newest} is ${short(parent)})`);
      if (lib.compareVersions(version, newest) <= 0) rules.push(`${version} is not higher than the newest dist release, ${newest} (one line of releases only)`);
    }
  }
  if (rules.length) return refuse(rules);

  // The commit and its tag, with a fixed identity and the source's date.
  const ct = g(['log', '-1', '--format=%ct', built.source]).stdout.trim();
  const date = `${ct} +0000`;
  const idEnv = {
    ...ctx.env,
    GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email, GIT_COMMITTER_DATE: date,
  };
  const message = `AP Labs template ${version}\n\nSource: ${built.source}\n`;
  const made = lib.git(ctx.root, ['commit-tree', '--no-gpg-sign', built.tree, ...(parent ? ['-p', parent] : []), '-F', '-'], { env: idEnv, input: message });
  if (!made.ok) return refuse([`could not create the dist commit: ${made.stderr}`]);
  const commit = made.stdout.trim();
  const engine = dist.engineProblem(ctx.root, tagRef, commit);
  if (engine) return refuse([engine]);
  const tagText = `object ${commit}\ntype commit\ntag ${version}\ntagger ${IDENTITY.name} <${IDENTITY.email}> ${date}\n\nAP Labs template ${version}\n`;
  const tag = g(['mktag'], { input: tagText });
  if (!tag.ok) return refuse([`could not create the dist tag: ${tag.stderr}`]);
  const tx = [
    'start',
    `create ${distTag(version)} ${tag.stdout.trim()}`,
    parent ? `update ${DIST_MAIN} ${commit} ${remoteMain}` : `update ${DIST_MAIN} ${commit}`,
    'prepare',
    'commit',
    '',
  ].join('\n');
  const refs = g(['update-ref', '--stdin'], { input: tx });
  if (!refs.ok) return refuse([`could not update the dist refs: ${refs.stderr}`]);
  out(`template:publish: built ${version} for the dist repo at ${short(commit)} (parent ${parent ? short(parent) : 'none: a new root'}), from ${short(built.source)}; ${built.files} files, without ${dist.EXCLUDED.join(', ')}. Stored at ${distTag(version)} and ${DIST_MAIN} (local only).`);
  if (built.binary.length) out(`template:publish: binary files shipped (paths scanned, contents not): ${built.binary.join(', ')}`);
  return finish();
}

// ---- --check --------------------------------------------------------------

function check(ctx, runTests) {
  const { root, env, out, refuse } = ctx;
  const built = dist.buildDistTree(root, 'HEAD', { env, excluded: ctx.excluded });
  if (built.problems.length) return refuse(built.problems);
  if (built.mentions.length) {
    out(`template:publish: warning: ${built.mentions.length} shipped file(s) mention an excluded path (N8, not a failure): ${built.mentions.join(', ')}`);
  }
  if (built.binary.length) out(`template:publish: binary files shipped (paths scanned, contents not): ${built.binary.join(', ')}`);

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-dist-check-')));
  try {
    const copy = path.join(dir, 'dist');
    fs.mkdirSync(copy);
    // The tree, written out through a temporary index (this repo's index and
    // worktree are never touched).
    const idxEnv = { ...env, GIT_INDEX_FILE: path.join(dir, 'index') };
    const read = lib.git(root, ['read-tree', built.tree], { env: idxEnv });
    const co = read.ok && lib.git(root, ['checkout-index', '--all', '--force', `--prefix=${copy}/`], { env: idxEnv });
    if (!read.ok || !co.ok) return refuse([`could not write the distribution tree out: ${(read.ok ? co : read).stderr}`]);
    const cg = (a) => lib.git(copy, a, {
      env: { ...env, GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email },
    });
    for (const a of [['init', '-q', '-b', 'main'], ['add', '-A', '-f'], ['commit', '-q', '--no-verify', '--no-gpg-sign', '-m', 'distribution tree (check)']]) {
      const r = cg(a);
      if (!r.ok) return refuse([`could not make the distribution copy a git repo (git ${a[0]}): ${r.stderr}`]);
    }
    if (rev((a) => lib.git(copy, a, { env }), 'HEAD^{tree}') !== built.tree) return refuse(['the distribution copy\'s tree is not the built tree']);
    const engine = dist.engineProblem(root, 'HEAD', 'HEAD', copy);
    if (engine) return refuse([engine]);
    // After the commit, so the link is never tracked.
    if (fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
    out(`template:publish: the distribution tree of HEAD (${short(built.source)}) has ${built.files} files, no deny-list hit and HEAD's engine; running ${CHECK_COMMAND} in it.`);
    const r = runTests(copy, env);
    if (!r.ok) return refuse([`${CHECK_COMMAND} failed in the distribution tree (${r.detail})`]);
    out('template:publish: ok (the distribution tree builds and passes its tests).');
    return 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { main, parseArgs, pushCommand, USAGE, IDENTITY, CHECK_COMMAND, DIST_MAIN, DIST_TAGS };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
