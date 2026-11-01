'use strict';

// Plan a route (Story 15.14, AD-R26, AD-R27): the route editor, a second
// screen of the routing-map archetype (a module with screen "route-editor").
// One view, two steps, updated in place (never views.push):
//
//   step 1  a crew select (a crew lead sees only their own crew), a date
//           picker (the archetype's day range, AD-R16) and Show stops.
//   step 2  (Story 15.17, AD-R29) a header block (the crew and the day), a
//           section of four fields (Drive, Distance, Back at Office, Rule
//           breaks with the hard count), the crew-out banner when it is out,
//           an actions row (Optimize, Reset to booked, Change crew or day),
//           a status line (after Optimize: drive and back time before →
//           after, or "Already the best order found."; "Map updating…"), a
//           caption ("Estimates from the Office at 08:00 · suggestions
//           only, nothing is saved"), the map and its attribution and ring
//           legend, then "🏠 Leave Office hh:mm", one section per stop (an
//           "After 18:00" line, the aim-finish, before the first stop that
//           finishes past it) and "🏠 Back at Office hh:mm" (🔴 past the
//           latest finish). A stop row (Story 15.16, AD-R29): its
//           number (keycap emoji 1 to 10, then "11."), the bold time and
//           client, the area; a second line with the drive minutes and the
//           hardest rule break (🔴 hard before 🟠 soft), shortened, then
//           "+N more"; and a ⋯ overflow menu (Move stop k up, down, to
//           first, to last; none of up or first on the first stop, none of
//           down or last on the last, no menu on a one-stop day or while
//           the crew is out).
//
// Reads (AD-R17 scope first, never from the click): the crew list on Open
// and again on each day picked (adapter.input and adapter.labels for crew
// nodes; the crews' map colours as Routing's views give them), and on Show
// stops (none when no crew is picked: "Pick a crew first") one
// adapter.route({ day, crewId, depot, scope }) (a crew lead's crewId comes
// from the scope), the labels of the crew and its stops (never the Office:
// it is named from routing.depot.label) and one mapPoints read for the Office
// and the stops. The session then holds the input, travel, distance, the
// order, its version, the names, and the positions and mosaic (memory only,
// AD-R12 amended); a reorder reads nothing from the database.
//
// Every order is timed by the engine's evaluateOrder from the Office
// (returnToBase). Optimize is optimizeDay on the one-crew input from the
// Office; stops it leaves unplaced are appended in booked order and flagged,
// until a move takes them from where Optimize put them. A crew not in the
// day's data, a crew lead's own too, is "not working" that day (plain words).
// Only the route's total distance is shown, in whole km; a leg's distance is
// never shown, logged or sent.
//
// Clicks: a menu option's value (read from selected_option.value) is
// "<version>:<index>:<target>", an index into the order, never a stop id. A
// stale version, an index out of range, a target the menu does not offer
// at that index, a malformed value, a click from the other step, or any
// change while the crew is out (read-only) is refused: nothing changes and
// the refusal is logged by reason only.
//
// Two updates per accepted change (AD-R27): at once, the list under the
// picture already shown (the hub's showList reuses the same slack_file) with
// "Map updating…"; then, after MAP_DELAY_MS, the map, unless a newer click
// came in (the session's request numbers, AD-R16). A render, upload,
// ratelimited or not-accepted failure keeps the list with "Map not updated;
// the list is current." A data or engine fault on Show stops, or a node with
// no position, is the error exit.
//
// Customer cancellation (Story 19.4, ./whatif.js) shows its Fill with #n
// here: showFill passes { cancel, add } to adapter.route, which gives the
// crew's day with the cancelled visit out and the candidate in its place;
// that stop's row says it moved up ("↩️"). The same list, map and clicks
// follow; whatif.js takes Change crew or day back to its own first step.
//
// Exits: Change crew or day (step 1; the hub deletes the files), Back and
// Close (the hub's view_closed, else the sweep), an expired session ("This
// plan has expired, go back and open <label> again."), access withdrawn (the
// refusal in the view), a click from another user or view (index.js), the
// error exit (a plain message, Back), and an expired trigger (the hub).

const engine = require('../../routing');
const { compareIds } = require('../../scoring');
const { RoutingFault, ConfigFault } = require('../../errors');
const {
  messageFor, escapeText, escapeName, ROUTE_WORDS, MAP_WORDS,
} = require('../../messages');
const { textBlocks } = require('../../slack/format');
const { altText } = require('../../slack/image');
const { MAX_COLOR } = require('../../routing-map/svg');
const audience = require('./audience');
const {
  namer, dayWords, clock, bookedStops, FRAME, ROUTE_LABEL,
} = require('./views');

const SCREEN = 'route-editor';
const ACTIONS = Object.freeze(['crew', 'day', 'show', 'move', 'optimize', 'reset', 'change']);
const MAX_STOPS = 40;
const MAP_DELAY_MS = 750;
const MAX_STOP_ID = 128;
const MAX_OPTIONS = 100;
const MAX_OPTION_TEXT = 75;
const MAX_HEADER = 150;
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const MINUS = '\u2212';
const DAY_MINUTES = 24 * 60;
const SEP = ' · ';
const WARN = '⚠';
const VERSION = /^[1-9][0-9]{0,8}$/;
// A menu option's value: "<version>:<index>:<target>" (AD-R29).
const MOVE = /^([1-9][0-9]{0,8}):(0|[1-9][0-9]{0,2}):(up|down|first|last)$/;
const MAX_MOVE_VALUE = 32;
const KEYCAPS = Object.freeze(['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']);
const STRENGTH_MARK = Object.freeze({ hard: '🔴', soft: '🟠' });
const DRIVE_MARK = '🚐';
const FILL_MARK = '↩️';

const fault = (field, problem) => new RoutingFault({ field, problem });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unique = (list) => [...new Set(list)];
const pad2 = (n) => String(n).padStart(2, '0');
const crewNode = (crewId) => `crew:${crewId}`;
const plainText = (text) => ({ type: 'plain_text', text, emoji: false });
const cut = (s, max) => Array.from(String(s)).slice(0, max).join('');

// A clock time; past 24:00, "hh:mm (next day)" (AD-R24).
const clockDay = (m) => (Number.isInteger(m) && m >= DAY_MINUTES ? `${clock(m % DAY_MINUTES)} (next day)` : clock(m));
const numberOf = (k) => (k <= KEYCAPS.length ? KEYCAPS[k - 1] : `${k}.`);
const driveWords = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad2(m % 60)} min`);
// A clock time; past 24:00, "hh:mm (+1 day)" (the summary and the Office rows).
const clockPlus = (m) => (Number.isInteger(m) && m >= DAY_MINUTES ? `${clock(m % DAY_MINUTES)} (+${Math.floor(m / DAY_MINUTES)} day)` : clock(m));
// A drive time in the Optimize status line: "52 min", "1 h 37".
const driveShort = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad2(m % 60)}`);

// "Mon 2 Nov" for an ISO day (the header block).
function shortDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

// A header block's plain_text: one line, at most 150 characters (code
// points), "…" when cut.
function headerText(s) {
  const chars = Array.from(String(s).replace(/\s+/g, ' ').trim());
  return chars.length <= MAX_HEADER ? chars.join('') : `${chars.slice(0, MAX_HEADER - 1).join('')}…`;
}

// Optimize's status line: drive and back time before → after.
function optimizedWords(before, after) {
  const delta = after.cost.driveMinutes - before.cost.driveMinutes;
  const change = delta ? ` (${delta < 0 ? MINUS : '+'}${Math.abs(delta)} min)` : '';
  return ROUTE_WORDS.optimized(
    `${driveShort(before.cost.driveMinutes)} → ${driveShort(after.cost.driveMinutes)}${change}`,
    `${clockPlus(before.backAt)} → ${clockPlus(after.backAt)}`,
  );
}

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

// A menu option's value: { version, index, target } or null.
function parseMove(value) {
  if (typeof value !== 'string' || value.length > MAX_MOVE_VALUE) return null;
  const m = MOVE.exec(value);
  return m ? { version: Number(m[1]), index: Number(m[2]), target: m[3] } : null;
}

// The moves the menu offers the stop at index i of n: no up or first on the
// first stop, no down or last on the last, none on a one-stop day.
function movesAt(i, n) {
  if (n < 2) return [];
  return [
    ...(i > 0 ? ['up'] : []), ...(i < n - 1 ? ['down'] : []), ...(i > 0 ? ['first'] : []), ...(i < n - 1 ? ['last'] : []),
  ];
}

// The order with the stop at index i moved to target, and the span of
// indexes whose stops changed place.
function moved(order, i, target) {
  const j = { up: i - 1, down: i + 1, first: 0, last: order.length - 1 }[target];
  const next = order.slice();
  const [id] = next.splice(i, 1);
  next.splice(j, 0, id);
  return { next, from: Math.min(i, j), to: Math.max(i, j) };
}

const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Each stop node's client and area for its row, escaped (formatting marks
// too: the client is bold, #256); a stop with no client name is "a stop",
// one with no area has none.
function placesOf(labels, nodes) {
  const text = (v) => (typeof v === 'string' && v ? escapeName(v) : null);
  return new Map(nodes.map((node) => {
    const l = labels.get(node) || {};
    return [node, { client: text(l.clientName) || 'a stop', area: text(l.city) }];
  }));
}

// A rule break, shortened for a stop row (AD-R29); st is the stop as
// evaluateOrder timed it, limits the day's. A rule this list does not know
// shows its label.
function shortBreak(b, st, limits) {
  // Inside brackets, a time past 24:00 reads "hh:mm next day".
  const at = (m) => (Number.isInteger(m) && m >= DAY_MINUTES ? `${clock(m % DAY_MINUTES)} next day` : clock(m));
  switch (b.ruleId) {
    case 'aim-finish': return ROUTE_WORDS.pastAim(clock(limits.aimFinish), driveWords(Math.max(0, st.finish - limits.aimFinish)));
    case 'crew-day-limits': return st.start < limits.earliestStart ? ROUTE_WORDS.beforeDay(at(st.start)) : ROUTE_WORDS.overDay(at(st.finish));
    case 'locked-start': return ROUTE_WORDS.lockedLate(at(st.start));
    case 'time-of-day': return ROUTE_WORDS.outsideHours(at(st.start));
    case 'day-of-week': return ROUTE_WORDS.wrongDay();
    case 'preferred-crew': return ROUTE_WORDS.notPreferred();
    default: return escapeText(cut(b.label, 40));
  }
}

// A stop row's second line: the drive, the hardest break (hard before
// soft, then the engine's order), then how many others.
function detailLine(st, limits) {
  const parts = [`${DRIVE_MARK} ${st.travelMinutesFromPrevious} min`];
  const ranked = [...st.breaks.filter((b) => b.strength === 'hard'), ...st.breaks.filter((b) => b.strength !== 'hard')];
  if (ranked.length) {
    const top = ranked[0];
    parts.push(`${STRENGTH_MARK[top.strength] || STRENGTH_MARK.soft} ${shortBreak(top, st, limits)}`);
    if (ranked.length > 1) parts.push(ROUTE_WORDS.more(ranked.length - 1));
  }
  return parts.join(SEP);
}

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

  const office = () => escapeName(depot.label);
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

  // The crews the select offers this scope, by name, read for the day
  // (one adapter.input, then labels for the crews offered), and each crew's
  // map colour: its place among the day's crews sorted by id, as Routing's
  // views colour it (views.js dayOf). A crew lead is offered only their own
  // crew, and nothing when it is not in that day's data (not working that
  // day: Show stops says so); only a lead with no crew id is a
  // configuration fault.
  async function crewChoices(mod, s, day) {
    const { scope } = s;
    if (scope.all !== true && typeof scope.crewId !== 'string') return { config: true };
    const adapter = adapterFor(mod);
    const got = await adapter.input({ day, view: 'compare', scope });
    if (!isPlainObject(got) || !isPlainObject(got.input) || !Array.isArray(got.input.crews)) throw fault('adapter.input', 'not_object');
    const ids = unique(got.input.crews.map((c) => c && c.crewId).filter((id) => typeof id === 'string')).sort(compareIds);
    const colors = new Map(ids.map((id, i) => [id, i % (MAX_COLOR + 1)]));
    const visible = ids.filter((id) => audience.visible(scope, id));
    const nodes = visible.map(crewNode);
    const labels = nodes.length ? checkLabels(await adapter.labels({ day, nodeIds: nodes, scope }), nodes) : new Map();
    const n = namer(labels);
    return { crews: visible.map((id) => ({ value: id, text: n.crewLabel(id) })), colors };
  }

  // The crews read for a day go on the session, and the pick follows them:
  // a crew lead's is always their own; anyone else keeps theirs while it is
  // offered, else the first offered, else none.
  function takeCrews(s, got) {
    s.crews = got.crews;
    s.colors = got.colors;
    if (s.scope.all !== true) s.picks.crew = s.scope.crewId;
    else if (!s.crews.some((c) => c.value === s.picks.crew)) s.picks.crew = s.crews.length ? s.crews[0].value : null;
  }

  const configRefusal = (mod) => {
    log.error('routing map refused', { module: mod.id, reason: 'the crew lead has no crew' });
    return messageFor(new ConfigFault({ admin }));
  };

  async function open({ mod, s, show }) {
    s.step = 1;
    s.plan = null;
    let got;
    try {
      got = await crewChoices(mod, s, s.picks.day);
    } catch (err) {
      await show(message(s, textBlocks(failureText(mod, 'route', err))));
      return;
    }
    if (got.config) {
      await show(message(s, textBlocks(configRefusal(mod))));
      return;
    }
    takeCrews(s, got);
    await show(stepOne(s));
  }

  // A day picked on step 1: the crews are read again for that day, and step
  // 1 shows them (a newer click wins; nothing changes for a superseded read).
  async function dayPicked({
    mod, s, day, number, show,
  }) {
    const current = () => sessions.isCurrent(s, number);
    s.picks.day = day;
    let got;
    try {
      got = await crewChoices(mod, s, day);
    } catch (err) {
      const words = failureText(mod, 'route', err);
      if (!current()) return;
      await show(message(s, textBlocks(words)), { current });
      return;
    }
    if (!current()) {
      log.info('map superseded', { module: mod.id, step: 'crews' });
      return;
    }
    if (got.config) {
      await show(message(s, textBlocks(configRefusal(mod))), { current });
      return;
    }
    takeCrews(s, got);
    await show(stepOne(s), { current });
  }

  // --- reading one crew's day (Show stops) ------------------------------------------------

  // The plan for the picked crew and day, or { plain } words to show.
  // fill (Customer cancellation's Fill with #n, Story 19.4): { cancel, add,
  // from }, the visit that cancels, the candidate that fills its gap and the
  // candidate's booked day; the adapter's route() makes the swap.
  async function load(mod, s, fill = null) {
    const { scope } = s;
    const lead = scope.all !== true;
    const crewId = lead ? scope.crewId : s.picks.crew;
    const { day } = s.picks;
    const adapter = adapterFor(mod);
    if (typeof adapter.route !== 'function') throw fault('adapter.route', 'not_function');
    const got = checkRoute(await adapter.route({
      day, crewId, depot: depot.node, scope, ...(fill ? { fill: { cancel: fill.cancel, add: fill.add } } : {}),
    }));
    const { input } = got;
    engine.validateInput(input);
    // A crew not in the day's data (a crew lead's too) is not working that
    // day: a plain message, never a refusal of access.
    const crew = input.crews.find((c) => c.crewId === crewId);
    const stops = crew ? bookedStops(input, crewId) : [];
    // The swap is the adapter's: the candidate is on the day, the cancelled
    // visit is not, or it is the error exit (never a list that hides it).
    if (fill && crew && (!stops.some((st) => st.stopId === fill.add) || stops.some((st) => st.stopId === fill.cancel))) {
      throw fault('adapter.route', 'fill_missing');
    }
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
    // The crew's own name for the header (plain_text) and the banner.
    const named = (labels.get(crewNode(crewId)) || {}).crewName;
    const crewName = typeof named === 'string' && named.trim() ? named : `Crew ${crewId}`;
    // The colour Routing's views give this crew on this day (crewChoices).
    const color = s.colors instanceof Map && s.colors.has(crewId) ? s.colors.get(crewId) : 0;
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
        // Optimize's status line, shown while the order is that version.
        note: null,
        // The stop Fill with #n moved up into the gap, and its booked day.
        filled: fill ? { stopId: fill.add, from: fill.from } : null,
        out: crew.available === false,
        crewName,
        names: n,
        places: placesOf(labels, stopNodes),
        color,
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

  // The Rule breaks field: every break, a late return counted as hard.
  function breakField(ev) {
    let total = ev.lateBack ? 1 : 0;
    let hard = total;
    for (const st of ev.stops) {
      total += st.breaks.length;
      hard += st.breaks.filter((b) => b.strength === 'hard').length;
    }
    return ROUTE_WORDS.breaksField(total, hard);
  }

  const button = (which, text, value, label) => ({
    type: 'button', action_id: `routing-map:${which}`, text: plainText(text), value, accessibility_label: label,
  });

  // A stop's ⋯ menu, or null when it offers nothing (AD-R29). Overflow
  // options carry no accessibility_label: the text names the stop.
  const menu = (v, i, n) => {
    const moves = movesAt(i, n);
    if (!moves.length) return null;
    return {
      type: 'overflow',
      action_id: 'routing-map:move',
      options: moves.map((target) => ({ text: plainText(ROUTE_WORDS.move(i + 1, target)), value: `${v}:${i}:${target}` })),
    };
  };

  // { head, blocks }: the list message, split around the place the image
  // goes (head above it, blocks below). status: a transient line ("Map
  // updating…", ...), or null; Optimize's own line shows while the order
  // is the one it was about.
  function listParts(s, { ev, km }, status) {
    const p = s.plan;
    const v = p.version;
    const { limits } = p.input;
    const id = (name) => `routing-map:${name}:${v}`;
    const mrkdwn = (text) => ({ type: 'mrkdwn', text });
    const head = [
      { type: 'header', block_id: id('title'), text: plainText(headerText(`${p.crewName}${SEP}${shortDay(p.day)}`)) },
      {
        type: 'section',
        block_id: id('summary'),
        fields: [
          mrkdwn(ROUTE_WORDS.drive(driveWords(ev.cost.driveMinutes))),
          mrkdwn(ROUTE_WORDS.distance(km)),
          mrkdwn(ROUTE_WORDS.backField(office(), clockPlus(ev.backAt))),
          mrkdwn(breakField(ev)),
        ],
      },
    ];
    if (p.out) head.push({ type: 'section', block_id: id('out'), text: mrkdwn(`*${ROUTE_WORDS.crewOut(escapeName(p.crewName), dayWords(p.day))}*`) });
    const top = p.out ? [changeButton()] : [
      { ...button('optimize', 'Optimize', `${v}:optimize`, 'Optimize the order from the Office'), style: 'primary' },
      button('reset', 'Reset to booked', `${v}:reset`, 'Put the stops back in the booked order'),
      changeButton(),
    ];
    head.push({ type: 'actions', block_id: id('actions'), elements: top });
    const lines = [p.note && p.note.version === v ? p.note.text : null, status].filter(Boolean);
    if (lines.length) head.push({ type: 'context', block_id: id('status'), elements: [mrkdwn(lines.join('\n'))] });
    head.push({ type: 'context', block_id: id('caption'), elements: [mrkdwn(ROUTE_WORDS.caption(office(), clock(limits.defaultStart)))] });
    const blocks = [{ type: 'section', block_id: id('leave'), text: mrkdwn(ROUTE_WORDS.leave(office(), clockPlus(ev.leaveAt))) }];
    // The aim-finish line sits before the first stop that finishes past it.
    const late = ev.stops.findIndex((st) => st.finish > limits.aimFinish);
    ev.stops.forEach((st, i) => {
      const k = i + 1;
      if (i === late) blocks.push({ type: 'context', block_id: id('after'), elements: [mrkdwn(ROUTE_WORDS.after(clock(limits.aimFinish)))] });
      const place = p.places.get(p.nodeOf.get(st.stopId)) || { client: 'a stop', area: null };
      const rowLines = [
        `${numberOf(k)} *${clockDay(st.start)} ${place.client}*${place.area ? `${SEP}${place.area}` : ''}`,
        detailLine(st, limits),
      ];
      if (p.flagged.has(st.stopId)) rowLines.push(`${WARN} ${ROUTE_WORDS.unplaced()}`);
      if (p.filled && p.filled.stopId === st.stopId) rowLines.push(`${FILL_MARK} ${ROUTE_WORDS.filled(escapeText(p.filled.from))}`);
      const accessory = p.out ? null : menu(v, i, ev.stops.length);
      blocks.push({
        type: 'section', block_id: `routing-map:stop:${k}:${v}`, text: mrkdwn(rowLines.join('\n')), ...(accessory ? { accessory } : {}),
      });
    });
    const back = [ROUTE_WORDS.back(office(), clockPlus(ev.backAt))];
    if (ev.lateBack) back.push(ROUTE_WORDS.lateBack(clock(limits.latestFinish)));
    blocks.push({ type: 'section', block_id: id('back'), text: mrkdwn(back.join('\n')) });
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

  // A stop's ring on the map (Story 15.18, AD-R29): its hardest rule break.
  const flagOf = (st) => {
    if (st.breaks.some((b) => b.strength === 'hard')) return 'hard';
    return st.breaks.length ? 'soft' : 'none';
  };

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
      route: { crewId: p.crewId, stops: evaluated.ev.stops.map((st) => ({ node: p.nodeOf.get(st.stopId), flag: flagOf(st) })) },
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
    if (model.route.stops.some((st) => st.flag !== 'none')) caption.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ROUTE_WORDS.legend() }] });
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
    mod, s, show, showMap, showList, recheck, fill = null,
  }) {
    const number = sessions.next(s);
    const current = () => sessions.isCurrent(s, number);
    const crewId = s.scope.all !== true ? s.scope.crewId : s.picks.crew;
    if (typeof crewId !== 'string' || !crewId) {
      // No crew picked (none offered that day, say): nothing is read.
      log.info('routing map click refused', { action: 'show', reason: 'no crew' });
      await show(stepOne(s, ROUTE_WORDS.pickCrew()), { current });
      return;
    }
    let loaded;
    try {
      loaded = await load(mod, s, fill);
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
        log.info('routing map click', { module: mod.id, action: which, view: 'route' });
        return dayPicked({
          mod, s, day, number, show,
        });
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
    if (which === 'move') {
      // An overflow click carries the chosen option, never a value of its own.
      const option = action && action.selected_option;
      const move = parseMove(option && typeof option.value === 'string' ? option.value : null);
      if (!move) return refuse(which, 'malformed');
      if (move.version !== p.version) return refuse(which, 'stale version');
      if (move.index >= p.order.length) return refuse(which, 'out of range');
      if (!movesAt(move.index, p.order.length).includes(move.target)) return refuse(which, 'not offered');
      const { next, from, to } = moved(p.order, move.index, move.target);
      p.order = next;
      // Optimize's "kept at the end" flag holds only while the stop stays
      // where Optimize put it: every stop the move shifts loses it.
      for (let k = from; k <= to; k += 1) p.flagged.delete(p.order[k]);
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
    let words = null;
    if (which === 'optimize') {
      const res = engine.optimizeDay(p.input, { travel: p.travel, returnToBase: true });
      const plan = res.plans.find((x) => x.crewId === p.crewId) || { stops: [] };
      const placed = plan.stops.map((x) => x.stopId);
      const rest = p.booked.filter((id) => !placed.includes(id));
      next = [...placed, ...rest];
      p.flagged = new Set(rest);
      words = sameOrder(next, p.order) ? ROUTE_WORDS.best() : optimizedWords(evaluate(p).ev, evaluate({ ...p, order: next }).ev);
    } else {
      next = p.booked.slice();
      p.flagged = new Set();
    }
    if (!sameOrder(next, p.order)) {
      p.order = next;
      p.version += 1;
    }
    // Optimize's line stays with this version (the map's update too); a
    // later move or Reset makes a new version, and the line goes.
    p.note = words ? { version: p.version, text: words } : null;
    log.info('routing map click', { module: mod.id, action: which, view: 'route' });
    return changed(go);
  }

  // Customer cancellation's Fill with #n (Story 19.4): step 2 on the crew's
  // day with the candidate in the gap. s.picks names the crew and day.
  const showFill = (args) => showStops(args);

  return {
    unready, open, click, ACTIONS, crewChoices, takeCrews, showFill,
  };
}

module.exports = {
  createEditor, parseMove, movesAt, optimizedWords, shortDay, headerText, SCREEN, ACTIONS, MAX_STOPS, MAP_DELAY_MS,
};
