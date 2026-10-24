'use strict';

// The one engine surface app code may import (AD-1). Handlers, connectors and
// module tests in the app dir require it as '#sdk' (package.json "imports"),
// never another kit/ path; a grep test enforces that.
//
// What a handler gets is its ctx argument (kit/runtime/slack/hubs.js):
//   ctx.person   { id, name }       the Slack user who pressed Open
//   ctx.client   { id, name }       from the profile
//   ctx.module   { id, label }      from the manifest
//   ctx.data     run(sql, params), describe()   the read-only query runner
//   ctx.reply    (text) => Promise  a private (ephemeral) reply
// The SDK adds only what a handler or its test needs beyond that, plus what a
// connector adapter and its test need (kit/templates/connector.md).

const { DataUnavailableError, QueryRefusedError } = require('../data');
const { createLog } = require('../log');
const {
  defineConnector, KillSwitchOn, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict,
} = require('../connectors/contract');

// The shared connector contract suite, for a connector's own test file. It
// registers node:test cases, so it is loaded only when a test calls it.
function connectorContract(...args) {
  return require('../connectors/suite').connectorContract(...args);
}

// A ctx for a module's own test: same shape as the dispatcher's, no Slack and
// no data file. ctx.replies holds every reply; ctx.queries every run() call.
// rows: the rows run() resolves with, or a function (sql, params) => rows.
// available: false makes run() reject as the real runner does when the data
// is unavailable (the dispatcher then tells the person so).
function testContext({
  person = { id: 'U0TEST', name: 'Test Person' },
  client = { id: 'test', name: 'Test Client' },
  module = { id: 'test-module', label: 'Test module' },
  rows = [],
  available = true,
} = {}) {
  const replies = [];
  const queries = [];
  const data = Object.freeze({
    run: async (sql, params) => {
      queries.push({ sql, params });
      if (!available) throw new DataUnavailableError('test context: data unavailable');
      return typeof rows === 'function' ? rows(sql, params) : rows;
    },
    describe: () => (available ? { available: true, source: 'test context' } : { available: false }),
  });
  return {
    person, client, module, data, replies, queries,
    reply: async (message) => { replies.push(message); },
  };
}

// A logger for a test that creates a connector (create() needs one): it
// redacts like the app's, and keeps its JSON lines in .lines instead of
// printing them.
function testLog() {
  const lines = [];
  return { ...createLog({ write: (line) => lines.push(line) }), lines };
}

module.exports = {
  testContext, testLog, DataUnavailableError, QueryRefusedError,
  defineConnector, connectorContract, KillSwitchOn, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict,
};
