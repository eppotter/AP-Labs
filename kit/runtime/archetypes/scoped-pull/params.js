'use strict';

// Declared parameters (Story 9.3, AD-4, AD-10). A module's manifest declares
// each input a person (or, from 9.4, the AI) may give:
//
//   { "name": "zone", "label": "Zone", "type": "string",
//     "enum": ["north", "south"], "default": "north", "required": true }
//
// The JSON Schema checks the shape; this file checks what a schema cannot:
// that every input is bounded, that ranges are possible and that a default
// passes its own declaration. A problem names the input, and the registry
// prefixes the module's file, so startup stops naming both.
//
// Bounded means:
//   string            allowed values (enum), or a pattern and a max_length
//   integer, number   a max (and an optional min), or allowed values
//   boolean, date     bounded by their type
// So nothing a person types can reach Slack or a query as unexpected text.
//
// checkValues() turns raw form text into typed values, or plain problems
// worded from the input's label (never from what was typed).

const TYPES = new Set(['string', 'integer', 'number', 'boolean', 'date']);
// Slack's static_select holds at most 100 options.
const MAX_ENUM = 100;
// A plain_text_input holds at most 3000 characters; text inputs stay far below.
const MAX_TEXT = 500;
const INTEGER_TEXT = /^-?\d{1,15}$/;
const NUMBER_TEXT = /^-?\d{1,15}(\.\d{1,10})?$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

const labelOf = (p) => p.label || p.name;

function isDate(s) {
  if (typeof s !== 'string' || !DATE_TEXT.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// The pattern matches the whole value, never a part of it.
function fullMatch(pattern) {
  return new RegExp(`^(?:${pattern})$`, 'u');
}

// True when v is a value of the declared type (before any bound).
function ofType(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isSafeInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'date': return isDate(v);
    default: return false;
  }
}

// Why a typed value breaks its declaration, or null. Assumes ofType.
function boundProblem(p, v) {
  if (p.enum) return p.enum.includes(v) ? null : 'is not one of the allowed values';
  if (p.type === 'string') {
    if (Array.from(v).length > p.max_length) return `is longer than ${p.max_length} characters`;
    if (!fullMatch(p.pattern).test(v)) return 'is not in the expected format';
  }
  if (p.type === 'integer' || p.type === 'number') {
    if (p.min !== undefined && v < p.min) return `is below ${p.min}`;
    if (p.max !== undefined && v > p.max) return `is above ${p.max}`;
  }
  return null;
}

// The problems with one declaration, each a plain sentence without the input
// name (the caller adds it).
function declarationProblems(p) {
  const out = [];
  if (!TYPES.has(p.type)) return [`has an unknown type "${p.type}"`];
  const numeric = p.type === 'integer' || p.type === 'number';
  if (!numeric && (p.min !== undefined || p.max !== undefined)) out.push(`declares min or max, which only an integer or number input can`);
  if (p.type !== 'string' && (p.pattern !== undefined || p.max_length !== undefined)) out.push('declares pattern or max_length, which only a string input can');
  if ((p.type === 'boolean' || p.type === 'date') && p.enum) out.push('declares allowed values, which a boolean or date input cannot');
  if (p.enum) {
    if (p.enum.length > MAX_ENUM) out.push(`declares ${p.enum.length} allowed values (at most ${MAX_ENUM})`);
    if (p.enum.some((v) => !ofType(p.type, v))) out.push(`has an allowed value that is not a ${p.type}`);
    if (numeric && (p.min !== undefined || p.max !== undefined)) out.push('declares both allowed values and min or max; declare one');
    if (p.type === 'string' && (p.pattern !== undefined || p.max_length !== undefined)) out.push('declares both allowed values and a pattern; declare one');
    if (p.type === 'string' && p.enum.some((v) => typeof v === 'string' && (!v.trim() || Array.from(v).length > 75))) {
      out.push('has an allowed value that is empty or longer than 75 characters (Slack\'s option limit)');
    }
  }
  if (p.type === 'string' && !p.enum) {
    if (p.pattern === undefined || p.max_length === undefined) {
      out.push('is a string with neither allowed values nor a pattern and max_length; declare one or the other');
    }
    if (p.pattern !== undefined) {
      try {
        fullMatch(p.pattern);
      } catch {
        out.push('has a pattern that is not a valid regular expression');
      }
    }
    if (p.max_length !== undefined && (!Number.isInteger(p.max_length) || p.max_length < 1 || p.max_length > MAX_TEXT)) {
      out.push(`has a max_length that is not a whole number from 1 to ${MAX_TEXT}`);
    }
  }
  if (numeric && !p.enum) {
    if (p.max === undefined) out.push(`is ${p.type === 'integer' ? 'an integer' : 'a number'} with no max; every number input declares one`);
    if (p.type === 'integer' && [p.min, p.max].some((b) => b !== undefined && !Number.isInteger(b))) out.push('has a min or max that is not a whole number');
    if (p.min !== undefined && p.max !== undefined && p.min > p.max) out.push(`has an impossible range (min ${p.min} is above max ${p.max})`);
  }
  if (out.length === 0 && p.default !== undefined) {
    if (!ofType(p.type, p.default) || boundProblem(p, p.default)) out.push('has a default that breaks its own declaration');
  }
  return out;
}

// Every problem with a module's parameters, as `input "<name>" <problem>`.
function checkDeclarations(parameters = []) {
  const problems = [];
  const seen = new Set();
  for (const p of parameters) {
    if (seen.has(p.name)) problems.push(`input "${p.name}" is declared twice`);
    seen.add(p.name);
    for (const problem of declarationProblems(p)) problems.push(`input "${p.name}" ${problem}`);
  }
  return problems;
}

// Raw form text to a typed value, or undefined when it cannot be read.
function parse(p, raw) {
  const s = String(raw).trim();
  switch (p.type) {
    case 'string': return String(raw);
    case 'integer': return INTEGER_TEXT.test(s) ? Number(s) : undefined;
    case 'number': return NUMBER_TEXT.test(s) ? Number(s) : undefined;
    case 'boolean': return s === 'true' ? true : s === 'false' ? false : undefined;
    case 'date': return isDate(s) ? s : undefined;
    default: return undefined;
  }
}

// What a person is told when a value cannot be read as its type.
const UNREADABLE = Object.freeze({
  integer: 'must be a whole number',
  number: 'must be a number',
  boolean: 'must be Yes or No',
  date: 'must be a date',
  string: 'is not in the expected format',
});

// raw: { name: string | undefined } from the form. Returns { values, problems }:
// values holds a typed value for each input given (or its default); problems
// is [{ name, label, message }], the message a plain sentence. An empty
// optional input with no default is left out of values.
function checkValues(parameters, raw = {}) {
  const values = {};
  const problems = [];
  for (const p of parameters) {
    const label = labelOf(p);
    const given = Object.hasOwn(raw, p.name) ? raw[p.name] : undefined;
    const empty = given === undefined || given === null || String(given).trim() === '';
    if (empty) {
      if (p.default !== undefined) values[p.name] = p.default;
      else if (p.required) problems.push({ name: p.name, label, message: `${label} is needed.` });
      continue;
    }
    const v = parse(p, given);
    if (v === undefined) {
      problems.push({ name: p.name, label, message: `${label} ${UNREADABLE[p.type]}.` });
      continue;
    }
    const why = boundProblem(p, v);
    if (why) {
      problems.push({ name: p.name, label, message: `${label} ${why}.` });
      continue;
    }
    values[p.name] = v;
  }
  return { values, problems };
}

// A value as a person reads it: Yes/No for a boolean, else its text.
function displayValue(p, v) {
  if (p.type === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

module.exports = {
  checkDeclarations, checkValues, displayValue, labelOf, TYPES, MAX_ENUM, MAX_TEXT,
};
