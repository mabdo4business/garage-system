-- I1-04 integrity review fixes. Runs as garage_owner.
--
-- OD-16: tax history only moves forward. A new profile, or a new rate for a code, may start in the past
-- but never on or before the latest one already recorded. Inserts take a transaction-scoped advisory
-- lock first, so two concurrent inserts cannot both pass the check.

CREATE FUNCTION tax_history_forward_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'tax_profile' THEN
    PERFORM pg_advisory_xact_lock(hashtext('tax_profile'));
    IF EXISTS (SELECT 1 FROM tax_profile WHERE effective_from >= NEW.effective_from) THEN
      RAISE EXCEPTION 'a tax profile must start after the latest one (OD-16)' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('tax_code_rate:' || NEW.code));
    IF EXISTS (SELECT 1 FROM tax_code_rate WHERE code = NEW.code AND effective_from >= NEW.effective_from) THEN
      RAISE EXCEPTION 'a rate must start after the latest one for this code (OD-16)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tax_profile_forward_only BEFORE INSERT ON tax_profile
  FOR EACH ROW EXECUTE FUNCTION tax_history_forward_only();
CREATE TRIGGER tax_code_rate_forward_only BEFORE INSERT ON tax_code_rate
  FOR EACH ROW EXECUTE FUNCTION tax_history_forward_only();
REVOKE ALL ON FUNCTION tax_history_forward_only() FROM PUBLIC;

-- Tax codes: the database stamps their creation time, and labels are not edited in place (no command
-- does so; the spec treats tax codes as history).
CREATE TRIGGER tax_code_stamp BEFORE INSERT ON tax_code
  FOR EACH ROW EXECUTE FUNCTION catalogue_stamp_now();
REVOKE UPDATE (label_en, label_ar, active) ON tax_code FROM garage_app;
