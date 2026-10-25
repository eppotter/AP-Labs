'use strict';

// What every stand-in Anthropic client checks before it answers, so the tests
// refuse a request the real API refuses.
//
//   const { checkRequest } = require('test/fixtures/fake-anthropic');
//   create(params) { checkRequest(params); ... }
//
// The models the profiles name (Claude Sonnet 5.5, Opus 5.5, Fable 5.1)
// reject a tool_choice of type "tool" or "any" with a 400:
//   tool_choice: type "tool" and "any" are not supported for this model.
// checkRequest throws the same kind of error (name BadRequestError, status
// 400), so a test that forces a tool fails the way the live bot did.

const UNSUPPORTED_TOOL_CHOICE = new Set(['tool', 'any']);

function badRequest(message) {
  return Object.assign(new Error(`400 ${message}`), { name: 'BadRequestError', status: 400 });
}

// Throws a BadRequestError when the real API would refuse params.
function checkRequest(params) {
  const choice = params && params.tool_choice;
  if (choice && UNSUPPORTED_TOOL_CHOICE.has(choice.type)) {
    throw badRequest('tool_choice: type "tool" and "any" are not supported for this model.');
  }
}

module.exports = { checkRequest, badRequest, UNSUPPORTED_TOOL_CHOICE };
