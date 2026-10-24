'use strict';

// Add-on stages (Story 2.6). Every build runs the 8 core stages in order
// (docs/orchestrator/DESIGN.md §3a). A profile may switch on add-ons under
// stages.addons; each slots between two core stages and never removes or
// reorders one. Pure: no I/O.
//
// The add-on ids are also the enum for stages.addons in
// profiles/_schema/profile.schema.json; test/unit/stages.test.js fails if the
// two lists drift apart, or if an add-on names a core stage that does not exist.

const { ProfileError } = require('../profile');

const CORE = Object.freeze(['Intake', 'Spec', 'Plan approval', 'Build', 'Verify', 'Review', 'Ship', 'Retro']);

// Each add-on runs right after the named core stage. Add-ons sharing a slot run
// in the order listed here, whatever order the profile lists them in.
const ADDONS = Object.freeze([
  Object.freeze({ id: 'review_queue', name: 'Batch review queue', after: 'Review' }),
  Object.freeze({ id: 'dev_test', name: 'Dev environment test', after: 'Review' }),
  Object.freeze({ id: 'dark_launch', name: 'Dark launch + flag flip', after: 'Ship' }),
]);

const coreId = (name) => name.toLowerCase().replace(/\s+/g, '_');

// Returns the ordered stage list for a loaded profile: [{ id, name, core }].
// A profile without stages (or with no add-ons) gets the 8 core stages. An
// unknown add-on (the schema should have caught it) is a ProfileError, so the
// session banner reports an invalid profile instead of dropping it.
function resolveStages(profile) {
  const on = new Set((profile && profile.stages && profile.stages.addons) || []);
  const unknown = [...on].filter((id) => !ADDONS.some((a) => a.id === id));
  if (unknown.length) throw new ProfileError(`unknown add-on stage(s): ${unknown.join(', ')}`);
  const out = [];
  for (const name of CORE) {
    out.push(Object.freeze({ id: coreId(name), name, core: true }));
    for (const a of ADDONS) {
      if (a.after === name && on.has(a.id)) out.push(Object.freeze({ id: a.id, name: a.name, core: false }));
    }
  }
  return Object.freeze(out);
}

module.exports = { CORE, ADDONS, resolveStages };
