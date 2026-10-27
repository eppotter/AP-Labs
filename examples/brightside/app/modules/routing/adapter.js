'use strict';

// Brightside's Routing module (Story 15.5): the routing-map archetype's
// adapter is Brightside's routing adapter (../../routing/adapter.js), which
// gives asOf, input and labels (AD-R16). The manifest names a file in this
// folder, so this one re-exports it.

const { createAdapter } = require('../../routing/adapter');

module.exports = { createAdapter };
