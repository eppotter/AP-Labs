'use strict';

// A Brightside v1 route skill (plan brightside-v1, D5, D8, Story 19.5): the
// routing-map archetype's Add a stop on /brightside-v1, with Brightside's
// routing adapter (../../routing/adapter.js), as the other v1 route skills.
// The manifest names a file in this folder, so this one re-exports it.

const { createAdapter } = require('../../routing/adapter');

module.exports = { createAdapter };
