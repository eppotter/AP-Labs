'use strict';

// Named query parameters (Story 7.5, AD-10), shared by the tools' runner
// (./index createData) and Ask's connection (./ask, Story 19.7). Moved here
// unchanged from ./index so both bind parameters by the same rules: by name
// ($zone), never spliced into the text; a key the caller did not declare is
// refused, and so is a placeholder with no value or a positional one ($1, ?).

// A query the runner refused before it reached DuckDB. rule is a guardrail
// rule (kit/runtime/sql RULES) or one of the parameter rules below.
class QueryRefusedError extends Error {
  constructor(rule, detail) {
    super(`query refused (${rule}): ${detail}`);
    this.name = 'QueryRefusedError';
    this.code = 'QUERY_REFUSED';
    this.rule = rule;
    this.detail = detail;
  }
}

const PARAM_RULES = Object.freeze({
  UNDECLARED: 'undeclared_parameter',
  MISSING: 'missing_parameter',
  POSITIONAL: 'positional_parameter',
  BAD_VALUE: 'bad_parameter_value',
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

function checkValue(name, v) {
  const ok = v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'bigint'
    || (typeof v === 'number' && Number.isFinite(v));
  if (!ok) throw new QueryRefusedError(PARAM_RULES.BAD_VALUE, `$${name} must be a string, finite number, boolean, bigint or null`);
}

// The template's placeholders, as DuckDB parsed them, against what the caller
// declared and passed.
function checkParams(prepared, params, declared) {
  const names = [];
  for (let i = 1; i <= prepared.parameterCount; i += 1) {
    const name = prepared.parameterName(i);
    if (/^\d+$/.test(name)) throw new QueryRefusedError(PARAM_RULES.POSITIONAL, 'parameters are bound by name ($name), never by position');
    names.push(name);
  }
  for (const key of Object.keys(params)) {
    if (!declared.has(key)) throw new QueryRefusedError(PARAM_RULES.UNDECLARED, `$${key} was not declared`);
    if (!names.includes(key)) throw new QueryRefusedError(PARAM_RULES.UNDECLARED, `$${key} is not a placeholder in the query`);
    checkValue(key, params[key]);
  }
  for (const name of names) {
    if (!declared.has(name)) throw new QueryRefusedError(PARAM_RULES.UNDECLARED, `$${name} was not declared`);
    if (!Object.hasOwn(params, name)) throw new QueryRefusedError(PARAM_RULES.MISSING, `$${name} has no value`);
  }
}

module.exports = {
  QueryRefusedError, PARAM_RULES, isPlainObject, checkParams,
};
