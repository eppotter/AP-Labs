'use strict';

// The build ledger (Story 5.1; plan ledger-rows): the pure half. Parses and
// validates docs/ledger.md and the build files under docs/ledger/builds/, and
// decides whether a PR's changes satisfy the ledger rule. No I/O here;
// scripts/ledger-check.js runs git and reads the files.
//
// Where rows live (plan ledger-rows): each build adds its one row in its own
// file, docs/ledger/builds/<slug>.md (slug: the branch name lowercased, `/`
// as `-`), so two open PRs never edit the same lines. docs/ledger.md keeps
// its intro, the older rows and the DEP table.
//
//   parseLedger(text)       docs/ledger.md alone
//   parseLedgerSet({ ledger, builds })
//                           docs/ledger.md and every build file together, with
//                           errors as `file:line: problem`
//   checkPr(...)            the per-PR rule
//
// The rule: a PR passes if it adds its own build file or touches
// docs/ledger.md, or if it is exempt by the review CLI's own rules
// (exemptionFor in kit/lib/review), limited to docs-only and verified
// reverts. Small config-only changes skip review but still need a ledger row.
// Whatever else it does, it fails if it deletes a build file, adds or edits
// another branch's, reuses a branch name whose build file is already on the
// base, adds a row in both places, or adds two pending rows.

const { exemptionFor } = require('../review');

const LEDGER_PATH = 'docs/ledger.md';
const BUILDS_DIR = 'docs/ledger/builds';
const BUILD_FILE_NAME = /^[a-z0-9][a-z0-9.-]*\.md$/;
const SEPARATOR = /^\|(\s*:?-+:?\s*\|)+$/;
const LEDGER_EXEMPTIONS = new Set(['docs only', 'revert']);

const BUILDS_HEADER = ['PR', 'Date', 'Story', 'Kind', 'Tier', 'Summary', 'DEPs'];
const DEPS_HEADER = ['DEP', 'Opened', 'Owner', 'Status', 'Blocks', 'What', 'Source'];
const DEP_ID = /^DEP-\d{3,}$/;
const DEP_STATUSES = ['open', 'closed'];
const PR_CELL = /^(#\d+|pending)$/;
const NONE = '—';

// One markdown table row -> trimmed cells. A pipe inside a cell is written \|.
function cells(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

const sameHeader = (row, header) => row.length === header.length && row.every((c, i) => c === header[i]);

// 1-based line numbers of every table header row that is exactly `header`.
const headerLines = (lines, header) => lines
  .map((l, i) => (l.trim().startsWith('|') && sameHeader(cells(l), header) ? i + 1 : 0))
  .filter(Boolean);

// Finds the first table whose header row is exactly `header` and returns its
// body rows with their 1-based line numbers, or null when there is no such table.
function readTable(lines, header) {
  const start = lines.findIndex((l) => l.trim().startsWith('|') && sameHeader(cells(l), header));
  if (start === -1) return null;
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    rows.push({ line: i + 1, cells: cells(lines[i]) });
  }
  return rows;
}

// One Builds row's cells -> the row, or null when it has the wrong number of
// cells. Each problem goes into errors as `line N: ...`.
function buildRow(c, line, errors) {
  if (c.length !== BUILDS_HEADER.length) {
    errors.push(`line ${line}: a Builds row needs ${BUILDS_HEADER.length} cells, found ${c.length}`);
    return null;
  }
  const [pr, date, story, kind, tier, summary, depCell] = c;
  if (!PR_CELL.test(pr)) errors.push(`line ${line}: PR "${pr}" must be #<number> or pending`);
  const refs = depCell === NONE || depCell === '' ? [] : depCell.split(',').map((s) => s.trim());
  return { pr, date, story, kind, tier, summary, deps: refs };
}

// docs/ledger.md text -> { builds, deps, errors }. errors is empty when the
// file is well formed.
function parseLedger(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const errors = [];
  const builds = [];
  const deps = [];

  const buildRows = readTable(lines, BUILDS_HEADER);
  const depRows = readTable(lines, DEPS_HEADER);
  if (!buildRows) errors.push(`missing the Builds table (header: | ${BUILDS_HEADER.join(' | ')} |)`);
  if (!depRows) errors.push(`missing the Deferrals table (header: | ${DEPS_HEADER.join(' | ')} |)`);
  // A second table with the same header would be skipped by readTable, so its
  // rows would escape every check below.
  for (const [name, header] of [['Builds', BUILDS_HEADER], ['Deferrals', DEPS_HEADER]]) {
    const at = headerLines(lines, header);
    if (at.length > 1) errors.push(`line ${at.slice(1).join(', ')}: a second ${name} table; keep one ${name} table (the first is at line ${at[0]})`);
  }

  for (const { line, cells: c } of depRows || []) {
    if (c.length !== DEPS_HEADER.length) {
      errors.push(`line ${line}: a DEP row needs ${DEPS_HEADER.length} cells, found ${c.length}`);
      continue;
    }
    const [id, opened, owner, status, blocks, what, source] = c;
    if (!DEP_ID.test(id)) errors.push(`line ${line}: "${id}" is not a DEP id (DEP-001, DEP-002, ...)`);
    else if (deps.some((d) => d.id === id)) errors.push(`line ${line}: ${id} is used twice`);
    if (!DEP_STATUSES.includes(status)) errors.push(`line ${line}: ${id} has status "${status}"; use ${DEP_STATUSES.join(' or ')}`);
    if (!owner) errors.push(`line ${line}: ${id} has no owner`);
    deps.push({ id, opened, owner, status, blocks, what, source });
  }

  const depIds = new Set(deps.map((d) => d.id));
  for (const { line, cells: c } of buildRows || []) {
    const row = buildRow(c, line, errors);
    if (!row) continue;
    if (PR_CELL.test(row.pr) && row.pr !== 'pending' && builds.some((b) => b.pr === row.pr)) errors.push(`line ${line}: PR ${row.pr} has two rows`);
    for (const ref of row.deps) {
      if (!depIds.has(ref)) errors.push(`line ${line}: PR ${row.pr} names ${ref}, which has no DEP row`);
    }
    builds.push(row);
  }

  return { builds, deps, errors };
}

// The build file's name for a branch: lowercased, every `/` as `-`.
function buildFileName(branch) {
  return `${String(branch).toLowerCase().replace(/\//g, '-')}.md`;
}

const buildFilePath = (branch) => `${BUILDS_DIR}/${buildFileName(branch)}`;

// One build file's text -> { row, errors }. A build file holds the Builds
// header, its separator and exactly one row, and nothing else (blank lines
// aside): no DEP table, no other table, no text. errors are `line N: ...`;
// row (with its line) is null unless the file holds exactly one row.
function parseBuildFile(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const errors = [];
  // Runs of table lines; any other non-blank line is an error.
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (!t.startsWith('|')) {
      errors.push(`line ${i + 1}: text outside the table; a build file holds only the Builds header and one row`);
      continue;
    }
    const prev = tables[tables.length - 1];
    if (prev && prev.end === i) prev.end = i + 1;
    else tables.push({ start: i, end: i + 1 });
  }
  let builds = null;
  for (const tbl of tables) {
    const head = cells(lines[tbl.start]);
    const at = tbl.start + 1;
    if (sameHeader(head, DEPS_HEADER)) errors.push(`line ${at}: a DEP table; DEP rows go in ${LEDGER_PATH}, never in a build file`);
    else if (!sameHeader(head, BUILDS_HEADER)) errors.push(`line ${at}: another table; a build file holds only the Builds table`);
    else if (builds) errors.push(`line ${at}: a second Builds table; a build file holds one (the first is at line ${builds.start + 1})`);
    else builds = tbl;
  }
  if (!builds) {
    errors.push(`line 1: missing the Builds table (header: | ${BUILDS_HEADER.join(' | ')} |)`);
    return { row: null, errors };
  }
  if (builds.end - builds.start < 2 || !SEPARATOR.test(lines[builds.start + 1].trim())) {
    errors.push(`line ${builds.start + 2}: the Builds header needs its separator row (|---|---|...)`);
    return { row: null, errors };
  }
  const rows = [];
  for (let i = builds.start + 2; i < builds.end; i++) rows.push({ line: i + 1, cells: cells(lines[i]) });
  if (!rows.length) {
    errors.push(`line ${builds.start + 1}: no row; a build file holds exactly one Builds row`);
    return { row: null, errors };
  }
  for (const extra of rows.slice(1)) {
    errors.push(`line ${extra.line}: a second row; a build file holds exactly one Builds row (one file per PR)`);
  }
  const row = buildRow(rows[0].cells, rows[0].line, errors);
  return { row: row && rows.length === 1 ? { ...row, line: rows[0].line } : null, errors };
}

// `line 15, 19: problem` (parseLedger's form) -> `file:15, 19: problem`;
// an error with no line -> `file: problem`.
function located(file, error) {
  const m = /^line ([\d, ]+): ([^]*)$/.exec(error);
  return m ? `${file}:${m[1]}: ${m[2]}` : `${file}: ${error}`;
}

/**
 * docs/ledger.md and every build file, checked together. ledger: the text of
 * docs/ledger.md (null when missing); builds: [{ name, text }], one per entry
 * in docs/ledger/builds/ (none when the folder is missing). Returns
 * { builds, deps, errors }: builds every row with its file and line, deps the
 * DEP rows, errors `file:line: problem`. Beyond parseLedger's rules it
 * refuses a PR with two rows anywhere, a build file that is not one row and
 * nothing else, a bad build file name, and a DEP named in a build row with no
 * DEP row.
 */
function parseLedgerSet({ ledger, builds = [] } = {}) {
  const errors = [];
  const rows = [];
  let deps = [];
  if (ledger === null || ledger === undefined) {
    errors.push(`${LEDGER_PATH}: missing`);
  } else {
    const text = String(ledger);
    const parsed = parseLedger(text);
    errors.push(...parsed.errors.map((e) => located(LEDGER_PATH, e)));
    deps = parsed.deps;
    // parseLedger keeps the rows with the right number of cells, in order;
    // pair each with its line so a clash names it.
    const shaped = (readTable(text.replace(/\r\n/g, '\n').split('\n'), BUILDS_HEADER) || [])
      .filter((r) => r.cells.length === BUILDS_HEADER.length);
    parsed.builds.forEach((b, i) => rows.push({ ...b, line: shaped[i].line, file: LEDGER_PATH }));
  }

  const depIds = new Set(deps.map((d) => d.id));
  const seen = new Map(); // PR -> `file:line` of its first row
  for (const r of rows) if (PR_CELL.test(r.pr) && r.pr !== 'pending' && !seen.has(r.pr)) seen.set(r.pr, `${r.file}:${r.line}`);

  const sorted = [...builds].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { name, text } of sorted) {
    const file = `${BUILDS_DIR}/${name}`;
    if (!BUILD_FILE_NAME.test(name)) {
      errors.push(`${file}: a bad file name; use the branch name lowercased with / as - (${BUILD_FILE_NAME})`);
    }
    const { row, errors: fileErrors } = parseBuildFile(text ?? '');
    errors.push(...fileErrors.map((e) => located(file, e)));
    if (!row) continue;
    const at = `${file}:${row.line}`;
    if (PR_CELL.test(row.pr) && row.pr !== 'pending') {
      if (seen.has(row.pr)) errors.push(`${at}: PR ${row.pr} has two rows (the other is at ${seen.get(row.pr)})`);
      else seen.set(row.pr, at);
    }
    for (const ref of row.deps) {
      if (!depIds.has(ref)) errors.push(`${at}: PR ${row.pr} names ${ref}, which has no DEP row in ${LEDGER_PATH}`);
    }
    rows.push({ ...row, file });
  }
  return { builds: rows, deps, errors };
}

const isBuildFile = (file) => file.startsWith(`${BUILDS_DIR}/`);
const pendingRows = (rows) => rows.filter((r) => r.pr === 'pending').length;

/**
 * Whether a PR satisfies the ledger rule. Returns { ok, reason, message }.
 *   changes     from parseNumstat on base...HEAD (the exemption rules read it)
 *   commits     carry verifiedRevert as in exemptionFor (the CI script cannot
 *               verify reverts cheaply and passes none, so only docs-only is
 *               exempt there)
 *   files       [{ status, file }] from a --name-status diff of base...HEAD
 *               (default: every change as an edit, M)
 *   branch      the PR's head branch, which names its own build file
 *   ledgerRows  { before, after }: docs/ledger.md's Builds rows at the merge
 *               base and now (parseLedger().builds). When given, a PR that
 *               adds a row there and its own build file fails, and so does
 *               one that adds two pending rows.
 */
function checkPr({ changes, commits = [], files, branch = null, ledgerRows = null }) {
  const statuses = files || changes.map((c) => ({ status: 'M', file: c.file }));
  const own = branch ? buildFilePath(branch) : null;
  const ownHint = own || `${BUILDS_DIR}/<branch>.md`;
  const fail = (reason, message) => ({ ok: false, reason, message });

  const buildChanges = statuses.filter((f) => isBuildFile(f.file));
  const deleted = buildChanges.filter((f) => f.status === 'D');
  if (deleted.length) {
    return fail('deletes a build file', `This PR deletes ${deleted.map((f) => f.file).join(', ')}. A build file is another PR's row and is never deleted.`);
  }
  const others = buildChanges.filter((f) => f.file !== own);
  if (others.length && !own) {
    return fail('unknown branch', `This PR changes ${others.map((f) => f.file).join(', ')}, but its branch is unknown, so its own build file can't be told apart (set GITHUB_HEAD_REF or pass --head <branch>).`);
  }
  if (others.length) {
    return fail('another build file', `This PR adds or edits ${others.map((f) => f.file).join(', ')}, which is not this branch's build file. Add or edit only ${own}, and leave other PRs' rows as they are.`);
  }
  const mine = buildChanges.find((f) => f.file === own);
  if (mine && mine.status !== 'A') {
    return fail('branch name reused', `${own} already exists at the base: branch name reused; add a suffix (for example ${branch}-2) and put the row in that branch's file.`);
  }
  if (ledgerRows) {
    const before = ledgerRows.before || [];
    const after = ledgerRows.after || [];
    if (mine && after.length > before.length) {
      return fail('row in both places', `This PR adds a row to ${LEDGER_PATH} and its own build file ${own}. A PR has one row: keep it in ${own}.`);
    }
    const added = pendingRows(after) - pendingRows(before);
    if (added > 1) {
      return fail('two pending rows', `This PR adds ${added} pending rows to ${LEDGER_PATH}. One branch adds one row, in ${ownHint}.`);
    }
  }

  if (mine) return { ok: true, reason: 'build file added', message: `${own} is added.` };
  if (changes.some((c) => c.file === LEDGER_PATH)) {
    return { ok: true, reason: 'ledger updated', message: `${LEDGER_PATH} is updated.` };
  }
  const exempt = exemptionFor({ commits, changes });
  if (LEDGER_EXEMPTIONS.has(exempt)) {
    return { ok: true, reason: exempt, message: `Exempt from the ledger rule (${exempt}).` };
  }
  return fail('no ledger row', `This PR adds no ledger row. Add its one Builds row in its own build file, ${ownHint} (see docs/ledger/README.md), and a DEP row in ${LEDGER_PATH} for anything it defers.`);
}

module.exports = {
  LEDGER_PATH,
  BUILDS_DIR,
  BUILD_FILE_NAME,
  BUILDS_HEADER,
  DEPS_HEADER,
  DEP_STATUSES,
  cells,
  parseLedger,
  parseBuildFile,
  parseLedgerSet,
  buildFileName,
  buildFilePath,
  checkPr,
};
