-- I1-02 integrity review fixes. Runs as garage_owner.
--
-- 0005 guarded UPDATE but not INSERT, so the app role could insert a photo that already looked
-- locked, a check-in that was already "completed", or a repair order no check-in produced. These
-- triggers make every new row start where the commands start it, and tie locking and completion
-- together. Also applies decisions OD-6 (fuel and keys optional), B-12 (no minimum resolution) and
-- the 10 MB upload limit (T-07).

-- ---------------------------------------------------------------------------
-- OD-6: fuel and keys are recorded but not required.
-- ---------------------------------------------------------------------------
ALTER TABLE repair_order ALTER COLUMN fuel_eighths DROP NOT NULL;
ALTER TABLE repair_order ALTER COLUMN keys_received DROP NOT NULL;
ALTER TABLE repair_order DROP CONSTRAINT repair_order_fuel_eighths_check;
ALTER TABLE repair_order ADD CONSTRAINT repair_order_fuel_eighths_check
  CHECK (fuel_eighths IS NULL OR fuel_eighths BETWEEN 0 AND 8);
ALTER TABLE repair_order DROP CONSTRAINT repair_order_keys_received_check;
ALTER TABLE repair_order ADD CONSTRAINT repair_order_keys_received_check
  CHECK (keys_received IS NULL OR keys_received BETWEEN 0 AND 20);

-- B-12 and T-07.
DELETE FROM app_setting WHERE key = 'media.min_long_edge_px';
UPDATE app_setting SET value = '10485760' WHERE key = 'media.max_photo_bytes';

-- A photo's repair order must be the one its own check-in produced.
ALTER TABLE repair_order ADD CONSTRAINT repair_order_id_check_in_key UNIQUE (id, check_in_id);
ALTER TABLE media_asset ADD CONSTRAINT media_asset_repair_order_matches_check_in
  FOREIGN KEY (repair_order_id, check_in_id) REFERENCES repair_order (id, check_in_id);

-- ---------------------------------------------------------------------------
-- New rows start as the commands start them.
-- ---------------------------------------------------------------------------
CREATE FUNCTION check_in_insert_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'in_progress' OR NEW.abandoned_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a check-in starts in progress' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_in_insert_guard
  BEFORE INSERT ON check_in
  FOR EACH ROW EXECUTE FUNCTION check_in_insert_guard();

CREATE FUNCTION media_asset_insert_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.locked_at IS NOT NULL OR NEW.repair_order_id IS NOT NULL OR NEW.discarded_at IS NOT NULL
     OR NEW.excluded_at IS NOT NULL OR NEW.excluded_by IS NOT NULL OR NEW.excluded_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a photo starts unlocked on its check-in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM check_in WHERE id = NEW.check_in_id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'photos are added only to a check-in in progress' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.uploaded_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_asset_insert_guard
  BEFORE INSERT ON media_asset
  FOR EACH ROW EXECUTE FUNCTION media_asset_insert_guard();

-- A repair order exists only through "Complete check-in": its check-in is still in progress in the
-- same transaction, its number was allocated for it, and its time and business date are now.
CREATE FUNCTION repair_order_insert_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'checked_in' THEN
    RAISE EXCEPTION 'a repair order starts checked in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM check_in WHERE id = NEW.check_in_id AND status = 'in_progress'
                   AND customer_id = NEW.customer_id AND vehicle_id = NEW.vehicle_id) THEN
    RAISE EXCEPTION 'a repair order comes from its own check-in in progress' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM issued_number WHERE series = 'repair_order' AND number_text = NEW.number
                   AND document_id = NEW.id) THEN
    RAISE EXCEPTION 'repair order number was not allocated for it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.checked_in_at := now();
  NEW.business_date := business_date_of(now());
  RETURN NEW;
END;
$$;
CREATE TRIGGER repair_order_insert_guard
  BEFORE INSERT ON repair_order
  FOR EACH ROW EXECUTE FUNCTION repair_order_insert_guard();

-- ---------------------------------------------------------------------------
-- Updates: completion needs its repair order; locking needs both columns together.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_in_editable_only_in_progress() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'in_progress' THEN
    RAISE EXCEPTION 'check_in % is % and can no longer change', OLD.id, OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'completed' AND NOT EXISTS (SELECT 1 FROM repair_order WHERE check_in_id = NEW.id) THEN
    RAISE EXCEPTION 'check_in % completes only with its repair order', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION media_asset_guard() RETURNS trigger
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
    -- Draft: discarded once, or locked once together with its repair order (whose check-in is
    -- this photo's, enforced by the foreign key); never un-discarded, never excluded.
    IF OLD.discarded_at IS NOT NULL
       OR NEW.excluded_at IS NOT NULL
       OR (NEW.locked_at IS NULL) <> (NEW.repair_order_id IS NULL)
       OR (NEW.locked_at IS NOT NULL AND NEW.discarded_at IS NOT NULL) THEN
      RAISE EXCEPTION 'media_asset % cannot change this way', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION check_in_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION media_asset_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION repair_order_insert_guard() FROM PUBLIC;
