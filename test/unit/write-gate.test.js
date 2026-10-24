'use strict';

// Write gate (Story 2.4): every decision rule, run through the bash wrapper
// end to end (bash + node) against fixture git repos in temp dirs, plus the
// SubagentStart marker, `npm run engage`, the gate log and fail-open.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { targetPaths } = require('../../kit/lib/gate');

const ROOT = path.resolve(__dirname, '../..');
const WRAPPER = path.join(ROOT, 'kit/hooks/write-gate.sh');
const ENGAGE = path.join(ROOT, 'kit/hooks/engage.js');
const BASH = '/bin/bash';
const MINIMAL = fs.readFileSync(path.join(__dirname, '../fixtures/profiles/minimal.yml'), 'utf8');
const PROFILE = `${MINIMAL}gate: { exempt: ["sandbox/**"], engagement_ttl_minutes: 30 }\n`;
const INVALID = 'schema_version: 1\nbogus: 1\nclient: { id: bad, name: Bad Co }\nusers:\n  - { id: u, name: U, role: admin, extra: 2 }\n';

const tmpDirs = [];
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-gate-'));
  tmpDirs.push(d);
  return d;
}

// Clean env, so a CLAUDE_PROJECT_DIR, APLABS_PROFILE or git identity from the
// shell running the tests cannot leak in.
const HOME = tmpDir();
const cleanEnv = (env = {}) => ({ PATH: process.env.PATH, HOME, GIT_CONFIG_NOSYSTEM: '1', ...env });

// A temp git repo, with .aplabs/profile.yml when `profile` text is given.
function repo(profile = PROFILE) {
  const d = tmpDir();
  execFileSync('git', ['init', '-q', '-b', 'story-x', d], { env: cleanEnv() });
  execFileSync('git', ['-C', d, 'config', 'user.name', 'Gate Tester'], { env: cleanEnv() });
  if (profile !== null) {
    fs.mkdirSync(path.join(d, '.aplabs'));
    fs.writeFileSync(path.join(d, '.aplabs/profile.yml'), profile);
  }
  return d;
}

const gitDir = (d) => path.join(d, '.git');
const marker = (d, name) => path.join(gitDir(d), 'aplabs/engaged', name);
const logLines = (d) => {
  const f = path.join(gitDir(d), 'aplabs/gate.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : [];
};

function run({ dir, input, args = [], env = {} }) {
  const r = spawnSync(BASH, [WRAPPER, ...args], {
    cwd: dir || ROOT,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: cleanEnv(dir ? { CLAUDE_PROJECT_DIR: dir, ...env } : env),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const write = (dir, rel, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd: dir, tool_name: 'Write',
  tool_input: { file_path: path.join(dir, rel), content: 'x' }, ...extra,
});

const SILENT = { code: 0, stdout: '', stderr: '' };

function denied(r) {
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(typeof out.systemMessage, 'string');
  return out.hookSpecificOutput.permissionDecisionReason;
}

test('targetPaths: edit tools give their paths, apply_patch is parsed, other tools are null', () => {
  assert.deepEqual(targetPaths('Write', { file_path: 'a.js' }), ['a.js']);
  assert.deepEqual(targetPaths('NotebookEdit', { notebook_path: 'n.ipynb' }), ['n.ipynb']);
  assert.deepEqual(targetPaths('Edit', {}), []);
  assert.equal(targetPaths('Bash', { command: 'echo > a.js' }), null);
  const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** Add File: sandbox/b.js\n+z\n*** Delete File: c.js\n*** End Patch\n';
  assert.deepEqual(targetPaths('apply_patch', { command: patch }), ['src/a.js', 'sandbox/b.js', 'c.js']);
});

test('rule: ungoverned repo allows silently', () => {
  const d = repo(null);
  assert.deepEqual(run({ dir: d, input: write(d, 'src/a.js') }), SILENT);
  assert.equal(fs.existsSync(path.join(gitDir(d), 'aplabs')), false);
});

test('rule: a non-edit tool is never gated', () => {
  const d = repo();
  assert.deepEqual(run({ dir: d, input: { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: d } }), SILENT);
  assert.deepEqual(logLines(d), []);
});

test('rule: invalid profile denies with every validation error, and is logged', () => {
  const d = repo(INVALID);
  const reason = denied(run({ dir: d, input: write(d, 'src/a.js') }));
  assert.match(reason, /fix the profile first/);
  assert.match(reason, /unknown key "bogus"/);
  assert.match(reason, /unknown key "extra"/);
  // Even inside a subagent and with a fresh marker: the profile comes first.
  run({ dir: d, input: { hook_event_name: 'SubagentStart', session_id: 'sess-1', agent_id: 'a1', agent_type: 'builder', cwd: d } });
  denied(run({ dir: d, input: write(d, 'src/a.js', { agent_id: 'a1' }) }));
  const lines = logLines(d);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\tdeny\tinvalid-profile\ttool=Write\tsession=sess-1\tpaths=src\/a\.js$/);
});

test('rule: invalid profile still allows fixing the profile file itself', () => {
  const d = repo(INVALID);
  assert.deepEqual(run({ dir: d, input: write(d, '.aplabs/profile.yml') }), SILENT);
});

test('rule: exempt paths allow; a mix of exempt and gated paths does not', () => {
  const d = repo();
  assert.deepEqual(run({ dir: d, input: write(d, 'sandbox/deep/a.js') }), SILENT);
  const patch = '*** Begin Patch\n*** Add File: sandbox/a.js\n+x\n*** Update File: src/b.js\n+y\n*** End Patch\n';
  const r = run({ dir: d, args: ['--harness', 'codex'], input: { hook_event_name: 'PreToolUse', cwd: d, tool_name: 'apply_patch', tool_input: { command: patch } } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /src\/b\.js/);
  // Exempt globs match exact case: they lower friction, so they never fail open on case.
  denied(run({ dir: d, input: write(d, 'Sandbox/a.js') }));
});

test('rule: an edit inside a subagent (agent_id) allows', () => {
  const d = repo();
  assert.deepEqual(run({ dir: d, input: write(d, 'src/a.js', { agent_id: 'agent-123', agent_type: 'builder' }) }), SILENT);
  denied(run({ dir: d, input: write(d, 'src/a.js', { agent_id: '' }) }));
});

test('SubagentStart writes a session-keyed marker that opens the gate for that session only', () => {
  const d = repo();
  const r = run({ dir: d, input: { hook_event_name: 'SubagentStart', session_id: 'sess/1', agent_id: 'a1', agent_type: 'Explore', cwd: d } });
  assert.deepEqual(r, SILENT);
  const m = JSON.parse(fs.readFileSync(marker(d, 'session-sess_1'), 'utf8'));
  assert.equal(m.by, 'SubagentStart');
  assert.equal(m.agent_type, 'Explore');
  assert.deepEqual(run({ dir: d, input: write(d, 'src/a.js', { session_id: 'sess/1' }) }), SILENT);
  denied(run({ dir: d, input: write(d, 'src/a.js', { session_id: 'other' }) }));
});

test('SubagentStart in an ungoverned repo writes nothing', () => {
  const d = repo(null);
  assert.deepEqual(run({ dir: d, input: { hook_event_name: 'SubagentStart', session_id: 's', cwd: d } }), SILENT);
  assert.equal(fs.existsSync(path.join(gitDir(d), 'aplabs')), false);
});

// Runs the real `npm run engage` inside the fixture, which gets a package.json
// pointing at this repo's engage entry.
function npmEngage(d, args) {
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'fx', private: true, scripts: { engage: `node ${JSON.stringify(ENGAGE)}` } }));
  const r = spawnSync('npm', ['run', '--silent', 'engage', '--', ...args], { cwd: d, encoding: 'utf8', env: cleanEnv() });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('npm run engage writes the worktree marker and a log line; the marker opens the gate', () => {
  const d = repo();
  denied(run({ dir: d, input: write(d, 'src/a.js') }));
  const r = npmEngage(d, ['--reason', 'Story 9.9:\tthe\nwidget']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /open in this worktree for 30 minutes/);
  const m = JSON.parse(fs.readFileSync(marker(d, 'worktree'), 'utf8'));
  assert.deepEqual([m.by, m.reason, m.user, m.branch], ['engage', 'Story 9.9: the widget', 'Gate Tester', 'story-x']);
  const lines = logLines(d);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\tdeny\tno-marker\t/);
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z\tengage\treason=Story 9\.9: the widget\tuser=Gate Tester\tbranch=story-x$/);
  // Any session in this worktree, Claude Code or Codex, is now allowed, and allows are not logged.
  assert.deepEqual(run({ dir: d, input: write(d, 'src/a.js', { session_id: 'any' }) }), SILENT);
  const patch = '*** Begin Patch\n*** Update File: src/b.js\n+y\n*** End Patch\n';
  assert.deepEqual(run({ dir: d, args: ['--harness', 'codex'], input: { cwd: d, tool_name: 'apply_patch', tool_input: { command: patch } } }), SILENT);
  assert.equal(logLines(d).length, 2);
});

test('engage without a reason is a usage error and writes nothing', () => {
  const d = repo();
  for (const args of [[], ['--reason', '   ']]) {
    const r = spawnSync('node', [ENGAGE, ...args], { cwd: d, encoding: 'utf8', env: cleanEnv() });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /a reason is required/);
  }
  assert.equal(fs.existsSync(marker(d, 'worktree')), false);
  assert.deepEqual(logLines(d), []);
});

test('engage in an ungoverned repo says so and writes nothing', () => {
  const d = repo(null);
  const r = spawnSync('node', [ENGAGE, '--reason=x'], { cwd: d, encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not governed/);
  assert.equal(fs.existsSync(path.join(gitDir(d), 'aplabs')), false);
});

test('rule: an expired marker is ignored and the edit is denied', () => {
  const d = repo();
  spawnSync('node', [ENGAGE, '--reason', 'old'], { cwd: d, env: cleanEnv() });
  run({ dir: d, input: { hook_event_name: 'SubagentStart', session_id: 'sess-1', cwd: d } });
  const old = new Date(Date.now() - 31 * 60 * 1000); // TTL is 30 in this profile
  for (const f of [marker(d, 'worktree'), marker(d, 'session-sess-1')]) fs.utimesSync(f, old, old);
  denied(run({ dir: d, input: write(d, 'src/a.js') }));
  // A marker stamped far in the future does not count either.
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  fs.utimesSync(marker(d, 'worktree'), future, future);
  denied(run({ dir: d, input: write(d, 'src/a.js') }));
});

test('rule: no marker denies with a route-the-work reason, and the deny is logged', () => {
  const d = repo();
  const reason = denied(run({ dir: d, input: write(d, 'src/a.js') }));
  assert.match(reason, /until the work is routed/);
  assert.match(reason, /Builder subagent/);
  assert.match(reason, /npm run engage -- --reason/);
  assert.match(reason, /Blocked: src\/a\.js/);
  const lines = logLines(d);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\tdeny\tno-marker\ttool=Write\tsession=sess-1\tpaths=src\/a\.js$/);
});

test('Codex: a deny is exit 2 with the reason on stderr and nothing on stdout', () => {
  const d = repo();
  const sub = path.join(d, 'src');
  fs.mkdirSync(sub);
  const patch = '*** Begin Patch\n*** Add File: new/a.js\n+x\n*** End Patch\n';
  // No CLAUDE_PROJECT_DIR: Codex finds the repo from the hook input's cwd, and relative patch paths resolve against it.
  const r = spawnSync(BASH, [WRAPPER, '--harness', 'codex'], {
    cwd: ROOT, encoding: 'utf8', env: cleanEnv(),
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: sub, tool_name: 'apply_patch', tool_input: { command: patch } }),
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /until the work is routed.*src\/new\/a\.js/);
});

test('edits outside the repo are not gated; relative paths resolve against the hook cwd', () => {
  const d = repo();
  assert.deepEqual(run({ dir: d, input: write(d, '../elsewhere.txt') }), SILENT);
  const rel = { ...write(d, 'x'), cwd: path.join(d, 'sandbox'), tool_input: { file_path: 'a.js' } };
  assert.deepEqual(run({ dir: d, input: rel }), SILENT);
  const out = { ...write(d, 'x'), cwd: d, tool_input: { file_path: 'src/../../out.js' } };
  assert.deepEqual(run({ dir: d, input: out }), SILENT);
});

test('garbage or empty stdin is not an edit, so it allows silently', () => {
  const d = repo();
  for (const input of ['not json', '']) assert.deepEqual(run({ dir: d, input }), SILENT);
});

test('fail-open: a broken Node module allows the edit with one stderr note', () => {
  const d = tmpDir();
  const broken = path.join(d, 'broken.js');
  fs.writeFileSync(broken, "process.stdout.write('{\"hookSpecificOutput\":'); require('./does-not-exist');\n");
  const gated = repo();
  for (const args of [[], ['--harness', 'codex']]) {
    const r = run({ dir: gated, args, input: write(gated, 'src/a.js'), env: { APLABS_WRITE_GATE_JS: broken } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^aplabs-hooks: write gate failed \(exit 1\), edit allowed\n$/);
  }
});

test('fail-open: node missing allows the edit', () => {
  const d = repo();
  const r = run({ dir: d, input: write(d, 'src/a.js'), env: { PATH: tmpDir() } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^aplabs-hooks: node not found/);
});

test('.claude/settings.json gates the four edit tools and SubagentStart, and is silent here', () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'SubagentStart']);
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  for (const event of ['PreToolUse', 'SubagentStart']) {
    const [hook] = hooks[event][0].hooks;
    assert.match(hook.command, /\$CLAUDE_PROJECT_DIR\/kit\/hooks\/write-gate\.sh/);
    // This repo has no profile, so the real command must allow silently.
    const r = spawnSync(BASH, ['-c', hook.command], {
      cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: ROOT },
      input: JSON.stringify({ hook_event_name: event, tool_name: 'Write', tool_input: { file_path: path.join(ROOT, 'x.js') }, cwd: ROOT }),
    });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  }
});

test('.codex/hooks.json runs the gate in Codex mode on PreToolUse, and is silent here', () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex/hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart']);
  const [hook] = hooks.PreToolUse[0].hooks;
  assert.match(hook.command, /f="\$r\/kit\/hooks\/write-gate\.sh".*exec bash "\$f" --harness codex$/);
  const r = spawnSync(BASH, ['-c', hook.command], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH },
    input: JSON.stringify({ cwd: ROOT, tool_name: 'apply_patch', tool_input: { command: '*** Add File: x.js\n' } }),
  });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});
