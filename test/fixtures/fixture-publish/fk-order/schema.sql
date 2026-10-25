-- Fixture for the publish upload-order tests (kit/fixture/publish): every
-- child table's name sorts before its parent's, so an upload that loads
-- tables by name, ignoring foreign keys, fails on the first child row.

CREATE TABLE zones (
  zone_id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL
);

CREATE TABLE crews (
  crew_id INTEGER PRIMARY KEY,
  zone_id VARCHAR NOT NULL REFERENCES zones (zone_id),
  name VARCHAR NOT NULL
);

CREATE TABLE assignments (
  assignment_id INTEGER PRIMARY KEY,
  crew_id INTEGER NOT NULL REFERENCES crews (crew_id),
  zone_id VARCHAR NOT NULL REFERENCES zones (zone_id),
  starts_on DATE NOT NULL
);

CREATE TABLE fixture_meta (
  key VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
);
