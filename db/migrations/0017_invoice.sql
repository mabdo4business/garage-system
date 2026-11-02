-- I1-09a — Invoice issue. Runs as garage_owner.
-- Spec: v0.2.1 §3.9, §4.1–4.4 (net cap, tax on the invoice business date, per-line tax snapshot), §5 (cap under
-- lock, numbering, issued documents immutable), PRD v0.2 §B1 (QC → Ready on invoice issue), §D1 (Draft → Issued; at
-- most one not-fully-credited invoice per repair order; no edit or void), Pre-Impl P0-06 (stock part lines need
-- issued stock; non-stock lines need their cost, B-08), amendment §A.1 (WIP → COGS at billing). Decisions OD-40,
-- OD-41, T-28, T-29, T-31, T-32. Commands lock repair order → revision lines → number series; the checks below rely on that.

-- ---------------------------------------------------------------------------
-- Drafts: previews of what will be billed. Never a document; only their status changes.
-- ---------------------------------------------------------------------------
CREATE TABLE invoice_draft (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_order_id  uuid NOT NULL REFERENCES repair_order (id),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'discarded')),
  created_by       uuid REFERENCES app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_by        uuid REFERENCES app_user (id),
  closed_at        timestamptz,
  CHECK ((status = 'draft') = (closed_at IS NULL))
);
CREATE INDEX invoice_draft_repair_order_idx ON invoice_draft (repair_order_id);

CREATE TABLE invoice_draft_line (
  draft_id          uuid NOT NULL REFERENCES invoice_draft (id),
  revision_line_id  uuid NOT NULL REFERENCES revision_line (id),
  PRIMARY KEY (draft_id, revision_line_id)
);

-- ---------------------------------------------------------------------------
-- Issued invoices and their lines: insert-only (rule 6, AC2-18). Credit status lives elsewhere (I3).
-- ---------------------------------------------------------------------------
CREATE TABLE invoice (
  id                   uuid PRIMARY KEY,
  number               text NOT NULL UNIQUE,
  repair_order_id      uuid NOT NULL REFERENCES repair_order (id),
  customer_id          uuid NOT NULL REFERENCES customer (id),
  draft_id             uuid NOT NULL UNIQUE REFERENCES invoice_draft (id),
  registration_status  text NOT NULL CHECK (registration_status IN ('not_registered', 'registered')),
  trn                  text CHECK (trn IS NULL OR trn ~ '^[0-9]{15}$'),
  gross                numeric(14,2) NOT NULL CHECK (gross >= 0),
  discount             numeric(14,2) NOT NULL CHECK (discount >= 0),
  net                  numeric(14,2) NOT NULL CHECK (net >= 0),
  vat                  numeric(14,2) NOT NULL CHECK (vat >= 0),
  total                numeric(14,2) NOT NULL CHECK (total >= 0),
  -- OD-41: required when any line's tax differs from what the customer approved.
  tax_change_notice    text CHECK (tax_change_notice IS NULL OR length(btrim(tax_change_notice)) BETWEEN 1 AND 1000),
  issued_by            uuid REFERENCES app_user (id),
  issued_at            timestamptz NOT NULL DEFAULT now(),
  business_date        date NOT NULL,
  -- T-32 (PRD v0.2 §D1, AC2-18): customer and vehicle as they were at issue, set by invoice_guard from the live rows.
  -- Later edits to the customer, a plate change or an ownership change never alter an issued invoice.
  ro_number            text NOT NULL,
  customer_name_en     text,
  customer_name_ar     text,
  vehicle_make         text NOT NULL,
  vehicle_model        text NOT NULL,
  vehicle_year         integer NOT NULL,
  vehicle_vin          text,
  plate_emirate        text,
  plate_code           text,
  plate_number         text,
  CHECK ((plate_emirate IS NULL) = (plate_number IS NULL)),
  CHECK ((registration_status = 'registered') = (trn IS NOT NULL)),
  CHECK (registration_status = 'registered' OR vat = 0),
  CHECK (total = net + vat)
);
CREATE INDEX invoice_repair_order_idx ON invoice (repair_order_id);

CREATE TABLE invoice_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES invoice (id),
  -- Order on the document: the estimate's line order (draft order).
  position          integer NOT NULL CHECK (position >= 0),
  revision_line_id  uuid NOT NULL REFERENCES revision_line (id),
  job_id            uuid NOT NULL REFERENCES repair_job (id),
  description_en    text NOT NULL,
  description_ar    text NOT NULL,
  line_type         text NOT NULL,
  unit              text,
  qty               numeric(18,3) NOT NULL CHECK (qty > 0),
  unit_price        numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  -- T-31: net ÷ qty, half-up to the fil (excl. VAT, after discount). Reference only; `net` is authoritative. On a
  -- line whose tax changed (OD-41) unit_price/gross/discount stay as approved (VAT-inclusive at the old rate).
  unit_price_net    numeric(14,2) NOT NULL CHECK (unit_price_net >= 0),
  gross             numeric(14,2) NOT NULL CHECK (gross >= 0),
  discount          numeric(14,2) NOT NULL CHECK (discount >= 0),
  net               numeric(14,2) NOT NULL CHECK (net >= 0),
  vat               numeric(14,2) NOT NULL CHECK (vat >= 0),
  total             numeric(14,2) NOT NULL,
  tax_code          text NOT NULL REFERENCES tax_code (code),
  tax_category      text NOT NULL,
  tax_rate          numeric(5,2) NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 100),
  -- T-28: the parts cost recognised at billing (COGS); never shown to customers (rule 9).
  cogs              numeric(14,2) CHECK (cogs IS NULL OR cogs >= 0),
  UNIQUE (invoice_id, revision_line_id),
  UNIQUE (invoice_id, position),
  CHECK (total = net + vat)
);
CREATE INDEX invoice_line_revision_line_idx ON invoice_line (revision_line_id);

-- ---------------------------------------------------------------------------
-- The cap (v0.2.1 §5): net billed per revision line never exceeds what was authorized. Counters change only in
-- the issue (and, from I3, credit-note) transaction under the line lock; the row check below holds them.
-- ---------------------------------------------------------------------------
CREATE TABLE revision_line_billing (
  revision_line_id  uuid PRIMARY KEY REFERENCES revision_line (id),
  net_billed_qty    numeric(18,3) NOT NULL CHECK (net_billed_qty >= 0),
  net_billed_net    numeric(14,2) NOT NULL CHECK (net_billed_net >= 0)
);

CREATE FUNCTION revision_line_billing_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  line record;
  costed numeric;
BEGIN
  SELECT l.qty, l.net, l.line_type, i.stock_tracked INTO line
    FROM revision_line l LEFT JOIN catalogue_item i ON i.id = l.catalogue_item_id WHERE l.id = NEW.revision_line_id;
  IF NEW.revision_line_id NOT IN (SELECT job_authorized_lines(r.job_id) FROM revision_line rl
                                  JOIN job_revision r ON r.id = rl.revision_id WHERE rl.id = NEW.revision_line_id) THEN
    RAISE EXCEPTION 'only authorized lines are billed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.net_billed_qty > line.qty OR NEW.net_billed_net > line.net THEN
    RAISE EXCEPTION 'net billed exceeds what was authorized (v0.2.1 §2.1 #8)' USING ERRCODE = 'check_violation';
  END IF;
  -- P0-06 / B-08: a part line is billed only up to the quantity received for it (issued or bought).
  IF line.line_type = 'part' THEN
    SELECT COALESCE(SUM(qty), 0) INTO costed FROM line_cost_movement WHERE revision_line_id = NEW.revision_line_id;
    IF NEW.net_billed_qty > costed THEN
      RAISE EXCEPTION 'part line billed beyond what was issued or received for it (P0-06)' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_line_billing_guard BEFORE INSERT OR UPDATE ON revision_line_billing
  FOR EACH ROW EXECUTE FUNCTION revision_line_billing_guard();

-- At commit, the counters equal the invoice lines (credit-note lines subtract from I3).
CREATE FUNCTION revision_line_billing_matches() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  line uuid := NEW.revision_line_id;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM revision_line_billing b,
      LATERAL (SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(net), 0) AS net
                 FROM invoice_line WHERE revision_line_id = line) m
     WHERE b.revision_line_id = line AND b.net_billed_qty = m.qty AND b.net_billed_net = m.net) THEN
    RAISE EXCEPTION 'net billed on line % does not equal its invoice lines', line USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER invoice_line_billed AFTER INSERT ON invoice_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION revision_line_billing_matches();
CREATE CONSTRAINT TRIGGER revision_line_billing_billed AFTER INSERT OR UPDATE ON revision_line_billing
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION revision_line_billing_matches();

-- ---------------------------------------------------------------------------
-- WIP → COGS at billing (T-28, amendment §A.1): the line pool's outbound movements.
-- ---------------------------------------------------------------------------
CREATE TABLE line_cogs_movement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_line_id  uuid NOT NULL REFERENCES revision_line (id),
  invoice_line_id   uuid NOT NULL UNIQUE REFERENCES invoice_line (id),
  qty               numeric(18,3) NOT NULL CHECK (qty > 0),
  value             numeric(14,2) NOT NULL CHECK (value >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  business_date     date NOT NULL
);

CREATE FUNCTION line_cogs_movement_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoice_line WHERE id = NEW.invoice_line_id AND revision_line_id = NEW.revision_line_id
                 AND qty = NEW.qty AND cogs = NEW.value) THEN
    RAISE EXCEPTION 'COGS matches its invoice line' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.business_date := business_date_of(now());
  RETURN NEW;
END;
$$;
CREATE TRIGGER line_cogs_movement_guard BEFORE INSERT ON line_cogs_movement
  FOR EACH ROW EXECUTE FUNCTION line_cogs_movement_guard();

-- Line WIP = inbound cost − COGS (replaces 0014's check).
CREATE OR REPLACE FUNCTION line_wip_matches_movements() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  line uuid := NEW.revision_line_id;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM line_wip w,
      LATERAL (SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(value), 0) AS value
                 FROM line_cost_movement WHERE revision_line_id = line) m,
      LATERAL (SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(value), 0) AS value
                 FROM line_cogs_movement WHERE revision_line_id = line) c
     WHERE w.revision_line_id = line AND w.qty = m.qty - c.qty AND w.value = m.value - c.value) THEN
    RAISE EXCEPTION 'cost on line % does not equal its movements', line USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER line_cogs_movement_balanced AFTER INSERT ON line_cogs_movement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION line_wip_matches_movements();

-- ---------------------------------------------------------------------------
-- Issue guards.
-- ---------------------------------------------------------------------------
CREATE FUNCTION invoice_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  latest text;
BEGIN
  SELECT status INTO latest FROM qc_record WHERE repair_order_id = NEW.repair_order_id
   ORDER BY requested_at DESC, id DESC LIMIT 1;
  IF NOT EXISTS (SELECT 1 FROM repair_order WHERE id = NEW.repair_order_id AND status = 'qc'
                 AND customer_id = NEW.customer_id) OR latest IS DISTINCT FROM 'passed' THEN
    RAISE EXCEPTION 'an invoice is issued after a QC pass, to the repair order''s customer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- PRD v0.2 §D1: at most one invoice per repair order that is not fully credited (credit notes arrive with I3).
  IF EXISTS (SELECT 1 FROM invoice WHERE repair_order_id = NEW.repair_order_id) THEN
    RAISE EXCEPTION 'this repair order already has an invoice' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM issued_number WHERE series = 'invoice' AND number_text = NEW.number
                 AND document_id = NEW.id) THEN
    RAISE EXCEPTION 'invoice number was not allocated for it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoice_draft WHERE id = NEW.draft_id AND repair_order_id = NEW.repair_order_id
                 AND status = 'draft') THEN
    RAISE EXCEPTION 'an invoice comes from an open draft of its repair order' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.issued_at := now();
  NEW.business_date := business_date_of(now());
  -- T-32: the snapshot always comes from the live rows at issue, whatever the caller sent.
  SELECT ro.number, c.name_en, c.name_ar, v.make, v.model, v.year, v.vin, p.emirate, p.code, p.number
    INTO NEW.ro_number, NEW.customer_name_en, NEW.customer_name_ar, NEW.vehicle_make, NEW.vehicle_model,
         NEW.vehicle_year, NEW.vehicle_vin, NEW.plate_emirate, NEW.plate_code, NEW.plate_number
    FROM repair_order ro
    JOIN customer c ON c.id = ro.customer_id
    JOIN vehicle v ON v.id = ro.vehicle_id
    LEFT JOIN vehicle_plate p ON p.vehicle_id = v.id AND p.valid_to IS NULL
   WHERE ro.id = NEW.repair_order_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoice_guard BEFORE INSERT ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_guard();

CREATE FUNCTION invoice_line_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- T-29: a line of this repair order, authorized, with a live "done" outcome.
  IF NOT EXISTS (SELECT 1 FROM invoice i JOIN repair_job j ON j.repair_order_id = i.repair_order_id
                 JOIN job_revision r ON r.job_id = j.id JOIN revision_line l ON l.revision_id = r.id
                 WHERE i.id = NEW.invoice_id AND l.id = NEW.revision_line_id AND j.id = NEW.job_id
                   AND l.id IN (SELECT job_authorized_lines(j.id)))
     OR NOT EXISTS (SELECT 1 FROM job_line_outcome WHERE revision_line_id = NEW.revision_line_id
                    AND outcome = 'done' AND superseded_at IS NULL) THEN
    RAISE EXCEPTION 'an invoice line bills an authorized, done line of its repair order (T-29)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoice_line_guard BEFORE INSERT ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION invoice_line_guard();

CREATE FUNCTION invoice_draft_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NOT EXISTS (SELECT 1 FROM repair_order WHERE id = NEW.repair_order_id AND status = 'qc') THEN
      RAISE EXCEPTION 'an invoice draft starts open, on a repair order in QC' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.repair_order_id <> OLD.repair_order_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at <> OLD.created_at OR OLD.status <> 'draft' OR NEW.status = 'draft' THEN
    RAISE EXCEPTION 'an invoice draft is closed once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'issued' AND NOT EXISTS (SELECT 1 FROM invoice WHERE draft_id = NEW.id) THEN
    RAISE EXCEPTION 'a draft is issued only with its invoice' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.closed_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoice_draft_guard BEFORE INSERT OR UPDATE ON invoice_draft
  FOR EACH ROW EXECUTE FUNCTION invoice_draft_guard();

CREATE FUNCTION invoice_draft_line_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoice_draft d JOIN repair_job j ON j.repair_order_id = d.repair_order_id
                 JOIN job_revision r ON r.job_id = j.id JOIN revision_line l ON l.revision_id = r.id
                 WHERE d.id = NEW.draft_id AND d.status = 'draft' AND l.id = NEW.revision_line_id) THEN
    RAISE EXCEPTION 'a draft lists lines of its own repair order' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoice_draft_line_guard BEFORE INSERT ON invoice_draft_line
  FOR EACH ROW EXECUTE FUNCTION invoice_draft_line_guard();

-- ---------------------------------------------------------------------------
-- Repair order transitions (replaces 0016's): Ready needs the QC pass and an issued invoice (B1).
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
  IF NEW.status = 'ready' AND NOT (OLD.status = 'qc' AND latest = 'passed'
       AND EXISTS (SELECT 1 FROM invoice WHERE repair_order_id = OLD.id)) THEN
    RAISE EXCEPTION 'a repair order is ready only after a QC pass and its invoice (B1)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;


REVOKE ALL ON FUNCTION revision_line_billing_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION revision_line_billing_matches() FROM PUBLIC;
REVOKE ALL ON FUNCTION line_cogs_movement_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_line_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_draft_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_draft_line_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants. Issued invoices, their lines and COGS are insert-only; drafts change status once; counters move with lines.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON invoice_draft TO garage_app;
GRANT UPDATE (status, closed_by, closed_at) ON invoice_draft TO garage_app;
GRANT SELECT, INSERT ON invoice_draft_line TO garage_app;
GRANT SELECT, INSERT ON invoice, invoice_line, line_cogs_movement TO garage_app;
GRANT SELECT, INSERT ON revision_line_billing TO garage_app;
GRANT UPDATE (net_billed_qty, net_billed_net) ON revision_line_billing TO garage_app;

-- ---------------------------------------------------------------------------
-- P0-06 / T-30: when the invoice is refused because a part was used but never recorded, the user issues it (or
-- receives and issues it) then: parts may also go to a done job's line whose live outcome is "done" and that is not
-- yet billed, while the repair order is in progress or in QC (replaces 0014's function; everything else unchanged).
-- A "not performed" line never takes parts: its cost could never be billed (T-29).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION line_accepts_parts(line uuid) RETURNS boolean
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
       AND ((j.execution_status IN ('authorized', 'waiting_parts', 'in_progress', 'paused') AND ro.status = 'in_progress')
            OR (j.execution_status = 'done' AND ro.status IN ('in_progress', 'qc')
                AND EXISTS (SELECT 1 FROM job_line_outcome o WHERE o.revision_line_id = l.id
                            AND o.outcome = 'done' AND o.superseded_at IS NULL)
                AND NOT EXISTS (SELECT 1 FROM revision_line_billing b WHERE b.revision_line_id = l.id AND b.net_billed_qty > 0))));
$$;
