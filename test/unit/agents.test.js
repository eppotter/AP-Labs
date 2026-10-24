'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = path.join(__dirname, '../../.claude/agents');

// Each agent's tools match its job (DESIGN §1, §2). Changing a list is a design change.
const ROSTER = {
  architect: ['Read', 'Grep', 'Glob'],
  builder: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  connector: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  onboarder: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  refuter: ['Read', 'Grep', 'Glob', 'Bash'],
  scribe: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  sqlsmith: ['Read', 'Grep', 'Glob'],
  verifier: ['Read', 'Grep', 'Glob', 'Bash'],
};

// Reference-implementation specifics that must never reach the template's agents.
const FORBIDDEN = [
  /varsity/i,
  /hometown/i,
  /snowflake/i,
  /ONE_HOMETOWN_REVENUE|CTAOLIT|COMBINED_\w+_TABLE/i,
  /\bU0[A-Z0-9]{6,}\b/, // Slack user ids
];

// The subset of YAML frontmatter the agent files use: `key: value` and folded `key: >-` blocks.
function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('no frontmatter');
  const out = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      if (key in out) throw new Error(`duplicate key: ${key}`);
      out[key] = /^[>|][-+]?$/.test(kv[2]) ? '' : kv[2].trim();
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = (out[key] ? `${out[key]} ` : '') + line.trim();
    } else if (line.trim()) {
      throw new Error(`unparsed frontmatter line: ${line}`);
    }
  }
  return { data: out, body: text.slice(m[0].length) };
}

function loadAgents() {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
      return { file, text, ...parseFrontmatter(text) };
    });
}

test('frontmatter parser handles plain and folded values', () => {
  const { data, body } = parseFrontmatter('---\nname: x\ndescription: >-\n  one\n  two\ntools: A, B\n---\n# Body\n');
  assert.deepEqual(data, { name: 'x', description: 'one two', tools: 'A, B' });
  assert.equal(body, '# Body\n');
  assert.throws(() => parseFrontmatter('# no frontmatter'), /no frontmatter/);
  assert.throws(() => parseFrontmatter('---\nname: a\nname: b\n---\n'), /duplicate key/);
});

test('the roster is exactly the eight agents (the Orchestrator is the main session)', () => {
  const names = loadAgents().map((a) => a.file.replace(/\.md$/, ''));
  assert.deepEqual(names, Object.keys(ROSTER).sort());
});

for (const agent of loadAgents()) {
  const name = agent.file.replace(/\.md$/, '');

  test(`${name}: name, description and the exact tool list; no model`, () => {
    assert.equal(agent.data.name, name);
    assert.ok(agent.data.description && agent.data.description.length > 40, 'description is written for routing');
    assert.deepEqual(agent.data.tools.split(',').map((t) => t.trim()), ROSTER[name]);
    assert.ok(!('model' in agent.data), 'agents inherit the session model');
  });

  test(`${name}: no reference-implementation specifics`, () => {
    for (const re of FORBIDDEN) assert.doesNotMatch(agent.text, re);
  });

  // The Refuter (Story 1.4) predates the roster and states its limits in its own shape.
  if (name !== 'refuter') {
    test(`${name}: states the hub-and-spoke rule`, () => {
      assert.match(agent.body, /^## Hub and spoke$/m);
      assert.match(agent.body, /only to the Orchestrator/);
    });
  }
}

test('specialists load their client file and say so when it is absent', () => {
  const byName = Object.fromEntries(loadAgents().map((a) => [a.file.replace(/\.md$/, ''), a.body]));
  for (const [name, file] of [['sqlsmith', 'data.md'], ['architect', 'guardrails.md'], ['connector', 'connectors.md']]) {
    assert.match(byName[name], new RegExp(`\\.aplabs/context/${file.replace('.', '\\.')}`));
    assert.match(byName[name], /\.aplabs\/context\/org\.md/);
    assert.match(byName[name], /has\s+not\s+been\s+onboarded/);
  }
});
