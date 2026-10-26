'use strict';

// The dev-only map check (Story 15.1, the live check for AD-R15): shows a
// fixed synthetic test pattern (colour bars and a checkerboard, no client
// data) in the module's view, the way a route map will be shown: uploaded as
// a private Slack file and drawn by an image block. The hub uploads it,
// records it and deletes it when the view closes or the sweep finds it
// expired. The alt text is the fixed route-map template. Story 15.5 removes
// this module.

const fs = require('node:fs');
const path = require('node:path');

const PNG = fs.readFileSync(path.join(__dirname, 'test-pattern.png'));
const ALT = 'Route map: Test pattern, no crew, 0 stops';
const TEXT = '*Map check (dev only).* A fixed test picture, shown the way a route map will be. '
  + 'Press Back to return to the menu.';

module.exports = async function mapCheck({ reply }) {
  await reply({ text: TEXT, image: { png: PNG, alt: ALT } });
};
