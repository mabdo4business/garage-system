-- Increment 0 — engineering foundations.
-- Runs as garage_owner. Every table grants garage_app only what the application needs.
-- Spec references: PRD v0.2.1 §5, Pre-Implementation Review P0-01/02/03/09, P1-07,
-- Final Consistency Review F-07/F-09, Specification Amendment v0.2.2.

-- ---------------------------------------------------------------------------
-- Business date: the Asia/Dubai calendar date of a timestamp (P1-07).
-- Commands call it with now(), the database transaction timestamp.
-- ---------------------------------------------------------------------------
CREATE FUNCTION business_date_of(ts timestamptz) RETURNS date
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT (ts AT TIME ZONE 'Asia/Dubai')::date $$;

-- ---------------------------------------------------------------------------
-- Users, roles, sessions (S9)
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        text NOT NULL CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 64),
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  password_hash   text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz,
  CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL))
);
CREATE UNIQUE INDEX app_user_username_key ON app_user (username);

CREATE TABLE user_role (
  user_id  uuid NOT NULL REFERENCES app_user (id),
  role     text NOT NULL CHECK (role IN
             ('partner', 'manager', 'service_advisor', 'technician', 'store_keeper', 'accountant')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE user_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE,          -- SHA-256 of the session token; the token itself is never stored
  user_id       uuid NOT NULL REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX user_session_user_idx ON user_session (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Audit log — append-only (S3). garage_app may INSERT and SELECT only.
-- seq is unique and increasing in allocation order; a rolled-back transaction
-- leaves a gap. It is not a document-numbering series.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_event (
  seq            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  business_date  date NOT NULL,
  command_name   text NOT NULL,
  command_id     uuid NOT NULL,
  actor_user_id  uuid REFERENCES app_user (id),
  actor_label    text NOT NULL,                 -- 'user', 'system:<name>' or 'anonymous'
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text NOT NULL,
  before_state   jsonb,
  after_state    jsonb,
  details        jsonb
);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id);
CREATE INDEX audit_event_command_idx ON audit_event (command_id);

-- ---------------------------------------------------------------------------
-- Idempotency (S5, Amendment v0.2.2 A.3 / F-07).
-- The row is inserted FIRST inside the command transaction; the result is written
-- in the same transaction. A concurrent duplicate waits on the primary key.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_key (
  command_name   text NOT NULL,
  key            uuid NOT NULL,
  request_hash   text NOT NULL,
  actor_user_id  uuid REFERENCES app_user (id),
  result         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (command_name, key)
);
CREATE INDEX idempotency_key_created_idx ON idempotency_key (created_at);

-- ---------------------------------------------------------------------------
-- Outbox (S7, P0-01): side effects happen only after commit.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_message (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  command_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  available_at  timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    text,
  processed_at  timestamptz
);
CREATE INDEX outbox_message_pending_idx ON outbox_message (available_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Document numbering (S6, F-09). One locked counter row per series.
-- Format and reset rules are configuration pending tax-agent verification (V-2).
-- ---------------------------------------------------------------------------
CREATE TABLE number_series (
  series      text PRIMARY KEY,
  prefix      text NOT NULL,
  pad_width   integer NOT NULL DEFAULT 6 CHECK (pad_width BETWEEN 1 AND 12),
  next_value  bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1)
);

INSERT INTO number_series (series, prefix) VALUES
  ('invoice',        'INV-'),
  ('credit_note',    'CN-'),
  ('release_note',   'RN-'),
  ('service_record', 'SR-'),
  ('test_document',  'TD-');

CREATE TABLE issued_number (
  series         text NOT NULL REFERENCES number_series (series),
  value          bigint NOT NULL CHECK (value >= 1),
  number_text    text NOT NULL,
  document_type  text NOT NULL,
  document_id    uuid NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  business_date  date NOT NULL,
  PRIMARY KEY (series, value),
  UNIQUE (series, number_text)
);

-- ---------------------------------------------------------------------------
-- Stub "test document" (S8): exercises the full command pattern.
-- Drafts are editable; the issue record is insert-only.
-- ---------------------------------------------------------------------------
CREATE TABLE test_document (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  amount      numeric(14, 2) NOT NULL CHECK (amount >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES app_user (id)
);

CREATE TABLE test_document_issue (
  document_id    uuid PRIMARY KEY REFERENCES test_document (id),
  series         text NOT NULL,
  number_value   bigint NOT NULL,
  number_text    text NOT NULL,
  business_date  date NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  issued_by      uuid REFERENCES app_user (id),
  snapshot       jsonb NOT NULL,
  UNIQUE (series, number_value),
  FOREIGN KEY (series, number_value) REFERENCES issued_number (series, value)
);

-- ---------------------------------------------------------------------------
-- Grants for the application role. Anything not granted here is denied.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON app_user TO garage_app;
GRANT UPDATE (display_name, password_hash, status, deactivated_at) ON app_user TO garage_app;
GRANT SELECT, INSERT, DELETE ON user_role TO garage_app;
GRANT SELECT, INSERT ON user_session TO garage_app;
GRANT UPDATE (last_seen_at, revoked_at) ON user_session TO garage_app;

GRANT SELECT, INSERT ON audit_event TO garage_app;

GRANT SELECT, INSERT, DELETE ON idempotency_key TO garage_app;
GRANT UPDATE (result) ON idempotency_key TO garage_app;

GRANT SELECT, INSERT ON outbox_message TO garage_app;
GRANT UPDATE (available_at, attempts, last_error, processed_at) ON outbox_message TO garage_app;

GRANT SELECT ON number_series TO garage_app;
GRANT UPDATE (next_value) ON number_series TO garage_app;
GRANT SELECT, INSERT ON issued_number TO garage_app;

GRANT SELECT, INSERT ON test_document TO garage_app;
GRANT UPDATE (title, amount) ON test_document TO garage_app;
GRANT SELECT, INSERT ON test_document_issue TO garage_app;
