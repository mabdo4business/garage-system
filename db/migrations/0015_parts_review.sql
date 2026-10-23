-- I1-07 integrity review fixes. Runs as garage_owner.
-- Adds checks next to 0014's (no 0014 function is replaced): whole quantities on movements (OD-22), receipts
-- only into active parts (OD-34), every stock issue lands on a job line, pool basis consistent with the pool, and
-- Waiting parts set only by an active assignee or active staff handling parts (OD-29).

-- ---------------------------------------------------------------------------
-- OD-22 on movements: only hour, litre, kg and metre take fractions (as estimate lines, migration 0011).
-- OD-34: stock is received only into an active part.
-- ---------------------------------------------------------------------------
CREATE FUNCTION stock_movement_rules() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  item record;
BEGIN
  SELECT unit, active INTO item FROM catalogue_item WHERE id = NEW.item_id;
  IF NEW.qty <> trunc(NEW.qty) AND item.unit IS DISTINCT FROM 'litre' AND item.unit IS DISTINCT FROM 'kg'
     AND item.unit IS DISTINCT FROM 'metre' THEN
    RAISE EXCEPTION 'this part is counted in whole units (OD-22)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'receipt' AND NOT item.active THEN
    RAISE EXCEPTION 'stock is received only into an active part (OD-34)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stock_movement_rules BEFORE INSERT ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION stock_movement_rules();

CREATE FUNCTION line_cost_movement_rules() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.qty <> trunc(NEW.qty) AND NOT EXISTS (
       SELECT 1 FROM revision_line WHERE id = NEW.revision_line_id AND unit IN ('hour', 'litre', 'kg', 'metre')) THEN
    RAISE EXCEPTION 'this line is counted in whole units (OD-22)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER line_cost_movement_rules BEFORE INSERT ON line_cost_movement
  FOR EACH ROW EXECUTE FUNCTION line_cost_movement_rules();

-- ---------------------------------------------------------------------------
-- At commit, every stock issue has put its cost on the job line (value never leaves stock for nowhere).
-- ---------------------------------------------------------------------------
CREATE FUNCTION stock_issue_reaches_line() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'issue' AND NOT EXISTS (SELECT 1 FROM line_cost_movement WHERE stock_movement_id = NEW.id) THEN
    RAISE EXCEPTION 'stock issue % has no job-line cost', NEW.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER stock_issue_reaches_line AFTER INSERT ON stock_movement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_issue_reaches_line();

-- ---------------------------------------------------------------------------
-- Pool basis (Amendment §A.1): empty pools have no basis; a basis covers at least what is held.
-- ---------------------------------------------------------------------------
ALTER TABLE stock_balance
  ADD CONSTRAINT stock_balance_basis CHECK ((qty = 0) = (basis_qty = 0) AND basis_qty >= qty AND (basis_qty > 0 OR basis_value = 0));
ALTER TABLE line_wip
  ADD CONSTRAINT line_wip_basis CHECK ((qty = 0) = (basis_qty = 0) AND basis_qty >= qty AND (basis_qty > 0 OR basis_value = 0));

-- The basis changes only together with an inbound movement in the same transaction (pool rule 1).
CREATE FUNCTION pool_basis_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.basis_qty IS DISTINCT FROM OLD.basis_qty OR NEW.basis_value IS DISTINCT FROM OLD.basis_value)
     AND NEW.qty > 0 AND NEW.qty <= OLD.qty THEN
    -- Outbound (or no) quantity change with a moved basis: only allowed as the pool empties (rule 3).
    RAISE EXCEPTION 'a pool''s basis changes only when units enter it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.qty > OLD.qty AND (NEW.basis_qty <> NEW.qty OR NEW.basis_value <> NEW.value) THEN
    RAISE EXCEPTION 'after units enter, the basis is the pool''s totals' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stock_balance_basis_guard BEFORE UPDATE ON stock_balance
  FOR EACH ROW EXECUTE FUNCTION pool_basis_guard();
CREATE TRIGGER line_wip_basis_guard BEFORE UPDATE ON line_wip
  FOR EACH ROW EXECUTE FUNCTION pool_basis_guard();

CREATE FUNCTION line_wip_insert_basis() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.basis_qty <> NEW.qty OR NEW.basis_value <> NEW.value THEN
    RAISE EXCEPTION 'a new line pool''s basis is its totals' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER line_wip_insert_basis BEFORE INSERT ON line_wip
  FOR EACH ROW EXECUTE FUNCTION line_wip_insert_basis();

-- ---------------------------------------------------------------------------
-- Waiting parts by an active assignee, or active staff handling parts. Keep the role list in step with
-- PERMISSIONS["stock.issue"] in src/server/auth/permissions.ts (OD-29).
-- ---------------------------------------------------------------------------
CREATE FUNCTION repair_job_waiting_parts_actor() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.execution_status = 'waiting_parts' OR NEW.execution_status = 'waiting_parts')
     AND NEW.execution_status IS DISTINCT FROM OLD.execution_status
     AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.updated_by AND status = 'active') THEN
    RAISE EXCEPTION 'waiting parts is changed by an active user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repair_job_waiting_parts_actor BEFORE UPDATE OF execution_status ON repair_job
  FOR EACH ROW EXECUTE FUNCTION repair_job_waiting_parts_actor();

REVOKE ALL ON FUNCTION stock_movement_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION line_cost_movement_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_issue_reaches_line() FROM PUBLIC;
REVOKE ALL ON FUNCTION pool_basis_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION line_wip_insert_basis() FROM PUBLIC;
REVOKE ALL ON FUNCTION repair_job_waiting_parts_actor() FROM PUBLIC;
