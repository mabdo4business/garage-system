-- I2-03a — Customer links: token service and the customer's estimate page. Runs as garage_owner.
-- Spec: PRD v0.2 §6.4 (token, scope, expiry, revocation, data shown, abuse controls), AC2-04, AC2-05; Pre-Impl
-- P1-08 (rate limits as configuration with defaults). Decisions OD-60–OD-63, T-40–T-43.
-- A link is valid only while its version is (T-40): withdrawn, expired or a closed repair order end it without a
-- write here. Revocation is stored only when staff revoke a link or replace it with a new one. Approving through
-- the link is I2-03b.

-- ---------------------------------------------------------------------------
-- The link. Only the SHA-256 of the token is stored; the token itself is shown once, when the link is created.
-- One live (unrevoked) link per version (T-41).
-- ---------------------------------------------------------------------------
CREATE TABLE customer_link (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose              text NOT NULL CHECK (purpose IN ('estimate_approval')),
  repair_order_id      uuid NOT NULL REFERENCES repair_order (id),
  estimate_version_id  uuid NOT NULL REFERENCES estimate_version (id),
  token_hash           bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at           timestamptz NOT NULL,
  created_by           uuid NOT NULL REFERENCES app_user (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  revoked_by           uuid REFERENCES app_user (id),
  revoke_reason        text CHECK (revoke_reason IS NULL OR revoke_reason IN ('manual', 'replaced')),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL) AND (revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX customer_link_one_live ON customer_link (estimate_version_id) WHERE revoked_at IS NULL;
CREATE INDEX customer_link_repair_order_idx ON customer_link (repair_order_id);

-- A link is made for a sent version of its own repair order and lives exactly as long as the version (§6.4).
CREATE FUNCTION customer_link_insert_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v record;
BEGIN
  SELECT ev.status, ev.expires_at, e.repair_order_id INTO v
    FROM estimate_version ev JOIN estimate e ON e.id = ev.estimate_id
   WHERE ev.id = NEW.estimate_version_id;
  IF v.repair_order_id IS DISTINCT FROM NEW.repair_order_id THEN
    RAISE EXCEPTION 'a link belongs to its version''s repair order' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v.status IS DISTINCT FROM 'sent' OR v.expires_at <= now() THEN
    RAISE EXCEPTION 'links are created only for a sent, unexpired version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.expires_at <> v.expires_at OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a new link expires with its version and starts live' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_link_insert_guard BEFORE INSERT ON customer_link
  FOR EACH ROW EXECUTE FUNCTION customer_link_insert_guard();

-- Revoking is the only change, and it happens once.
CREATE FUNCTION customer_link_update_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'a link is revoked once and never restored' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_link_update_guard BEFORE UPDATE ON customer_link
  FOR EACH ROW EXECUTE FUNCTION customer_link_update_guard();

-- ---------------------------------------------------------------------------
-- Every request to a link page (insert-only): what staff see as "opened", and what the rate limits count (AC2-05).
-- An invalid token has no link. The IP is personal data: kept, not purged, until V-1 sets retention (P1-09).
-- ---------------------------------------------------------------------------
CREATE TABLE customer_link_access (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_link_id  uuid REFERENCES customer_link (id),
  outcome           text NOT NULL CHECK (outcome IN ('opened', 'invalid')),
  ip                text NOT NULL CHECK (length(ip) BETWEEN 1 AND 64),
  user_agent        text CHECK (user_agent IS NULL OR length(user_agent) <= 500),
  at                timestamptz NOT NULL DEFAULT now(),
  CHECK (outcome = 'invalid' OR customer_link_id IS NOT NULL)
);
CREATE INDEX customer_link_access_invalid_ip_idx ON customer_link_access (ip, at) WHERE outcome = 'invalid';
CREATE INDEX customer_link_access_link_idx ON customer_link_access (customer_link_id, at);

CREATE FUNCTION customer_link_access_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_link_access_guard BEFORE INSERT ON customer_link_access
  FOR EACH ROW EXECUTE FUNCTION customer_link_access_guard();

-- P1-08: rate limits as configuration, with defaults [assumption — confirm before UAT] (T-42).
INSERT INTO app_setting (key, value) VALUES
  ('link.invalid_per_ip_10min', '10'),
  ('link.requests_per_link_10min', '60');

REVOKE ALL ON FUNCTION customer_link_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_link_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_link_access_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants: links are created and revoked, never deleted; access records are insert-only.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON customer_link TO garage_app;
GRANT UPDATE (revoked_at, revoked_by, revoke_reason) ON customer_link TO garage_app;
GRANT SELECT, INSERT ON customer_link_access TO garage_app;
