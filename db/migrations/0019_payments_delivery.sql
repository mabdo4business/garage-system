-- I1-10 — Payments and delivery. Runs as garage_owner.
-- Spec: PRD v0.2 §D2 (payment record: invoice issued, 0 < amount ≤ balance due, method, card/transfer reference and
-- never card numbers, idempotency key), §B1 (Ready → Delivered with balance 0 or a release override; Delivered →
-- Closed at balance 0), AC2-20–22, AC2-27; v0.2.1 §4.1 (P = payments; credits, refunds and reversals arrive in I3).
-- Decisions OD-51 (cash, card, transfer), OD-52 (no cash rounding), OD-53 (partner releases with balance), OD-54
-- (handover checklist), T-36. Commands lock the repair order first; the sums below rely on that.

-- ---------------------------------------------------------------------------
-- Payments: insert-only (rule 6). Reversals are new records (I3-05).
-- ---------------------------------------------------------------------------
CREATE TABLE payment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid NOT NULL REFERENCES invoice (id),
  repair_order_id  uuid NOT NULL REFERENCES repair_order (id),
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  method           text NOT NULL CHECK (method IN ('cash', 'card', 'transfer')),
  -- Card: the terminal approval code; transfer: the transfer reference (T-36). Never a card number.
  reference        text,
  idempotency_key  uuid NOT NULL UNIQUE,
  recorded_by      uuid NOT NULL REFERENCES app_user (id),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  business_date    date NOT NULL,
  CHECK ((method = 'cash') = (reference IS NULL)),
  CHECK (method <> 'card' OR reference ~ '^[A-Za-z0-9]{4,12}$'),
  CHECK (method <> 'transfer' OR length(btrim(reference)) BETWEEN 3 AND 40)
);
CREATE INDEX payment_invoice_idx ON payment (invoice_id);
CREATE INDEX payment_business_date_idx ON payment (business_date);

-- Balance due of one invoice: total − payments (v0.2.1 §4.1 before I3's credits and refunds).
CREATE FUNCTION invoice_balance(inv uuid) RETURNS numeric
  LANGUAGE sql STABLE AS $$
  SELECT i.total - COALESCE((SELECT SUM(p.amount) FROM payment p WHERE p.invoice_id = i.id), 0)
    FROM invoice i WHERE i.id = inv;
$$;

-- Balance due of a repair order: its invoice's balance; NULL when there is no invoice. invoice_guard (0017) allows
-- one invoice per repair order. I3-02 relaxes that ("at most one not fully credited") and must redefine this — it
-- refuses to guess when there are several.
CREATE FUNCTION repair_order_balance(ro uuid) RETURNS numeric
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  invoices uuid[];
BEGIN
  SELECT array_agg(id) INTO invoices FROM invoice WHERE repair_order_id = ro;
  IF invoices IS NULL THEN
    RETURN NULL;
  END IF;
  IF cardinality(invoices) > 1 THEN
    RAISE EXCEPTION 'repair order % has more than one invoice; redefine repair_order_balance (I3-02)', ro
      USING ERRCODE = 'feature_not_supported';
  END IF;
  RETURN invoice_balance(invoices[1]);
END;
$$;

CREATE FUNCTION payment_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  balance numeric;
BEGIN
  -- The repair-order row lock serialises balance changes even for a writer that skipped the command's lock.
  PERFORM 1 FROM repair_order WHERE id = NEW.repair_order_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM invoice i JOIN repair_order ro ON ro.id = i.repair_order_id
                  WHERE i.id = NEW.invoice_id AND ro.id = NEW.repair_order_id
                    AND ro.status IN ('ready', 'delivered')) THEN
    RAISE EXCEPTION 'payments are recorded against the issued invoice of a ready or delivered repair order'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  balance := invoice_balance(NEW.invoice_id);
  -- AC2-21: no overpayment (cash change is given at the counter).
  IF NEW.amount > balance THEN
    RAISE EXCEPTION 'amount exceeds balance due (%)', balance USING ERRCODE = 'check_violation';
  END IF;
  NEW.recorded_at := now();
  NEW.business_date := business_date_of(now());
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_guard BEFORE INSERT ON payment FOR EACH ROW EXECUTE FUNCTION payment_guard();

-- ---------------------------------------------------------------------------
-- Handover: one per repair order, insert-only. The balance at delivery is set here from the database, never taken
-- from the caller; a balance above zero needs a partner (OD-53) and a reason (AC2-27).
-- ---------------------------------------------------------------------------
CREATE TABLE vehicle_delivery (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_order_id      uuid NOT NULL UNIQUE REFERENCES repair_order (id),
  keys_returned        boolean NOT NULL CHECK (keys_returned),
  belongings_returned  boolean NOT NULL CHECK (belongings_returned),
  balance_due          numeric(14,2) NOT NULL CHECK (balance_due >= 0),
  override_reason      text CHECK (override_reason IS NULL OR length(btrim(override_reason)) BETWEEN 1 AND 500),
  delivered_by         uuid NOT NULL REFERENCES app_user (id),
  delivered_at         timestamptz NOT NULL DEFAULT now(),
  business_date        date NOT NULL,
  CHECK ((balance_due > 0) = (override_reason IS NOT NULL))
);
CREATE INDEX vehicle_delivery_override_idx ON vehicle_delivery (business_date) WHERE override_reason IS NOT NULL;

CREATE FUNCTION vehicle_delivery_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM repair_order WHERE id = NEW.repair_order_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM repair_order WHERE id = NEW.repair_order_id AND status = 'ready') THEN
    RAISE EXCEPTION 'only a ready repair order is handed over' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.balance_due := repair_order_balance(NEW.repair_order_id);
  IF NEW.balance_due IS NULL THEN
    RAISE EXCEPTION 'no invoice for this repair order' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.balance_due > 0 AND (NEW.override_reason IS NULL OR NOT EXISTS (
       SELECT 1 FROM user_role WHERE user_id = NEW.delivered_by AND role = 'partner')) THEN
    RAISE EXCEPTION 'release with a balance due needs a partner and a reason (AC2-27, OD-53)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.balance_due = 0 THEN
    NEW.override_reason := NULL;
  END IF;
  NEW.delivered_at := now();
  NEW.business_date := business_date_of(now());
  RETURN NEW;
END;
$$;
CREATE TRIGGER vehicle_delivery_guard BEFORE INSERT ON vehicle_delivery
  FOR EACH ROW EXECUTE FUNCTION vehicle_delivery_guard();

-- ---------------------------------------------------------------------------
-- Repair order transitions, extended for delivery and closing.
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
  -- I1-10 (B1): Ready → Delivered with its delivery record (balance 0, or a partner's override with a reason,
  -- checked by vehicle_delivery_guard); Delivered → Closed once the balance is 0. Nothing else leaves Ready or
  -- Delivered yet (reopening for correction arrives with credit notes, I3-02); Closed is final.
  IF OLD.status = 'ready' AND NEW.status <> 'delivered' THEN
    RAISE EXCEPTION 'a ready repair order is only delivered' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'delivered' AND NOT (OLD.status = 'ready'
       AND EXISTS (SELECT 1 FROM vehicle_delivery WHERE repair_order_id = OLD.id)) THEN
    RAISE EXCEPTION 'a repair order is delivered only from Ready, with its handover recorded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'delivered' AND NEW.status <> 'closed' THEN
    RAISE EXCEPTION 'a delivered repair order only closes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'closed' AND NOT (OLD.status = 'delivered' AND repair_order_balance(OLD.id) = 0) THEN
    RAISE EXCEPTION 'a repair order closes only when delivered and fully paid (B1)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'a closed repair order does not change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION payment_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION vehicle_delivery_guard() FROM PUBLIC;

-- Grants: both are records of what happened — insert-only.
GRANT SELECT, INSERT ON payment TO garage_app;
GRANT SELECT, INSERT ON vehicle_delivery TO garage_app;
GRANT EXECUTE ON FUNCTION invoice_balance(uuid) TO garage_app;
GRANT EXECUTE ON FUNCTION repair_order_balance(uuid) TO garage_app;
