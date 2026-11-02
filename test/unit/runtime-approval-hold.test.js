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

test('a list too long for one Slack section shows the first rows that fit and says only that the rest are not shown', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, name: `Name ${i + 1}`, day: '2026-10-03', why: null }));
  const view = preview.previewMessage({
    mod: MOD, listName: 'n', rows, skipped: [], token: 'a'.repeat(32), held: [], sending: rows,
  });
  const text = view.blocks[2].text.text;
  assert.ok(text.length <= preview.SECTION_LIMIT, `${text.length} characters`);
  const m = /^\*What will be sent: the first (\d+) of 400\* \(And (\d+) more, not shown here\.\):/.exec(text);
  assert.ok(m, text.slice(0, 120));
  assert.equal(Number(m[1]) + Number(m[2]), 400);
  assert.ok(!/CSV/.test(text));
});

test('held rows with many distinct long reasons: the reason lines, the table and the "not shown" lines all fit one section', () => {
  const held = Array.from({ length: 300 }, (_, i) => ({
    id: i + 1, name: `Name ${i + 1}`, day: '2026-10-03', why: `Held: reason number ${i + 1} ${'x'.repeat(140)}`,
  }));
  const view = preview.nothingToSendMessage({
    mod: MOD, listName: 'n', rows: held, skipped: held.map(() => ({ reason: preview.HELD })), held,
  });
  const text = view.blocks[1].text.text;
  assert.ok(text.length <= preview.SECTION_LIMIT, `${text.length} characters`);
  assert.ok(text.startsWith('*Held, not sent: 300.*\n• Held: reason number 1 '));
  const shownReasons = text.split('\n').filter((l) => l.startsWith('• Held:')).length;
  assert.ok(shownReasons > 0 && shownReasons < 300);
  assert.match(text, new RegExp(`• And ${300 - shownReasons} more reasons, not shown here\\.`));
  assert.match(text, /\nAnd \d+ more, not shown here\.$/);
  assert.ok(!/CSV/.test(text));
});

test('renderedOf: the plan\'s texts in the order of the rows to send, or a problem when they are not exactly one per row, malformed or would close their code block', () => {
  const sending = [{ id: 1 }, { id: 2 }];
  const plan = (emails) => ({ wouldWrite: { emails } });
  const e = (ref, body = `Body ${ref}`) => ({ ref: String(ref), subject: `S${ref}`, body });
  assert.equal(preview.renderedOf(MOD, { wouldWrite: { send: 2 } }, sending), null, 'no texts in the plan');
  assert.deepEqual(preview.renderedOf(MOD, plan([e(2), e(1)]), sending), { texts: [{ subject: 'S1', body: 'Body 1' }, { subject: 'S2', body: 'Body 2' }] });
  assert.ok(preview.renderedOf(MOD, plan([e(1)]), sending).problem, 'one missing');
  assert.ok(preview.renderedOf(MOD, plan([e(1), e(3)]), sending).problem, 'another row');
  assert.ok(preview.renderedOf(MOD, plan([e(1), e(1)]), sending).problem, 'twice');
  assert.ok(preview.renderedOf(MOD, plan([e(1), { ref: '2', subject: 'S' }]), sending).problem, 'no body');
  assert.ok(preview.renderedOf(MOD, plan([e(1), e(2, 'a ``` b')]), sending).problem, 'closes the block');
  assert.ok(preview.renderedOf(MOD, plan([e(1), e(2, 'y'.repeat(3000))]), sending).problem, 'too long');
  assert.ok(preview.renderedOf(MOD, plan({}), sending).problem, 'not a list');
});

test('without write.preview the preview keeps its sample of 5 rows', () => {
  const mod = { ...MOD, write: { ...MOD.write, preview: undefined, hold: undefined } };
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `N${i + 1}`, day: '2026-10-03', why: null }));
  const view = preview.previewMessage({
    mod, listName: 'n', rows, skipped: [], token: 'a'.repeat(32),
  });
  assert.match(view.blocks[2].text.text, /^\*A sample of 5:\*/);
});
