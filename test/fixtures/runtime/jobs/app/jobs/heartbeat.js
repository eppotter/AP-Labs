'use strict';

// A fixture job (Story 11.1): logs one line through ctx.log, no rows.
async function run(ctx) {
  ctx.log.info('heartbeat ran', { at: ctx.now().toISOString() });
}

module.exports = { run };
