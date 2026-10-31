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
// Story 16.8 (reading an uploaded file) adds, each checked against the Claude
// API reference on 2026-10-30:
//   - an unknown model: 404 not_found_error. max_tokens not an integer from 1
//     to the model's synchronous output limit (128K tokens for every current
//     model; platform.claude.com/docs/en/about-claude/models/overview, "Max
//     output"): 400.
//   - a request body over 128 MB: 413 request_too_large
//     (.../docs/en/api/overview, "Request size limits").
//   - a text block with empty text: 400. An unknown block type: 400.
//   - a document block with a base64 source whose media_type is not
//     application/pdf, whose data is not base64, or whose PDF has more than
//     600 pages (100 under a 1M-token context window; every current model has
//     1M) (.../build-with-claude/pdf-support, "PDF support limitations"): 400.
//   - an image block whose media_type is not image/jpeg, image/png, image/gif
//     or image/webp, whose bytes are not that format ("Image does not match
//     the provided media type"), whose base64 data is over 10 MB (the
//     first-party API's per-image limit; 5 MB is Bedrock's), or, for a PNG or
//     GIF, wider or taller than 8,000 pixels (.../build-with-claude/vision,
//     "Image limits and costs"): 400.
// The plan named a 5 MB base64 image limit; the current reference says 10 MB
// on the first-party API, so the fake uses 10 MB.
//
// Tools (Story 16.6), refused as the API refuses them: tools not a list, a
// tool with a field the API doesn't take (effects is the engine's own and is
// never sent: "Extra inputs are not permitted"), a name not matching
// ^[a-zA-Z0-9_-]{1,64}$, a description that is not text, or an input_schema
// that is not a JSON Schema object with type "object" (and, when given,
// properties an object and required a list of property names).

const UNSUPPORTED_TOOL_CHOICE = new Set(['tool', 'any']);
const MODEL_MAX_OUTPUT = Object.freeze({
  'claude-fable-5-1': 128000,
  'claude-opus-5-5': 128000,
  'claude-sonnet-5-5': 128000,
  'claude-haiku-5-5': 128000,
});
const MAX_REQUEST_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_BASE64 = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 8000;
const MAX_PDF_PAGES = 600;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

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
function notFound(message) {
  return Object.assign(new Error(`404 ${message}`), { name: 'NotFoundError', status: 404 });
}
function tooLarge(message) {
  return Object.assign(new Error(`413 ${message}`), { name: 'APIError', status: 413 });
}

// The format the bytes are, from their first bytes, as a media type, or null.
function formatOf(b) {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// A PNG's or GIF's size, or null for another format.
function pixelsOf(b, type) {
  if (type === 'image/png' && b.length >= 24) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (type === 'image/gif' && b.length >= 10) return [b.readUInt16LE(6), b.readUInt16LE(8)];
  return null;
}

// The fake's own page count: the larger of the biggest /Count and the /Page
// leaves it can see uncompressed. Rough, and independent of the engine's.
function pagesOf(b) {
  const text = b.toString('latin1');
  const counts = [...text.matchAll(/\/Count\s+(\d{1,9})/g)].map((m) => Number(m[1]));
  const leaves = (text.match(/\/Type\s*\/Page(?![A-Za-z0-9])/g) || []).length;
  return Math.max(0, leaves, ...counts);
}

function checkBlock(block) {
  if (!block || typeof block !== 'object') throw badRequest('messages: each content block must be an object');
  if (block.type === 'text') {
    if (typeof block.text !== 'string' || !block.text) throw badRequest('messages: text content blocks must be non-empty');
    return;
  }
  if (block.type === 'tool_use' || block.type === 'tool_result') return;
  if (block.type !== 'document' && block.type !== 'image') throw badRequest(`messages: unknown content block type "${block.type}"`);
  const src = block.source;
  if (!src || src.type !== 'base64') return; // url and file sources are not used by the engine
  if (typeof src.data !== 'string' || !src.data || !BASE64.test(src.data)) throw badRequest(`${block.type}.source.data: invalid base64 data`);
  const bytes = Buffer.from(src.data, 'base64');
  if (block.type === 'document') {
    if (src.media_type !== 'application/pdf') throw badRequest(`document.source.media_type: Input should be 'application/pdf'`);
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('document: the PDF specified was not valid');
    if (pagesOf(bytes) > MAX_PDF_PAGES) throw badRequest(`document: A maximum of ${MAX_PDF_PAGES} PDF pages may be provided.`);
    return;
  }
  if (!IMAGE_TYPES.has(src.media_type)) throw badRequest("image.source.media_type: Input should be 'image/jpeg', 'image/png', 'image/gif' or 'image/webp'");
  if (src.data.length > MAX_IMAGE_BASE64) throw badRequest(`image: image exceeds ${MAX_IMAGE_BASE64 / (1024 * 1024)} MB maximum: ${src.data.length} bytes > ${MAX_IMAGE_BASE64} bytes`);
  if (formatOf(bytes) !== src.media_type) throw badRequest(`image: Image does not match the provided media type ${src.media_type}`);
  const px = pixelsOf(bytes, src.media_type);
  if (px && (px[0] > MAX_IMAGE_PIXELS || px[1] > MAX_IMAGE_PIXELS)) throw badRequest(`image: image dimensions exceed max allowed size: ${MAX_IMAGE_PIXELS} pixels`);
}

// Throws the error the real API would answer with, when it would refuse
// params. maxRequestBytes: a test seam, to check the 413 without building a
// 128 MB request.
function checkRequest(params, { maxRequestBytes = MAX_REQUEST_BYTES } = {}) {
  const choice = params && params.tool_choice;
  if (choice && UNSUPPORTED_TOOL_CHOICE.has(choice.type)) {
    throw badRequest('tool_choice: type "tool" and "any" are not supported for this model.');
  }
  if (!params || typeof params !== 'object') throw badRequest('the request body must be an object');
  const tools = params && params.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw badRequest('tools: Input should be a valid list');
    tools.forEach((tool, i) => {
      const why = badTool(tool, i);
      if (why) throw badRequest(why);
    });
  }
  if (Buffer.byteLength(JSON.stringify(params)) > maxRequestBytes) throw tooLarge('request_too_large: Request exceeds the maximum allowed number of bytes.');
  if (!Object.hasOwn(MODEL_MAX_OUTPUT, params.model)) throw notFound(`not_found_error: model: ${params.model}`);
  const max = MODEL_MAX_OUTPUT[params.model];
  if (!Number.isInteger(params.max_tokens) || params.max_tokens < 1 || params.max_tokens > max) {
    throw badRequest(`max_tokens: ${params.max_tokens} > ${max}, which is the maximum allowed number of output tokens for ${params.model}`);
  }
  for (const m of Array.isArray(params.messages) ? params.messages : []) {
    if (Array.isArray(m.content)) m.content.forEach(checkBlock);
  }
}

module.exports = {
  checkRequest, badRequest, badTool, UNSUPPORTED_TOOL_CHOICE, MODEL_MAX_OUTPUT, MAX_REQUEST_BYTES, MAX_IMAGE_BASE64, MAX_IMAGE_PIXELS, MAX_PDF_PAGES,
};
