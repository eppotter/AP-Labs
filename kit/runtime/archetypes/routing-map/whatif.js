'use strict';

// The what-if screens (Story 19.4, plan brightside-v1 D8): Customer
// cancellation (a module with screen "cancellation") and Crew out (screen
// "crew-out"), two more screens of the routing-map archetype, on the same
// audience (AD-R17, ./audience unchanged), sessions, hub listener and map
// lifecycle. Suggest only: nothing is written, and nothing goes to the LLM.
// One view, updated in place (never views.push).
//
// Customer cancellation, four stages:
//   pick    a crew select (a crew lead: only their own), a date picker (the
//           archetype's day range) and Show visits
//   visit   "Which visit cancels?": a select of the crew's visits that day
//           (each "hh:mm · client name", "(cancelled)" when the data already
//           shows it cancelled; never an address), Change crew or day. The
//           visits come from adapter.visits({ day, crewId, scope }) and their
//           names from adapter.labels (the crew lead's own crew only)
//   result  picking a visit draws Routing's Gap fill view for that crew and
//           day with the visit taken as cancelled (adapter.gapFor({ day,
//           crewId, stopId, scope }), the gap the visit leaves): the top
//           five candidates with their reasons, and Fill with #1..#n, Pick
//           another visit and Change crew or day. A day with no candidate
//           says so ("No visit can be moved up into this gap.")
//   edit    Fill with #n: Plan a route's step 2 (./editor showFill) on the
//           crew's day with candidate n in the gap (adapter.route with
//           fill), its row marked "↩️ Moved up from <day>"; Optimize, Reset
//           and the ⋯ moves work as in Plan a route
// Crew out, two stages:
//   pick    a crew select, a date picker and Mark out for the day
//   result  Routing's Route change view for the crew's zone (a crew lead:
//           their crew) with that crew out (adapter.crewOut({ day, crewId,
//           scope }) sets it available false); a crew the data already shows
//           out says so above the same view; Change crew or day
//
// Reads, as Routing's views and Plan a route read them: the scope first
// (from the audience, never from the click), then the adapter, then the
// labels for only the node ids the scope may see. Values the clicks carry
// are indexes into what the session holds ("<seq>:<index>" for a visit,
// "<seq>:<rank>" for a fill), never a stop id; a stale seq, an index out of
// range or a malformed value is refused, nothing changes and the refusal is
// logged by reason only.
//
// Ways out: Back and the X (the hub's view_closed: the session and its map
// files go, and a draw still running finds its session gone and shows
// nothing), Change crew or day (back to pick, from every later stage), Pick
// another visit (back to visit, no read), an error (a plain message: Back),
// an expired session or trigger (index.js and the hub), access withdrawn
// (the refusal), a click from someone else's view (index.js), no visits
// ("no visit can cancel"), a crew not working that day, and the map not
// ready (unready: the menu's Why?).

const { RoutingFault, ConfigFault } = require('../../errors');
const {
  messageFor, escapeText, MAP_WORDS, ROUTE_WORDS, WHATIF_WORDS,
} = require('../../messages');
const { textBlocks } = require('../../slack/format');
const audience = require('./audience');
const { namer, dayWords, clock } = require('./views');

const CANCELLATION = 'cancellation';
const CREW_OUT = 'crew-out';
const SCREENS = Object.freeze([CANCELLATION, CREW_OUT]);
const ACTIONS = Object.freeze({
  [CANCELLATION]: Object.freeze(['crew', 'day', 'show', 'visit', 'fill', 'again', 'change', 'move', 'optimize', 'reset']),
  [CREW_OUT]: Object.freeze(['crew', 'day', 'out', 'change']),
});
// Each screen's first-step button.
const GO = Object.freeze({
  [CANCELLATION]: Object.freeze({
    action: 'show', text: 'Show visits', label: "Show this crew's visits on this day", words: WHATIF_WORDS.pickVisits,
  }),
  [CREW_OUT]: Object.freeze({
    action: 'out', text: 'Mark out for the day', label: 'See the day with this crew out', words: WHATIF_WORDS.pickOut,
  }),
});
const EDIT_ACTIONS = new Set(['move', 'optimize', 'reset']);
const MAX_OPTIONS = 100;
const MAX_OPTION_TEXT = 75;
const MAX_STOP_ID = 128;
const MAX_VISITS = 200;
const DAY_MINUTES = 24 * 60;
const SEP = ' · ';
// A visit select option's value, or a Fill button's: "<seq>:<index>".
const PICK = /^([1-9][0-9]{0,8}):(0|[1-9][0-9]{0,2})$/;
const MAX_PICK = 16;

const fault = (field, problem) => new RoutingFault({ field, problem });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const plainText = (text) => ({ type: 'plain_text', text, emoji: false });
const cut = (s, max) => Array.from(String(s)).slice(0, max).join('');
const crewNode = (crewId) => `crew:${crewId}`;
const unique = (list) => [...new Set(list)];

function parsePick(value) {
  if (typeof value !== 'string' || value.length > MAX_PICK) return null;
  const m = PICK.exec(value);
  return m ? { seq: Number(m[1]), index: Number(m[2]) } : null;
}

// adapter.visits's answer: { known, visits: [{ stopId, node, start, cancelled }] }.
function checkVisits(got) {
  if (!isPlainObject(got) || typeof got.known !== 'boolean' || !Array.isArray(got.visits)) throw fault('adapter.visits', 'not_object');
  if (got.visits.length > MAX_VISITS) throw fault('adapter.visits', 'too_long');
  for (const v of got.visits) {
    if (!isPlainObject(v) || typeof v.stopId !== 'string' || !v.stopId || v.stopId.length > MAX_STOP_ID) throw fault('adapter.visits.stopId', 'not_text');
    if (typeof v.node !== 'string' || !v.node) throw fault('adapter.visits.node', 'not_text');
    if (!Number.isSafeInteger(v.start) || v.start < 0 || v.start > DAY_MINUTES) throw fault('adapter.visits.start', 'not_integer');
    if (typeof v.cancelled !== 'boolean') throw fault('adapter.visits.cancelled', 'not_boolean');
  }
  return got;
}

const hasFns = (adapter, names) => isPlainObject(adapter) && names.every((k) => typeof adapter[k] === 'function');
const NEEDS = Object.freeze({ [CANCELLATION]: ['visits', 'gapFor'], [CREW_OUT]: ['crewOut'] });

function createWhatIf({
  log, admin, sessions, adapterFor, checkLabels, editor, draw, withModal, inRange, failureText,
}) {
  const message = (s, blocks) => withModal(s, { blocks });
  const refuse = (which, reason) => log.warn('routing map click refused', { action: which, reason });
  const button = (which, text, value, label) => ({
    type: 'button', action_id: `routing-map:${which}`, text: plainText(text), value, accessibility_label: label,
  });
  const changeButton = () => button('change', 'Change crew or day', 'change', 'Change the crew or the day');
  const crewIdOf = (s) => (s.scope.all !== true ? s.scope.crewId : s.picks.crew);
  // The picked crew's name for mrkdwn: the select's own label (a safe one).
  const crewWords = (s, crewId) => {
    const o = (s.crews || []).find((c) => c.value === crewId);
    return escapeText(o ? o.text : `Crew ${crewId}`);
  };

  // Why this module cannot open (a fixed reason), or false.
  function unready(mod) {
    if (mod.screen === CANCELLATION) {
      // Fill with #n shows the day in Plan a route's editor: it needs the Office.
      const why = editor.unready(mod);
      if (why) return why;
    }
    let adapter;
    try {
      adapter = adapterFor(mod);
    } catch {
      return false; // Open's error exit says so.
    }
    return hasFns(adapter, NEEDS[mod.screen]) ? false : `the adapter has no ${NEEDS[mod.screen].join(' or ')}()`;
  }

  // --- pick ---------------------------------------------------------------------------

  function pickStep(s, words) {
    const go = GO[s.screen];
    const list = (s.crews || []).slice(0, MAX_OPTIONS);
    const elements = [];
    if (list.length) {
      const initial = list.find((o) => o.value === s.picks.crew);
      const option = (o) => ({ text: plainText(cut(o.text, MAX_OPTION_TEXT)), value: o.value });
      elements.push({
        type: 'static_select', action_id: 'routing-map:crew', placeholder: plainText('Crew'),
        options: list.map(option), ...(initial ? { initial_option: option(initial) } : {}),
      });
    }
    elements.push({ type: 'datepicker', action_id: 'routing-map:day', placeholder: plainText('Day'), initial_date: s.picks.day });
    elements.push({ ...button(go.action, go.text, go.action, go.label), style: 'primary' });
    return message(s, [
      { type: 'section', block_id: `routing-map:intro:${s.seq}`, text: { type: 'mrkdwn', text: words || go.words() } },
      { type: 'actions', block_id: `routing-map:pick:${s.seq}`, elements },
      { type: 'context', block_id: `routing-map:days:${s.seq}`, elements: [{ type: 'mrkdwn', text: `Days from ${s.range.from} to ${s.range.to}. ${WHATIF_WORDS.suggestOnly()}` }] },
    ]);
  }

  // Words with Change crew or day under them.
  function plainStep(s, words) {
    return message(s, [
      { type: 'section', block_id: `routing-map:plain:${s.seq}`, text: { type: 'mrkdwn', text: words } },
      { type: 'actions', block_id: `routing-map:plainact:${s.seq}`, elements: [changeButton()] },
    ]);
  }

  const configRefusal = (mod) => {
    log.error('routing map refused', { module: mod.id, reason: 'the crew lead has no crew' });
    return messageFor(new ConfigFault({ admin }));
  };

  function reset(s) {
    s.stage = 'pick';
    s.step = 1;
    s.plan = null;
    s.visits = null;
    s.picked = null;
    s.fills = null;
  }

  async function open({ mod, s, show }) {
    reset(s);
    let got;
    try {
      got = await editor.crewChoices(mod, s, s.picks.day);
    } catch (err) {
      s.stage = 'error';
      await show(message(s, textBlocks(failureText(mod, mod.screen, err))));
      return;
    }
    if (got.config) {
      s.stage = 'error';
      await show(message(s, textBlocks(configRefusal(mod))));
      return;
    }
    editor.takeCrews(s, got);
    await show(pickStep(s));
  }

  async function dayPicked({
    mod, s, day, number, show,
  }) {
    const current = () => sessions.isCurrent(s, number);
    s.picks.day = day;
    let got;
    try {
      got = await editor.crewChoices(mod, s, day);
    } catch (err) {
      const words = failureText(mod, mod.screen, err);
      if (!current()) return;
      s.stage = 'error';
      await show(message(s, textBlocks(words)), { current });
      return;
    }
    if (!current()) {
      log.info('map superseded', { module: mod.id, step: 'crews' });
      return;
    }
    if (got.config) {
      s.stage = 'error';
      await show(message(s, textBlocks(configRefusal(mod))), { current });
      return;
    }
    editor.takeCrews(s, got);
    await show(pickStep(s), { current });
  }

  // --- Customer cancellation ------------------------------------------------------------

  // The crew's visits that day, named, or { plain } words.
  async function loadVisits(mod, s, crewId) {
    const { scope } = s;
    const { day } = s.picks;
    // The scope decides (AD-R17): a crew lead's crewId is their own.
    if (!audience.visible(scope, crewId)) throw fault('crewId', 'not_visible');
    const adapter = adapterFor(mod);
    const got = checkVisits(await adapter.visits({ day, crewId, scope }));
    const nodes = unique([crewNode(crewId), ...got.visits.map((v) => v.node)]);
    const labels = checkLabels(await adapter.labels({ day, nodeIds: nodes, scope }), nodes);
    const n = namer(labels);
    const when = dayWords(day);
    if (!got.known) return { plain: ROUTE_WORDS.notWorking(n.crew(crewId), when) };
    if (!got.visits.length) return { plain: WHATIF_WORDS.noVisits(n.crew(crewId), when) };
    const visits = [...got.visits].sort((a, b) => a.start - b.start || (a.stopId < b.stopId ? -1 : a.stopId > b.stopId ? 1 : 0))
      .slice(0, MAX_OPTIONS)
      .map((v) => {
        const name = (labels.get(v.node) || {}).clientName;
        const client = typeof name === 'string' && name.trim() ? name.trim() : 'a stop';
        return {
          stopId: v.stopId,
          start: v.start,
          cancelled: v.cancelled,
          // The select's plain text, and the same name for mrkdwn.
          option: `${clock(v.start)}${SEP}${client}${v.cancelled ? ' (cancelled)' : ''}`,
          client: escapeText(client),
        };
      });
    return { visits, crew: n.crew(crewId) };
  }

  function visitStep(s) {
    const options = s.visits.map((v, i) => ({ text: plainText(cut(v.option, MAX_OPTION_TEXT)), value: `${s.visitsSeq}:${i}` }));
    return message(s, [
      { type: 'section', block_id: `routing-map:which:${s.seq}`, text: { type: 'mrkdwn', text: WHATIF_WORDS.whichVisit(s.visitsCrew, dayWords(s.picks.day)) } },
      {
        type: 'actions',
        block_id: `routing-map:visits:${s.seq}`,
        elements: [
          {
            type: 'static_select', action_id: 'routing-map:visit', placeholder: plainText('Visit that cancels'), options,
          },
          changeButton(),
        ],
      },
      { type: 'context', block_id: `routing-map:note:${s.seq}`, elements: [{ type: 'mrkdwn', text: WHATIF_WORDS.suggestOnly() }] },
    ]);
  }

  async function showVisits({ mod, s, show }) {
    const number = sessions.next(s);
    const current = () => sessions.isCurrent(s, number);
    const crewId = crewIdOf(s);
    if (typeof crewId !== 'string' || !crewId) {
      log.info('routing map click refused', { action: 'show', reason: 'no crew' });
      await show(pickStep(s, WHATIF_WORDS.pickCrew(GO[s.screen].text)), { current });
      return;
    }
    let got;
    try {
      got = await loadVisits(mod, s, crewId);
    } catch (err) {
      const words = failureText(mod, mod.screen, err);
      if (!current()) return;
      s.stage = 'error';
      await show(message(s, textBlocks(words)), { current });
      return;
    }
    if (!current()) {
      log.info('map superseded', { module: mod.id, step: 'visits' });
      return;
    }
    if (got.plain) {
      s.stage = 'plain';
      await show(plainStep(s, got.plain), { current });
      return;
    }
    s.stage = 'visit';
    s.visits = got.visits;
    s.visitsSeq = number;
    s.visitsCrew = got.crew;
    log.info('routing map click', { module: mod.id, action: 'show', view: mod.screen });
    await show(visitStep(s), { current });
  }

  // The head of the gap view: what was asked, and its buttons. fills: the
  // candidates shown (by rank), or null before they are known.
  function cancelHead(s, fills, seq) {
    const v = s.picked;
    const title = v.cancelled ? WHATIF_WORDS.cancelled(v.client, clock(v.start)) : WHATIF_WORDS.cancels(v.client, clock(v.start));
    const list = fills || [];
    const lines = [title, ...(list.length ? [WHATIF_WORDS.fillHelp()] : [])];
    return [
      { type: 'section', block_id: `routing-map:whatif:${seq}`, text: { type: 'mrkdwn', text: lines.join('\n') } },
      {
        type: 'actions',
        block_id: `routing-map:fills:${seq}`,
        elements: [
          // fill-<rank>: each action_id in a block must be unique.
          ...list.map((f) => button(`fill-${f.rank}`, `Fill with #${f.rank}`, `${seq}:${f.rank}`, `Show the day with visit ${f.rank} moved up into the gap`)),
          button('again', 'Pick another visit', 'again', 'Pick another visit that cancels'),
          changeButton(),
        ],
      },
    ];
  }

  async function pickVisit({
    mod, s, action, show, showMap, recheck,
  }) {
    const option = action && action.selected_option;
    const got = parsePick(option && option.value);
    if (!got) return refuse('visit', 'malformed');
    if (got.seq !== s.visitsSeq) return refuse('visit', 'stale version');
    if (got.index >= s.visits.length) return refuse('visit', 'out of range');
    const visit = s.visits[got.index];
    const crewId = crewIdOf(s);
    const { day } = s.picks;
    const { scope } = s;
    s.picked = visit;
    s.fills = null;
    s.stage = 'result';
    const number = sessions.next(s);
    const current = () => sessions.isCurrent(s, number);
    log.info('routing map click', { module: mod.id, action: 'visit', view: mod.screen });
    await show(message(s, [...cancelHead(s, null, number), ...textBlocks(MAP_WORDS.drawing())]), { current });
    await draw({
      mod,
      s,
      number,
      show,
      showMap,
      recheck,
      what: {
        view: 'gap',
        source: (adapter) => {
          if (typeof adapter.gapFor !== 'function') throw fault('adapter.gapFor', 'not_function');
          return adapter.gapFor({
            day, crewId, stopId: visit.stopId, scope,
          });
        },
        pick: () => ({ kind: 'crew', id: crewId }),
        focus: visit.stopId,
        missing: () => ROUTE_WORDS.notWorking(crewWords(s, crewId), dayWords(day)),
        head: ({ plan, seq }) => cancelHead(s, plan && plan.fills ? plan.fills : null, seq),
      },
    });
    return undefined;
  }

  async function fill({
    mod, s, action, show, showMap, showList, recheck,
  }) {
    const got = parsePick(action && typeof action.value === 'string' ? action.value : null);
    if (!got) return refuse('fill', 'malformed');
    if (got.seq !== s.fillsSeq) return refuse('fill', 'stale version');
    const chosen = (s.fills || []).find((f) => f.rank === got.index);
    if (!chosen) return refuse('fill', 'out of range');
    s.stage = 'edit';
    log.info('routing map click', { module: mod.id, action: 'fill', view: mod.screen });
    return editor.showFill({
      mod, s, show, showMap, showList, recheck, fill: { cancel: s.picked.stopId, add: chosen.stopId, from: chosen.plannedDate },
    });
  }

  // --- Crew out -----------------------------------------------------------------------

  function outHead(s, crewId, wasOut, seq) {
    const words = wasOut ? WHATIF_WORDS.alreadyOut : WHATIF_WORDS.out;
    return [
      { type: 'section', block_id: `routing-map:whatif:${seq}`, text: { type: 'mrkdwn', text: words(crewWords(s, crewId), dayWords(s.picks.day)) } },
      { type: 'actions', block_id: `routing-map:outact:${seq}`, elements: [changeButton()] },
    ];
  }

  async function markOut({
    mod, s, show, showMap, recheck,
  }) {
    const crewId = crewIdOf(s);
    const number = sessions.next(s);
    const current = () => sessions.isCurrent(s, number);
    if (typeof crewId !== 'string' || !crewId) {
      log.info('routing map click refused', { action: 'out', reason: 'no crew' });
      await show(pickStep(s, WHATIF_WORDS.pickCrew(GO[s.screen].text)), { current });
      return;
    }
    const { day } = s.picks;
    const { scope } = s;
    const lead = scope.all !== true;
    s.stage = 'result';
    log.info('routing map click', { module: mod.id, action: 'out', view: mod.screen });
    await show(message(s, [...outHead(s, crewId, false, number), ...textBlocks(MAP_WORDS.drawing())]), { current });
    await draw({
      mod,
      s,
      number,
      show,
      showMap,
      recheck,
      what: {
        view: 'change',
        source: (adapter) => {
          if (typeof adapter.crewOut !== 'function') throw fault('adapter.crewOut', 'not_function');
          return adapter.crewOut({ day, crewId, scope });
        },
        // A crew lead's view is their crew; a dispatcher's, the crew's zone.
        pick: (input) => {
          const crew = input.crews.find((c) => c.crewId === crewId);
          if (!crew) return null;
          return lead ? { kind: 'crew', id: scope.crewId } : { kind: 'zone', id: crew.zoneId };
        },
        missing: () => ROUTE_WORDS.notWorking(crewWords(s, crewId), dayWords(day)),
        head: ({ got, seq }) => outHead(s, crewId, Boolean(got && got.wasOut === true), seq),
      },
    });
  }

  // --- clicks -----------------------------------------------------------------------

  async function click({
    which, action, s, mod, show, showMap, showList, recheck,
  }) {
    const go = GO[s.screen];
    if (which === 'crew' || which === 'day' || which === go.action) {
      if (s.stage !== 'pick') return refuse(which, 'another step');
      if (which === 'crew') {
        const v = action && action.selected_option && action.selected_option.value;
        if (s.scope.all !== true) {
          // A crew lead's crew comes from the scope; the pick is ignored.
          sessions.next(s);
          return undefined;
        }
        if (!(s.crews || []).some((c) => c.value === v)) return refuse(which, 'unknown crew');
        s.picks.crew = v;
        sessions.next(s);
        log.info('routing map click', { module: mod.id, action: which, view: mod.screen });
        return undefined;
      }
      if (which === 'day') {
        const day = action && action.selected_date;
        const number = sessions.next(s);
        if (!inRange(day, s.range)) {
          log.info('routing map click refused', { action: which, reason: 'day out of range' });
          await show(pickStep(s, MAP_WORDS.badDate(s.range.from, s.range.to)), { current: () => sessions.isCurrent(s, number) });
          return undefined;
        }
        log.info('routing map click', { module: mod.id, action: which, view: mod.screen });
        return dayPicked({
          mod, s, day, number, show,
        });
      }
      if (s.screen === CANCELLATION) return showVisits({ mod, s, show });
      return markOut({
        mod, s, show, showMap, recheck,
      });
    }
    if (which === 'change') {
      if (s.stage === 'pick') return refuse(which, 'another step');
      const number = sessions.next(s);
      reset(s);
      log.info('routing map click', { module: mod.id, action: which, view: mod.screen });
      await show(pickStep(s), { current: () => sessions.isCurrent(s, number) });
      return undefined;
    }
    if (EDIT_ACTIONS.has(which)) {
      if (s.stage !== 'edit') return refuse(which, 'another step');
      return editor.click({
        which, action, s, mod, show, showMap, showList, recheck,
      });
    }
    if (which === 'visit') {
      if (s.stage !== 'visit') return refuse(which, 'another step');
      return pickVisit({
        mod, s, action, show, showMap, recheck,
      });
    }
    if (which === 'again') {
      if (s.stage !== 'result' || !s.visits) return refuse(which, 'another step');
      const number = sessions.next(s);
      s.stage = 'visit';
      s.picked = null;
      s.fills = null;
      log.info('routing map click', { module: mod.id, action: which, view: mod.screen });
      await show(visitStep(s), { current: () => sessions.isCurrent(s, number) });
      return undefined;
    }
    if (which === 'fill') {
      if (s.stage !== 'result') return refuse(which, 'another step');
      return fill({
        mod, s, action, show, showMap, showList, recheck,
      });
    }
    return refuse(which, 'another screen');
  }

  return { unready, open, click };
}

module.exports = {
  createWhatIf, parsePick, SCREENS, ACTIONS, CANCELLATION, CREW_OUT,
};
