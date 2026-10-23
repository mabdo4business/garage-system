-- I1-08 — Quality check. Runs as garage_owner.
-- Spec: PRD v0.2 §B1 (In progress → QC → In progress on fail; Ready needs a QC pass), §G (QC record and checklist),
-- GAP-47 (old parts disposition), GAP-48 (odometer out, road test), AC2-25, AC2-26, v0.2.1 §3.2 QC guard.
-- Decisions OD-36, OD-37 (D-8), OD-38, OD-39, T-26, T-27. Commands lock the repair order first; the checks below read
-- state without row locks and rely on that.

INSERT INTO app_setting (key, value) VALUES ('qc.different_person', 'true');

-- ---------------------------------------------------------------------------
-- QC records: requested (pending), then decided once — passed or failed.
-- ---------------------------------------------------------------------------
CREATE TABLE qc_record (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_order_id         uuid NOT NULL REFERENCES repair_order (id),
  status                  text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed')),
  requested_by            uuid REFERENCES app_user (id),
  requested_at            timestamptz NOT NULL DEFAULT now(),
  no_new_warning_lights   boolean,
  road_test               text CHECK (road_test IS NULL OR road_test IN ('done', 'not_applicable')),
  road_test_reason        text CHECK (road_test_reason IS NULL OR length(btrim(road_test_reason)) BETWEEN 1 AND 500),
  odometer_out_km         integer CHECK (odometer_out_km IS NULL OR odometer_out_km BETWEEN 0 AND 2000000),
  odometer_reason         text CHECK (odometer_reason IS NULL OR length(btrim(odometer_reason)) BETWEEN 1 AND 500),
  fluids_ok               boolean,
  cleanliness_ok          boolean,
  belongings_ok           boolean,
  old_parts               text CHECK (old_parts IS NULL OR old_parts IN ('returned_to_customer', 'disposed', 'kept_for_claim', 'none_replaced')),
  notes                   text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  decided_by              uuid REFERENCES app_user (id),
  decided_at              timestamptz,
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'pending') = (decided_by IS NULL)),
  CHECK (status <> 'failed' OR notes IS NOT NULL),
  CHECK (road_test IS DISTINCT FROM 'not_applicable' OR road_test_reason IS NOT NULL)
);
CREATE UNIQUE INDEX qc_record_one_pending ON qc_record (repair_order_id) WHERE status = 'pending';
CREATE INDEX qc_record_repair_order_idx ON qc_record (repair_order_id, requested_at);

CREATE FUNCTION qc_record_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  ro record;
BEGIN
  SELECT status, odometer_km INTO ro FROM repair_order WHERE id = NEW.repair_order_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR ro.status IS DISTINCT FROM 'qc' THEN
      RAISE EXCEPTION 'a QC record starts pending, on a repair order in QC' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- OD-36: requested by a manager or partner, or by someone holding a job on this repair order.
    IF NOT EXISTS (SELECT 1 FROM app_user u JOIN user_role r ON r.user_id = u.id
                   WHERE u.id = NEW.requested_by AND u.status = 'active' AND r.role IN ('manager', 'partner'))
       AND NOT EXISTS (SELECT 1 FROM job_assignment a JOIN repair_job j ON j.id = a.job_id
                       WHERE j.repair_order_id = NEW.repair_order_id AND a.assignee_id = NEW.requested_by
                         AND a.ended_at IS NULL) THEN
      RAISE EXCEPTION 'QC is requested by a manager, a partner or a technician on the job (OD-36)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.repair_order_id <> OLD.repair_order_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at OR OLD.status <> 'pending' OR NEW.status = 'pending' THEN
    RAISE EXCEPTION 'a QC record is decided once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ro.status IS DISTINCT FROM 'qc' THEN
    RAISE EXCEPTION 'QC is decided while the repair order is in QC' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- OD-36: managers and partners decide.
  IF NOT EXISTS (SELECT 1 FROM app_user u JOIN user_role r ON r.user_id = u.id
                 WHERE u.id = NEW.decided_by AND u.status = 'active' AND r.role IN ('manager', 'partner')) THEN
    RAISE EXCEPTION 'QC is decided by an active manager or partner (OD-36)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'passed' THEN
    IF NOT (COALESCE(NEW.no_new_warning_lights, false) AND COALESCE(NEW.fluids_ok, false)
            AND COALESCE(NEW.cleanliness_ok, false) AND COALESCE(NEW.belongings_ok, false))
       OR NEW.road_test IS NULL OR NEW.old_parts IS NULL OR NEW.odometer_out_km IS NULL THEN
      RAISE EXCEPTION 'every QC check is confirmed before a pass (PRD v0.2 §G)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.odometer_out_km < ro.odometer_km AND NEW.odometer_reason IS NULL THEN
      RAISE EXCEPTION 'odometer out below check-in needs a reason (GAP-48)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- AC2-26 / OD-37: not by anyone assigned to the work while the setting is on.
    IF (SELECT value FROM app_setting WHERE key = 'qc.different_person') = 'true'::jsonb
       AND EXISTS (SELECT 1 FROM job_assignment a JOIN repair_job j ON j.id = a.job_id
                   WHERE j.repair_order_id = NEW.repair_order_id AND a.assignee_id = NEW.decided_by) THEN
      RAISE EXCEPTION 'QC is passed by someone other than who did the work (AC2-26)' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER qc_record_guard BEFORE INSERT OR UPDATE ON qc_record
  FOR EACH ROW EXECUTE FUNCTION qc_record_guard();

-- At commit, a repair order that entered QC has its pending record.
CREATE FUNCTION repair_order_qc_has_record() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'qc' AND OLD.status IS DISTINCT FROM 'qc'
     AND NOT EXISTS (SELECT 1 FROM qc_record WHERE repair_order_id = NEW.id AND status = 'pending') THEN
    RAISE EXCEPTION 'repair order % entered QC without a QC record', NEW.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER repair_order_qc_has_record AFTER UPDATE OF status ON repair_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION repair_order_qc_has_record();

-- ---------------------------------------------------------------------------
-- Repair order transitions (replaces 0012's function): QC and back, and Ready only after a pass.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION repair_order_estimate_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  latest text;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  SELECT status INTO latest FROM qc_record WHERE repair_order_id = OLD.id ORDER BY requested_at DESC, id DESC LIMIT 1;
  IF NEW.status = 'awaiting_approval' AND NOT (
       OLD.status IN ('checked_in', 'diagnosing')
       AND EXISTS (SELECT 1 FROM estimate e JOIN estimate_version v ON v.estimate_id = e.id
                   WHERE e.repair_order_id = OLD.id AND v.status = 'sent')) THEN
    RAISE EXCEPTION 'a repair order awaits approval only once its estimate is sent' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'in_progress' AND NOT (
       (OLD.status = 'awaiting_approval'
        AND EXISTS (SELECT 1 FROM repair_job j JOIN job_revision r ON r.job_id = j.id
                    WHERE j.repair_order_id = OLD.id AND r.status = 'approved'))
       OR (OLD.status = 'qc' AND latest = 'failed')) THEN
    RAISE EXCEPTION 'a repair order is in progress only with approved work, or after a failed QC' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'qc' THEN
    -- B1 and v0.2.1 §3.2: every approved job done, no version awaiting a decision (AC2-25), nothing waiting parts.
    IF OLD.status <> 'in_progress'
       OR EXISTS (SELECT 1 FROM repair_job j WHERE j.repair_order_id = OLD.id AND j.removed_at IS NULL
                   AND j.execution_status NOT IN ('done', 'stopped_by_customer')
                   AND EXISTS (SELECT 1 FROM job_revision r WHERE r.job_id = j.id AND r.status = 'approved'))
       OR EXISTS (SELECT 1 FROM estimate e JOIN estimate_version v ON v.estimate_id = e.id
                   WHERE e.repair_order_id = OLD.id AND v.status = 'sent') THEN
      RAISE EXCEPTION 'QC needs every approved job done and no estimate awaiting a decision' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF OLD.status = 'qc' AND NEW.status NOT IN ('in_progress', 'ready', 'cancelled') THEN
    RAISE EXCEPTION 'a repair order leaves QC only back to work, to Ready or cancelled' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'ready' AND NOT (OLD.status = 'qc' AND latest = 'passed') THEN
    -- The invoice condition is added with I1-09.
    RAISE EXCEPTION 'a repair order is ready only after a QC pass' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Rework after a failed QC (T-26): line outcomes are superseded (kept), the job goes Done → Approved.
-- ---------------------------------------------------------------------------
ALTER TABLE job_line_outcome ADD COLUMN superseded_at timestamptz;
ALTER TABLE job_line_outcome DROP CONSTRAINT job_line_outcome_revision_line_id_key;
CREATE UNIQUE INDEX job_line_outcome_one_live ON job_line_outcome (revision_line_id) WHERE superseded_at IS NULL;

CREATE FUNCTION job_line_outcome_supersede_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.job_id <> OLD.job_id OR NEW.revision_line_id <> OLD.revision_line_id
     OR NEW.outcome <> OLD.outcome OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.recorded_by <> OLD.recorded_by
     OR NEW.recorded_at <> OLD.recorded_at OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'an outcome is only superseded, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only by a QC failure decided in this transaction on the job's repair order.
  IF NOT EXISTS (SELECT 1 FROM qc_record q JOIN repair_job j ON j.repair_order_id = q.repair_order_id
                 WHERE j.id = OLD.job_id AND q.status = 'failed' AND q.decided_at = now()) THEN
    RAISE EXCEPTION 'outcomes are superseded only by a failed QC' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.superseded_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_line_outcome_supersede_guard BEFORE UPDATE ON job_line_outcome
  FOR EACH ROW EXECUTE FUNCTION job_line_outcome_supersede_guard();

-- Job update guard (replaces 0014's): adds Done → Authorized after a failed QC (T-26); "done" counts live outcomes.
CREATE OR REPLACE FUNCTION repair_job_update_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  from_to text;
BEGIN
  IF NEW.id <> OLD.id OR NEW.repair_order_id <> OLD.repair_order_id OR NEW.title <> OLD.title
     OR NEW.finding_id IS DISTINCT FROM OLD.finding_id OR NEW.job_type <> OLD.job_type
     OR NEW.charge_type <> OLD.charge_type OR NEW.created_at <> OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'repair job % cannot change this way', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.execution_status = OLD.execution_status THEN
    IF NEW.removed_at IS NULL OR NEW.execution_reason IS DISTINCT FROM OLD.execution_reason THEN
      RAISE EXCEPTION 'a job update is a removal or a status change' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Removal: only a draft job of an open draft, as in 0011.
    IF NOT EXISTS (SELECT 1 FROM job_revision r WHERE r.job_id = OLD.id AND r.status = 'draft'
                   AND estimate_draft_open(r.proposed_in_version_id)) THEN
      RAISE EXCEPTION 'the estimate is not an open draft' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.removed_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.removed_at IS NOT NULL OR NEW.removed_by IS DISTINCT FROM OLD.removed_by THEN
    RAISE EXCEPTION 'a status change does not touch removal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- AC2-01: nothing leaves Not authorized without an approved revision.
  IF NOT EXISTS (SELECT 1 FROM job_revision WHERE job_id = OLD.id AND status = 'approved') THEN
    RAISE EXCEPTION 'job % has no approved revision: unapproved work cannot start (AC2-01)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  from_to := OLD.execution_status || '>' || NEW.execution_status;
  IF from_to = 'not_authorized>authorized' THEN
    NULL;
  ELSIF from_to = 'done>authorized' THEN
    -- T-26: returned for rework by the checker of a QC failed in this transaction; its outcomes superseded.
    IF NOT EXISTS (SELECT 1 FROM qc_record WHERE repair_order_id = OLD.repair_order_id AND status = 'failed'
                   AND decided_at = now() AND decided_by = NEW.updated_by)
       OR EXISTS (SELECT 1 FROM job_line_outcome WHERE job_id = OLD.id AND superseded_at IS NULL) THEN
      RAISE EXCEPTION 'a done job is reopened only by a failed QC (T-26)' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF from_to IN ('authorized>in_progress', 'paused>in_progress', 'in_progress>paused', 'in_progress>done',
                    'authorized>waiting_parts', 'waiting_parts>authorized') THEN
    IF from_to IN ('authorized>waiting_parts', 'waiting_parts>authorized') THEN
      IF NOT EXISTS (SELECT 1 FROM job_assignment WHERE job_id = OLD.id AND ended_at IS NULL
                     AND assignee_id = NEW.updated_by)
         AND NOT EXISTS (SELECT 1 FROM user_role WHERE user_id = NEW.updated_by
                         AND role IN ('store_keeper', 'service_advisor', 'manager', 'partner')) THEN
        RAISE EXCEPTION 'waiting parts is set by the assignee or by staff handling parts (OD-29)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM job_assignment WHERE job_id = OLD.id AND ended_at IS NULL
                      AND assignee_id = NEW.updated_by) THEN
      RAISE EXCEPTION 'only the assignee changes a job''s status (OD-27)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM repair_order WHERE id = OLD.repair_order_id AND status = 'in_progress') THEN
      RAISE EXCEPTION 'work runs only while the repair order is in progress' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF from_to = 'in_progress>paused' AND NEW.execution_reason IS NULL THEN
      RAISE EXCEPTION 'a pause needs a reason (v0.2.1 §3.3)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF from_to = 'in_progress>done' AND NEW.execution_reason IS NULL THEN
      RAISE EXCEPTION 'Done needs a completion note (OD-31)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF from_to = 'in_progress>done' AND EXISTS (
         SELECT 1 FROM job_authorized_lines(OLD.id) AS line(id)
          WHERE NOT EXISTS (SELECT 1 FROM job_line_outcome o WHERE o.revision_line_id = line.id
                            AND o.superseded_at IS NULL)) THEN
      RAISE EXCEPTION 'every authorized line is done or not performed before the job is done'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    RAISE EXCEPTION 'job % cannot go from % to %', OLD.id, OLD.execution_status, NEW.execution_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION done_job_keeps_outcomes() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM repair_job j WHERE j.id = NEW.job_id AND j.execution_status = 'done'
               AND EXISTS (SELECT 1 FROM job_authorized_lines(j.id) AS line(id)
                           WHERE NOT EXISTS (SELECT 1 FROM job_line_outcome o WHERE o.revision_line_id = line.id
                                             AND o.superseded_at IS NULL))) THEN
    RAISE EXCEPTION 'a done job keeps an outcome for every authorized line' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER done_job_keeps_outcomes AFTER UPDATE ON job_line_outcome
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION done_job_keeps_outcomes();

REVOKE ALL ON FUNCTION done_job_keeps_outcomes() FROM PUBLIC;
REVOKE ALL ON FUNCTION qc_record_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION repair_order_qc_has_record() FROM PUBLIC;
REVOKE ALL ON FUNCTION job_line_outcome_supersede_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants. A QC record is inserted pending and decided once (columns below only); nothing is deleted.
-- ---------------------------------------------------------------------------
GRANT SELECT ON qc_record TO garage_app;
GRANT INSERT (repair_order_id, requested_by) ON qc_record TO garage_app;
GRANT UPDATE (status, no_new_warning_lights, road_test, road_test_reason, odometer_out_km, odometer_reason, fluids_ok,
              cleanliness_ok, belongings_ok, old_parts, notes, decided_by, decided_at) ON qc_record TO garage_app;
GRANT UPDATE (superseded_at) ON job_line_outcome TO garage_app;
