-- I2-03b — Approval through the customer link. Runs as garage_owner.
-- Spec: PRD v0.2 §6.4 ("after use", "evidence captured": typed name, timestamp, IP, user agent, version ID, content
-- hash, per-job decisions), AC2-02, AC2-03, AC21-05, AC21-07, Amendment A.4 (lock the repair order first; contact
-- snapshot). Decisions OD-60 (typed name, link possession L1), OD-61 (name recorded, not matched), OD-62 (any amount
-- until I2-04), T-44.

-- ---------------------------------------------------------------------------
-- Evidence of a link approval: the link used, and the IP and browser it came from. Only link approvals carry them.
-- ---------------------------------------------------------------------------
ALTER TABLE approval_event ADD COLUMN customer_link_id uuid REFERENCES customer_link (id);
ALTER TABLE approval_event ADD COLUMN ip text CHECK (ip IS NULL OR length(ip) BETWEEN 1 AND 64);
ALTER TABLE approval_event ADD COLUMN user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 500);
ALTER TABLE approval_event ADD CONSTRAINT approval_event_link_evidence CHECK (
  (method = 'link') = (customer_link_id IS NOT NULL)
  AND (customer_link_id IS NULL) = (ip IS NULL)
  AND (method <> 'link' OR (verification_level = 'possession' AND recorded_by IS NULL))
);
CREATE INDEX approval_event_link_idx ON approval_event (customer_link_id) WHERE customer_link_id IS NOT NULL;

-- The guard from 0012, now also accepting link approvals: through a live link to this very version, unexpired.
CREATE OR REPLACE FUNCTION approval_event_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v record;
BEGIN
  SELECT ev.status, ev.content_hash, ev.expires_at, ev.terms_ar_id, ev.terms_en_id, ro.contact_name, ro.contact_mobile,
         ro.status AS ro_status
    INTO v
    FROM estimate_version ev JOIN estimate e ON e.id = ev.estimate_id JOIN repair_order ro ON ro.id = e.repair_order_id
   WHERE ev.id = NEW.estimate_version_id;
  IF v.status IS DISTINCT FROM 'sent' OR v.expires_at <= now()
     OR v.ro_status NOT IN ('awaiting_approval', 'in_progress') THEN
    RAISE EXCEPTION 'approvals are recorded only on a sent, unexpired version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.content_hash <> v.content_hash OR NEW.terms_ar_id IS DISTINCT FROM v.terms_ar_id
     OR NEW.terms_en_id IS DISTINCT FROM v.terms_en_id THEN
    RAISE EXCEPTION 'an approval is for exactly the content that was sent' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.contact_name <> v.contact_name OR NEW.contact_mobile <> v.contact_mobile THEN
    RAISE EXCEPTION 'an approval records the authorized contact in effect' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.method NOT IN ('in_person_signature', 'link') THEN
    RAISE EXCEPTION 'only in-person and link approvals are recorded yet' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.method = 'link' AND NOT EXISTS (
       SELECT 1 FROM customer_link l
        WHERE l.id = NEW.customer_link_id AND l.estimate_version_id = NEW.estimate_version_id
          AND l.revoked_at IS NULL AND l.expires_at > now()) THEN
    RAISE EXCEPTION 'a link approval comes through a live link to its own version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.recorded_at := now();
  NEW.business_date := business_date_of(now());
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION approval_event_guard() FROM PUBLIC;
-- Grants unchanged: approval_event stays SELECT, INSERT for garage_app (0012).

-- ---------------------------------------------------------------------------
-- A decision submitted through a link is recorded as a request too, so submissions count toward the link's
-- request limit (T-42) like openings; staff's "opened" count still counts openings only.
-- ---------------------------------------------------------------------------
ALTER TABLE customer_link_access DROP CONSTRAINT customer_link_access_outcome_check;
ALTER TABLE customer_link_access ADD CONSTRAINT customer_link_access_outcome_check
  CHECK (outcome IN ('opened', 'invalid', 'submitted'));
