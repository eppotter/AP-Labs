'use strict';

module.exports = async function prodOnly({ reply }) {
  await reply('prod only ran');
};
