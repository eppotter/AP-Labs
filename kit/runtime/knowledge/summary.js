'use strict';

// A hub's setup summary (plan hub-status-menu, D3 and D4, Story 17.1): what
// the menu's strip counts and how far setup has got. Pure: it reads nothing
// itself. Its inputs come from what the hub already has: readiness() (no AI
// call, bounded reads) and the knowledge store's list (via data-sources'
// entriesOf).
//
//   summarize({ ready, entries, entriesProblem, sees })
//     -> { counts: { notes, sources, truths, rules },
//          steps: [{ step, counted, done }], done, of, problem }
//
// counts (D3), numbers only, never a note, truth or rule:
//   notes    the hub's added-context entries; null when they couldn't be
//            listed (entriesProblem): "couldn't check", never 0.
//   sources  1 when the hub sees data and its runner says available, else 0.
//   truths   the valid, signed-off known truths; 0 when the hub doesn't see
//            rules.
//   rules    the approved rule cards (readiness detail.rules.approvedRules),
//            0 while guardrails.md is not signed off or the hub doesn't see
//            rules.
//
// steps (D4), in order. Only the steps the hub's sees allows are counted
// (architect P2-6): "taught" always; "data" when it sees data; "truths" and
// "rules" when it sees rules. done and of count the counted steps only, so a
// blank hub (sees []) is 0 of 1 until its first note.
//   taught   at least one note, or the hub sees context
//   data     readiness.data
//   truths   at least one valid, signed-off truth
//   rules    data.md and guardrails.md both signed off
// truths and rules together are readiness.rules, so Ask and the menu agree
// on what "rules set up" means.
//
// problem: something could not be read (the notes, the runner or a client
// file), so the strip says "couldn't check just now".
//
// Who may see it (D4, architect P1-1): a person in the profile with at least
// one row on the hub. Never a person the profile doesn't name.

const STEPS = Object.freeze(['taught', 'data', 'truths', 'rules']);
const has = (list, what) => Array.isArray(list) && list.includes(what);
const signedTruth = (t) => Boolean(t && t.valid === true && typeof t.signedOff === 'string' && t.signedOff !== 'pending');
const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

function summarize({
  ready, entries = [], entriesProblem = false, sees = [],
} = {}) {
  if (!ready || !ready.detail || !ready.detail.data || !ready.detail.rules) throw new TypeError('summarize needs readiness() for the hub');
  const { data, rules } = ready.detail;
  const seesData = has(sees, 'data');
  const seesRules = has(sees, 'rules');
  const notes = entriesProblem ? null : (Array.isArray(entries) ? entries.length : 0);
  const files = Array.isArray(rules.files) ? rules.files : [];
  const signed = (f) => files.some((s) => s && s.file === f && s.signed === true);
  const counts = Object.freeze({
    notes,
    sources: seesData && data.seen && data.connected === true ? 1 : 0,
    truths: seesRules && rules.seen ? (Array.isArray(rules.truths) ? rules.truths.filter(signedTruth).length : 0) : 0,
    rules: seesRules && rules.seen && signed('guardrails.md') ? count(rules.approvedRules) : 0,
  });
  const done = {
    taught: (notes !== null && notes > 0) || has(sees, 'context'),
    data: seesData && ready.data === true,
    truths: counts.truths > 0,
    rules: seesRules && rules.seen && signed('data.md') && signed('guardrails.md'),
  };
  const counted = {
    taught: true, data: seesData, truths: seesRules, rules: seesRules,
  };
  const steps = Object.freeze(STEPS.map((step) => Object.freeze({ step, counted: counted[step], done: done[step] })));
  const kept = steps.filter((s) => s.counted);
  return Object.freeze({
    counts,
    steps,
    done: kept.filter((s) => s.done).length,
    of: kept.length,
    problem: Boolean(entriesProblem || data.problem || rules.problem),
  });
}

module.exports = { summarize, STEPS };
