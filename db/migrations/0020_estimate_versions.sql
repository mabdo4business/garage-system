-- I2-01 — Estimate versions: later versions, withdraw, expire, discard, offering a job again. Runs as garage_owner.
-- Spec: v0.2.1 §2.1 #4–#6 (carry-forward is display only; lapsed revisions are not reused; one open revision per
-- job), §3.1 (version states), §3.2 (partial decisions, withdrawal, expiry), §5 (approval vs withdrawal race, expiry
-- at submission time), AC21-05, AC21-06, AC21-07. Decisions OD-55 (lapsed and declined jobs may be offered again),
-- OD-56 (later versions while Awaiting approval or In progress), OD-57 (withdrawal reasons), OD-58 (urgent findings
-- in every version), OD-59 (no QC over an unsent draft), T-37.
-- As in 0011/0012, the checks read repair-order, version and revision state without row locks: every command that
-- changes those states locks the repair order first (T-19), which also settles the approval-vs-withdrawal race.

-- ---------------------------------------------------------------------------
-- How a version ended (insert-only evidence): withdrawn by staff with a reason, expired (by the system or at the
-- moment someone acted on it), or a draft discarded before sending.
-- ---------------------------------------------------------------------------
CREATE TABLE estimate_version_end (
  estimate_version_id  uuid PRIMARY KEY REFERENCES estimate_version (id),
  outcome              text NOT NULL CHECK (outcome IN ('withdrawn', 'expired', 'discarded')),
  reason_code          text CHECK (reason_code IS NULL OR reason_code IN ('no_response', 'needs_changes', 'other')),
  reason               text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  ended_by             uuid REFERENCES app_user (id),
  ended_at             timestamptz NOT NULL DEFAULT now(),
  -- OD-57: a withdrawal names its reason; "other" needs the text.
  CHECK ((outcome = 'withdrawn') = (reason_code IS NOT NULL)),
  CHECK (reason_code IS DISTINCT FROM 'other' OR reason IS NOT NULL),
  CHECK (outcome = 'expired' OR ended_by IS NOT NULL)
);

CREATE FUNCTION estimate_version_end_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v record;
BEGIN
  SELECT status, expires_at, version_no INTO v FROM estimate_version WHERE id = NEW.estimate_version_id;
  IF (NEW.outcome IN ('withdrawn', 'expired') AND v.status IS DISTINCT FROM 'sent')
     OR (NEW.outcome = 'discarded' AND (v.status IS DISTINCT FROM 'draft' OR v.version_no < 2)) THEN
    RAISE EXCEPTION 'version % cannot end as %', NEW.estimate_version_id, NEW.outcome
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.outcome = 'expired' AND v.expires_at > now() THEN
    RAISE EXCEPTION 'version % has not expired yet', NEW.estimate_version_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.ended_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER estimate_version_end_guard BEFORE INSERT ON estimate_version_end
  FOR EACH ROW EXECUTE FUNCTION estimate_version_end_guard();

-- A discarded draft was never sent: "not a draft" no longer means "sent" (0012).
ALTER TABLE estimate_version DROP CONSTRAINT estimate_version_sent_complete;
ALTER TABLE estimate_version ADD CONSTRAINT estimate_version_sent_complete CHECK (
  (status IN ('draft', 'discarded')) = (sent_at IS NULL)
  AND (sent_at IS NULL) = (snapshot IS NULL)
  AND (sent_at IS NULL) = (content_hash IS NULL)
  AND (sent_at IS NULL) = (expires_at IS NULL)
);

-- ---------------------------------------------------------------------------
-- Drafts may now be edited while the repair order is Awaiting approval or In progress (OD-56): that is where
-- version 2 onwards lives. Version 1 is still started only while Checked-in or Diagnosing (estimate_guard and
-- estimate_version_guard below).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estimate_draft_open(version_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM estimate_version v
                 JOIN estimate e ON e.id = v.estimate_id
                 JOIN repair_order ro ON ro.id = e.repair_order_id
                 WHERE v.id = version_id AND v.status = 'draft'
                   AND ro.status IN ('checked_in', 'diagnosing', 'awaiting_approval', 'in_progress'));
$$;

CREATE OR REPLACE FUNCTION estimate_version_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  ro_status text;
  latest int;
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'an estimate version starts as a draft' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ro.status INTO ro_status FROM estimate e JOIN repair_order ro ON ro.id = e.repair_order_id
   WHERE e.id = NEW.estimate_id;
  SELECT max(version_no) INTO latest FROM estimate_version WHERE estimate_id = NEW.estimate_id;
  IF latest IS NULL THEN
    IF NEW.version_no <> 1 OR ro_status NOT IN ('checked_in', 'diagnosing') THEN
      RAISE EXCEPTION 'estimates are drafted only while the repair order is checked in or diagnosing'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    -- §3.1: a later version follows the latest one, once that one has ended (the open-version index keeps
    -- at most one draft or sent version).
    IF NEW.version_no <> latest + 1 OR ro_status NOT IN ('awaiting_approval', 'in_progress')
       OR EXISTS (SELECT 1 FROM estimate_version WHERE estimate_id = NEW.estimate_id AND status IN ('draft', 'sent')) THEN
      RAISE EXCEPTION 'a new version follows an ended one while the repair order awaits approval or is in progress'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Version transitions: 0012's send and close, plus withdraw, expire (with their end row) and discard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estimate_version_transition() RETURNS trigger
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
  IF (OLD.status = 'sent' AND NEW.status IN ('withdrawn', 'expired'))
     OR (OLD.status = 'draft' AND NEW.status = 'discarded') THEN
    IF NOT EXISTS (SELECT 1 FROM estimate_version_end WHERE estimate_version_id = OLD.id AND outcome = NEW.status) THEN
      RAISE EXCEPTION 'version % ends as % only with its recorded end', OLD.id, NEW.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'estimate version % cannot go from % to %', OLD.id, OLD.status, NEW.status
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- At commit, an ended version leaves nothing awaiting a decision: withdrawn and expired versions have no pending
-- revision (they lapsed), a discarded draft has no draft revision. (A job removed from a draft before sending keeps
-- its never-sent draft revision, as in 0011; only a discarded version takes those along.)
CREATE FUNCTION estimate_version_ended_clean() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('withdrawn', 'expired', 'discarded') AND EXISTS (
       SELECT 1 FROM job_revision r JOIN repair_job j ON j.id = r.job_id
        WHERE r.proposed_in_version_id = NEW.id AND r.status IN ('draft', 'pending')
          AND (j.removed_at IS NULL OR NEW.status = 'discarded')) THEN
    RAISE EXCEPTION 'version % ended with revisions still open', NEW.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER estimate_version_ended_clean AFTER UPDATE OF status ON estimate_version
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION estimate_version_ended_clean();

-- ---------------------------------------------------------------------------
-- Revisions: a draft taken out before sending is Discarded (kept, never deleted).
-- ---------------------------------------------------------------------------
ALTER TABLE job_revision DROP CONSTRAINT job_revision_status_check;
ALTER TABLE job_revision ADD CONSTRAINT job_revision_status_check
  CHECK (status IN ('draft', 'pending', 'approved', 'declined', 'lapsed', 'discarded'));

-- Inserting a revision: numbered in sequence; until amendments (I2-02) every revision is an "Original" proposal of
-- a job with nothing approved. A second one offers again a job whose last proposal was declined or lapsed (OD-55,
-- §2.1 #5); the one-open-revision index (0011) keeps it the only open one.
CREATE FUNCTION job_revision_sequence_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  latest record;
BEGIN
  SELECT revision_no, status INTO latest FROM job_revision WHERE job_id = NEW.job_id
   ORDER BY revision_no DESC LIMIT 1;
  IF NEW.kind <> 'original' THEN
    RAISE EXCEPTION 'amendments arrive with I2-02' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF latest IS NULL THEN
    IF NEW.revision_no <> 1 THEN
      RAISE EXCEPTION 'a job''s first revision is number 1' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.revision_no <> latest.revision_no + 1
        OR EXISTS (SELECT 1 FROM job_revision WHERE job_id = NEW.job_id AND status IN ('approved', 'draft', 'pending'))
        OR NOT EXISTS (SELECT 1 FROM job_revision WHERE job_id = NEW.job_id AND status IN ('declined', 'lapsed')) THEN
    RAISE EXCEPTION 'only a declined or lapsed job is offered again, as its next revision'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_revision_sequence_guard BEFORE INSERT ON job_revision
  FOR EACH ROW EXECUTE FUNCTION job_revision_sequence_guard();

CREATE OR REPLACE FUNCTION job_revision_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  version_status text;
BEGIN
  IF NEW.id <> OLD.id OR NEW.job_id <> OLD.job_id OR NEW.revision_no <> OLD.revision_no OR NEW.kind <> OLD.kind
     OR NEW.proposed_in_version_id <> OLD.proposed_in_version_id OR NEW.created_at <> OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'job revision % keeps its identity', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.lapse_reason IS DISTINCT FROM OLD.lapse_reason AND NOT (OLD.status = 'pending' AND NEW.status = 'lapsed') THEN
    RAISE EXCEPTION 'a lapse reason is set only when a revision lapses' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO version_status FROM estimate_version WHERE id = OLD.proposed_in_version_id;
  IF OLD.status = 'draft' AND NEW.status = 'pending' THEN
    IF version_status IS DISTINCT FROM 'sent'
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
  -- §3.1: when a version is withdrawn or expires, what is still pending lapses for that reason; never a decided one.
  IF OLD.status = 'pending' AND NEW.status = 'lapsed' THEN
    IF version_status NOT IN ('withdrawn', 'expired') OR NEW.lapse_reason IS DISTINCT FROM version_status THEN
      RAISE EXCEPTION 'a revision lapses only with its version''s withdrawal or expiry' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- A draft is discarded with its discarded version, or taken out of an open draft when it offered a job again
  -- (the job and its history stay; a job new in the draft is removed instead).
  IF OLD.status = 'draft' AND NEW.status = 'discarded' THEN
    IF version_status = 'discarded' OR (estimate_draft_open(OLD.proposed_in_version_id) AND OLD.revision_no > 1) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'revision % is not discarded this way', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION 'job revision % cannot go from % to %', OLD.id, OLD.status, NEW.status
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ---------------------------------------------------------------------------
-- A job with history is never removed: only a job whose every revision is still a draft (new in the open draft).
-- ---------------------------------------------------------------------------
CREATE FUNCTION repair_job_removal_history_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL
     AND EXISTS (SELECT 1 FROM job_revision WHERE job_id = OLD.id AND status <> 'draft') THEN
    RAISE EXCEPTION 'job % has history; take its draft revision out instead', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repair_job_removal_history_guard BEFORE UPDATE OF removed_at ON repair_job
  FOR EACH ROW EXECUTE FUNCTION repair_job_removal_history_guard();

-- ---------------------------------------------------------------------------
-- OD-59: QC is not requested while a later version is an unsent draft (it would be stranded: drafts are edited,
-- sent or discarded only until QC).
-- ---------------------------------------------------------------------------
CREATE FUNCTION repair_order_qc_draft_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'qc' AND OLD.status <> 'qc'
     AND EXISTS (SELECT 1 FROM estimate e JOIN estimate_version v ON v.estimate_id = e.id
                 WHERE e.repair_order_id = OLD.id AND v.status = 'draft') THEN
    RAISE EXCEPTION 'repair order % has an unsent estimate draft; send or discard it before QC', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repair_order_qc_draft_guard BEFORE UPDATE OF status ON repair_order
  FOR EACH ROW EXECUTE FUNCTION repair_order_qc_draft_guard();

REVOKE ALL ON FUNCTION repair_order_qc_draft_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION estimate_version_end_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION estimate_version_ended_clean() FROM PUBLIC;
REVOKE ALL ON FUNCTION job_revision_sequence_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION repair_job_removal_history_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants: the end record is insert-only evidence; a revision's lapse reason is set with its lapse.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON estimate_version_end TO garage_app;
GRANT UPDATE (lapse_reason) ON job_revision TO garage_app;
