-- I1-02 — Repair order & check-in. Runs as garage_owner.
-- Spec: PRD v0.1 EP-04 (US-04.1/.2/.5/.6, AC-04.2, AC-04.2b); PRD v0.2 B1 ((new) → Checked-in), GAP-10
-- (authorized contact), GAP-42 and model #31 (MediaAsset), AC2-33. Decisions D-18, OD-2…OD-5, T-07.

-- ---------------------------------------------------------------------------
-- Settings that are configuration, not code (D-18 "minimum held as configuration", T-07).
-- Read-only for the app: changing them is an R1 admin change, which arrives with Increment 5.
-- ---------------------------------------------------------------------------
CREATE TABLE app_setting (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
INSERT INTO app_setting (key, value) VALUES
  ('check_in.required_photo_slots', '["front", "rear", "left", "right", "odometer"]'),
  ('media.max_photo_bytes', '15728640'),
  ('media.min_long_edge_px', '1280');

-- Repair-order reference numbers (OD-3): not a tax document.
INSERT INTO number_series (series, prefix) VALUES ('repair_order', 'RO-');

-- ---------------------------------------------------------------------------
-- Check-in in progress (OD-2). Becomes read-only once completed or abandoned.
-- ---------------------------------------------------------------------------
CREATE TABLE check_in (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id              uuid NOT NULL REFERENCES customer (id),
  vehicle_id               uuid NOT NULL REFERENCES vehicle (id),
  status                   text NOT NULL DEFAULT 'in_progress'
                             CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  contact_name             text CHECK (contact_name IS NULL OR length(btrim(contact_name)) BETWEEN 1 AND 200),
  contact_mobile           text CHECK (contact_mobile IS NULL OR length(contact_mobile) BETWEEN 6 AND 20),
  contact_mobile_normalized text CHECK (contact_mobile_normalized IS NULL OR contact_mobile_normalized ~ '^[0-9]{6,15}$'),
  contact_relationship     text CHECK (contact_relationship IS NULL OR contact_relationship IN
                             ('owner', 'driver', 'company_representative', 'other')),
  odometer_km              integer CHECK (odometer_km IS NULL OR odometer_km BETWEEN 0 AND 2000000),
  fuel_eighths             smallint CHECK (fuel_eighths IS NULL OR fuel_eighths BETWEEN 0 AND 8),
  warning_lights           text CHECK (warning_lights IS NULL OR length(warning_lights) <= 500),
  concerns                 text CHECK (concerns IS NULL OR length(concerns) <= 2000),
  belongings               text CHECK (belongings IS NULL OR length(belongings) <= 1000),
  keys_received            smallint CHECK (keys_received IS NULL OR keys_received BETWEEN 0 AND 20),
  key_tag                  text CHECK (key_tag IS NULL OR length(key_tag) <= 50),
  promised_at              timestamptz,
  photo_shortfall_reason   text CHECK (photo_shortfall_reason IS NULL OR length(btrim(photo_shortfall_reason)) BETWEEN 1 AND 500),
  abandoned_reason         text CHECK (abandoned_reason IS NULL OR length(btrim(abandoned_reason)) BETWEEN 1 AND 500),
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES app_user (id),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'abandoned') = (abandoned_reason IS NOT NULL))
);
CREATE INDEX check_in_vehicle_idx ON check_in (vehicle_id);
CREATE INDEX check_in_open_idx ON check_in (created_at) WHERE status = 'in_progress';

CREATE FUNCTION check_in_editable_only_in_progress() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'in_progress' THEN
    RAISE EXCEPTION 'check_in % is % and can no longer change', OLD.id, OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_in_editable_only_in_progress
  BEFORE UPDATE ON check_in
  FOR EACH ROW EXECUTE FUNCTION check_in_editable_only_in_progress();

-- ---------------------------------------------------------------------------
-- Repair order (PRD v0.2 B1). Created by "Complete check-in" with a copy of the arrival record,
-- which never changes afterwards (only status is granted for UPDATE). Statuses after Checked-in
-- are listed so later stories need no constraint change; nothing reaches them yet.
-- ---------------------------------------------------------------------------
CREATE TABLE repair_order (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  text NOT NULL UNIQUE,
  status                  text NOT NULL DEFAULT 'checked_in' CHECK (status IN
                            ('checked_in', 'diagnosing', 'awaiting_approval', 'in_progress', 'qc',
                             'release_check', 'ready', 'delivered', 'closed', 'cancelled')),
  customer_id             uuid NOT NULL REFERENCES customer (id),
  vehicle_id              uuid NOT NULL REFERENCES vehicle (id),
  check_in_id             uuid NOT NULL UNIQUE REFERENCES check_in (id),
  contact_name            text NOT NULL CHECK (length(btrim(contact_name)) BETWEEN 1 AND 200),
  contact_mobile          text NOT NULL CHECK (length(contact_mobile) BETWEEN 6 AND 20),
  contact_relationship    text NOT NULL CHECK (contact_relationship IN
                            ('owner', 'driver', 'company_representative', 'other')),
  odometer_km             integer NOT NULL CHECK (odometer_km BETWEEN 0 AND 2000000),
  fuel_eighths            smallint NOT NULL CHECK (fuel_eighths BETWEEN 0 AND 8),
  warning_lights          text CHECK (warning_lights IS NULL OR length(warning_lights) <= 500),
  concerns                text NOT NULL CHECK (length(btrim(concerns)) BETWEEN 1 AND 2000),
  belongings              text CHECK (belongings IS NULL OR length(belongings) <= 1000),
  keys_received           smallint NOT NULL CHECK (keys_received BETWEEN 0 AND 20),
  key_tag                 text CHECK (key_tag IS NULL OR length(key_tag) <= 50),
  promised_at             timestamptz,
  photo_shortfall_reason  text CHECK (photo_shortfall_reason IS NULL OR length(btrim(photo_shortfall_reason)) BETWEEN 1 AND 500),
  checked_in_at           timestamptz NOT NULL DEFAULT now(),
  checked_in_by           uuid REFERENCES app_user (id),
  business_date           date NOT NULL
);
CREATE INDEX repair_order_vehicle_idx ON repair_order (vehicle_id);
CREATE INDEX repair_order_status_idx ON repair_order (status);

-- ---------------------------------------------------------------------------
-- Photos (MediaAsset, model #31). Uploaded to a check-in; locked when it completes (AC-04.2b).
-- No DELETE for the app role at all. Before locking, a draft photo can be discarded (kept, hidden);
-- after locking only a manager's exclusion (AC2-33) may be recorded, once.
-- ---------------------------------------------------------------------------
CREATE TABLE media_asset (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_in_id      uuid NOT NULL REFERENCES check_in (id),
  repair_order_id  uuid REFERENCES repair_order (id),
  slot             text NOT NULL CHECK (slot IN ('front', 'rear', 'left', 'right', 'odometer', 'other')),
  storage_key      text NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 200),
  content_type     text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size        integer NOT NULL CHECK (byte_size > 0),
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  width            integer NOT NULL CHECK (width > 0),
  height           integer NOT NULL CHECK (height > 0),
  visibility       text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'customer')),
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  uploaded_by      uuid REFERENCES app_user (id),
  discarded_at     timestamptz,
  locked_at        timestamptz,
  excluded_at      timestamptz,
  excluded_by      uuid REFERENCES app_user (id),
  excluded_reason  text CHECK (excluded_reason IS NULL OR length(btrim(excluded_reason)) BETWEEN 1 AND 500),
  CHECK (discarded_at IS NULL OR locked_at IS NULL),
  CHECK ((excluded_at IS NULL) = (excluded_reason IS NULL) AND (excluded_at IS NULL) = (excluded_by IS NULL)),
  CHECK (excluded_at IS NULL OR locked_at IS NOT NULL)
);
-- One current photo per required slot; "other" may hold several.
CREATE UNIQUE INDEX media_asset_one_per_slot ON media_asset (check_in_id, slot)
  WHERE discarded_at IS NULL AND slot <> 'other';
CREATE INDEX media_asset_repair_order_idx ON media_asset (repair_order_id);

CREATE FUNCTION media_asset_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.check_in_id <> OLD.check_in_id OR NEW.slot <> OLD.slot
     OR NEW.storage_key <> OLD.storage_key OR NEW.sha256 <> OLD.sha256 THEN
    RAISE EXCEPTION 'media_asset content cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.locked_at IS NOT NULL THEN
    -- Locked: only a first exclusion may be recorded.
    IF OLD.excluded_at IS NOT NULL
       OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
       OR NEW.repair_order_id IS DISTINCT FROM OLD.repair_order_id
       OR NEW.discarded_at IS DISTINCT FROM OLD.discarded_at
       OR NEW.excluded_at IS NULL THEN
      RAISE EXCEPTION 'media_asset % is locked', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    -- Draft: may be discarded once, or locked once (with its repair order); never un-discarded.
    IF OLD.discarded_at IS NOT NULL
       OR (NEW.repair_order_id IS DISTINCT FROM OLD.repair_order_id AND NEW.locked_at IS NULL)
       OR NEW.excluded_at IS NOT NULL THEN
      RAISE EXCEPTION 'media_asset % cannot change this way', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_asset_guard
  BEFORE UPDATE ON media_asset
  FOR EACH ROW EXECUTE FUNCTION media_asset_guard();

REVOKE ALL ON FUNCTION check_in_editable_only_in_progress() FROM PUBLIC;
REVOKE ALL ON FUNCTION media_asset_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants for the application role. Anything not granted here is denied; no DELETE anywhere.
-- ---------------------------------------------------------------------------
GRANT SELECT ON app_setting TO garage_app;
GRANT SELECT, INSERT ON check_in TO garage_app;
GRANT UPDATE (status, contact_name, contact_mobile, contact_mobile_normalized, contact_relationship,
              odometer_km, fuel_eighths, warning_lights, concerns, belongings, keys_received, key_tag,
              promised_at, photo_shortfall_reason, abandoned_reason, updated_at) ON check_in TO garage_app;
GRANT SELECT, INSERT ON repair_order TO garage_app;
-- Status moves in later stories; it is also what lets ctx.locks take a row lock (FOR UPDATE).
GRANT UPDATE (status) ON repair_order TO garage_app;
GRANT SELECT, INSERT ON media_asset TO garage_app;
GRANT UPDATE (repair_order_id, discarded_at, locked_at, excluded_at, excluded_by, excluded_reason)
  ON media_asset TO garage_app;
