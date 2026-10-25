'use strict';

// Connector loading (Story 10.2, AD-15, finding B1). The one engine file that
// loads a connector: no other file under kit/ requires one (a grep test,
// test/unit/runtime-approval-connectors.test.js, holds that).
//
//   <app dir>/connectors/<id>/connector.js    one connector (kit/templates/connector.md)
//
// Discovery, never registration: a connector is loaded only when an
// approval-write module names it in its manifest's write block, so a folder
// nobody pushes through is never loaded.
//
//   checkWrite(mod, appDir)        at startup, for each approval-write module
//                                  (the registry calls it; it never reads a
//                                  write block itself): the named connector
//                                  loads, is a defineConnector declaration
//                                  whose id is its folder name, and declares
//                                  write.operation. A missing folder, a file
//                                  that throws while loading (a declaration
//                                  that fails checkDeclaration throws there)
//                                  and an unknown operation are each a
//                                  problem naming the field.
//   createConnectors({ appDir, modules, log, env })
//                                  at boot (kit/runtime/app): exactly one
//                                  instance per connector, made with the
//                                  app's logger and env (create({ log, env })),
//                                  shared by every module that names it. The
//                                  app calls it once, so there is one instance
//                                  per connector per process (AD-8: one
//                                  process). Throws when a connector can't be
//                                  loaded or created, so boot refuses.
//
// Node's require cache holds each connector file once per process, so the
// connector's own state (the mock email tool's outbox and the contract's
// idempotency store) is shared too (DEP-012).

const fs = require('node:fs');
const path = require('node:path');

const ARCHETYPE = 'approval-write';
const FILE = 'connector.js';

// "connectors/<id>/connector.js", relative to the app dir: what a problem
// names (never an absolute path, which may come from env).
const relFile = (id) => `connectors/${id}/${FILE}`;

// The connector a module names, loaded: { connector } or { problem }.
function load(appDir, id) {
  const abs = path.join(appDir, 'connectors', id, FILE);
  if (!fs.existsSync(abs)) return { problem: `field "write.connector" names "${id}", but ${relFile(id)} does not exist in the app dir` };
  let exported;
  try {
    exported = require(abs);
  } catch (err) {
    const why = String((err && err.message) || err).split('\n')[0];
    return { problem: `field "write.connector" names "${id}", but ${relFile(id)} could not be loaded (${why})` };
  }
  const decl = exported && exported.declaration;
  if (!decl || typeof exported.create !== 'function' || !Array.isArray(decl.write) || typeof decl.id !== 'string') {
    return { problem: `field "write.connector" names "${id}", but ${relFile(id)} does not export a connector declared with defineConnector (kit/templates/connector.md)` };
  }
  if (decl.id !== id) return { problem: `field "write.connector" names "${id}", but ${relFile(id)} declares id "${decl.id}" (it must equal its folder name)` };
  return { connector: exported };
}

// The write block of an approval-write module, or null.
function writeOf(mod) {
  return mod && mod.archetype === ARCHETYPE && mod.write && typeof mod.write === 'object' ? mod.write : null;
}

// Startup problems with mod's connector and operation, as sentences naming
// the field (the registry prefixes the module's file).
function checkWrite(mod, appDir) {
  const block = writeOf(mod);
  if (!block) return [];
  const found = load(appDir, block.connector);
  if (found.problem) return [found.problem];
  const ops = found.connector.declaration.write;
  if (!ops.includes(block.operation)) {
    const has = ops.length ? `it has ${ops.join(', ')}` : 'it declares none';
    return [`field "write.operation" "${block.operation}" is not a write operation of connector "${block.connector}" (${has})`];
  }
  return [];
}

// The connector ids the approval-write modules name, sorted, once each.
function connectorIds(modules) {
  return [...new Set(modules.map(writeOf).filter(Boolean).map((b) => b.connector))].sort();
}

// One instance per connector the modules name: a frozen Map id → instance.
function createConnectors({ appDir, modules, log, env = process.env }) {
  const instances = new Map();
  for (const id of connectorIds(modules)) {
    const found = load(appDir, id);
    if (found.problem) throw new Error(`app: ${found.problem}`);
    try {
      instances.set(id, found.connector.create({ log, env }));
    } catch (err) {
      throw new Error(`app: connector "${id}" could not be created (${String((err && err.message) || err).split('\n')[0]})`);
    }
  }
  return Object.freeze({
    get: (id) => instances.get(id),
    has: (id) => instances.has(id),
    ids: () => [...instances.keys()],
  });
}

module.exports = { checkWrite, createConnectors, connectorIds, FILE };
