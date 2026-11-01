'use strict';

// Readiness (plan brightside-v0, D9 and D10, Story 16.3): whether a hub has
// data connected and the rules for using it safely set up. The one place
// both are decided: Data sources shows it, and Ask (Story 16.7) routes data
// questions by it.
//
//   const rules = createRulesReader({ profile, profilePath });
//   readiness(hubView, { rules })  ->  { data: bool, rules: bool, detail }
//
// Data connected: the hub sees "data" and its runner's describe() says
// available. Rules set up: the hub sees "rules", data.md and guardrails.md
// are signed off (kit/lib/onboard), and at least one known truth is valid and
// signed off (kit/lib/truths). A hub that does not see data or rules is
// false for it without reading anything: neither the runner nor a file.
//
// Never an error: a runner whose describe() throws, a context file that is
// missing, unreadable, unsigned or malformed, or a rules reader that throws
// each reads as "not set up". detail.data.problem or detail.rules.problem
// says something could not be read, so a screen can say so plainly; the
// cause is never in detail.
//
// detail holds only what may be shown to someone who holds the tool's key:
//
//   data:  { seen, connected, source, label, problem }
//   rules: { seen, files: [{ file, present, signed, owner, signedOff }],
//            truths: [{ id, statement, owner, signedOff, valid, last }],
//            forbiddenColumns (a count), approvedRules (a count),
//            signedQueryRules (a count), checkedAt, problem }
//
// Never in detail: a truth's expect (the client's number) or run (its
// command), a table name, a row count, a column name, a file's text or why a
// read failed. last is the truth's outcome at the last `npm run verify` on
// this machine (kit/lib/verify/last: pass, fail, skip or timeout), or null
// when there is no record: not checked on this machine.
//
// approvedRules (plan hub-status-menu, D3, Story 17.1): the rule cards in
// guardrails.md ("### <ID>: <name>") whose first "- status:" line says
// exactly "approved", counted only while guardrails.md itself is signed off.
// A card inside an HTML comment or a fenced code block is not a card, and
// "draft (approved ...)" is not approved. A number only: no rule's id, name
// or text reaches detail.
//
// signedQueryRules (plan brightside-v1, D11, Story 19.6): the query rules in
// data.md's "## Query rules" section that are signed (kit/lib/query-rules
// isSigned: valid, approved, dated, named, and their query-rule:<id> check
// passed at the last verify on this machine). A number only.
//
// Who may see the counts (plan hub-status-menu, D4, architect P1-1): the hub
// menu's strip (kit/runtime/knowledge/summary) shows the number of notes,
// sources, signed-off truths and approved rules to a person who is in the
// profile and has at least one row on the hub, as numbers only. Never to a
// person the profile doesn't name. A truth's statement and owner, and each
// file's sign-off, stay behind Data sources' key, as before.
//
// Bounded reads (plan hub-status-menu, D8): the menu reads this inside
// Slack's 3-second window, and a synchronous read can't be raced. So each of
// the three files the reader opens (data.md, guardrails.md and the last
// verify record) is sized first, and one over MAX_FILE_BYTES (256 KB) is not
// read: it reads as not set up (no truths, no rules, no verify record), with
// problem set, so a screen says it couldn't check just now.

const fs = require('node:fs');
const path = require('node:path');
const { contextDirFor, fileStatus } = require('../../lib/onboard');
const { loadTruths } = require('../../lib/truths');
const {
  parseRules, countSigned, isSigned, writerCanon,
} = require('../../lib/query-rules');
const { gitDirOf, readLastResult, lastFile } = require('../../lib/verify/last');
const { forbiddenColumnsOf } = require('../sql');

// The two client files "rules set up" needs signed off.
const RULE_FILES = Object.freeze(['data.md', 'guardrails.md']);
// The largest file the rules reader opens (D8). A bigger one is never read.
const MAX_FILE_BYTES = 256 * 1024;

const sees = (view, what) => Boolean(view && Array.isArray(view.sees) && view.sees.includes(what));
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const NO_DATA = Object.freeze({
  seen: false, connected: false, source: null, label: null, problem: false,
});
const NO_RULES = Object.freeze({
  seen: false, files: Object.freeze([]), truths: Object.freeze([]), forbiddenColumns: 0, approvedRules: 0, signedQueryRules: 0, checkedAt: null, problem: false,
});

// The data half: read only when the hub sees data.
function dataDetail(view) {
  if (!sees(view, 'data')) return NO_DATA;
  const runner = view.data;
  if (!runner || typeof runner.describe !== 'function') return { ...NO_DATA, seen: true };
  try {
    const d = runner.describe() || {};
    return {
      seen: true, connected: d.available === true, source: text(d.source), label: text(d.label), problem: false,
    };
  } catch {
    return { ...NO_DATA, seen: true, problem: true };
  }
}

// The rules half: read only when the hub sees rules (view.rules, from the
// hub view, and its sees list agree; both are checked).
function rulesDetail(view, rules) {
  if (!sees(view, 'rules') || view.rules !== true) return NO_RULES;
  if (!rules || typeof rules.read !== 'function') return { ...NO_RULES, seen: true, problem: true };
  try {
    return { ...rules.read(), seen: true };
  } catch {
    return { ...NO_RULES, seen: true, problem: true };
  }
}

const rulesSetUp = (r) => r.seen
  && RULE_FILES.every((f) => r.files.some((s) => s.file === f && s.signed))
  && r.truths.some((t) => t.valid && t.signedOff !== 'pending' && t.signedOff !== null);

// hubView: a hub's view (kit/runtime/slack/hub-view). rules: the reader
// (createRulesReader), or null.
function readiness(hubView, { rules = null } = {}) {
  const data = dataDetail(hubView);
  const r = rulesDetail(hubView, rules);
  return Object.freeze({ data: data.connected, rules: rulesSetUp(r), detail: Object.freeze({ data, rules: r }) });
}

// True when the file is a regular file over MAX_FILE_BYTES: it is not read.
// Missing, or a stat that fails, is false, so the read that follows reports
// it as it always has.
function overBound(full) {
  try {
    const st = fs.statSync(full);
    return st.isFile() && st.size > MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

// One client file's state, without its owner's words beyond the name. over:
// the file was too big to read (D8).
function fileDetail(contextDir, file) {
  if (overBound(path.join(contextDir, file))) {
    return {
      file, present: true, signed: false, owner: null, signedOff: null, problem: true, over: true,
    };
  }
  const s = fileStatus(contextDir, file);
  return {
    file,
    present: s.present === true,
    signed: s.signed === true,
    owner: s.error ? null : text(s.owner),
    signedOff: s.signed ? s.signedOff : null,
    // Unreadable (not missing, not malformed): something to tell the person.
    problem: typeof s.error === 'string' && s.error.startsWith('cannot read'),
    over: false,
  };
}

// The truths, each with only what may be shown.
function truthDetail(entries, last) {
  const outcomes = new Map(((last && last.results) || []).map((r) => [r.id, r.outcome]));
  return entries
    .filter((e) => e.index !== 0) // index 0: data.md could not be read (loadTruths)
    .map((e) => ({
      id: e.id,
      statement: e.truth ? e.truth.statement : null,
      owner: e.truth ? e.truth.owner : null,
      signedOff: e.truth ? e.truth.signedOff : null,
      valid: e.problems.length === 0,
      last: outcomes.get(`truth:${e.id}`) || null,
    }));
}

// A rule card's heading, any heading, a code fence, and a card's status line.
const CARD = /^ {0,3}### +[A-Za-z][A-Za-z0-9_-]*: *\S/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const STATUS = /^\s*[-*] +status: *(.*?)\s*$/;

// A line with its HTML comment text removed. Returns { kept, open }: open is
// true when a comment is still open at the end of the line.
function outsideComments(line, open) {
  let rest = line;
  let kept = '';
  let inside = open;
  while (rest) {
    const at = rest.indexOf(inside ? '-->' : '<!--');
    if (at < 0) {
      if (!inside) kept += rest;
      break;
    }
    if (!inside) kept += rest.slice(0, at);
    rest = rest.slice(at + (inside ? 3 : 4));
    inside = !inside;
  }
  return { kept, open: inside };
}

// The approved rule cards in a guardrails.md text (D3): "### <ID>: <name>"
// headings outside HTML comments and fenced code, whose first "- status:"
// line before the next heading says exactly "approved". A count only.
function countApprovedRules(source) {
  let count = 0;
  let card = null; // inside a card: { status } (null until its status line)
  let fence = null; // the open fence's marker
  let comment = false;
  for (const line of String(source).split(/\r?\n/)) {
    if (fence) {
      const m = FENCE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.trim().slice(m[1].length).trim()) fence = null;
      continue;
    }
    if (!comment && FENCE.test(line)) {
      [, fence] = FENCE.exec(line);
      continue;
    }
    const { kept, open } = outsideComments(line, comment);
    comment = open;
    // A card's heading starts its line: not after a comment on the same line.
    if (CARD.test(kept) && CARD.test(line)) {
      card = { status: null };
    } else if (HEADING.test(kept)) {
      card = null;
    } else if (card && card.status === null) {
      const m = STATUS.exec(kept);
      if (m) {
        card.status = m[1];
        if (m[1] === 'approved') count += 1;
      }
    }
  }
  return count;
}

// guardrails.md's approved rules: read only when it is signed off and was
// not too big to read (fileDetail).
function approvedRulesIn(contextDir, guardrails) {
  if (!guardrails || !guardrails.signed || guardrails.problem) return 0;
  const full = path.join(contextDir, 'guardrails.md');
  if (overBound(full)) return 0;
  try {
    return countApprovedRules(fs.readFileSync(full, 'utf8'));
  } catch {
    return 0;
  }
}

// data.md's query rules (D11), or none when it can't be read: the truths'
// read already reports that as a problem.
function queryRulesIn(contextDir) {
  try {
    return parseRules(fs.readFileSync(path.join(contextDir, 'data.md'), 'utf8'));
  } catch {
    return [];
  }
}

// The code a verify record over the bound is refused with, inside the reader.
const OVER_BOUND = 'APLABS_OVER_BOUND';

// The rules reader for one profile: the client files beside it
// (contextDirFor), the profile's forbidden columns and the last verify
// record of the repo it sits in. Each read() reads the files again, so a
// sign-off shows without a restart. readLast and now are test seams.
//
// forQueries() (plan brightside-v1, D10, D11, Story 19.8) is for Ask's query
// path only, never a screen: { rules, canon, truths, checkedAt }. rules: the
// signed query rules (isSigned, against the same verify record), each its
// validated rule object. canon: kit/lib/query-rules writerCanon of data.md
// (Terminology and approved metric rule lines, no figure). truths: every
// known truth as { id, signed, last } (signed: valid and signed off; last:
// its outcome at the last verify), never its expect. checkedAt: the record's
// time, or null with no record. data.md over the bound, missing or
// unreadable gives no rules and no truths, so Ask refuses (fail closed).
function createRulesReader({
  profile, profilePath, readLast = null, now = Date.now,
}) {
  const contextDir = profilePath ? contextDirFor(path.resolve(profilePath)) : null;
  let gitDir;
  const last = readLast || (() => {
    if (gitDir === undefined) gitDir = contextDir ? gitDirOf(path.dirname(contextDir)) : null;
    if (gitDir && overBound(lastFile(gitDir))) throw Object.assign(new Error('verify record over the bound'), { code: OVER_BOUND });
    return readLastResult(gitDir, now());
  });
  return Object.freeze({
    read() {
      if (!contextDir) return { ...NO_RULES, problem: true };
      const files = RULE_FILES.map((f) => fileDetail(contextDir, f));
      const dataMd = files.find((f) => f.file === 'data.md');
      const entries = dataMd.over ? [] : loadTruths(contextDir);
      const queryRules = dataMd.over ? [] : queryRulesIn(contextDir);
      let record = null;
      let recordOver = false;
      try {
        record = last();
      } catch (err) {
        record = null;
        recordOver = Boolean(err && err.code === OVER_BOUND);
      }
      return {
        files: files.map(({ problem, over, ...f }) => f),
        truths: truthDetail(entries, record),
        forbiddenColumns: forbiddenColumnsOf(profile).length,
        approvedRules: approvedRulesIn(contextDir, files.find((f) => f.file === 'guardrails.md')),
        signedQueryRules: countSigned(queryRules, record),
        checkedAt: record && typeof record.at === 'string' ? record.at : null,
        problem: files.some((f) => f.problem) || entries.some((e) => e.index === 0) || recordOver,
      };
    },
    forQueries() {
      const none = {
        rules: Object.freeze([]), canon: writerCanon(''), truths: Object.freeze([]), checkedAt: null,
      };
      if (!contextDir) return none;
      const full = path.join(contextDir, 'data.md');
      if (overBound(full)) return none;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        return none;
      }
      let record = null;
      try {
        record = last();
      } catch {
        record = null;
      }
      const outcomes = new Map(((record && record.results) || []).map((r) => [r.id, r.outcome]));
      const truths = loadTruths(contextDir).filter((e) => e.index !== 0).map((e) => Object.freeze({
        id: e.id,
        signed: e.problems.length === 0 && Boolean(e.truth && e.truth.owner && e.truth.signedOff && e.truth.signedOff !== 'pending'),
        last: outcomes.get(`truth:${e.id}`) || null,
      }));
      return Object.freeze({
        rules: Object.freeze(parseRules(text).filter((e) => isSigned(e, record)).map((e) => e.rule)),
        canon: writerCanon(text),
        truths: Object.freeze(truths),
        checkedAt: record && typeof record.at === 'string' ? record.at : null,
      });
    },
  });
}

module.exports = {
  readiness, createRulesReader, countApprovedRules, RULE_FILES, MAX_FILE_BYTES,
};
