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

const { escapeText } = require('../../messages');
const { labelOf, displayValue } = require('./params');

// The Confirm screen's buttons. One listener (kit/runtime/slack/hubs)
// handles both.
const ACTIONS = Object.freeze({
  confirm: 'scoped-pull:confirm',
  change: 'scoped-pull:change',
});
const ACTION_PATTERN = /^scoped-pull:(confirm|change)$/;
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

// The form. initial: values to prefill (defaults when opened, the checked
// values after Change). Its view gets the submit, the callback id and the
// metadata through message.modal (kit/runtime/slack/modal).
function formMessage(mod, { sessionId, initial = {} } = {}) {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: escapeText(mod.description) } }];
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
  ACTIONS, ACTION_PATTERN, FORM_CALLBACK, SUBMIT, INPUT_BLOCK, VALUE_ACTION,
};
