'use strict';

// What a hub may see (plan brightside-v0, D1, Story 16.1): the one list,
// read from the hub schema's sees enum (kit/runtime/schema/hub.schema.json,
// a T3 engine floor), so the registry, the AI service and the hub view can't
// drift apart from the schema or from each other.

const schema = require('./schema/hub.schema.json');

const HUB_SEES = Object.freeze([...schema.properties.sees.items.enum]);

module.exports = { HUB_SEES };
