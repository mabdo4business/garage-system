-- I1-06 — Workshop execution, and the OQ-1 check-in warning. Runs as garage_owner.
-- Spec: PRD v0.1 EP-07 (US-07.1–07.4, AC-07.3, AC-07.4), PRD v0.2 B2 (job statuses) and #39 (bay as a label),
-- AC2-01, AC2-30, v0.2.1 §3.3 (Authorized → In progress ↔ Paused → Done; Done needs every authorized line complete
-- or "not performed" with a reason). Decisions OD-26, OD-27, OQ-1.
-- The checks read job and repair-order state without row locks; every command that changes them locks the repair
-- order first, which serialises them.

-- ---------------------------------------------------------------------------
-- Authorized scope in the database (v0.2.1 §2.1 #7): lines of approved revisions, minus lines superseded by a line
-- of another approved revision.
-- ---------------------------------------------------------------------------
CREATE FUNCTION job_authorized_lines(job uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE AS $$
  SELECT l.id FROM revision_line l JOIN job_revision r ON r.id = l.revision_id
   WHERE r.job_id = job AND r.status = 'approved' AND l.removed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM revision_line s JOIN job_revision sr ON sr.id = s.revision_id
                     WHERE s.supersedes_line_id = l.id AND sr.status = 'approved');
$$;
REVOKE ALL ON FUNCTION job_authorized_lines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_authorized_lines(uuid) TO garage_app;

-- ---------------------------------------------------------------------------
-- Assignment: one live assignee per job (OD-26); history kept (ended, never deleted).
-- ---------------------------------------------------------------------------
CREATE TABLE job_assignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES repair_job (id),
  assignee_id  uuid NOT NULL REFERENCES app_user (id),
  bay          text CHECK (bay IS NULL OR length(btrim(bay)) BETWEEN 1 AND 20),
  assigned_by  uuid REFERENCES app_user (id),
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  ended_by     uuid REFERENCES app_user (id),
  ended_at     timestamptz,
  CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
CREATE UNIQUE INDEX job_assignment_one_live ON job_assignment (job_id) WHERE ended_at IS NULL;
CREATE INDEX job_assignment_assignee_idx ON job_assignment (assignee_id) WHERE ended_at IS NULL;

CREATE FUNCTION job_assignment_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL THEN
      RAISE EXCEPTION 'an assignment starts live' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM repair_job WHERE id = NEW.job_id AND removed_at IS NULL
                   AND execution_status IN ('authorized', 'in_progress', 'paused')) THEN
      RAISE EXCEPTION 'only authorized, unfinished jobs are assigned' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- OD-27: assignees are technicians, managers or partners.
    IF NOT EXISTS (SELECT 1 FROM app_user u JOIN user_role r ON r.user_id = u.id
                   WHERE u.id = NEW.assignee_id AND u.status = 'active'
                     AND r.role IN ('technician', 'manager', 'partner')) THEN
      RAISE EXCEPTION 'a job is assigned to an active technician, manager or partner' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.assigned_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.job_id <> OLD.job_id OR NEW.assignee_id <> OLD.assignee_id
     OR NEW.bay IS DISTINCT FROM OLD.bay OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
     OR NEW.assigned_at <> OLD.assigned_at OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'an assignment is only ended, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.ended_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_assignment_guard BEFORE INSERT OR UPDATE ON job_assignment
  FOR EACH ROW EXECUTE FUNCTION job_assignment_guard();

-- ---------------------------------------------------------------------------
-- Line outcomes at completion (§3.3 Done): every authorized line is done or not performed with a reason.
-- ---------------------------------------------------------------------------
CREATE TABLE job_line_outcome (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES repair_job (id),
  revision_line_id  uuid NOT NULL UNIQUE REFERENCES revision_line (id),
  outcome           text NOT NULL CHECK (outcome IN ('done', 'not_performed')),
  reason            text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  recorded_by       uuid NOT NULL REFERENCES app_user (id),
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'not_performed') = (reason IS NOT NULL))
);
CREATE INDEX job_line_outcome_job_idx ON job_line_outcome (job_id);

CREATE FUNCTION job_line_outcome_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM repair_job WHERE id = NEW.job_id AND execution_status = 'in_progress')
     OR NEW.revision_line_id NOT IN (SELECT job_authorized_lines(NEW.job_id))
     OR NOT EXISTS (SELECT 1 FROM job_assignment WHERE job_id = NEW.job_id AND ended_at IS NULL
                    AND assignee_id = NEW.recorded_by) THEN
    RAISE EXCEPTION 'outcomes are recorded by the assignee for authorized lines of a job in progress'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_line_outcome_guard BEFORE INSERT ON job_line_outcome
  FOR EACH ROW EXECUTE FUNCTION job_line_outcome_guard();

-- ---------------------------------------------------------------------------
-- Execution history, written by the database itself on every status change (insert-only for everyone else).
-- ---------------------------------------------------------------------------
ALTER TABLE repair_job
  ADD COLUMN execution_reason text CHECK (execution_reason IS NULL OR length(btrim(execution_reason)) BETWEEN 1 AND 500);

CREATE TABLE job_status_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES repair_job (id),
  from_status  text NOT NULL,
  to_status    text NOT NULL,
  reason       text,
  actor_id     uuid REFERENCES app_user (id),
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_status_event_job_idx ON job_status_event (job_id, occurred_at);

-- SECURITY DEFINER so the history is written even though the app role may not insert into it; search_path pinned.
CREATE FUNCTION job_status_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO job_status_event (job_id, from_status, to_status, reason, actor_id)
  VALUES (NEW.id, OLD.execution_status, NEW.execution_status, NEW.execution_reason, NEW.updated_by);
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_status_history AFTER UPDATE OF execution_status ON repair_job
  FOR EACH ROW WHEN (OLD.execution_status IS DISTINCT FROM NEW.execution_status)
  EXECUTE FUNCTION job_status_history();

-- ---------------------------------------------------------------------------
-- Job update guard (replaces 0012's): removal of a draft job, authorization by an approved decision, and the
-- workshop transitions, each by the live assignee (OD-27; the actor is updated_by).
-- ---------------------------------------------------------------------------
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

  IF NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed job has no execution' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- AC2-01: nothing leaves Not authorized without an approved revision.
  IF NOT EXISTS (SELECT 1 FROM job_revision WHERE job_id = OLD.id AND status = 'approved') THEN
    RAISE EXCEPTION 'job % has no approved revision: unapproved work cannot start (AC2-01)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  from_to := OLD.execution_status || '>' || NEW.execution_status;
  IF from_to = 'not_authorized>authorized' THEN
    NULL;
  ELSIF from_to IN ('authorized>in_progress', 'paused>in_progress', 'in_progress>paused', 'in_progress>done') THEN
    IF NOT EXISTS (SELECT 1 FROM job_assignment WHERE job_id = OLD.id AND ended_at IS NULL
                   AND assignee_id = NEW.updated_by) THEN
      RAISE EXCEPTION 'only the assignee changes a job''s status (OD-27)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM repair_order WHERE id = OLD.repair_order_id AND status = 'in_progress') THEN
      RAISE EXCEPTION 'work runs only while the repair order is in progress' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF from_to = 'in_progress>paused' AND NEW.execution_reason IS NULL THEN
      RAISE EXCEPTION 'a pause needs a reason (v0.2.1 §3.3)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF from_to = 'in_progress>done' AND EXISTS (
         SELECT 1 FROM job_authorized_lines(OLD.id) AS line(id)
          WHERE NOT EXISTS (SELECT 1 FROM job_line_outcome o WHERE o.revision_line_id = line.id)) THEN
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

-- ---------------------------------------------------------------------------
-- OQ-1: a second open repair order for the same vehicle is allowed, after the advisor confirms the open one.
-- ---------------------------------------------------------------------------
ALTER TABLE repair_order
  ADD COLUMN duplicate_open_ack text CHECK (duplicate_open_ack IS NULL OR length(duplicate_open_ack) BETWEEN 1 AND 40);

CREATE FUNCTION repair_order_open_duplicate_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  open_number text;
BEGIN
  SELECT number INTO open_number FROM repair_order
   WHERE vehicle_id = NEW.vehicle_id AND status NOT IN ('delivered', 'closed', 'cancelled')
   ORDER BY checked_in_at DESC LIMIT 1;
  IF open_number IS NULL AND NEW.duplicate_open_ack IS NOT NULL THEN
    RAISE EXCEPTION 'there is no open repair order to confirm' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF open_number IS NOT NULL AND NEW.duplicate_open_ack IS DISTINCT FROM open_number THEN
    RAISE EXCEPTION 'the vehicle has open repair order %; confirm it first (OQ-1)', open_number
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repair_order_open_duplicate_guard BEFORE INSERT ON repair_order
  FOR EACH ROW EXECUTE FUNCTION repair_order_open_duplicate_guard();

REVOKE ALL ON FUNCTION job_assignment_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION job_line_outcome_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION job_status_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION repair_order_open_duplicate_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants. Outcomes are insert-only; the status history is written only by the trigger above.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON job_assignment TO garage_app;
GRANT UPDATE (ended_at, ended_by) ON job_assignment TO garage_app;
GRANT SELECT, INSERT ON job_line_outcome TO garage_app;
GRANT SELECT ON job_status_event TO garage_app;
GRANT UPDATE (execution_reason) ON repair_job TO garage_app;
