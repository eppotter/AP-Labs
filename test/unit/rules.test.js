'use strict';

// The rules layer (AGENTS.md) may only route to things that are installed (Story 2.3).
// Conventions the parser relies on, inside the Orchestrator section:
//   - a skill is a backticked bare name (`p3-mode`, `bmad-prd`); nothing else is
//     backticked as a bare lowercase name
//   - agents are listed, unbackticked, on the one line starting "Agents"
//   - playbooks are backticked paths under .agents/skills/
// `bmad-*` names and `npm run <script>` are checked across the whole file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const SECTION = '## The Orchestrator';
const STOP_RULE = 'stop after reporting; never start another story; do not open a PR';

// Scripts the rules may name before they exist. Each entry must be removed once
// its script lands: the test fails if a pending script is already in package.json.
const PENDING_SCRIPTS = {
  land: 'Story 1.5 adds npm run land (merge gated on review and CI)',
};

function orchestratorSection(text) {
  const start = text.indexOf(`\n${SECTION}\n`);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.slice(SECTION.length).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, SECTION.length + next);
}

function backticked(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

// Returns every reference that is not installed, as human-readable strings.
function missingReferences(text, { root, scripts, pending }) {
  const missing = [];
  const section = orchestratorSection(text);
  if (section === null) return [`no "${SECTION}" section`];

  const skills = new Set(text.match(/\bbmad-[a-z0-9-]*[a-z0-9]/g) || []);
  for (const t of backticked(section)) {
    if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(t)) skills.add(t);
  }
  for (const s of skills) {
    if (!fs.existsSync(path.join(root, '.agents/skills', s, 'SKILL.md'))) missing.push(`skill ${s}`);
  }

  for (const t of backticked(section)) {
    if (t.startsWith('.agents/skills/') && t.endsWith('.md') && !fs.existsSync(path.join(root, t))) {
      missing.push(`playbook ${t}`);
    }
  }

  const agentLines = section.split('\n').filter((l) => /^Agents\b/.test(l));
  if (agentLines.length !== 1) missing.push(`expected one "Agents" line, found ${agentLines.length}`);
  for (const name of agentNames(agentLines[0] || '')) {
    if (!fs.existsSync(path.join(root, '.claude/agents', `${name}.md`))) missing.push(`agent ${name}`);
  }

  for (const m of text.matchAll(/npm run ([a-z][\w:-]*)/g)) {
    const s = m[1];
    if (!(s in scripts) && !(s in pending)) missing.push(`script ${s}`);
  }
  return [...new Set(missing)];
}

function agentNames(line) {
  const list = line.slice(line.indexOf(':', line.indexOf(')') + 1) + 1);
  return list.replace(/\.\s*$/, '').split(',').map((s) => s.trim()).filter(Boolean);
}

const agentsMd = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const opts = { root: ROOT, scripts, pending: PENDING_SCRIPTS };

test('AGENTS.md references only installed skills, playbooks, agents and scripts', () => {
  assert.deepEqual(missingReferences(agentsMd, opts), []);
});

test('the agent list names the whole roster', () => {
  const line = orchestratorSection(agentsMd).split('\n').find((l) => /^Agents\b/.test(l));
  const roster = fs.readdirSync(path.join(ROOT, '.claude/agents'))
    .filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual([...agentNames(line)].sort(), roster);
});

test('pending scripts do not exist yet (remove them from the allowlist once they land)', () => {
  for (const [name, why] of Object.entries(PENDING_SCRIPTS)) {
    assert.ok(!(name in scripts), `npm run ${name} now exists; drop it from PENDING_SCRIPTS (${why})`);
  }
});

test('the Orchestrator section carries the stop rule and the approval phrase', () => {
  const section = orchestratorSection(agentsMd);
  assert.ok(section.includes(STOP_RULE), 'stop-rule sentence missing');
  assert.match(section, /`approve plan <slug>`/);
});

test('the checker catches what is not installed', () => {
  const fake = [
    '# x', '', 'Uses `bmad-nope` and npm run nope.', '', SECTION, '',
    'Agents (`.claude/agents/<name>.md`): builder, ghost.', '',
    'Run `p3-nope` with `.agents/skills/p3-mode/playbooks/nope.md`, then npm run land.', '',
    '## Next', '', 'Outside the section `not-a-skill` is ignored.', '',
  ].join('\n');
  assert.deepEqual(missingReferences(fake, opts).sort(), [
    'agent ghost',
    'playbook .agents/skills/p3-mode/playbooks/nope.md',
    'script nope',
    'skill bmad-nope',
    'skill p3-nope',
  ]);
  assert.deepEqual(missingReferences('# no section\n', opts), [`no "${SECTION}" section`]);
});
