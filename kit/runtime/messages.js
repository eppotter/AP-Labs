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
const { RoutingFault, ContextRefused, FileRefused } = require('./errors');

// Slack mrkdwn treats &, < and > as control characters.
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A name shown inside mrkdwn formatting (a bold client, the Office in a bold
// label): escaped, and with Slack's formatting marks (* _ ~ `) swapped for
// look-alikes, so a name holding one can't end the bold early or start
// italics or strikethrough (#256). Slack mrkdwn has no backslash escape.
const LOOKALIKE = Object.freeze({
  '*': '\u2217', _: '\u02CD', '~': '\u223C', '`': '\u02CB',
});
function escapeName(s) {
  return escapeText(s).replace(/[*_~`]/g, (ch) => LOOKALIKE[ch]);
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
  bad_node: ({ field }) => `"${field}" is not a place id (property:<id>, crew:<id> or depot:<id>)`,
  bad_date: ({ field }) => `"${field}" is not a date written as YYYY-MM-DD`,
  bad_strength: ({ field }) => `"${field}" is neither hard nor soft`,
  unknown_crew: ({ field }) => `"${field}" names a crew that isn't in the day`,
  duplicate: ({ field }) => `"${field}" appears more than once`,
  no_travel: ({ from, to }) => `there is no drive time from ${from} to ${to}`,
  unknown_rule: ({ field }) => `"${field}" names a rule that isn't registered`,
  not_overridable: ({ field }) => `"${field}" tries to change a rule that is always hard`,
  not_function: ({ field }) => `"${field}" is not a check the engine can run`,
  unknown_weight: ({ field }) => `"${field}" names a ranking input the engine doesn't have`,
  bad_weights: ({ field }) => `"${field}" are not ranking weights the scoring check accepts`,
  // travelMatrix (Story 13.2): fixed words, never the query's own text.
  routing_off: ({ field }) => `"${field}" needs a routing block in the profile, and there is none`,
  too_many_pairs: ({ field }) => `"${field}" asks for more drive times than the profile allows at once`,
  not_coordinate_column: ({ field }) => `"${field}" is not a whole-number coordinate column in the data`,
  shared_column_name: ({ field }) => `"${field}" has the same name as a protected column in another table`,
  no_position: ({ field }) => `"${field}" names a place with no position in the data`,
  data_unavailable: ({ field }) => `"${field}" could not reach the data`,
  query_refused: ({ field }) => `"${field}" was refused by the query check`,
  query_failed: ({ field }) => `"${field}" failed while reading the data`,
  // The map renderer (Story 15.3): fixed words, never the model's values.
  unknown_key: ({ field }) => `"${field}" holds a field the map does not take`,
  renderer_unavailable: ({ field }) => `"${field}" can't be drawn: the map drawing tool didn't load`,
  renderer_failed: ({ field }) => `"${field}" couldn't be drawn`,
  image_too_large: ({ field }) => `"${field}" came out larger than the size Slack is sent`,
  unsafe_svg: ({ field }) => `"${field}" was refused: it names something outside the map`,
  basemap_invalid: ({ field }) => `"${field}" was refused: its street map squares are not ones the map can draw`,
  // A route order for evaluateOrder (Story 15.12).
  missing_stop: ({ field }) => `"${field}" leaves out one of the crew's stops`,
  unknown_stop: ({ field }) => `"${field}" names a stop that isn't in the day`,
  other_crew_stop: ({ field }) => `"${field}" names a stop on another crew`,
  // Add a stop (Story 19.5).
  locked: ({ field }) => `"${field}" is locked, and a new stop has no booked start`,
  not_working: ({ field }) => `"${field}" names a crew that isn't working that day`,
  unknown_client: ({ field }) => `"${field}" names a client that can't be added to this crew's day`,
  day_changed: ({ field }) => `"${field}" changed since the day was shown`,
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

// The routing map's own words (Story 15.4): what the view says while it
// draws and when a click cannot draw. Plain, each with a next step; nothing
// in them comes from the data except the dates and the module's label, which
// the caller escapes.
const MAP_WORDS = Object.freeze({
  drawing: () => 'Drawing the map…',
  expired: (label) => `This map has expired (a map closes after 15 minutes without use). Go back and open ${label} again.`,
  notYours: () => "This map belongs to another window, so I can't change it. Go back and open it again from the menu.",
  badDate: (from, to) => `That day is outside what this map can show, so nothing was read. Pick a day from ${from} to ${to}.`,
  planFailed: (admin) => `The map for this day couldn't be worked out, so nothing is drawn. I've logged the problem; please tell ${admin}. Press Back to return to the menu.`,
  drawFailed: (admin) => `The map couldn't be drawn this time, so nothing is shown. Press Back to return to the menu and try again; if it keeps happening, tell ${admin}.`,
  noCrews: (day) => `No crews are working on ${day}, so there's nothing to draw.`,
  streetsUnavailable: () => 'Street map unavailable, showing the plain map.',
  // A screen that cannot open (Story 19.4: the hub checks first, so this is
  // the archetype's own fail-closed line).
  notReady: () => "This tool isn't set up yet, so nothing was read. Press Back to return to the menu.",
});

// Plan a route's own words (Story 15.14, AD-R26, AD-R27). The crew, the
// Office's label and the day are escaped by the caller.
const ROUTE_WORDS = Object.freeze({
  pick: () => 'Pick a crew and a day, then press *Show stops*.',
  expired: (label) => `This plan has expired, go back and open ${label} again.`,
  updating: () => 'Map updating…',
  notUpdated: () => 'Map not updated; the list is current.',
  // Story 15.17 (AD-R29): the caption at the top of step 2, the status line
  // after Optimize, the Office bookends, the aim-finish divider and the four
  // summary fields. Times are clock strings the caller builds.
  caption: (office, time) => `Estimates from the ${office} at ${time} · suggestions only, nothing is saved`,
  optimized: (drive, back) => `Optimized: drive ${drive}, back ${back}`,
  leave: (office, time) => `🏠 *Leave ${office}* ${time}`,
  back: (office, time) => `🏠 *Back at ${office}* ${time}`,
  lateBack: (time) => `🔴 past the crew day's end (${time})`,
  after: (time) => `After ${time}`,
  drive: (words) => `🚐 *Drive*\n${words}`,
  distance: (km) => `📏 *Distance*\nabout ${km} km`,
  backField: (office, time) => `🏁 *Back at ${office}*\n${time}`,
  breaksField: (total, hard) => (total ? `${hard ? '🔴' : '🟠'} *Rule breaks*\n${total} (${hard} hard)` : '✅ *Rule breaks*\nnone'),
  noStops: (crew, day) => `${crew} has no stops booked on ${day}, so there is nothing to plan.`,
  tooMany: (crew, n, max) => `${crew} has too many stops to plan here (${n}; at most ${max}).`,
  notWorking: (crew, day) => `${crew} isn't working on ${day}, so there is nothing to plan.`,
  crewOut: (crew, day) => `${crew} is marked out on ${day}. The list is read-only.`,
  best: () => 'Already the best order found.',
  unplaced: () => 'Optimize could not place this stop, so it is kept at the end.',
  pickCrew: () => 'Pick a crew first, then press *Show stops*.',
  // The map's ring colours (Story 15.18, AD-R29), under the image when a stop has one.
  legend: () => '🟠 ring: soft rule break · 🔴 ring: hard rule break',
  // A stop's ⋯ menu (Story 15.16, AD-R29): each option names the stop.
  move: (k, target) => `Move stop ${k} ${{ up: 'up', down: 'down', first: 'to first', last: 'to last' }[target]}`,
  // A stop row's second line: the hardest rule break, shortened, then the
  // others counted. Times are clock strings the caller builds.
  more: (n) => `+${n} more`,
  pastAim: (time, late) => `past ${time} (+${late})`,
  overDay: (time) => `over crew day (ends ${time})`,
  beforeDay: (time) => `before crew day (starts ${time})`,
  lockedLate: (time) => `missed locked start (starts ${time})`,
  outsideHours: (time) => `outside customer's hours (starts ${time})`,
  wrongDay: () => "not one of the customer's days",
  notPreferred: () => 'not the preferred crew',
  // Customer cancellation's Fill with #n (Story 19.4): the stop moved up.
  filled: (from) => `Moved up from ${from} to fill the gap; call to confirm`,
});

// The two what-if screens (Story 19.4, plan brightside-v1 D8): Customer
// cancellation and Crew out. Names and days are escaped by the caller.
const WHATIF_WORDS = Object.freeze({
  pickVisits: () => 'Pick a crew and a day, then press *Show visits*.',
  pickOut: () => 'Pick a day and a crew, then press *Mark out for the day*.',
  pickCrew: (button) => `Pick a crew first, then press *${button}*.`,
  whichVisit: (crew, day) => `*${crew}, ${day}*\nWhich visit cancels? Pick it to see which visits could fill the gap.`,
  noVisits: (crew, day) => `${crew} has no visits booked on ${day}, so no visit can cancel.`,
  cancels: (client, time) => `*What if ${client}'s visit at ${time} cancels?*`,
  cancelled: (client, time) => `*${client}'s visit at ${time} is cancelled in the data.* These could fill its gap.`,
  out: (crew, day) => `*What if ${crew} is out on ${day}?*`,
  alreadyOut: (crew, day) => `*${crew} is out on ${day} in the data,* so this is the plan for it.`,
  fillHelp: () => 'Press *Fill with #n* to see the day with that visit moved up.',
  suggestOnly: () => 'Suggestions only: nothing is changed.',
});

// Add a stop (Story 19.5, plan brightside-v1 D8): its form in Plan a route's
// list, and the added stop's lines. Names and days are escaped by the caller.
const ADD_WORDS = Object.freeze({
  form: (crew, day) => `*Add a stop to ${crew} on ${day}*\nSearch for a client of this crew's zone by name, pick how long the visit takes and when it may start, then press *Add*.`,
  formNote: () => "Clients of this crew's zone, by name only. Suggestions only: nothing is booked.",
  pickClient: () => 'Pick a client first, then press *Add*.',
  adding: () => 'Working out where the stop fits…',
  cannotAdd: () => "That client can't be added to this day: they already have a visit that day, or they aren't in this crew's zone. Pick another client.",
  dayChanged: () => "This day's bookings changed since it was shown, so the stop wasn't added. Press *Back to the day*, then *Change crew or day*, and *Show stops* again.",
  added: () => 'Added stop: a suggestion only, nothing is booked',
  placedLast: () => 'No place on this crew keeps every hard rule, so it is placed last',
  others: (list) => `Other crews in the zone that could take it: ${list}`,
  other: (crew, k, time, drive) => `${crew} (stop ${k} at ${time}, ${drive})`,
  noOthers: () => 'No other crew in the zone has room for it.',
});

const num = (n) => Number(n).toLocaleString('en-US');

// Why a new added-context entry was refused (Story 16.4, worded here since
// Story 16.5). max: the cap, in characters or entries. Nothing was stored.
const CONTEXT_WORDS = Object.freeze({
  empty: () => 'There is nothing to add: the text is empty.',
  too_long: (max) => `That is too long to add. At most ${num(max)} characters fit, and each <, > or & counts as 4 or 5. Shorten it and try again.`,
  hub_full: (max) => `This hub's added context is full (${num(max)} characters in all). Remove an entry to make room, then try again.`,
  too_many: (max) => `This hub already holds ${max} entries, the most it can. Remove one to make room, then try again.`,
});

// A file refused by Add context (Story 16.8). Nothing was added in any case.
const mb = (bytes) => `${Math.round((Number(bytes) / (1024 * 1024)) * 10) / 10} MB`;
const FILE_WORDS = Object.freeze({
  type: () => 'I can read PDF, PNG, JPEG, GIF and WebP files, .csv files, and .txt or .md text files. Choose one of those, or type the text instead.',
  docx: () => "I can't read Word, Excel or other office files yet. Save it as a PDF first, then upload the PDF. For a sheet, you can save it as a .csv instead.",
  size: (max) => `That file is too big: I read files of at most ${mb(max)}. Split it or make it smaller, then try again.`,
  signature: () => "That file isn't what its name says it is (its contents don't match its type), so I didn't read it. Save it again in the right format, then try again.",
  pages: (max) => `That PDF has more than ${num(max)} pages, the most I read in one go. Split it into smaller PDFs, then add each one.`,
  pages_unreadable: () => "I couldn't count the pages in that PDF, so I didn't read it. Save or print it to a new PDF, then try again.",
  pixels: (max) => `That image is too large: at most ${num(max)} pixels wide and tall. Make it smaller, then try again.`,
  encoding: () => "That text file isn't plain UTF-8 text, so I didn't read it. Save it as UTF-8 text, or paste the text in instead.",
  not_owner: () => 'You can only add a file you uploaded yourself. Upload your own copy, then try again.',
  not_found: () => 'Slack says that file is gone, so nothing was added. Choose the file again, then try again.',
  info_failed: () => "I couldn't get that file from Slack just now, so nothing was added. Press Back and try again in a minute.",
  download_failed: () => "I couldn't download that file from Slack just now, so nothing was added. Press Back and try again in a minute.",
  too_long: (max) => `I took more than ${num(max)} characters from that file, more than one entry holds. Split the file into smaller parts, then add each one.`,
  empty: () => "I couldn't take any text from that file, so nothing was added. Try a clearer copy, or type the text instead.",
  too_costly: () => "That file is too large to read within this hour's limit for reading files. Split it into smaller parts, then add each one.",
  not_set_up: (max, admin) => `Reading files isn't set up on this bot, so nothing was added. Type the text instead, or tell ${admin}.`,
  // A .csv file (plan brightside-v1, D3, Story 18.2).
  csv_too_big: () => 'That CSV is too big for a note: at most 200 rows, 30 columns and about 6,000 characters. Keep the rows you need, or split it.',
  csv_ragged: () => "Every row of a CSV needs as many columns as its header row, and at least one row in that file doesn't, so nothing was added. Save the sheet as a CSV again, then try again.",
  csv_quote: () => 'That CSV has a quote mark (") left open or out of place, so I can\'t tell where a value ends. Nothing was added. Save the sheet as a CSV again, then try again.',
  csv_no_rows: () => 'That CSV has a header row but no rows under it, so nothing was added. Add the rows you need, then try again.',
});

// The AI refusing to read an uploaded file (Story 16.8): each says nothing
// was added and that typing the text still works. reason: an LlmUnavailable
// reason (kit/runtime/errors LLM_REASONS).
const READ_FILE_AI_WORDS = Object.freeze({
  off: () => 'Reading files needs the AI, which is off right now, so nothing was added. Type the text instead.',
  no_key: () => 'Reading files needs the AI, which is off on this bot, so nothing was added. Type the text instead.',
  config: (admin) => `Reading files needs the AI, which isn't set up correctly, so nothing was added. I've logged the problem; please tell ${admin}. You can type the text instead.`,
  too_long: () => "I couldn't read that file, so nothing was added. Type the text instead.",
  rate_limited: (admin, { perHour = 20 }) => `You've reached the limit of ${perHour} AI requests an hour, so I didn't read that file and nothing was added. Type the text instead, or try again later.`,
  over_budget: () => "Reading files has reached the AI's spending limit for this hour, so nothing was added. Type the text instead, or try again later.",
  failed: () => "I couldn't read that file just now, so nothing was added. Press Back and try again in a minute, or type the text instead.",
});
function readFileAiText(err, { admin = 'your admin' } = {}) {
  const details = (err && err.details) || {};
  const words = READ_FILE_AI_WORDS[details.reason] || READ_FILE_AI_WORDS.failed;
  return words(admin, details);
}

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
  // Added context (Stories 16.4, 16.5).
  [ContextRefused, ({ reason, max }) => CONTEXT_WORDS[reason](max)],
  [FileRefused, ({ reason, max }, { admin }) => FILE_WORDS[reason](max, admin)],
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

// Build request's own words (plan brightside-v0, D11, Story 16.6). Fixed
// text, plain and each with a next step; admin is Slack mrkdwn
// (access.adminContact), maxChars and minutes are the engine's numbers.
const BUILD_REQUEST_WORDS = Object.freeze({
  label: () => 'What do you need?',
  hint: (maxChars) => `Describe the tool or change you'd like, in your own words (${maxChars} characters at most). You'll see a preview before anything is posted.`,
  empty: () => 'Type what you need first.',
  tooLong: (maxChars) => `That's too long: ${maxChars} characters at most.`,
  thinking: () => 'Thinking…',
  willPost: () => 'This will post to the build-request channel as you:',
  notSummarised: () => "The AI helper couldn't summarise this just now, so the preview shows your own words, not summarised.",
  posted: () => 'Posted. The AP Labs team will pick it up.',
  posting: () => 'This request is being posted now. It will only be posted once.',
  alreadyPosted: () => 'This request was already posted. It is only posted once.',
  cancelled: () => 'Cancelled. Nothing was posted. Press Back to return to the menu.',
  wasCancelled: () => 'This request was cancelled, so nothing was posted. Press Back and open Request a tool to start again.',
  expired: (minutes) => `This preview has expired (a preview lasts ${minutes} minutes), so nothing was posted. Press Back and open Request a tool to start again.`,
  notYours: () => "This preview belongs to someone else's window, so I can't post it. Press Back and open Request a tool to start your own.",
  refused: (admin) => `Slack didn't take the post, so nothing was posted. Press Try again, or Back to leave it. If it keeps happening, tell ${admin}.`,
  notSetUp: (admin) => `Tool requests aren't set up yet: no channel to post them to. Ask ${admin} to set one up.`,
  // A hub whose sees is not a list of known values (fail closed; plan
  // brightside-v1, D12: any well-formed hub may post).
  notOnThisHub: () => "Request a tool isn't set up correctly on this hub, so it can't post from here. Use it from another hub.",
});
// The tool's name wherever the bot names it (plan hub-status-menu, D10):
// "Request a tool". The archetype and its resource key keep their names.
const REQUEST_A_TOOL = 'Request a tool';

// Ask (plan brightside-v0, D10, Story 16.7). Written by the bot, never by
// the AI; a tool's label comes from its reviewed manifest and is escaped
// here. The four readiness messages, one per state of a hub's data and rules
// (kit/runtime/knowledge/readiness), decide every data question: Ask never
// writes or runs SQL.
const ASK_WORDS = Object.freeze({
  label: () => 'Ask a question',
  hint: (maxChars) => `In your own words, ${maxChars} characters at most.`,
  empty: () => 'Type a question first.',
  tooLong: (maxChars) => `That's too long: ${maxChars} characters at most.`,
  thinking: () => 'Thinking…',
  // Data questions, by readiness (D10's table).
  noDataNoRules: () => "I can't answer data questions yet. No data is connected, and there are no rules yet for using it safely.",
  dataNoRules: () => "Data is connected, but the rules for using it safely (approved tables, known truths, columns to keep out) aren't set up yet, so I won't pull from it.",
  rulesNoData: () => 'The rules are set up, but no data is connected yet.',
  noToolYet: () => "There's no tool for that yet.",
  // A tool that fits, from the person's own openable list. verb: the tool's
  // menu verb (plan hub-status-menu, D10), the text of its button.
  tool: (label, verb) => `*${escapeName(label)}* can help with that. Press ${escapeText(verb)} to use it.`,
  notSorted: () => "I couldn't sort that question. Try asking it another way.",
  noAnswer: () => "I couldn't answer that just now. Try asking it another way.",
  notWhatYouNeeded: () => 'Not what you needed?',
  // When the Request a tool button is hidden (review B9).
  askAdmin: (admin) => `Not what you needed? Tell ${admin} what you were looking for.`,
});

// Why? (plan hub-status-menu, D7, Story 17.3): the words a waiting tool's
// Why? screen adds to the existing ones (ASK_WORDS' readiness lines,
// BUILD_REQUEST_WORDS' notSetUp and notOnThisHub, add-context's NO_STORE).
// admin is Slack mrkdwn (access.adminContact); verb is a menu verb and
// label a reviewed manifest label, both escaped here.
const WHY_WORDS = Object.freeze({
  noMap: (admin) => `The map isn't set up on this bot yet. Ask ${admin}.`,
  noAi: (admin) => `The AI helper isn't set up on this bot yet. Ask ${admin}.`,
  readyNow: (verb) => `This is ready now. Press Back, then ${escapeText(verb)} it from the menu.`,
  askAdmin: (admin) => `Ask ${admin} about it.`,
  request: (label) => `Need it, or something else? Tell the team with *${escapeName(label)}*.`,
  requestInWindow: (label) => `Need it, or something else? Use *${escapeName(label)}* from the hub's window.`,
});

// Hub wording (Story 6.4). A hub file may set its own welcome and feedback
// lines; these defaults keep a hub without them working. The welcome sits
// below the menu's strip, which already says what is set up, so it is kept
// short (plan hub-status-menu, D9).
function welcomeText(hub) {
  if (hub.welcome) return escapeText(hub.welcome);
  return `Welcome to ${escapeText(hub.name)}. `
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
  messageFor, escapeText, escapeName, welcomeText, feedbackText, joinWelcomeText, pushResultText, FILE_WORDS, READ_FILE_AI_WORDS, readFileAiText, READ_WORDS, MAP_WORDS, ROUTE_WORDS, WHATIF_WORDS, ADD_WORDS,
  BUILD_REQUEST_WORDS, ASK_WORDS, REQUEST_A_TOOL, WHY_WORDS,
};
