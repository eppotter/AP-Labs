'use strict';

// Add a stop (Story 19.5, plan brightside-v1 D8): a fifth screen of the
// routing-map archetype (a module with screen "add-stop"). It is Plan a
// route's editor (./editor.js: step 1, Show stops, the list, the map,
// Optimize, Reset, the ⋯ moves) with one more button on the list, Add a
// stop, on the same audience (AD-R17, ./audience unchanged), sessions, hub
// listener and map lifecycle. Suggest only: nothing is saved or booked, and
// nothing goes to the LLM.
//
// Add a stop opens a form in place of the list's buttons (the list and its
// map stay; the ⋯ menus hide while it is open):
//   client   an external_select: the person types two or more letters of a
//            name and Slack asks the app (block_suggestion, the hub's
//            options listener, which re-checks access before anything here
//            runs) for the clients of the crew's zone whose name holds them:
//            suggest() reads adapter.clients({ day, crewId, query, scope })
//            and answers at most 20 options, "name · city", never an address
//   length   30 minutes to 4 hours, in steps of 15 (1 hour first)
//   window   Any time, Morning or Afternoon (the adapter's split of the day)
//   Add      adapter.addStop({ day, crewId, depot, scope, node, minutes,
//            window }) gives the crew's zone (a crew lead: only their crew)
//            from the Office with the new stop; the engine's insertStop puts
//            it at the cheapest place in the person's current order, marked
//            ➕, and names the two cheapest other crews of the zone (a crew
//            lead sees none). The list and the map follow.
//   Back to the day   closes the form; nothing changes
// On the list, Remove the added stop takes it out again (the day as it was
// before Add); Reset to booked keeps it, at the place insertStop chose.
//
// The search's option values are tokens ("o<n>") into what this session was
// offered, never a client or property id; a token it was not offered is
// refused. Add checks the client again through the adapter (in the crew's
// zone, no visit booked that day), so a forged token or a stale search adds
// nothing. Button values carry the list's version ("<version>:add"); a stale
// one is refused. Every refusal is logged by reason only; the search's text
// is never logged.
//
// Ways out: Back to the day (the form closes), the X and Back (the hub's
// view_closed: the session goes, and an Add still working finds it gone and
// shows nothing), no client found (Slack shows no results; Back to the day),
// the search failing (no options, logged by reason; Back to the day), a
// client that can't be added (the form says why), the day changed under the
// form (the form says so), an expired session or trigger (index.js and the
// hub: "This plan has expired"), a search from a session that has expired,
// is someone else's or has no form, or by a person who lost access (no
// options), a stop added then removed, and the error exit (a data or engine
// fault on Add: the form says so, and Back to the day).

const { escapeName, ADD_WORDS } = require('../../messages');
const { ADD_STOP_LENGTHS } = require('../../routing');
const audience = require('./audience');
const { dayWords, clock } = require('./views');

const SCREEN = 'add-stop';
const OWN = Object.freeze(['add', 'client', 'length', 'window', 'place', 'back', 'remove']);
const ACTIONS = Object.freeze(['crew', 'day', 'show', 'move', 'optimize', 'reset', 'change', ...OWN]);
const FORM = new Set(['client', 'length', 'window', 'place', 'back']);
const EDITOR_LIST = new Set(['move', 'optimize', 'reset', 'change']);
// The engine's own list, which adapters read through the sdk too.
const LENGTHS = ADD_STOP_LENGTHS;
const DEFAULT_MINUTES = 60;
const WINDOWS = Object.freeze({ any: 'Any time', morning: 'Morning', afternoon: 'Afternoon' });
const MAX_RESULTS = 20;
const MIN_QUERY = 2;
const MAX_QUERY = 50;
const MAX_OFFERED = 200;
const MAX_NAME = 100;
const MAX_OPTION_TEXT = 75;
const TOKEN = /^o[1-9][0-9]{0,8}$/;
const NODE = /^property:[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^([1-9][0-9]{0,8}):(add|place|back|remove)$/;
const MINUS = '−';
const SEP = ' · ';
const ADD_MARK = '➕';
const WARN = '⚠';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const plainText = (text) => ({ type: 'plain_text', text, emoji: false });
const cut = (s, max) => Array.from(String(s)).slice(0, max).join('');
const pad2 = (n) => String(n).padStart(2, '0');

// "45 min", "1 h", "1 h 15 min".
function lengthWords(m) {
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${pad2(m % 60)} min` : `${m / 60} h`;
}

// What a place adds to a crew's drive: "+9 min drive", "−3 min drive".
function driveDelta(m) {
  if (m > 0) return `+${m} min drive`;
  if (m < 0) return `${MINUS}${-m} min drive`;
  return 'no extra drive';
}

// "<version>:<what>" for a button, read back as { version, what } or null.
function parseValue(value) {
  if (typeof value !== 'string' || value.length > 20) return null;
  const m = VERSION.exec(value);
  return m ? { version: Number(m[1]), what: m[2] } : null;
}

// The search text: trimmed, at most 50 characters; null when shorter than 2.
function queryOf(value) {
  if (typeof value !== 'string') return null;
  const q = cut(value.trim().replace(/\s+/g, ' '), MAX_QUERY);
  return Array.from(q).length >= MIN_QUERY ? q : null;
}

// adapter.clients's answer: { clients: [{ node, clientName, city }] }, cut
// to 20. A node is a property; a name is short text; nothing else is kept.
function checkClients(got) {
  if (!isPlainObject(got) || !Array.isArray(got.clients)) throw new TypeError('adapter.clients: not a list');
  return got.clients.slice(0, MAX_RESULTS).map((c) => {
    if (!isPlainObject(c) || typeof c.node !== 'string' || !NODE.test(c.node)) throw new TypeError('adapter.clients: bad node');
    if (typeof c.clientName !== 'string' || !c.clientName.trim() || c.clientName.length > MAX_NAME) throw new TypeError('adapter.clients: bad name');
    if (c.city !== null && c.city !== undefined && (typeof c.city !== 'string' || c.city.length > MAX_NAME)) throw new TypeError('adapter.clients: bad city');
    const city = typeof c.city === 'string' && c.city.trim() ? c.city.trim() : null;
    return { node: c.node, text: cut(`${c.clientName.trim()}${city ? `${SEP}${city}` : ''}`, MAX_OPTION_TEXT) };
  });
}

const option = (value, text) => ({ text: plainText(text), value });
const button = (which, text, value, label) => ({
  type: 'button', action_id: `routing-map:${which}`, text: plainText(text), value, accessibility_label: label,
});

// The list's button that opens the form, or takes the added stop out.
function listButton(p) {
  const v = p.version;
  return p.added
    ? button('remove', 'Remove added stop', `${v}:remove`, 'Take the added stop out of the day')
    : button('add', 'Add a stop', `${v}:add`, 'Add a stop to this day and see where it fits');
}

// The form, in place of the list's buttons. Its block ids change with each
// draw (s.seq), so Slack shows the values given, not a stale choice.
function formBlocks(s) {
  const p = s.plan;
  const f = s.form;
  const v = p.version;
  const id = (name) => `routing-map:${name}:${v}:${s.seq}`;
  const lengths = LENGTHS.map((m) => option(String(m), lengthWords(m)));
  const windows = Object.entries(WINDOWS).map(([value, text]) => option(value, text));
  const client = {
    type: 'external_select',
    action_id: 'routing-map:client',
    placeholder: plainText('Search for a client'),
    min_query_length: MIN_QUERY,
    ...(f.client ? { initial_option: option(f.client.token, f.client.text) } : {}),
  };
  const words = [ADD_WORDS.form(escapeName(p.crewName), dayWords(p.day)), ...(f.note ? [f.note] : [])];
  return [
    { type: 'section', block_id: id('addform'), text: { type: 'mrkdwn', text: words.join('\n') } },
    {
      type: 'actions',
      block_id: id('addpick'),
      elements: [
        client,
        {
          type: 'static_select', action_id: 'routing-map:length', placeholder: plainText('Length'), options: lengths,
          initial_option: lengths.find((o) => o.value === String(f.minutes)),
        },
        {
          type: 'static_select', action_id: 'routing-map:window', placeholder: plainText('Start'), options: windows,
          initial_option: windows.find((o) => o.value === f.window),
        },
      ],
    },
    {
      type: 'actions',
      block_id: id('addgo'),
      elements: [
        { ...button('place', 'Add', `${v}:place`, 'Add this stop where it fits best'), style: 'primary' },
        button('back', 'Back to the day', `${v}:back`, 'Close the form; nothing changes'),
      ],
    },
    { type: 'context', block_id: id('addnote'), elements: [{ type: 'mrkdwn', text: ADD_WORDS.formNote() }] },
  ];
}

// The added stop's own lines in its row.
function addedLines(p, stopId) {
  if (!p.added || p.added.stopId !== stopId) return [];
  return [`${ADD_MARK} ${ADD_WORDS.added()}`, ...(p.added.fits ? [] : [`${WARN} ${ADD_WORDS.placedLast()}`])];
}

// The other crews line under the summary (a dispatcher's only), or null.
function othersBlock(p) {
  if (!p.added || !p.added.others) return null;
  const list = p.added.others.map((o) => ADD_WORDS.other(o.name, o.position, clock(o.start), driveDelta(o.drive)));
  const text = list.length ? ADD_WORDS.others(list.join('; ')) : ADD_WORDS.noOthers();
  return { type: 'context', block_id: `routing-map:others:${p.version}`, elements: [{ type: 'mrkdwn', text }] };
}

function createAddStop({
  log, sessions, adapterFor, editor,
}) {
  const refuse = (which, reason) => log.warn('routing map click refused', { action: which, reason });

  // Why this module cannot open (a fixed reason), or false.
  function unready(mod) {
    const why = editor.unready(mod);
    if (why) return why;
    let adapter;
    try {
      adapter = adapterFor(mod);
    } catch {
      return false; // Open's error exit says so.
    }
    return ['addStop', 'clients'].every((k) => typeof adapter[k] === 'function') ? false : 'the adapter has no addStop or clients()';
  }

  function forget(s) {
    s.form = null;
  }

  async function open({ mod, s, show }) {
    forget(s);
    s.offered = new Map();
    s.offerSeq = 0;
    await editor.open({ mod, s, show });
  }

  // A button's "<version>:<what>", checked against the list shown.
  function versionOk(which, action, p) {
    const got = parseValue(action && typeof action.value === 'string' ? action.value : null);
    if (!got || got.what !== which) {
      refuse(which, 'malformed');
      return false;
    }
    if (got.version !== p.version) {
      refuse(which, 'stale version');
      return false;
    }
    return true;
  }

  async function click({
    which, action, s, mod, show, showMap, showList, recheck,
  }) {
    const go = {
      mod, s, show, showMap, showList, recheck,
    };
    if (which === 'crew' || which === 'day' || which === 'show') {
      if (which === 'show' && s.step !== 2) forget(s);
      return editor.click({ which, action, ...go });
    }
    if (EDITOR_LIST.has(which)) {
      if (s.form) return refuse(which, 'form open');
      if (which === 'change') forget(s);
      return editor.click({ which, action, ...go });
    }
    const p = s.step === 2 ? s.plan : null;
    if (!p) return refuse(which, 'another step');
    if (p.out) return refuse(which, 'read only');
    if (which === 'add') {
      if (s.form || p.added) return refuse(which, 'another step');
      if (!versionOk(which, action, p)) return undefined;
      s.form = {
        client: null, minutes: DEFAULT_MINUTES, window: 'any', note: null,
      };
      log.info('routing map click', { module: mod.id, action: which, view: SCREEN });
      return editor.relist(go);
    }
    if (which === 'remove') {
      if (s.form || !p.added) return refuse(which, 'another step');
      if (!versionOk(which, action, p)) return undefined;
      log.info('routing map click', { module: mod.id, action: which, view: SCREEN });
      return editor.removeAdded(go);
    }
    if (!FORM.has(which)) return refuse(which, 'another screen');
    if (!s.form) return refuse(which, 'no form');
    const f = s.form;
    if (which === 'client') {
      const value = action && action.selected_option && action.selected_option.value;
      const offered = typeof value === 'string' && TOKEN.test(value) && s.offered instanceof Map ? s.offered.get(value) : undefined;
      if (!offered) return refuse(which, 'not offered');
      f.client = { token: value, node: offered.node, text: offered.text };
      f.note = null;
      sessions.next(s);
      log.info('routing map click', { module: mod.id, action: which, view: SCREEN });
      return undefined;
    }
    if (which === 'length') {
      const value = Number(action && action.selected_option && action.selected_option.value);
      if (!LENGTHS.includes(value)) return refuse(which, 'not offered');
      f.minutes = value;
      sessions.next(s);
      return undefined;
    }
    if (which === 'window') {
      const value = action && action.selected_option && action.selected_option.value;
      if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(WINDOWS, value)) return refuse(which, 'not offered');
      f.window = value;
      sessions.next(s);
      return undefined;
    }
    if (!versionOk(which, action, p)) return undefined;
    log.info('routing map click', { module: mod.id, action: which, view: SCREEN });
    if (which === 'back') {
      forget(s);
      return editor.relist(go);
    }
    // Add.
    if (!f.client) {
      f.note = ADD_WORDS.pickClient();
      return editor.relist(go);
    }
    f.note = null;
    return editor.addStop({
      ...go, node: f.client.node, minutes: f.minutes, window: f.window,
    });
  }

  // The search's options (block_suggestion), after the hub and index.js
  // have re-checked the person's access and scope. [] for anything refused.
  async function suggest({ mod, s, value }) {
    const p = s.step === 2 ? s.plan : null;
    if (!p || !s.form) {
      log.info('routing map search refused', { module: mod.id, reason: 'no form' });
      return [];
    }
    if (!audience.visible(s.scope, p.crewId)) {
      log.warn('routing map search refused', { module: mod.id, reason: 'not visible' });
      return [];
    }
    const query = queryOf(value);
    if (!query) return [];
    let found;
    try {
      found = checkClients(await adapterFor(mod).clients({
        day: p.day, crewId: p.crewId, query, scope: s.scope,
      }));
    } catch (err) {
      log.warn('routing map search failed', { module: mod.id, reason: (err && err.name) || 'error' });
      return [];
    }
    // The view closed, the session expired or the day changed meanwhile.
    if (!sessions.isCurrent(s, s.seq) || s.plan !== p || !s.form) {
      log.info('routing map search refused', { module: mod.id, reason: 'superseded' });
      return [];
    }
    if (!(s.offered instanceof Map)) s.offered = new Map();
    const out = found.map((c) => {
      s.offerSeq = (s.offerSeq || 0) + 1;
      const token = `o${s.offerSeq}`;
      s.offered.set(token, c);
      return option(token, c.text);
    });
    while (s.offered.size > MAX_OFFERED) s.offered.delete(s.offered.keys().next().value);
    log.info('routing map search', { module: mod.id, results: out.length });
    return out;
  }

  return {
    unready, open, click, suggest,
  };
}

module.exports = {
  createAddStop, formBlocks, addedLines, othersBlock, listButton, parseValue, queryOf, lengthWords, driveDelta,
  SCREEN, ACTIONS, LENGTHS, WINDOWS, MAX_RESULTS, ADD_MARK,
};
