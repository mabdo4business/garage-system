-- I2-06 — Authorized contact change. Runs as garage_owner.
-- Spec: Final Consistency Review F-10 (P0), Amendment A.4 ("contact change"), Pre-Impl P1-06, v0.2.1 §3.7 (L2 or L3
-- to change the authorized contact), test T-08. Decisions OD-64 (in person or callback), OD-65 (owner or current
-- contact authorizes), OD-66 (advisor, manager, partner), OD-67 (reason), T-45.
-- The contact changes only through a recorded change: inserting a contact_change row applies the new contact and
-- revokes every live link of the repair order in the same transaction (F-10), so no code path can do one without
-- the other. Pending ApprovalAttempts are voided here too once they exist (I2-04).

CREATE TABLE contact_change (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_order_id         uuid NOT NULL REFERENCES repair_order (id),
  old_name                text NOT NULL,
  old_mobile              text NOT NULL,
  old_relationship        text NOT NULL,
  new_name                text NOT NULL CHECK (length(btrim(new_name)) BETWEEN 1 AND 200),
  new_mobile              text NOT NULL CHECK (length(new_mobile) BETWEEN 6 AND 20),
  new_relationship        text NOT NULL CHECK (new_relationship IN ('owner', 'driver', 'company_representative', 'other')),
  reason                  text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  authorized_by           text NOT NULL CHECK (authorized_by IN ('owner', 'current_contact')),
  verification            text NOT NULL CHECK (verification IN ('in_person', 'callback')),
  -- In person (L3): who signed, and the signature (evidence, stored apart from photos like approval signatures).
  signer_name             text CHECK (signer_name IS NULL OR length(btrim(signer_name)) BETWEEN 1 AND 200),
  signature_sha256        text CHECK (signature_sha256 IS NULL OR signature_sha256 ~ '^[0-9a-f]{64}$'),
  signature_storage_key   text CHECK (signature_storage_key IS NULL OR length(signature_storage_key) BETWEEN 1 AND 300),
  signature_content_type  text CHECK (signature_content_type IS NULL OR signature_content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  -- Callback (L2): the number on file that was called, when, and who answered.
  called_number           text CHECK (called_number IS NULL OR length(called_number) BETWEEN 6 AND 20),
  called_at               timestamptz,
  spoken_to               text CHECK (spoken_to IS NULL OR length(btrim(spoken_to)) BETWEEN 1 AND 200),
  idempotency_key         text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 100),
  changed_by              uuid NOT NULL REFERENCES app_user (id),
  changed_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (verification = 'in_person'
       AND signer_name IS NOT NULL AND signature_sha256 IS NOT NULL AND signature_storage_key IS NOT NULL
       AND signature_content_type IS NOT NULL AND called_number IS NULL AND called_at IS NULL AND spoken_to IS NULL)
    OR
    (verification = 'callback'
       AND called_number IS NOT NULL AND called_at IS NOT NULL AND spoken_to IS NOT NULL
       AND signer_name IS NULL AND signature_sha256 IS NULL AND signature_storage_key IS NULL
       AND signature_content_type IS NULL)
  )
);
CREATE INDEX contact_change_repair_order_idx ON contact_change (repair_order_id, changed_at);

-- Links revoked by a contact change say so.
ALTER TABLE customer_link DROP CONSTRAINT customer_link_revoke_reason_check;
ALTER TABLE customer_link ADD CONSTRAINT customer_link_revoke_reason_check
  CHECK (revoke_reason IS NULL OR revoke_reason IN ('manual', 'replaced', 'contact_changed'));

-- ---------------------------------------------------------------------------
-- Applying a change. SECURITY DEFINER: the app role may not update the contact columns itself, only record a change;
-- search_path pinned (as job_status_history, 0013).
-- ---------------------------------------------------------------------------
CREATE FUNCTION contact_change_apply() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ro record;
  owner_mobile text;
BEGIN
  -- Locked here too, so two changes from the same contact can never both pass the check below (the command also
  -- locks the repair order first).
  SELECT r.status, r.contact_name, r.contact_mobile, r.contact_relationship, r.customer_id INTO ro
    FROM repair_order r WHERE r.id = NEW.repair_order_id FOR UPDATE;
  IF ro.status IN ('delivered', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'the contact of a delivered, closed or cancelled repair order does not change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The change replaces the contact the form showed, not one changed since.
  IF (NEW.old_name, NEW.old_mobile, NEW.old_relationship)
     IS DISTINCT FROM (ro.contact_name, ro.contact_mobile, ro.contact_relationship) THEN
    RAISE EXCEPTION 'the change must start from the current contact' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.verification = 'callback' THEN
    SELECT c.mobile INTO owner_mobile FROM customer c WHERE c.id = ro.customer_id;
    -- OD-65: the number on file of the person who authorized it, not one given during the call.
    IF NEW.called_number IS DISTINCT FROM
       (CASE NEW.authorized_by WHEN 'owner' THEN owner_mobile ELSE ro.contact_mobile END) THEN
      RAISE EXCEPTION 'a callback goes to the authorizing person''s mobile on file' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- T-45: the call happened, recently [assumption — confirm before UAT].
    IF NEW.called_at > now() OR NEW.called_at < now() - interval '24 hours' THEN
      RAISE EXCEPTION 'the callback was within the last 24 hours' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  NEW.changed_at := now();

  UPDATE repair_order
     SET contact_name = NEW.new_name, contact_mobile = NEW.new_mobile, contact_relationship = NEW.new_relationship
   WHERE id = NEW.repair_order_id;
  -- F-10: every live link of the repair order stops working with the change.
  UPDATE customer_link
     SET revoked_at = now(), revoked_by = NEW.changed_by, revoke_reason = 'contact_changed'
   WHERE repair_order_id = NEW.repair_order_id AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contact_change_apply BEFORE INSERT ON contact_change
  FOR EACH ROW EXECUTE FUNCTION contact_change_apply();

REVOKE ALL ON FUNCTION contact_change_apply() FROM PUBLIC;

-- Insert-only evidence; the app still has no UPDATE on the repair order's contact columns.
GRANT SELECT, INSERT ON contact_change TO garage_app;
