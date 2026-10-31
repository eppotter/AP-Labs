'use strict';

// Plan hub-status-menu, Story 17.1 (D11): each tool's status
// (kit/runtime/registry/status toolStatus), one test per row of D11's
// table, worded through the vocabulary. Facts come from the fixture hubs in
// test/fixtures/runtime/status-menu (readiness and the summary) wherever the
// row depends on them.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry } = require('../../kit/runtime/registry');
const { readiness, createRulesReader } = require('../../kit/runtime/knowledge/readiness');
const { summarize } = require('../../kit/runtime/knowledge/summary');
const { toolStatus } = require('../../kit/runtime/registry/status');
const { statusText } = require('../../kit/runtime/registry/vocabulary');

const FIX = path.join(__dirname, '../fixtures/runtime/status-menu');
const PROFILE_PATH = path.join(FIX, 'profile.yml');
const profile = loadProfile(PROFILE_PATH);
const { registry } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });
const rules = createRulesReader({ profile, profilePath: PROFILE_PATH, readLast: () => null });
const mod = (id) => registry.module(id);
const hubOf = (id) => registry.hubs.find((h) => h.id === id);

const runner = (available) => ({ describe: () => ({ source: 'local fixture', label: 'tiny.duckdb', available }), run: async () => [] });

// The facts a hub gives: its readiness and summary, from a fixture hub.
function factsFor(hubId, {
  available = true, notes = 0, entriesProblem = false, llm = true, knowledge = true, requests = { available: true }, mapReady = true, unready = false, reader = rules,
} = {}) {
  const hub = hubOf(hubId);
  const view = {
    id: hub.id, sees: hub.sees, data: hub.sees.includes('data') ? runner(available) : null, rules: hub.sees.includes('rules'),
  };
  const ready = readiness(view, { rules: reader });
  const entries = Array.from({ length: notes }, (_, i) => ({ id: String(i) }));
  return {
    ready, summary: summarize({ ready, entries, entriesProblem, sees: hub.sees }), llm, knowledge, requests, mapReady, unready,
  };
}

const shown = (s) => (s ? statusText(s) : null);

test('ask: ready with data and rules; partly before them; waiting only for the AI, never for data', () => {
  assert.equal(shown(toolStatus(mod('full-ask'), factsFor('full'))), '✓ Ready');
  assert.equal(shown(toolStatus(mod('blank-ask'), factsFor('blank'))), '◐ Partly ready · nothing taught yet');
  assert.equal(shown(toolStatus(mod('blank-ask'), factsFor('blank', { notes: 2 }))), '◐ Partly ready · no data yet');
  // A hub that sees context has been taught even with no notes.
  assert.equal(shown(toolStatus(mod('onboarded-ask'), factsFor('onboarded'))), '◐ Partly ready · no data yet');
  // The full hub with its data off: partly, never waiting for data.
  assert.equal(shown(toolStatus(mod('full-ask'), factsFor('full', { available: false }))), '◐ Partly ready · no data yet');
  // Data connected, rules not set up.
  const noRules = { read: () => ({ ...rules.read(), truths: [] }) };
  assert.equal(shown(toolStatus(mod('full-ask'), factsFor('full', { reader: noRules }))), '◐ Partly ready · no rules yet');
  assert.equal(shown(toolStatus(mod('blank-ask'), factsFor('blank', { llm: false }))), '◌ Waiting · needs the AI');
  assert.equal(shown(toolStatus(mod('full-ask'), factsFor('full', { llm: false }))), '◌ Waiting · needs the AI');
});

test('add-context: done with N notes, not started with none, waiting with no store, no status when notes couldn\'t be listed', () => {
  assert.equal(shown(toolStatus(mod('blank-add'), factsFor('blank'))), '○ Not started · no notes yet');
  assert.equal(shown(toolStatus(mod('blank-add'), factsFor('blank', { notes: 1 }))), '✓ Done · 1 note');
  assert.equal(shown(toolStatus(mod('blank-add'), factsFor('blank', { notes: 3 }))), '✓ Done · 3 notes');
  assert.equal(shown(toolStatus(mod('blank-add'), factsFor('blank', { knowledge: false }))), '◌ Waiting · needs storage');
  assert.equal(toolStatus(mod('blank-add'), factsFor('blank', { entriesProblem: true })), null);
});

test('data-sources: on a hub that counts none of data, truths or rules, context only with notes, else done; otherwise by the counted steps', () => {
  assert.equal(shown(toolStatus(mod('blank-sources'), factsFor('blank'))), '✓ Done · no data on this hub');
  assert.equal(shown(toolStatus(mod('blank-sources'), factsFor('blank', { notes: 1 }))), '✓ Context only · 1 note');
  assert.equal(shown(toolStatus(mod('blank-sources'), factsFor('blank', { notes: 3 }))), '✓ Context only · 3 notes');
  assert.equal(shown(toolStatus(mod('blank-sources'), factsFor('blank', { entriesProblem: true }))), '✓ Done · no data on this hub');
  // A hub that counts data keeps its steps' wording, notes or not.
  assert.equal(shown(toolStatus(mod('first-sources'), factsFor('first-tool', { available: false, notes: 2 }))), '○ Not started · no data');
  // first-tool sees data only: one counted step.
  assert.equal(shown(toolStatus(mod('first-sources'), factsFor('first-tool'))), '✓ Done');
  assert.equal(shown(toolStatus(mod('first-sources'), factsFor('first-tool', { available: false }))), '○ Not started · no data');
  // full counts data, truths and rules.
  assert.equal(shown(toolStatus(mod('full-sources'), factsFor('full'))), '✓ Done');
  assert.equal(shown(toolStatus(mod('full-sources'), factsFor('full', { available: false }))), '◐ Partly ready · needs data');
  const none = { read: () => ({ ...rules.read(), truths: [], files: [] }) };
  assert.equal(shown(toolStatus(mod('full-sources'), factsFor('full', { available: false, reader: none }))), '○ Not started · no data, no rules');
  assert.equal(shown(toolStatus(mod('full-sources'), factsFor('full', { reader: none }))), '◐ Partly ready · needs truths, rules');
});

test('build-request: ready when available on the hub; else waiting for a channel or not on this hub, from its own check', () => {
  assert.equal(shown(toolStatus(mod('blank-request'), factsFor('blank'))), '✓ Ready');
  assert.equal(shown(toolStatus(mod('blank-request'), factsFor('blank', { requests: { available: false, reason: 'channel' } }))), '◌ Waiting · needs a channel');
  assert.equal(shown(toolStatus(mod('blank-request'), factsFor('blank', { requests: { available: false, reason: 'hub' } }))), '◌ Waiting · not on this hub');
  // No answer from the check is not ready (fail closed).
  assert.equal(shown(toolStatus(mod('blank-request'), factsFor('blank', { requests: null }))), '◌ Waiting · needs a channel');
});

test('scoped-pull and approval-write: ready when the hub\'s data is connected, else waiting for data', () => {
  assert.equal(shown(toolStatus(mod('first-pull'), factsFor('first-tool'))), '✓ Ready');
  assert.equal(shown(toolStatus(mod('first-pull'), factsFor('first-tool', { available: false }))), '◌ Waiting · needs data');
  const write = { ...mod('full-list-b'), archetype: 'approval-write' };
  assert.equal(shown(toolStatus(write, factsFor('full'))), '✓ Ready');
  assert.equal(shown(toolStatus(write, factsFor('full', { available: false }))), '◌ Waiting · needs data');
});

test('routing-map: ready with data, the map files ready and the module not unready; else waiting for data or map setup', () => {
  const map = {
    id: 'map', hub: 'full', label: 'Map', archetype: 'routing-map', environments: ['dev'],
  };
  assert.equal(shown(toolStatus(map, factsFor('full'))), '✓ Ready');
  assert.equal(shown(toolStatus(map, factsFor('full', { available: false }))), '◌ Waiting · needs data');
  assert.equal(shown(toolStatus(map, factsFor('full', { mapReady: false }))), '◌ Waiting · needs map setup');
  assert.equal(shown(toolStatus(map, factsFor('full', { unready: true }))), '◌ Waiting · needs map setup');
});

test('handler: ready, except a map module (the dev-only map check) while the map files aren\'t ready', () => {
  assert.equal(shown(toolStatus(mod('full-tool-a'), factsFor('full'))), '✓ Ready');
  assert.equal(shown(toolStatus(mod('full-tool-a'), factsFor('full', { available: false, mapReady: false }))), '✓ Ready');
  const mapCheck = {
    id: 'map-check', hub: 'full', label: 'Map check', archetype: 'handler', environments: ['dev'],
  };
  assert.equal(shown(toolStatus(mapCheck, factsFor('full', { mapReady: false }))), '◌ Waiting · needs map setup');
  assert.equal(shown(toolStatus(mapCheck, factsFor('full'))), '✓ Ready');
});

test('an unknown archetype is refused (throws); only handler is ready by default', () => {
  assert.throws(() => toolStatus({ id: 'x', archetype: 'mystery' }, factsFor('full')), TypeError);
  assert.throws(() => toolStatus({ id: 'x' }, factsFor('full')), TypeError);
  assert.throws(() => toolStatus(null, factsFor('full')), TypeError);
  assert.throws(() => toolStatus(mod('full-tool-a'), {}), TypeError);
  assert.equal(toolStatus({ id: 'x', archetype: 'handler' }, factsFor('full')).key, 'ready');
});

test('every status the table gives is one the vocabulary words', () => {
  for (const m of registry.modules) {
    for (const opts of [{}, { available: false }, { notes: 2 }, { llm: false, knowledge: false, mapReady: false }]) {
      const s = toolStatus(m, factsFor(m.hub, opts));
      if (s) assert.doesNotThrow(() => statusText(s), `${m.id} ${JSON.stringify(opts)}`);
    }
  }
});
