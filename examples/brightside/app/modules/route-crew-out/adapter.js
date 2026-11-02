'use strict';

// Crew out on /brightside (Story 20.3, plan brightside-v1 D8, D14): a copy
// of the v1 route skill on the live hub, dev only, so its Route change can
// notify the affected customers. The manifest names a file in this folder,
// so this one re-exports Brightside's routing adapter
// (../../routing/adapter.js).

const { createAdapter } = require('../../routing/adapter');

module.exports = { createAdapter };
