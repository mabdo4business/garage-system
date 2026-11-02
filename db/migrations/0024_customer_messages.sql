-- I2-09 — Staff-initiated sharing: messages prepared for the customer and confirmed sent. Runs as garage_owner.
-- Spec: PRD v0.2 E9-S2 ("generated message + link, bilingual, 'shared' confirmation log"), AC2-28 ("Customer not
-- yet informed" after 15 minutes), §3A MVP "staff-initiated sharing (logged)". Decisions OD-68–OD-71, T-46.
-- Both texts are kept as prepared, with the link replaced by "[link]": the token exists only in the customer's URL
-- (T-41). "I sent it" records which language was sent; the texts themselves never change, so the record is what
-- the advisor's screen showed. Once confirmed sent, nothing changes.

CREATE TABLE customer_message (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_order_id   uuid NOT NULL REFERENCES repair_order (id),
  kind              text NOT NULL CHECK (kind IN ('estimate_link', 'vehicle_ready')),
  customer_link_id  uuid REFERENCES customer_link (id),
  language          text NOT NULL CHECK (language IN ('ar', 'en')),
  body_ar           text NOT NULL CHECK (length(body_ar) BETWEEN 1 AND 2000),
  body_en           text NOT NULL CHECK (length(body_en) BETWEEN 1 AND 2000),
  recipient_mobile  text NOT NULL CHECK (length(recipient_mobile) BETWEEN 6 AND 20),
  prepared_by       uuid NOT NULL REFERENCES app_user (id),
  prepared_at       timestamptz NOT NULL DEFAULT now(),
  shared_at         timestamptz,
  shared_by         uuid REFERENCES app_user (id),
  CHECK ((kind = 'estimate_link') = (customer_link_id IS NOT NULL)),
  CHECK ((shared_at IS NULL) = (shared_by IS NULL)),
  -- The token never reaches this table, only the placeholder (a link path with a token would match /c/<43 chars>).
  CHECK (kind <> 'estimate_link' OR (body_ar LIKE '%[link]%' AND body_en LIKE '%[link]%')),
  CHECK (body_ar !~ '/c/[A-Za-z0-9_-]{43}' AND body_en !~ '/c/[A-Za-z0-9_-]{43}')
);
CREATE INDEX customer_message_repair_order_idx ON customer_message (repair_order_id, kind, prepared_at);

CREATE FUNCTION customer_message_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.shared_at IS NOT NULL THEN
      RAISE EXCEPTION 'a message starts unsent' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.prepared_at := now();
    RETURN NEW;
  END IF;
  -- Sent once, then never changed; the texts never change at all (the app has no UPDATE on them either).
  IF OLD.shared_at IS NOT NULL OR NEW.body_ar IS DISTINCT FROM OLD.body_ar OR NEW.body_en IS DISTINCT FROM OLD.body_en THEN
    RAISE EXCEPTION 'a message confirmed sent does not change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.shared_at IS NOT NULL THEN
    NEW.shared_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_message_guard BEFORE INSERT OR UPDATE ON customer_message
  FOR EACH ROW EXECUTE FUNCTION customer_message_guard();

REVOKE ALL ON FUNCTION customer_message_guard() FROM PUBLIC;

GRANT SELECT, INSERT ON customer_message TO garage_app;
-- "I sent it": which language was sent, by whom, once.
GRANT UPDATE (language, shared_at, shared_by) ON customer_message TO garage_app;
