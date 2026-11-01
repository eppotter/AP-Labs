-- Ask's query guard tests (Story 19.7): a made-up client with allowed and
-- hidden tables and columns. clients.first_name and clients.email,
-- properties.street_address and visits.labour_minutes are hidden columns of
-- allowed tables; staff and pay_rates are never allowed. Never a client's.

CREATE TABLE zones (
  zone_id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL
);

CREATE TABLE clients (
  client_id INTEGER PRIMARY KEY,
  zone_id VARCHAR NOT NULL REFERENCES zones (zone_id),
  first_name VARCHAR NOT NULL,
  email VARCHAR NOT NULL,
  created_on DATE NOT NULL
);

CREATE TABLE properties (
  property_id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients (client_id),
  street_address VARCHAR NOT NULL,
  city VARCHAR NOT NULL
);

CREATE TABLE visits (
  visit_id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties (property_id),
  visit_date DATE NOT NULL,
  status VARCHAR NOT NULL,
  labour_minutes INTEGER NOT NULL
);

CREATE TABLE staff (
  staff_id INTEGER PRIMARY KEY,
  name VARCHAR NOT NULL
);

CREATE TABLE pay_rates (
  rate_id INTEGER PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff (staff_id),
  hourly_rate_cents BIGINT NOT NULL
);

CREATE TABLE fixture_meta (
  key VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
);
