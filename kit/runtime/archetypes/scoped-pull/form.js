'use strict';

// The typed form and the Confirm screen of a scoped pull (Story 9.3), as Block
// Kit blocks for the module's view in the hub modal.
//
// The form has no Submit: a view_submission would close or replace the view.
// "Check values" is an ordinary button, and the engine reads what was typed
// from the open view's state (body.view.state). Every button carries the
// session id as its value; nothing else about the person or the values is in
// the view's metadata.
//
// Values are shown back as plain_text, so nothing in them can format or link
// in Slack. Labels and descriptions come from the reviewed manifest and are
// escaped where they render as mrkdwn.

const { escapeText } = require('../../messages');
const { labelOf, displayValue } = require('./params');

// The action ids of the form's buttons. One listener (kit/runtime/slack/hubs)
// handles all four.
const ACTIONS = Object.freeze({
  check: 'scoped-pull:check',
  read: 'scoped-pull:read',
  confirm: 'scoped-pull:confirm',
  change: 'scoped-pull:change',
});
const ACTION_PATTERN = /^scoped-pull:(check|read|confirm|change)$/;
// Each input's block id is this plus the parameter name; its element's action
// id is always VALUE_ACTION. Slack keeps what was typed across views.update
// while both stay the same.
const INPUT_BLOCK = 'sp-input:';
const VALUE_ACTION = 'value';

const plain = (text) => ({ type: 'plain_text', text: String(text), emoji: false });

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
// values after Change, the valid ones after a failed check). problems: from
// checkValues, listed above the inputs. note: one mrkdwn line (already
// escaped) shown under the description.
function formMessage(mod, { sessionId, initial = {}, problems = [], note } = {}) {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: escapeText(mod.description) } }];
  if (note) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: note }] });
  if (problems.length) {
    const lines = problems.map((p) => `• ${escapeText(p.message)}`);
    blocks.push({ type: 'section', block_id: 'sp-problems', text: { type: 'mrkdwn', text: `*Please check:*\n${lines.join('\n')}` } });
  }
  for (const p of mod.parameters) {
    const start = Object.hasOwn(initial, p.name) ? initial[p.name] : p.default;
    blocks.push(inputBlock(p, start));
  }
  blocks.push({
    type: 'actions',
    block_id: 'sp-actions',
    elements: [button('Check values', ACTIONS.check, sessionId, 'primary')],
  });
  const text = problems.length
    ? `${mod.label}: please check ${problems.map((p) => p.label).join(', ')}.`
    : `${mod.label}: fill in the form, then press Check values.`;
  return { text, blocks };
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

// What a confirmed request shows until the query step lands (Story 9.5
// replaces this with the run and its results).
function confirmedMessage(mod, values) {
  return {
    text: `${mod.label}: your values are confirmed.`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*Confirmed.* These are the values you chose:' } },
      ...valueBlocks(mod, values),
      { type: 'context', elements: [{ type: 'mrkdwn', text: "Running this list isn't switched on yet, so nothing ran. Open it again from the menu to start over." }] },
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
  formMessage, confirmMessage, confirmedMessage, readState, verbOf,
  ACTIONS, ACTION_PATTERN, INPUT_BLOCK, VALUE_ACTION,
};
