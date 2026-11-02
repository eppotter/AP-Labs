'use strict';

// Story 20.2: the approval-write preview's held rows (write.hold) and full
// list (write.preview), on a stand-in module. End to end on Brightside's
// Appointment reminders: examples/brightside/test/appointment-reminders.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const preview = require('../../kit/runtime/archetypes/approval-write/preview');

const MOD = Object.freeze({
  id: 'notes',
  label: 'Notes',
  row_id: 'id',
  write: {
    connector: 'mail',
    operation: 'send',
    destination: 'mail tool',
    fields: ['id', 'name', 'day', 'why'],
    send: { ref: 'id', name: 'name' },
    hold: 'why',
    preview: ['name', 'day'],
    list_name: 'notes-{run_date}',
  },
});

test('a row is held when its hold field is a non-empty string; null, undefined, false and blank are not; any other value holds it (fail closed)', () => {
  const held = (v) => preview.isHeld(MOD, { id: 1, why: v });
  assert.equal(held('Held: away'), true);
  assert.equal(held(null), false);
  assert.equal(held(undefined), false);
  assert.equal(held(false), false);
  assert.equal(held('  '), false);
  assert.equal(held(true), true);
  assert.equal(held(0), true);
  assert.equal(preview.holdReason(MOD, { why: true }), preview.HELD);
  assert.equal(preview.isHeld({ ...MOD, write: { ...MOD.write, hold: undefined } }, { why: 'x' }), false, 'no write.hold: nothing is held');
});

test('the preview lists every row to send with write.preview\'s fields, the held rows under their escaped reason, and never a field it does not name', () => {
  const rows = [
    { id: 1, name: 'Ann', day: '2026-10-03', why: null },
    { id: 2, name: 'Bo <@U1>', day: '2026-10-03', why: 'Held: <!channel> away' },
    { id: 3, name: 'Cy', day: '2026-10-03', why: null },
  ];
  const view = preview.previewMessage({
    mod: MOD, listName: 'notes-2026-11-01', rows, skipped: [{ reason: preview.HELD }], token: 'a'.repeat(32), held: [rows[1]], sending: [rows[0], rows[2]],
  });
  const [, counts, heldBlock, sendBlock] = view.blocks;
  assert.equal(counts.text.text, '*List name:* notes-2026-11-01\n*Rows to send:* 2 of 3 rows\n*Skipped:* 1: held (1)');
  assert.equal(heldBlock.text.text, '*Held, not sent: 1.*\n• Held: &lt;!channel&gt; away (1)\n```\nname      day\nBo &lt;@U1&gt;  2026-10-03\n```');
  assert.equal(sendBlock.text.text, '*What will be sent (2):*\n```\nname  day\nAnn   2026-10-03\nCy    2026-10-03\n```');
  assert.match(view.blocks[4].elements[0].text, /Skipped and held rows are never sent/);
});

test('a list too long for one Slack section shows the first rows that fit and says the rest are in the CSV', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, name: `Name ${i + 1}`, day: '2026-10-03', why: null }));
  const view = preview.previewMessage({
    mod: MOD, listName: 'n', rows, skipped: [], token: 'a'.repeat(32), held: [], sending: rows,
  });
  const text = view.blocks[2].text.text;
  assert.ok(text.length < 3000, `${text.length} characters`);
  assert.match(text, /^\*What will be sent: the first \d+ of 400\* \(all 400 are in the CSV in your DM with me\):/);
});

test('without write.preview the preview keeps its sample of 5 rows', () => {
  const mod = { ...MOD, write: { ...MOD.write, preview: undefined, hold: undefined } };
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `N${i + 1}`, day: '2026-10-03', why: null }));
  const view = preview.previewMessage({
    mod, listName: 'n', rows, skipped: [], token: 'a'.repeat(32),
  });
  assert.match(view.blocks[2].text.text, /^\*A sample of 5:\*/);
});
