-- Synthetic places for travelMatrix tests (Story 13.2): sites and vans with
-- micro-degree coordinates, matching test/fixtures/profiles/routing.yml.
-- Every value is made up. street_address and phone are text columns a
-- profile forbids; s4 has no position.

CREATE TABLE sites (
  site_id VARCHAR PRIMARY KEY,
  street_address VARCHAR NOT NULL,
  phone VARCHAR NOT NULL,
  pos_lat_e6 INTEGER,
  pos_lon_e6 INTEGER
);

CREATE TABLE vans (
  van_id VARCHAR PRIMARY KEY,
  home_lat_e6 BIGINT NOT NULL,
  home_lon_e6 BIGINT NOT NULL
);

-- Not a node source: a forbidden column with the same name as a declared
-- coordinate column (sites.pos_lat_e6), to prove travelMatrix never opens it.
CREATE TABLE depots (
  depot_id VARCHAR PRIMARY KEY,
  pos_lat_e6 INTEGER NOT NULL
);

CREATE TABLE fixture_meta (
  key VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
);
