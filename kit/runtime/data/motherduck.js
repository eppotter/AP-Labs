'use strict';

// The MotherDuck read path's constants and pure helpers (plan motherduck-read,
// Story B). Nothing here opens a connection or imports DuckDB: the query
// runner (./index.js) stays the only runtime importer of @duckdb/node-api and
// runs the sequence below.
//
// The sequence was proven live by the Orchestrator as the reader service
// account. The `md:<db>?attach_mode=single` path form is out: with
// enable_external_access=false the instance cannot be created, and without it
// a URL read was executed on MotherDuck's side. Instead:
//   1. an in-memory instance with extension auto-install and auto-load off;
//   2. on one setup connection: LOAD motherduck, SET motherduck_token, ATTACH
//      the one database READ_ONLY, SET enable_external_access=false, then
//      SET lock_configuration=true, so no later SET can loosen it;
//   3. every connection runs USE <db> before its query (a new connection
//      starts on `memory`; USE still works after the lock, SET GLOBAL
//      search_path does not). After USE, open() checks once that
//      current_database() is the database and that fixture_meta exists.
// Under it, only <db>, md_information_schema and `memory` are visible; the
// reader's my_db and sample_data are not. `memory` is a writable in-process
// scratch database: harmless (nothing leaves the process), and the SQL
// guardrail refuses DDL and writes anyway.
//
// The token goes into SQL text (SET motherduck_token = '...'), so the caller
// registers it with the redactor before the sequence starts, and every reason
// built from a DuckDB error is redacted (reasonFor).
//
// The name check lives here, not in kit/fixture, so the runtime never loads
// fixture code; kit/fixture/remote.js imports it from here.

const { redact } = require('../../lib/secrets');

// The bot's read key (a MotherDuck service account that holds only the
// client's share) and the publish key it must never equal.
const READ_TOKEN_ENV = 'MOTHERDUCK_READ_TOKEN';
const READ_TOKEN_KEYCHAIN = 'aplabs-motherduck-read-token';
const PUBLISH_TOKEN_ENV = 'MOTHERDUCK_TOKEN';
const PUBLISH_TOKEN_KEYCHAIN = 'aplabs-motherduck-token';

const SOURCE = 'MotherDuck';
const DOC = 'docs/runtime/motherduck-publish.md';

// Time limits (ms). A connect attempt that finishes after its limit has its
// instance closed at once; after a failure other than a catalog or binder
// error the instance is dropped and the next connect waits RETRY_AFTER_MS.
const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;
const RETRY_AFTER_MS = 30_000;

// Database names are spliced into SQL as quoted identifiers, so only plain
// lower-case identifiers are allowed. my_db and sample_data are MotherDuck's
// own databases on every account; *__publishing is publish's staging copy.
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const RESERVED = Object.freeze(['my_db', 'sample_data']);
const STAGING_SUFFIX = '__publishing';

// Why a database name can't be used, or null.
function databaseNameProblem(name) {
  if (typeof name !== 'string' || !NAME.test(name)) return `"${name}" is not a plain name (lower-case letters, digits and _, up to 63, not starting with a digit)`;
  if (RESERVED.includes(name)) return `"${name}" is one of MotherDuck's own databases`;
  if (name.endsWith(STAGING_SUFFIX)) return `"${name}" ends with ${STAGING_SUFFIX}, which publish uses for its staging copy`;
  return null;
}

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The whole MotherDuck lockdown, in order. instance: the options the
// in-memory instance is created with. setup(db, token): the statements run on
// the setup connection, in order. perConnection(db): run on every connection
// before its query. Separate from the local file's LOCKDOWN (./index.js).
const MD_LOCKDOWN = Object.freeze({
  path: ':memory:',
  instance: Object.freeze({
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
  }),
  setup: Object.freeze([
    () => 'LOAD motherduck',
    (db, token) => `SET motherduck_token = ${sqlString(token)}`,
    (db) => `ATTACH ${sqlString(`md:${db}`)} AS ${ident(db)} (READ_ONLY)`,
    () => 'SET enable_external_access = false',
    () => 'SET lock_configuration = true',
  ]),
  perConnection: Object.freeze([
    (db) => `USE ${ident(db)}`,
  ]),
});

// The statements, as text, for a database and token.
const setupStatements = (db, token) => MD_LOCKDOWN.setup.map((s) => s(db, token));
const perConnectionStatements = (db) => MD_LOCKDOWN.perConnection.map((s) => s(db));

// The one check after opening: which database the connection is on, and
// whether it holds fixture_meta. The database name is compared in JS, never
// spliced in.
const OPEN_CHECK = `SELECT current_database() AS db,
  (SELECT count(*) FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main' AND table_name = 'fixture_meta')::INTEGER AS meta`;

const firstLine = (s) => String(s ?? '').split('\n')[0];

// What kind of DuckDB error this is. catalog and binder errors are about the
// query (a missing table or column): the instance is kept. Anything else
// (a network, auth or interrupt error) drops it.
function classifyError(err) {
  const msg = firstLine(err?.message ?? err);
  if (/^Catalog Error\b/i.test(msg)) return 'catalog';
  if (/^Binder Error\b/i.test(msg)) return 'binder';
  if (/extension/i.test(msg) && /motherduck/i.test(msg) && /(not found|not installed|could not be loaded|failed to load|unable to (?:find|load)|no such file)/i.test(msg)) return 'missing_extension';
  return 'other';
}

const keepsInstance = (kind) => kind === 'catalog' || kind === 'binder';

// A loggable reason from a DuckDB error: its first line, every secret and
// every absolute path removed. Never the token.
function reasonFor(err, secrets = []) {
  const text = redact(firstLine(err?.message ?? err), secrets.filter(Boolean));
  return text.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s"'\\/]+[\\/])+([^\s"'\\/]+)/g, '$1');
}

const MISSING_EXTENSION = `the MotherDuck extension is not installed (install it ahead of time with INSTALL motherduck; the bot never installs it, see ${DOC})`;

module.exports = {
  READ_TOKEN_ENV,
  READ_TOKEN_KEYCHAIN,
  PUBLISH_TOKEN_ENV,
  PUBLISH_TOKEN_KEYCHAIN,
  SOURCE,
  CONNECT_TIMEOUT_MS,
  QUERY_TIMEOUT_MS,
  RETRY_AFTER_MS,
  NAME,
  RESERVED,
  STAGING_SUFFIX,
  databaseNameProblem,
  MD_LOCKDOWN,
  setupStatements,
  perConnectionStatements,
  OPEN_CHECK,
  classifyError,
  keepsInstance,
  reasonFor,
  MISSING_EXTENSION,
};
