'use strict';

// A Brightside v1 route skill (plan brightside-v1, D5, D8, Story 19.2): the
// routing-map archetype on /brightside-v1, with Brightside's routing adapter
// (../../routing/adapter.js), as on /brightside. The manifest names a file in
// this folder, so this one re-exports it.

const { createAdapter } = require('../../routing/adapter');

module.exports = { createAdapter };
