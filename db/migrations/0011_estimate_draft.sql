-- I1-05a — Estimate draft: jobs, revisions, lines, totals. Runs as garage_owner.
-- Spec: v0.2.1 §2 (RepairJob → JobRevision → RevisionLine), §3.1 (version states), AC-05.2, AC-06.1, AC2-12.
-- Decisions OD-18 (VAT split per line), OD-19 (discounts), OD-22 (whole quantities), OD-23/OD-24 (findings),
-- T-18 (line prices), T-19 (one estimate per RO), T-20 (package lines).
-- Sending, snapshots and approvals are I1-05b; this migration only lets drafts be built.

-- Validity of a sent version (OD-21, provisional until D-12). Read when sending (I1-05b).
INSERT INTO app_setting (key, value) VALUES ('estimate.validity_days', '7');

-- ---------------------------------------------------------------------------
-- Estimate and its versions (one estimate per repair order, T-19).
-- ---------------------------------------------------------------------------
CREATE TABLE estimate (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_order_id  uuid NOT NULL UNIQUE REFERENCES repair_order (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user (id)
);

CREATE TABLE estimate_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id   uuid NOT NULL REFERENCES estimate (id),
  version_no    smallint NOT NULL CHECK (version_no >= 1),
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'sent', 'closed', 'withdrawn', 'expired', 'discarded')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES app_user (id),
  UNIQUE (estimate_id, version_no)
);
-- §3.1: no other version of the estimate in Draft or Sent.
CREATE UNIQUE INDEX estimate_version_one_open ON estimate_version (estimate_id) WHERE status IN ('draft', 'sent');

-- ---------------------------------------------------------------------------
-- Repair jobs (the logical repair, v0.2.1 §2.1 #1). A draft job can be removed (never deleted); a job
-- made from a finding addresses it (AC-05.2).
-- ---------------------------------------------------------------------------
CREATE TABLE repair_job (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_order_id   uuid NOT NULL REFERENCES repair_order (id),
  title             text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  job_type          text NOT NULL DEFAULT 'repair' CHECK (job_type IN ('repair', 'diagnostic')),
  charge_type       text NOT NULL DEFAULT 'chargeable' CHECK (charge_type IN ('chargeable', 'warranty', 'goodwill')),
  -- Execution statuses (v0.2.1 §3.3) are listed so later stories need no constraint change.
  execution_status  text NOT NULL DEFAULT 'not_authorized' CHECK (execution_status IN
                      ('not_authorized', 'authorized', 'waiting_parts', 'in_progress', 'paused', 'done',
                       'stopped_by_customer', 'cancelled')),
  finding_id        uuid REFERENCES finding (id),
  removed_at        timestamptz,
  removed_by        uuid REFERENCES app_user (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES app_user (id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES app_user (id)
);
CREATE INDEX repair_job_repair_order_idx ON repair_job (repair_order_id);
-- A finding is addressed by at most one live job.
CREATE UNIQUE INDEX repair_job_one_per_finding ON repair_job (finding_id)
  WHERE finding_id IS NOT NULL AND removed_at IS NULL;

CREATE TABLE job_revision (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   uuid NOT NULL REFERENCES repair_job (id),
  revision_no              smallint NOT NULL CHECK (revision_no >= 1),
  kind                     text NOT NULL CHECK (kind IN ('original', 'add_scope', 'price_change', 'reduction',
                                                         'substitution', 'partial_work_agreement')),
  proposed_in_version_id   uuid NOT NULL REFERENCES estimate_version (id),
  status                   text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'pending', 'approved', 'declined', 'lapsed')),
  lapse_reason             text CHECK (lapse_reason IS NULL OR lapse_reason IN ('withdrawn', 'expired')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES app_user (id),
  UNIQUE (job_id, revision_no),
  CHECK ((status = 'lapsed') = (lapse_reason IS NOT NULL))
);
-- §2.1 #6: at most one revision per job awaiting a decision (draft or pending).
CREATE UNIQUE INDEX job_revision_one_open ON job_revision (job_id) WHERE status IN ('draft', 'pending');
CREATE INDEX job_revision_version_idx ON job_revision (proposed_in_version_id);

-- ---------------------------------------------------------------------------
-- Revision lines: the billable atoms. Prices include VAT (OD-14); the line keeps the catalogue price row
-- it was priced from and its values (T-18, AC2-12). The arithmetic is checked here as well as in code:
--   gross = round(qty × unit price)        total = gross − discount
--   net   = round(total × 100 / (100 + rate))  vat = total − net           (OD-18, rounding half-up)
-- ---------------------------------------------------------------------------
CREATE TABLE revision_line (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id         uuid NOT NULL REFERENCES job_revision (id),
  line_type           text NOT NULL CHECK (line_type IN ('labor', 'part', 'package', 'fee', 'customer_supplied_part')),
  catalogue_item_id   uuid REFERENCES catalogue_item (id),
  catalogue_price_id  uuid REFERENCES catalogue_price (id),
  description_en      text NOT NULL CHECK (length(btrim(description_en)) BETWEEN 1 AND 200),
  description_ar      text NOT NULL CHECK (length(btrim(description_ar)) BETWEEN 1 AND 200),
  unit                text CHECK (unit IS NULL OR unit IN ('piece', 'set', 'litre', 'kg', 'metre', 'job', 'hour')),
  qty                 numeric(18,3) NOT NULL CHECK (qty > 0),
  unit_price          numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  gross               numeric(14,2) NOT NULL,
  discount            numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  line_total          numeric(14,2) NOT NULL,
  net                 numeric(14,2) NOT NULL,
  vat                 numeric(14,2) NOT NULL,
  tax_code            text NOT NULL REFERENCES tax_code (code),
  tax_rate            numeric(5,2) NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 100),
  supersedes_line_id  uuid REFERENCES revision_line (id),
  removed_at          timestamptz,
  removed_by          uuid REFERENCES app_user (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES app_user (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES app_user (id),
  CHECK (gross = round(qty * unit_price, 2)),
  CHECK (discount <= gross),
  CHECK (line_total = gross - discount),
  CHECK (net = round(line_total * 100 / (100 + tax_rate), 2)),
  CHECK (vat = line_total - net),
  -- Until fee and customer-supplied lines arrive (I2), every line is priced from the catalogue (T-18).
  CHECK (catalogue_item_id IS NOT NULL AND catalogue_price_id IS NOT NULL),
  -- OD-22: only labour hours and parts sold by litre, kg or metre may be fractional.
  CHECK (qty = trunc(qty) OR unit IN ('hour', 'litre', 'kg', 'metre'))
);
CREATE INDEX revision_line_revision_idx ON revision_line (revision_id);

-- ---------------------------------------------------------------------------
-- AC-05.2: an urgent finding left out of the estimate needs a recorded reason. Re-including the finding
-- clears the exclusion (cleared, never deleted).
-- ---------------------------------------------------------------------------
CREATE TABLE urgent_finding_exclusion (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_version_id  uuid NOT NULL REFERENCES estimate_version (id),
  finding_id           uuid NOT NULL REFERENCES finding (id),
  reason               text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES app_user (id),
  cleared_at           timestamptz,
  cleared_by           uuid REFERENCES app_user (id)
);
CREATE UNIQUE INDEX urgent_finding_exclusion_one_live ON urgent_finding_exclusion (estimate_version_id, finding_id)
  WHERE cleared_at IS NULL;

-- ---------------------------------------------------------------------------
-- Guards. Drafts change only while the repair order is still Checked-in or Diagnosing and the version is
-- a draft; once sent (I1-05b) jobs keep their identity and lines never change (§2.2 "immutable once sent").
-- Times come from the database, removal and clearing times included. The checks read repair-order and finding
-- state without row locks: they are race-free because every command that changes those states locks the
-- repair order first (I1-05b's send must too).
-- ---------------------------------------------------------------------------
CREATE FUNCTION estimate_draft_open(version_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM estimate_version v
                 JOIN estimate e ON e.id = v.estimate_id
                 JOIN repair_order ro ON ro.id = e.repair_order_id
                 WHERE v.id = version_id AND v.status = 'draft' AND ro.status IN ('checked_in', 'diagnosing'));
$$;

CREATE FUNCTION estimate_draft_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  version_id uuid;
  today date;
  expected_rate numeric;
BEGIN
  IF TG_TABLE_NAME = 'revision_line' THEN
    SELECT r.proposed_in_version_id INTO version_id FROM job_revision r JOIN repair_job j ON j.id = r.job_id
      WHERE r.id = NEW.revision_id AND r.status = 'draft' AND j.removed_at IS NULL;
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := clock_timestamp();
      IF NEW.removed_at IS NOT NULL OR NEW.supersedes_line_id IS NOT NULL THEN
        RAISE EXCEPTION 'a line starts live and supersedes nothing in a draft' USING ERRCODE = 'insufficient_privilege';
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
    -- I1-05a only creates draft revisions; status changes arrive with sending (I1-05b).
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
    -- A job is edited only through its draft revision in an open draft.
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
CREATE TRIGGER repair_job_guard BEFORE INSERT OR UPDATE ON repair_job
  FOR EACH ROW EXECUTE FUNCTION estimate_draft_guard();
CREATE TRIGGER job_revision_guard BEFORE INSERT OR UPDATE ON job_revision
  FOR EACH ROW EXECUTE FUNCTION estimate_draft_guard();
CREATE TRIGGER revision_line_guard BEFORE INSERT OR UPDATE ON revision_line
  FOR EACH ROW EXECUTE FUNCTION estimate_draft_guard();
CREATE TRIGGER urgent_finding_exclusion_guard BEFORE INSERT OR UPDATE ON urgent_finding_exclusion
  FOR EACH ROW EXECUTE FUNCTION estimate_draft_guard();

CREATE FUNCTION estimate_version_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'an estimate version starts as a draft' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM estimate e JOIN repair_order ro ON ro.id = e.repair_order_id
                 WHERE e.id = NEW.estimate_id AND ro.status IN ('checked_in', 'diagnosing')) THEN
    RAISE EXCEPTION 'estimates are drafted only while the repair order is checked in or diagnosing'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER estimate_version_guard BEFORE INSERT ON estimate_version
  FOR EACH ROW EXECUTE FUNCTION estimate_version_guard();
CREATE FUNCTION estimate_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM repair_order WHERE id = NEW.repair_order_id AND status IN ('checked_in', 'diagnosing')) THEN
    RAISE EXCEPTION 'estimates are started only while the repair order is checked in or diagnosing'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER estimate_guard BEFORE INSERT ON estimate
  FOR EACH ROW EXECUTE FUNCTION estimate_guard();

-- OD-24: a finding that a live estimate job is built from cannot be withdrawn; remove the job first.
CREATE FUNCTION finding_in_estimate_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'withdrawn' AND OLD.status = 'active'
     AND EXISTS (SELECT 1 FROM repair_job WHERE finding_id = OLD.id AND removed_at IS NULL) THEN
    RAISE EXCEPTION 'finding % is in the estimate; remove its job first (OD-24)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finding_in_estimate_guard BEFORE UPDATE ON finding
  FOR EACH ROW EXECUTE FUNCTION finding_in_estimate_guard();

REVOKE ALL ON FUNCTION estimate_draft_open(uuid) FROM PUBLIC;
-- The guards run as the caller, so the app role needs this read-only helper.
GRANT EXECUTE ON FUNCTION estimate_draft_open(uuid) TO garage_app;
REVOKE ALL ON FUNCTION estimate_draft_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION estimate_version_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION estimate_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION finding_in_estimate_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants. No DELETE anywhere; removal is a stamped column. Status changes are granted with sending (I1-05b).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON estimate, estimate_version, job_revision TO garage_app;
GRANT SELECT, INSERT ON repair_job TO garage_app;
-- No title edits: a job's identity is fixed (v0.2.1 §2.2).
GRANT UPDATE (removed_at, removed_by, updated_at, updated_by) ON repair_job TO garage_app;
GRANT SELECT, INSERT ON revision_line TO garage_app;
GRANT UPDATE (qty, gross, discount, line_total, net, vat, removed_at, removed_by, updated_at, updated_by)
  ON revision_line TO garage_app;
GRANT SELECT, INSERT ON urgent_finding_exclusion TO garage_app;
GRANT UPDATE (cleared_at, cleared_by) ON urgent_finding_exclusion TO garage_app;
