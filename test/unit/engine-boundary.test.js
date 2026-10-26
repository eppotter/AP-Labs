'use strict';

// The engine/fork boundary (AD-1, Story 6.5), as grep tests:
//   - app code (every app dir, and the module and connector templates) imports from kit/ only
//     through kit/runtime/sdk (as '#sdk' or a relative path to it);
//   - no engine file (kit/**, profiles/_schema/**) references examples/;
//   - the routing engine (kit/runtime/routing/**) requires only
//     kit/runtime/scoring, kit/runtime/errors and its own files, and its code
//     uses no clock, randomness, async or process state (AD-R1, Story 12.1).
// App dirs scanned: APLABS_APP_DIR when set, <repo>/app (a fork) and
// examples/*/app (template dev), plus kit/templates/module and
// kit/templates/connector always, so the check never passes by scanning nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ENGINE_PATHS, SDK_DIR, isEnginePath, listEngineFiles } = require('../../kit/runtime/paths');

const ROOT = path.resolve(__dirname, '../..');
const JS = /\.(c|m)?js$/;
const IMPORT = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)|\bimport\s*\(\s*(['"`])([^'"`]+)\3\s*\)|\bfrom\s*(['"])([^'"]+)\5|^\s*import\s+(['"])([^'"]+)\7/gm;
const EXAMPLES = /\bexamples\//;

const slash = (p) => p.split(path.sep).join('/');
const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);

function jsFiles(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'node_modules') continue;
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...jsFiles(abs));
    else if (d.isFile() && JS.test(d.name)) out.push(abs);
  }
  return out;
}

// Why one import specifier breaks the rule, or null. base: the app dir being
// scanned (imports inside it are always fine); root: the repo.
function badImport(spec, file, base, root) {
  if (spec.startsWith('#')) return spec === '#sdk' ? null : 'is not #sdk';
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const target = path.resolve(path.dirname(file), spec);
    if (inside(target, base)) return null;
    const rel = slash(path.relative(root, target));
    if (rel !== 'kit' && !rel.startsWith('kit/')) return null;
    return rel === SDK_DIR || rel.startsWith(`${SDK_DIR}/`) ? null : `reaches ${rel}`;
  }
  const m = /(?:^|\/)(kit\/.*)$/.exec(spec);
  if (!m) return null;
  return m[1] === SDK_DIR || m[1].startsWith(`${SDK_DIR}/`) ? null : `reaches ${m[1]}`;
}

// Every import under dir that reaches kit/ other than the SDK, as
// "<file>: imports '<spec>' (<why>)" with file relative to root.
function kitImportProblems(dir, root = ROOT) {
  const problems = [];
  for (const file of jsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[2] || m[4] || m[6] || m[8];
      const why = badImport(spec, file, dir, root);
      if (why) problems.push(`${slash(path.relative(root, file))}: imports '${spec}' (${why}; use '#sdk')`);
    }
  }
  return problems;
}

// Every engine file under root that references examples/.
function engineExampleRefs(root = ROOT) {
  return listEngineFiles(root).filter((rel) => EXAMPLES.test(fs.readFileSync(path.join(root, rel), 'utf8')));
}

// The routing engine's dependency rule (architecture-routing.md): each import
// in kit/runtime/routing/** must resolve inside it, to kit/runtime/scoring or
// to kit/runtime/errors. A package or node: built-in is outside too.
const ROUTING_DIR = 'kit/runtime/routing';
const ROUTING_ALLOWED = ['kit/runtime/scoring', 'kit/runtime/errors.js', ROUTING_DIR];
// AD-R1: no clock, randomness, async or process state in the engine's code.
const IMPURE = [/\bDate\b/, /\bMath\.random\b/, /\basync\b/, /\bawait\b/, /\bPromise\b/, /\bprocess\b/, /\bset(Timeout|Interval|Immediate)\b/];

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function routingProblems(root = ROOT) {
  const dir = path.join(root, ROUTING_DIR);
  const problems = [];
  for (const file of jsFiles(dir)) {
    const rel = slash(path.relative(root, file));
    const text = fs.readFileSync(file, 'utf8');
    if (EXAMPLES.test(text)) problems.push(`${rel}: names examples/`);
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[2] || m[4] || m[6] || m[8];
      let target = null;
      if (spec.startsWith('.')) {
        const abs = path.resolve(path.dirname(file), spec);
        target = slash(path.relative(root, abs));
        if (target === 'kit/runtime/errors') target = 'kit/runtime/errors.js';
      }
      const ok = target !== null && ROUTING_ALLOWED.some((a) => target === a || target.startsWith(`${a}/`));
      if (!ok) problems.push(`${rel}: requires '${spec}' (outside routing, scoring and errors)`);
    }
    const code = withoutComments(text);
    for (const re of IMPURE) if (re.test(code)) problems.push(`${rel}: uses ${re.source.replace(/\\b/g, '').replace(/\\/g, '')}`);
  }
  return problems;
}

function appDirs(root = ROOT, env = process.env) {
  const dirs = [path.join(root, 'kit/templates/module'), path.join(root, 'kit/templates/connector'), path.join(root, 'app')];
  if (env.APLABS_APP_DIR) dirs.push(env.APLABS_APP_DIR);
  const examples = path.join(root, 'examples');
  if (fs.existsSync(examples)) {
    for (const d of fs.readdirSync(examples)) dirs.push(path.join(examples, d, 'app'));
  }
  return [...new Set(dirs)].filter((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
}

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-boundary-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the identical-engine set is kit/** and profiles/_schema/** (AD-1)', () => {
  assert.deepEqual(ENGINE_PATHS, ['kit/**', 'profiles/_schema/**']);
  assert.ok(isEnginePath('kit/runtime/app/index.js'));
  assert.ok(isEnginePath('profiles/_schema/profile.schema.json'));
  for (const p of ['kitchen/x.js', 'profiles/acme/profile.yml', 'app/modules/x/handler.js', 'package.json']) {
    assert.equal(isEnginePath(p), false, p);
  }
  const files = listEngineFiles(ROOT);
  assert.ok(files.includes('kit/runtime/paths.js'));
  assert.ok(files.includes('profiles/_schema/profile.schema.json'));
  assert.ok(files.every(isEnginePath));
});

test('app code imports from kit/ only through kit/runtime/sdk', () => {
  const dirs = appDirs();
  assert.ok(dirs.some((d) => d.endsWith(path.join('kit', 'templates', 'module'))), 'the module template is always scanned');
  assert.ok(dirs.some((d) => d.endsWith(path.join('kit', 'templates', 'connector'))), 'the connector template is always scanned');
  const problems = dirs.flatMap((d) => kitImportProblems(d));
  assert.deepEqual(problems, []);
});

test('no engine file references examples/', () => {
  assert.deepEqual(engineExampleRefs(), []);
});

test('the import check catches a kit/ import other than the SDK, in every form', (t) => {
  const root = tmpDir(t);
  const app = path.join(root, 'app');
  const mod = path.join(app, 'modules', 'm');
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'ok.js'), [
    "require('#sdk');",
    "require('../../../kit/runtime/sdk');",
    "require('../../../kit/runtime/sdk/index.js');",
    "require('./helper');",
    "require('../../lib/shared');",
    "require('node:fs');",
    "require('yaml');",
  ].join('\n'));
  fs.writeFileSync(path.join(mod, 'bad.js'), [
    "const data = require('../../../kit/runtime/data');",
    "import x from '../../../kit/lib/secrets/index.js';",
    "const y = await import(`../../../kit/runtime/log`);",
    "require('ap-labs/kit/lib/profile');",
    "require('#engine');",
  ].join('\n'));
  assert.deepEqual(kitImportProblems(app, root), [
    "app/modules/m/bad.js: imports '../../../kit/runtime/data' (reaches kit/runtime/data; use '#sdk')",
    "app/modules/m/bad.js: imports '../../../kit/lib/secrets/index.js' (reaches kit/lib/secrets/index.js; use '#sdk')",
    "app/modules/m/bad.js: imports '../../../kit/runtime/log' (reaches kit/runtime/log; use '#sdk')",
    "app/modules/m/bad.js: imports 'ap-labs/kit/lib/profile' (reaches kit/lib/profile; use '#sdk')",
    "app/modules/m/bad.js: imports '#engine' (is not #sdk; use '#sdk')",
  ]);
});

test('the engine check catches an engine file that references examples/', (t) => {
  const root = tmpDir(t);
  fs.mkdirSync(path.join(root, 'kit/runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, 'profiles/_schema'), { recursive: true });
  fs.mkdirSync(path.join(root, 'profiles/acme'), { recursive: true });
  fs.writeFileSync(path.join(root, 'kit/runtime/ok.js'), '// worked examples are fine; a path is not\n');
  fs.writeFileSync(path.join(root, 'kit/runtime/bad.js'), "const APP = 'examples/acme/app';\n");
  fs.writeFileSync(path.join(root, 'profiles/_schema/s.json'), '{"$comment": "see examples/acme"}\n');
  fs.writeFileSync(path.join(root, 'profiles/acme/profile.yml'), '# examples/acme is fine here: not engine\n');
  assert.deepEqual(engineExampleRefs(root), ['kit/runtime/bad.js', 'profiles/_schema/s.json']);
});

test('the routing engine requires only scoring, errors and its own files, and is pure (AD-R1)', () => {
  assert.ok(jsFiles(path.join(ROOT, ROUTING_DIR)).length >= 3, 'the routing engine is scanned');
  assert.deepEqual(routingProblems(), []);
});

test('the routing check catches a require outside the rule, a name of examples/ and impure code', (t) => {
  const root = tmpDir(t);
  const dir = path.join(root, ROUTING_DIR);
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ok.js'), [
    "require('./sub/x');",
    "require('../scoring');",
    "require('../scoring/index.js');",
    "require('../errors');",
    "require('../errors.js');",
    '// a comment may say Date.now, async or process.env',
    '/* or Math.random() here */',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'sub', 'x.js'), "require('../../routing/ok');\n");
  fs.writeFileSync(path.join(dir, 'bad.js'), [
    "require('../data');",
    "require('../routing-map');",
    "require('../slack/modal');",
    "require('node:fs');",
    "require('yaml');",
    "require('#sdk');",
    "const APP = 'examples/acme/app';",
    'const t = Date.now();',
    'const r = Math.random();',
    'async function f() { await g(); }',
    'const e = process.env.X;',
  ].join('\n'));
  assert.deepEqual(routingProblems(root), [
    'kit/runtime/routing/bad.js: names examples/',
    "kit/runtime/routing/bad.js: requires '../data' (outside routing, scoring and errors)",
    "kit/runtime/routing/bad.js: requires '../routing-map' (outside routing, scoring and errors)",
    "kit/runtime/routing/bad.js: requires '../slack/modal' (outside routing, scoring and errors)",
    "kit/runtime/routing/bad.js: requires 'node:fs' (outside routing, scoring and errors)",
    "kit/runtime/routing/bad.js: requires 'yaml' (outside routing, scoring and errors)",
    "kit/runtime/routing/bad.js: requires '#sdk' (outside routing, scoring and errors)",
    'kit/runtime/routing/bad.js: uses Date',
    'kit/runtime/routing/bad.js: uses Math.random',
    'kit/runtime/routing/bad.js: uses async',
    'kit/runtime/routing/bad.js: uses await',
    'kit/runtime/routing/bad.js: uses process',
  ]);
});
