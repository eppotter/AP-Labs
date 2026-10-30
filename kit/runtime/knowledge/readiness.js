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
//            forbiddenColumns (a count), checkedAt, problem }
//
// Never in detail: a truth's expect (the client's number) or run (its
// command), a table name, a row count, a column name, a file's text or why a
// read failed. last is the truth's outcome at the last `npm run verify` on
// this machine (kit/lib/verify/last: pass, fail, skip or timeout), or null
// when there is no record: not checked on this machine.

const path = require('node:path');
const { contextDirFor, fileStatus } = require('../../lib/onboard');
const { loadTruths } = require('../../lib/truths');
const { gitDirOf, readLastResult } = require('../../lib/verify/last');
const { forbiddenColumnsOf } = require('../sql');

// The two client files "rules set up" needs signed off.
const RULE_FILES = Object.freeze(['data.md', 'guardrails.md']);

const sees = (view, what) => Boolean(view && Array.isArray(view.sees) && view.sees.includes(what));
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const NO_DATA = Object.freeze({
  seen: false, connected: false, source: null, label: null, problem: false,
});
const NO_RULES = Object.freeze({
  seen: false, files: Object.freeze([]), truths: Object.freeze([]), forbiddenColumns: 0, checkedAt: null, problem: false,
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

// One client file's state, without its owner's words beyond the name.
function fileDetail(contextDir, file) {
  const s = fileStatus(contextDir, file);
  return {
    file,
    present: s.present === true,
    signed: s.signed === true,
    owner: s.error ? null : text(s.owner),
    signedOff: s.signed ? s.signedOff : null,
    // Unreadable (not missing, not malformed): something to tell the person.
    problem: typeof s.error === 'string' && s.error.startsWith('cannot read'),
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

// The rules reader for one profile: the client files beside it
// (contextDirFor), the profile's forbidden columns and the last verify
// record of the repo it sits in. Each read() reads the files again, so a
// sign-off shows without a restart. readLast and now are test seams.
function createRulesReader({
  profile, profilePath, readLast = null, now = Date.now,
}) {
  const contextDir = profilePath ? contextDirFor(path.resolve(profilePath)) : null;
  let gitDir;
  const last = readLast || (() => {
    if (gitDir === undefined) gitDir = contextDir ? gitDirOf(path.dirname(contextDir)) : null;
    return readLastResult(gitDir, now());
  });
  return Object.freeze({
    read() {
      if (!contextDir) return { ...NO_RULES, problem: true };
      const files = RULE_FILES.map((f) => fileDetail(contextDir, f));
      const entries = loadTruths(contextDir);
      let record = null;
      try {
        record = last();
      } catch {
        record = null;
      }
      return {
        files: files.map(({ problem, ...f }) => f),
        truths: truthDetail(entries, record),
        forbiddenColumns: forbiddenColumnsOf(profile).length,
        checkedAt: record && typeof record.at === 'string' ? record.at : null,
        problem: files.some((f) => f.problem) || entries.some((e) => e.index === 0),
      };
    },
  });
}

module.exports = { readiness, createRulesReader, RULE_FILES };
