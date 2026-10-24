'use strict';

// Discovers hubs and modules by directory scan (AD-3) and validates them
// (AD-4). Nothing else registers a module; there is no hub-specific code.
//
//   <app>/hubs/<id>.json                  one hub: a slash command
//   <app>/modules/<id>/manifest.json      one module: an entry on a hub's menu
//   <app>/modules/<id>/<handler>.js       its handler (archetype "handler")
//
// Both are read sorted by file name, so menu order is folder order. Every
// problem is collected and returned at once, each naming the file (relative
// to the app dir) and the field, so boot can refuse listing all of them.
//
// Until access wiring lands (Story 6.3), a module can only be registered on a
// resource the profile declares open_access. A resource the profile does not
// declare is a configuration fault, never a denial.

const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');

const SCHEMA_DIR = path.join(__dirname, '../schema');
// Archetypes whose engine code exists. The others are valid in a manifest but
// refused at boot until their stories land (7.x scoped-pull, 10.x approval-write).
const BUILT_ARCHETYPES = new Set(['handler']);
const ENV_PATTERN = /^[a-z][a-z0-9-]*$/;

let _validators = null;
function validators() {
  if (!_validators) {
    // strictRequired off: the archetype if/then blocks require fields declared
    // in the parent schema, which strict mode cannot see.
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    const load = (name) => ajv.compile(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8')));
    _validators = { hub: load('hub.schema.json'), module: load('module.schema.json') };
  }
  return _validators;
}

// "/environments/0" → "environments[0]".
function fieldName(instancePath, extra) {
  const parts = instancePath.split('/').slice(1);
  if (extra !== undefined) parts.push(extra);
  return parts.reduce((acc, p) => (/^\d+$/.test(p) ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p), '');
}

function schemaProblems(validate, data, file) {
  if (validate(data)) return [];
  return validate.errors
    .filter((e) => e.keyword !== 'if')
    .map((e) => {
      if (e.keyword === 'additionalProperties') return `${file}: unknown field "${fieldName(e.instancePath, e.params.additionalProperty)}"`;
      if (e.keyword === 'required') return `${file}: field "${fieldName(e.instancePath, e.params.missingProperty)}" is required`;
      const field = fieldName(e.instancePath);
      return field ? `${file}: field "${field}" ${e.message}` : `${file}: ${e.message}`;
    });
}

function readJson(abs, file, problems) {
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    problems.push(`${file}: cannot be read (${e.code || e.message})`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    problems.push(`${file}: is not valid JSON (${e.message})`);
    return undefined;
  }
}

function listSorted(dir, keep) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(keep).map((d) => d.name).sort();
}

// Reads and validates <app>/hubs/*.json. Returns { hubs, problems, failed }:
// failed holds the file stems of hub files that did not load, so a module
// naming one is not reported a second time.
function loadHubs(appDir) {
  const problems = [];
  const hubs = [];
  const failed = new Set();
  const commands = new Map();
  const names = listSorted(path.join(appDir, 'hubs'), (d) => d.isFile() && d.name.endsWith('.json'));
  for (const name of names) {
    const file = `hubs/${name}`;
    const before = problems.length;
    const hub = loadHub(appDir, file, name, commands, problems);
    if (problems.length > before) failed.add(name.slice(0, -'.json'.length));
    if (hub) hubs.push(hub);
  }
  return { hubs, problems, failed };
}

// One hub file. Returns the frozen hub, or undefined after recording why.
function loadHub(appDir, file, name, commands, problems) {
  const stem = name.slice(0, -'.json'.length);
  const hub = readJson(path.join(appDir, file), file, problems);
  if (hub === undefined) return undefined;
  const errs = schemaProblems(validators().hub, hub, file);
  if (errs.length) {
    problems.push(...errs);
    return undefined;
  }
  if (hub.id !== stem) {
    problems.push(`${file}: field "id" must equal the file name ("${stem}")`);
    return undefined;
  }
  if (commands.has(hub.command)) {
    problems.push(`${file}: field "command" ${hub.command} is already used by ${commands.get(hub.command)}`);
    return undefined;
  }
  commands.set(hub.command, file);
  return Object.freeze({ ...hub, file });
}

function loadHandler(abs, file, problems) {
  if (!fs.existsSync(abs)) {
    problems.push(`${file}: field "handler" names a file that does not exist`);
    return undefined;
  }
  let run;
  try {
    run = require(abs);
  } catch (e) {
    problems.push(`${file}: field "handler" could not be loaded (${e.message})`);
    return undefined;
  }
  if (typeof run !== 'function') {
    problems.push(`${file}: field "handler" must export one function (module.exports = async (ctx) => ...)`);
    return undefined;
  }
  return run;
}

// Reads and validates <app>/modules/*/manifest.json against the hubs and the
// profile. Returns { modules, problems }.
function loadModules(appDir, { hubs, profile, failedHubs = new Set() }) {
  const problems = [];
  const modules = [];
  const hubIds = new Set(hubs.map((h) => h.id));
  const resources = new Map(((profile && profile.resources) || []).map((r) => [r.key, r]));
  const folders = listSorted(path.join(appDir, 'modules'), (d) => d.isDirectory());
  for (const folder of folders) {
    const file = `modules/${folder}/manifest.json`;
    const abs = path.join(appDir, file);
    if (!fs.existsSync(abs)) {
      problems.push(`modules/${folder}: has no manifest.json`);
      continue;
    }
    const m = readJson(abs, file, problems);
    if (m === undefined) continue;
    const errs = schemaProblems(validators().module, m, file);
    if (errs.length) {
      problems.push(...errs);
      continue;
    }
    const before = problems.length;
    if (m.id !== folder) problems.push(`${file}: field "id" must equal the folder name ("${folder}")`);
    if (failedHubs.has(m.hub)) problems.push(`${file}: field "hub" names hubs/${m.hub}.json, which did not load (see above)`);
    else if (!hubIds.has(m.hub)) problems.push(`${file}: field "hub" names no hub ("${m.hub}" has no hubs/${m.hub}.json)`);
    const resource = resources.get(m.resource);
    if (!resource) {
      problems.push(`${file}: field "resource" ${m.resource} is not declared in the profile (configuration fault)`);
    } else if (!resource.open_access) {
      problems.push(`${file}: field "resource" ${m.resource} is not open_access; until access wiring lands only open-access modules can be registered`);
    }
    if (!BUILT_ARCHETYPES.has(m.archetype)) {
      problems.push(`${file}: field "archetype" "${m.archetype}" is not available yet`);
    }
    if (problems.length > before) continue;
    const run = loadHandler(path.join(appDir, 'modules', folder, m.handler), file, problems);
    if (!run) continue;
    modules.push(Object.freeze({ ...m, file, run }));
  }
  return { modules, problems };
}

// The registry: hubs in file order, modules in folder order.
function createRegistry({ hubs, modules }) {
  const byCommand = new Map(hubs.map((h) => [h.command, h]));
  const byId = new Map(modules.map((m) => [m.id, m]));
  return Object.freeze({
    hubs,
    modules,
    hubByCommand: (command) => byCommand.get(command),
    module: (id) => (typeof id === 'string' ? byId.get(id) : undefined),
    // A hub's entries, in folder order, including hidden ones.
    entries: (hubId) => modules.filter((m) => m.hub === hubId),
  });
}

// Loads everything under appDir. Returns { registry, problems }; registry is
// null when there is any problem.
function loadRegistry({ appDir, profile }) {
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    return { registry: null, problems: ['the app dir does not exist (set APLABS_APP_DIR to an absolute path)'] };
  }
  const h = loadHubs(appDir);
  const m = loadModules(appDir, { hubs: h.hubs, profile, failedHubs: h.failed });
  const problems = [...h.problems, ...m.problems];
  return { registry: problems.length ? null : createRegistry({ hubs: h.hubs, modules: m.modules }), problems };
}

// An entry shows (and dispatches) only in the environments it names.
function isVisible(entry, env) {
  return entry.environments.includes(env);
}

module.exports = { loadRegistry, loadHubs, loadModules, createRegistry, isVisible, ENV_PATTERN };
