'use strict';

// A fake DuckDB instance factory for the MotherDuck read path (plan
// motherduck-read). kit/runtime/data's createData({ connect }) calls
// create(path, options) and uses the instance the way it uses DuckDB's
// (connect, run, runAndReadAll, prepare, bind, interrupt, closeSync). Nothing
// here opens a connection or imports DuckDB.
//
// It records every instance and, per connection, every statement in order,
// so tests assert the lockdown sequence. Behaviour is set with options:
//   database      the database the share attaches as (ATTACH 'md:<it>' works)
//   hasMeta       whether that database holds fixture_meta (default true)
//   landOn        what current_database() reports (default: where USE went)
//   createDelayMs create() resolves after this long (a slow connect)
//   failOn(sql)   an Error to throw for a statement, or null
//   rows(sql)     the rows a query returns (may throw; default: none)
//   hangQueries   queries never finish until the connection is interrupted

function createFakeMotherDuck({
  database = 'brightside_fixture',
  hasMeta = true,
  landOn = null,
  createDelayMs = 0,
  failOn = () => null,
  rows = () => [],
  hangQueries = false,
} = {}) {
  const state = {
    instances: [],
    created: [],
    revoked: null, // set to an Error: every later statement fails with it
    hangQueries,
    rows,
    failOn,
  };

  function connection(instance) {
    const conn = {
      statements: [],
      current: 'memory',
      interrupted: 0,
      closed: false,
      waiters: [],
    };
    const check = (sql) => {
      if (instance.closed) throw new Error('Connection Error: the database instance is closed');
      if (state.revoked) throw state.revoked;
      const err = state.failOn(sql);
      if (err) throw err;
    };
    const attachMatch = (sql) => /^ATTACH 'md:([a-z0-9_]+)' AS "([a-z0-9_]+)" \(READ_ONLY\)$/.exec(sql);
    const api = {
      async run(sql) {
        conn.statements.push(sql);
        check(sql);
        const attach = attachMatch(sql);
        if (attach) {
          if (attach[1] !== database) throw new Error(`Catalog Error: database "${attach[1]}" not found`);
          instance.attached.add(attach[2]);
        }
        const use = /^USE "([a-z0-9_]+)"$/.exec(sql);
        if (use) {
          if (!instance.attached.has(use[1])) throw new Error(`Catalog Error: Catalog "${use[1]}" does not exist!`);
          conn.current = use[1];
        }
        return {};
      },
      async runAndReadAll(sql) {
        conn.statements.push(sql);
        check(sql);
        if (/current_database\(\)/.test(sql)) {
          const db = landOn || conn.current;
          return { getRowObjectsJson: () => [{ db, meta: db === database && hasMeta ? 1 : 0 }] };
        }
        throw new Error(`fake: unexpected runAndReadAll ${sql}`);
      },
      async prepare(sql) {
        conn.statements.push(sql);
        check(sql);
        return {
          parameterCount: 0,
          parameterName: () => { throw new Error('fake: no parameters'); },
          bind() {},
          runAndReadAll: () => {
            if (state.hangQueries) {
              return new Promise((resolve, reject) => conn.waiters.push(reject));
            }
            check(sql);
            const out = state.rows(sql, conn);
            return Promise.resolve({ getRowObjectsJson: () => out });
          },
        };
      },
      interrupt() {
        conn.interrupted += 1;
        for (const reject of conn.waiters.splice(0)) reject(new Error('INTERRUPT Error: Interrupted!'));
      },
      closeSync() { conn.closed = true; },
      get record() { return conn; },
    };
    instance.connections.push(conn);
    return api;
  }

  async function create(where, options) {
    state.created.push({ where, options: { ...options } });
    if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs));
    const instance = { where, options, connections: [], attached: new Set(), closed: false };
    state.instances.push(instance);
    return {
      connect: async () => connection(instance),
      closeSync() { instance.closed = true; },
    };
  }

  return {
    create,
    state,
    // The MotherDuck key stops working, as if revoked mid-run.
    revoke(message) { state.revoked = new Error(message); },
    restore() { state.revoked = null; },
  };
}

module.exports = { createFakeMotherDuck };
