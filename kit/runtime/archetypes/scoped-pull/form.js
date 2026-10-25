'use strict';

// The typed form and the Confirm screen of a scoped pull (Story 9.3), as Block
// Kit blocks for the module's view in the hub modal.
//
// The form is a modal with input blocks, so Slack requires a submit: its
// submit is "Check values" and its callback id is FORM_CALLBACK. The engine
// reads what was typed from the submitted view's state (body.view.state) and
// answers in the ack: errors beside the inputs, or an update to the Confirm
// screen (kit/runtime/slack/hubs). The form's private_metadata is
// "<hub id>:<session id>", never values or person data. The Confirm screen
// has no inputs and no submit; its Confirm and Change buttons carry the
// session id as their value.
//
// Values are shown back as plain_text, so nothing in them can format or link
// in Slack. Labels and descriptions come from the reviewed manifest and are
// escaped where they render as mrkdwn.
//
// Plain English (Story 9.4): when the AI is wired in, the form also has a
// request box and a "Read my request" button (an ordinary button: the engine
// reads the box from the view's state). A follow-up question is a text box
// in the same view, with its own submit (ANSWER_CALLBACK), written by the bot
// from the input's label and declaration, never by the AI.

const { escapeText, READ_WORDS } = require('../../messages');
const { labelOf, displayValue } = require('./params');

// The Confirm screen's buttons. One listener (kit/runtime/slack/hubs)
// handles both.
const ACTIONS = Object.freeze({
  confirm: 'scoped-pull:confirm',
  change: 'scoped-pull:change',
  read: 'scoped-pull:read',
});
const ACTION_PATTERN = /^scoped-pull:(confirm|change|read)$/;
// The form's view_submission callback id, and its submit button's text.
const FORM_CALLBACK = 'scoped-pull:form';
const SUBMIT = 'Check values';
const SESSION_PATTERN = /^[0-9a-f]{32}$/;
const HUB_PATTERN = /^[a-z][a-z0-9-]*$/;
// Each input's block id is this plus the parameter name; its element's action
// id is always VALUE_ACTION. Slack keeps what was typed across views.update
// while both stay the same.
const INPUT_BLOCK = 'sp-input:';
const VALUE_ACTION = 'value';
// Story 9.4: the request box, the follow-up question's box and its submit.
// The request box holds what the AI service accepts (llm MAX_REQUEST_CHARS;
// a test keeps the two equal, and this engine never imports the service).
const REQUEST_BLOCK = 'sp-request';
const REQUEST_MAX_CHARS = 500;
const READ_BUTTON = 'Read my request';
const ANSWER_BLOCK = 'sp-answer';
const ANSWER_CALLBACK = 'scoped-pull:answer';
const ANSWER_SUBMIT = 'Use this answer';
const ANSWER_MAX_CHARS = 100;

const plain = (text) => ({ type: 'plain_text', text: String(text), emoji: false });

// The form's private_metadata, and back. parseMetadata returns { hubId,
// sessionId }, each null when missing or malformed.
function formMetadata(hubId, sessionId) {
  return `${hubId}:${sessionId}`;
}

function parseMetadata(text) {
  const [hub, session, ...rest] = typeof text === 'string' ? text.split(':') : [];
  return {
    hubId: HUB_PATTERN.test(hub || '') ? hub : null,
    sessionId: rest.length === 0 && SESSION_PATTERN.test(session || '') ? session : null,
  };
}

function verbOf(actionId) {
  const m = typeof actionId === 'string' ? ACTION_PATTERN.exec(actionId) : null;
  return m ? m[1] : null;
}

const option = (value, text) => ({ text: plain(text), value: String(value) });

// The element for one input, prefilled with initial when given.
function element(p, initial) {
  const has = initial !== undefined && initial !== null;
  if (p.enum) {
    const options = p.enum.map((v) => option(v, v));
    const pick = has ? options.find((o) => o.value === String(initial)) : undefined;
    return {
      type: 'static_select', action_id: VALUE_ACTION, placeholder: plain('Choose…'), options,
      ...(pick ? { initial_option: pick } : {}),
    };
  }
  switch (p.type) {
    case 'boolean': {
      const options = [option('true', 'Yes'), option('false', 'No')];
      return {
        type: 'static_select', action_id: VALUE_ACTION, placeholder: plain('Choose…'), options,
        ...(has ? { initial_option: options[initial ? 0 : 1] } : {}),
      };
    }
    case 'date':
      return { type: 'datepicker', action_id: VALUE_ACTION, ...(has ? { initial_date: initial } : {}) };
    case 'integer':
    case 'number':
      return {
        type: 'number_input', action_id: VALUE_ACTION, is_decimal_allowed: p.type === 'number',
        ...(p.min !== undefined ? { min_value: String(p.min) } : {}),
        ...(p.max !== undefined ? { max_value: String(p.max) } : {}),
        ...(has ? { initial_value: String(initial) } : {}),
      };
    default:
      return {
        type: 'plain_text_input', action_id: VALUE_ACTION, max_length: p.max_length,
        ...(has ? { initial_value: String(initial) } : {}),
      };
  }
}

function inputBlock(p, initial) {
  return {
    type: 'input',
    block_id: `${INPUT_BLOCK}${p.name}`,
    optional: !p.required,
    label: plain(labelOf(p)),
    ...(p.description ? { hint: plain(p.description) } : {}),
    element: element(p, initial),
  };
}

const button = (text, actionId, sessionId, style) => ({
  type: 'button', action_id: actionId, value: sessionId, text: plain(text), ...(style ? { style } : {}),
});

// The request box and its button (Story 9.4), above the typed inputs.
function requestBlocks(sessionId) {
  return [
    {
      type: 'input',
      block_id: REQUEST_BLOCK,
      optional: true,
      label: plain('Describe what you want'),
      hint: plain(`In your own words, then press ${READ_BUTTON}. Or fill in the form below and press ${SUBMIT}.`),
      element: { type: 'plain_text_input', action_id: VALUE_ACTION, multiline: true, max_length: REQUEST_MAX_CHARS },
    },
    { type: 'actions', block_id: 'sp-read', elements: [button(READ_BUTTON, ACTIONS.read, sessionId)] },
  ];
}

// The form. initial: values to prefill (defaults when opened, the checked
// values after Change). notice: mrkdwn shown first, already escaped (a
// fallback's message). ask: true to offer the request box (the AI is wired
// in). Its view gets the submit, the callback id and the metadata through
// message.modal (kit/runtime/slack/modal).
function formMessage(mod, { sessionId, initial = {}, notice, ask = false } = {}) {
  const blocks = [];
  if (notice) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: String(notice) } });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: escapeText(mod.description) } });
  if (ask) blocks.push(...requestBlocks(sessionId));
  for (const p of mod.parameters) {
    const start = Object.hasOwn(initial, p.name) ? initial[p.name] : p.default;
    blocks.push(inputBlock(p, start));
  }
  return {
    text: `${mod.label}: fill in the form, then press ${SUBMIT}.`,
    blocks,
    modal: { submit: SUBMIT, callbackId: FORM_CALLBACK, privateMetadata: formMetadata(mod.hub, sessionId) },
  };
}

// Slack's errors for a submitted form: each problem beside its input, keyed
// by block id, worded from the input's label.
function formErrors(problems) {
  return Object.fromEntries(problems.map((p) => [`${INPUT_BLOCK}${p.name}`, p.message]));
}

// One section per value: the label in bold, the value as plain text.
function valueBlocks(mod, values) {
  return mod.parameters
    .filter((p) => Object.hasOwn(values, p.name))
    .map((p) => ({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*${escapeText(labelOf(p))}*` },
        plain(displayValue(p, values[p.name])),
      ],
    }));
}

// The Confirm screen: the checked values, with Confirm and Change.
function confirmMessage(mod, { sessionId, values }) {
  return {
    text: `${mod.label}: check these values, then press Confirm.`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: 'Check these values. Nothing runs until you press *Confirm*.' } },
      ...valueBlocks(mod, values),
      {
        type: 'actions',
        block_id: 'sp-actions',
        elements: [
          button('Confirm', ACTIONS.confirm, sessionId, 'primary'),
          button('Change', ACTIONS.change, sessionId),
        ],
      },
    ],
  };
}

// "Reading your request…" while the AI call runs: no inputs, no buttons.
function readingMessage(mod) {
  return { text: `${mod.label}: ${READ_WORDS.reading()}`, blocks: [{ type: 'section', text: plain(READ_WORDS.reading()) }] };
}

// What a person may answer for p, from its declaration.
function answerHint(p) {
  if (p.enum) return `One of: ${p.enum.join(', ')}.`;
  const range = (what) => {
    if (p.min !== undefined && p.max !== undefined) return `${what} from ${p.min} to ${p.max}.`;
    if (p.max !== undefined) return `${what} up to ${p.max}.`;
    return `${what}.`;
  };
  switch (p.type) {
    case 'integer': return range('A whole number');
    case 'number': return range('A number');
    case 'boolean': return 'Yes or No.';
    case 'date': return 'A date, as YYYY-MM-DD.';
    default: return `Up to ${p.max_length} characters.`;
  }
}

// The follow-up question (Story 9.4): one text box for input p, in the same
// view. why: the plain line above it (a missing value, or the check's
// problem). Its submit is ANSWER_CALLBACK; "Use the form instead" is Change.
// Every word is the bot's: the label and declaration are the manifest's.
function questionMessage(mod, { sessionId, param, why }) {
  const label = labelOf(param);
  const max = param.type === 'string' && param.max_length ? param.max_length : ANSWER_MAX_CHARS;
  return {
    text: `${mod.label}: ${READ_WORDS.question(label)}`,
    blocks: [
      { type: 'section', text: plain(why) },
      {
        type: 'input',
        block_id: ANSWER_BLOCK,
        label: plain(READ_WORDS.question(label)),
        hint: plain(answerHint(param)),
        element: { type: 'plain_text_input', action_id: VALUE_ACTION, max_length: max },
      },
      { type: 'actions', block_id: 'sp-question', elements: [button('Use the form instead', ACTIONS.change, sessionId)] },
    ],
    modal: { submit: ANSWER_SUBMIT, callbackId: ANSWER_CALLBACK, privateMetadata: formMetadata(mod.hub, sessionId) },
  };
}

// The text in one box of a view's state, or '' when Slack did not send it.
function boxText(state, blockId) {
  const entry = state && state.values && state.values[blockId] && state.values[blockId][VALUE_ACTION];
  return entry && typeof entry.value === 'string' ? entry.value : '';
}
const readRequest = (state) => boxText(state, REQUEST_BLOCK);
const readAnswer = (state) => boxText(state, ANSWER_BLOCK);

// The raw text of each input from a view's state (body.view.state), keyed by
// parameter name. A field Slack did not send reads as undefined.
function readState(parameters, state) {
  const values = (state && state.values) || {};
  const raw = {};
  for (const p of parameters) {
    const entry = values[`${INPUT_BLOCK}${p.name}`] && values[`${INPUT_BLOCK}${p.name}`][VALUE_ACTION];
    if (!entry || typeof entry !== 'object') continue;
    let v;
    if (entry.selected_option && typeof entry.selected_option === 'object') v = entry.selected_option.value;
    else if (entry.selected_date !== undefined) v = entry.selected_date;
    else v = entry.value;
    if (typeof v === 'string') raw[p.name] = v;
  }
  return raw;
}

module.exports = {
  formMessage, formErrors, confirmMessage, valueBlocks, readState, verbOf, formMetadata, parseMetadata,
  readingMessage, questionMessage, answerHint, readRequest, readAnswer,
  ACTIONS, ACTION_PATTERN, FORM_CALLBACK, SUBMIT, INPUT_BLOCK, VALUE_ACTION,
  REQUEST_BLOCK, REQUEST_MAX_CHARS, READ_BUTTON, ANSWER_BLOCK, ANSWER_CALLBACK, ANSWER_SUBMIT,
};
