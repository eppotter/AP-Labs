'use strict';

// Profile migrations (Story 11.6, Q18). When a template release raises the
// profile schema's `schema_version`, `npm run template:update` upgrades the
// fork's .aplabs/profile.yml by running every step here in order, from the
// fork's version to the template's, keeping the profile's comments.
//
//   STEPS[n]  upgrades a profile from version n to n + 1. It gets the parsed
//             YAML Document (the `yaml` package's, which keeps comments) and
//             changes it in place; the runner then sets schema_version to
//             n + 1. A step never reads files, env or the network.
//
// The schema is at version 1 today, so the list is empty. A test
// (test/unit/template-migrations.test.js) fails when the schema's
// schema_version has no chain of steps from 1, so a version bump must ship
// its step in the same release.

const YAML = require('yaml');

const STEPS = Object.freeze({});

/**
 * The schema_version a profile JSON Schema requires: its
 * properties.schema_version `const`, or the highest of its `enum`. null when
 * the schema names none.
 */
function schemaVersionOf(schema) {
  const sv = schema && schema.properties && schema.properties.schema_version;
  if (!sv || typeof sv !== 'object') return null;
  if (Number.isInteger(sv.const)) return sv.const;
  if (Array.isArray(sv.enum) && sv.enum.length && sv.enum.every(Number.isInteger)) return Math.max(...sv.enum);
  return null;
}

/**
 * The missing steps on the way from version 1 to target: a list of plain
 * reasons, empty when every step is there.
 */
function chainProblems(target, steps = STEPS) {
  if (!Number.isInteger(target) || target < 1) return [`the schema's schema_version is not a whole number from 1 (${target})`];
  const missing = [];
  for (let v = 1; v < target; v++) {
    if (typeof steps[v] !== 'function') missing.push(`no migration step from schema_version ${v} to ${v + 1}`);
  }
  return missing;
}

/**
 * Upgrades profile text from version `from` to version `to`, step by step.
 * Returns { text, applied: [n, ...] }: the text is unchanged (byte for byte)
 * when from equals to. Throws, naming the reason, when from is newer than to,
 * a step is missing, or the text is not YAML.
 */
function migrateProfile(text, { from, to, steps = STEPS }) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`schema versions must be whole numbers (from ${from} to ${to})`);
  if (from > to) throw new Error(`the profile's schema_version ${from} is newer than the template's ${to}`);
  if (from === to) return { text, applied: [] };
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`the profile is not valid YAML (${doc.errors[0].message.split('\n')[0]})`);
  const applied = [];
  for (let v = from; v < to; v++) {
    const step = steps[v];
    if (typeof step !== 'function') throw new Error(`no migration step from schema_version ${v} to ${v + 1}`);
    step(doc);
    doc.set('schema_version', v + 1);
    applied.push(v);
  }
  return { text: doc.toString(), applied };
}

module.exports = { STEPS, schemaVersionOf, chainProblems, migrateProfile };
