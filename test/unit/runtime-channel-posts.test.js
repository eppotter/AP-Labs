'use strict';

// N9 (plan epic-10, decision 4): nothing in the engine posts to a channel
// that isn't a DM, except through kit/runtime/slack/channel.js, the one
// channel-post function (Story 10.3 adds it, for the ops escalation, AD-14;
// Story 16.6 adds the build request, the AD-14 amendment).
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

// Matches only a source that never names channel, channels or channel_id
// (any case), so no argument can share the file to a conversation.
const NO_CHANNEL = /^(?![\s\S]*\bchannel(?:s|_id)?\b)/i;

// Each allowed send: [file, the line's code, a guard over the file's source,
// why it reaches only a DM (or no one)].
const ALLOWED = [
  ['kit/runtime/archetypes/scoped-pull/deliver.js', /client\.files\.uploadV2\(\{$/, /DM_ID\.test\(channel\)/, 'the CSV goes to the DM conversations.open returned, checked against DM_ID first'],
  ['kit/runtime/slack/greeting.js', /await say\(\{ text: greetingText/, /if \(!isPersonDm\(message\)\) return;/, 'answers a person\'s DM in the same DM'],
  ['kit/runtime/slack/handle.js', /if \(ev\.channel_type === 'im' && typeof args\.say === 'function'\) return args\.say\(\{ text \}\);/, /channel_type === 'im'/, 'only in a DM (channel_type im)'],
  ['kit/runtime/slack/hubs.js', /await client\.chat\.postMessage\(\{ channel: user\.id, text \}\);/, /channel: user\.id/, 'a user id as the channel opens that person\'s DM (team_join welcome)'],
  // Story 15.1 (AD-R15, F2): the map image is uploaded shared nowhere and
  // shown only in the modal. The call's arguments are pinned, and the guard
  // proves the file never names a channel, channels or channel_id at all.
  ['kit/runtime/slack/image.js', /^const res = await client\.files\.uploadV2\(\{ file: png, filename: FILENAME, title: TITLE \}\);$/, NO_CHANNEL, 'the map image is uploaded with no channel_id, channel or channels: shared nowhere'],
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

// Story 10.3: the one exception lives in kit/runtime/slack/channel.js. It has
// exactly one send, and that send is reached only after the exception is
// looked up in its declared list and the channel matched as a channel id.
test('kit/runtime/slack/channel.js has exactly one send, guarded by its declared exceptions and the channel-id check', () => {
  const src = fs.readFileSync(path.join(ROOT, CHANNEL), 'utf8');
  const sends = src.split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line) && SENDS.test(line));
  assert.deepEqual(sends.map((l) => l.trim()), ['return client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });']);
  const at = src.indexOf('client.chat.postMessage(');
  const guards = src.slice(src.indexOf('async function postToChannel('), at);
  assert.match(guards, /if \(!Object\.hasOwn\(EXCEPTIONS, exception\)\) throw/);
  assert.match(guards, /if \(typeof channel !== 'string' \|\| !CHANNEL_ID\.test\(channel\)\) throw/);
  assert.match(guards, /const text = EXCEPTIONS\[exception\]\(fields\);/, 'the text is built by the exception, never passed in');
  assert.match(src, /const CHANNEL_ID = \/\^\[CG\]\[A-Z0-9\]\{8,\}\$\/;/, 'the profile schema\'s pattern: never a DM (D…) or a person (U…)');
});

// Story 16.6 (plan brightside-v0, D11, the AD-14 amendment): the declared
// exceptions are exactly the write escalation and the build request, and the
// build request's text refuses a hub that sees context or data before
// anything else is read.
test('kit/runtime/slack/channel.js declares exactly two exceptions; build-request is refused from a hub that sees context or data', () => {
  const channel = require(path.join(ROOT, CHANNEL));
  assert.deepEqual(Object.keys(channel.EXCEPTIONS), ['write-escalation', 'build-request']);
  const src = fs.readFileSync(path.join(ROOT, CHANNEL), 'utf8');
  const body = src.slice(src.indexOf('function buildRequestText('), src.indexOf('// Exception name'));
  assert.match(body, /if \(!mayPostBuildRequest\(hub\.sees\)\) throw new ChannelPostRefused/);
  assert.match(body, /From <@\$\{requester\}>/, 'the one mention is the requester');
  assert.match(src, /const BUILD_REQUEST_BLOCKED_SEES = Object\.freeze\(\['context', 'data'\]\);/);
});

// Story 15.1: the image row's guard fails on any way of naming a channel.
test('the map image guard refuses a source that names channel_id, channel or channels', () => {
  const ok = "const res = await client.files.uploadV2({ file: png, filename: FILENAME, title: TITLE });\n";
  const row = ALLOWED.find(([file]) => file === 'kit/runtime/slack/image.js');
  assert.match(ok, row[2]);
  for (const bad of [
    'client.files.uploadV2({ file: png, filename: FILENAME, title: TITLE, channel_id: dm });',
    'client.files.uploadV2({ file: png, channels: c });',
    'const args = { channel };',
    'const CHANNEL_ID = x;',
  ]) assert.doesNotMatch(`${ok}${bad}\n`, row[2], bad);
});
