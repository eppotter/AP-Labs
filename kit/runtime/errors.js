'use strict';

// Typed errors the engine raises when it refuses (AD-17). Each carries only
// what its message needs; kit/runtime/messages.js turns it into words. More
// kinds land with their stories (GuardrailBlocked, ...).

class RuntimeRefusal extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

// The Slack id matches no profile user. details: { client, admin }
class NotSetUp extends RuntimeRefusal {
  constructor(details) { super('person is not set up in the profile', details); }
}

// A known person the profile does not allow. details: { label, admin }
class AccessDenied extends RuntimeRefusal {
  constructor(details) { super('access denied by the profile', details); }
}

// The setup is wrong (for example a resource key the profile does not
// declare). Never shown as a denial. details: { admin }
class ConfigFault extends RuntimeRefusal {
  constructor(details) { super('configuration fault', details); }
}

// The data source is missing or cannot be opened (Story 7.5). reason is for
// the log, never shown to the person. kit/runtime/data raises it (and exports
// it as DataUnavailableError); code stays 'DATA_UNAVAILABLE'.
class DataUnavailable extends RuntimeRefusal {
  constructor(reason) {
    super(`data unavailable: ${reason}`, { reason });
    this.code = 'DATA_UNAVAILABLE';
    this.reason = reason;
  }
}

// A connector write was refused because a kill switch is on: the connector's
// own (killSwitchEnv) or the global APLABS_WRITES_OFF (Story 8.1). Raised
// before any I/O, so nothing was written, unless the switch flipped partway
// through a write: then details.sent ({ batches, items }) says what had gone
// (#89). details: { connector, system, env, sent? }
class KillSwitchOn extends RuntimeRefusal {
  constructor(details) {
    super(`writes to ${details.system} are switched off (${details.env})`, details);
    this.code = 'KILL_SWITCH_ON';
  }
}

// A connector write was refused whole because the system's own limit for a
// period is reached (Story 20.1: the mock email tool's 200 emails a day).
// Nothing was sent; a retry after the period may go. Not an outage, so not
// escalated. details: { connector, system, operation, what, limit, period }
// (what: a short plain noun such as "email"; period: 'day').
class LimitReached extends RuntimeRefusal {
  constructor(details) {
    super(`${details.system} refused the write: today's ${details.what} limit (${details.limit} a ${details.period}) is reached`, details);
    this.code = 'LIMIT_REACHED';
  }
}

// A connector call failed (Story 8.1). reason is already redacted and is for
// the log, never shown to the person. details: { connector, system, operation },
// plus sent ({ batches, items }) when a write failed after some requests went.
class ConnectorFailed extends RuntimeRefusal {
  constructor(reason, details) {
    super(`${details.system} ${details.operation} failed: ${reason}`, details);
    this.code = 'CONNECTOR_FAILED';
    this.reason = reason;
  }
}

// The system refused the connector's credentials, or a declared credential is
// not set (then details.setup is true: a setup fault, worded apart from a
// rejected key). Reads and writes fail closed: no data comes back. Same details.
class ConnectorAuthFailed extends ConnectorFailed {
  constructor(reason, details) {
    super(reason, details);
    this.code = 'CONNECTOR_AUTH_FAILED';
  }
}

// A write reused an idempotency key with a different input. Nothing was sent:
// answering with the first result would hide rows the caller meant to send.
// Same details; reason is for the log.
class IdempotencyConflict extends ConnectorFailed {
  constructor(reason, details) {
    super(reason, details);
    this.code = 'IDEMPOTENCY_CONFLICT';
  }
}

// A batch write partly applied (#90). The items that succeeded were recorded
// with their keys and the failed ones were not, so a retry with the same input
// sends only the failed ones: nothing is sent twice. An adapter throws it from
// a write's apply with { succeeded, failed, failedRefs }; the contract rebuilds
// it with the connector's details, checks the counts and masks any ref that
// is not id-shaped. failedRefs are the failed items' external ids (never
// contact data), for the log only: the person sees the counts.
// details: { connector, system, operation, succeeded, failed, failedRefs }
class PartialFailure extends ConnectorFailed {
  constructor(reason, details = {}) {
    super(reason, details);
    this.code = 'PARTIAL_FAILURE';
  }
}

// A scoped-pull form click whose session is gone: idle 30 minutes, or never
// known (Story 9.3). details: {}
class SessionExpired extends RuntimeRefusal {
  constructor() { super('form session expired', {}); }
}

// A form click on a session another person opened (Story 9.3). details: {}
class SessionNotYours extends RuntimeRefusal {
  constructor() { super('form session belongs to another person', {}); }
}

// A second Confirm (a double click or a replay) on a request already confirmed
// (Story 9.3). details: { done } (false while it is still running), and
// failed: true when the run finished without delivering the list (Story 9.5).
class AlreadyConfirmed extends RuntimeRefusal {
  constructor(details) { super(`request already ${details.done ? (details.failed ? 'tried' : 'done') : 'running'}`, details); }
}

// A scoped pull's query was refused before it ran: the SQL checker or the
// parameter rules (Story 9.5). Nothing ran. rule is for the log. details: { rule }
class QueryBlocked extends RuntimeRefusal {
  constructor(rule) {
    super(`list query refused (${rule})`, { rule });
    this.code = 'QUERY_BLOCKED';
  }
}

// A scoped pull's query failed while running, for a reason other than the
// data being unavailable (Story 9.5). No rows are shown. details: {}
class QueryFailed extends RuntimeRefusal {
  constructor() {
    super('list query failed', {});
    this.code = 'QUERY_FAILED';
  }
}

// A scoped pull ran but its CSV could not be sent to the person's DM (Story
// 9.5). The view still shows the count and first rows, saying the file is
// missing. details: {}
class CsvNotDelivered extends RuntimeRefusal {
  constructor() {
    super('list CSV not delivered', {});
    this.code = 'CSV_NOT_DELIVERED';
  }
}

// A scored list's rows could not be scored (Story 10.1): a declared input
// missing from the rows, a null or non-numeric value, no row id column, or a
// column named like one the engine adds (score, reason), two rows with the
// same row id, or a limit that is set but not a whole number of rows (a
// setup fault: the limit input is declared integer). The run stops; no
// row is ever scored as 0 in place of an error. The value itself is never
// carried. details: { module, input, label, problem } with problem one of
// SCORING_PROBLEMS.
const SCORING_PROBLEMS = Object.freeze(['missing', 'null', 'not_number', 'no_row_id', 'column_taken', 'duplicate_row_id', 'bad_limit']);
class ScoringFault extends RuntimeRefusal {
  constructor(details) {
    if (!SCORING_PROBLEMS.includes(details.problem)) throw new TypeError(`unknown ScoringFault problem "${details.problem}"`);
    super(`list scoring failed: input "${details.input}" ${details.problem} in module ${details.module}`, details);
    this.code = 'SCORING_FAULT';
  }
}

// The routing engine refused its input (Story 12.1, AD-R2, AD-R3): a field of
// the input contract is missing or malformed (contract.js never coerces), or
// the travel port has no minutes for a pair (never 0), or a rule is malformed
// or misused (Story 12.2, AD-R4: registration, an unknown rule id, a soft
// override of an always-hard rule), or gap fill's ranking weights name an
// input it doesn't have or fail scoring's checkScoring (Story 12.5, AD-R8),
// or travelMatrix (Story 13.2, AD-R9)
// refused or failed: routing is off, too many pairs, a coordinate column that
// is missing or not INTEGER/BIGINT or whose name another table forbids, a node with no position, or the query
// refused, unavailable or failed (fixed words: never DuckDB's text, the SQL,
// a path or a value), or the map renderer (Story 15.3, AD-R14) refused its
// model (an unknown key) or could not draw (the rasterizer did not load, drew
// nothing usable, or drew over its size cap), or refused an SVG holding a
// reference or style (unsafe_svg), or street tiles that are not checked
// 256 x 256 PNGs or do not cover the frame (basemap_invalid, Story 15.10),
// or an evaluateOrder order that leaves out one of the crew's stops
// (missing_stop), names a stop not in the day (unknown_stop) or one on
// another crew (other_crew_stop, Story 15.12), or a stop insertStop is
// given that is locked (locked) or on a crew that is not working
// (not_working), a client Add a stop may not add (unknown_client: not in
// the crew's zone, or already booked that day) or a day whose bookings
// changed under the editor (day_changed, Story 19.5). A setup fault in the
// adapter, so no plan is shown. field is a path like "stops[2].node"; the
// value itself is never carried. details: { field, problem }, plus { from,
// to } (node ids) when problem is 'no_travel'. problem is one of
// ROUTING_PROBLEMS.
const ROUTING_PROBLEMS = Object.freeze([
  'missing', 'not_object', 'not_list', 'not_text', 'not_integer', 'not_true_false', 'out_of_range',
  'bad_id', 'bad_node', 'bad_date', 'bad_strength', 'unknown_crew', 'duplicate', 'no_travel',
  'unknown_rule', 'not_overridable', 'not_function', 'unknown_weight', 'bad_weights',
  'routing_off', 'too_many_pairs', 'not_coordinate_column', 'shared_column_name', 'no_position', 'data_unavailable', 'query_refused', 'query_failed',
  'unknown_key', 'renderer_unavailable', 'renderer_failed', 'image_too_large', 'unsafe_svg', 'basemap_invalid',
  'missing_stop', 'unknown_stop', 'other_crew_stop',
  'locked', 'not_working', 'unknown_client', 'day_changed',
]);
class RoutingFault extends RuntimeRefusal {
  constructor(details) {
    if (!ROUTING_PROBLEMS.includes(details.problem)) throw new TypeError(`unknown RoutingFault problem "${details.problem}"`);
    const pair = details.problem === 'no_travel' ? ` (${details.from} to ${details.to})` : '';
    super(`routing input refused: "${details.field}" ${details.problem}${pair}`, details);
    this.code = 'ROUTING_FAULT';
  }
}

// A "How was this made?" click whose run record is gone: older than 24 hours,
// or never known (Story 9.6). details: {}
class ProvenanceGone extends RuntimeRefusal {
  constructor() { super('run details no longer available', {}); }
}

// A "How was this made?" click on another person's run (Story 9.6). details: {}
class ProvenanceNotYours extends RuntimeRefusal {
  constructor() { super('run details belong to another person', {}); }
}

// An approval preview's Approve or Cancel whose token is expired, unknown,
// malformed, already used or another person's (Story 10.2, AD-17). Each case
// gets the same words, so a click learns nothing about someone else's push.
// Nothing is pushed or consumed. details: {}
class PreviewInvalid extends RuntimeRefusal {
  constructor() { super('approval preview no longer valid', {}); }
}

// A Push click that can't make a preview (Story 10.2): the run's record has
// expired ('expired'), the run's CSV did not reach the person so its rows were
// never kept ('not_delivered'), or the run had no rows ('empty'). No token is
// created. details: { reason }
const PUSH_REFUSALS = Object.freeze(['expired', 'not_delivered', 'empty']);
class PushRefused extends RuntimeRefusal {
  constructor(reason) {
    if (!PUSH_REFUSALS.includes(reason)) throw new TypeError(`unknown PushRefused reason "${reason}"`);
    super(`push refused: ${reason}`, { reason });
    this.code = 'PUSH_REFUSED';
    this.reason = reason;
  }
}

// A second Approve (a double click, a replay or a concurrent click) on a push
// this same person already approved (Story 10.3, plan epic-10 decision 5).
// Anyone else gets PreviewInvalid. Nothing is sent again. details:
// { running: true } while the first push is in flight, else { running: false,
// result } with result the push's outcome ({ outcome, counts, destination,
// listName }, see kit/runtime/messages pushResultText).
class AlreadyPushed extends RuntimeRefusal {
  constructor(details) { super(`push already ${details.running ? 'running' : 'done'}`, details); }
}

// The AI service refused or failed (Story 9.1), so the module falls back to its
// typed form. Raised before anything is sent, except 'failed'. reason is one
// of LLM_REASONS; details.log, when set, is for the log only and never shown.
// details: { reason, log? }
const LLM_REASONS = Object.freeze(['off', 'no_key', 'config', 'too_long', 'rate_limited', 'over_budget', 'failed']);
class LlmUnavailable extends RuntimeRefusal {
  constructor(reason, details = {}) {
    if (!LLM_REASONS.includes(reason)) throw new TypeError(`unknown LlmUnavailable reason "${reason}"`);
    super(`AI unavailable: ${reason}`, { ...details, reason });
    this.code = 'LLM_UNAVAILABLE';
    this.reason = reason;
  }
}

// A new added-context entry refused (plan brightside-v0, D4, Story 16.4):
// no text ('empty'), over its own cap ('too_long'), over the hub's total
// ('hub_full') or its entry count ('too_many'). details: { reason, max },
// max the cap in characters or entries (null for 'empty'). Worded by
// kit/runtime/messages (Story 16.5). Nothing is stored or cut.
const CONTEXT_REFUSALS = Object.freeze(['empty', 'too_long', 'hub_full', 'too_many']);
class ContextRefused extends RuntimeRefusal {
  constructor(reason, max = null) {
    if (!CONTEXT_REFUSALS.includes(reason)) throw new TypeError(`unknown ContextRefused reason "${reason}"`);
    super(`added context refused: ${reason}`, { reason, max });
    this.code = 'CONTEXT_REFUSED';
    this.reason = reason;
  }
}

// A file uploaded through Add context refused (plan brightside-v0, D5, D7,
// Story 16.8). Nothing is stored. reason is one of FILE_REFUSALS; details:
// { reason, max } (max: the cap in bytes, pages, pixels or characters, when
// one applies). Worded by kit/runtime/messages; the log gets the reason only.
//   type        the name's extension is not one we read
//   docx        an office file (.docx, .doc, ...): "save it as a PDF first"
//   size        over the byte cap (Slack's size, or the download itself)
//   signature   the first bytes don't match the type the name says
//   pages       a PDF over the page cap
//   pages_unreadable  a PDF whose page count can't be read
//   pixels      an image wider or taller than the API takes
//   encoding    a text file that is not UTF-8, or holds a NUL byte
//   not_owner   the file belongs to someone other than the person submitting
//   not_found   Slack says the file is gone (file_not_found, file_deleted)
//   info_failed files.info failed for another reason
//   download_failed  the download failed, timed out, was redirected or
//               answered with a web page
//   too_long    what was taken from it is over the 6,000-character cap
//   empty       nothing could be taken from it
//   too_costly  its worst-case price alone is over the hourly upload limit
//   not_set_up  this bot has no way to read Slack files
// A .csv file (plan brightside-v1, D3, Story 18.2; kit/runtime/slack/files
// readCsv):
//   csv_too_big over 200 rows, 30 columns or 6,000 escaped characters
//   csv_ragged  a row whose column count is not the header's
//   csv_quote   a quote left open, or out of place
//   csv_no_rows a header row and nothing under it
const FILE_REFUSALS = Object.freeze([
  'type', 'docx', 'size', 'signature', 'pages', 'pages_unreadable', 'pixels', 'encoding', 'not_owner',
  'not_found', 'info_failed', 'download_failed', 'too_long', 'empty', 'too_costly', 'not_set_up',
  'csv_too_big', 'csv_ragged', 'csv_quote', 'csv_no_rows',
]);
class FileRefused extends RuntimeRefusal {
  constructor(reason, max = null) {
    if (!FILE_REFUSALS.includes(reason)) throw new TypeError(`unknown FileRefused reason "${reason}"`);
    super(`file refused: ${reason}`, { reason, max });
    this.code = 'FILE_REFUSED';
    this.reason = reason;
  }
}

// Ask's query (plan brightside-v1, D10, Story 19.7; kit/runtime/data/ask)
// did not run or did not finish. Nothing is shown from it. reason:
//   guard    the SQL guard or DuckDB's parse refused it (details.rule)
//   failed   DuckDB failed while running it, or the data couldn't be opened
//            or didn't fit ask.tables (details.errorClass: a DuckDB error
//            kind, data_unavailable or ask_config)
//   timeout  it ran past its 10 seconds and was interrupted
//   busy     another Ask query was running; this one never started
// rule and errorClass are fixed words for the log. DuckDB's own error text
// never reaches this error: it can hold a hidden column's name or a value.
const ASK_QUERY_REASONS = Object.freeze(['guard', 'failed', 'timeout', 'busy']);
class AskQueryRefused extends RuntimeRefusal {
  constructor(reason, { rule = null, errorClass = null } = {}) {
    if (!ASK_QUERY_REASONS.includes(reason)) throw new TypeError(`unknown AskQueryRefused reason "${reason}"`);
    super(`ask query ${reason}`, { reason, rule, errorClass });
    this.code = 'ASK_QUERY_REFUSED';
    this.reason = reason;
  }
}

module.exports = {
  AskQueryRefused, ASK_QUERY_REASONS,
  RuntimeRefusal, NotSetUp, AccessDenied, ConfigFault, DataUnavailable, LlmUnavailable, LLM_REASONS,
  KillSwitchOn, LimitReached, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict, PartialFailure,
  SessionExpired, SessionNotYours, AlreadyConfirmed, QueryBlocked, QueryFailed, CsvNotDelivered,
  ProvenanceGone, ProvenanceNotYours, ScoringFault, SCORING_PROBLEMS, PreviewInvalid, PushRefused, PUSH_REFUSALS, AlreadyPushed,
  RoutingFault, ROUTING_PROBLEMS, ContextRefused, CONTEXT_REFUSALS, FileRefused, FILE_REFUSALS,
};
