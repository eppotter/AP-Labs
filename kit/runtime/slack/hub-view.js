'use strict';

// Each hub's view (plan brightside-v0, D1, Story 16.1): what the code on one
// hub may reach, built once at boot from the hub file's sees. This file is
// the one seam: no module, archetype or button decides what a hub sees.
//
//   const views = createHubViews({ hubs, data, llm });
//   const view = views.forHub('brightside');
//   // { id, sees, data, llm, rules, knowledge }
//
//   data       the query runner (kit/runtime/data) when sees lists "data",
//              else null: a handler's ctx.data.run then rejects with "no data
//              source" and describe() says unavailable (hubs.js moduleData).
//   llm        the AI service bound to this hub (llm.forHub): the profile's
//              context reaches its prompt only when sees lists "context".
//              The service has no unbound call. null when there is no AI service.
//   rules      true when sees lists "rules" (readiness, Story 16.3).
//   knowledge  the hub's added-context store: null until Story 16.4.
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

// The hub's sees, checked: a frozen list. Throws, naming the hub, when it is
// missing or holds anything else.
function seesOf(hub) {
  const sees = hub && hub.sees;
  if (!Array.isArray(sees)) throw new TypeError(`add "sees" to ${nameOf(hub)}`);
  const bad = sees.find((s) => !HUB_SEES.includes(s));
  if (bad !== undefined) throw new TypeError(`${nameOf(hub)}: sees ${JSON.stringify(bad)} is not one of ${HUB_SEES.join(', ')}`);
  return Object.freeze([...new Set(sees)]);
}

function viewOf({ id, sees, data, llm }) {
  return Object.freeze({
    id,
    sees,
    data: sees.includes('data') ? data || null : null,
    llm,
    rules: sees.includes('rules'),
    knowledge: null,
  });
}

// The view of a hub that is not in the registry (a hand-made payload): it
// sees nothing.
const BLANK_VIEW = viewOf({ id: null, sees: Object.freeze([]), data: null, llm: null });

// hubs: the registry's hubs. data: the app's query runner, or null. llm: the
// AI service (kit/runtime/llm createLlm), or null. Each view is built once.
function createHubViews({ hubs, data = null, llm = null }) {
  const views = new Map();
  for (const hub of hubs || []) {
    const sees = seesOf(hub);
    views.set(hub.id, viewOf({
      id: hub.id, sees, data, llm: llm ? llm.forHub({ id: hub.id, sees: [...sees] }) : null,
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
  return Object.freeze({ ask: (args) => get().ask(args), structured: (args) => get().structured(args) });
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
  return problems;
}

module.exports = {
  createHubViews, everyHubSeesAll, bootProblems, seesOf, BLANK_VIEW, DATA_ARCHETYPES, ENGINE_JOB_NEEDS,
};
