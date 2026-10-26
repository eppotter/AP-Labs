'use strict';

// The routing input contract (Story 12.1, AD-R2, data-design §4). An adapter
// in the app dir builds this shape from its own tables; the engine never reads
// a client table. validateInput checks every field it knows and returns the
// same object untouched: it never coerces, fills a default or copies. The
// first bad field throws RoutingFault naming its path, never its value.
//
//   day, asOf          ISO calendar dates, YYYY-MM-DD (never a clock time)
//   limits             { earliestStart, defaultStart, aimFinish, latestFinish }
//                      minutes after local midnight (wall clock), in order,
//                      plus startRoundTo (whole minutes, 1 or more)
//   crews[]            { crewId, zoneId, baseNode, headcountPlanned,
//                        headcountPresent, available }
//   stops[]            { stopId, node, currentCrewId, labourMinutes,
//                        serviceMinutes, locked, rules[], routeOrder?, start? }
//                      a locked stop needs its booked start
//   candidates[]?      stop fields (currentCrewId optional) plus { plannedDate,
//                        cadenceDays, prevVisitDate (or null), flexible }
//   rules[]            rule instances { ruleId, value, strength? }; a rule's
//                      own value is checked by the rule (AD-R4), not here
//
// Ids are strings. A node is a kind-prefixed id (property:<id>, crew:<id>),
// never a coordinate. Keys the contract does not name are left alone for the
// entry point that reads them.

const { RoutingFault } = require('../errors');

const ID = /^[A-Za-z0-9_-]+$/;
const NODE = /^(property|crew):[A-Za-z0-9_-]+$/;
const RULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MINUTES = 1440;
const STRENGTHS = Object.freeze(['hard', 'soft']);
const LIMIT_ORDER = Object.freeze(['earliestStart', 'defaultStart', 'aimFinish', 'latestFinish']);

const fault = (field, problem) => new RoutingFault({ field, problem });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;

function need(obj, key, field) {
  if (!has(obj, key)) throw fault(field, 'missing');
  return obj[key];
}

function object(value, field) {
  if (!isObject(value)) throw fault(field, 'not_object');
  return value;
}

function list(value, field) {
  if (!Array.isArray(value)) throw fault(field, 'not_list');
  return value;
}

function text(obj, key, field) {
  const v = need(obj, key, field);
  if (typeof v !== 'string') throw fault(field, 'not_text');
  return v;
}

function id(obj, key, field) {
  const v = text(obj, key, field);
  if (!ID.test(v)) throw fault(field, 'bad_id');
  return v;
}

function node(obj, key, field) {
  const v = text(obj, key, field);
  if (!NODE.test(v)) throw fault(field, 'bad_node');
  return v;
}

function bool(obj, key, field) {
  const v = need(obj, key, field);
  if (typeof v !== 'boolean') throw fault(field, 'not_true_false');
  return v;
}

function integer(obj, key, field, min, max = Number.MAX_SAFE_INTEGER) {
  const v = need(obj, key, field);
  if (!Number.isSafeInteger(v)) throw fault(field, 'not_integer');
  if (v < min || v > max) throw fault(field, 'out_of_range');
  return v;
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const MONTH_DAYS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

// A real calendar date by arithmetic alone, so no time zone is ever involved.
function isoDate(obj, key, field) {
  const v = text(obj, key, field);
  const m = ISO_DATE.exec(v);
  if (!m) throw fault(field, 'bad_date');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const last = mo === 2 && isLeap(y) ? 29 : MONTH_DAYS[mo - 1];
  if (mo < 1 || mo > 12 || d < 1 || d > last) throw fault(field, 'bad_date');
  return v;
}

function checkLimits(input) {
  const limits = object(need(input, 'limits', 'limits'), 'limits');
  for (const key of LIMIT_ORDER) integer(limits, key, `limits.${key}`, 0, DAY_MINUTES);
  for (let i = 0; i + 1 < LIMIT_ORDER.length; i += 1) {
    const [a, b] = [LIMIT_ORDER[i], LIMIT_ORDER[i + 1]];
    if (limits[a] > limits[b]) throw fault(`limits.${a}`, 'out_of_range');
  }
  integer(limits, 'startRoundTo', 'limits.startRoundTo', 1, DAY_MINUTES);
}

function checkCrews(input) {
  const crews = list(need(input, 'crews', 'crews'), 'crews');
  const ids = new Set();
  crews.forEach((crew, i) => {
    const at = `crews[${i}]`;
    object(crew, at);
    const crewId = id(crew, 'crewId', `${at}.crewId`);
    if (ids.has(crewId)) throw fault(`${at}.crewId`, 'duplicate');
    ids.add(crewId);
    id(crew, 'zoneId', `${at}.zoneId`);
    node(crew, 'baseNode', `${at}.baseNode`);
    integer(crew, 'headcountPlanned', `${at}.headcountPlanned`, 0);
    integer(crew, 'headcountPresent', `${at}.headcountPresent`, 0);
    bool(crew, 'available', `${at}.available`);
  });
  return ids;
}

function checkRules(stop, at) {
  const rules = list(need(stop, 'rules', `${at}.rules`), `${at}.rules`);
  const seen = new Set();
  rules.forEach((rule, j) => {
    const rat = `${at}.rules[${j}]`;
    object(rule, rat);
    const ruleId = text(rule, 'ruleId', `${rat}.ruleId`);
    if (!RULE_ID.test(ruleId)) throw fault(`${rat}.ruleId`, 'bad_id');
    if (seen.has(ruleId)) throw fault(`${rat}.ruleId`, 'duplicate');
    seen.add(ruleId);
    need(rule, 'value', `${rat}.value`);
    if (has(rule, 'strength') && !STRENGTHS.includes(rule.strength)) throw fault(`${rat}.strength`, 'bad_strength');
  });
}

// The fields a stop and a candidate share. crewRequired: a day's stop always
// has a crew; a candidate from a later day may not name one.
function checkStop(stop, at, crewIds, stopIds, { crewRequired }) {
  object(stop, at);
  const stopId = id(stop, 'stopId', `${at}.stopId`);
  if (stopIds.has(stopId)) throw fault(`${at}.stopId`, 'duplicate');
  stopIds.add(stopId);
  node(stop, 'node', `${at}.node`);
  if (crewRequired || has(stop, 'currentCrewId')) {
    const crewId = text(stop, 'currentCrewId', `${at}.currentCrewId`);
    if (!crewIds.has(crewId)) throw fault(`${at}.currentCrewId`, 'unknown_crew');
  }
  integer(stop, 'labourMinutes', `${at}.labourMinutes`, 0);
  integer(stop, 'serviceMinutes', `${at}.serviceMinutes`, 0, DAY_MINUTES);
  const locked = bool(stop, 'locked', `${at}.locked`);
  if (has(stop, 'routeOrder')) integer(stop, 'routeOrder', `${at}.routeOrder`, 1);
  if (locked || has(stop, 'start')) integer(stop, 'start', `${at}.start`, 0, DAY_MINUTES);
  checkRules(stop, at);
}

function checkCandidate(cand, at, crewIds, stopIds) {
  checkStop(cand, at, crewIds, stopIds, { crewRequired: false });
  isoDate(cand, 'plannedDate', `${at}.plannedDate`);
  integer(cand, 'cadenceDays', `${at}.cadenceDays`, 1);
  if (need(cand, 'prevVisitDate', `${at}.prevVisitDate`) !== null) isoDate(cand, 'prevVisitDate', `${at}.prevVisitDate`);
  bool(cand, 'flexible', `${at}.flexible`);
}

function validateInput(input) {
  object(input, 'input');
  isoDate(input, 'day', 'day');
  isoDate(input, 'asOf', 'asOf');
  checkLimits(input);
  const crewIds = checkCrews(input);
  const stopIds = new Set();
  list(need(input, 'stops', 'stops'), 'stops').forEach((stop, i) => checkStop(stop, `stops[${i}]`, crewIds, stopIds, { crewRequired: true }));
  if (has(input, 'candidates')) {
    list(input.candidates, 'candidates').forEach((cand, i) => checkCandidate(cand, `candidates[${i}]`, crewIds, stopIds));
  }
  return input;
}

module.exports = { validateInput, NODE, ID };
