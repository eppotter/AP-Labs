'use strict';

// The hub menu's next-step line (plan hub-status-menu, D6, Story 17.4). Pure:
// it reads nothing itself. The slash command (kit/runtime/slack/hubs) hands
// it what the menu already has, and kit/runtime/registry/menu renders what
// it returns as the `next` block, with the menu's only primary button.
//
//   nextStep({ summary, admin, rows, newIds, hubTools })
//     -> { text, label, moduleId, actionId } or null
//
//   summary   summarize() for the hub (kit/runtime/knowledge/summary)
//   admin     the person's profile role is admin
//   rows      the rows in this person's menu, in menu order, each
//             { entry, status, verb } (status { key, detail } or null)
//   newIds    the module ids in this menu that were not in the last menu
//             this person opened on this hub (none on a first visit, after
//             a restart or after 7 days)
//   hubTools  the hub's modules in this environment, whoever may open them
//
// D6's rule, first match wins:
//   1  an admin, the "taught" step not done, and an Add context row in the
//      menu: "*Next:* teach it the business", button "Add context"
//   2  anyone, a tool new to them whose status is ready or partly (the
//      first such row in menu order): "*New:* <label>", button its verb
//   3  an admin, the "taught" step done, no tool on the hub but the template
//      tools (ask, add-context, data-sources, build-request), and a ready
//      Request a tool row: "*Next:* request your first tool", button
//      "Request"
//   -  anything else: null, no line
//
// A row whose status is waiting (or that has no status) is never chosen, so
// a member never sees a setup step: rules 1 and 3 are an admin's only.
// Rules 1 and 3 read the summary: one that couldn't be read gives neither.
// The button sends the row's own <module-id>:open, so the dispatcher
// re-checks access at the click as for any row.

const { openActionId } = require('./menu');
const { menuVerbOf } = require('./vocabulary');

// The tools every hub starts with (rule 3).
const TEMPLATE_ARCHETYPES = Object.freeze(['ask', 'add-context', 'data-sources', 'build-request']);
const TEACH = '*Next:* teach it the business';
const TEACH_LABEL = 'Add context';
const FIRST_TOOL = '*Next:* request your first tool';
const FIRST_TOOL_LABEL = 'Request';
const NEW_PREFIX = '*New:* ';

// Slack mrkdwn treats &, < and > as control characters.
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const keyOf = (row) => (row && row.status && typeof row.status.key === 'string' ? row.status.key : null);
const usable = (row) => ['ready', 'partly'].includes(keyOf(row));
const archetypeOf = (row) => row && row.entry && row.entry.archetype;
const step = (summary, name) => (summary.steps.find((s) => s && s.step === name) || null);
const step1Done = (summary) => {
  const s = step(summary, 'taught');
  return Boolean(s && s.done);
};

function line(text, label, entry) {
  return Object.freeze({
    text, label, moduleId: entry.id, actionId: openActionId(entry.id),
  });
}

function nextStep({
  summary = null, admin = false, rows = [], newIds = [], hubTools = [],
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError('nextStep needs the menu rows');
  const known = Boolean(summary && !summary.problem && Array.isArray(summary.steps));
  const fresh = new Set(Array.isArray(newIds) ? newIds : []);

  // 1. Teach it the business.
  if (admin && known && step(summary, 'taught') && !step1Done(summary)) {
    const add = rows.find((r) => archetypeOf(r) === 'add-context' && keyOf(r) && keyOf(r) !== 'waiting');
    if (add) return line(TEACH, TEACH_LABEL, add.entry);
  }

  // 2. A tool new to them.
  const brandNew = rows.find((r) => r && r.entry && fresh.has(r.entry.id) && usable(r));
  if (brandNew) return line(`${NEW_PREFIX}${escapeText(brandNew.entry.label)}`, brandNew.verb || menuVerbOf(brandNew.entry), brandNew.entry);

  // 3. Request your first tool.
  if (admin && known && step1Done(summary)) {
    const onlyTemplate = Array.isArray(hubTools) && hubTools.every((m) => m && TEMPLATE_ARCHETYPES.includes(m.archetype));
    const request = rows.find((r) => archetypeOf(r) === 'build-request' && keyOf(r) === 'ready');
    if (onlyTemplate && request) return line(FIRST_TOOL, FIRST_TOOL_LABEL, request.entry);
  }

  return null;
}

module.exports = {
  nextStep, TEMPLATE_ARCHETYPES, TEACH, TEACH_LABEL, FIRST_TOOL, FIRST_TOOL_LABEL, NEW_PREFIX,
};
