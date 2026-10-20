-- I1-01 review fixes (finding 6). Runs as garage_owner.
--
-- 0002 grants garage_app UPDATE (valid_to) on vehicle_plate / vehicle_ownership and UPDATE (colour)
-- on vehicle. Those grants exist so commands can close a validity window and so
-- SELECT ... FOR UPDATE (ctx.locks) works — PostgreSQL requires UPDATE privilege for row locks.
-- Column grants alone would still let the app role rewrite closed history or reopen an old row,
-- so these triggers narrow them to exactly what the commands do. Row locks do not fire UPDATE
-- triggers, so ctx.locks.acquire("vehicle", …) is unaffected.

-- A history row may be closed once (valid_to NULL → a value) and never changed afterwards.
CREATE FUNCTION history_row_close_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL THEN
    RAISE EXCEPTION '% rows are append-only: valid_to may only be set once', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vehicle_plate_close_once
  BEFORE UPDATE ON vehicle_plate
  FOR EACH ROW EXECUTE FUNCTION history_row_close_once();

CREATE TRIGGER vehicle_ownership_close_once
  BEFORE UPDATE ON vehicle_ownership
  FOR EACH ROW EXECUTE FUNCTION history_row_close_once();

-- No command edits a vehicle yet; UPDATE (colour) is only there for the row lock. A story that
-- adds vehicle editing replaces this trigger in its own migration.
CREATE FUNCTION vehicle_lock_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vehicle rows cannot be updated yet (UPDATE is granted for row locks only)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER vehicle_lock_only
  BEFORE UPDATE ON vehicle
  FOR EACH ROW EXECUTE FUNCTION vehicle_lock_only();

-- Trigger functions run with the invoker's rights; garage_app needs nothing new and gets nothing.
REVOKE ALL ON FUNCTION history_row_close_once() FROM PUBLIC;
REVOKE ALL ON FUNCTION vehicle_lock_only() FROM PUBLIC;
