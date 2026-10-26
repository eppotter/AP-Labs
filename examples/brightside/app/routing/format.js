'use strict';

// Plain-text output for the dispatcher's routing CLI (Story 14.5, AD-R11).
// Pure: each function takes the adapter's input, the engine's result and the
// names lookup, and returns the text to print. Nothing here reads data or
// writes anywhere.
//
// What a line may hold: crew names and numbers, zone names, client names,
// the city, stop numbers, dates, clock times, minutes, and the engine's own
// reasons (built from rule labels, crew ids, clock times and minutes only).
// Never a coordinate, a street address or a postal code: the names lookup
// holds only client name and city per property, and crew and zone names.
//
//   names = {
//     crews:  Map crewId -> { name, zone }
//     places: Map propertyId -> { client, city }
//   }
// A node is kind-prefixed (property:<id>, crew:<id>); only property nodes are
// shown, by client name and city.

const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const SUGGEST_ONLY = 'Suggestion only: nothing has been changed. Call each customer to confirm before moving a visit.';

const pad2 = (n) => String(n).padStart(2, '0');
const clock = (minutes) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The weekday of an ISO date, from the calendar alone (no clock, no zone).
function weekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

const dayWords = (day) => `${weekday(day)} ${day}`;

function crewWords(names, crewId) {
  const crew = names.crews.get(String(crewId));
  return crew ? `${crew.name} (crew ${crewId}, zone ${crew.zone})` : `crew ${crewId}`;
}

function crewShort(names, crewId) {
  const crew = names.crews.get(String(crewId));
  return crew ? `${crew.name} (crew ${crewId})` : `crew ${crewId}`;
}

// A property node as "Client Name, City"; anything else as "a stop".
function placeWords(names, node) {
  const m = /^property:(\d+)$/.exec(String(node));
  const place = m ? names.places.get(m[1]) : null;
  return place ? `${place.client}, ${place.city}` : 'a stop';
}

// stopId -> the stop, from every list the input holds.
function stopIndex(input) {
  const index = new Map();
  for (const list of [input.stops, input.cancelled || [], input.candidates || []]) {
    for (const s of list) index.set(s.stopId, s);
  }
  return index;
}

function stopWords(names, index, stopId, extra = '') {
  const stop = index.get(stopId);
  return `${stop ? placeWords(names, stop.node) : 'a stop'} [stop ${stopId}${extra}]`;
}

const reasonLine = (reason) => `     ${reason}`;

function section(lines, title, rows, render) {
  lines.push('', `${title} (${rows.length}):`);
  if (rows.length === 0) lines.push('  none');
  for (const row of rows) lines.push(...render(row));
}

// optimize: each working crew's suggested order, with booked times for
// comparison, moves between crews and anything that could not be placed.
function formatOptimize({ input, result, names, crewIds }) {
  const index = stopIndex(input);
  const scope = crewIds && crewIds.length > 0 ? ` (${crewIds.map((id) => crewShort(names, id)).join(', ')} only)` : '';
  const lines = [`Suggested routes for ${dayWords(input.day)}${scope}`, SUGGEST_ONLY];
  if (input.stops.length === 0) {
    lines.push('', `No stops are booked on ${input.day}.`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `Result: ${result.source === 'booked' ? 'keep the booked order' : 'a new order is suggested'}; ${result.reason}.`,
    `Driving: booked ${result.booked.driveMinutes} min, suggested ${result.cost.driveMinutes} min. `
      + `Hard-rule breaks: booked ${result.booked.hardBreaks}, suggested ${result.cost.hardBreaks}.`,
  );
  const out = input.crews.filter((c) => !c.available && (!crewIds || crewIds.includes(c.crewId)));
  if (out.length > 0) lines.push(`Not working: ${out.map((c) => crewShort(names, c.crewId)).join(', ')} (use the change command for their stops).`);
  for (const plan of result.plans) {
    if (plan.stops.length === 0) continue;
    const drive = plan.stops.reduce((n, s) => n + s.travelMinutesFromPrevious, 0);
    lines.push('', `${crewWords(names, plan.crewId)}: ${plural(plan.stops.length, 'stop')}, ${drive} min driving`);
    for (const s of plan.stops) {
      const booked = index.get(s.stopId);
      const was = booked && Number.isInteger(booked.start) && booked.start !== s.start ? `, booked ${clock(booked.start)}` : '';
      lines.push(`  ${s.routeOrder}. ${clock(s.start)}  ${stopWords(names, index, s.stopId, was)}`, reasonLine(s.reason));
    }
  }
  if (result.moves.length > 0) {
    section(lines, 'Moved between crews', result.moves, (m) => [
      `  ${stopWords(names, index, m.stopId)}: ${crewShort(names, m.fromCrew)} to ${crewShort(names, m.toCrew)}`,
      reasonLine(m.reason),
    ]);
  }
  if (result.unplaced.length > 0) {
    section(lines, 'Could not be placed', result.unplaced, (u) => [`  ${stopWords(names, index, u.stopId)}`, reasonLine(u.reason)]);
  }
  return `${lines.join('\n')}\n`;
}

// change: a crew is out; where each of its stops goes, what is only a
// recommendation, what to rebook and which existing stops move.
function formatChange({ input, result, names }) {
  const index = stopIndex(input);
  const lines = [`Route change for ${dayWords(input.day)}`, SUGGEST_ONLY, `Result: ${result.reason}.`];
  if (result.crewsOut.length === 0) return `${lines.join('\n')}\n`;
  lines.push(`Not working: ${result.crewsOut.map((id) => crewWords(names, id)).join(', ')}`);
  const placed = result.moves.filter((m) => !m.crossZone);
  const cross = result.moves.filter((m) => m.crossZone);
  section(lines, 'Placed in their zone', placed, (m) => [
    `  ${clock(m.start)}  ${stopWords(names, index, m.stopId)}: ${crewShort(names, m.fromCrew)} to ${crewShort(names, m.toCrew)}`,
    reasonLine(m.reason),
  ]);
  section(lines, 'Recommended for another zone, not placed (a dispatcher decides)', cross, (m) => [
    `  ${clock(m.start)}  ${stopWords(names, index, m.stopId)}: ${crewShort(names, m.fromCrew)} to ${crewWords(names, m.toCrew)}`,
    reasonLine(m.reason),
  ]);
  section(lines, 'To rebook', result.unplaced, (u) => [`  ${stopWords(names, index, u.stopId)}`, reasonLine(u.reason)]);
  section(lines, 'Existing stops to confirm a new time', result.shifted, (s) => [
    `  ${stopWords(names, index, s.stopId)} on ${crewShort(names, s.crewId)}: ${clock(s.previousStart)} to ${clock(s.start)}`,
    reasonLine(s.reason),
  ]);
  return `${lines.join('\n')}\n`;
}

// gap: each gap a cancellation leaves on the crew, the ranked visits that
// could be moved up into it, and (with all) every one left out and why.
function formatGap({ input, result, names, crewId, all = false }) {
  const index = stopIndex(input);
  const lines = [`Gap fill for ${dayWords(input.day)}, ${crewWords(names, crewId)}`, SUGGEST_ONLY];
  const gaps = result.gaps.filter((g) => g.crewId === String(crewId));
  if (gaps.length === 0) {
    lines.push(`Result: no visit was cancelled on ${crewShort(names, crewId)} on ${input.day}; no gap to fill.`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(`Result: ${result.reason}.`);
  gaps.forEach((gap, k) => {
    const after = gap.after === null ? 'the start of the day' : stopWords(names, index, gap.after);
    const before = gap.before === null ? 'the end of the day' : stopWords(names, index, gap.before);
    lines.push(
      '',
      `Gap ${k + 1}: ${clock(gap.from)} to ${clock(gap.to)} (${gap.minutes} min), after ${after}, before ${before}`,
      `  Cancelled: ${gap.cancelled.map((id) => stopWords(names, index, id)).join('; ')}`,
      `  ${gap.reason}.`,
    );
    for (const c of gap.candidates) {
      const also = c.alsoOfferedFor.length > 0 ? `; also offered for the gap of stop ${c.alsoOfferedFor.join(', ')}` : '';
      lines.push(
        `  ${c.rank}. ${clock(c.start)}  ${stopWords(names, index, c.stopId)}, booked for ${c.plannedDate} (${plural(c.daysMovedUp, 'day')} earlier), `
          + `${c.extraDriveMinutes} min extra driving${also}`,
        reasonLine(c.reason),
      );
    }
    if (all) {
      section(lines, '  Left out', gap.excluded, (e) => [`  ${stopWords(names, index, e.stopId)}`, reasonLine(e.reason)]);
    } else if (gap.excluded.length > 0) {
      lines.push(`  Left out: ${plural(gap.excluded.length, 'other visit')} (add --all to list each with its reason).`);
    }
  });
  return `${lines.join('\n')}\n`;
}

module.exports = { formatOptimize, formatChange, formatGap, clock, weekday, placeWords, SUGGEST_ONLY };
