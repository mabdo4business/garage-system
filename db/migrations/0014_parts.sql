-- I1-07 — Parts for a job (simple). Runs as garage_owner.
-- Spec: Amendment v0.2.2 §A.1 (pool rule: stock pool per part, job-line WIP pool per revision line), PRD v0.2 §F
-- (movements; no negative stock; Waiting parts or Receive-and-issue on shortage), B2 (Approved ↔ Waiting parts),
-- v0.2.1 §3.3 stock issue guard (authorized, non-frozen line; over-issue only with a reason), AC2-13, AC2-14,
-- Pre-Impl P0-06 #3 and B-08 (non-stock cost on the line). Decisions OD-28–OD-31, T-23–T-25.
-- Pool arithmetic happens in the application (src/server/core/pool.ts); the database checks that every balance
-- equals the sum of its movements and never goes negative. Commands lock repair order → revision line → stock
-- balance, so the unlocked reads below are serialised.

-- ---------------------------------------------------------------------------
-- Stock pool per stock-tracked part.
-- ---------------------------------------------------------------------------
CREATE TABLE stock_balance (
  item_id      uuid PRIMARY KEY REFERENCES catalogue_item (id),
  qty          numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  value        numeric(14,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  basis_qty    numeric(18,3) NOT NULL DEFAULT 0 CHECK (basis_qty >= 0),
  basis_value  numeric(14,2) NOT NULL DEFAULT 0 CHECK (basis_value >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Pool rule 3: an empty pool holds no value.
  CHECK (qty > 0 OR value = 0)
);

CREATE TABLE stock_movement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           uuid NOT NULL REFERENCES stock_balance (item_id),
  kind              text NOT NULL CHECK (kind IN ('receipt', 'issue')),
  qty               numeric(18,3) NOT NULL CHECK (qty > 0),
  value             numeric(14,2) NOT NULL CHECK (value >= 0),
  supplier_name     text CHECK (supplier_name IS NULL OR length(btrim(supplier_name)) BETWEEN 1 AND 200),
  supplier_ref      text CHECK (supplier_ref IS NULL OR length(btrim(supplier_ref)) BETWEEN 1 AND 100),
  revision_line_id  uuid REFERENCES revision_line (id),
  created_by        uuid REFERENCES app_user (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  business_date     date NOT NULL,
  CHECK ((kind = 'receipt') = (supplier_name IS NOT NULL AND supplier_ref IS NOT NULL)),
  CHECK ((kind = 'issue') = (revision_line_id IS NOT NULL))
);
CREATE INDEX stock_movement_item_idx ON stock_movement (item_id, created_at);

-- Every stock-tracked part has its pool row from the start (so commands can lock it).
CREATE FUNCTION stock_balance_for_new_part() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stock_tracked THEN
    INSERT INTO stock_balance (item_id) VALUES (NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER stock_balance_for_new_part AFTER INSERT ON catalogue_item
  FOR EACH ROW EXECUTE FUNCTION stock_balance_for_new_part();
INSERT INTO stock_balance (item_id) SELECT id FROM catalogue_item WHERE stock_tracked;

CREATE FUNCTION stock_balance_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.qty <> 0 OR NEW.value <> 0 OR NEW.basis_qty <> 0 OR NEW.basis_value <> 0
       OR NOT EXISTS (SELECT 1 FROM catalogue_item WHERE id = NEW.item_id AND stock_tracked) THEN
      RAISE EXCEPTION 'a stock pool starts empty, for a stock-tracked part' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.item_id <> OLD.item_id THEN
    RAISE EXCEPTION 'a stock pool keeps its part' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER stock_balance_guard BEFORE INSERT OR UPDATE ON stock_balance
  FOR EACH ROW EXECUTE FUNCTION stock_balance_guard();

-- At commit, the pool equals its movements.
CREATE FUNCTION stock_balance_matches_movements() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  item uuid := COALESCE(NEW.item_id, OLD.item_id);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM stock_balance b,
      LATERAL (SELECT COALESCE(SUM(CASE kind WHEN 'receipt' THEN qty ELSE -qty END), 0) AS qty,
                      COALESCE(SUM(CASE kind WHEN 'receipt' THEN value ELSE -value END), 0) AS value
                 FROM stock_movement WHERE item_id = item) m
     WHERE b.item_id = item AND b.qty = m.qty AND b.value = m.value) THEN
    RAISE EXCEPTION 'stock of part % does not equal its movements', item USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER stock_movement_balanced AFTER INSERT ON stock_movement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_balance_matches_movements();
CREATE CONSTRAINT TRIGGER stock_balance_balanced AFTER UPDATE ON stock_balance
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_balance_matches_movements();

-- ---------------------------------------------------------------------------
-- Job-line WIP pool and its inbound cost movements (issue from stock, or receive-and-issue / purchase, T-23).
-- ---------------------------------------------------------------------------
CREATE TABLE line_wip (
  revision_line_id  uuid PRIMARY KEY REFERENCES revision_line (id),
  qty               numeric(18,3) NOT NULL CHECK (qty >= 0),
  value             numeric(14,2) NOT NULL CHECK (value >= 0),
  basis_qty         numeric(18,3) NOT NULL CHECK (basis_qty >= 0),
  basis_value       numeric(14,2) NOT NULL CHECK (basis_value >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (qty > 0 OR value = 0)
);

CREATE TABLE line_cost_movement (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_line_id   uuid NOT NULL REFERENCES revision_line (id),
  kind               text NOT NULL CHECK (kind IN ('stock_issue', 'purchase')),
  qty                numeric(18,3) NOT NULL CHECK (qty > 0),
  value              numeric(14,2) NOT NULL CHECK (value >= 0),
  stock_movement_id  uuid UNIQUE REFERENCES stock_movement (id),
  supplier_name      text CHECK (supplier_name IS NULL OR length(btrim(supplier_name)) BETWEEN 1 AND 200),
  supplier_ref       text CHECK (supplier_ref IS NULL OR length(btrim(supplier_ref)) BETWEEN 1 AND 100),
  -- v0.2.1 §3.3: more than the line authorizes only with a reason.
  over_reason        text CHECK (over_reason IS NULL OR length(btrim(over_reason)) BETWEEN 1 AND 500),
  created_by         uuid REFERENCES app_user (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  business_date      date NOT NULL,
  CHECK ((kind = 'stock_issue') = (stock_movement_id IS NOT NULL)),
  CHECK ((kind = 'purchase') = (supplier_name IS NOT NULL AND supplier_ref IS NOT NULL))
);
CREATE INDEX line_cost_movement_line_idx ON line_cost_movement (revision_line_id);

-- The line may receive cost: authorized, not frozen, a part line, on a job and repair order that are running.
CREATE FUNCTION line_accepts_parts(line uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM revision_line l
      JOIN job_revision r ON r.id = l.revision_id
      JOIN repair_job j ON j.id = r.job_id
      JOIN repair_order ro ON ro.id = j.repair_order_id
     WHERE l.id = line AND l.line_type = 'part'
       AND l.id IN (SELECT job_authorized_lines(j.id))
       -- Frozen: superseded by a line of a revision still awaiting a decision (v0.2.1 §3.2).
       AND NOT EXISTS (SELECT 1 FROM revision_line s JOIN job_revision sr ON sr.id = s.revision_id
                       WHERE s.supersedes_line_id = l.id AND sr.status = 'pending')
       AND j.removed_at IS NULL
       AND j.execution_status IN ('authorized', 'waiting_parts', 'in_progress', 'paused')
       AND ro.status = 'in_progress');
$$;
REVOKE ALL ON FUNCTION line_accepts_parts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION line_accepts_parts(uuid) TO garage_app;

CREATE FUNCTION stock_movement_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'issue' AND (NOT line_accepts_parts(NEW.revision_line_id)
       OR NOT EXISTS (SELECT 1 FROM revision_line WHERE id = NEW.revision_line_id AND catalogue_item_id = NEW.item_id)) THEN
    RAISE EXCEPTION 'stock is issued only to an authorized, unfrozen line of this part on running work'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.business_date := business_date_of(now());
  RETURN NEW;
END;
$$;
CREATE TRIGGER stock_movement_guard BEFORE INSERT ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION stock_movement_guard();

CREATE FUNCTION line_cost_movement_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  line_qty numeric;
  costed numeric;
BEGIN
  IF NOT line_accepts_parts(NEW.revision_line_id) THEN
    RAISE EXCEPTION 'cost is recorded only on an authorized, unfrozen part line of running work'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.kind = 'stock_issue' AND NOT EXISTS (
       SELECT 1 FROM stock_movement m WHERE m.id = NEW.stock_movement_id AND m.kind = 'issue'
          AND m.revision_line_id = NEW.revision_line_id AND m.qty = NEW.qty AND m.value = NEW.value) THEN
    RAISE EXCEPTION 'a stock issue to a line matches its stock movement' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT qty INTO line_qty FROM revision_line WHERE id = NEW.revision_line_id;
  SELECT COALESCE(SUM(qty), 0) INTO costed FROM line_cost_movement WHERE revision_line_id = NEW.revision_line_id;
  IF costed + NEW.qty > line_qty AND NEW.over_reason IS NULL THEN
    RAISE EXCEPTION 'more than the line authorizes needs a reason (v0.2.1 §3.3)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.business_date := business_date_of(now());
  RETURN NEW;
END;
$$;
CREATE TRIGGER line_cost_movement_guard BEFORE INSERT ON line_cost_movement
  FOR EACH ROW EXECUTE FUNCTION line_cost_movement_guard();

CREATE FUNCTION line_wip_stamp() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.revision_line_id <> OLD.revision_line_id THEN
    RAISE EXCEPTION 'a line pool keeps its line' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER line_wip_stamp BEFORE INSERT OR UPDATE ON line_wip
  FOR EACH ROW EXECUTE FUNCTION line_wip_stamp();

-- At commit, a line's WIP equals its cost movements (outbound billing and returns arrive with I1-09 / I4-02).
CREATE FUNCTION line_wip_matches_movements() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  line uuid := NEW.revision_line_id;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM line_wip w,
      LATERAL (SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(value), 0) AS value
                 FROM line_cost_movement WHERE revision_line_id = line) m
     WHERE w.revision_line_id = line AND w.qty = m.qty AND w.value = m.value) THEN
    RAISE EXCEPTION 'cost on line % does not equal its movements', line USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER line_cost_movement_balanced AFTER INSERT ON line_cost_movement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION line_wip_matches_movements();
CREATE CONSTRAINT TRIGGER line_wip_balanced AFTER INSERT OR UPDATE ON line_wip
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION line_wip_matches_movements();

-- ---------------------------------------------------------------------------
-- Jobs: Approved ↔ Waiting parts (B2), by the assignee or by staff who handle parts (OD-29); Done needs the
-- completion note (OD-31); a status change never touches removal columns. Replaces 0013's guard.
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

-- A job waiting for parts can still be assigned (replaces 0013's guard; only the status list changes).
CREATE OR REPLACE FUNCTION job_assignment_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL THEN
      RAISE EXCEPTION 'an assignment starts live' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM repair_job WHERE id = NEW.job_id AND removed_at IS NULL
                   AND execution_status IN ('authorized', 'waiting_parts', 'in_progress', 'paused')) THEN
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

REVOKE ALL ON FUNCTION stock_balance_for_new_part() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_balance_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_balance_matches_movements() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_movement_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION line_cost_movement_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION line_wip_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION line_wip_matches_movements() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants. Movements are insert-only; pools change only alongside their movements (checked at commit).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON stock_balance TO garage_app;
GRANT UPDATE (qty, value, basis_qty, basis_value, updated_at) ON stock_balance TO garage_app;
GRANT SELECT, INSERT ON stock_movement TO garage_app;
GRANT SELECT, INSERT ON line_wip TO garage_app;
GRANT UPDATE (qty, value, basis_qty, basis_value, updated_at) ON line_wip TO garage_app;
GRANT SELECT, INSERT ON line_cost_movement TO garage_app;
