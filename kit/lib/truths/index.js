'use strict';

// Known truths (Story 4.2): the pure half. Every data fact the Onboarder
// records in .aplabs/context/data.md carries a check against the client's own
// number, so SQLsmith never trusts an unchecked claim.
//
// A known truth is a fenced block with the info string `truth`, under the
// "## Known truths" heading, holding YAML:
//
//   id:              slug, unique in the file
//   statement:       the fact, in plain language
//   run:             argv, spawned without a shell (same rules as verify checks)
//   expect:          the client's number
//   tolerance:       optional: an absolute number, or a percent string ("0.5%"); default 0
//   owner:           the named client person who owns the number
//   signed_off:      a real date (YYYY-MM-DD) or "pending"
//   timeout_seconds: optional, 1 to 3600; default 300 like a verify check
//
// The command must print one number: the last non-empty stdout line, with
// optional standard thousands grouping (412,300 or 1,234,567.89). `npm run verify` and the Stop hook run each truth as the check
// `truth:<id>` (truthChecks below); a malformed block is a failing check that
// names its problem. Blocks inside HTML comments are ignored, so a template's
// commented example never runs. File reading is the only I/O here.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { isIsoDate } = require('../dates');
const { contextDirFor } = require('../onboard');

const SECTION = /^##\s+Known truths\s*#*\s*$/i;
const KEYS = ['id', 'statement', 'run', 'expect', 'tolerance', 'owner', 'signed_off', 'timeout_seconds'];
const REQUIRED = ['id', 'statement', 'run', 'expect', 'owner'];
const SLUG = /^[a-z][a-z0-9-]*$/;
const PERCENT = /^(\d+(?:\.\d+)?)\s*%$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
// Commas only as thousands separators: 1 to 3 leading digits, then groups of
// exactly 3, before any decimal point. "1,2" or "12,34,5" could be a typo or
// another locale's decimal comma, so they are rejected, never guessed.
const GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;
const DEFAULT_TIMEOUT_SECONDS = 300;
const SHOWN_CHARS = 80;

const filled = (v) => typeof v === 'string' && /\S/.test(v);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// The raw `truth` blocks under "## Known truths": [{ index, line, body, unclosed? }].
// `index` counts from 1 in file order; `line` is the opening fence's line number.
// Skips HTML comments, other fences, and everything outside the section.
// `section` and `info` name another section and info string: the query rules
// (kit/lib/query-rules) are `query-rule` blocks under "## Query rules".
function extractBlocks(text, { section = SECTION, info = 'truth' } = {}) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let inSection = false;
  let inComment = false;
  let fence = null;
  lines.forEach((line, i) => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
        if (fence.keep) blocks.push({ index: blocks.length + 1, line: fence.line, body: fence.body.join('\n') });
        fence = null;
      } else fence.body.push(line);
      return;
    }
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      return;
    }
    const open = line.indexOf('<!--');
    if (open !== -1) {
      if (!line.includes('-->', open + 4)) inComment = true;
      return;
    }
    if (/^#{1,6}\s/.test(line)) {
      if (section.test(line)) inSection = true;
      else if (/^#{1,2}\s/.test(line)) inSection = false;
      return;
    }
    const start = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (start) fence = { marker: start[1], keep: inSection && start[2] === info, line: i + 1, body: [] };
  });
  if (fence && fence.keep) blocks.push({ index: blocks.length + 1, line: fence.line, body: fence.body.join('\n'), unclosed: true });
  return blocks;
}

// Parses a tolerance into { kind: 'abs' | 'pct', value } or null when invalid.
function parseTolerance(v) {
  if (v === undefined || v === null) return { kind: 'abs', value: 0 };
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? { kind: 'abs', value: v } : null;
  if (typeof v === 'string') {
    const m = PERCENT.exec(v.trim());
    if (m) return { kind: 'pct', value: Number(m[1]) };
  }
  return null;
}

// The allowed distance from `expect` for a parsed tolerance.
const allowance = (tol, expect) => (tol.kind === 'pct' ? (Math.abs(expect) * tol.value) / 100 : tol.value);

// Validates one parsed YAML body. Returns { truth, problems }.
function validate(data) {
  const problems = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { truth: null, problems: ['block is not a YAML mapping'] };
  for (const k of Object.keys(data)) if (!KEYS.includes(k)) problems.push(`unknown key "${k}"`);
  for (const k of REQUIRED) if (data[k] === undefined || data[k] === null || data[k] === '') problems.push(`missing ${k}`);
  if (data.id != null && !(typeof data.id === 'string' && SLUG.test(data.id))) problems.push('id must be a slug (a-z, 0-9, -; starts with a letter)');
  if (data.statement != null && data.statement !== '' && !filled(data.statement)) problems.push('statement must be text');
  if (data.run != null) {
    const ok = Array.isArray(data.run) && data.run.length > 0 && data.run.every(filled);
    if (!ok) problems.push('run must be a non-empty argv list of strings (no shell)');
  }
  if (data.expect != null && data.expect !== '' && !(typeof data.expect === 'number' && Number.isFinite(data.expect))) problems.push('expect must be a number');
  const tolerance = parseTolerance(data.tolerance);
  if (!tolerance) problems.push('tolerance must be a number >= 0 or a percent such as "0.5%"');
  if (data.owner != null && data.owner !== '' && !filled(data.owner)) problems.push('owner must name a client person');
  if (data.signed_off === undefined || data.signed_off === null) problems.push('missing signed_off (a date or pending)');
  else if (data.signed_off !== 'pending' && !isIsoDate(data.signed_off)) problems.push('signed_off must be pending or a real ISO date (YYYY-MM-DD)');
  const t = data.timeout_seconds;
  if (t !== undefined && !(Number.isInteger(t) && t >= 1 && t <= 3600)) problems.push('timeout_seconds must be an integer from 1 to 3600');
  const truth = {
    id: typeof data.id === 'string' ? data.id : null,
    statement: filled(data.statement) ? data.statement.trim() : null,
    run: data.run,
    expect: data.expect,
    tolerance,
    owner: filled(data.owner) ? data.owner.trim() : null,
    signedOff: data.signed_off === 'pending' || isIsoDate(data.signed_off) ? data.signed_off : null,
    timeoutSeconds: t === undefined ? DEFAULT_TIMEOUT_SECONDS : t,
  };
  return { truth, problems };
}

// Parses data.md text into [{ index, line, id, truth, problems }]: one entry
// per `truth` block, valid or not. `id` is the check id suffix: the truth's
// own id when usable and unique, else `block-<index>`.
function parseTruths(text) {
  const seen = new Set();
  return extractBlocks(text).map((b) => {
    let entry;
    if (b.unclosed) entry = { truth: null, problems: ['block is not closed (no closing ```)'] };
    else {
      try {
        entry = validate(YAML.parse(b.body));
      } catch (err) {
        entry = { truth: null, problems: [`block is not valid YAML: ${err.message.split('\n')[0]}`] };
      }
    }
    const own = entry.truth && entry.truth.id && SLUG.test(entry.truth.id) ? entry.truth.id : null;
    if (own && seen.has(own)) entry.problems.push(`duplicate id "${own}"`);
    const id = own && !seen.has(own) ? own : `block-${b.index}`;
    if (own) seen.add(own);
    return { index: b.index, line: b.line, id, ...entry };
  });
}

// Reads <contextDir>/data.md. A missing file is no truths; an unreadable one
// is a single malformed entry, so it fails verify instead of passing silently.
function loadTruths(contextDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(contextDir, 'data.md'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    return [{ index: 0, line: 0, id: 'data-md', truth: null, problems: [`cannot read data.md: ${err.code || err.message}`] }];
  }
  return parseTruths(text);
}

// The truth checks for the repo governed by `profileFile`: its data.md sits
// in the context directory beside the profile (kit/lib/onboard).
const truthChecksFor = (profileFile) => truthChecks(loadTruths(contextDirFor(path.resolve(profileFile))));

// Reads a number from a command's stdout: the last non-empty line, with
// optional standard thousands grouping.
function readNumber(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { error: 'printed nothing' };
  const last = lines[lines.length - 1];
  if (last.includes(',') && !GROUPED.test(last)) {
    return { error: `output has commas that are not standard thousands grouping: "${oneLine(last).slice(0, SHOWN_CHARS)}"` };
  }
  const bare = last.replace(/,/g, '');
  if (!NUMBER.test(bare)) return { error: `output is not a number: "${oneLine(last).slice(0, SHOWN_CHARS)}"` };
  return { value: Number(bare) };
}

const showTolerance = (tol) => (tol.kind === 'pct' ? `${tol.value}%` : String(tol.value));

// Judges a truth command that exited 0: { outcome, reason? }.
function judge(truth, stdout) {
  const want = `expected ${truth.expect} ± ${showTolerance(truth.tolerance)}`;
  const got = readNumber(stdout);
  if (got.error) return { outcome: 'fail', reason: `${want}, ${got.error}` };
  const diff = Math.abs(got.value - truth.expect);
  const slack = Number.EPSILON * Math.max(Math.abs(got.value), Math.abs(truth.expect)) * 4;
  if (diff <= allowance(truth.tolerance, truth.expect) + slack) return { outcome: 'pass' };
  return { outcome: 'fail', reason: `${want}, actual ${got.value} (off by ${Number(diff.toPrecision(12))})` };
}

// Verify check objects for the runner (kit/lib/verify/runner): a valid truth
// spawns its `run` and is judged on its output; a malformed one carries its
// `problem` and fails without spawning.
function truthChecks(entries) {
  return entries.map((e) => {
    const id = `truth:${e.id}`;
    if (e.problems.length) return { id, problem: `line ${e.line}: ${e.problems.join('; ')}` };
    return { id, run: e.truth.run, timeout_seconds: e.truth.timeoutSeconds, judge: (stdout) => judge(e.truth, stdout) };
  });
}

// Truths that need attention before SQLsmith may rely on them: a validation
// problem, no owner, or a pending sign-off.
const needsAttention = (e) => e.problems.length > 0 || !e.truth.owner || e.truth.signedOff === 'pending';

// Truths in `entries` whose check failed or timed out in `last` (the record
// from kit/lib/verify/last, or null). Truths removed since are not counted.
function failedAtLast(entries, last) {
  if (!last) return 0;
  const bad = new Set(last.results.filter((r) => r.outcome === 'fail' || r.outcome === 'timeout').map((r) => r.id));
  return entries.filter((e) => bad.has(`truth:${e.id}`)).length;
}

// The session banner line, or null when there are no truths, all are valid
// and signed off, and none failed at the last verify run (`last`, optional).
// Static only: the commands are never run at session start.
function bannerLine(entries, last = null) {
  const parts = [];
  const need = entries.filter(needsAttention).length;
  if (need) parts.push(`${need} of ${entries.length} need a check or sign-off`);
  const failed = failedAtLast(entries, last);
  if (failed) parts.push(`${failed} failed at last verify (${last.at})`);
  return parts.length ? `Known truths: ${parts.join('; ')}` : null;
}

module.exports = {
  DEFAULT_TIMEOUT_SECONDS,
  allowance,
  extractBlocks,
  parseTolerance,
  parseTruths,
  loadTruths,
  readNumber,
  judge,
  truthChecks,
  truthChecksFor,
  bannerLine,
};
