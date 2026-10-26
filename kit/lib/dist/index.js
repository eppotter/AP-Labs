'use strict';

// The distribution tree (plan template-dist, Story D.1): what a client fork
// receives. Clients never clone the source repo; they clone a distribution
// repo whose commits are the release's files minus EXCLUDED, with the
// ledger's rows emptied. This module holds the pure half, shared by the
// tripwire test and (Story D.2) the publish command:
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
// The deny list lives in docs/reference/, which is itself excluded, so the
// names it lists never ship. A hit reports the file, the line and the
// pattern's number, never the matched text, so a log or CI output never
// repeats a name either.

const fs = require('node:fs');
const path = require('node:path');
const { ENGINE_DIRS } = require('../../runtime/paths');

const EXCLUDED = Object.freeze(['docs/reference', 'docs/planning', 'docs/PLAN-v1.md', 'docs/HANDOFF.md']);
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
};
