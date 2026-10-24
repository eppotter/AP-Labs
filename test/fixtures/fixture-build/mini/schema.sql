-- Minimal fixture for kit/fixture/build tests: a parent, a child with a
-- foreign key, nullable and zero-padded text columns, and fixture_meta.

CREATE TABLE regions (
  region_id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL
);

CREATE TABLE shops (
  shop_id INTEGER PRIMARY KEY,
  region_id VARCHAR NOT NULL REFERENCES regions (region_id),
  postal_code VARCHAR NOT NULL,
  opened_on DATE NOT NULL,
  closed_on DATE,
  revenue_cents BIGINT NOT NULL
);

CREATE TABLE fixture_meta (
  key VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
);
