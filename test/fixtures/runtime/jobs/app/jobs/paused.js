'use strict';

// A fixture job whose jobs.json entry is disabled (Story 11.1).
async function run(ctx) {
  ctx.log.info('paused ran');
}

module.exports = { run };
