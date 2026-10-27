'use strict';

// The routing-map archetype (Story 15.4, AD-R12, R15, R16, R17): a Routing
// entry on a hub menu that opens a modal with a plain map of a crew's day and
// a short text list under it, and a view select, a date picker and a crew or
// zone select that redraw it in place. Suggest only: nothing is written, and
// nothing goes to the LLM (this archetype is never given it).
//
// The module (kit/runtime/registry) is a manifest with archetype
// "routing-map" and an adapter file in its folder that exports
// createAdapter({ data, routing }) returning (AD-R16, F8):
//   asOf()                      the ISO date the data is as of, read once on
//                               Open (it bounds the date picker)
//   input({ day, view, scope }) { input, travel }: the engine's input
//                               contract (AD-R2) for that day and view, and
//                               the travel function (kit/runtime/routing
//                               travel.fromMatrix). change: the day with the
//                               crews that are out (available false); gap:
//                               plus cancelled[] and candidates[]. scope is
//                               the person's (AD-R17); a route change or gap
//                               fill needs other crews, so those are not cut
//   labels({ day, nodeIds, scope })  per node id { crewName?, clientName?,
//                               city? } and nothing else (any other field is
//                               refused here), its SQL filtered by scope
// data is the app's full data object (kit/runtime/data createData); the
// adapter gets it, and only this archetype reads pixel positions from it
// (kit/runtime/data/map mapPoints, AD-R13).
//
// The hub (kit/runtime/slack/hubs) owns Slack: it pushes the view with
// "Loading…" inside the trigger's life, then calls open(); each select click
// is acked, then click() runs. Both get
//   show(message, { current }?)      a plain message rendered into the view
//                                    (the hub deletes the view's earlier map
//                                    files once it shows); with current, the
//                                    hub skips it if current() is false when
//                                    its turn to show comes
//   showMap(message, { current })    the map: the hub's one lifecycle
//                                    (upload, record, show, replace or
//                                    delete, AD-R15), which asks current()
//                                    before it uploads and before it shows
// Every message carries modal options from viewModal(sessionId): the map
// view's callback (view_closed), and the session id as private_metadata.
//
// A draw, in this order (filtering before any position or name is read,
// AD-R17): the scope from the audience (never from the click), the adapter's
// input, the configuration check of a crew lead's crew, the engine
// (./views), the labels for the node ids that scope may see, mapPoints for
// only those ids, the renderer (kit/runtime/routing-map), then showMap. The
// points and the SVG stay in this function: never logged, kept or sent. Logs
// carry the module, the view and fixed reasons only. mapPoints also returns
// the tile mosaic under the points (Story 15.8, AD-R20): tile numbers are
// rough locations, so the mosaic goes nowhere yet, not to the renderer, the
// logs, Slack or an error (Story 15.10 passes it to the tile fetcher only).
//
// Exits: Back and Close (view_closed, else the sweep: the hub), an error (a
// plain message in the view, with Back), an expired trigger (the hub's
// path), an expired session ("this map has expired"), access withdrawn
// mid-session (the refusal in the view), a click from someone else's view
// (refused, nothing changes).

const { DataUnavailable, ConfigFault, AccessDenied, RoutingFault } = require('../../errors');
const { messageFor, escapeText, MAP_WORDS } = require('../../messages');
const { textBlocks } = require('../../slack/format');
const { altText, ImageError } = require('../../slack/image');
const { renderPng } = require('../../routing-map');
const { mapPoints: readPoints } = require('../../data/map');
const audience = require('./audience');
const {
  planView, choices, resolvePick, pickKind, namer, zoneLabel, textOf, VIEWS, VIEW_LABELS, FRAME,
} = require('./views');
const { createSessions, STATUS } = require('./session');

const ARCHETYPE = 'routing-map';
const ACTIONS = Object.freeze(['view', 'day', 'crew', 'zone']);
const ACTION_PATTERN = /^routing-map:(view|day|crew|zone)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_DAYS = 7;
const MAX_OPTIONS = 100;
const MAX_OPTION_TEXT = 75;
const MAX_LABEL = 100;
const LABEL_KEYS = Object.freeze(['crewName', 'clientName', 'city']);
const RENDER_PROBLEMS = new Set(['renderer_unavailable', 'renderer_failed', 'image_too_large', 'unsafe_svg']);

// --- dates, by arithmetic on the calendar alone -----------------------------------

function isRealDate(s) {
  const m = typeof s === 'string' ? ISO_DATE.exec(s) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

// The days the date picker may name: [asOf - 7, asOf + horizon_days] (F17).
function dayRange(asOf, horizonDays) {
  return { from: addDays(asOf, -PAST_DAYS), to: addDays(asOf, horizonDays) };
}

const inRange = (day, range) => isRealDate(day) && day >= range.from && day <= range.to;

// --- the controls -------------------------------------------------------------------

const plainText = (text) => ({ type: 'plain_text', text, emoji: false });
const cut = (s, max) => Array.from(String(s)).slice(0, max).join('');
const option = (value, text) => ({ text: plainText(cut(text, MAX_OPTION_TEXT)), value });

// The selects (in an actions block: an input block would need a submit) and
// a line naming the days the picker may show. block_id changes with each
// draw, so Slack shows the initial values given, not a stale choice.
function controls({ picks, options, range, scope, seq }) {
  const kind = pickKind(picks.view, scope);
  const list = (kind === 'zone' ? options.zones : options.crews).slice(0, MAX_OPTIONS);
  const current = kind === 'zone' ? picks.zone : picks.crew;
  const elements = [
    {
      type: 'static_select', action_id: 'routing-map:view', placeholder: plainText('View'),
      options: VIEWS.map((v) => option(v, VIEW_LABELS[v])), initial_option: option(picks.view, VIEW_LABELS[picks.view]),
    },
    {
      type: 'datepicker', action_id: 'routing-map:day', placeholder: plainText('Day'), initial_date: picks.day,
    },
  ];
  if (list.length) {
    const initial = list.find((o) => o.value === current);
    elements.push({
      type: 'static_select', action_id: `routing-map:${kind}`, placeholder: plainText(kind === 'zone' ? 'Zone' : 'Crew'),
      options: list.map((o) => option(o.value, o.text)), ...(initial ? { initial_option: option(initial.value, initial.text) } : {}),
    });
  }
  return [
    { type: 'actions', block_id: `routing-map:controls:${seq}`, elements },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Days from ${range.from} to ${range.to}. Suggestions only: nothing is changed.` }] },
  ];
}

// --- checking what the adapter gives back ----------------------------------------------

const fault = (field, problem) => new RoutingFault({ field, problem });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkAdapter(adapter) {
  if (!isPlainObject(adapter) || !['asOf', 'input', 'labels'].every((k) => typeof adapter[k] === 'function')) {
    throw fault('adapter', 'not_function');
  }
  return adapter;
}

function checkInput(got) {
  if (!isPlainObject(got) || !isPlainObject(got.input)) throw fault('adapter.input', 'not_object');
  if (typeof got.travel !== 'function') throw fault('adapter.travel', 'not_function');
  return got;
}

// labels: an object (or Map) keyed by node id, each holding only crewName,
// clientName and city as short text, for node ids that were asked for.
function checkLabels(raw, asked) {
  const entries = raw instanceof Map ? [...raw.entries()] : isPlainObject(raw) ? Object.entries(raw) : null;
  if (!entries) throw fault('labels', 'not_object');
  const want = new Set(asked);
  const out = new Map();
  for (const [node, value] of entries) {
    if (!want.has(node)) throw fault('labels', 'unknown_key');
    if (!isPlainObject(value)) throw fault('labels', 'not_object');
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      if (!LABEL_KEYS.includes(k)) throw fault('labels', 'unknown_key');
      if (v === null || v === undefined) continue;
      if (typeof v !== 'string' || v.length > MAX_LABEL) throw fault('labels', 'not_text');
      clean[k] = v;
    }
    out.set(node, Object.freeze(clean));
  }
  return out;
}

const unique = (list) => [...new Set(list)];

// --- the archetype ---------------------------------------------------------------------

function createRoutingMap({
  profile, data, log, admin = 'your admin', viewModal = () => undefined,
  mapPoints = readPoints, render = renderPng, now = () => Date.now(),
}) {
  const sessions = createSessions({ now });
  const adapters = new Map(); // module id -> adapter
  const routing = (profile && profile.routing) || null;
  const gapFill = (routing && routing.gap_fill) || { horizon_days: 14, limit: 5 };

  function adapterFor(mod) {
    if (!data) throw new DataUnavailable('no data source');
    if (!adapters.has(mod.id)) {
      if (typeof mod.createAdapter !== 'function') throw fault('adapter', 'not_function');
      adapters.set(mod.id, checkAdapter(mod.createAdapter({ data, routing })));
    }
    return adapters.get(mod.id);
  }

  const withModal = (s, message) => (s ? { ...message, modal: viewModal(s.id) } : message);
  const textMessage = (s, text, head = []) => withModal(s, { blocks: [...head, ...textBlocks(text)] });
  const headOf = (s) => (s && s.options && s.range ? controls({
    picks: s.picks, options: s.options, range: s.range, scope: s.scope, seq: s.seq,
  }) : []);

  // A refused scope as words, logged with a reason (never the person).
  function refusalText(mod, refused) {
    if (refused.refusal === 'denied') return messageFor(new AccessDenied({ label: mod.label, admin }));
    log.error('routing map refused', { module: mod.id, reason: refused.reason });
    return messageFor(new ConfigFault({ admin }));
  }

  // An error from a draw as the plain message the view shows.
  function failureText(mod, view, err) {
    if (err instanceof DataUnavailable || (err && err.code === 'DATA_UNAVAILABLE')
      || (err instanceof RoutingFault && err.details.problem === 'data_unavailable')) {
      log.warn('data unavailable', { module: mod.id, view, reason: err instanceof RoutingFault ? 'map read' : String(err.reason || 'unavailable') });
      return messageFor(new DataUnavailable('routing map'));
    }
    if (err instanceof RoutingFault) {
      const { field, problem } = err.details;
      log.error('routing map not drawn', { module: mod.id, view, field: String(field), problem });
      return RENDER_PROBLEMS.has(problem) ? MAP_WORDS.drawFailed(admin) : MAP_WORDS.planFailed(admin);
    }
    if (err instanceof ImageError) {
      log.error('routing map not drawn', { module: mod.id, view, reason: err.reason });
      return MAP_WORDS.drawFailed(admin);
    }
    log.error('routing map not drawn', { module: mod.id, view, reason: (err && err.name) || 'error' });
    return MAP_WORDS.planFailed(admin);
  }

  // Draws the session's current picks and shows the result, unless a newer
  // click has come in by then. A failure while working the map out is a
  // plain message here; a Slack failure while showing it is the hub's.
  // The draw works on its own copy of the picks and options (st); only a
  // draw still current when its work is done commits them to the session,
  // so a superseded draw never changes what the next click draws or the
  // selects the next view shows (PR #226 review).
  async function draw({ mod, s, number, show, showMap }) {
    const current = () => sessions.isCurrent(s, number);
    const superseded = () => {
      if (current()) return false;
      log.info('map superseded', { module: mod.id, step: 'draw' });
      return true;
    };
    const st = {
      picks: { ...s.picks }, options: s.options, range: s.range, scope: s.scope, seq: number,
    };
    let shown;
    try {
      shown = await work({ mod, s, st });
    } catch (err) {
      shown = { plain: textMessage(s, failureText(mod, st.picks.view, err), headOf(st)) };
    }
    if (superseded()) return;
    s.picks.crew = st.picks.crew;
    s.picks.zone = st.picks.zone;
    s.options = st.options;
    if (shown.plain) {
      await show(shown.plain, { current });
      return;
    }
    log.info('routing map drawn', { module: mod.id, view: st.picks.view });
    await showMap(shown.map, { current, mod });
  }

  // Works one draw out: { plain } (a message) or { map } (a message with
  // its image), writing only st (the draw's own copy). Throws on any
  // failure; nothing here talks to Slack.
  async function work({ mod, s, st }) {
    const { scope } = st;
    const { view, day } = st.picks;
    const adapter = adapterFor(mod);
    const { input, travel } = checkInput(await adapter.input({ day, view, scope }));
    const opts = choices(input, scope);
    const crewIds = new Set(input.crews.map((c) => c.crewId));
    if (audience.checkScope(scope, crewIds) !== 'ok') {
      log.error('routing map refused', { module: mod.id, reason: "the crew lead's crew is not in the data" });
      st.options = null;
      return { plain: textMessage(s, messageFor(new ConfigFault({ admin }))) };
    }
    const pick = resolvePick(view, scope, st.picks, opts);
    if (pick.kind === 'zone') st.picks.zone = pick.id; else st.picks.crew = pick.id;
    if (pick.id === null) {
      st.options = { crews: [], zones: [] };
      return { plain: textMessage(s, MAP_WORDS.noCrews(day), headOf(st)) };
    }
    const plan = planView({
      view, input, travel, scope, pick, gapFill,
    });
    // Only node ids this scope may see are named (AD-R17).
    const crewNodes = [...opts.crews, ...(plan.crewIds || [])].map((c) => `crew:${c}`);
    const labelNodes = unique([...crewNodes, ...(plan.placeNodes || plan.labelNodes || [])]);
    const labels = checkLabels(await adapter.labels({ day, nodeIds: labelNodes, scope }), labelNodes);
    const n = namer(labels);
    st.options = {
      crews: opts.crews.map((c) => ({ value: c, text: n.crewLabel(c) })),
      zones: opts.zones.map((z) => ({ value: z, text: zoneLabel(z) })),
    };
    if (plan.empty) return { plain: textMessage(s, plan.empty(n), headOf(st)) };
    const nodes = unique(plan.nodes);
    // Only the points are taken; the mosaic is left behind (AD-R20).
    const read = await mapPoints(data, nodes, FRAME);
    const points = read && Array.isArray(read.points) ? read.points : [];
    const placed = new Set(points.map((p) => p && p.node));
    // A requested node with no position is an engine fault (AD-R13, F16).
    if (!nodes.every((node) => placed.has(node))) throw fault('mapPoints', 'no_position');
    const built = plan.build(n);
    const png = render(view, { frame: { ...FRAME }, points, ...built.model });
    const alt = altText({ view: VIEW_LABELS[view], crew: built.alt.crew, stops: built.alt.stops });
    return { map: withModal(s, { head: headOf(st), image: { png, alt }, blocks: textBlocks(textOf(built)) }) };
  }

  // The days the picker may show, from the adapter's asOf, read once per
  // session (again on a later click if the first read failed). False, with
  // the failure shown, when it cannot be read.
  async function withRange(mod, s, show) {
    if (s.range) return true;
    try {
      const asOf = await adapterFor(mod).asOf();
      if (!isRealDate(asOf)) throw fault('adapter.asOf', 'bad_date');
      s.range = dayRange(asOf, gapFill.horizon_days);
      if (!s.picks.day) s.picks.day = asOf;
      return true;
    } catch (err) {
      await show(textMessage(s, failureText(mod, 'open', err)));
      return false;
    }
  }

  // Open: the hub has pushed "Loading…" and knows the view's id.
  async function open({
    mod, person, viewId, show, showMap,
  }) {
    const decided = audience.scopeFor(profile, person.user);
    if (!decided.scope) {
      await show({ text: refusalText(mod, decided) });
      return;
    }
    const s = sessions.open({
      userId: person.id, viewId, moduleId: mod.id, picks: { view: 'compare', day: null, crew: null, zone: null },
    });
    s.scope = decided.scope;
    const number = sessions.next(s);
    log.info('routing map opened', { module: mod.id, scope: decided.scope.all === true ? 'all crews' : 'own crew' });
    if (!await withRange(mod, s, show)) return;
    await draw({
      mod, s, number, show, showMap,
    });
  }

  // A select or date click. from: the view the click came from. resolve:
  // the hub's re-check that this person may still open the module here.
  async function click({
    actionId, action, from, person, resolve, show, showMap,
  }) {
    const m = ACTION_PATTERN.exec(typeof actionId === 'string' ? actionId : '');
    const which = m ? m[1] : null;
    const viewId = from && typeof from.id === 'string' ? from.id : null;
    const found = sessions.lookup(from && from.private_metadata, { userId: person.id, viewId });
    if (found.status === STATUS.EXPIRED) {
      log.info('routing map click refused', { action: which, reason: 'expired' });
      const title = from && from.title && typeof from.title.text === 'string' && from.title.text ? escapeText(from.title.text) : 'it';
      await show({ text: MAP_WORDS.expired(title) });
      return;
    }
    if (found.status === STATUS.NOT_YOURS) {
      // Someone else's view is never touched; this person's own other view
      // is told why nothing changed.
      log.warn('routing map click refused', { action: which, reason: found.sameUser ? 'another view' : 'another user' });
      if (found.sameUser) await show({ text: MAP_WORDS.notYours() });
      return;
    }
    const s = found.session;
    const allowed = resolve(s.moduleId);
    if (!allowed.mod) {
      sessions.drop(s.id);
      await show({ text: allowed.refusal });
      return;
    }
    const mod = allowed.mod;
    // Access is re-checked on every click; the scope comes from the
    // audience, never from what the click carries (AD-R17).
    const decided = audience.scopeFor(profile, person.user);
    if (!decided.scope) {
      sessions.drop(s.id);
      await show({ text: refusalText(mod, decided) });
      return;
    }
    s.scope = decided.scope;
    if (!await withRange(mod, s, show)) return;
    let refusedDay = false;
    if (which === 'view') {
      const v = action && action.selected_option && action.selected_option.value;
      if (VIEWS.includes(v)) s.picks.view = v;
    } else if (which === 'day') {
      const day = action && action.selected_date;
      if (inRange(day, s.range)) s.picks.day = day;
      else refusedDay = true;
    } else if (which === 'crew' || which === 'zone') {
      const v = action && action.selected_option && action.selected_option.value;
      if (typeof v === 'string' && v.length <= 64) s.picks[which] = v;
    }
    const number = sessions.next(s);
    const current = () => sessions.isCurrent(s, number);
    log.info('routing map click', { module: mod.id, action: which, view: s.picks.view });
    if (refusedDay) {
      log.info('routing map click refused', { action: which, reason: 'day out of range' });
      if (sessions.isCurrent(s, number)) await show(textMessage(s, MAP_WORDS.badDate(s.range.from, s.range.to), headOf(s)), { current });
      return;
    }
    if (sessions.isCurrent(s, number)) await show(textMessage(s, MAP_WORDS.drawing(), headOf(s)), { current });
    await draw({
      mod, s, number, show, showMap,
    });
  }

  return {
    open, click, closed: (who) => sessions.closed(who), sessions,
  };
}

module.exports = {
  createRoutingMap, controls, dayRange, isRealDate, checkLabels, MAP_WORDS, ACTION_PATTERN, ACTIONS, ARCHETYPE,
};
