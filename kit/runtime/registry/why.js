'use strict';

// The Why? screen (plan hub-status-menu, D7, Story 17.3). A menu row whose
// status is waiting shows Why? (<module-id>:why, ./menu WHY_ACTION) instead
// of its verb, since Slack has no disabled button. Its listener
// (kit/runtime/slack/hubs) re-checks the click, recomputes the tool's status
// (./status) and pushes this screen, titled with the tool's label. Pure: it
// reads nothing itself.
//
//   whyScreen({ mod, status, ready, admin, request })
//     -> { text, blocks, ephemeralFallback }
//
//   mod      the module the click names (its label, archetype and verb)
//   status   toolStatus() for it, recomputed at the click; null when it has
//            no status line (Add context whose notes couldn't be listed)
//   ready    readiness() for the module's hub: { data, rules }
//   admin    who to ask (Slack mrkdwn, access.adminContact)
//   request  the Request a tool module, when it is in this person's menu on
//            the same hub and is ready; else null
//
// What it says, in the existing words where they exist (D7's table), keyed
// by the waiting status's detail:
//   needs data          ASK_WORDS noDataNoRules, dataNoRules or rulesNoData,
//                       by the hub's readiness (a scoped pull, approval
//                       write or routing map on a hub with no data)
//   needs a channel     BUILD_REQUEST_WORDS.notSetUp(admin)
//   not on this hub     BUILD_REQUEST_WORDS.notOnThisHub
//   needs map setup     WHY_WORDS.noMap(admin)
//   needs the AI        WHY_WORDS.noAi(admin)
//   needs storage       add-context's NO_STORE(admin)
// A waiting detail with no words here (a status added later) says only the
// status line and the last line, never a guess.
//
// Then either Request (the Request a tool module's own <id>:open, pushed by
// the dispatcher as the third view, its access re-checked there; the form
// opens empty: nothing is carried into a post), or "Ask <admin> about it.".
// A tool no longer waiting (it became ready since the menu was built, or has
// no status line now): "This is ready now. Press Back, then <verb> it from
// the menu." Back is the view's own close (Slack's back arrow returns to the
// menu).
//
// Never more than the person could already see: the status line is the
// one their menu row showed (vocabulary statusText: the white dot and
// "needs data", subtle health), and the words name only whether the hub's
// data and rules are set up (the strip's counts, as yes or no), never a
// note, truth, rule or row. The listener shows it only to a person in the
// profile who has the row in their menu (the strip's audience, P1-1).
//
// ephemeralFallback: a click from an old message menu gets the same words
// as a private reply, with no buttons.

const { statusText, menuVerbOf } = require('./vocabulary');
const { openActionId } = require('./menu');
const {
  ASK_WORDS, BUILD_REQUEST_WORDS, WHY_WORDS, escapeName,
} = require('../messages');
const { NO_STORE } = require('../archetypes/add-context');

// The data words by the hub's readiness (D10 of plan brightside-v0).
function dataWords(ready) {
  if (ready && ready.data === true) return ASK_WORDS.dataNoRules();
  if (ready && ready.rules === true) return ASK_WORDS.rulesNoData();
  return ASK_WORDS.noDataNoRules();
}

// What a waiting tool is missing, or null when there are no words for it.
function reasonFor(detail, { ready, admin }) {
  switch (detail) {
    case 'needs data': return dataWords(ready);
    case 'needs a channel': return BUILD_REQUEST_WORDS.notSetUp(admin);
    case 'not on this hub': return BUILD_REQUEST_WORDS.notOnThisHub();
    case 'needs map setup': return WHY_WORDS.noMap(admin);
    case 'needs the AI': return WHY_WORDS.noAi(admin);
    case 'needs storage': return NO_STORE(admin);
    default: return null;
  }
}

const section = (blockId, text) => ({ type: 'section', block_id: blockId, text: { type: 'mrkdwn', text } });

function whyScreen({
  mod, status, ready, admin = 'your admin', request = null,
} = {}) {
  if (!mod || typeof mod !== 'object') throw new TypeError('whyScreen needs a module');
  const label = `*${escapeName(mod.label)}*`;
  if (!status || status.key !== 'waiting') {
    const words = WHY_WORDS.readyNow(menuVerbOf(mod));
    return { text: words, blocks: [section('why:status', `${label}\n${words}`)], ephemeralFallback: words };
  }
  const line = statusText(status);
  const reason = reasonFor(status.detail, { ready, admin });
  const blocks = [section('why:status', `${label}\n${line}`)];
  if (reason) blocks.push(section('why:reason', reason));
  const plain = [`${escapeName(mod.label)}: ${line}`, reason];
  if (request) {
    blocks.push({
      ...section('why:request', WHY_WORDS.request(request.label)),
      accessory: {
        type: 'button',
        action_id: openActionId(request.id),
        value: request.id,
        text: { type: 'plain_text', text: menuVerbOf(request), emoji: false },
      },
    });
    plain.push(WHY_WORDS.requestInWindow(request.label));
  } else {
    blocks.push(section('why:ask', WHY_WORDS.askAdmin(admin)));
    plain.push(WHY_WORDS.askAdmin(admin));
  }
  const text = plain.filter(Boolean).join('\n');
  return { text, blocks, ephemeralFallback: text };
}

module.exports = { whyScreen, reasonFor };
