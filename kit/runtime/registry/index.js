'use strict';

// Discovers hubs and modules by directory scan (AD-3) and validates them
// (AD-4). Nothing else registers a module; there is no hub-specific code.
//
//   <app>/hubs/<id>.json                  one hub: a slash command
//   <app>/modules/<id>/manifest.json      one module: an entry on a hub's menu
//   <app>/modules/<id>/<handler>.js       its handler (archetype "handler")
//   <app>/modules/<id>/<query>.sql        its SQL template (archetype "scoped-pull")
//
// Both are read sorted by file name, so menu order is folder order. Every
// problem is collected and returned at once, each naming the file (relative
// to the app dir) and the field, so boot can refuse listing all of them.
//
// A module's resource must be declared in the profile: an undeclared key is a
// configuration fault, never a denial. Who may use it is decided per person at
// runtime (kit/runtime/access, Story 6.3).
//
// Declared parameters (Story 9.3): every module's parameters are checked
// beyond the schema (kit/runtime/archetypes/scoped-pull/params): each input
// bounded, each range possible, each default valid. A problem names the
// module file and the input. A scoped-pull module has no handler: the engine
// runs its form; its SQL file must exist and is read once at boot.
//
// Story 9.5: each scoped pull's SQL is checked at boot without connecting to
// the data (kit/runtime/archetypes/scoped-pull/run checkQuery): the SQL
// checker with the profile's forbidden columns, no "${", and every $name in
// the SQL matched to a declared input both ways. A problem stops startup,
// naming the module file.
//
// Story 10.1: a module's scoring declaration is checked
// (kit/runtime/scoring checkScoring: each range min < max, not every weight
// 0, the limit input declared), and a scored module's SQL must name its
// inputs and row id, never its limit input, and end with ORDER BY ...,
// <row id> LIMIT 5001 (checkQuery).
//
// Story 10.2: approval-write is accepted. Its module is a scoped pull (the
// same form, SQL file and checks) plus a write block, which this file never
// reads: the archetype checks it (kit/runtime/archetypes/approval-write
// checkModule: an admin_grantable: false resource, row_id in write.fields,
// write.fields the query returns, write.send and write.list_name, and,
// through approval-write/connectors.js, that the connector loads and
// declares write.operation). Each refusal names the module file and field.
//
// Story 15.4: routing-map is accepted (kit/runtime/archetypes/routing-map).
// Its manifest names an adapter file in the module's folder, which must load
// and export createAdapter (a function); it has no handler, query,
// parameters, scoring or row_id. The profile must have a routing block with
// an audience (AD-R17), and the module's resource must be that audience's
// all_crews key: who may open it is decided by the audience (all_crews, or
// own_crew with a crew_leads row), never by the resource alone.

const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const { checkDeclarations } = require('../archetypes/scoped-pull/params');
const { checkQuery } = require('../archetypes/scoped-pull/run');
const { checkScoring } = require('../scoring');
const approvalWrite = require('../archetypes/approval-write');
const { forbiddenColumnsOf } = require('../sql');

const SCHEMA_DIR = path.join(__dirname, '../schema');
// Archetypes whose engine code exists (every archetype the schema names).
const BUILT_ARCHETYPES = new Set(['handler', 'scoped-pull', 'approval-write', 'routing-map']);
// The archetypes the engine runs from a fixed SQL file and a typed form.
const QUERY_ARCHETYPES = new Set(['scoped-pull', 'approval-write']);
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

// " (input "zone")" for an error inside parameters[i], so a problem names the
// input as well as its position.
function inputNote(instancePath, data) {
  const m = /^\/parameters\/(\d+)(\/|$)/.exec(instancePath);
  const p = m && data && Array.isArray(data.parameters) ? data.parameters[Number(m[1])] : null;
  return p && typeof p.name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(p.name) ? ` (input "${p.name}")` : '';
}

function schemaProblems(validate, data, file) {
  if (validate(data)) return [];
  return validate.errors
    .filter((e) => e.keyword !== 'if')
    .map((e) => {
      const note = inputNote(e.instancePath, data);
      if (e.keyword === 'additionalProperties') return `${file}: unknown field "${fieldName(e.instancePath, e.params.additionalProperty)}"${note}`;
      if (e.keyword === 'required') return `${file}: field "${fieldName(e.instancePath, e.params.missingProperty)}" is required${note}`;
      // The only false schema: a write block outside approval-write (AD-15).
      if (e.keyword === 'false schema' && e.instancePath === '/write') return `${file}: field "write" is used only by an approval-write module (writes go through that archetype)`;
      if (e.keyword === 'false schema' && e.instancePath === '/adapter') return `${file}: field "adapter" is used only by a routing-map module`;
      const field = fieldName(e.instancePath);
      return field ? `${file}: field "${field}"${note} ${e.message}` : `${file}: ${e.message}`;
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

// A routing-map module's adapter file: it must load and export createAdapter.
function loadAdapter(abs, file, problems) {
  if (!fs.existsSync(abs)) {
    problems.push(`${file}: field "adapter" names a file that does not exist`);
    return undefined;
  }
  let mod;
  try {
    mod = require(abs);
  } catch (e) {
    problems.push(`${file}: field "adapter" could not be loaded (${e.message})`);
    return undefined;
  }
  if (!mod || typeof mod.createAdapter !== 'function') {
    problems.push(`${file}: field "adapter" must export createAdapter (module.exports = { createAdapter })`);
    return undefined;
  }
  return mod.createAdapter;
}

// What a routing-map manifest may not hold, and what the profile must.
const NOT_ROUTING_MAP = Object.freeze(['handler', 'query', 'parameters', 'scoring', 'row_id']);
function routingMapProblems(m, file, profile) {
  const problems = [];
  for (const key of NOT_ROUTING_MAP) {
    if (m[key] !== undefined) problems.push(`${file}: field "${key}" is not used by a routing-map module (the engine draws its map)`);
  }
  const audience = profile && profile.routing && profile.routing.audience;
  if (!audience) {
    problems.push(`${file}: field "archetype" routing-map needs routing.audience in the profile (who sees which crews)`);
  } else if (m.resource !== audience.all_crews) {
    problems.push(`${file}: field "resource" must be the profile's routing.audience.all_crews key (${audience.all_crews})`);
  }
  return problems;
}

// A scoped-pull's SQL template, read once, then checked (checkQuery).
function loadQuery(abs, file, problems) {
  try {
    const sql = fs.readFileSync(abs, 'utf8');
    if (sql.trim()) return sql;
    problems.push(`${file}: field "query" names an empty file`);
  } catch (e) {
    problems.push(`${file}: field "query" names a file that ${e.code === 'ENOENT' ? 'does not exist' : 'cannot be read'}`);
  }
  return undefined;
}

// Reads and validates <app>/modules/*/manifest.json against the hubs and the
// profile. Returns { modules, problems }.
function loadModules(appDir, { hubs, profile, failedHubs = new Set() }) {
  const problems = [];
  const modules = [];
  const hubIds = new Set(hubs.map((h) => h.id));
  const resources = new Set(((profile && profile.resources) || []).map((r) => r.key));
  const forbiddenColumns = forbiddenColumnsOf(profile);
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
    if (!resources.has(m.resource)) {
      problems.push(`${file}: field "resource" ${m.resource} is not declared in the profile (configuration fault)`);
    }
    if (!BUILT_ARCHETYPES.has(m.archetype)) {
      problems.push(`${file}: field "archetype" "${m.archetype}" is not available yet`);
    }
    for (const p of checkDeclarations(m.parameters)) problems.push(`${file}: ${p}`);
    for (const p of checkScoring(m)) problems.push(`${file}: ${p}`);
    if (QUERY_ARCHETYPES.has(m.archetype) && m.handler !== undefined) {
      problems.push(`${file}: field "handler" is not used by ${m.archetype === 'approval-write' ? 'an' : 'a'} ${m.archetype} module (the engine runs its form)`);
    }
    if (m.archetype === 'routing-map') problems.push(...routingMapProblems(m, file, profile));
    if (problems.length > before) continue;
    if (m.archetype === 'routing-map') {
      const createAdapter = loadAdapter(path.join(appDir, 'modules', folder, m.adapter), file, problems);
      if (createAdapter) modules.push(Object.freeze({ ...m, file, createAdapter }));
      continue;
    }
    if (QUERY_ARCHETYPES.has(m.archetype)) {
      const sql = loadQuery(path.join(appDir, 'modules', folder, m.query), file, problems);
      if (sql === undefined) continue;
      const sqlProblems = checkQuery(sql, m.parameters || [], { forbiddenColumns, scoring: m.scoring || null, rowId: m.row_id || null });
      if (sqlProblems.length) {
        problems.push(...sqlProblems.map((p) => `${file}: field "query" (${m.query}) ${p}`));
        continue;
      }
      const writeProblems = approvalWrite.checkModule(m, { appDir, profile, sql });
      if (writeProblems.length) {
        problems.push(...writeProblems.map((p) => `${file}: ${p}`));
        continue;
      }
      modules.push(Object.freeze({ ...m, file, sql }));
      continue;
    }
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

module.exports = {
  loadRegistry, loadHubs, loadModules, createRegistry, isVisible, ENV_PATTERN, QUERY_ARCHETYPES,
};
