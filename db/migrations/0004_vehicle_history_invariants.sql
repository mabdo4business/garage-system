-- I1-01 re-review fixes (finding N3). Runs as garage_owner.
--
-- 0003 lets a history row be closed once. Two wrong closes were still possible for the app role:
-- closing a row with a future valid_to, and closing a vehicle's only ownership row with no
-- replacement (getVehicle then has no current owner). Both are refused here.

-- A row may be closed once, and not later than now: valid_to records when the change happened.
CREATE OR REPLACE FUNCTION history_row_close_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL THEN
    RAISE EXCEPTION '% rows are append-only: valid_to may only be set once', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.valid_to > clock_timestamp() THEN
    RAISE EXCEPTION '% valid_to cannot be in the future', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Every vehicle has exactly one current owner when a transaction commits. Checked at commit
-- (deferred) because a transfer closes the old row before inserting the new one, and a new vehicle
-- is inserted before its first ownership row. Plates have no such rule: a vehicle may be left
-- without a plate when its plate moves to another vehicle (OD-1).
CREATE FUNCTION vehicle_has_one_current_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  current_owners integer;
BEGIN
  -- Separate branches: PL/pgSQL resolves NEW.<field> even in the arm of a CASE that is not taken.
  IF TG_TABLE_NAME = 'vehicle' THEN
    target := NEW.id;
  ELSE
    target := NEW.vehicle_id;
  END IF;
  SELECT count(*) INTO current_owners
    FROM vehicle_ownership
   WHERE vehicle_id = target AND valid_to IS NULL;
  IF current_owners <> 1 THEN
    RAISE EXCEPTION 'vehicle % must have exactly one current owner (found %)', target, current_owners
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER vehicle_ownership_one_current
  AFTER INSERT OR UPDATE ON vehicle_ownership
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vehicle_has_one_current_owner();

CREATE CONSTRAINT TRIGGER vehicle_has_owner
  AFTER INSERT ON vehicle
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vehicle_has_one_current_owner();

-- Same as 0003: invoker rights, nothing new granted to garage_app.
REVOKE ALL ON FUNCTION vehicle_has_one_current_owner() FROM PUBLIC;
