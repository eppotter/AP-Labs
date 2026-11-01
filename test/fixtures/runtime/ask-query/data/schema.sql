-- Ask's query answers (Story 19.8): a made-up client, never a client's.
-- clients.first_name and clients.email are hidden from Ask (not in the
-- profile's ask.tables); staff is never allowed.

CREATE TABLE zones (
  zone_id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL
);

CREATE TABLE clients (
  client_id INTEGER PRIMARY KEY,
  zone_id VARCHAR NOT NULL REFERENCES zones (zone_id),
  first_name VARCHAR NOT NULL,
  email VARCHAR NOT NULL
);

CREATE TABLE invoices (
  invoice_id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients (client_id),
  issued_on DATE NOT NULL,
  total_cents BIGINT NOT NULL
);

CREATE TABLE payments (
  payment_id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices (invoice_id),
  paid_on DATE NOT NULL,
  amount_cents BIGINT NOT NULL
);

CREATE TABLE staff (
  staff_id INTEGER PRIMARY KEY,
  name VARCHAR NOT NULL
);

CREATE TABLE fixture_meta (
  key VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
);
