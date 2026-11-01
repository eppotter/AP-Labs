'use strict';

// Each hub's view (plan brightside-v0, D1, Story 16.1): what the code on one
// hub may reach, built once at boot from the hub file's sees. This file is
// the one seam: no module, archetype or button decides what a hub sees.
//
//   const views = createHubViews({ hubs, data, llm, knowledge });
//   const view = views.forHub('brightside');
//   // { id, sees, data, llm, rules, knowledge, notes, sharedWith }
//
//   data       the query runner (kit/runtime/data) when sees lists "data",
//              else null: a handler's ctx.data.run then rejects with "no data
//              source" and describe() says unavailable (hubs.js moduleData).
//   llm        the AI service bound to this hub (llm.forHub): the profile's
//              context reaches its prompt only when sees lists "context".
//              The service has no unbound call. null when there is no AI service.
//   rules      true when sees lists "rules" (readiness, Story 16.3).
//   knowledge  the added-context store bound to this hub (Story 16.4,
//              kit/runtime/knowledge/store forHub): add, list, remove and
//              forPrompt, for this hub's entries only. Every hub gets its
//              own, whatever sees says (D1, D4). null when there is no store.
//   notes      the id of the hub whose notes store this hub uses: its own id,
//              or the hub its file's "notes" names (below).
//   sharedWith the names of the other hubs that use the same notes, in file
//              order ([] for a hub whose notes are its own alone), for the
//              Add context and Data sources screens to say so.
//
// Shared notes (plan brightside-v1, D6, Story 19.1): a hub file may name
// another hub in "notes". Its knowledge store is then that hub's
// (knowledge.forHub(notes)) and its AI service reads the same entries
// (llm.forHub({ id, sees, notes })): one folder, one queue, one set of caps,
// so a note added or removed on either hub is added or removed on both.
// sees is unchanged: it alone decides what each hub gets from the profile,
// so a blank hub sharing notes with a full one still never gets the
// profile's context, data or rules. createHubViews throws on a link boot
// would refuse (fail closed); boot names each problem first (bootProblems).
//
// kit/runtime/app hands registerHubs (kit/runtime/slack/hubs) only forHub,
// never the app-wide runner or AI service. The hubs give each handler,
// archetype (a scoped pull, its reader, a routing map's adapter) and button
// listener on a hub only that hub's view. A hub with no sees list throws
// here, naming it (fail closed): the registry refuses such a hub file first.
//
// bootProblems({ hubs, modules, env }), run by app/index checkConfig. Boot
// refuses, each problem naming the module file and the hub:
//   - a scoped-pull, approval-write or routing-map module on a hub that does
//     not see data (a handler module there gets the null runner instead);
//   - an engine job a module brings in this environment (kit/runtime/jobs
//     engineJobsBroughtBy) when its hub's sees lacks data or context, naming
//     the job too. Fork jobs (<app>/jobs.json) belong to no hub: their ctx is
//     log, data, now and name only, never an AI service or a knowledge store
//     (Story 11.1).
// And, naming the hub file and its "notes" field (Story 19.1, D6):
//   - a notes link to no hub, to the hub itself, or to a hub that shares
//     another hub's notes (no chains, so no loops);
//   - ask, add-context or data-sources modules (in any environment) on the
//     hubs that share one set of notes with more than one resource key
//     between them, so the same people read, add and remove, and list the
//     shared notes (architect P3-15). A hub without one of them is fine.
//
// everyHubSeesAll({ data, llm }): registerHubs' test seam, for tests that
// hand it a runner and an AI service directly (as before Story 16.1). Every
// hub then sees everything, and the service is bound per hub when first
// called. Boot never uses it: app/index passes forHub only (a test pins it).

const { engineJobsBroughtBy } = require('../jobs');
const { HUB_SEES } = require('../sees');

// The archetypes that read data through the engine (a fixed SQL file, or the
// routing map's adapter): refused on a hub that does not see data.
const DATA_ARCHETYPES = Object.freeze(['scoped-pull', 'approval-write', 'routing-map']);
// What a hub must see for a module there to bring an engine job.
const ENGINE_JOB_NEEDS = Object.freeze(['data', 'context']);

const nameOf = (hub) => (hub && (hub.file || hub.id)) || 'a hub';
const hubFile = (hub) => hub.file || `hubs/${hub.id}.json`;
const moduleFile = (mod) => mod.file || `modules/${mod.id}/manifest.json`;
// The archetypes that reach a hub's notes, and what their key lets people
// do with them (Story 19.1, D6).
const NOTES_ARCHETYPES = Object.freeze({ ask: 'read', 'add-context': 'add and remove', 'data-sources': 'list' });

// The id of the hub whose notes a hub uses: its "notes" link, else its own.
const notesOf = (hub) => (typeof hub.notes === 'string' ? hub.notes : hub.id);

// A hub's notes link, checked against the other hubs (D6): problems naming
// the hub file and the field. A hub with no link has none.
function linkProblems(hubs) {
  const byId = new Map((hubs || []).map((h) => [h.id, h]));
  const problems = [];
  for (const hub of hubs || []) {
    if (hub.notes === undefined) continue;
    const file = hubFile(hub);
    const target = typeof hub.notes === 'string' ? byId.get(hub.notes) : undefined;
    if (typeof hub.notes !== 'string') problems.push(`${file}: field "notes" must be the id of another hub`);
    else if (hub.notes === hub.id) problems.push(`${file}: field "notes" names the hub itself (leave "notes" out for the hub's own notes)`);
    else if (!target) problems.push(`${file}: field "notes" names no hub ("${hub.notes}" has no hubs/${hub.notes}.json)`);
    else if (target.notes !== undefined) {
      problems.push(`${file}: field "notes" names ${target.id}, which shares another hub's notes itself (${hubFile(target)} field "notes"); name a hub that keeps its own notes (no chains)`);
    }
  }
  return problems;
}

// The hubs that share one set of notes: Map(store hub id -> [linking hub]),
// for well-formed links only (linkProblems names the rest).
function sharedGroups(hubs) {
  const byId = new Map((hubs || []).map((h) => [h.id, h]));
  const groups = new Map();
  for (const hub of hubs || []) {
    if (typeof hub.notes !== 'string' || hub.notes === hub.id) continue;
    const target = byId.get(hub.notes);
    if (!target || target.notes !== undefined) continue;
    if (!groups.has(target.id)) groups.set(target.id, []);
    groups.get(target.id).push(hub);
  }
  return groups;
}

// One resource key per notes archetype across the hubs that share notes
// (D6, architect P3-15). Each problem names the linking hub file, its field
// and every module with its key.
function sharedKeyProblems(hubs, modules) {
  const problems = [];
  for (const [store, linkers] of sharedGroups(hubs)) {
    const members = new Set([store, ...linkers.map((h) => h.id)]);
    for (const [archetype, verb] of Object.entries(NOTES_ARCHETYPES)) {
      const mods = (modules || []).filter((m) => m.archetype === archetype && members.has(m.hub));
      if (new Set(mods.map((m) => m.resource)).size <= 1) continue;
      const list = mods.map((m) => `${moduleFile(m)} "resource" ${m.resource}`).join(', ');
      for (const hub of linkers) {
        problems.push(`${hubFile(hub)}: field "notes" shares the notes of ${store}, but the ${archetype} modules on these hubs use different keys (${list}); give them one key, so the same people ${verb} the shared notes`);
      }
    }
  }
  return problems;
}

// The hub's sees, checked: a frozen list. Throws, naming the hub, when it is
// missing or holds anything else.
function seesOf(hub) {
  const sees = hub && hub.sees;
  if (!Array.isArray(sees)) throw new TypeError(`add "sees" to ${nameOf(hub)}`);
  const bad = sees.find((s) => !HUB_SEES.includes(s));
  if (bad !== undefined) throw new TypeError(`${nameOf(hub)}: sees ${JSON.stringify(bad)} is not one of ${HUB_SEES.join(', ')}`);
  return Object.freeze([...new Set(sees)]);
}

function viewOf({
  id, sees, data, llm, knowledge = null, notes = id, sharedWith = [],
}) {
  return Object.freeze({
    id,
    sees,
    data: sees.includes('data') ? data || null : null,
    llm,
    rules: sees.includes('rules'),
    knowledge,
    notes,
    sharedWith: Object.freeze([...sharedWith]),
  });
}

// The view of a hub that is not in the registry (a hand-made payload): it
// sees nothing.
const BLANK_VIEW = viewOf({ id: null, sees: Object.freeze([]), data: null, llm: null });

// hubs: the registry's hubs. data: the app's query runner, or null. llm: the
// AI service (kit/runtime/llm createLlm), or null. knowledge: the
// added-context store (kit/runtime/knowledge/store), or null. Each view is
// built once.
function createHubViews({
  hubs, data = null, llm = null, knowledge = null,
}) {
  // A notes link boot would refuse stops here too (fail closed).
  const bad = linkProblems(hubs);
  if (bad.length) throw new TypeError(bad[0]);
  const views = new Map();
  for (const hub of hubs || []) {
    const sees = seesOf(hub);
    const notes = notesOf(hub);
    const sharedWith = (hubs || []).filter((h) => h.id !== hub.id && notesOf(h) === notes).map((h) => h.name || h.id);
    const bind = { id: hub.id, sees: [...sees], ...(notes !== hub.id ? { notes } : {}) };
    views.set(hub.id, viewOf({
      id: hub.id,
      sees,
      data,
      llm: llm ? llm.forHub(bind) : null,
      knowledge: knowledge ? knowledge.forHub(notes) : null,
      notes,
      sharedWith,
    }));
  }
  return Object.freeze({
    forHub: (hubId) => {
      const view = views.get(hubId);
      if (!view) throw new TypeError(`no view for hub "${hubId}"`);
      return view;
    },
  });
}

// The service bound to a hub the first time it is called (the test seam:
// a stand-in service is never touched until something calls it).
function boundLater(llm, id, sees) {
  let bound = null;
  const get = () => {
    if (!bound) bound = llm.forHub({ id, sees: [...sees] });
    return bound;
  };
  return Object.freeze({ ask: (args) => get().ask(args), structured: (args) => get().structured(args), readFile: (args) => get().readFile(args) });
}

// registerHubs' test seam (see the header): every hub sees everything.
function everyHubSeesAll({ data = null, llm = null }) {
  const views = new Map();
  return Object.freeze({
    forHub: (hubId) => {
      if (!views.has(hubId)) {
        views.set(hubId, viewOf({
          id: hubId, sees: HUB_SEES, data, llm: llm ? boundLater(llm, hubId, HUB_SEES) : null,
        }));
      }
      return views.get(hubId);
    },
  });
}

// Every boot refusal, as text naming the module file and the hub (see the header).
function bootProblems({ hubs, modules, env }) {
  const problems = [];
  const byId = new Map((hubs || []).map((h) => [h.id, h]));
  for (const mod of modules || []) {
    const hub = byId.get(mod.hub);
    if (!hub) continue; // the registry has already refused it
    const sees = Array.isArray(hub.sees) ? hub.sees : [];
    const file = mod.file || `modules/${mod.id}/manifest.json`;
    if (DATA_ARCHETYPES.includes(mod.archetype) && !sees.includes('data')) {
      const a = /^[aeiou]/.test(mod.archetype) ? 'an' : 'a';
      problems.push(`${file}: ${a} ${mod.archetype} module reads data, but its hub ${nameOf(hub)} does not see data (add "data" to the hub's sees, or move the module)`);
    }
    const lacks = ENGINE_JOB_NEEDS.filter((s) => !sees.includes(s));
    if (!lacks.length) continue;
    for (const job of engineJobsBroughtBy(mod, env)) {
      problems.push(`${file}: module ${mod.id} brings the engine job "${job}", but its hub ${nameOf(hub)} does not see ${lacks.join(' or ')}`);
    }
  }
  problems.push(...linkProblems(hubs), ...sharedKeyProblems(hubs, modules));
  return problems;
}

module.exports = {
  createHubViews, everyHubSeesAll, bootProblems, seesOf, BLANK_VIEW, DATA_ARCHETYPES, ENGINE_JOB_NEEDS, NOTES_ARCHETYPES,
};
