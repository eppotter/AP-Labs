'use strict';

// N9 (plan epic-10, decision 4): nothing in the engine posts to a channel
// that isn't a DM, except through kit/runtime/slack/channel.js, the one
// channel-post function (Story 10.3 adds it, for the ops escalation, AD-14).
// Every other place that sends a message or a file is listed here with why it
// only ever reaches one person privately; a new one fails this test until it
// is reviewed (and goes through channel.js if it posts to a channel).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const CHANNEL = 'kit/runtime/slack/channel.js';

// A Slack call that sends something somewhere. Ephemeral messages are seen
// only by the person (postEphemeral, respond with response_type ephemeral)
// and views are private, so they aren't listed.
const SENDS = /\bchat\.(?!postEphemeral\b)[A-Za-z]+\s*\(|\bfiles\.upload[A-Za-z0-9]*\s*\(|\bsay\s*\(/;

// Each allowed send: [file, the line's code, why it reaches only a DM].
const ALLOWED = [
  ['kit/runtime/archetypes/scoped-pull/deliver.js', /client\.files\.uploadV2\(\{$/, /DM_ID\.test\(channel\)/, 'the CSV goes to the DM conversations.open returned, checked against DM_ID first'],
  ['kit/runtime/slack/greeting.js', /await say\(\{ text: greetingText/, /if \(!isPersonDm\(message\)\) return;/, 'answers a person\'s DM in the same DM'],
  ['kit/runtime/slack/handle.js', /if \(ev\.channel_type === 'im' && typeof args\.say === 'function'\) return args\.say\(\{ text \}\);/, /channel_type === 'im'/, 'only in a DM (channel_type im)'],
  ['kit/runtime/slack/hubs.js', /await client\.chat\.postMessage\(\{ channel: user\.id, text \}\);/, /channel: user\.id/, 'a user id as the channel opens that person\'s DM (team_join welcome)'],
];

function jsUnder(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...jsUnder(abs));
    else if (d.name.endsWith('.js')) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out;
}

test('nothing outside kit/runtime/slack/channel.js posts to a channel that is not a DM', () => {
  const found = [];
  for (const file of jsUnder(path.join(ROOT, 'kit/runtime'))) {
    if (file === CHANNEL) continue;
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (SENDS.test(line)) found.push({ file, line: line.trim(), at: i + 1, src });
    });
  }
  const unexplained = found.filter((f) => !ALLOWED.some(([file, code]) => file === f.file && code.test(f.line)));
  assert.deepEqual(unexplained.map((f) => `${f.file}:${f.at}: ${f.line}`), [], 'a new send: if it posts to a channel, it goes through kit/runtime/slack/channel.js');
  // Each allowed send is still there, with what keeps it to a DM.
  for (const [file, code, guard, why] of ALLOWED) {
    const hit = found.find((f) => f.file === file && code.test(f.line));
    assert.ok(hit, `${file}: the send this test allows is gone; update ALLOWED (${why})`);
    assert.match(hit.src, guard, `${file}: ${why}`);
  }
});
