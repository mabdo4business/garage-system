-- I1-04 — Catalog & tax. Runs as garage_owner.
-- Spec: v0.2.1 §4.4 (tax configuration), v0.2 §4.2 and GAP-02 (VAT mode), Pre-Implementation Review P0-06
-- (stock-tracked vs non-stock), US-06.1, US-08.1. Decisions B-08, OD-12…OD-15, T-14…T-17.
-- Nothing tax-related is seeded (OD-13): codes, categories and rates are for the tax agent (V-2).

-- ---------------------------------------------------------------------------
-- Tax profile (VAT mode) history: one row per change, effective from a business date.
-- ---------------------------------------------------------------------------
CREATE TABLE tax_profile (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_status  text NOT NULL CHECK (registration_status IN ('not_registered', 'registered')),
  trn                  text CHECK (trn IS NULL OR trn ~ '^[0-9]{15}$'),
  effective_from       date NOT NULL UNIQUE,
  note                 text CHECK (note IS NULL OR length(note) <= 500),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES app_user (id),
  CHECK ((registration_status = 'registered') = (trn IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Tax codes. Categories are the spec's placeholders; which exist and where they apply is V-2.
-- ---------------------------------------------------------------------------
CREATE TABLE tax_code (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  label_en    text NOT NULL CHECK (length(btrim(label_en)) BETWEEN 1 AND 100),
  label_ar    text NOT NULL CHECK (length(btrim(label_ar)) BETWEEN 1 AND 100),
  category    text NOT NULL CHECK (category IN ('standard', 'zero_rated', 'exempt', 'out_of_scope', 'not_registered')),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES app_user (id)
);

CREATE TABLE tax_code_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL REFERENCES tax_code (code),
  rate            numeric(5,2) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  effective_from  date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES app_user (id),
  UNIQUE (code, effective_from)
);

-- ---------------------------------------------------------------------------
-- Catalogue: labor rates, packages, parts and non-stock items (B-08).
-- ---------------------------------------------------------------------------
CREATE TABLE catalogue_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('labor_rate', 'package', 'part')),
  code            text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9._/-]{1,40}$'),
  name_en         text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 200),
  name_ar         text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 200),
  description_en  text CHECK (description_en IS NULL OR length(description_en) <= 1000),
  description_ar  text CHECK (description_ar IS NULL OR length(description_ar) <= 1000),
  part_no         text CHECK (part_no IS NULL OR length(btrim(part_no)) BETWEEN 1 AND 60),
  brand           text CHECK (brand IS NULL OR length(btrim(brand)) BETWEEN 1 AND 100),
  part_type       text CHECK (part_type IS NULL OR part_type IN ('oem', 'aftermarket', 'other')),
  unit            text CHECK (unit IS NULL OR unit IN ('piece', 'set', 'litre', 'kg', 'metre', 'job')),
  stock_tracked   boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES app_user (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES app_user (id),
  -- Parts carry part details and a unit; only parts can be stock-tracked (P0-06).
  CHECK ((kind = 'part') = (unit IS NOT NULL)),
  CHECK (kind = 'part' OR (part_no IS NULL AND brand IS NULL AND part_type IS NULL AND NOT stock_tracked))
);
CREATE INDEX catalogue_item_kind_idx ON catalogue_item (kind, active);

-- Price history, insert-only. Prices include VAT (OD-14).
CREATE TABLE catalogue_price (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES catalogue_item (id),
  price           numeric(14,2) NOT NULL CHECK (price >= 0),
  tax_code        text NOT NULL REFERENCES tax_code (code),
  effective_from  timestamptz NOT NULL DEFAULT now(),
  set_by          uuid REFERENCES app_user (id)
);
CREATE INDEX catalogue_price_item_idx ON catalogue_price (item_id, effective_from DESC);

-- ---------------------------------------------------------------------------
-- Guards: histories are insert-only with the database's own time; kind and stock flag never change.
-- ---------------------------------------------------------------------------
CREATE FUNCTION catalogue_stamp_now() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'catalogue_price' THEN
    -- The moment of the insert, not of the transaction start: a price change that waited for the item
    -- lock must still be later than the price it replaces (cf. the I1-01 ownership fix).
    NEW.effective_from := clock_timestamp();
  ELSE
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalogue_price_stamp BEFORE INSERT ON catalogue_price
  FOR EACH ROW EXECUTE FUNCTION catalogue_stamp_now();
CREATE TRIGGER tax_profile_stamp BEFORE INSERT ON tax_profile
  FOR EACH ROW EXECUTE FUNCTION catalogue_stamp_now();
CREATE TRIGGER tax_code_rate_stamp BEFORE INSERT ON tax_code_rate
  FOR EACH ROW EXECUTE FUNCTION catalogue_stamp_now();

CREATE FUNCTION catalogue_item_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.stock_tracked <> OLD.stock_tracked OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'catalogue item % keeps its kind, code and stock flag (T-17)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalogue_item_guard BEFORE INSERT OR UPDATE ON catalogue_item
  FOR EACH ROW EXECUTE FUNCTION catalogue_item_guard();

REVOKE ALL ON FUNCTION catalogue_stamp_now() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalogue_item_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants. Histories: SELECT, INSERT only. No DELETE anywhere.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON tax_profile, tax_code_rate, catalogue_price TO garage_app;
GRANT SELECT, INSERT ON tax_code TO garage_app;
GRANT UPDATE (label_en, label_ar, active) ON tax_code TO garage_app;
GRANT SELECT, INSERT ON catalogue_item TO garage_app;
GRANT UPDATE (name_en, name_ar, description_en, description_ar, part_no, brand, part_type, unit, active,
              updated_at, updated_by) ON catalogue_item TO garage_app;
