'use strict';

module.exports = async function second({ reply }) {
  await reply({ text: 'second', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'second' } }] });
};
