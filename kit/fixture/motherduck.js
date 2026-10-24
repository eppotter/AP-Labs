'use strict';

// The MotherDuck connection for fixture:publish and fixture:status --remote
// (Story 7.7, AD-18). Run by Ely only; no test opens it (they inject a fake).
//
// It opens DuckDB on `md:` (MotherDuck's default database) with the token as
// the motherduck_token setting, never in the path, so the token is not part
// of any file name DuckDB might echo in an error. Callers register the token
// with the redactor before calling connect() (kit/fixture/remote).
//
// This is a separate DuckDB instance from the runtime's query runner
// (kit/runtime/data), which stays locked read-only and offline; nothing in the
// app loads this file.
//
// connect({ token }) returns { run(sql) -> rows as JSON-safe objects, close() }.

const { DuckDBInstance } = require('@duckdb/node-api');

async function connect({ token }) {
  const instance = await DuckDBInstance.create('md:', { motherduck_token: token });
  let conn;
  try {
    conn = await instance.connect();
  } catch (err) {
    instance.closeSync();
    throw err;
  }
  return {
    run: async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson(),
    close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

module.exports = { connect };
