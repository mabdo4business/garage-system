-- I1-03 integrity review fixes. Runs as garage_owner. The database rules hold even if the app code
-- were wrong (rule 6), so they mirror what the inspection commands check.

-- An inspection is assigned only while the repair order is in inspection (the command checks this too).
CREATE FUNCTION inspection_assignment_open_repair_order() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM repair_order WHERE id = NEW.repair_order_id
                 AND status IN ('checked_in', 'diagnosing')) THEN
    RAISE EXCEPTION 'inspections are assigned only while the repair order is checked in or diagnosing'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inspection_assignment_open_repair_order
  BEFORE INSERT ON inspection_assignment
  FOR EACH ROW EXECUTE FUNCTION inspection_assignment_open_repair_order();

-- Withdrawing a finding records the reason only; its content stays as it was. Timestamps are the
-- database's, not the caller's.
CREATE FUNCTION finding_update_rules() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'withdrawn' AND OLD.status = 'active'
     AND (NEW.title, NEW.severity, NEW.fault_codes, NEW.customer_note, NEW.internal_note, NEW.template_item_id)
         IS DISTINCT FROM
         (OLD.title, OLD.severity, OLD.fault_codes, OLD.customer_note, OLD.internal_note, OLD.template_item_id) THEN
    RAISE EXCEPTION 'withdrawing finding % cannot change its content', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER finding_update_rules
  BEFORE UPDATE ON finding
  FOR EACH ROW EXECUTE FUNCTION finding_update_rules();

-- A checklist item is recorded once per repair order (two tablets could otherwise both record it, T-12).
CREATE UNIQUE INDEX finding_one_per_checklist_item ON finding (repair_order_id, template_item_id)
  WHERE status = 'active' AND template_item_id IS NOT NULL;

-- When a photo is discarded, locked or excluded, the time is now — never a caller-chosen date.
CREATE FUNCTION media_asset_stamp_times() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.discarded_at IS NULL AND NEW.discarded_at IS NOT NULL THEN
    NEW.discarded_at := now();
  END IF;
  IF OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL THEN
    NEW.locked_at := now();
  END IF;
  IF OLD.excluded_at IS NULL AND NEW.excluded_at IS NOT NULL THEN
    NEW.excluded_at := now();
  END IF;
  RETURN NEW;
END;
$$;
-- Named to run after media_asset_guard (triggers fire in name order).
CREATE TRIGGER media_asset_stamp_times
  BEFORE UPDATE ON media_asset
  FOR EACH ROW EXECUTE FUNCTION media_asset_stamp_times();

REVOKE ALL ON FUNCTION inspection_assignment_open_repair_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION finding_update_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION media_asset_stamp_times() FROM PUBLIC;
