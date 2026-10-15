-- I1-01 — Customers & Vehicles.
-- Runs as garage_owner. Spec references: PRD v0.1 EP-02 (US-02.1-02.7, AC-02.1/.3/.4/.5),
-- PRD v0.2 §7.2 item 8 (VehiclePlate: emirate, code, number, valid from/to — GAP-26).

-- ---------------------------------------------------------------------------
-- Customers (S11). No UPDATE grant: this story has no edit screen, only create.
-- ---------------------------------------------------------------------------
CREATE TABLE customer (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_en             text CHECK (name_en IS NULL OR length(btrim(name_en)) BETWEEN 1 AND 200),
  name_ar             text CHECK (name_ar IS NULL OR length(btrim(name_ar)) BETWEEN 1 AND 200),
  mobile              text NOT NULL CHECK (length(mobile) BETWEEN 6 AND 20),
  mobile_normalized   text NOT NULL CHECK (mobile_normalized ~ '^[0-9]{6,15}$'),
  email               text CHECK (email IS NULL OR length(email) <= 254),
  preferred_language  text NOT NULL CHECK (preferred_language IN ('ar', 'en')),
  marketing_consent   boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES app_user (id),
  CHECK (name_en IS NOT NULL OR name_ar IS NOT NULL)
);
CREATE INDEX customer_mobile_idx ON customer (mobile_normalized);

-- ---------------------------------------------------------------------------
-- Vehicles (S11). VIN is optional (US-02.2); duplicate VIN only warns (US-02.4),
-- so there is no uniqueness constraint on it.
-- ---------------------------------------------------------------------------
CREATE TABLE vehicle (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vin         text CHECK (vin IS NULL OR length(btrim(vin)) BETWEEN 5 AND 32),
  make        text NOT NULL CHECK (length(btrim(make)) BETWEEN 1 AND 100),
  model       text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 100),
  year        integer NOT NULL CHECK (year BETWEEN 1960 AND 2100),
  colour      text CHECK (colour IS NULL OR length(btrim(colour)) BETWEEN 1 AND 50),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES app_user (id)
);
CREATE INDEX vehicle_vin_idx ON vehicle (vin) WHERE vin IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Plate history (GAP-26): a plate belongs to at most one vehicle at a time
-- (valid_to IS NULL = currently active), but the same physical plate number can be
-- retired from one vehicle and later assigned to a different one.
-- ---------------------------------------------------------------------------
CREATE TABLE vehicle_plate (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  uuid NOT NULL REFERENCES vehicle (id),
  emirate     text NOT NULL CHECK (emirate IN
                ('abu_dhabi', 'dubai', 'sharjah', 'ajman', 'umm_al_quwain', 'ras_al_khaimah', 'fujairah')),
  code        text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 4),
  number      text NOT NULL CHECK (number ~ '^[0-9]{1,5}$'),
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  changed_by  uuid REFERENCES app_user (id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
-- The hard "one active plate" rule (not just a warning): two vehicles cannot both
-- currently hold the same real-world plate.
CREATE UNIQUE INDEX vehicle_plate_active_key ON vehicle_plate (emirate, code, number) WHERE valid_to IS NULL;
CREATE INDEX vehicle_plate_vehicle_idx ON vehicle_plate (vehicle_id);

-- ---------------------------------------------------------------------------
-- Ownership history: exactly one current owner per vehicle; transferring keeps
-- the previous owner's row (closed) rather than overwriting it (AC-02.5 basis).
-- ---------------------------------------------------------------------------
CREATE TABLE vehicle_ownership (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id   uuid NOT NULL REFERENCES vehicle (id),
  customer_id  uuid NOT NULL REFERENCES customer (id),
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_to     timestamptz,
  changed_by   uuid REFERENCES app_user (id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX vehicle_ownership_active_key ON vehicle_ownership (vehicle_id) WHERE valid_to IS NULL;
CREATE INDEX vehicle_ownership_customer_idx ON vehicle_ownership (customer_id);

-- ---------------------------------------------------------------------------
-- Free-text search (plate/mobile/name/VIN, AC-02.3: under 2s with 10,000 vehicles).
-- pg_trgm would give an indexed "contains" search, but garage_owner is only granted
-- CONNECT on the database (bootstrap-database.sql), not CREATE, so it cannot install
-- extensions even though pg_trgm is "trusted" from PostgreSQL 13 on. The plain btree
-- indexes above plus a sequential scan over 10,000 rows already clear the 2s target
-- (verified in tests/s11-customers-vehicles.test.ts), so this is not blocking.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Grants for the application role. Anything not granted here is denied.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON customer TO garage_app;
GRANT SELECT, INSERT ON vehicle TO garage_app;
-- changePlate/transferOwnership lock the vehicle row (ctx.locks.acquire("vehicle", …)) before
-- transitioning plate/ownership history. PostgreSQL's SELECT ... FOR UPDATE requires UPDATE
-- privilege on the table — on any column, not necessarily the one matched in the lock query
-- (0001's test_document has the same pattern: granted UPDATE on title/amount, locked by id).
GRANT UPDATE (colour) ON vehicle TO garage_app;
GRANT SELECT, INSERT ON vehicle_plate TO garage_app;
GRANT UPDATE (valid_to) ON vehicle_plate TO garage_app;
GRANT SELECT, INSERT ON vehicle_ownership TO garage_app;
GRANT UPDATE (valid_to) ON vehicle_ownership TO garage_app;
