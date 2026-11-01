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
