'use strict';

// The one place that turns a typed refusal into words (AD-17). Each message is
// plain and names a next step. Handlers never build refusal text themselves.
// Returns Slack mrkdwn text, or null for an error that is not a refusal (the
// caller then uses the generic plain error). context.admin, when the caller
// knows it, is who to tell in a connector message; else "your admin".

const {
  NotSetUp, AccessDenied, ConfigFault, DataUnavailable, LlmUnavailable, KillSwitchOn,
  ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict, PartialFailure,
} = require('./errors');
const {
  SessionExpired, SessionNotYours, AlreadyConfirmed, QueryBlocked, QueryFailed, CsvNotDelivered,
} = require('./errors');
const {
  ProvenanceGone, ProvenanceNotYours, ScoringFault, PreviewInvalid, PushRefused, AlreadyPushed,
} = require('./errors');
const { RoutingFault } = require('./errors');

// Slack mrkdwn treats &, < and > as control characters.
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sentWords = ({ items }) => `${items} ${items === 1 ? 'item was' : 'items were'} sent`;
// When what went could not be recorded (sent.recorded false), a retry may send
// it again, so the next step is always a check first, never a retry (#89).
const checkFirst = (admin, { start = true } = {}) => `${start ? admin.charAt(0).toUpperCase() + admin.slice(1) : admin} should check what arrived before anyone tries again.`;

// Why a scored list stopped (Story 10.1), from the input's label. Never the
// value itself.
const SCORING_WORDS = Object.freeze({
  missing: (label) => `the results have no "${label}" column`,
  null: (label) => `"${label}" is empty for at least one row (the list's SQL must COALESCE it to a number)`,
  not_number: (label) => `"${label}" is not a number for at least one row`,
  no_row_id: (label) => `the results have no "${label}" column to tell the rows apart`,
  column_taken: (label) => `the results already have a column named "${label}", which the scores need`,
  duplicate_row_id: (label) => `two rows have the same "${label}", so they can't be told apart`,
  bad_limit: (label) => `"${label}" is not a whole number of rows`,
});

// Why the routing engine refused its input (Story 12.1), from the field's
// path. Never the value itself.
const ROUTING_WORDS = Object.freeze({
  missing: ({ field }) => `"${field}" is missing`,
  not_object: ({ field }) => `"${field}" is not a set of named values`,
  not_list: ({ field }) => `"${field}" is not a list`,
  not_text: ({ field }) => `"${field}" is not text`,
  not_integer: ({ field }) => `"${field}" is not a whole number`,
  not_true_false: ({ field }) => `"${field}" is not true or false`,
  out_of_range: ({ field }) => `"${field}" is outside its allowed range`,
  bad_id: ({ field }) => `"${field}" is not a valid id`,
  bad_node: ({ field }) => `"${field}" is not a place id (property:<id> or crew:<id>)`,
  bad_date: ({ field }) => `"${field}" is not a date written as YYYY-MM-DD`,
  bad_strength: ({ field }) => `"${field}" is neither hard nor soft`,
  unknown_crew: ({ field }) => `"${field}" names a crew that isn't in the day`,
  duplicate: ({ field }) => `"${field}" appears more than once`,
  no_travel: ({ from, to }) => `there is no drive time from ${from} to ${to}`,
});

// The AI service's refusals (Story 9.1). Each points to the typed form, which
// always works; the module shows it alongside.
const LLM_WORDS = Object.freeze({
  off: () => "The AI helper is switched off right now, so I can't read your request. Please use the form instead.",
  no_key: () => "The AI helper isn't available here, so I can't read your request. Please use the form instead.",
  config: (admin) => `The AI helper isn't set up correctly, so I can't read your request. I've logged the problem; please tell ${admin}. You can use the form instead.`,
  too_long: (admin, { maxChars = 500 }) => `That request is too long for me to read (${maxChars} characters at most). Please shorten it, or use the form instead.`,
  rate_limited: (admin, { perHour = 20 }) => `You've reached the limit of ${perHour} AI requests an hour. Please use the form instead, or try again later.`,
  over_budget: () => 'The AI helper has reached its spending limit for this hour. Please use the form instead, or try again later.',
  failed: () => "I couldn't read your request just now. Please use the form instead, or try again in a moment.",
});

// "Read my request" (Story 9.4). Written by the bot, never by the AI: a label
// comes from the reviewed manifest. Each is plain text (shown as plain_text,
// so nothing in it formats or links), except the notices, which are mrkdwn
// and escape what they insert.
const READ_WORDS = Object.freeze({
  reading: () => 'Reading your request…',
  empty: () => 'Type what you want in the box first, then press *Read my request*. Or fill in the form and press *Check values*.',
  missing: (label) => `I couldn't find ${label} in your request.`,
  question: (label) => `What should ${label} be?`,
  secondMiss: () => "I still couldn't fill in every value, so here is the form. Fill in the rest and press *Check values*.",
});

const MESSAGES = [
  [NotSetUp, ({ client, admin }) => `You're not set up in ${escapeText(client)}'s bot yet, so you only see what's open to everyone. Ask ${admin} to add you.`],
  [AccessDenied, ({ label, admin }) => `You don't have access to ${escapeText(label)}; ask ${admin}.`],
  [ConfigFault, ({ admin }) => `That option isn't set up correctly, so I can't open it right now. I've logged the problem; please tell ${admin}.`],
  [DataUnavailable, () => "The data isn't available right now, so I can't answer that. The app is still running; please tell your admin."],
  [LlmUnavailable, (details, { admin }) => LLM_WORDS[details.reason](admin, details)],
  // A write stopped partway (details.sent: { batches, items, recorded }) says what
  // already went, never "nothing was sent" (#89).
  [KillSwitchOn, ({ system, sent }, { admin }) => (sent
    ? `Sending to ${escapeText(system)} was switched off partway through: ${sentWords(sent)} before it stopped, and the rest weren't. `
      + (sent.recorded === false ? `I couldn't record that, so please tell ${admin}. ${checkFirst(admin)}` : `Please tell ${admin}.`)
    : `Sending to ${escapeText(system)} is switched off right now, so nothing was sent. Please tell your admin.`)],
  // Subclasses of ConnectorFailed come first: the first match wins.
  // A missing credential is a setup fault, worded like ConfigFault; a rejected
  // one says so. Neither reads as a passing outage (AD-17).
  [ConnectorAuthFailed, ({ system, setup, sent }, { admin }) => (sent
    ? `${escapeText(system)} turned down my sign-in partway through: ${sentWords(sent)} before it stopped, and the rest weren't. Please tell ${admin}; trying again won't help until it's fixed.`
      + (sent.recorded === false ? ` I couldn't record what went, so ${checkFirst(admin, { start: false })}` : '')
    : setup
      ? `${escapeText(system)} isn't set up correctly, so I can't reach it. I've logged the problem; please tell ${admin}.`
      : `${escapeText(system)} turned down my sign-in, so I couldn't reach it. Please tell ${admin}; trying again won't help until it's fixed.`)],
  [IdempotencyConflict, ({ system }, { admin }) => `That was already sent to ${escapeText(system)} with different contents, so I didn't send it again. Please tell ${admin}.`],
  // Counts only: the failed refs go to the log, never to the person. A retry
  // is called safe only when the write declares per-item idempotency
  // (details.retrySafe); otherwise the engine can't promise it, so it doesn't.
  [PartialFailure, ({ system, succeeded, failed, retrySafe }, { admin }) => `Sent ${succeeded} of ${succeeded + failed} to ${escapeText(system)}; ${failed} failed. `
    + (retrySafe === true
      ? `Nothing was sent twice, so trying again is safe: it sends only the ${failed} that failed. If they keep failing, please tell ${admin}.`
      : `Please tell ${admin} before trying again.`)],
  [ConnectorFailed, ({ system, sent }, { admin }) => (sent
    ? `I couldn't finish sending to ${escapeText(system)}: ${sentWords(sent)} before it stopped, and the rest weren't. `
      + (sent.recorded === false ? `I couldn't record that, so please tell ${admin}. ${checkFirst(admin)}` : `Please tell ${admin} before trying again.`)
    : `I couldn't reach ${escapeText(system)} just now. Please try again later, or tell ${admin} if it keeps happening.`)],
  // Scoped-pull form sessions (Story 9.3).
  [SessionExpired, () => 'This form has expired (forms close after 30 minutes without use). Go back to the menu and open it again.'],
  [SessionNotYours, () => "This form belongs to someone else, so I can't act on it. Open your own from the menu."],
  [AlreadyConfirmed, ({ done, failed }) => {
    if (!done) return 'You already confirmed this request and it\'s still running, so I won\'t run it twice.';
    if (failed) return 'You already confirmed this request and it didn\'t finish, so I won\'t run it again from here. Open it again from the menu to try again.';
    return 'You already confirmed this request, so it ran once and I won\'t run it again. Open it again from the menu for a new one.';
  }],
  // Scoped-pull runs (Story 9.5). Each says nothing partial was passed off.
  [QueryBlocked, (details, { admin }) => `The safety check refused this list's query, so nothing ran and there are no results. I've logged the problem; please tell ${admin}.`],
  [QueryFailed, (details, { admin }) => `This list's query failed, so there are no results (nothing partial was kept). I've logged the problem; please tell ${admin} if it keeps happening.`],
  [CsvNotDelivered, (details, { admin }) => `*The CSV didn't arrive.* I couldn't send the file to your DM, so you have only the first rows shown here, not the whole list. Open it again from the menu to try again, or tell ${admin} if it keeps happening.`],
  // A scored list (Story 10.1): a setup fault, so nothing partial is shown.
  [ScoringFault, ({ label, problem }, { admin }) => `This list's scores couldn't be worked out: ${escapeText(SCORING_WORDS[problem](label))}. So there are no results and nothing was sent. I've logged the problem; please tell ${admin}.`],
  // The routing engine's input (Story 12.1): a setup fault, so no plan is shown.
  [RoutingFault, (details, { admin }) => `The suggested plan couldn't be worked out: ${escapeText(ROUTING_WORDS[details.problem](details))}. Nothing was changed. I've logged the problem; please tell ${admin}.`],
  // "How was this made?" (Story 9.6). Neither says anything about the run.
  [ProvenanceGone, () => "The details of this run are no longer available (they're kept for 24 hours). Run the list again from the menu to see how a new one is made."],
  [ProvenanceNotYours, () => "These details belong to someone else's run, so I can't show them. Run the list yourself from the menu to see how yours is made."],
  // Push and its preview (Story 10.2). The same words for every invalid
  // preview, whoever clicked: nothing about another person's push leaks.
  [PreviewInvalid, () => 'This preview is no longer valid, so nothing was sent. Run the list again from the menu and press Push for a new preview.'],
  [PushRefused, ({ reason }) => PUSH_WORDS[reason]],
  // A second Approve by the person who approved (Story 10.3): never twice.
  [AlreadyPushed, ({ running, result }, { admin }) => (running
    ? "You already approved this push and it's still running, so I won't send it twice."
    : `You already approved this push, so it ran once and I won't send it again. ${pushResultText(result, { admin })}`)],
];

const num = (n) => Number(n).toLocaleString('en-US');

// A push's outcome in words (Story 10.3): honest counts, nothing partial
// called complete. result: { outcome, destination, listName, counts, retry }
// with counts { total, sent, already, skipped, failed } (whole numbers) and
// outcome one of
//   sent       the push went: sent new, already there, skipped, failed 0
//   replayed   the key was already used (the same list sent earlier today):
//              nothing new sent, never "Pushed n"
//   retried    a retry of the failed rows went (counts describe the retry)
//   partial    some failed (retry: a "Retry the failed ones" is offered;
//              retried: this was itself a retry)
//   stopped    it stopped partway or failed (an outage, a rejected sign-in,
//              a key reused with other rows, a kill switch flipped partway)
//   refused    a kill switch refused before anything was sent
function pushResultText(result, { admin = 'your admin' } = {}) {
  const r = result || {};
  const c = r.counts || {};
  const dest = escapeText(r.destination || 'the tool');
  const list = r.listName ? ` List: ${escapeText(r.listName)}.` : '';
  const skipped = num(c.skipped || 0);
  switch (r.outcome) {
    case 'sent':
      return `*Pushed ${num(c.sent || 0)} to ${dest}*${c.already ? ` (${num(c.already)} ${c.already === 1 ? 'was' : 'were'} already there)` : ''}, skipped ${skipped}, failed 0.${list}`;
    case 'retried':
      return `*Retried ${num(c.total || 0)} that failed: sent ${num(c.sent || 0)}, failed 0.*${c.already ? ` (${num(c.already)} ${c.already === 1 ? 'was' : 'were'} already there.)` : ''}${list}`;
    case 'replayed':
      return `*Already sent today; nothing new sent.* ${dest} already has this list with these rows, so I didn't send it again (skipped ${skipped}).${list}`;
    case 'partial':
      if (r.retried) {
        return `Retried ${num(c.total || 0)} that failed: sent ${num(c.sent || 0)}, failed ${num(c.failed || 0)}. `
          + (r.retry ? 'Nothing was sent twice, so trying again is safe: it sends only the ones that still failed.' : `Please tell ${admin} before trying again.`)
          + list;
      }
      return `Sent ${num(c.sent || 0)} of ${num((c.sent || 0) + (c.failed || 0))} to ${dest}; ${num(c.failed || 0)} failed, skipped ${skipped}. `
        + (r.retry ? 'Nothing was sent twice, so trying again is safe: it sends only the ones that failed.' : `Please tell ${admin} before trying again.`)
        + list;
    case 'refused':
      return `Nothing was sent to ${dest}: sending was switched off.${list}`;
    default:
      return `It didn't finish: ${num(c.sent || 0)} sent, ${num(c.failed || 0)} not sent, skipped ${skipped}. Please tell ${admin} before anyone tries again.${list}`;
  }
}

// Why a Push click made no preview (Story 10.2). Nothing was sent.
const PUSH_WORDS = Object.freeze({
  expired: "These results have expired (they're kept for 24 hours), so they can't be pushed and nothing was sent. Run the list again from the menu, then press Push.",
  not_delivered: "This list's CSV didn't reach you, so I won't push it: you'd be sending rows you haven't had in full. Nothing was sent. Run the list again from the menu.",
  empty: "This list has no rows, so there's nothing to push.",
});

// Hub wording (Story 6.4). A hub file may set its own welcome and feedback
// lines; these defaults keep a hub without them working.
function welcomeText(hub) {
  if (hub.welcome) return escapeText(hub.welcome);
  return `Welcome to ${escapeText(hub.name)}. Each option below opens one tool. `
    + 'Press Help at the bottom any time to see what you can use here and how to give feedback.';
}

function feedbackText(hub, admin) {
  if (hub.feedback) return escapeText(hub.feedback);
  return `To give feedback or ask for something new, tell ${admin}.`;
}

// The private welcome for a person who just joined the workspace. hubs: the
// hubs with at least one entry they can use; notice: the not-set-up line, if
// they have no profile user yet.
function joinWelcomeText({ client, hubs, notice, admin }) {
  const lines = [`Welcome to ${escapeText(client)}! I'm the ${escapeText(client)} bot.`];
  if (hubs.length) {
    const list = hubs.map((h) => `\`${h.command}\` (${escapeText(h.name)})`).join(', ');
    lines.push(`You can use ${list}. Type a command to see its menu, and press Help there for more.`);
  } else if (!notice) {
    lines.push(`There's nothing here for you to use yet; ask ${admin} if you need something.`);
  }
  if (notice) lines.push(notice);
  return lines.join('\n');
}

function messageFor(err, { admin = 'your admin' } = {}) {
  for (const [Kind, words] of MESSAGES) {
    if (err instanceof Kind) return words(err.details, { admin });
  }
  return null;
}

module.exports = {
  messageFor, escapeText, welcomeText, feedbackText, joinWelcomeText, pushResultText, READ_WORDS,
};
