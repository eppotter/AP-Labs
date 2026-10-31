'use strict';

// Each tool's status on the hub menu (plan hub-status-menu, D11, Story
// 17.1). Pure: toolStatus(mod, facts) -> { key, detail } (detail a short
// text or null), worded by kit/runtime/registry/vocabulary statusText. A
// manifest never says its own status: it is computed here, from what the hub
// already knows, which the slash command gathers (Story 17.2).
//
// facts:
//   ready      readiness() for the hub (kit/runtime/knowledge/readiness)
//   summary    summarize() for the hub (kit/runtime/knowledge/summary)
//   llm        true when the hub has an AI service (view.llm)
//   knowledge  true when the hub has a knowledge store (view.knowledge)
//   requests   build request's own check for this hub (architect P3-13):
//              { available: true } or { available: false, reason:
//              "channel" | "hub" }
//   mapReady   the map files are ready (mapFiles.ready())
//   unready    this routing-map module can't open yet
//              (routingMapOf(hub).unready(mod))
//
// D11's table:
//   ask              ready with data and rules; waiting · needs the AI with
//                    no AI service; else partly (· nothing taught yet, · no
//                    data yet, or · no rules yet). Never waiting for data:
//                    Ask works without it.
//   add-context      done · N notes; not-started · no notes yet; waiting ·
//                    needs storage with no knowledge store; null (no status
//                    line) when the notes couldn't be listed.
//   data-sources     of the counted steps data, truths and rules: done when
//                    all are; not-started when none is; else partly · needs
//                    <what>. A hub that counts none (its sees leaves out
//                    data and rules): context-only · no data on this hub
//                    when it has notes (the menu says "notes only · no data
//                    on this hub", subtle health); else done · no data on
//                    this hub (no notes, or they couldn't be listed).
//   build-request    ready when requests.available; else waiting · needs a
//                    channel or waiting · not on this hub.
//   scoped-pull,     ready when the hub's data is connected; else waiting ·
//   approval-write   needs data.
//   routing-map      ready when data is connected, the map files are ready
//                    and the module is not unready; else waiting · needs data
//                    or waiting · needs map setup.
//   handler          ready, except a map module (uploadsMapImages: the
//                    dev-only map check) while the map files aren't ready:
//                    waiting · needs map setup (architect P2-9), as the
//                    dispatcher refuses it then.
// Any other archetype throws: the menu's guard shows that row with its verb
// and no status line (D1).

const { uploadsMapImages } = require('../slack/image');

const status = (key, detail = null) => Object.freeze({ key, detail });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const stepOf = (summary, name) => ((summary && Array.isArray(summary.steps)) ? summary.steps.find((s) => s.step === name) : null) || { counted: false, done: false };

function needsMapSetup(mod, facts) {
  return uploadsMapImages(mod) && facts.mapReady !== true;
}

function askStatus(facts) {
  const { ready, summary } = facts;
  if (facts.llm !== true) return status('waiting', 'needs the AI');
  if (ready.data === true && ready.rules === true) return status('ready');
  const taught = stepOf(summary, 'taught');
  if (!taught.done && summary && summary.counts && summary.counts.notes === 0) return status('partly', 'nothing taught yet');
  if (ready.data === true) return status('partly', 'no rules yet');
  return status('partly', 'no data yet');
}

function addContextStatus(facts) {
  if (facts.knowledge !== true) return status('waiting', 'needs storage');
  const notes = facts.summary && facts.summary.counts ? facts.summary.counts.notes : null;
  if (!Number.isSafeInteger(notes) || notes < 0) return null;
  if (notes === 0) return status('not-started', 'no notes yet');
  return status('done', plural(notes, 'note', 'notes'));
}

function dataSourcesStatus(facts) {
  const names = { data: 'data', truths: 'truths', rules: 'rules' };
  const steps = Object.keys(names).map((name) => ({ name, ...stepOf(facts.summary, name) })).filter((s) => s.counted);
  if (!steps.length) {
    const notes = facts.summary && facts.summary.counts ? facts.summary.counts.notes : null;
    if (Number.isSafeInteger(notes) && notes > 0) return status('context-only', 'no data on this hub');
    return status('done', 'no data on this hub');
  }
  const missing = steps.filter((s) => !s.done);
  if (!missing.length) return status('done');
  if (missing.length === steps.length) {
    const what = [];
    if (missing.some((s) => s.name === 'data')) what.push('no data');
    if (missing.some((s) => s.name !== 'data')) what.push('no rules');
    return status('not-started', what.join(', '));
  }
  return status('partly', `needs ${missing.map((s) => names[s.name]).join(', ')}`);
}

function buildRequestStatus(facts) {
  const r = facts.requests;
  if (r && r.available === true) return status('ready');
  if (r && r.reason === 'hub') return status('waiting', 'not on this hub');
  return status('waiting', 'needs a channel');
}

function toolStatus(mod, facts = {}) {
  if (!mod || typeof mod !== 'object') throw new TypeError('toolStatus needs a module');
  if (!facts || !facts.ready) throw new TypeError('toolStatus needs the hub\'s readiness');
  const dataReady = facts.ready.data === true;
  switch (mod.archetype) {
    case 'ask': return askStatus(facts);
    case 'add-context': return addContextStatus(facts);
    case 'data-sources': return dataSourcesStatus(facts);
    case 'build-request': return buildRequestStatus(facts);
    case 'scoped-pull':
    case 'approval-write':
      return dataReady ? status('ready') : status('waiting', 'needs data');
    case 'routing-map':
      if (!dataReady) return status('waiting', 'needs data');
      if (needsMapSetup(mod, facts) || facts.unready === true) return status('waiting', 'needs map setup');
      return status('ready');
    case 'handler':
      return needsMapSetup(mod, facts) ? status('waiting', 'needs map setup') : status('ready');
    default:
      throw new TypeError(`no status for archetype ${String(mod.archetype)}`);
  }
}

module.exports = { toolStatus };
