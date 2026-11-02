-- I2-02a — Amendments: add scope, price change, substitution; frozen superseded lines; a done job reopened by an
-- approved amendment; findings recorded during work. Runs as garage_owner.
-- Spec: v0.2.1 §2.1 #2–#7, §2.3 (example, variants and supersession guards), §3.2 (frozen lines), §3.3 (Done → In
-- progress when a new revision is approved before QC), AC21-01, AC21-08, AC2-06; Final review F-13.
-- Decisions OD-56 (versions while Awaiting approval or In progress), OD-72 (findings during work), T-47.
-- Every command that changes these rows locks the repair order first, so the checks below read without row locks.

-- ---------------------------------------------------------------------------
-- A line may be superseded (v0.2.1 §2.3 guards): it belongs to the same job, is authorized now, nothing else open
-- supersedes it, nothing of it is billed, and no cost (stock issue or purchase) was booked to it — returning issued
-- parts arrives with I4-02.
-- ---------------------------------------------------------------------------
CREATE FUNCTION line_supersedable(line uuid, revision uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM revision_line l
      JOIN job_revision lr ON lr.id = l.revision_id
      JOIN job_revision nr ON nr.id = revision AND nr.job_id = lr.job_id
     WHERE l.id = line
       AND l.id IN (SELECT job_authorized_lines(lr.job_id))
       AND NOT EXISTS (SELECT 1 FROM revision_line s JOIN job_revision sr ON sr.id = s.revision_id
                       WHERE s.supersedes_line_id = l.id AND s.removed_at IS NULL
                         AND sr.status IN ('draft', 'pending') AND sr.id <> revision)
       AND NOT EXISTS (SELECT 1 FROM revision_line_billing b WHERE b.revision_line_id = l.id AND b.net_billed_qty > 0)
       AND NOT EXISTS (SELECT 1 FROM line_cost_movement m WHERE m.revision_line_id = l.id));
$$;
REVOKE ALL ON FUNCTION line_supersedable(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION line_supersedable(uuid, uuid) TO garage_app;

-- ---------------------------------------------------------------------------
-- The kind of an amendment follows from its lines (T-47): a line replacing a different item makes it a
-- substitution, a line replacing the same item a price change, otherwise it adds scope. Fixed when it is sent.
-- ---------------------------------------------------------------------------
CREATE FUNCTION amendment_kind(revision uuid) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM revision_line n JOIN revision_line o ON o.id = n.supersedes_line_id
                 WHERE n.revision_id = revision AND n.removed_at IS NULL
                   AND n.catalogue_item_id IS DISTINCT FROM o.catalogue_item_id) THEN 'substitution'
    WHEN EXISTS (SELECT 1 FROM revision_line n WHERE n.revision_id = revision AND n.removed_at IS NULL
                   AND n.supersedes_line_id IS NOT NULL) THEN 'price_change'
    ELSE 'add_scope' END;
$$;
REVOKE ALL ON FUNCTION amendment_kind(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amendment_kind(uuid) TO garage_app;

-- ---------------------------------------------------------------------------
-- Draft guard (0011) with one change: a line of an amendment may supersede a line of its own job (§2.3), of the
-- same line type, that may be superseded now. A line of an Original revision still supersedes nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estimate_draft_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  version_id uuid;
  today date;
  expected_rate numeric;
  revision_kind text;
BEGIN
  IF TG_TABLE_NAME = 'revision_line' THEN
    SELECT r.proposed_in_version_id, r.kind INTO version_id, revision_kind
      FROM job_revision r JOIN repair_job j ON j.id = r.job_id
      WHERE r.id = NEW.revision_id AND r.status = 'draft' AND j.removed_at IS NULL;
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := clock_timestamp();
      IF NEW.removed_at IS NOT NULL THEN
        RAISE EXCEPTION 'a line starts live' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NEW.supersedes_line_id IS NOT NULL THEN
        IF revision_kind IS DISTINCT FROM 'add_scope' THEN
          RAISE EXCEPTION 'only an amendment of an approved job replaces a line' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NOT line_supersedable(NEW.supersedes_line_id, NEW.revision_id)
           OR NOT EXISTS (SELECT 1 FROM revision_line o WHERE o.id = NEW.supersedes_line_id
                          AND o.line_type = NEW.line_type) THEN
          RAISE EXCEPTION 'line % cannot be replaced (v0.2.1 §2.3)', NEW.supersedes_line_id
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM catalogue_price p JOIN catalogue_item i ON i.id = p.item_id
           WHERE p.id = NEW.catalogue_price_id AND p.item_id = NEW.catalogue_item_id AND p.price = NEW.unit_price
             AND p.tax_code = NEW.tax_code
             AND NEW.line_type = CASE i.kind WHEN 'labor_rate' THEN 'labor' ELSE i.kind END
             AND NEW.unit IS NOT DISTINCT FROM CASE i.kind WHEN 'labor_rate' THEN 'hour' WHEN 'part' THEN i.unit END) THEN
        RAISE EXCEPTION 'a line is priced from its own catalogue price row (T-18)' USING ERRCODE = 'insufficient_privilege';
      END IF;
      -- The VAT rate is the tax code's rate on today's business date, or 0 while not registered (OD-18).
      today := (now() AT TIME ZONE 'Asia/Dubai')::date;
      IF (SELECT registration_status FROM tax_profile WHERE effective_from <= today
          ORDER BY effective_from DESC LIMIT 1) = 'registered' THEN
        expected_rate := (SELECT rate FROM tax_code_rate WHERE code = NEW.tax_code AND effective_from <= today
                          ORDER BY effective_from DESC LIMIT 1);
      ELSE
        expected_rate := 0;
      END IF;
      IF expected_rate IS NULL OR NEW.tax_rate <> expected_rate THEN
        RAISE EXCEPTION 'a line carries the tax rate in force' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.revision_id <> OLD.revision_id OR NEW.catalogue_item_id IS DISTINCT FROM OLD.catalogue_item_id
          OR NEW.catalogue_price_id IS DISTINCT FROM OLD.catalogue_price_id OR NEW.line_type <> OLD.line_type
          OR NEW.unit_price <> OLD.unit_price OR NEW.tax_code <> OLD.tax_code OR NEW.tax_rate <> OLD.tax_rate
          OR NEW.supersedes_line_id IS DISTINCT FROM OLD.supersedes_line_id OR OLD.removed_at IS NOT NULL THEN
      -- A line's price is changed only by a discount or by adding the line again (T-18).
      RAISE EXCEPTION 'revision line % cannot change this way', OLD.id USING ERRCODE = 'insufficient_privilege';
    ELSIF NEW.removed_at IS NOT NULL THEN
      NEW.removed_at := now();
    END IF;
    NEW.updated_at := clock_timestamp();
  ELSIF TG_TABLE_NAME = 'job_revision' THEN
    IF TG_OP = 'UPDATE' OR NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'job revisions start as drafts' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM repair_job j JOIN estimate e ON e.repair_order_id = j.repair_order_id
                   JOIN estimate_version v ON v.estimate_id = e.id
                   WHERE j.id = NEW.job_id AND v.id = NEW.proposed_in_version_id AND j.removed_at IS NULL) THEN
      RAISE EXCEPTION 'a revision is proposed in its own repair order''s estimate' USING ERRCODE = 'insufficient_privilege';
    END IF;
    version_id := NEW.proposed_in_version_id;
    NEW.created_at := now();
  ELSIF TG_TABLE_NAME = 'repair_job' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.execution_status <> 'not_authorized' OR NEW.removed_at IS NOT NULL THEN
        RAISE EXCEPTION 'a job starts live and not authorized' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NEW.finding_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM finding WHERE id = NEW.finding_id
                                                     AND repair_order_id = NEW.repair_order_id AND status = 'active') THEN
        RAISE EXCEPTION 'a job addresses an active finding of its own repair order' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.created_at := now();
    ELSIF NEW.repair_order_id <> OLD.repair_order_id OR NEW.finding_id IS DISTINCT FROM OLD.finding_id
          OR NEW.job_type <> OLD.job_type OR NEW.charge_type <> OLD.charge_type
          OR NEW.execution_status <> OLD.execution_status OR OLD.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'repair job % cannot change this way', OLD.id USING ERRCODE = 'insufficient_privilege';
    ELSIF NEW.removed_at IS NOT NULL THEN
      NEW.removed_at := now();
    END IF;
    SELECT r.proposed_in_version_id INTO version_id FROM job_revision r
      WHERE r.job_id = NEW.id AND r.status = 'draft';
    IF TG_OP = 'INSERT' THEN
      IF NOT EXISTS (SELECT 1 FROM estimate e JOIN estimate_version v ON v.estimate_id = e.id
                     WHERE e.repair_order_id = NEW.repair_order_id AND estimate_draft_open(v.id)) THEN
        RAISE EXCEPTION 'jobs are added only to an open draft estimate' USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END IF;
    NEW.updated_at := now();
  ELSE -- urgent_finding_exclusion
    IF TG_OP = 'INSERT' THEN
      IF NEW.cleared_at IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM finding f JOIN estimate e ON e.repair_order_id = f.repair_order_id
           JOIN estimate_version v ON v.estimate_id = e.id
           WHERE f.id = NEW.finding_id AND v.id = NEW.estimate_version_id AND f.status = 'active' AND f.severity = 'urgent') THEN
        RAISE EXCEPTION 'only an active urgent finding of this repair order is excluded' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.created_at := now();
    ELSIF NEW.estimate_version_id <> OLD.estimate_version_id OR NEW.finding_id <> OLD.finding_id
          OR NEW.reason <> OLD.reason OR OLD.cleared_at IS NOT NULL THEN
      RAISE EXCEPTION 'an exclusion is only cleared, once' USING ERRCODE = 'insufficient_privilege';
    ELSIF NEW.cleared_at IS NOT NULL THEN
      NEW.cleared_at := now();
    END IF;
    version_id := NEW.estimate_version_id;
  END IF;

  IF version_id IS NULL OR NOT estimate_draft_open(version_id) THEN
    RAISE EXCEPTION 'the estimate is not an open draft' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Inserting a revision (0020 rule, extended): an Original proposal of a job with nothing approved (first, or
-- offered again after a decline or lapse, OD-55), or an amendment of a job with approved work and nothing open.
-- Amendments are inserted as "add_scope"; sending fixes their kind (T-47). Garage reductions and partial-work
-- agreements arrive with I2-02b.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_revision_sequence_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  latest record;
BEGIN
  SELECT revision_no, status INTO latest FROM job_revision WHERE job_id = NEW.job_id
   ORDER BY revision_no DESC LIMIT 1;
  IF NEW.kind = 'add_scope' THEN
    IF latest IS NULL OR NEW.revision_no <> latest.revision_no + 1
       OR NOT EXISTS (SELECT 1 FROM job_revision WHERE job_id = NEW.job_id AND status = 'approved')
       OR EXISTS (SELECT 1 FROM job_revision WHERE job_id = NEW.job_id AND status IN ('draft', 'pending')) THEN
      RAISE EXCEPTION 'an amendment is the next revision of a job with approved work and nothing open'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind <> 'original' THEN
    RAISE EXCEPTION 'amendments start as "add_scope"; reductions and partial-work agreements arrive with I2-02b'
      USING ERRCODE = 'insufficient_privilege';
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

-- ---------------------------------------------------------------------------
-- Revision transitions (0020 rules) plus, when an amendment is sent: its kind is fixed from its lines (T-47) and
-- every line it replaces may still be replaced — parts issued or costs booked to it while the draft was open
-- block it (§2.3 guard d) — and a price change on the same item costs more (a lower price is a garage reduction,
-- I2-02b; the same price changes nothing).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_revision_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  version_status text;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'pending' AND OLD.kind = 'add_scope' THEN
    NEW.kind := amendment_kind(OLD.id);
    IF EXISTS (SELECT 1 FROM revision_line n JOIN revision_line o ON o.id = n.supersedes_line_id
               WHERE n.revision_id = OLD.id AND n.removed_at IS NULL
                 AND (NOT line_supersedable(o.id, OLD.id)
                      OR (n.catalogue_item_id IS NOT DISTINCT FROM o.catalogue_item_id
                          AND n.line_total <= o.line_total))) THEN
      RAISE EXCEPTION 'amendment % replaces a line it may not replace (v0.2.1 §2.3)', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'job revision % keeps its identity', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.job_id <> OLD.job_id OR NEW.revision_no <> OLD.revision_no
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
  IF OLD.status = 'pending' AND NEW.status = 'lapsed' THEN
    IF version_status NOT IN ('withdrawn', 'expired') OR NEW.lapse_reason IS DISTINCT FROM version_status THEN
      RAISE EXCEPTION 'a revision lapses only with its version''s withdrawal or expiry' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
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
-- Job transitions (0016 rules) plus §3.3 "Done → In progress (SYS)": a done job reopens when an amendment of it is
-- approved in this transaction and left it with an authorized line that has no outcome yet. It keeps its assignee.
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
  IF NOT EXISTS (SELECT 1 FROM job_revision WHERE job_id = OLD.id AND status = 'approved') THEN
    RAISE EXCEPTION 'job % has no approved revision: unapproved work cannot start (AC2-01)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  from_to := OLD.execution_status || '>' || NEW.execution_status;
  IF from_to = 'not_authorized>authorized' THEN
    NULL;
  ELSIF from_to = 'done>authorized' THEN
    IF NOT EXISTS (SELECT 1 FROM qc_record WHERE repair_order_id = OLD.repair_order_id AND status = 'failed'
                   AND decided_at = now() AND decided_by = NEW.updated_by)
       OR EXISTS (SELECT 1 FROM job_line_outcome WHERE job_id = OLD.id AND superseded_at IS NULL) THEN
      RAISE EXCEPTION 'a done job is reopened only by a failed QC (T-26)' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF from_to = 'done>in_progress' THEN
    IF NOT EXISTS (SELECT 1 FROM revision_decision d JOIN approval_event e ON e.id = d.approval_event_id
                   JOIN job_revision r ON r.id = d.revision_id
                   WHERE r.job_id = OLD.id AND r.kind <> 'original' AND d.decision = 'approved'
                     AND e.recorded_at = now())
       OR NOT EXISTS (SELECT 1 FROM job_authorized_lines(OLD.id) AS line(id)
                      WHERE NOT EXISTS (SELECT 1 FROM job_line_outcome o WHERE o.revision_line_id = line.id
                                        AND o.superseded_at IS NULL))
       OR NOT EXISTS (SELECT 1 FROM repair_order WHERE id = OLD.repair_order_id AND status = 'in_progress') THEN
      RAISE EXCEPTION 'a done job reopens only when an approved amendment adds work to it (v0.2.1 §3.3)'
        USING ERRCODE = 'insufficient_privilege';
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

-- ---------------------------------------------------------------------------
-- OD-72: findings (and their photos) are recorded, edited and withdrawn during work too (In progress), so extra
-- work found under the car reaches the next estimate version (v0.2.1 §2.3 step 4).
-- ---------------------------------------------------------------------------
-- OD-10: a finding the customer was shown in a sent estimate (any revision of its job left Draft) is read-only:
-- its title, severity, notes, fault codes and photos are in a hashed snapshot. Before OD-72 the repair-order status
-- guaranteed this; findings are now open during work, so it is checked explicitly. New photos may still be added
-- (they start internal and change nothing the customer saw).
CREATE FUNCTION finding_in_sent_estimate(finding uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM repair_job j JOIN job_revision r ON r.job_id = j.id
                 WHERE j.finding_id = finding AND j.removed_at IS NULL
                   AND r.status IN ('pending', 'approved', 'declined', 'lapsed'));
$$;
REVOKE ALL ON FUNCTION finding_in_sent_estimate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finding_in_sent_estimate(uuid) TO garage_app;

CREATE OR REPLACE FUNCTION finding_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'a finding starts active' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.recorded_at := now();
    NEW.updated_at := now();
  ELSIF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'finding % is withdrawn and can no longer change', OLD.id USING ERRCODE = 'insufficient_privilege';
  ELSIF finding_in_sent_estimate(OLD.id) THEN
    RAISE EXCEPTION 'finding % was shown to the customer and is read-only (OD-10)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM repair_order WHERE id = NEW.repair_order_id
                 AND status IN ('checked_in', 'diagnosing', 'in_progress')) THEN
    RAISE EXCEPTION 'findings change only while the repair order is checked in, diagnosing or in progress'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION media_asset_insert_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.locked_at IS NOT NULL OR NEW.repair_order_id IS NOT NULL OR NEW.discarded_at IS NOT NULL
     OR NEW.excluded_at IS NOT NULL OR NEW.excluded_by IS NOT NULL OR NEW.excluded_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a photo starts unlocked on its parent' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.check_in_id IS NOT NULL THEN
    IF NEW.visibility <> 'internal'
       OR NOT EXISTS (SELECT 1 FROM check_in WHERE id = NEW.check_in_id AND status = 'in_progress') THEN
      RAISE EXCEPTION 'check-in photos are added only to a check-in in progress' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF NEW.visibility <> 'internal'
       OR NOT EXISTS (SELECT 1 FROM finding f JOIN repair_order ro ON ro.id = f.repair_order_id
                      WHERE f.id = NEW.finding_id AND f.status = 'active'
                        AND ro.status IN ('checked_in', 'diagnosing', 'in_progress')) THEN
      RAISE EXCEPTION 'finding photos are added only to an active finding' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  NEW.uploaded_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION media_asset_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.check_in_id IS DISTINCT FROM OLD.check_in_id
     OR NEW.finding_id IS DISTINCT FROM OLD.finding_id OR NEW.slot <> OLD.slot
     OR NEW.storage_key <> OLD.storage_key OR NEW.sha256 <> OLD.sha256 THEN
    RAISE EXCEPTION 'media_asset content cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.finding_id IS NOT NULL THEN
    IF NEW.locked_at IS NOT NULL OR NEW.repair_order_id IS NOT NULL OR NEW.excluded_at IS NOT NULL
       OR OLD.discarded_at IS NOT NULL
       OR finding_in_sent_estimate(OLD.finding_id)
       OR NOT EXISTS (SELECT 1 FROM finding f JOIN repair_order ro ON ro.id = f.repair_order_id
                      WHERE f.id = OLD.finding_id AND f.status = 'active'
                        AND ro.status IN ('checked_in', 'diagnosing', 'in_progress')) THEN
      RAISE EXCEPTION 'finding photo % cannot change this way', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.visibility <> OLD.visibility THEN
    RAISE EXCEPTION 'check-in photo visibility cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.locked_at IS NOT NULL THEN
    IF OLD.excluded_at IS NOT NULL
       OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
       OR NEW.repair_order_id IS DISTINCT FROM OLD.repair_order_id
       OR NEW.discarded_at IS DISTINCT FROM OLD.discarded_at
       OR NEW.excluded_at IS NULL THEN
      RAISE EXCEPTION 'media_asset % is locked', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF OLD.discarded_at IS NOT NULL
       OR NEW.excluded_at IS NOT NULL
       OR (NEW.locked_at IS NULL) <> (NEW.repair_order_id IS NULL)
       OR (NEW.locked_at IS NOT NULL AND NEW.discarded_at IS NOT NULL) THEN
      RAISE EXCEPTION 'media_asset % cannot change this way', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- No new tables, so no new grants; the two helpers above are granted EXECUTE where they are created.
