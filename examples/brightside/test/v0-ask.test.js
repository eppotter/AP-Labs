'use strict';

// Brightside v0's Ask (plan brightside-v0, Story 16.7), end to end through
// the booted engine with the fake Slack client and a stand-in Anthropic
// client (it checks each request as the real API does; nothing reaches the
// real API). An example test (architecture carve-out): it reads Brightside's
// app dir and the demo profile fixture (never profiles/brightside/), and is
// deleted with the example in a fork. /brightside-v0 sees neither data nor
// rules, so every data question gets "no data and no rules yet".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const { checkRequest } = require('../../../test/fixtures/fake-anthropic');
const askTool = require('../../../kit/runtime/archetypes/ask');
const { ASK_WORDS } = require('../../../kit/runtime/messages');

const ROOT = path.join(__dirname, '../../..');
const PROFILE = path.join(__dirname, 'fixtures/demo-profile.yml');
const ADMIN = { id: 'U0FIXTUREELY', name: 'ely' }; // Ely, the fixture's admin

class ViewsApp extends FakeSlackApp {
  constructor(options) {
    super({ ...options, views: true });
  }
}

// Sorts every question as data.
function dataModel() {
  const calls = [];
  return {
    calls,
    client: {
      messages: {
        async create(params) {
          calls.push(params);
          checkRequest(params);
          return {
            content: [{ type: 'tool_use', id: 'tu_1', name: askTool.TOOL_NAME, input: { kind: 'data' } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 100, output_tokens: 10 },
          };
        },
      },
    },
  };
}

test('/brightside-v0: Ask with a data question gets "no data and no rules yet", from one route call and no data', async (t) => {
  const lines = [];
  const model = dataModel();
  const varDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-v0ask-var-')));
  t.after(() => fs.rmSync(varDir, { recursive: true, force: true }));
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      ANTHROPIC_API_KEY: 'sk-ant-api00-fake-v0-ask-key-value',
      APLABS_PROFILE: PROFILE,
      APLABS_APP_DIR: path.join(ROOT, 'examples/brightside/app'),
      APLABS_DATA_PATH: path.join(os.tmpdir(), 'aplabs-no-such-v0ask-data.duckdb'),
      APLABS_VAR_DIR: varDir,
    },
    cwd: os.tmpdir(),
    deps: {
      App: ViewsApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain'), llm: { createClient: () => model.client },
    },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => {
    res.engineJobs.stop();
    res.jobs.stop();
    res.data.close();
  });
  const { app } = res;
  await app.dispatchAction('v0-ask:open', { user: ADMIN, view: { id: 'VMENU', type: 'modal', private_metadata: 'brightside-v0', hash: 'h0' } });
  const form = app.views.filter((v) => v.method === 'push').at(-1).args.view;
  assert.equal(form.callback_id, askTool.FORM_CALLBACK);
  const view = {
    ...form,
    id: 'VASK',
    state: { values: { [askTool.QUESTION_BLOCK]: { [askTool.QUESTION_ACTION]: { type: 'plain_text_input', value: 'How many cleanings did we do last week?' } } } },
  };
  await app.dispatchView(askTool.FORM_CALLBACK, { user: ADMIN, view });
  const answer = app.views.filter((v) => v.method === 'update').at(-1).args.view;
  assert.equal(answer.blocks[0].text.text, ASK_WORDS.noDataNoRules());
  assert.equal(model.calls.length, 1);
  // The blank hub's prompt carries no business context.
  assert.ok(!model.calls[0].system.includes('<client_context file='));
  // Request a tool is offered: Ely holds the key, a channel is set, the hub is blank.
  assert.deepEqual(answer.blocks.at(-1).elements.map((e) => e.action_id), [askTool.ACTIONS.buildRequest, askTool.ACTIONS.again]);
});

// Story 18.3 (review R1-1): once the demo pack's billing CSV is a note on
// /brightside-v0, a figures question sorted as data is answered from the
// note, not refused. Boots the engine as above; the stand-in AI sorts every
// question as data and, asked by answer_from_notes, says the notes cover it.
test('/brightside-v0: a data question the uploaded notes answer is answered from them, on the blank hub\'s own prompt', async (t) => {
  const { readCsv } = require('../../../kit/runtime/slack/files');
  const lines = [];
  const calls = [];
  const client = {
    messages: {
      async create(params) {
        calls.push(params);
        checkRequest(params);
        const usage = { input_tokens: 100, output_tokens: 10 };
        if (params.tools[0].name === askTool.NOTES_TOOL_NAME) {
          return {
            content: [{ type: 'tool_use', id: 'tu_2', name: askTool.NOTES_TOOL_NAME, input: { covered: true, answer: 'South billed the most: $91,558.00.' } }],
            stop_reason: 'tool_use',
            usage,
          };
        }
        return { content: [{ type: 'tool_use', id: 'tu_1', name: askTool.TOOL_NAME, input: { kind: 'data' } }], stop_reason: 'tool_use', usage };
      },
    },
  };
  const varDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-v0ask-notes-')));
  t.after(() => fs.rmSync(varDir, { recursive: true, force: true }));
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      ANTHROPIC_API_KEY: 'sk-ant-api00-fake-v0-ask-key-value',
      APLABS_PROFILE: PROFILE,
      APLABS_APP_DIR: path.join(ROOT, 'examples/brightside/app'),
      APLABS_DATA_PATH: path.join(os.tmpdir(), 'aplabs-no-such-v0ask-data.duckdb'),
      APLABS_VAR_DIR: varDir,
    },
    cwd: os.tmpdir(),
    deps: {
      App: ViewsApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain'), llm: { createClient: () => client },
    },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => {
    res.engineJobs.stop();
    res.jobs.stop();
    res.data.close();
  });
  const csv = readCsv(fs.readFileSync(path.join(__dirname, '../demo-pack/zone-billing-2026-09.csv')));
  await res.knowledge.add({
    hub: 'brightside-v0', kind: 'file', title: 'Billing by zone, September', text: csv.text, addedBy: ADMIN.id,
    file: { name: 'zone-billing-2026-09.csv', type: 'text/csv', bytes: 229 },
  });
  const { app } = res;
  await app.dispatchAction('v0-ask:open', { user: ADMIN, view: { id: 'VMENU', type: 'modal', private_metadata: 'brightside-v0', hash: 'h0' } });
  const form = app.views.filter((v) => v.method === 'push').at(-1).args.view;
  const question = 'Which zone billed the most in September, and how much cash did we receive from that zone in September?';
  const view = {
    ...form,
    id: 'VASK',
    state: { values: { [askTool.QUESTION_BLOCK]: { [askTool.QUESTION_ACTION]: { type: 'plain_text_input', value: question } } } },
  };
  await app.dispatchView(askTool.FORM_CALLBACK, { user: ADMIN, view });
  const answer = app.views.filter((v) => v.method === 'update').at(-1).args.view;
  assert.equal(answer.blocks[0].text.text, 'South billed the most: $91,558.00.');
  assert.notEqual(answer.blocks[0].text.text, ASK_WORDS.noDataNoRules());
  assert.equal(calls.length, 2);
  const notesCall = calls[1];
  assert.equal(notesCall.tools[0].name, askTool.NOTES_TOOL_NAME);
  // The note is in the prompt; the profile's context, data and rules are not (sees: []).
  assert.ok(notesCall.system.includes('Cash received in September ($)'));
  assert.ok(!notesCall.system.includes('<client_context file='));
});
