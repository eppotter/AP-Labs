'use strict';

// A fixture job whose top-level code throws when loaded (Story 11.1, B2): with
// jobs off it must never be evaluated. The counter lets a test prove it was
// not. `node --test` also runs every .js under test/ as its own file; only a
// require() from the app counts, so running it directly does nothing.
if (require.main !== module) {
  globalThis.__aplabsJobFixtureLoads = (globalThis.__aplabsJobFixtureLoads || 0) + 1;
  throw new Error('top-level job code ran');
}
