'use strict';

// Story 9.2: the one Slack formatter and splitter (kit/runtime/slack/format).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  toMrkdwn, splitText, textBlocks, formatBlocks, messageParts, SECTION_LIMIT, MAX_MESSAGE_BLOCKS,
} = require('../../kit/runtime/slack/format');
const sdk = require('../../kit/runtime/sdk');

test('headings become bold lines', () => {
  assert.equal(toMrkdwn('# Revenue\n## By **region** ##\n###### small'), '*Revenue*\n*By region*\n*small*');
  assert.equal(toMrkdwn('#hashtag stays'), '#hashtag stays');
});

test('bold, italics and strikethrough become Slack emphasis', () => {
  assert.equal(toMrkdwn('**bold** and __also bold__'), '*bold* and *also bold*');
  assert.equal(toMrkdwn('*italic* and _italic_'), '_italic_ and _italic_');
  assert.equal(toMrkdwn('~~gone~~'), '~gone~');
  assert.equal(toMrkdwn('2 * 3 * 4 and snake_case_name'), '2 * 3 * 4 and snake_case_name');
});

test('links become Slack links, only for http(s) and mailto', () => {
  assert.equal(toMrkdwn('see [the report](https://example.com/r?a=1&b=2)'), 'see <https://example.com/r?a=1&amp;b=2|the report>');
  assert.equal(toMrkdwn('[**Bold** link](http://x.test)'), '<http://x.test|*Bold* link>');
  assert.equal(toMrkdwn('[mail](mailto:a@b.test)'), '<mailto:a@b.test|mail>');
  assert.equal(toMrkdwn('[click](javascript:void)'), 'click (javascript:void)');
  assert.equal(toMrkdwn('[x](https://a.test|<!channel>)'), 'x (https://a.test|&lt;!channel&gt;)');
  assert.equal(toMrkdwn('![chart](https://a.test/c.png)'), '<https://a.test/c.png|chart>');
});

test('lists become bullets and numbered lines, nested lists indent', () => {
  assert.equal(toMrkdwn('- one\n* two\n+ three'), '• one\n• two\n• three');
  assert.equal(toMrkdwn('1. first\n2) second'), '1. first\n2. second');
  assert.equal(toMrkdwn('- top\n  - nested\n    - deeper'), '• top\n    • nested\n        • deeper');
  assert.equal(toMrkdwn('- [ ] todo\n- [x] done'), '• ☐ todo\n• ☑ done');
  assert.equal(toMrkdwn('---'), '───');
});

test('quotes stay quotes', () => {
  assert.equal(toMrkdwn('> a **quote**'), '> a *quote*');
});

test('code: inline spans and fenced blocks keep their text, escaped, never formatted', () => {
  assert.equal(toMrkdwn('run `a **b** <c>` now'), 'run `a **b** &lt;c&gt;` now');
  assert.equal(toMrkdwn('```sql\nSELECT * FROM t WHERE a < 2 -- **x**\n```'), '```\nSELECT * FROM t WHERE a &lt; 2 -- **x**\n```');
  assert.equal(toMrkdwn('~~~\n# not a heading\n- not a list\n~~~'), '```\n# not a heading\n- not a list\n```');
  assert.equal(toMrkdwn('```\nunclosed'), '```\nunclosed\n```');
});

test('the input can never mention, link or inject Slack controls', () => {
  assert.equal(toMrkdwn('<!channel> & <@U123> <https://evil.test|ok>'), '&lt;!channel&gt; &amp; &lt;@U123&gt; &lt;https://evil.test|ok&gt;');
  assert.equal(toMrkdwn('a 0 b'), 'a 0 b');
  assert.equal(toMrkdwn('line\r\nnext'), 'line\nnext');
  assert.equal(toMrkdwn(null), '');
});

test('a body with no line break under the limit stays one section, unchanged', () => {
  const body = 'word '.repeat(500).trim();
  assert.ok(body.length < SECTION_LIMIT);
  assert.deepEqual(splitText(body), [body]);
  assert.deepEqual(splitText(''), ['']);
  assert.deepEqual(textBlocks(''), [{ type: 'section', text: { type: 'mrkdwn', text: ' ' } }]);
});

test('a long body splits on line breaks into sections under 2,900 characters, losing nothing', () => {
  assert.equal(SECTION_LIMIT, 2900);
  const lines = Array.from({ length: 800 }, (_, i) => `${i}: ${'x'.repeat(i % 40)}`);
  const body = lines.join('\n');
  const parts = splitText(body);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= SECTION_LIMIT));
  // Every cut is at a line break: each part is whole lines, and they rejoin.
  assert.equal(parts.join('\n'), body);
  for (const p of parts) assert.ok(p.split('\n').every((l) => lines.includes(l)));
});

test('a body with no line break over the limit splits on spaces, then hard, never inside an escape, emoji or link', () => {
  const words = 'word '.repeat(1500).trim();
  const parts = splitText(words);
  assert.ok(parts.every((p) => p.length <= SECTION_LIMIT && !p.startsWith(' ') && !p.endsWith(' ')));
  assert.equal(parts.join(' '), words);

  const solid = 'a'.repeat(7000);
  assert.ok(splitText(solid).every((p) => p.length <= SECTION_LIMIT));
  assert.equal(splitText(solid).join(''), solid);

  const amp = `${'a'.repeat(2893)}&amp;tail`;
  assert.deepEqual(splitText(amp), ['a'.repeat(2893), '&amp;tail']);

  const emoji = `${'a'.repeat(2894)}😀tail`;
  const [head] = splitText(emoji);
  assert.ok(!/[\uD800-\uDBFF]$/.test(head));
  assert.equal(splitText(emoji).join(''), emoji);

  const link = `${'w '.repeat(1440)}<https://a.test|some long link text>`;
  assert.ok(splitText(link).some((p) => p.includes('<https://a.test|some long link text>')));
});

test('a link at the start or right at the cut is never split; only a link longer than a section is', () => {
  const whole = (parts, link) => parts.some((p) => p.includes(link));
  // A link with spaces at index 0, followed by text with no break to cut at.
  const first = '<https://a.test|link text with spaces>';
  const atStart = `${first}${'z'.repeat(4000)}`;
  const startParts = splitText(atStart);
  assert.ok(whole(startParts, first));
  assert.ok(startParts.every((p) => p.length <= SECTION_LIMIT));
  assert.equal(startParts.join(''), atStart);
  // Hard cuts: a link starting just before the cut, and one starting exactly at it.
  const room = SECTION_LIMIT - 4;
  const link = '<https://b.test|label>';
  for (const lead of [room - 5, room]) {
    const text = `${'a'.repeat(lead)}${link}${'b'.repeat(10)}`;
    const parts = splitText(text);
    assert.ok(whole(parts, link), `link split with lead ${lead}`);
    assert.ok(parts.every((p) => p.length <= SECTION_LIMIT));
    assert.equal(parts.join(''), text);
  }
  // A link longer than a whole section cannot fit anywhere: it is cut, but nothing is lost.
  const huge = `<https://c.test/${'p'.repeat(4000)}|big>`;
  const hugeParts = splitText(huge);
  assert.ok(hugeParts.every((p) => p.length <= SECTION_LIMIT));
  assert.equal(hugeParts.join(''), huge);
});

test('a code block split across sections is closed and reopened, so each section renders as code', () => {
  const code = Array.from({ length: 300 }, (_, i) => `SELECT ${i} AS n, 'row ${i}' AS label;`).join('\n');
  const text = toMrkdwn(`Here is the query:\n\n\`\`\`sql\n${code}\n\`\`\`\n\nThat's all.`);
  const parts = splitText(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= SECTION_LIMIT));
  for (const p of parts) assert.equal((p.match(/```/g) || []).length % 2, 0, `unbalanced fence in: ${p.slice(0, 60)}`);
  assert.ok(parts[0].endsWith('\n```'));
  assert.ok(parts[1].startsWith('```\n'));
  assert.ok(parts.at(-1).endsWith("That's all."));
  // The code lines all survive, in order.
  const seen = parts.join('\n').split('\n').filter((l) => l.startsWith('SELECT'));
  assert.deepEqual(seen, code.split('\n'));
});

test('formatBlocks converts then splits; messageParts keeps short text plain and caps a message at 50 blocks', () => {
  assert.deepEqual(formatBlocks('# Title\n- **a**'), [{ type: 'section', text: { type: 'mrkdwn', text: '*Title*\n• *a*' } }]);

  assert.deepEqual(messageParts('hi'), [{ text: 'hi' }]);
  const own = { text: 'fallback', blocks: [{ type: 'divider' }] };
  assert.deepEqual(messageParts(own), [own]);

  const huge = Array.from({ length: 160 }, () => 'y'.repeat(2000)).join('\n');
  const parts = messageParts({ text: huge });
  assert.equal(MAX_MESSAGE_BLOCKS, 50);
  assert.deepEqual(parts.map((m) => m.blocks.length), [50, 50, 50, 10]);
  assert.equal(parts.flatMap((m) => m.blocks.map((b) => b.text.text)).join('\n'), huge);
});

test('the SDK offers the formatter to handlers', () => {
  assert.equal(sdk.toMrkdwn, toMrkdwn);
});

test('there is one splitter: the modal uses the shared one and keeps none of its own', () => {
  const modal = require('../../kit/runtime/slack/modal');
  assert.equal(modal.splitText, undefined);
  const src = fs.readFileSync(path.join(__dirname, '../../kit/runtime/slack/modal.js'), 'utf8');
  assert.match(src, /require\('\.\/format'\)/);
  assert.doesNotMatch(src, /lastIndexOf/);
});

test('thread history is never read in V1, so it cannot reach the AI', () => {
  const root = path.join(__dirname, '../../kit/runtime');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && /conversations\.(replies|history)/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
