'use strict';

// The rule registry and the v1 rules (Story 12.2, AD-R4). A rule is data plus
// one check; the solver loops over a registry and never names a rule, so a
// fork adds a rule by registering it, with no engine edit.
//
//   { id, label, defaultStrength: 'hard'|'soft', weight?, overridable?,
//     everyStop?, position?, checkValue?, check(stop, slot, ctx) }
//
//   id            kebab-case, unique in a registry
//   label         plain words, used in reasons
//   weight        integer >= 1 on any rule that can be soft (its default is
//                 soft, or a stop may override it to soft); absent otherwise
//   overridable   false: a stop's rule instance may not change its strength
//                 (crew-day-limits); default true
//   everyStop     true: checked on every stop (crew-day-limits, aim-finish);
//                 default false: checked only on a stop whose rules[] holds an
//                 instance { ruleId, value, strength? } for it
//   position      where a soft break counts in the plan's cost (AD-R5):
//                 'softPenalty' (default) or 'aimFinishMinutes', so aim-finish
//                 is never summed with preferred-crew
//   checkValue    (value) -> null, or a RoutingFault problem for the instance's
//                 value (AD-R2: a rule checks its own value)
//   check         (stop, slot, ctx) -> { ok, reason, amount? }; slot is
//                 { crewId, start, finish } in minutes after local midnight;
//                 ctx is { day, limits, value } (value: the instance's, or
//                 undefined). amount (integer >= 0, default 1) scales a soft
//                 break: penalty = weight * amount.
//
// Strength (AD-R4): a stop's instance may carry strength; absent, the rule's
// defaultStrength applies. Reasons hold rule labels, crew ids, clock times and
// minutes only (AD-R11), never a place.

const { RoutingFault } = require('../errors');
const { ID, RULE_ID } = require('./contract');

const STRENGTHS = Object.freeze(['hard', 'soft']);
const POSITIONS = Object.freeze(['softPenalty', 'aimFinishMinutes']);
const DAY_MINUTES = 1440;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_NAMES = Object.freeze(['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

const fault = (field, problem) => new RoutingFault({ field, problem });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;

// ISO weekday (Monday 1 to Sunday 7) of a YYYY-MM-DD date, by arithmetic
// alone (Sakamoto), so no clock or time zone is ever involved.
const MONTH_OFFSET = Object.freeze([0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]);
function isoWeekday(day) {
  const m = ISO_DATE.exec(day);
  if (!m) throw fault('day', 'bad_date');
  const month = Number(m[2]);
  const y = Number(m[1]) - (month < 3 ? 1 : 0);
  const sunday0 = (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + MONTH_OFFSET[month - 1] + Number(m[3])) % 7;
  return sunday0 === 0 ? 7 : sunday0;
}

// Minutes after midnight as a wall-clock time, 06:00 or 23:15.
function clock(minutes) {
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function dayList(days) {
  const names = days.map((d) => DAY_NAMES[d]);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

// --- the v1 rules ---------------------------------------------------------

const crewDayLimits = Object.freeze({
  id: 'crew-day-limits',
  label: 'crew day limits',
  defaultStrength: 'hard',
  overridable: false,
  everyStop: true,
  check(stop, slot, { limits }) {
    if (slot.start < limits.earliestStart) {
      return { ok: false, reason: `starts at ${clock(slot.start)}, before the crew day's earliest start of ${clock(limits.earliestStart)}` };
    }
    if (slot.finish > limits.latestFinish) {
      return { ok: false, reason: `finishes at ${clock(slot.finish)}, after the crew day's latest finish of ${clock(limits.latestFinish)}` };
    }
    return { ok: true, reason: `within the crew day (${clock(limits.earliestStart)} to ${clock(limits.latestFinish)})` };
  },
});

const dayOfWeek = Object.freeze({
  id: 'day-of-week',
  label: 'day of the week',
  defaultStrength: 'hard',
  weight: 100,
  checkValue(value) {
    if (!Array.isArray(value)) return 'not_list';
    if (value.length === 0) return 'out_of_range';
    if (!value.every(Number.isSafeInteger)) return 'not_integer';
    if (!value.every((d) => d >= 1 && d <= 7)) return 'out_of_range';
    if (new Set(value).size !== value.length) return 'duplicate';
    return null;
  },
  check(stop, slot, { day, value }) {
    const today = isoWeekday(day);
    const allowed = [...value].sort((a, b) => a - b);
    if (allowed.includes(today)) return { ok: true, reason: `${DAY_NAMES[today]} is one of the customer's days` };
    return { ok: false, reason: `the customer's days are ${dayList(allowed)}, not ${DAY_NAMES[today]}` };
  },
});

const timeOfDay = Object.freeze({
  id: 'time-of-day',
  label: 'time of day',
  defaultStrength: 'hard',
  weight: 100,
  checkValue(value) {
    if (!isObject(value)) return 'not_object';
    for (const key of ['startFrom', 'startBefore']) {
      if (!has(value, key)) return 'missing';
      if (!Number.isSafeInteger(value[key])) return 'not_integer';
      if (value[key] < 0 || value[key] > DAY_MINUTES) return 'out_of_range';
    }
    return value.startFrom < value.startBefore ? null : 'out_of_range';
  },
  check(stop, slot, { value }) {
    const window = `${clock(value.startFrom)} to before ${clock(value.startBefore)}`;
    if (slot.start >= value.startFrom && slot.start < value.startBefore) {
      return { ok: true, reason: `starts at ${clock(slot.start)}, inside the customer's window (${window})` };
    }
    return { ok: false, reason: `starts at ${clock(slot.start)}, outside the customer's window (${window})` };
  },
});

const preferredCrew = Object.freeze({
  id: 'preferred-crew',
  label: 'preferred crew',
  defaultStrength: 'soft',
  weight: 100,
  checkValue(value) {
    if (typeof value !== 'string') return 'not_text';
    return ID.test(value) ? null : 'bad_id';
  },
  check(stop, slot, { value }) {
    if (slot.crewId === value) return { ok: true, reason: `on crew ${value}, the preferred crew` };
    return { ok: false, reason: `on crew ${slot.crewId}, not the preferred crew ${value}` };
  },
});

// Lateness past the aim-finish time, counted per stop: each stop adds the
// minutes its own finish runs past aimFinish. The hard limit is
// crew-day-limits' latestFinish.
const aimFinish = Object.freeze({
  id: 'aim-finish',
  label: 'aim-finish time',
  defaultStrength: 'soft',
  weight: 1,
  everyStop: true,
  position: 'aimFinishMinutes',
  check(stop, slot, { limits }) {
    const late = slot.finish - limits.aimFinish;
    if (late <= 0) return { ok: true, reason: `finishes at ${clock(slot.finish)}, by the aim-finish time of ${clock(limits.aimFinish)}` };
    return { ok: false, reason: `finishes at ${clock(slot.finish)}, ${late} minutes past the aim-finish time of ${clock(limits.aimFinish)}`, amount: late };
  },
});

const V1_RULES = Object.freeze([crewDayLimits, dayOfWeek, timeOfDay, preferredCrew, aimFinish]);

// --- the registry ---------------------------------------------------------

// A rule's shape, checked once at registration; returns a frozen copy with
// the optional fields filled in.
function checkRule(rule) {
  if (!isObject(rule)) throw fault('rule', 'not_object');
  if (!has(rule, 'id')) throw fault('rule.id', 'missing');
  if (typeof rule.id !== 'string') throw fault('rule.id', 'not_text');
  if (!RULE_ID.test(rule.id)) throw fault('rule.id', 'bad_id');
  const at = `rule[${rule.id}]`;
  if (!has(rule, 'label')) throw fault(`${at}.label`, 'missing');
  if (typeof rule.label !== 'string' || rule.label.trim() === '') throw fault(`${at}.label`, 'not_text');
  if (!has(rule, 'defaultStrength')) throw fault(`${at}.defaultStrength`, 'missing');
  if (!STRENGTHS.includes(rule.defaultStrength)) throw fault(`${at}.defaultStrength`, 'bad_strength');
  for (const key of ['overridable', 'everyStop']) {
    if (has(rule, key) && typeof rule[key] !== 'boolean') throw fault(`${at}.${key}`, 'not_true_false');
  }
  const overridable = rule.overridable !== false;
  if (!overridable && rule.defaultStrength === 'soft') throw fault(`${at}.overridable`, 'not_overridable');
  const canBeSoft = rule.defaultStrength === 'soft' || overridable;
  if (canBeSoft) {
    if (!has(rule, 'weight')) throw fault(`${at}.weight`, 'missing');
    if (!Number.isSafeInteger(rule.weight)) throw fault(`${at}.weight`, 'not_integer');
    if (rule.weight < 1) throw fault(`${at}.weight`, 'out_of_range');
  } else if (has(rule, 'weight')) {
    throw fault(`${at}.weight`, 'out_of_range');
  }
  const position = has(rule, 'position') ? rule.position : 'softPenalty';
  if (!POSITIONS.includes(position)) throw fault(`${at}.position`, 'out_of_range');
  if (has(rule, 'checkValue') && typeof rule.checkValue !== 'function') throw fault(`${at}.checkValue`, 'not_function');
  if (!has(rule, 'check')) throw fault(`${at}.check`, 'missing');
  if (typeof rule.check !== 'function') throw fault(`${at}.check`, 'not_function');
  return Object.freeze({
    id: rule.id,
    label: rule.label,
    defaultStrength: rule.defaultStrength,
    weight: canBeSoft ? rule.weight : null,
    overridable,
    everyStop: rule.everyStop === true,
    position,
    checkValue: rule.checkValue || null,
    check: rule.check,
  });
}

function checkResult(result, rule) {
  const at = `rule[${rule.id}].check`;
  if (!isObject(result) || typeof result.ok !== 'boolean') throw fault(at, 'not_object');
  if (typeof result.reason !== 'string' || result.reason === '') throw fault(`${at}.reason`, 'not_text');
  if (has(result, 'amount') && (!Number.isSafeInteger(result.amount) || result.amount < 0)) throw fault(`${at}.amount`, 'out_of_range');
}

function createRegistry() {
  const rules = [];
  const byId = new Map();

  function register(rule) {
    const entry = checkRule(rule);
    if (byId.has(entry.id)) throw fault(`rule[${entry.id}].id`, 'duplicate');
    rules.push(entry);
    byId.set(entry.id, entry);
    return registry;
  }

  // The rules that apply to a stop, in registration order, each with its
  // instance value and resolved strength. at is the stop's path for faults.
  function resolve(stop, at = 'stop') {
    const instances = new Map();
    (stop.rules || []).forEach((inst, j) => {
      const iat = `${at}.rules[${j}]`;
      const rule = byId.get(inst.ruleId);
      if (!rule) throw fault(`${iat}.ruleId`, 'unknown_rule');
      if (has(inst, 'strength')) {
        if (!STRENGTHS.includes(inst.strength)) throw fault(`${iat}.strength`, 'bad_strength');
        if (!rule.overridable && inst.strength !== rule.defaultStrength) throw fault(`${iat}.strength`, 'not_overridable');
      }
      if (rule.checkValue) {
        const problem = rule.checkValue(inst.value);
        if (problem !== null) throw fault(`${iat}.value`, problem);
      }
      instances.set(rule.id, inst);
    });
    const out = [];
    for (const rule of rules) {
      const inst = instances.get(rule.id);
      if (!inst && !rule.everyStop) continue;
      const strength = inst && has(inst, 'strength') ? inst.strength : rule.defaultStrength;
      out.push(Object.freeze({ rule, value: inst ? inst.value : undefined, strength }));
    }
    return out;
  }

  // Every applicable rule checked on one slot, tallied into the cost tuple's
  // rule positions (AD-R5). A hard break counts once in hardBreaks; a soft
  // break adds weight * amount to its rule's position.
  function evaluate(stop, slot, ctx, at = 'stop') {
    const tally = { hardBreaks: 0, softPenalty: 0, aimFinishMinutes: 0, checks: [] };
    for (const { rule, value, strength } of resolve(stop, at)) {
      const result = rule.check(stop, slot, { day: ctx.day, limits: ctx.limits, value });
      checkResult(result, rule);
      let penalty = 0;
      if (!result.ok) {
        if (strength === 'hard') tally.hardBreaks += 1;
        else {
          penalty = rule.weight * (has(result, 'amount') ? result.amount : 1);
          tally[rule.position] += penalty;
        }
      }
      tally.checks.push({ ruleId: rule.id, label: rule.label, strength, ok: result.ok, reason: result.reason, penalty });
    }
    return tally;
  }

  const registry = Object.freeze({
    register,
    get: (id) => byId.get(id),
    list: () => Object.freeze([...rules]),
    resolve,
    evaluate,
  });
  return registry;
}

// A fresh registry holding the v1 rules; a fork registers its own on top.
function v1Registry() {
  const registry = createRegistry();
  for (const rule of V1_RULES) registry.register(rule);
  return registry;
}

module.exports = { createRegistry, v1Registry, V1_RULES, isoWeekday };
