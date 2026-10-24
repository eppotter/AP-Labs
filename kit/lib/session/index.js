'use strict';

// Session start (Story 2.1): the pure half. Decides whether a repo is
// governed and builds the banner the SessionStart hook emits. The Node entry
// in kit/hooks/session-start.js only reads the hook input and prints.
//
// A repo is GOVERNED iff it has .aplabs/profile.yml (found the way every other
// kit module finds it: APLABS_PROFILE, else walk up from the start directory).
// Ungoverned repos get no output at all.

const path = require('path');
const { loadProfile, findProfilePath, ProfileError } = require('../profile');

const NAME = 'AP Labs Orchestrator';

// The 8 core stages, in order (docs/orchestrator/DESIGN.md §3a).
const STAGES = Object.freeze(['Intake', 'Spec', 'Plan approval', 'Build', 'Verify', 'Review', 'Ship', 'Retro']);

const stageLine = () => STAGES.map((s, i) => `${i + 1} ${s}`).join(' → ');

// Profile text is untrusted: keep it on one line so it cannot add lines to the banner.
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// Both harnesses read the same shape: systemMessage is shown to the user,
// hookSpecificOutput.additionalContext goes to the model.
function hookOutput(message, context) {
  return {
    systemMessage: message,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  };
}

function bannerForProfile(profile, file) {
  const client = oneLine(profile.client.name);
  return hookOutput(
    `${NAME} on deck for ${client}. Stages: ${stageLine()}`,
    [
      `${NAME} is active for ${client} (profile: ${file}).`,
      'You are the Orchestrator for this session: scope the ask, route work to specialists, bring one plan to the gate, and do not write production code yourself.',
      `Every build runs the core stages in order: ${stageLine()}.`,
    ].join('\n'),
  );
}

function bannerForError(err) {
  const problems = oneLine(err.message);
  return hookOutput(
    `${NAME}: the profile is invalid and must be fixed before building. ${problems}`,
    [
      `${NAME}: this repo is governed but its profile is INVALID.`,
      `Validation errors: ${problems}`,
      'The profile must be fixed before building: do not start any build stage until it loads cleanly. Help the user fix it if asked.',
    ].join('\n'),
  );
}

// Returns the hook output for a session starting in `startDir`, or null when
// the repo is not governed. Only ProfileError becomes a banner; anything else
// is a bug and throws, and the wrapper fails open.
function sessionStart(startDir) {
  let file;
  try {
    file = findProfilePath(startDir);
  } catch (err) {
    if (err instanceof ProfileError) return bannerForError(err);
    throw err;
  }
  if (!file) return null;
  let profile;
  try {
    profile = loadProfile(file);
  } catch (err) {
    if (err instanceof ProfileError) return bannerForError(err);
    throw err;
  }
  return bannerForProfile(profile, path.relative(startDir, file) || file);
}

module.exports = { NAME, STAGES, hookOutput, bannerForProfile, bannerForError, sessionStart };
