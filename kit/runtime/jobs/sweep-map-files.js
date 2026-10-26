'use strict';

// The map-file sweep (Story 15.1, AD-R15): an engine job, not a jobs.json
// job. It deletes the file of every map-file record in the store whose
// 15-minute expiry has passed (kit/runtime/slack/image deleteMapFiles). It
// runs at start-up and every 5 minutes (kit/runtime/jobs createEngineJobs),
// so no map file outlives its upload by more than 20 minutes. A failed delete
// keeps the record and the next run retries it; a new process given the same
// store deletes what the previous one recorded.
//
// ctx: { store, client, log }. It reads the clock only through the store.

const { deleteMapFiles } = require('../slack/image');

const NAME = 'sweep-map-files';
const EVERY_MS = 5 * 60 * 1000;

async function run({ store, client, log }) {
  const ids = store.expiredMapFiles();
  if (!ids.length) return { deleted: 0, kept: 0 };
  const res = await deleteMapFiles({
    store, client, log, ids, why: 'expired',
  });
  log.info('map files swept', res);
  return res;
}

module.exports = { run, NAME, EVERY_MS };
