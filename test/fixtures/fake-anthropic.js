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
//
// Tools (Story 16.6), refused as the API refuses them: tools not a list, a
// tool with a field the API doesn't take (effects is the engine's own and is
// never sent: "Extra inputs are not permitted"), a name not matching
// ^[a-zA-Z0-9_-]{1,64}$, a description that is not text, or an input_schema
// that is not a JSON Schema object with type "object" (and, when given,
// properties an object and required a list of property names).

const UNSUPPORTED_TOOL_CHOICE = new Set(['tool', 'any']);
const TOOL_FIELDS = new Set(['name', 'description', 'input_schema', 'cache_control', 'type']);
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

// Why the API would refuse this tool, or null.
function badTool(tool, i) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return `tools.${i}: must be an object`;
  const extra = Object.keys(tool).find((k) => !TOOL_FIELDS.has(k));
  if (extra) return `tools.${i}.${extra}: Extra inputs are not permitted`;
  if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) return `tools.${i}.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'`;
  if (tool.description !== undefined && typeof tool.description !== 'string') return `tools.${i}.description: Input should be a valid string`;
  const schema = tool.input_schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return `tools.${i}.input_schema: Field required`;
  if (schema.type !== 'object') return `tools.${i}.input_schema.type: Input should be 'object'`;
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
    return `tools.${i}.input_schema.properties: Input should be a valid dictionary`;
  }
  if (schema.required !== undefined) {
    const props = schema.properties || {};
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string' || !Object.hasOwn(props, r))) {
      return `tools.${i}.input_schema.required: each entry must name a property`;
    }
  }
  return null;
}

function badRequest(message) {
  return Object.assign(new Error(`400 ${message}`), { name: 'BadRequestError', status: 400 });
}

// Throws a BadRequestError when the real API would refuse params.
function checkRequest(params) {
  const choice = params && params.tool_choice;
  if (choice && UNSUPPORTED_TOOL_CHOICE.has(choice.type)) {
    throw badRequest('tool_choice: type "tool" and "any" are not supported for this model.');
  }
  const tools = params && params.tools;
  if (tools === undefined) return;
  if (!Array.isArray(tools)) throw badRequest('tools: Input should be a valid list');
  tools.forEach((tool, i) => {
    const why = badTool(tool, i);
    if (why) throw badRequest(why);
  });
}

module.exports = {
  checkRequest, badRequest, badTool, UNSUPPORTED_TOOL_CHOICE,
};
