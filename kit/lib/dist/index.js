'use strict';

// The distribution tree (plan template-dist, Story D.1): what a client fork
// receives. Clients never clone the source repo; they clone a distribution
// repo whose commits are the release's files minus EXCLUDED (the build files
// in docs/ledger/builds/ among them), with the ledger's rows emptied. This module holds the pure half, shared by the
// tripwire test and the publish command (kit/release/publish.js, Story D.2):
//
//   EXCLUDED          the internal paths that never ship
//   isExcluded        true when a repo path is one of them, or under one
//   assertExclusionsSafe
//                     refuses an exclusion list that would drop engine files
//                     (the engine fingerprint must be the same in the dist tree)
//   transformLedger   the ledger as shipped: its text, headings and table
//                     header rows, and no rows
//   shippedContent    a blob as shipped (the ledger transformed, all else as is)
//   loadDenyList      the reference-client deny list, failing closed
//   referencePatterns the deny list, or null in a distribution copy
//   scanDist          checks every shipped path and text blob against it
//   formatHit         one hit as `file:line`, never the matched text
//
// and the git half, shared by `template:publish -- vX.Y.Z` and
// `template:publish -- --check` (Story D.2):
//
//   buildDistTree     a commit's tree as shipped, written as a git tree object
//                     (refusing gitlinks, symlinks into excluded paths and any
//                     deny-list hit)
//   engineProblem     null when two commits have the same engine fingerprint
//
// The deny list lives in docs/reference/, which is itself excluded, so the
// names it lists never ship. A hit reports the file, the line and the
// pattern's number, never the matched text, so a log or CI output never
// repeats a name either.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ENGINE_DIRS } = require('../../runtime/paths');

// docs/ledger/builds: the build files (plan ledger-rows), one row each, named
// after their branch. Like the ledger's rows, none ships, and neither do their
// names; docs/ledger/README.md (what goes in builds/) does.
const EXCLUDED = Object.freeze(['docs/reference', 'docs/planning', 'docs/PLAN-v1.md', 'docs/HANDOFF.md', 'docs/ledger/builds']);
const REFERENCE_DIR = 'docs/reference';
const DENY_FILE = 'docs/reference/dist-deny.txt';
const LEDGER_PATH = 'docs/ledger.md';

const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);

/** True when a repo-relative POSIX path is excluded from the distribution tree. */
function isExcluded(rel, excluded = EXCLUDED) {
  return excluded.some((e) => under(String(rel), e));
}

/**
 * Throws, naming every problem, when an exclusion would drop an engine path:
 * an exclusion under an engine dir, or an engine dir under an exclusion.
 */
function assertExclusionsSafe(excluded = EXCLUDED, engineDirs = ENGINE_DIRS) {
  const problems = [];
  for (const e of excluded) {
    for (const d of engineDirs) {
      if (under(e, d) || under(d, e)) problems.push(`"${e}" overlaps the engine path "${d}"`);
    }
  }
  if (problems.length) throw new Error(`dist: an excluded path would drop engine files: ${problems.join('; ')}`);
}

/**
 * The ledger as shipped: every line kept except the body rows of each table.
 * A table is a run of lines starting with `|`; its first two lines (the header
 * and the separator) stay.
 */
function transformLedger(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inTable = 0; // lines seen in the current table
  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      inTable += 1;
      if (inTable <= 2) out.push(line);
    } else {
      inTable = 0;
      out.push(line);
    }
  }
  return out.join('\n');
}

/** A blob as shipped: the ledger transformed, every other file unchanged. */
function shippedContent(rel, content) {
  if (rel !== LEDGER_PATH) return content;
  return Buffer.from(transformLedger(Buffer.isBuffer(content) ? content.toString('utf8') : content), 'utf8');
}

// Reads a repo-relative file from a root directory, or through a reader
// function (rel -> string | Buffer | null), so D.2 can read from a git tree.
function readFrom(treeOrRoot, rel) {
  if (typeof treeOrRoot === 'function') return treeOrRoot(rel);
  if (typeof treeOrRoot === 'string') {
    const file = path.join(treeOrRoot, rel);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }
  throw new Error('dist: loadDenyList needs a root directory or a reader function');
}

/**
 * The deny list: one case-insensitive regex per line; blank lines and lines
 * starting with `#` are skipped. Returns [{ n, line, re }] where n is the
 * pattern's number (1-based) and line its line in the file. Fails closed: a
 * missing file, an empty list or an invalid regex throws. The error names the
 * line, never the pattern.
 */
function loadDenyList(treeOrRoot) {
  const raw = readFrom(treeOrRoot, DENY_FILE);
  if (raw === null || raw === undefined) throw new Error(`dist: the deny list ${DENY_FILE} is missing; refusing to scan without it`);
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const patterns = [];
  const bad = [];
  text.replace(/\r\n/g, '\n').split('\n').forEach((l, i) => {
    const s = l.trim();
    if (!s || s.startsWith('#')) return;
    try {
      patterns.push({ n: patterns.length + 1, line: i + 1, re: new RegExp(s, 'i') });
    } catch {
      bad.push(i + 1);
    }
  });
  if (bad.length) throw new Error(`dist: ${DENY_FILE} has an invalid regex on line ${bad.join(', ')}`);
  if (!patterns.length) throw new Error(`dist: ${DENY_FILE} has no patterns; refusing to scan with an empty list`);
  return patterns;
}

/**
 * The deny list for a checkout at `root`, or null when `docs/reference/` is
 * absent (a distribution copy, where there is nothing to check against).
 * `docs/reference/` without the deny file throws (fail closed).
 */
function referencePatterns(root) {
  if (!fs.existsSync(path.join(root, REFERENCE_DIR))) return null;
  return loadDenyList(root);
}

/**
 * Scans shipped files against the deny list. `files` is [{ path, content }]
 * with content a Buffer or string. Every path is checked; every text blob is
 * checked line by line. A blob with a NUL byte is listed as binary (its path
 * is still checked). Returns { hits: [{ file, line, pattern }], binary: [path] }
 * where line is 0 for a hit in the path itself.
 */
function scanDist(files, patterns) {
  if (!Array.isArray(patterns) || !patterns.length) throw new Error('dist: scanDist needs a loaded deny list');
  const hits = [];
  const binary = [];
  for (const f of files) {
    for (const p of patterns) if (p.re.test(f.path)) hits.push({ file: f.path, line: 0, pattern: p.n });
    const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content ?? ''), 'utf8');
    if (buf.includes(0)) { binary.push(f.path); continue; }
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((l, i) => {
      for (const p of patterns) if (p.re.test(l)) hits.push({ file: f.path, line: i + 1, pattern: p.n });
    });
  }
  return { hits, binary };
}

/** One hit as text: `file:line: deny pattern N` (`file (path): ...` for a path hit). */
function formatHit(h) {
  return h.line ? `${h.file}:${h.line}: deny pattern ${h.pattern}` : `${h.file} (path): deny pattern ${h.pattern}`;
}

// ---- the git half (Story D.2) -------------------------------------------

// Lazy, so the pure half above loads without the template helpers.
const template = () => require('../template');

const GITLINK = '160000';
const SYMLINK = '120000';

// Splits `git ls-tree -r -z --full-tree` output into { mode, type, oid, path }.
function parseTree(out) {
  return out.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    return { mode, type, oid, path: line.slice(tab + 1) };
  });
}

// The blobs for oids, read with one `git cat-file --batch`: Map oid -> Buffer.
function readBlobs(root, oids, env) {
  const unique = [...new Set(oids)];
  const blobs = new Map();
  if (!unique.length) return blobs;
  const r = template().git(root, ['cat-file', '--batch'], { encoding: 'buffer', input: `${unique.join('\n')}\n`, env });
  if (!r.ok) throw new Error(`dist: could not read the blobs: ${r.stderr || 'git cat-file failed'}`);
  const buf = r.stdout;
  let at = 0;
  for (const oid of unique) {
    const nl = buf.indexOf(0x0a, at);
    const header = buf.subarray(at, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (header[0] !== oid || header[1] !== 'blob' || !Number.isSafeInteger(size)) throw new Error(`dist: could not read the blob ${oid}`);
    blobs.set(oid, buf.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return blobs;
}

// Where a symlink at rel pointing at target resolves, repo-relative (POSIX).
// An absolute target, or one that leaves the repo, resolves outside it ('').
function symlinkTarget(rel, target) {
  if (path.posix.isAbsolute(target)) return '';
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target)).replace(/\/$/, '');
  return resolved === '..' || resolved.startsWith('../') ? '' : resolved;
}

/**
 * The distribution tree of a commit (ref) in the repo at root: its tree with
 * every excluded path removed and the ledger transformed (transformLedger),
 * written into the repo's objects through a temporary index (the repo's own
 * index is never touched). The deny list is read from that commit's tree, not
 * the worktree. It refuses, naming every problem: an unsafe exclusion list, a
 * gitlink, a symlink whose target resolves into an excluded path, a deny list
 * that does not load, and any deny hit in a shipped path or text blob.
 *
 * Returns { tree, source, files, binary, mentions, problems }: tree is the
 * written tree's id (null when there are problems); source the commit's id;
 * files the number of shipped entries; binary the shipped blobs with a NUL
 * byte (listed, N7); mentions the shipped text files that name an excluded
 * path (a warning only, N8).
 */
function buildDistTree(root, ref, { env, excluded = EXCLUDED } = {}) {
  const { git } = template();
  const result = { tree: null, source: null, files: 0, binary: [], mentions: [], problems: [] };
  const fail = (p) => {
    result.problems.push(p);
    return result;
  };
  try {
    assertExclusionsSafe(excluded);
  } catch (e) {
    return fail(e.message);
  }
  const commit = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env });
  if (!commit.ok) return fail(`dist: could not read ${ref}`);
  const source = commit.stdout.trim();
  result.source = source;

  let patterns = null;
  try {
    patterns = loadDenyList((rel) => {
      const r = git(root, ['cat-file', 'blob', `${source}:${rel}`], { encoding: 'buffer', env });
      return r.ok ? r.stdout : null;
    });
  } catch (e) {
    result.problems.push(`${e.message} (read from ${ref}'s tree)`);
  }

  const listed = git(root, ['ls-tree', '-r', '-z', '--full-tree', source], { env });
  if (!listed.ok) return fail(`dist: could not list ${ref}'s tree: ${listed.stderr || 'git ls-tree failed'}`);
  const shipped = [];
  for (const e of parseTree(listed.stdout)) {
    if (e.mode === GITLINK) {
      result.problems.push(`dist: ${e.path} is a gitlink (a submodule); the distribution tree refuses gitlinks`);
      continue;
    }
    if (!isExcluded(e.path, excluded)) shipped.push(e);
  }
  let blobs;
  try {
    blobs = readBlobs(root, shipped.map((e) => e.oid), env);
  } catch (e) {
    return fail(e.message);
  }
  const files = [];
  for (const e of shipped) {
    const bytes = blobs.get(e.oid);
    if (e.mode === SYMLINK) {
      const to = symlinkTarget(e.path, bytes.toString('utf8'));
      if (to && isExcluded(to, excluded)) result.problems.push(`dist: ${e.path} is a symlink into the excluded path ${to}`);
    }
    files.push({ path: e.path, mode: e.mode, oid: e.oid, content: e.mode === SYMLINK ? bytes : shippedContent(e.path, bytes) });
  }
  if (patterns) {
    const { hits, binary } = scanDist(files, patterns);
    result.binary = binary;
    for (const h of hits) result.problems.push(`dist: deny-list hit: ${formatHit(h)}`);
  }
  for (const f of files) {
    if (f.mode === SYMLINK || f.content.includes(0)) continue;
    const text = f.content.toString('utf8');
    if (excluded.some((x) => text.includes(x))) result.mentions.push(f.path);
  }
  result.files = files.length;
  if (result.problems.length) return result;

  // The transformed ledger as a new blob; every other entry keeps its id.
  const ledger = files.find((f) => f.path === LEDGER_PATH);
  if (ledger) {
    const h = git(root, ['hash-object', '-w', '--stdin'], { input: ledger.content, env });
    if (!h.ok) return fail(`dist: could not write the ledger blob: ${h.stderr}`);
    ledger.oid = h.stdout.trim();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-dist-index-'));
  try {
    const idxEnv = { ...(env || process.env), GIT_INDEX_FILE: path.join(dir, 'index') };
    const info = files.map((f) => `${f.mode} ${f.oid}\t${f.path}\0`).join('');
    const add = git(root, ['update-index', '-z', '--index-info'], { input: info, env: idxEnv });
    if (!add.ok) return fail(`dist: could not fill the temporary index: ${add.stderr}`);
    const tree = git(root, ['write-tree'], { env: idxEnv });
    if (!tree.ok) return fail(`dist: could not write the tree: ${tree.stderr}`);
    result.tree = tree.stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

/**
 * null when commit a (in rootA) and commit b (in rootB, default rootA) have
 * the same engine fingerprint (kit/lib/template refFingerprint); otherwise
 * the problem, naming each differing file.
 */
function engineProblem(rootA, a, b, rootB = rootA) {
  const { refFingerprint, diffFiles } = template();
  let x;
  let y;
  try {
    x = refFingerprint(rootA, a);
    y = refFingerprint(rootB, b);
  } catch (e) {
    return `dist: ${e.message}`;
  }
  if (x.sha256 === y.sha256) return null;
  const diffs = diffFiles(x.files, y.files).map((d) => `${d.path} (${d.change})`);
  return `dist: the distribution tree's engine fingerprint is not the source's: ${diffs.join(', ') || 'the engine differs'}`;
}

module.exports = {
  EXCLUDED,
  REFERENCE_DIR,
  DENY_FILE,
  LEDGER_PATH,
  isExcluded,
  assertExclusionsSafe,
  transformLedger,
  shippedContent,
  loadDenyList,
  referencePatterns,
  scanDist,
  formatHit,
  symlinkTarget,
  buildDistTree,
  engineProblem,
};
