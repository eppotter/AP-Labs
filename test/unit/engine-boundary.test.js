'use strict';

// The engine/fork boundary (AD-1, Story 6.5), as grep tests:
//   - app code (every app dir, and the module template) imports from kit/ only
//     through kit/runtime/sdk (as '#sdk' or a relative path to it);
//   - no engine file (kit/**, profiles/_schema/**) references examples/.
// App dirs scanned: APLABS_APP_DIR when set, <repo>/app (a fork) and
// examples/*/app (template dev), plus kit/templates/module always, so the
// check never passes by scanning nothing.

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

function appDirs(root = ROOT, env = process.env) {
  const dirs = [path.join(root, 'kit/templates/module'), path.join(root, 'app')];
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
