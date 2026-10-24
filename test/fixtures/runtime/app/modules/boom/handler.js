'use strict';

module.exports = async function boom() {
  throw new Error('boom: internal detail');
};
