'use strict';

// Brightside's Plan a route module (Story 15.15, AD-R26): the routing-map
// archetype's route-editor screen. Its adapter is Brightside's routing
// adapter (../../routing/adapter.js), whose route() gives one crew's day from
// the Office. The manifest names a file in this folder, so this one
// re-exports it, as modules/routing/adapter.js does.

const { createAdapter } = require('../../routing/adapter');

module.exports = { createAdapter };
