-- I1-03 — Inspection findings. Runs as garage_owner.
-- Spec: PRD v0.1 EP-05 (US-05.1–05.3, AC-05.3); PRD v0.2 B1 Checked-in → Diagnosing ("technician assigned to
-- inspection", ro.diagnosis_started), AC2-30, AC2-31. Decisions OD-8…OD-11, T-10, T-11.

-- ---------------------------------------------------------------------------
-- Inspection assignment (OD-8): at most one active technician per repair order.
-- ---------------------------------------------------------------------------
CREATE TABLE inspection_assignment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_order_id     uuid NOT NULL REFERENCES repair_order (id),
  technician_user_id  uuid NOT NULL REFERENCES app_user (id),
  assigned_at         timestamptz NOT NULL DEFAULT now(),
  assigned_by         uuid REFERENCES app_user (id),
  ended_at            timestamptz,
  ended_by            uuid REFERENCES app_user (id),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
CREATE UNIQUE INDEX inspection_assignment_active_key ON inspection_assignment (repair_order_id) WHERE ended_at IS NULL;
CREATE INDEX inspection_assignment_technician_idx ON inspection_assignment (technician_user_id) WHERE ended_at IS NULL;

CREATE FUNCTION inspection_assignment_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'an assignment starts active' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Only an active technician can be assigned (T-11; the command checks the same thing first).
    IF NOT EXISTS (SELECT 1 FROM app_user u JOIN user_role r ON r.user_id = u.id
                   WHERE u.id = NEW.technician_user_id AND u.status = 'active' AND r.role = 'technician') THEN
      RAISE EXCEPTION 'only an active technician can be assigned' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.assigned_at := now();
    RETURN NEW;
  END IF;
  -- UPDATE: an assignment is ended once and never reopened or rewritten.
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'assignment % can only be ended once', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inspection_assignment_guard
  BEFORE INSERT OR UPDATE ON inspection_assignment
  FOR EACH ROW EXECUTE FUNCTION inspection_assignment_guard();

-- ---------------------------------------------------------------------------
-- Checklist templates (US-05.1, OD-9). Seeded; editing them is E4-S3 (P1). [owner review]
-- ---------------------------------------------------------------------------
CREATE TABLE checklist_template (
  code      text PRIMARY KEY CHECK (code ~ '^[a-z_]{2,40}$'),
  name_en   text NOT NULL,
  name_ar   text NOT NULL,
  position  integer NOT NULL
);
CREATE TABLE checklist_template_item (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_code  text NOT NULL REFERENCES checklist_template (code),
  position       integer NOT NULL,
  label_en       text NOT NULL,
  label_ar       text NOT NULL,
  UNIQUE (template_code, position)
);

INSERT INTO checklist_template (code, name_en, name_ar, position) VALUES
  ('periodic_service', 'Periodic service', 'الصيانة الدورية', 1),
  ('air_conditioning', 'Air conditioning', 'التكييف', 2),
  ('electrical', 'Electrical', 'الكهرباء', 3);

INSERT INTO checklist_template_item (template_code, position, label_en, label_ar) VALUES
  ('periodic_service', 1, 'Engine oil level and condition', 'مستوى زيت المحرك وحالته'),
  ('periodic_service', 2, 'Oil leaks', 'تسريب الزيت'),
  ('periodic_service', 3, 'Coolant level and leaks', 'مستوى سائل التبريد والتسريب'),
  ('periodic_service', 4, 'Brake fluid level', 'مستوى زيت الفرامل'),
  ('periodic_service', 5, 'Front brake pads and discs', 'فحمات وأقراص الفرامل الأمامية'),
  ('periodic_service', 6, 'Rear brake pads, discs or drums', 'فحمات وأقراص أو طبول الفرامل الخلفية'),
  ('periodic_service', 7, 'Tyre tread and pressure', 'عمق نقشة الإطارات وضغطها'),
  ('periodic_service', 8, 'Battery and terminals', 'البطارية والأقطاب'),
  ('periodic_service', 9, 'Drive belts', 'السيور'),
  ('periodic_service', 10, 'Air filter', 'فلتر الهواء'),
  ('periodic_service', 11, 'Cabin filter', 'فلتر المقصورة'),
  ('periodic_service', 12, 'Steering and suspension play', 'الخلوص في التوجيه والتعليق'),
  ('periodic_service', 13, 'Lights and indicators', 'الأضواء والإشارات'),
  ('periodic_service', 14, 'Wipers and washer fluid', 'المساحات وسائل الغسيل'),
  ('air_conditioning', 1, 'Vent outlet temperature', 'درجة حرارة هواء الفتحات'),
  ('air_conditioning', 2, 'Compressor engagement', 'تشغيل الكمبروسر'),
  ('air_conditioning', 3, 'Refrigerant pressures (low and high side)', 'ضغط غاز التبريد (الجهة المنخفضة والمرتفعة)'),
  ('air_conditioning', 4, 'Condenser condition and fan', 'حالة المكثف والمروحة'),
  ('air_conditioning', 5, 'Visible leaks (oil or dye)', 'تسريب ظاهر (زيت أو صبغة)'),
  ('air_conditioning', 6, 'Blower speeds', 'سرعات المروحة الداخلية'),
  ('air_conditioning', 7, 'Cabin filter', 'فلتر المقصورة'),
  ('air_conditioning', 8, 'Smell or noise from the system', 'رائحة أو صوت من النظام'),
  ('electrical', 1, 'Battery test (state of health)', 'فحص البطارية (حالتها)'),
  ('electrical', 2, 'Charging voltage', 'جهد الشحن'),
  ('electrical', 3, 'Starter operation', 'عمل السلف'),
  ('electrical', 4, 'Diagnostic scan (fault codes)', 'فحص الكمبيوتر (أكواد الأعطال)'),
  ('electrical', 5, 'Warning lights on the dashboard', 'لمبات التحذير في لوحة العدادات'),
  ('electrical', 6, 'Exterior and interior lights', 'الأضواء الخارجية والداخلية'),
  ('electrical', 7, 'Fuses and relays', 'الفيوزات والريليهات'),
  ('electrical', 8, 'Visible wiring damage', 'تلف ظاهر في الأسلاك');

-- ---------------------------------------------------------------------------
-- Findings (US-05.2, US-05.3). Editable while the repair order is Checked-in or Diagnosing; withdrawn
-- findings never change (OD-10). Internal notes stay in their own column (rule 9, AC-05.3).
-- ---------------------------------------------------------------------------
CREATE TABLE finding (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_order_id   uuid NOT NULL REFERENCES repair_order (id),
  template_item_id  uuid REFERENCES checklist_template_item (id),
  title             text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  severity          text NOT NULL CHECK (severity IN ('ok', 'soon', 'urgent')),
  fault_codes       text[] NOT NULL DEFAULT '{}'
                      CHECK (cardinality(fault_codes) <= 10
                             AND array_to_string(fault_codes, ',') ~ '^([A-Z0-9-]{2,12}(,[A-Z0-9-]{2,12})*)?$'),
  customer_note     text CHECK (customer_note IS NULL OR length(customer_note) <= 2000),
  internal_note     text CHECK (internal_note IS NULL OR length(internal_note) <= 2000),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  withdrawn_reason  text CHECK (withdrawn_reason IS NULL OR length(btrim(withdrawn_reason)) BETWEEN 1 AND 500),
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by       uuid REFERENCES app_user (id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES app_user (id),
  CHECK ((status = 'withdrawn') = (withdrawn_reason IS NOT NULL))
);
CREATE INDEX finding_repair_order_idx ON finding (repair_order_id);

CREATE FUNCTION finding_guard() RETURNS trigger
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
  END IF;
  IF NOT EXISTS (SELECT 1 FROM repair_order WHERE id = NEW.repair_order_id
                 AND status IN ('checked_in', 'diagnosing')) THEN
    RAISE EXCEPTION 'findings change only while the repair order is checked in or diagnosing'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finding_guard
  BEFORE INSERT OR UPDATE ON finding
  FOR EACH ROW EXECUTE FUNCTION finding_guard();

-- ---------------------------------------------------------------------------
-- Finding photos share media_asset: exactly one parent (a check-in or a finding).
-- ---------------------------------------------------------------------------
ALTER TABLE media_asset ALTER COLUMN check_in_id DROP NOT NULL;
ALTER TABLE media_asset ADD COLUMN finding_id uuid REFERENCES finding (id);
ALTER TABLE media_asset ADD CONSTRAINT media_asset_one_parent CHECK ((check_in_id IS NULL) <> (finding_id IS NULL));
CREATE INDEX media_asset_finding_idx ON media_asset (finding_id) WHERE finding_id IS NOT NULL;

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
    -- Finding photos start internal (OD-11) on an active finding of an open inspection.
    IF NEW.visibility <> 'internal'
       OR NOT EXISTS (SELECT 1 FROM finding f JOIN repair_order ro ON ro.id = f.repair_order_id
                      WHERE f.id = NEW.finding_id AND f.status = 'active'
                        AND ro.status IN ('checked_in', 'diagnosing')) THEN
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
    -- Finding photo: never locked or excluded; discarded once; visibility may change while it is
    -- current and its finding is active and editable.
    IF NEW.locked_at IS NOT NULL OR NEW.repair_order_id IS NOT NULL OR NEW.excluded_at IS NOT NULL
       OR OLD.discarded_at IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM finding f JOIN repair_order ro ON ro.id = f.repair_order_id
                      WHERE f.id = OLD.finding_id AND f.status = 'active'
                        AND ro.status IN ('checked_in', 'diagnosing')) THEN
      RAISE EXCEPTION 'finding photo % cannot change this way', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- Check-in photo (rules from 0006, unchanged); visibility is fixed for check-in photos.
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

REVOKE ALL ON FUNCTION inspection_assignment_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION finding_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants. No DELETE anywhere.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON inspection_assignment TO garage_app;
GRANT UPDATE (ended_at, ended_by) ON inspection_assignment TO garage_app;
GRANT SELECT ON checklist_template, checklist_template_item TO garage_app;
GRANT SELECT, INSERT ON finding TO garage_app;
GRANT UPDATE (title, severity, fault_codes, customer_note, internal_note, status, withdrawn_reason, updated_at,
              updated_by) ON finding TO garage_app;
GRANT UPDATE (visibility) ON media_asset TO garage_app;
