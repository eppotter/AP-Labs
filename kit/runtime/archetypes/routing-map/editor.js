'use strict';

// Plan a route (Story 15.14, AD-R26, AD-R27): the route editor, a second
// screen of the routing-map archetype (a module with screen "route-editor").
// One view, two steps, updated in place (never views.push):
//
//   step 1  a crew select (a crew lead sees only their own crew), a date
//           picker (the archetype's day range, AD-R16) and Show stops.
//   step 2  a header line (drive time, about N km, last stop done, back at
//           the Office, the rule breaks), the map and its caption, a fixed
//           note, an actions row (Optimize, Reset to booked, Change crew or
//           day), then "Office · leave hh:mm", one row per stop (time, place,
//           drive, a warning line per rule break, then ↑ ↓ buttons: no ↑ on
//           the first stop, no ↓ on the last) and "Office · back hh:mm".
//
// Reads (AD-R17 scope first, never from the click): the crew list on Open
// (adapter.input and adapter.labels for crew nodes), and on Show stops one
// adapter.route({ day, crewId, depot, scope }) (a crew lead's crewId comes
// from the scope), the labels of the crew and its stops (never the Office:
// it is named from routing.depot.label) and one mapPoints read for the Office
// and the stops. The session then holds the input, travel, distance, the
// order, its version, the names, and the positions and mosaic (memory only,
// AD-R12 amended); a reorder reads nothing from the database.
//
// Every order is timed by the engine's evaluateOrder from the Office
// (returnToBase). Optimize is optimizeDay on the one-crew input from the
// Office; stops it leaves unplaced are appended in booked order and flagged.
// Only the route's total distance is shown, in whole km; a leg's distance is
// never shown, logged or sent.
//
// Clicks: each ↑/↓ value is "<version>:<stopId>". A stale version, a stop
// not in the order, ↑ on the first or ↓ on the last, a malformed value, a
// click from the other step, or any change while the crew is out (read-only)
// is refused: nothing changes and the refusal is logged by reason only.
//
// Two updates per accepted change (AD-R27): at once, the list under the
// picture already shown (the hub's showList reuses the same slack_file) with
// "Map updating…"; then, after MAP_DELAY_MS, the map, unless a newer click
// came in (the session's request numbers, AD-R16). A render, upload,
// ratelimited or not-accepted failure keeps the list with "Map not updated;
// the list is current." A data or engine fault on Show stops, or a node with
// no position, is the error exit.
//
// Exits: Change crew or day (step 1; the hub deletes the files), Back and
// Close (the hub's view_closed, else the sweep), an expired session ("This
// plan has expired, go back and open <label> again."), access withdrawn (the
// refusal in the view), a click from another user or view (index.js), the
// error exit (a plain message, Back), and an expired trigger (the hub).

const engine = require('../../routing');
const { compareIds } = require('../../scoring');
const { RoutingFault, ConfigFault } = require('../../errors');
const { messageFor, escapeText, ROUTE_WORDS, MAP_WORDS } = require('../../messages');
const { textBlocks } = require('../../slack/format');
const { altText } = require('../../slack/image');
const { MAX_COLOR } = require('../../routing-map/svg');
const audience = require('./audience');
const {
  namer, dayWords, clock, bookedStops, FRAME, ROUTE_LABEL,
} = require('./views');

const SCREEN = 'route-editor';
const ACTIONS = Object.freeze(['crew', 'day', 'show', 'up', 'down', 'optimize', 'reset', 'change']);
const MAX_STOPS = 40;
const MAP_DELAY_MS = 750;
const MAX_VALUE = 2000;
const MAX_STOP_ID = 128;
const MAX_OPTIONS = 100;
const MAX_OPTION_TEXT = 75;
const DAY_MINUTES = 24 * 60;
const SEP = ' · ';
const WARN = '⚠';
const VERSION = /^[1-9][0-9]{0,8}$/;

const fault = (field, problem) => new RoutingFault({ field, problem });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unique = (list) => [...new Set(list)];
const pad2 = (n) => String(n).padStart(2, '0');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const crewNode = (crewId) => `crew:${crewId}`;
const plainText = (text) => ({ type: 'plain_text', text, emoji: false });
const cut = (s, max) => Array.from(String(s)).slice(0, max).join('');

// A clock time; past 24:00, "hh:mm (next day)" (AD-R24).
const clockDay = (m) => (Number.isInteger(m) && m >= DAY_MINUTES ? `${clock(m % DAY_MINUTES)} (next day)` : clock(m));
const estimated = (m) => (Number.isInteger(m) && m >= DAY_MINUTES ? `${clock(m % DAY_MINUTES)} (next day, est.)` : `${clock(m)} (est.)`);
const driveWords = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad2(m % 60)} min`);

// Waits ms, or less when the signal aborts (a newer click, Back, Close).
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

// An ↑/↓ value: { version, stopId } or null.
function parseMove(value) {
  if (typeof value !== 'string' || value.length > MAX_VALUE) return null;
  const at = value.indexOf(':');
  if (at < 1) return null;
  const version = value.slice(0, at);
  const stopId = value.slice(at + 1);
  if (!VERSION.test(version) || !stopId || stopId.length > MAX_STOP_ID) return null;
  return { version: Number(version), stopId };
}

const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// adapter.route's answer: { input, travel, distance }.
function checkRoute(got) {
  if (!isPlainObject(got) || !isPlainObject(got.input)) throw fault('adapter.route', 'not_object');
  if (typeof got.travel !== 'function') throw fault('adapter.route.travel', 'not_function');
  if (typeof got.distance !== 'function') throw fault('adapter.route.distance', 'not_function');
  return got;
}

// Every leg a route through these stops could drive, from and back to the
// Office: a whole number of minutes and of tenths of a km, so no later
// reorder can meet a missing leg. Faults name the field, never a value.
function checkLegs(nodes, office, travel, distance) {
  const froms = [office, ...nodes];
  const tos = [...nodes, office];
  for (const from of froms) {
    for (const to of tos) {
      if (from === to) continue;
      const m = travel(from, to);
      if (!Number.isSafeInteger(m) || m < 0) throw fault('travel', 'not_integer');
      const d = distance(from, to);
      if (!Number.isSafeInteger(d) || d < 0) throw fault('distance', 'not_integer');
    }
  }
}

function createEditor({
  profile, data, log, admin, sessions, adapterFor, checkLabels, mapPoints, render, tilesFor, captionBlock,
  failureText, drawProblem, withModal, inRange, streetSource, delay = pause, mapDelayMs = MAP_DELAY_MS,
}) {
  const routing = (profile && profile.routing) || null;
  const depot = (routing && routing.depot) || null;

  // Why this module cannot open (a fixed reason), or false (AD-R26).
  function unready(mod) {
    if (!depot) return 'no routing.depot in the profile';
    let adapter;
    try {
      adapter = adapterFor(mod);
    } catch {
      return false; // Open's error exit says so.
    }
    return typeof adapter.route === 'function' ? false : 'the adapter has no route()';
  }

  const office = () => escapeText(depot.label);
  const refuse = (which, reason) => log.warn('routing map click refused', { action: which, reason });
  const message = (s, blocks) => withModal(s, { blocks });

  // --- step 1 -----------------------------------------------------------------------

  function stepOne(s, words = ROUTE_WORDS.pick()) {
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
    elements.push({
      type: 'button', action_id: 'routing-map:show', text: plainText('Show stops'), value: 'show', style: 'primary',
      accessibility_label: 'Show the stops for this crew and day',
    });
    return message(s, [
      { type: 'section', block_id: `routing-map:intro:${s.seq}`, text: { type: 'mrkdwn', text: words } },
      { type: 'actions', block_id: `routing-map:pick:${s.seq}`, elements },
      { type: 'context', block_id: `routing-map:days:${s.seq}`, elements: [{ type: 'mrkdwn', text: `Days from ${s.range.from} to ${s.range.to}. Suggestions only: nothing is changed.` }] },
    ]);
  }

  const changeButton = () => ({
    type: 'button', action_id: 'routing-map:change', text: plainText('Change crew or day'), value: 'change',
    accessibility_label: 'Change the crew or the day',
  });

  // Step 2 with no list: a plain message and Change crew or day.
  function plainStepTwo(s, words, { change = true } = {}) {
    return message(s, [
      { type: 'section', block_id: `routing-map:plain:${s.seq}`, text: { type: 'mrkdwn', text: words } },
      ...(change ? [{ type: 'actions', block_id: `routing-map:plainact:${s.seq}`, elements: [changeButton()] }] : []),
    ]);
  }

  // The crews the select offers this scope, by name, read for the picked day.
  async function crewChoices(mod, s) {
    const { scope } = s;
    const adapter = adapterFor(mod);
    const got = await adapter.input({ day: s.picks.day, view: 'compare', scope });
    if (!isPlainObject(got) || !isPlainObject(got.input) || !Array.isArray(got.input.crews)) throw fault('adapter.input', 'not_object');
    const ids = got.input.crews.map((c) => c && c.crewId).filter((id) => typeof id === 'string');
    if (audience.checkScope(scope, new Set(ids)) !== 'ok') return { config: true };
    const visible = ids.filter((id) => audience.visible(scope, id)).sort(compareIds);
    const nodes = visible.map(crewNode);
    const labels = nodes.length ? checkLabels(await adapter.labels({ day: s.picks.day, nodeIds: nodes, scope }), nodes) : new Map();
    const n = namer(labels);
    return { crews: visible.map((id) => ({ value: id, text: n.crewLabel(id) })) };
  }

  async function open({ mod, s, show }) {
    s.step = 1;
    s.plan = null;
    let got;
    try {
      got = await crewChoices(mod, s);
    } catch (err) {
      await show(message(s, textBlocks(failureText(mod, 'route', err))));
      return;
    }
    if (got.config) {
      log.error('routing map refused', { module: mod.id, reason: "the crew lead's crew is not in the data" });
      await show(message(s, textBlocks(messageFor(new ConfigFault({ admin })))));
      return;
    }
    s.crews = got.crews;
    if (s.scope.all !== true) s.picks.crew = s.scope.crewId;
    else if (!s.crews.some((c) => c.value === s.picks.crew)) s.picks.crew = s.crews.length ? s.crews[0].value : null;
    await show(stepOne(s));
  }

  // --- reading one crew's day (Show stops) ------------------------------------------------

  // The plan for the picked crew and day, or { plain } words to show.
  async function load(mod, s) {
    const { scope } = s;
    const lead = scope.all !== true;
    const crewId = lead ? scope.crewId : s.picks.crew;
    const { day } = s.picks;
    const adapter = adapterFor(mod);
    if (typeof adapter.route !== 'function') throw fault('adapter.route', 'not_function');
    const got = checkRoute(await adapter.route({
      day, crewId, depot: depot.node, scope,
    }));
    const { input } = got;
    engine.validateInput(input);
    const crew = input.crews.find((c) => c.crewId === crewId);
    if (!crew && lead) {
      log.error('routing map refused', { module: mod.id, reason: "the crew lead's crew is not in the data" });
      return { plain: messageFor(new ConfigFault({ admin })), change: false };
    }
    const stops = crew ? bookedStops(input, crewId) : [];
    if (stops.some((st) => st.stopId.length > MAX_STOP_ID)) throw fault('stopId', 'too_long');
    const fits = stops.length > 0 && stops.length <= MAX_STOPS;
    const stopNodes = unique(stops.map((st) => st.node));
    // The Office is never sent to labels: it is named from the profile.
    const labelNodes = [crewNode(crewId), ...(fits ? stopNodes : [])];
    const labels = checkLabels(await adapter.labels({ day, nodeIds: labelNodes, scope }), labelNodes);
    const n = namer(labels);
    const when = dayWords(day);
    if (!crew) return { plain: ROUTE_WORDS.notWorking(n.crew(crewId), when) };
    if (!stops.length) return { plain: ROUTE_WORDS.noStops(n.crew(crewId), when) };
    if (!fits) return { plain: ROUTE_WORDS.tooMany(n.crew(crewId), stops.length, MAX_STOPS) };
    const one = { ...input, crews: [{ ...crew, baseNode: depot.node }], stops };
    delete one.cancelled;
    delete one.candidates;
    engine.validateInput(one);
    checkLegs(stopNodes, depot.node, got.travel, got.distance);
    const nodes = unique([depot.node, ...stopNodes]);
    // The points go to the renderer; the mosaic only to the tile fetcher.
    const read = await mapPoints(data, nodes, FRAME);
    const points = read && Array.isArray(read.points) ? read.points : [];
    const placed = new Set(points.map((p) => p && p.node));
    if (!nodes.every((node) => placed.has(node))) throw fault('mapPoints', 'no_position');
    const order = stops.map((st) => st.stopId);
    const colors = input.crews.map((c) => c.crewId).sort(compareIds);
    return {
      plan: {
        crewId,
        day,
        input: one,
        travel: got.travel,
        distance: got.distance,
        nodeOf: new Map(stops.map((st) => [st.stopId, st.node])),
        booked: order,
        order: order.slice(),
        version: 1,
        mapVersion: null,
        flagged: new Set(),
        out: crew.available === false,
        names: n,
        color: colors.indexOf(crewId) % (MAX_COLOR + 1),
        points,
        mosaic: (read && read.mosaic) || null,
      },
    };
  }

  // --- the list ---------------------------------------------------------------------

  // The engine's timing of the current order, and the route's total
  // distance in tenths of a km (never shown per leg).
  function evaluate(p) {
    const ev = engine.evaluateOrder(p.input, {
      travel: p.travel, returnToBase: true, crewId: p.crewId, order: p.order,
    });
    const nodes = [depot.node, ...p.order.map((id) => p.nodeOf.get(id)), depot.node];
    let tenths = 0;
    for (let i = 1; i < nodes.length; i += 1) if (nodes[i - 1] !== nodes[i]) tenths += p.distance(nodes[i - 1], nodes[i]);
    return { ev, km: Math.round(tenths / 10) };
  }

  function breakWords(ev) {
    let total = ev.lateBack ? 1 : 0;
    let hard = total;
    for (const st of ev.stops) {
      total += st.breaks.length;
      hard += st.breaks.filter((b) => b.strength === 'hard').length;
    }
    return total ? `${plural(total, 'rule break')} (${hard} hard)` : 'no rule breaks';
  }

  const button = (which, text, value, label) => ({
    type: 'button', action_id: `routing-map:${which}`, text: plainText(text), value, accessibility_label: label,
  });

  // { head, blocks }: the list message, split around the place the image
  // goes. status: a line under the image ("Map updating…", ...), or null.
  function listParts(s, { ev, km }, status) {
    const p = s.plan;
    const n = p.names;
    const v = p.version;
    const id = (name) => `routing-map:${name}:${v}`;
    const head = [{
      type: 'section',
      block_id: id('head'),
      text: {
        type: 'mrkdwn',
        text: `*${n.crew(p.crewId)}, ${dayWords(p.day)}*\n${[
          `Drive ${driveWords(ev.cost.driveMinutes)}`, `about ${km} km`, `last stop done ${clockDay(ev.finish)}`,
          `back at ${office()} ${clockDay(ev.backAt)}`, breakWords(ev),
        ].join(SEP)}`,
      },
    }];
    if (p.out) head.push({ type: 'section', block_id: id('out'), text: { type: 'mrkdwn', text: `*${ROUTE_WORDS.crewOut(n.crew(p.crewId), dayWords(p.day))}*` } });
    const top = p.out ? [changeButton()] : [
      button('optimize', 'Optimize', `${v}:optimize`, 'Optimize the order from the Office'),
      button('reset', 'Reset to booked', `${v}:reset`, 'Put the stops back in the booked order'),
      changeButton(),
    ];
    const blocks = [];
    if (status) blocks.push({ type: 'context', block_id: id('status'), elements: [{ type: 'mrkdwn', text: status }] });
    blocks.push(
      { type: 'context', block_id: id('note'), elements: [{ type: 'mrkdwn', text: ROUTE_WORDS.note(office(), clock(p.input.limits.defaultStart)) }] },
      { type: 'actions', block_id: id('actions'), elements: top },
      { type: 'section', block_id: id('leave'), text: { type: 'mrkdwn', text: `${office()}${SEP}leave ${clockDay(ev.leaveAt)}` } },
    );
    const last = ev.stops.length - 1;
    ev.stops.forEach((st, i) => {
      const k = i + 1;
      const lines = [`${k}. ${[estimated(st.start), n.place(p.nodeOf.get(st.stopId)), `${st.travelMinutesFromPrevious} min drive`].join(SEP)}`];
      for (const b of st.breaks) lines.push(`${WARN} ${escapeText(b.label)}: ${escapeText(b.reason)}`);
      if (p.flagged.has(st.stopId)) lines.push(`${WARN} ${ROUTE_WORDS.unplaced()}`);
      blocks.push({ type: 'section', block_id: `routing-map:stop:${k}:${v}`, text: { type: 'mrkdwn', text: lines.join('\n') } });
      if (p.out) return;
      const moves = [];
      if (i > 0) moves.push(button('up', '↑', `${v}:${st.stopId}`, `Move stop ${k} up`));
      if (i < last) moves.push(button('down', '↓', `${v}:${st.stopId}`, `Move stop ${k} down`));
      if (moves.length) blocks.push({ type: 'actions', block_id: `routing-map:move:${k}:${v}`, elements: moves });
    });
    const back = [`${office()}${SEP}back ${clockDay(ev.backAt)}`];
    if (ev.lateBack) back.push(`${WARN} crew day limits: back after ${clock(p.input.limits.latestFinish)}`);
    blocks.push({ type: 'section', block_id: id('back'), text: { type: 'mrkdwn', text: back.join('\n') } });
    return { head, blocks };
  }

  const listMessage = (s, evaluated, status) => withModal(s, listParts(s, evaluated, status));

  // --- the map ----------------------------------------------------------------------

  // After the wait (and the tile fetch): is this change still wanted, by
  // someone still allowed to see it? null when so.
  function checkpoint(s, current, recheck) {
    if (sessions.expired(s)) return 'expired';
    if (!current()) return 'superseded';
    const refusal = recheck ? recheck() : null;
    return refusal ? { refused: refusal } : null;
  }

  // Shows what a checkpoint stopped on; true when the work should stop.
  async function stopped(mod, s, stop, show) {
    if (!stop) return false;
    if (stop === 'superseded') {
      log.info('map superseded', { module: mod.id, step: 'draw' });
      return true;
    }
    sessions.drop(s.id);
    if (stop === 'expired') {
      log.info('routing map click refused', { action: 'draw', reason: 'expired' });
      await show({ text: ROUTE_WORDS.expired(escapeText(mod.label)) });
      return true;
    }
    await show({ text: stop.refused });
    return true;
  }

  // Draws the current order and shows it; a failure keeps the list.
  async function drawMap({
    mod, s, number, evaluated, show, showMap, showList, recheck,
  }) {
    const current = () => sessions.isCurrent(s, number);
    const p = s.plan;
    const { version } = p;
    const keepList = async () => showList(listMessage(s, evaluated, ROUTE_WORDS.notUpdated()), { current });
    if (await stopped(mod, s, checkpoint(s, current, recheck), show)) return;
    let basemap = null;
    if (streetSource) {
      if (p.mosaic) {
        basemap = await tilesFor(mod, p.mosaic, sessions.signal(s));
        if (await stopped(mod, s, checkpoint(s, current, recheck), show)) return;
      } else {
        log.info('street map not drawn', { module: mod.id, view: 'route', reason: 'no_mosaic' });
      }
    }
    const model = {
      frame: { ...FRAME },
      points: p.points,
      crews: [{ crewId: p.crewId, color: p.color, baseNode: depot.node }],
      route: { crewId: p.crewId, stops: p.order.map((id) => p.nodeOf.get(id)) },
      depot: depot.node,
    };
    let png;
    let streets = streetSource ? 'unavailable' : 'off';
    let alt;
    try {
      if (basemap) {
        try {
          png = render('route', model, { basemap });
          streets = 'shown';
        } catch (err) {
          log.warn('street map not drawn', { module: mod.id, view: 'route', reason: drawProblem(err) });
          png = render('route', model);
        }
      } else {
        png = render('route', model);
      }
      alt = altText({ view: ROUTE_LABEL, crew: p.names.crewLabel(p.crewId), stops: p.order.length });
    } catch (err) {
      log.warn('route map not drawn', { module: mod.id, reason: drawProblem(err) });
      if (current()) await keepList();
      return;
    }
    const caption = streets === 'off' ? [] : [captionBlock(streetSource, streets)];
    const parts = listParts(s, evaluated, null);
    const status = await showMap(withModal(s, {
      head: parts.head, image: { png, alt }, caption, blocks: parts.blocks, fallback: keepList,
    }), { current, mod });
    if (status === 'shown' && s.plan === p) p.mapVersion = version;
  }

  // An accepted change to the order (or none): the list at once, then the
  // map after the wait, when the map shown is not of this order already.
  async function changed({
    mod, s, status, show, showMap, showList, recheck, wait = mapDelayMs,
  }) {
    const number = sessions.next(s);
    const current = () => sessions.isCurrent(s, number);
    const p = s.plan;
    const evaluated = evaluate(p);
    const needMap = p.mapVersion !== p.version;
    await showList(listMessage(s, evaluated, status || (needMap ? ROUTE_WORDS.updating() : null)), { current });
    if (!needMap) return;
    if (wait > 0) await delay(wait, sessions.signal(s));
    await drawMap({
      mod, s, number, evaluated, show, showMap, showList, recheck,
    });
  }

  async function showStops({
    mod, s, show, showMap, showList, recheck,
  }) {
    const number = sessions.next(s);
    const current = () => sessions.isCurrent(s, number);
    let loaded;
    try {
      loaded = await load(mod, s);
    } catch (err) {
      const words = failureText(mod, 'route', err);
      if (!current()) return;
      s.plan = null;
      s.step = 2;
      await show(message(s, textBlocks(words)), { current });
      return;
    }
    if (!current()) {
      log.info('map superseded', { module: mod.id, step: 'show stops' });
      return;
    }
    s.step = 2;
    if (loaded.plain) {
      s.plan = null;
      await show(plainStepTwo(s, loaded.plain, { change: loaded.change !== false }), { current });
      return;
    }
    s.plan = loaded.plan;
    log.info('route plan shown', { module: mod.id, stops: s.plan.order.length, out: s.plan.out });
    await changed({
      mod, s, show, showMap, showList, recheck, wait: 0,
    });
  }

  // --- clicks -----------------------------------------------------------------------

  async function click({
    which, action, s, mod, show, showMap, showList, recheck,
  }) {
    const step = s.step === 2 ? 2 : 1;
    const value = action && typeof action.value === 'string' ? action.value : null;
    const go = { mod, s, show, showMap, showList, recheck };
    if (which === 'crew' || which === 'day' || which === 'show') {
      if (step !== 1) return refuse(which, 'another step');
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
        log.info('routing map click', { module: mod.id, action: which, view: 'route' });
        return undefined;
      }
      if (which === 'day') {
        const day = action && action.selected_date;
        const number = sessions.next(s);
        if (!inRange(day, s.range)) {
          log.info('routing map click refused', { action: which, reason: 'day out of range' });
          await show(stepOne(s, MAP_WORDS.badDate(s.range.from, s.range.to)), { current: () => sessions.isCurrent(s, number) });
          return undefined;
        }
        s.picks.day = day;
        log.info('routing map click', { module: mod.id, action: which, view: 'route' });
        return undefined;
      }
      log.info('routing map click', { module: mod.id, action: which, view: 'route' });
      return showStops(go);
    }
    if (step !== 2) return refuse(which, 'another step');
    if (which === 'change') {
      const number = sessions.next(s);
      s.plan = null;
      s.step = 1;
      log.info('routing map click', { module: mod.id, action: which, view: 'route' });
      await show(stepOne(s), { current: () => sessions.isCurrent(s, number) });
      return undefined;
    }
    const p = s.plan;
    if (!p) return refuse(which, 'no list');
    if (p.out) return refuse(which, 'read only');
    if (which === 'up' || which === 'down') {
      const move = parseMove(value);
      if (!move) return refuse(which, 'malformed');
      if (move.version !== p.version) return refuse(which, 'stale version');
      const i = p.order.indexOf(move.stopId);
      if (i < 0) return refuse(which, 'unknown stop');
      const j = which === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= p.order.length) return refuse(which, 'edge');
      [p.order[i], p.order[j]] = [p.order[j], p.order[i]];
      p.version += 1;
      log.info('routing map click', { module: mod.id, action: which, view: 'route' });
      return changed(go);
    }
    // Optimize and Reset carry "<version>:optimize" / "<version>:reset".
    const at = value ? value.indexOf(':') : -1;
    const version = at > 0 ? value.slice(0, at) : null;
    if (!version || !VERSION.test(version) || value.slice(at + 1) !== which) return refuse(which, 'malformed');
    if (Number(version) !== p.version) return refuse(which, 'stale version');
    let next;
    let status = null;
    if (which === 'optimize') {
      const res = engine.optimizeDay(p.input, { travel: p.travel, returnToBase: true });
      const plan = res.plans.find((x) => x.crewId === p.crewId) || { stops: [] };
      const placed = plan.stops.map((x) => x.stopId);
      const rest = p.booked.filter((id) => !placed.includes(id));
      next = [...placed, ...rest];
      p.flagged = new Set(rest);
      if (sameOrder(next, p.order)) status = ROUTE_WORDS.best();
    } else {
      next = p.booked.slice();
      p.flagged = new Set();
    }
    if (!sameOrder(next, p.order)) {
      p.order = next;
      p.version += 1;
    }
    log.info('routing map click', { module: mod.id, action: which, view: 'route' });
    return changed({ ...go, status });
  }

  return {
    unready, open, click, ACTIONS,
  };
}

module.exports = {
  createEditor, parseMove, SCREEN, ACTIONS, MAX_STOPS, MAP_DELAY_MS,
};
