-- I1-09b — Printed invoice: the garage's business profile. Runs as garage_owner.
-- Spec: v0.2.1 §4.4, PRD v0.2 §D1. Decisions OD-42 (partner-entered profile, titles), OD-46 (versions kept, the
-- invoice records the one in force at issue), OD-47 (no invoice without a profile), T-33 (phone format).

-- ---------------------------------------------------------------------------
-- Business profile: insert-only versions. Each new version names the one it replaces; one first version and one
-- successor per version keep the history a single chain, so two partners saving from the same version cannot both
-- win (the second insert hits the unique index and is asked to reload).
-- ---------------------------------------------------------------------------
CREATE TABLE business_profile (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supersedes_id  uuid UNIQUE REFERENCES business_profile (id),
  legal_name_en  text NOT NULL CHECK (length(btrim(legal_name_en)) BETWEEN 1 AND 200),
  legal_name_ar  text NOT NULL CHECK (length(btrim(legal_name_ar)) BETWEEN 1 AND 200),
  address_en     text NOT NULL CHECK (length(btrim(address_en)) BETWEEN 1 AND 500),
  address_ar     text NOT NULL CHECK (length(btrim(address_ar)) BETWEEN 1 AND 500),
  phone          text NOT NULL CHECK (phone ~ '^\+?[0-9][0-9 -]{4,28}[0-9]$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES app_user (id),
  CHECK (supersedes_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX business_profile_single_root ON business_profile ((true)) WHERE supersedes_id IS NULL;

CREATE TRIGGER business_profile_stamp BEFORE INSERT ON business_profile
  FOR EACH ROW EXECUTE FUNCTION catalogue_stamp_now();

-- ---------------------------------------------------------------------------
-- OD-46/OD-47: an invoice records the profile version in force at issue, set here from the latest version
-- whatever the caller sent; no profile, no invoice. Invoices issued before this migration keep NULL (NOT VALID).
-- ---------------------------------------------------------------------------
ALTER TABLE invoice ADD COLUMN business_profile_id uuid REFERENCES business_profile (id);
ALTER TABLE invoice ADD CONSTRAINT invoice_business_profile_required
  CHECK (business_profile_id IS NOT NULL) NOT VALID;

CREATE FUNCTION invoice_business_profile() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.business_profile_id := (
    SELECT p.id FROM business_profile p
     WHERE NOT EXISTS (SELECT 1 FROM business_profile n WHERE n.supersedes_id = p.id));
  IF NEW.business_profile_id IS NULL THEN
    RAISE EXCEPTION 'enter the business profile before issuing invoices (OD-47)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoice_business_profile BEFORE INSERT ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_business_profile();

REVOKE ALL ON FUNCTION invoice_business_profile() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants: versions are history — SELECT, INSERT only. invoice keeps SELECT, INSERT (the new column is set by the
-- trigger).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON business_profile TO garage_app;
