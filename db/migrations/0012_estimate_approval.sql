-- I1-05b — Send the estimate, canonical snapshot, in-person approval. Runs as garage_owner.
-- Spec: v0.2.1 §2.2 (ApprovalEvent, RevisionDecision), §3.1 (Draft → Sent → Closed), §3.3 (job authorization),
-- v0.2 §5 (repair order Awaiting approval → In progress), Amendment A.4 (contact snapshot), P0-11 (canonical snapshot,
-- displayed language and terms versions). Decisions OD-20, OD-21, OD-25, T-21, T-22.
-- Every check below reads repair-order, version and revision state without row locks: the commands that change
-- those states lock the repair order first, which serialises them. The content hash is computed by the
-- application (canonical JSON, which jsonb's own text form does not reproduce); tests re-hash stored snapshots.

-- ---------------------------------------------------------------------------
-- Terms text (P0-11 #4): versioned per language, never edited. Nothing is seeded: the wording comes from the owners
-- and their lawyer (OD-20, V-4); until then a snapshot records "no terms".
-- ---------------------------------------------------------------------------
CREATE TABLE terms_text (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('estimate')),
  language    text NOT NULL CHECK (language IN ('ar', 'en')),
  version_no  integer NOT NULL CHECK (version_no >= 1),
  body        text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES app_user (id),
  UNIQUE (kind, language, version_no)
);

-- ---------------------------------------------------------------------------
-- Sent versions carry their frozen snapshot and its hash (P0-11 #1–#2).
-- ---------------------------------------------------------------------------
ALTER TABLE estimate_version
  ADD COLUMN sent_at       timestamptz,
  ADD COLUMN sent_by       uuid REFERENCES app_user (id),
  ADD COLUMN expires_at    timestamptz,
  ADD COLUMN snapshot      jsonb,
  ADD COLUMN content_hash  text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN terms_ar_id   uuid REFERENCES terms_text (id),
  ADD COLUMN terms_en_id   uuid REFERENCES terms_text (id),
  ADD CONSTRAINT estimate_version_sent_complete CHECK (
    (status = 'draft') = (sent_at IS NULL)
    AND (sent_at IS NULL) = (snapshot IS NULL)
    AND (sent_at IS NULL) = (content_hash IS NULL)
    AND (sent_at IS NULL) = (expires_at IS NULL)
  );

CREATE FUNCTION estimate_version_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.estimate_id <> OLD.estimate_id OR NEW.version_no <> OLD.version_no
     OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'estimate version % keeps its identity', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'sent' THEN
    IF NOT estimate_draft_open(OLD.id) THEN
      RAISE EXCEPTION 'only an open draft is sent' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.snapshot IS NULL OR NEW.content_hash IS NULL OR NEW.sent_by IS NULL OR NEW.expires_at IS NULL
       OR NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'a sent version carries its snapshot, hash, sender and a future expiry'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (NEW.terms_ar_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM terms_text WHERE id = NEW.terms_ar_id AND language = 'ar'))
       OR (NEW.terms_en_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM terms_text WHERE id = NEW.terms_en_id AND language = 'en')) THEN
      RAISE EXCEPTION 'terms texts are recorded for their own language' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.sent_at := now();
    RETURN NEW;
  END IF;
  -- After sending, the evidence never changes.
  IF NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.sent_by IS DISTINCT FROM OLD.sent_by
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.terms_ar_id IS DISTINCT FROM OLD.terms_ar_id
     OR NEW.terms_en_id IS DISTINCT FROM OLD.terms_en_id THEN
    RAISE EXCEPTION 'a sent version''s snapshot is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'sent' AND NEW.status = 'closed' THEN
    IF EXISTS (SELECT 1 FROM job_revision WHERE proposed_in_version_id = OLD.id AND status = 'pending') THEN
      RAISE EXCEPTION 'a version closes only when nothing is pending' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- Withdrawal and expiry arrive with I2-01.
  RAISE EXCEPTION 'estimate version % cannot go from % to %', OLD.id, OLD.status, NEW.status
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER estimate_version_transition BEFORE UPDATE ON estimate_version
  FOR EACH ROW EXECUTE FUNCTION estimate_version_transition();

-- ---------------------------------------------------------------------------
-- Approval evidence (insert-only).
-- ---------------------------------------------------------------------------
CREATE TABLE approval_event (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_version_id     uuid NOT NULL REFERENCES estimate_version (id),
  method                  text NOT NULL CHECK (method IN ('in_person_signature', 'link', 'phone', 'garage_reduction')),
  verification_level      text NOT NULL CHECK (verification_level IN ('possession', 'step_up', 'in_person')),
  approver_name           text NOT NULL CHECK (length(btrim(approver_name)) BETWEEN 1 AND 200),
  signature_sha256        text CHECK (signature_sha256 IS NULL OR signature_sha256 ~ '^[0-9a-f]{64}$'),
  signature_storage_key   text CHECK (signature_storage_key IS NULL OR length(signature_storage_key) BETWEEN 1 AND 300),
  signature_content_type  text CHECK (signature_content_type IS NULL OR signature_content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  -- A.4: the authorized contact in effect when the event was created.
  contact_name            text NOT NULL,
  contact_mobile          text NOT NULL,
  displayed_language      text NOT NULL CHECK (displayed_language IN ('ar', 'en')),
  terms_ar_id             uuid REFERENCES terms_text (id),
  terms_en_id             uuid REFERENCES terms_text (id),
  content_hash            text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key         text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 100),
  recorded_by             uuid REFERENCES app_user (id),
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  business_date           date NOT NULL,
  -- I1-05b records only in-person signatures (L3); other methods arrive with I2.
  CHECK (method <> 'in_person_signature' OR (verification_level = 'in_person' AND signature_sha256 IS NOT NULL
         AND signature_storage_key IS NOT NULL AND signature_content_type IS NOT NULL))
);
CREATE INDEX approval_event_version_idx ON approval_event (estimate_version_id);

CREATE TABLE revision_decision (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_event_id    uuid NOT NULL REFERENCES approval_event (id),
  revision_id          uuid NOT NULL UNIQUE REFERENCES job_revision (id),
  decision             text NOT NULL CHECK (decision IN ('approved', 'declined')),
  -- OD-25: an urgent job declined in person waits for the declined-urgent acknowledgment (I2-07).
  urgent_ack_pending   boolean NOT NULL DEFAULT false,
  CHECK (NOT urgent_ack_pending OR decision = 'declined')
);
CREATE INDEX revision_decision_event_idx ON revision_decision (approval_event_id);

CREATE FUNCTION approval_event_guard() RETURNS trigger
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
  IF NEW.method <> 'in_person_signature' THEN
    RAISE EXCEPTION 'only in-person approvals are recorded yet' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.recorded_at := now();
  NEW.business_date := business_date_of(now());
  RETURN NEW;
END;
$$;
CREATE TRIGGER approval_event_guard BEFORE INSERT ON approval_event
  FOR EACH ROW EXECUTE FUNCTION approval_event_guard();

CREATE FUNCTION revision_decision_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  urgent boolean;
BEGIN
  -- §2.4: the decided revision was proposed in the event's own version, and is still pending.
  IF NOT EXISTS (SELECT 1 FROM job_revision r JOIN approval_event a ON a.estimate_version_id = r.proposed_in_version_id
                 WHERE r.id = NEW.revision_id AND a.id = NEW.approval_event_id AND r.status = 'pending') THEN
    RAISE EXCEPTION 'a decision is for a pending revision of the approved version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(f.severity = 'urgent', false) INTO urgent
    FROM job_revision r JOIN repair_job j ON j.id = r.job_id LEFT JOIN finding f ON f.id = j.finding_id
   WHERE r.id = NEW.revision_id;
  IF NEW.urgent_ack_pending <> (NEW.decision = 'declined' AND urgent) THEN
    RAISE EXCEPTION 'urgent_ack_pending marks exactly the declined urgent jobs (OD-25)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_decision_guard BEFORE INSERT ON revision_decision
  FOR EACH ROW EXECUTE FUNCTION revision_decision_guard();

-- At commit, a decided revision carries its decision: a decision row never sits beside a revision left Pending.
CREATE FUNCTION revision_decision_applied() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM job_revision WHERE id = NEW.revision_id AND status = NEW.decision) THEN
    RAISE EXCEPTION 'revision % was not moved to its decision', NEW.revision_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER revision_decision_applied AFTER INSERT ON revision_decision
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION revision_decision_applied();

-- ---------------------------------------------------------------------------
-- Revisions: Draft → Pending on send; Pending → Approved/Declined only with the matching decision.
-- The insert guard from 0011 stays; updates get their own guard.
-- ---------------------------------------------------------------------------
DROP TRIGGER job_revision_guard ON job_revision;
CREATE TRIGGER job_revision_guard BEFORE INSERT ON job_revision
  FOR EACH ROW EXECUTE FUNCTION estimate_draft_guard();

CREATE FUNCTION job_revision_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.job_id <> OLD.job_id OR NEW.revision_no <> OLD.revision_no OR NEW.kind <> OLD.kind
     OR NEW.proposed_in_version_id <> OLD.proposed_in_version_id OR NEW.created_at <> OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.lapse_reason IS DISTINCT FROM OLD.lapse_reason THEN
    RAISE EXCEPTION 'job revision % keeps its identity', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'pending' THEN
    IF NOT EXISTS (SELECT 1 FROM estimate_version WHERE id = OLD.proposed_in_version_id AND status = 'sent')
       OR NOT EXISTS (SELECT 1 FROM repair_job WHERE id = OLD.job_id AND removed_at IS NULL) THEN
      RAISE EXCEPTION 'a revision becomes pending when its version is sent' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'declined') THEN
    IF NOT EXISTS (SELECT 1 FROM revision_decision WHERE revision_id = OLD.id AND decision = NEW.status) THEN
      RAISE EXCEPTION 'a revision is decided only by a recorded decision' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'job revision % cannot go from % to %', OLD.id, OLD.status, NEW.status
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER job_revision_transition BEFORE UPDATE ON job_revision
  FOR EACH ROW EXECUTE FUNCTION job_revision_transition();

-- ---------------------------------------------------------------------------
-- Jobs: draft removal keeps the 0011 rules; execution status leaves Not authorized only with an approved
-- revision (AC2-01). I1-06 adds the workshop transitions.
-- ---------------------------------------------------------------------------
DROP TRIGGER repair_job_guard ON repair_job;
CREATE TRIGGER repair_job_guard BEFORE INSERT ON repair_job
  FOR EACH ROW EXECUTE FUNCTION estimate_draft_guard();

CREATE FUNCTION repair_job_update_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.repair_order_id <> OLD.repair_order_id OR NEW.title <> OLD.title
     OR NEW.finding_id IS DISTINCT FROM OLD.finding_id OR NEW.job_type <> OLD.job_type
     OR NEW.charge_type <> OLD.charge_type OR NEW.created_at <> OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'repair job % cannot change this way', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.execution_status <> OLD.execution_status THEN
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a removed job has no execution' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT (OLD.execution_status = 'not_authorized' AND NEW.execution_status = 'authorized') THEN
      RAISE EXCEPTION 'job % cannot go from % to %', OLD.id, OLD.execution_status, NEW.execution_status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM job_revision WHERE job_id = OLD.id AND status = 'approved') THEN
      RAISE EXCEPTION 'job % has no approved revision: unapproved work cannot start (AC2-01)', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.execution_status = OLD.execution_status AND NEW.removed_at IS NULL THEN
    -- Nothing else is updated on a job (removed_by, updated_by alone would forge the record).
    RAISE EXCEPTION 'a job update is a removal or an authorization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.removed_at IS NOT NULL THEN
    -- Removal: only a draft job of an open draft, as in 0011.
    IF NOT EXISTS (SELECT 1 FROM job_revision r WHERE r.job_id = OLD.id AND r.status = 'draft'
                   AND estimate_draft_open(r.proposed_in_version_id)) THEN
      RAISE EXCEPTION 'the estimate is not an open draft' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.removed_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER repair_job_update_guard BEFORE UPDATE ON repair_job
  FOR EACH ROW EXECUTE FUNCTION repair_job_update_guard();

-- ---------------------------------------------------------------------------
-- Repair order: Awaiting approval needs a sent estimate; In progress needs an approved job (v0.2 §5).
-- ---------------------------------------------------------------------------
CREATE FUNCTION repair_order_estimate_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'awaiting_approval' AND NOT (
       OLD.status IN ('checked_in', 'diagnosing')
       AND EXISTS (SELECT 1 FROM estimate e JOIN estimate_version v ON v.estimate_id = e.id
                   WHERE e.repair_order_id = OLD.id AND v.status = 'sent')) THEN
    RAISE EXCEPTION 'a repair order awaits approval only once its estimate is sent' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'in_progress' AND NOT (
       OLD.status = 'awaiting_approval'
       AND EXISTS (SELECT 1 FROM repair_job j JOIN job_revision r ON r.job_id = j.id
                   WHERE j.repair_order_id = OLD.id AND r.status = 'approved')) THEN
    RAISE EXCEPTION 'a repair order is in progress only with approved work (AC2-01)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repair_order_estimate_transition BEFORE UPDATE OF status ON repair_order
  FOR EACH ROW EXECUTE FUNCTION repair_order_estimate_transition();

REVOKE ALL ON FUNCTION estimate_version_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION approval_event_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION revision_decision_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION revision_decision_applied() FROM PUBLIC;
REVOKE ALL ON FUNCTION job_revision_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION repair_job_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION repair_order_estimate_transition() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants. Evidence is insert-only; terms text is read-only for the app (no editing screen yet).
-- ---------------------------------------------------------------------------
GRANT SELECT ON terms_text TO garage_app;
GRANT SELECT, INSERT ON approval_event, revision_decision TO garage_app;
GRANT UPDATE (status, sent_at, sent_by, expires_at, snapshot, content_hash, terms_ar_id, terms_en_id)
  ON estimate_version TO garage_app;
GRANT UPDATE (status) ON job_revision TO garage_app;
GRANT UPDATE (execution_status) ON repair_job TO garage_app;
