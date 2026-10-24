'use strict';

// The build ledger (Story 5.1): the pure half. Parses and validates
// docs/ledger.md and decides whether a PR's changes satisfy the ledger rule.
// No I/O here; scripts/ledger-check.js runs git and reads the file.
//
// The rule: a PR passes if it touches docs/ledger.md, or if it is exempt by
// the review CLI's own rules (exemptionFor in kit/lib/review), limited to
// docs-only and verified reverts. Small config-only changes skip review but
// still need a ledger row.

const { exemptionFor } = require('../review');

const LEDGER_PATH = 'docs/ledger.md';
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

// Finds the table whose header row is exactly `header` and returns its body
// rows with their 1-based line numbers, or null when there is no such table.
function readTable(lines, header) {
  const start = lines.findIndex((l) => l.trim().startsWith('|') && sameHeader(cells(l), header));
  if (start === -1) return null;
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    rows.push({ line: i + 1, cells: cells(lines[i]) });
  }
  return rows;
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
    if (c.length !== BUILDS_HEADER.length) {
      errors.push(`line ${line}: a Builds row needs ${BUILDS_HEADER.length} cells, found ${c.length}`);
      continue;
    }
    const [pr, date, story, kind, tier, summary, depCell] = c;
    if (!PR_CELL.test(pr)) errors.push(`line ${line}: PR "${pr}" must be #<number> or pending`);
    else if (pr !== 'pending' && builds.some((b) => b.pr === pr)) errors.push(`line ${line}: PR ${pr} has two rows`);
    const refs = depCell === NONE || depCell === '' ? [] : depCell.split(',').map((s) => s.trim());
    for (const ref of refs) {
      if (!depIds.has(ref)) errors.push(`line ${line}: PR ${pr} names ${ref}, which has no DEP row`);
    }
    builds.push({ pr, date, story, kind, tier, summary, deps: refs });
  }

  return { builds, deps, errors };
}

// Whether a PR satisfies the ledger rule. changes come from parseNumstat on
// base...HEAD; commits carry verifiedRevert as in exemptionFor (the CI script
// cannot verify reverts cheaply and passes none, so only docs-only is exempt
// there). Returns { ok, reason, message }.
function checkPr({ changes, commits = [] }) {
  if (changes.some((c) => c.file === LEDGER_PATH)) {
    return { ok: true, reason: 'ledger updated', message: `${LEDGER_PATH} is updated.` };
  }
  const exempt = exemptionFor({ commits, changes });
  if (LEDGER_EXEMPTIONS.has(exempt)) {
    return { ok: true, reason: exempt, message: `Exempt from the ledger rule (${exempt}).` };
  }
  return {
    ok: false,
    reason: 'no ledger row',
    message: `This PR does not touch ${LEDGER_PATH}. Add a row for it to the Builds table in ${LEDGER_PATH} (and a DEP row for anything it defers).`,
  };
}

module.exports = {
  LEDGER_PATH,
  BUILDS_HEADER,
  DEPS_HEADER,
  DEP_STATUSES,
  cells,
  parseLedger,
  checkPr,
};
