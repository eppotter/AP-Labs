'use strict';

// The "engine untouched" check (Story 11.5):
//
//   npm run template:check                       in a fork: is the engine the release's?
//   npm run template:check -- --record vX.Y.Z    day one: record the release a fork is built from
//
// Fork status comes from .aplabs/profile.yml (review B8). With no profile (the
// template) it says "not a fork; skipped" and passes. In a fork it reads the
// record, .aplabs/template-version, recomputes the engine fingerprint
// (kit/lib/template: sha256 over `git ls-files -z kit profiles/_schema`,
// framed path, NUL, length, bytes) and compares. A fork with no readable record
// fails. A changed engine fails: with the tag available (here, or fetched from
// the `upstream` remote) it names each file; offline it can only say the
// engine changed.
//
// --record checks the worktree's engine matches the tag, then writes the
// record. It never commits: the record is under .aplabs/, always T3, and goes
// through review like any other change.
//
// Exit codes: 0 passed or skipped, 1 failed or refused, 2 usage. Never pushes,
// never writes anything but the record, and reaches the network only to fetch
// the one tag from `upstream` when it is not here.

const lib = require('../lib/template');

const USAGE = 'usage: npm run template:check [-- --record vX.Y.Z]';

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let record;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--record') {
      record = argv[++i];
      if (!record || record.startsWith('-')) return { error: '--record needs the version, for example --record v0.2.0' };
      if (!lib.parseVersion(record)) return { error: `not a version: ${record} (expected vX.Y.Z)` };
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }
  return { record };
}

const describe = (diffs) => diffs.map((d) => `- ${d.path} (${d.change})`).join('\n');

function main(argv, deps = {}) {
  const out = deps.out || ((s) => console.log(s));
  const err = deps.err || ((s) => console.error(s));
  const cwd = deps.cwd || process.cwd();
  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.error) {
    err(`template:check: ${args.error}\n${USAGE}`);
    return 2;
  }
  const root = lib.repoRoot(cwd);
  if (!root) {
    err('template:check: not inside a git repository');
    return 2;
  }
  if (!lib.isFork(root)) {
    if (args.record) {
      err(`template:check: refusing --record: this is not a fork (no ${lib.PROFILE_REL}); only a fork records its template version`);
      return 1;
    }
    out(`template:check: not a fork (no ${lib.PROFILE_REL}); skipped`);
    return 0;
  }

  let mine;
  try {
    mine = lib.worktreeFingerprint(root);
  } catch (e) {
    err(`template:check: ${e.message}`);
    return 1;
  }

  if (args.record) return record(root, args.record, mine, { out, err });

  const read = lib.readRecord(root);
  if (read.missing) {
    err(`template:check: FAILED: ${lib.NO_RECORD}`);
    return 1;
  }
  if (read.error) {
    err(`template:check: FAILED: ${read.error}; run \`npm run template:check -- --record vX.Y.Z\``);
    return 1;
  }
  const { version, engine_sha256: recorded } = read.record;
  const count = Object.keys(mine.files).length;
  if (mine.sha256 === recorded) {
    out(`template:check: ok: the engine is untouched since ${version} (${count} files)`);
    return 0;
  }

  const tag = lib.resolveTag(root, version);
  if (tag.error) {
    err(`template:check: FAILED: the engine changed since ${version} (kit/ or profiles/_schema/ differ from the record). ` +
      `Offline this check can't name the files: ${tag.error}. To see them, add the template as the \`upstream\` remote and run this again.`);
    return 1;
  }
  let theirs;
  try {
    theirs = lib.refFingerprint(root, tag.ref);
  } catch (e) {
    err(`template:check: FAILED: the engine changed since ${version}, and ${e.message}`);
    return 1;
  }
  const diffs = lib.diffFiles(theirs.files, mine.files);
  const notes = [];
  if (theirs.sha256 !== recorded) notes.push(`The record's fingerprint does not match the tag ${version} either: the record itself was edited.`);
  err(`template:check: FAILED: the engine differs from ${version}${diffs.length ? ` in ${diffs.length} file(s):\n${describe(diffs)}` : '.'}` +
    `${notes.length ? `\n${notes.join('\n')}` : ''}\nA fork never edits kit/ or profiles/_schema/: change the template and take an update instead.`);
  return 1;
}

function record(root, version, mine, { out, err }) {
  const tag = lib.resolveTag(root, version);
  if (tag.error) {
    err(`template:check: refusing --record ${version}: ${tag.error}. Add the template as the \`upstream\` remote first.`);
    return 1;
  }
  let theirs;
  try {
    theirs = lib.refFingerprint(root, tag.ref);
  } catch (e) {
    err(`template:check: refusing --record ${version}: ${e.message}`);
    return 1;
  }
  if (theirs.sha256 !== mine.sha256) {
    const diffs = lib.diffFiles(theirs.files, mine.files);
    err(`template:check: refusing --record ${version}: the engine here is not ${version}'s; ${diffs.length} file(s) differ:\n${describe(diffs)}`);
    return 1;
  }
  const before = lib.readRecord(root);
  lib.writeRecord(root, { version, engine_sha256: mine.sha256 });
  const was = before.record ? ` (was ${before.record.version})` : '';
  out(`template:check: recorded ${version}${was} in ${lib.RECORD_REL} (engine sha256 ${mine.sha256}, ${Object.keys(mine.files).length} files). Commit it.`);
  return 0;
}

module.exports = { main, parseArgs, USAGE };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
