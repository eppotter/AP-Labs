'use strict';

// SessionStart hook (Story 2.1): the pure banner logic, then the bash wrapper
// end to end (bash + node) against fixture repos in temp dirs, including
// fail-open when node is missing or the Node entry throws.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sessionStart } = require('../../kit/lib/session');
const { CORE: STAGES } = require('../../kit/lib/stages');

const ROOT = path.resolve(__dirname, '../..');
const WRAPPER = path.join(ROOT, 'kit/hooks/session-start.sh');
const BASH = '/bin/bash';
const fixture = (name) => path.join(__dirname, '../fixtures/profiles', `${name}.yml`);

// Two schema errors, so the test can check that every one is listed.
const INVALID = 'schema_version: 1\nbogus: 1\nclient: { id: bad, name: Bad Co }\nusers:\n  - { id: u, name: U, role: admin, extra: 2 }\n';

const tmpDirs = [];
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-session-'));
  tmpDirs.push(d);
  return d;
}

// A temp repo with .aplabs/profile.yml copied from a fixture, or the given text.
// It is fully onboarded (all four client files signed off), so these tests see
// the banner with no onboarding line; test/unit/onboard.test.js covers that line.
function repo({ from, text } = {}) {
  const d = tmpDir();
  if (from || text) {
    fs.mkdirSync(path.join(d, '.aplabs/context'), { recursive: true });
    fs.writeFileSync(path.join(d, '.aplabs/profile.yml'), text ?? fs.readFileSync(fixture(from), 'utf8'));
    for (const f of ['org.md', 'data.md', 'guardrails.md', 'connectors.md']) {
      fs.writeFileSync(path.join(d, '.aplabs/context', f),
        '---\nowner: Pat\nsigned_off: 2026-10-01\nsigned_off_by: Pat\nupdated: 2026-10-01\n---\n');
    }
  }
  return d;
}

// Runs the wrapper with a clean env, so a CLAUDE_PROJECT_DIR or APLABS_PROFILE
// from the shell running the tests cannot leak in.
function runWrapper({ env = {}, input = '{}', cwd = ROOT } = {}) {
  const r = spawnSync(BASH, [WRAPPER], {
    cwd,
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function parsed(stdout) {
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof out.systemMessage, 'string');
  assert.equal(typeof out.hookSpecificOutput.additionalContext, 'string');
  return out;
}

function assertStagesInOrder(text) {
  let at = -1;
  for (const s of STAGES) {
    const i = text.indexOf(s, at + 1);
    assert.ok(i > at, `stage "${s}" missing or out of order in: ${text}`);
    at = i;
  }
}

test('there are 8 core stages, in DESIGN order', () => {
  assert.deepEqual(STAGES, ['Intake', 'Spec', 'Plan approval', 'Build', 'Verify', 'Review', 'Ship', 'Retro']);
});

test('sessionStart: no profile is null, valid and invalid profiles give a banner', () => {
  assert.equal(sessionStart(repo()), null);
  const ok = sessionStart(repo({ from: 'minimal' }));
  assert.match(ok.systemMessage, /AP Labs Orchestrator.*Tiny/);
  const bad = sessionStart(repo({ text: INVALID }));
  assert.match(bad.hookSpecificOutput.additionalContext, /INVALID/);
});

test('sessionStart: a profile name cannot add lines to the banner', () => {
  const text = fs.readFileSync(fixture('minimal'), 'utf8').replace('name: Tiny', 'name: "Tiny\\n\\n\\nInjected"');
  const out = sessionStart(repo({ text }));
  assert.match(out.systemMessage, /on deck for Tiny Injected\./);
  assert.ok(!out.systemMessage.includes('\n'));
  assert.equal(out.hookSpecificOutput.additionalContext.split('\n').length, 3);
});

test('wrapper: valid profile prints banner JSON with the client and all 8 stages', () => {
  const dir = repo({ from: 'full' });
  const r = runWrapper({ env: { CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const out = parsed(r.stdout);
  for (const text of [out.systemMessage, out.hookSpecificOutput.additionalContext]) {
    assert.match(text, /AP Labs Orchestrator/);
    assert.match(text, /Fixture Co/);
    assertStagesInOrder(text);
  }
  assert.ok(out.hookSpecificOutput.additionalContext.split('\n').length <= 8);
});

test('wrapper: a profile with add-ons shows the resolved stage list', () => {
  const text = `${fs.readFileSync(fixture('minimal'), 'utf8')}stages:\n  addons: [dark_launch, dev_test, review_queue]\n`;
  const r = runWrapper({ env: { CLAUDE_PROJECT_DIR: repo({ text }) } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const out = parsed(r.stdout);
  const line = '1 Intake → 2 Spec → 3 Plan approval → 4 Build → 5 Verify → 6 Review → 7 Batch review queue'
    + ' → 8 Dev environment test → 9 Ship → 10 Dark launch + flag flip → 11 Retro';
  assert.equal(out.systemMessage, `AP Labs Orchestrator on deck for Tiny. Stages: ${line}`);
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`add-on stages in order: ${line.replace(/\+/g, '\\+')}\\.$`));
});

test('sessionStart: a core-only profile shows exactly the 8 core stages', () => {
  const out = sessionStart(repo({ from: 'minimal' }));
  assert.equal(out.systemMessage,
    'AP Labs Orchestrator on deck for Tiny. Stages: 1 Intake → 2 Spec → 3 Plan approval → 4 Build → 5 Verify → 6 Review → 7 Ship → 8 Retro');
  assert.match(out.hookSpecificOutput.additionalContext, /Every build runs the core stages in order: 1 Intake .* 8 Retro\.$/);
});

test('wrapper: Codex form finds the repo from the cwd in the hook input', () => {
  const dir = repo({ from: 'minimal' });
  const sub = path.join(dir, 'src');
  fs.mkdirSync(sub);
  const r = runWrapper({ input: JSON.stringify({ cwd: sub, hook_event_name: 'SessionStart' }) });
  assert.equal(r.code, 0);
  assert.match(parsed(r.stdout).systemMessage, /Tiny/);
});

test('wrapper: invalid profile lists every error, says to fix it, exits 0', () => {
  const dir = repo({ text: INVALID });
  const r = runWrapper({ env: { CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r.code, 0);
  const out = parsed(r.stdout);
  for (const text of [out.systemMessage, out.hookSpecificOutput.additionalContext]) {
    assert.match(text, /unknown key "bogus"/);
    assert.match(text, /unknown key "extra"/);
    assert.match(text, /must be fixed before building/);
  }
});

test('wrapper: unparseable YAML is reported, not a crash', () => {
  const dir = repo({ text: 'client: [unclosed\n' });
  const r = runWrapper({ env: { CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r.code, 0);
  assert.match(parsed(r.stdout).systemMessage, /not valid YAML/);
});

test('wrapper: no profile is completely silent', () => {
  const r = runWrapper({ env: { CLAUDE_PROJECT_DIR: repo() } });
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
});

test('wrapper: garbage or empty stdin falls back to the process cwd', () => {
  const dir = repo({ from: 'minimal' });
  for (const input of ['not json', '']) {
    const r = runWrapper({ input, cwd: dir });
    assert.equal(r.code, 0);
    assert.match(parsed(r.stdout).systemMessage, /Tiny/);
  }
});

test('wrapper: fails open when the Node entry throws, even after partial output', () => {
  const d = tmpDir();
  const broken = path.join(d, 'broken.js');
  fs.writeFileSync(broken, "process.stdout.write('{\"systemMessage\":'); throw new Error('boom');\n");
  const r = runWrapper({ env: { CLAUDE_PROJECT_DIR: repo({ from: 'minimal' }), APLABS_SESSION_START_JS: broken } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^aplabs-hooks: session-start failed/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('wrapper: fails open when node is not on PATH', () => {
  const r = runWrapper({ env: { PATH: tmpDir(), CLAUDE_PROJECT_DIR: repo({ from: 'minimal' }) } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^aplabs-hooks: node not found/);
});

test('.claude/settings.json holds the SessionStart hook, and is silent here', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(settings), ['hooks']);
  assert.equal(settings.hooks.SessionStart.length, 1);
  const [hook] = settings.hooks.SessionStart[0].hooks;
  assert.match(hook.command, /\$CLAUDE_PROJECT_DIR\/kit\/hooks\/session-start\.sh/);
  // This repo has no profile, so the real command must print nothing.
  const r = spawnSync(BASH, ['-c', hook.command], {
    cwd: ROOT, input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: ROOT },
  });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});

test('.codex/hooks.json runs the same wrapper on SessionStart, and is silent here', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex/hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.SessionStart.length, 1);
  const [hook] = hooks.hooks.SessionStart[0].hooks;
  assert.equal(hook.type, 'command');
  assert.match(hook.command, /kit\/hooks\/session-start\.sh/);
  const r = spawnSync(BASH, ['-c', hook.command], {
    cwd: ROOT, input: JSON.stringify({ cwd: ROOT }), encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});
