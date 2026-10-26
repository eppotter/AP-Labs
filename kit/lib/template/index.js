'use strict';

// Template releases, the "engine untouched" check (Story 11.5) and template
// updates (Story 11.6): the pure half plus the small git reads the CLIs
// share. The CLIs live in kit/release/ (release.js, check.js, update.js).
//
// The engine fingerprint (Q15, review N9) is a sha256 over the files
// `git ls-files -z kit profiles/_schema` lists (the identical-engine set,
// kit/runtime/paths.js), sorted by path, each framed as
//
//     path (UTF-8) | NUL | length (8 bytes, big-endian) | bytes
//
// so no two different file sets can hash alike. A file's bytes are its
// content; a symlink's are its target, as git stores it. A listed file missing
// from the worktree is left out (so the fingerprint changes). The same
// framing over the blobs of a tag gives the tag's fingerprint, so a fork can
// name each changed file when the tag is available, and say only "the engine
// changed" when it is not (offline CI).
//
// The record, .aplabs/template-version, is two YAML keys:
//
//     version: vX.Y.Z
//     engine_sha256: <64 hex>
//
// Fork status comes from .aplabs/profile.yml (review B8), never from the
// record: a repo with a profile is a fork, and a fork with no readable record
// fails the check.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { ENGINE_DIRS } = require('../../runtime/paths');
const { areaOf, packageDelta, DEP_SECTIONS } = require('../fork');

const PROFILE_REL = '.aplabs/profile.yml';
const RECORD_REL = '.aplabs/template-version';
const CHANGELOG_REL = 'CHANGELOG.md';
// The jobs a release needs on main's head, besides every other check passing.
const REQUIRED_JOBS = Object.freeze(['test', 'clean-bones', 'container', 'dist']);
const VERSION_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const NO_RECORD = `fork without a template record; run \`npm run template:check -- --record vX.Y.Z\``;

// ---- git ----------------------------------------------------------------

// Runs git in cwd (with env, default the process's). Returns { ok, stdout
// (Buffer or string), stderr }.
function git(cwd, args, { encoding = 'utf8', input, env } = {}) {
  const r = spawnSync('git', args, {
    cwd, env, encoding: encoding === 'buffer' ? undefined : encoding, input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = r.error ? r.error.message : String(r.stderr || '').trim();
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? (encoding === 'buffer' ? Buffer.alloc(0) : ''), stderr };
}

// The repo root for cwd, or null outside a git repo.
function repoRoot(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.stdout.trim() : null;
}

const isFork = (root) => fs.existsSync(path.join(root, PROFILE_REL));

// ---- fingerprint --------------------------------------------------------

// The framed sha256 over entries [{ path, bytes }], sorted by path bytes.
function frame(entries) {
  const h = crypto.createHash('sha256');
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const { path: rel, bytes } of sorted) {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(bytes.length));
    h.update(Buffer.from(rel, 'utf8'));
    h.update(Buffer.from([0]));
    h.update(len);
    h.update(bytes);
  }
  return h.digest('hex');
}

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// A fingerprint from entries: { sha256, files: { path: sha256 of bytes } }.
function summarise(entries) {
  const files = {};
  for (const e of entries) files[e.path] = sha(e.bytes);
  return { sha256: frame(entries), files };
}

// Splits `git ls-files -s -z` or `git ls-tree -r -z` output into
// { mode, oid, path }. Gitlinks (submodules) are left out.
function parseIndexLines(out, { tree }) {
  const seen = new Map();
  for (const line of out.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const meta = line.slice(0, tab).split(' ');
    const rel = line.slice(tab + 1);
    const mode = meta[0];
    const oid = tree ? meta[2] : meta[1];
    if (mode === '160000') continue;
    // One entry per path, also while a merge leaves several stages.
    if (!seen.has(rel)) seen.set(rel, { mode, oid, path: rel });
  }
  // Only the identical-engine set (kit/lib/fork's one definition of it).
  return [...seen.values()].filter((e) => areaOf(e.path) === 'engine');
}

/**
 * The engine fingerprint of the worktree at root: the files git tracks under
 * kit/ and profiles/_schema/, read from disk. Throws when git can't list them.
 */
function worktreeFingerprint(root) {
  const r = git(root, ['ls-files', '-s', '-z', '--', ...ENGINE_DIRS]);
  if (!r.ok) throw new Error(`could not list the engine files: ${r.stderr || 'git ls-files failed'}`);
  const entries = [];
  for (const e of parseIndexLines(r.stdout, { tree: false })) {
    const abs = path.join(root, e.path);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue; // deleted in the worktree: left out, so the fingerprint differs
    }
    const bytes = st.isSymbolicLink() ? Buffer.from(fs.readlinkSync(abs), 'utf8') : fs.readFileSync(abs);
    entries.push({ path: e.path, bytes });
  }
  return summarise(entries);
}

/**
 * The engine fingerprint of a commit or tag (ref), from git's objects.
 * Throws when the ref can't be read.
 */
function refFingerprint(root, ref) {
  const r = git(root, ['ls-tree', '-r', '-z', `${ref}^{commit}`, '--', ...ENGINE_DIRS]);
  if (!r.ok) throw new Error(`could not read ${ref}: ${r.stderr || 'git ls-tree failed'}`);
  const listed = parseIndexLines(r.stdout, { tree: true });
  if (!listed.length) return summarise([]);
  const batch = git(root, ['cat-file', '--batch'], { encoding: 'buffer', input: `${listed.map((e) => e.oid).join('\n')}\n` });
  if (!batch.ok) throw new Error(`could not read the blobs of ${ref}: ${batch.stderr || 'git cat-file failed'}`);
  const buf = batch.stdout;
  const entries = [];
  let at = 0;
  for (const e of listed) {
    const nl = buf.indexOf(0x0a, at);
    const header = buf.subarray(at, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (header[0] !== e.oid || !Number.isSafeInteger(size)) throw new Error(`could not read the blob for ${e.path} at ${ref}`);
    entries.push({ path: e.path, bytes: buf.subarray(nl + 1, nl + 1 + size) });
    at = nl + 1 + size + 1;
  }
  return summarise(entries);
}

// What differs between two fingerprints' file maps (a: the reference, b: the
// worktree): [{ path, change: 'changed' | 'added' | 'deleted' }], sorted.
function diffFiles(a, b) {
  const out = [];
  for (const rel of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!(rel in b)) out.push({ path: rel, change: 'deleted' });
    else if (!(rel in a)) out.push({ path: rel, change: 'added' });
    else if (a[rel] !== b[rel]) out.push({ path: rel, change: 'changed' });
  }
  return out;
}

/**
 * Finds tag `version` for comparison: the local tag if there is one, else,
 * with an `upstream` remote, that one tag fetched from it (no other tags).
 * Returns { ref } or { error } (a plain reason).
 */
function resolveTag(root, version, { env } = {}) {
  const ref = `refs/tags/${version}`;
  if (git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env }).ok) return { ref };
  if (!git(root, ['remote', 'get-url', 'upstream'], { env }).ok) {
    return { error: `the tag ${version} is not here and there is no \`upstream\` remote` };
  }
  const f = git(root, ['fetch', '--quiet', '--no-tags', 'upstream', `+${ref}:${ref}`], { env });
  if (!f.ok || !git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env }).ok) {
    return { error: `could not fetch the tag ${version} from \`upstream\`${f.stderr ? ` (${f.stderr.split('\n')[0]})` : ''}` };
  }
  return { ref };
}

// ---- versions -----------------------------------------------------------

function parseVersion(v) {
  const m = VERSION_RE.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The highest vX.Y.Z among names (others ignored), or null.
function newestVersion(names) {
  const valid = [...new Set(names)].filter((n) => parseVersion(n));
  return valid.length ? valid.sort(compareVersions).at(-1) : null;
}

// ---- the record ---------------------------------------------------------

/**
 * Reads the record. Returns { record: { version, engine_sha256 } } or
 * { missing: true } or { error } when it is there but malformed.
 */
function readRecord(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, RECORD_REL), 'utf8');
  } catch {
    return { missing: true };
  }
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    return { error: `${RECORD_REL} is not valid YAML (${err.message.split('\n')[0]})` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: `${RECORD_REL} is not a YAML mapping` };
  const keys = Object.keys(doc).sort();
  if (keys.join(',') !== 'engine_sha256,version') return { error: `${RECORD_REL} must hold exactly version and engine_sha256` };
  if (!parseVersion(doc.version)) return { error: `${RECORD_REL}: version must look like vX.Y.Z` };
  if (typeof doc.engine_sha256 !== 'string' || !SHA_RE.test(doc.engine_sha256)) return { error: `${RECORD_REL}: engine_sha256 must be 64 lowercase hex characters` };
  return { record: { version: doc.version, engine_sha256: doc.engine_sha256 } };
}

function recordText({ version, engine_sha256: hex }) {
  return [
    '# The template release this fork is built from, and the fingerprint of its',
    '# engine (kit/ and profiles/_schema/). Written by',
    '# `npm run template:check -- --record vX.Y.Z`; checked by `npm run template:check`.',
    `version: ${version}`,
    `engine_sha256: ${hex}`,
    '',
  ].join('\n');
}

function writeRecord(root, record) {
  fs.mkdirSync(path.join(root, '.aplabs'), { recursive: true });
  fs.writeFileSync(path.join(root, RECORD_REL), recordText(record));
}

// ---- release checks -----------------------------------------------------

/**
 * The CHANGELOG.md entry for version: a `## vX.Y.Z` heading whose section
 * (up to the next `## `) has a "What changed" and a "What a fork must do"
 * heading. Returns a list of problems, empty when the entry is there.
 */
function changelogProblems(text, version) {
  if (text === null) return [`${CHANGELOG_REL} is missing`];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const heading = new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}(\\s|$)`);
  const starts = lines.map((l, i) => (heading.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!starts.length) return [`${CHANGELOG_REL} has no "## ${version}" entry`];
  if (starts.length > 1) return [`${CHANGELOG_REL} has more than one "## ${version}" entry`];
  const body = [];
  for (let i = starts[0] + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) body.push(lines[i]);
  const problems = [];
  for (const name of ['What changed', 'What a fork must do']) {
    if (!body.some((l) => new RegExp(`^###\\s+${name}\\s*$`, 'i').test(l))) {
      problems.push(`${CHANGELOG_REL}'s ${version} entry has no "### ${name}" section`);
    }
  }
  return problems;
}

/**
 * Judges the check runs on main's head (GitHub's check-runs API shape:
 * [{ name, status, conclusion }]). Every check must have completed with
 * success (or been skipped), and each required job must be there and have
 * succeeded. Returns a list of reasons, empty when the release may go.
 */
function checkRunProblems(runs, required = REQUIRED_JOBS) {
  if (!Array.isArray(runs) || !runs.length) return ['no checks are reported on main\'s head; every check must pass first'];
  const problems = [];
  const bad = runs.filter((c) => c.status !== 'completed' || !['success', 'skipped'].includes(c.conclusion));
  if (bad.length) {
    problems.push(`not every check on main's head passed: ${bad.map((c) => `${c.name} (${c.status === 'completed' ? c.conclusion || 'no result' : c.status || 'unknown'})`).join(', ')}`);
  }
  for (const name of required) {
    const runsOf = runs.filter((c) => c.name === name);
    if (!runsOf.length) problems.push(`the "${name}" check is missing on main's head`);
    else if (!runsOf.every((c) => c.status === 'completed' && c.conclusion === 'success')) {
      if (!bad.some((c) => c.name === name)) problems.push(`the "${name}" check did not succeed on main's head`);
    }
  }
  return problems;
}

// ---- updates (Story 11.6) ---------------------------------------------

/**
 * The CHANGELOG.md entry for version: { found, lines, forkMustDo }, where
 * lines is the entry's body and forkMustDo the non-blank lines under its
 * "### What a fork must do" heading.
 */
function changelogEntry(text, version) {
  if (text === null || text === undefined) return { found: false, lines: [], forkMustDo: [] };
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const heading = new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}(\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return { found: false, lines: [], forkMustDo: [] };
  const body = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) body.push(lines[i]);
  const forkMustDo = [];
  let inside = false;
  for (const l of body) {
    if (/^###\s/.test(l)) {
      inside = /^###\s+What a fork must do\s*$/i.test(l);
      continue;
    }
    if (inside && l.trim()) forkMustDo.push(l);
  }
  return { found: true, lines: body, forkMustDo };
}

// GitHub's anchor for a "## vX.Y.Z" heading (lowercase, dots dropped).
const changelogAnchor = (version) => version.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');

/**
 * The package rule (review B10): the template's package.json with the fork's
 * appended dependencies re-applied. recordedPkg: package.json at the fork's
 * recorded release; forkPkg: the fork's; templatePkg: the target release's.
 * Returns { pkg, appended, problems }. problems is non-empty, naming each,
 * when the fork changed package.json beyond appending dependencies, or
 * appended a dependency the template now ships itself.
 */
function packagePlan({ recordedPkg, forkPkg, templatePkg }) {
  const { appended, problems } = packageDelta(recordedPkg, forkPkg);
  const out = problems.map((p) => `the fork changed package.json beyond appending dependencies: ${p}`);
  const ships = (name) => DEP_SECTIONS.some((s) => templatePkg && templatePkg[s] && Object.hasOwn(templatePkg[s], name));
  for (const a of appended) {
    if (ships(a.name)) out.push(`the fork appended ${a.name} (${a.section}), which the template now ships itself: remove the fork's entry on main first`);
  }
  if (out.length) return { pkg: null, appended, problems: out };
  const pkg = JSON.parse(JSON.stringify(templatePkg));
  for (const a of appended) {
    const section = { ...(pkg[a.section] || {}), [a.name]: a.spec };
    // npm keeps dependency sections sorted by name.
    pkg[a.section] = Object.fromEntries(Object.entries(section).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  }
  return { pkg, appended, problems: [] };
}

const bullets = (items, none) => (items.length ? items.map((i) => `- ${i}`).join('\n') : `- ${none}`);
const code = (p) => `\`${p}\``;

/**
 * The body of a template update's PR in the fork. It opens with "What this
 * does", names the version and its changelog entry, copies the entry's
 * "What a fork must do" lines, and lists every conflict resolution, every
 * path handled after the merge, the package files and the profile diff.
 */
function updatePrBody({
  version, from, branch, changelog, conflicts = [], removed = [], reset = [], deletedRoots = [],
  packageFiles = [], appended = [], lockRegenerated = false, profileDiff = '', migrations = [],
}) {
  const lines = [
    `**What this does:** Takes the template's ${version} release into this fork (from ${from}) with a merge commit, keeping the fork's own files as they are.`,
    '',
    'Kind: infra',
    '',
    `Opened by \`npm run template:update -- ${version}\` from the branch ${code(branch)}. The engine (\`kit/\`, \`profiles/_schema/\`) is now exactly ${version}'s, and \`.aplabs/template-version\` records it. \`npm run check && npm test\` passed on this branch.`,
    '',
    '## The release',
    '',
    changelog.found
      ? `Changelog: [\`CHANGELOG.md\`, ${version}](CHANGELOG.md#${changelogAnchor(version)}).`
      : `Changelog: \`CHANGELOG.md\` has no ${version} entry.`,
    '',
    '### What a fork must do',
    '',
    changelog.forkMustDo.length ? changelog.forkMustDo.join('\n') : '- (the entry lists nothing)',
    '',
    '## Conflicts resolved',
    '',
    bullets(conflicts.map((c) => `${code(c.path)}: ${c.how}`), 'none'),
    '',
    '## Paths handled after the merge',
    '',
    `Deleted on purpose by this fork since ${from} (derived from what it deleted): ${deletedRoots.length ? deletedRoots.map(code).join(', ') : 'none'}.`,
    '',
    'Removed again (the fork deleted them on purpose):',
    '',
    bullets(removed.map(code), 'none'),
    '',
    'Kept as on the fork\'s main (fork-owned):',
    '',
    bullets(reset.map(code), 'none'),
    '',
    '## Package files',
    '',
    packageFiles.length
      ? bullets([
        `\`package.json\`: the template's, with the fork's appended dependencies re-applied (${appended.length ? appended.map((a) => `${a.name} ${a.spec}`).join(', ') : 'none'})`,
        `\`package-lock.json\`: ${lockRegenerated ? 'the template\'s, regenerated with `npm install --package-lock-only --ignore-scripts`' : 'the template\'s'}`,
      ], 'none')
      : '- unchanged by this release',
    '',
    '## Profile',
    '',
  ];
  if (profileDiff.trim()) {
    lines.push(`Migrated \`.aplabs/profile.yml\` (steps from schema_version ${migrations.join(', ')}). Review the diff:`, '', '```diff', profileDiff.trimEnd(), '```');
  } else {
    lines.push('- unchanged (no schema version change)');
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  PROFILE_REL,
  RECORD_REL,
  CHANGELOG_REL,
  REQUIRED_JOBS,
  NO_RECORD,
  git,
  repoRoot,
  isFork,
  frame,
  worktreeFingerprint,
  refFingerprint,
  diffFiles,
  resolveTag,
  parseVersion,
  compareVersions,
  newestVersion,
  readRecord,
  recordText,
  writeRecord,
  changelogProblems,
  checkRunProblems,
  changelogEntry,
  changelogAnchor,
  packagePlan,
  updatePrBody,
};
