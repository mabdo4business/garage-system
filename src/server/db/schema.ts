import type { ColumnType, Generated } from "kysely";

/**
 * Database types for Kysely. Hand-written to match db/migrations.
 *
 * Conventions (PostgreSQL driver defaults are kept on purpose):
 *  - numeric  -> string  (exact; converted with Money/Qty, never to a JS float)
 *  - bigint   -> string  (exact)
 *  - timestamptz -> Date
 *  - date     -> string 'YYYY-MM-DD' (parser registered in db/client.ts)
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type DbDate = ColumnType<string, string, string>;
type BigintStr = ColumnType<string, string | bigint | number, string | bigint | number>;
type Json = ColumnType<unknown, string, string>;

export interface AppUserTable {
  id: Generated<string>;
  username: string;
  display_name: string;
  password_hash: string;
  status: Generated<"active" | "deactivated">;
  created_at: Generated<Date>;
  deactivated_at: Timestamp | null;
}

export interface UserRoleTable {
  user_id: string;
  role: string;
}

export interface UserSessionTable {
  id: Generated<string>;
  token_hash: Buffer;
  user_id: string;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface AuditEventTable {
  seq: Generated<string>;
  occurred_at: Generated<Date>;
  business_date: DbDate;
  command_name: string;
  command_id: string;
  actor_user_id: string | null;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_state: Json | null;
  after_state: Json | null;
  details: Json | null;
}

export interface IdempotencyKeyTable {
  command_name: string;
  key: string;
  request_hash: string;
  actor_user_id: string | null;
  result: Json | null;
  created_at: Generated<Date>;
}

export interface OutboxMessageTable {
  id: Generated<string>;
  topic: string;
  payload: Json;
  command_id: string;
  created_at: Generated<Date>;
  available_at: Generated<Date>;
  attempts: Generated<number>;
  last_error: string | null;
  processed_at: Timestamp | null;
}

export interface NumberSeriesTable {
  series: string;
  prefix: string;
  pad_width: Generated<number>;
  next_value: ColumnType<string, string | bigint | number | undefined, string | bigint | number>;
}

export interface IssuedNumberTable {
  series: string;
  value: BigintStr;
  number_text: string;
  document_type: string;
  document_id: string;
  issued_at: Generated<Date>;
  business_date: DbDate;
}

export interface TestDocumentTable {
  id: Generated<string>;
  title: string;
  amount: string;
  created_at: Generated<Date>;
  created_by: string | null;
}

export interface TestDocumentIssueTable {
  document_id: string;
  series: string;
  number_value: BigintStr;
  number_text: string;
  business_date: DbDate;
  issued_at: Generated<Date>;
  issued_by: string | null;
  snapshot: Json;
}

export interface CustomerTable {
  id: Generated<string>;
  name_en: string | null;
  name_ar: string | null;
  mobile: string;
  mobile_normalized: string;
  email: string | null;
  preferred_language: "ar" | "en";
  marketing_consent: Generated<boolean>;
  created_at: Generated<Date>;
  created_by: string | null;
}

export interface VehicleTable {
  id: Generated<string>;
  vin: string | null;
  make: string;
  model: string;
  year: number;
  colour: string | null;
  created_at: Generated<Date>;
  created_by: string | null;
}

export type Emirate =
  "abu_dhabi" | "dubai" | "sharjah" | "ajman" | "umm_al_quwain" | "ras_al_khaimah" | "fujairah";

export interface VehiclePlateTable {
  id: Generated<string>;
  vehicle_id: string;
  emirate: Emirate;
  code: string;
  number: string;
  valid_from: Timestamp; // has a DEFAULT; commands pass the instant read under the lock
  valid_to: Timestamp | null;
  changed_by: string | null;
}

export interface VehicleOwnershipTable {
  id: Generated<string>;
  vehicle_id: string;
  customer_id: string;
  valid_from: Timestamp; // has a DEFAULT; commands pass the instant read under the lock
  valid_to: Timestamp | null;
  changed_by: string | null;
}

export interface SchemaMigrationTable {
  version: string;
  checksum: string;
  applied_at: Generated<Date>;
}

// I1-02 — repair order & check-in (0005)

export interface AppSettingTable {
  key: string;
  value: Json;
}

export type ContactRelationship = "owner" | "driver" | "company_representative" | "other";
export type CheckInStatus = "in_progress" | "completed" | "abandoned";
export type RepairOrderStatus =
  | "checked_in"
  | "diagnosing"
  | "awaiting_approval"
  | "in_progress"
  | "qc"
  | "release_check"
  | "ready"
  | "delivered"
  | "closed"
  | "cancelled";
export type PhotoSlot = "front" | "rear" | "left" | "right" | "odometer" | "other";
export type ImageType = "image/jpeg" | "image/png" | "image/webp";

export interface CheckInTable {
  id: Generated<string>;
  customer_id: string;
  vehicle_id: string;
  status: Generated<CheckInStatus>;
  contact_name: string | null;
  contact_mobile: string | null;
  contact_mobile_normalized: string | null;
  contact_relationship: ContactRelationship | null;
  odometer_km: number | null;
  fuel_eighths: number | null;
  warning_lights: string | null;
  concerns: string | null;
  belongings: string | null;
  keys_received: number | null;
  key_tag: string | null;
  promised_at: Timestamp | null;
  photo_shortfall_reason: string | null;
  abandoned_reason: string | null;
  created_at: Generated<Date>;
  created_by: string | null;
  updated_at: Timestamp;
}

export interface RepairOrderTable {
  id: Generated<string>;
  number: string;
  status: Generated<RepairOrderStatus>;
  customer_id: string;
  vehicle_id: string;
  check_in_id: string;
  contact_name: string;
  contact_mobile: string;
  contact_relationship: ContactRelationship;
  odometer_km: number;
  fuel_eighths: number | null; // optional since 0006 (OD-6)
  warning_lights: string | null;
  concerns: string;
  belongings: string | null;
  keys_received: number | null;
  key_tag: string | null;
  promised_at: Timestamp | null;
  photo_shortfall_reason: string | null;
  /** OQ-1: the open repair order number the advisor confirmed at check-in (migration 0013). */
  duplicate_open_ack: ColumnType<string | null, string | null | undefined, never>;
  checked_in_at: Timestamp;
  checked_in_by: string | null;
  business_date: DbDate;
}

export interface MediaAssetTable {
  id: Generated<string>;
  check_in_id: string | null; // null for finding photos (0007)
  finding_id: Generated<string | null>;
  repair_order_id: string | null;
  slot: PhotoSlot;
  storage_key: string;
  content_type: ImageType;
  byte_size: number;
  sha256: string;
  width: number;
  height: number;
  visibility: Generated<"internal" | "customer">;
  uploaded_at: Generated<Date>;
  uploaded_by: string | null;
  discarded_at: Timestamp | null;
  locked_at: Timestamp | null;
  excluded_at: Timestamp | null;
  excluded_by: string | null;
  excluded_reason: string | null;
}

// I1-03 — inspection findings (0007)

export type FindingSeverity = "ok" | "soon" | "urgent";

export interface InspectionAssignmentTable {
  id: Generated<string>;
  repair_order_id: string;
  technician_user_id: string;
  assigned_at: Generated<Date>;
  assigned_by: string | null;
  ended_at: Timestamp | null;
  ended_by: string | null;
}

export interface ChecklistTemplateTable {
  code: string;
  name_en: string;
  name_ar: string;
  position: number;
}

export interface ChecklistTemplateItemTable {
  id: Generated<string>;
  template_code: string;
  position: number;
  label_en: string;
  label_ar: string;
}

export interface FindingTable {
  id: Generated<string>;
  repair_order_id: string;
  template_item_id: string | null;
  title: string;
  severity: FindingSeverity;
  fault_codes: ColumnType<string[], string[] | undefined, string[]>;
  customer_note: string | null;
  internal_note: string | null;
  status: Generated<"active" | "withdrawn">;
  withdrawn_reason: string | null;
  recorded_at: Generated<Date>;
  recorded_by: string | null;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

// I1-04 — catalog & tax (0009)

export type TaxCategory = "standard" | "zero_rated" | "exempt" | "out_of_scope" | "not_registered";
export type CatalogueKind = "labor_rate" | "package" | "part";
export type PartType = "oem" | "aftermarket" | "other";
export type PartUnit = "piece" | "set" | "litre" | "kg" | "metre" | "job";

export interface TaxProfileTable {
  id: Generated<string>;
  registration_status: "not_registered" | "registered";
  trn: string | null;
  effective_from: DbDate;
  note: string | null;
  created_at: Generated<Date>;
  created_by: string | null;
}

export interface TaxCodeTable {
  code: string;
  label_en: string;
  label_ar: string;
  category: TaxCategory;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  created_by: string | null;
}

export interface TaxCodeRateTable {
  id: Generated<string>;
  code: string;
  rate: ColumnType<string, string, string>; // numeric(5,2) percent, exact
  effective_from: DbDate;
  created_at: Generated<Date>;
  created_by: string | null;
}

export interface CatalogueItemTable {
  id: Generated<string>;
  kind: CatalogueKind;
  code: string;
  name_en: string;
  name_ar: string;
  description_en: string | null;
  description_ar: string | null;
  part_no: string | null;
  brand: string | null;
  part_type: PartType | null;
  unit: PartUnit | null;
  stock_tracked: Generated<boolean>;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  created_by: string | null;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface CataloguePriceTable {
  id: Generated<string>;
  item_id: string;
  price: ColumnType<string, string, string>; // numeric(14,2), VAT-inclusive (OD-14)
  tax_code: string;
  effective_from: Generated<Date>;
  set_by: string | null;
}

// I1-05a — estimate draft (migration 0011).
export type EstimateVersionStatus = "draft" | "sent" | "closed" | "withdrawn" | "expired" | "discarded";
export type JobExecutionStatus =
  | "not_authorized"
  | "authorized"
  | "waiting_parts"
  | "in_progress"
  | "paused"
  | "done"
  | "stopped_by_customer"
  | "cancelled";
export type RevisionKind =
  "original" | "add_scope" | "price_change" | "reduction" | "substitution" | "partial_work_agreement";
export type RevisionStatus = "draft" | "pending" | "approved" | "declined" | "lapsed";
export type RevisionLineType = "labor" | "part" | "package" | "fee" | "customer_supplied_part";

export interface EstimateTable {
  id: Generated<string>;
  repair_order_id: string;
  created_at: Generated<Date>;
  created_by: string | null;
}

export interface EstimateVersionTable {
  id: Generated<string>;
  estimate_id: string;
  version_no: number;
  status: Generated<EstimateVersionStatus>;
  created_at: Generated<Date>;
  created_by: string | null;
  // I1-05b (migration 0012): set once, when sent.
  sent_at: ColumnType<Date | null, never, Date | null>;
  sent_by: ColumnType<string | null, never, string | null>;
  expires_at: ColumnType<Date | null, never, Date | null>;
  snapshot: ColumnType<unknown, never, string>;
  content_hash: ColumnType<string | null, never, string>;
  terms_ar_id: ColumnType<string | null, never, string | null>;
  terms_en_id: ColumnType<string | null, never, string | null>;
}

export interface RepairJobTable {
  id: Generated<string>;
  repair_order_id: string;
  title: string;
  job_type: Generated<"repair" | "diagnostic">;
  charge_type: Generated<"chargeable" | "warranty" | "goodwill">;
  execution_status: Generated<JobExecutionStatus>;
  /** Reason or note of the last execution change (pause reason, completion note); migration 0013. */
  execution_reason: ColumnType<string | null, never, string | null>;
  finding_id: string | null;
  removed_at: Date | null;
  removed_by: string | null;
  created_at: Generated<Date>;
  created_by: string | null;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface JobRevisionTable {
  id: Generated<string>;
  job_id: string;
  revision_no: number;
  kind: RevisionKind;
  proposed_in_version_id: string;
  status: Generated<RevisionStatus>;
  lapse_reason: "withdrawn" | "expired" | null;
  created_at: Generated<Date>;
  created_by: string | null;
}

export interface RevisionLineTable {
  id: Generated<string>;
  revision_id: string;
  line_type: RevisionLineType;
  catalogue_item_id: string | null;
  catalogue_price_id: string | null;
  description_en: string;
  description_ar: string;
  unit: string | null;
  qty: ColumnType<string, string, string>; // numeric(18,3)
  unit_price: ColumnType<string, string, string>; // numeric(14,2), VAT-inclusive
  gross: ColumnType<string, string, string>;
  discount: ColumnType<string, string | undefined, string>;
  line_total: ColumnType<string, string, string>;
  net: ColumnType<string, string, string>;
  vat: ColumnType<string, string, string>;
  tax_code: string;
  tax_rate: ColumnType<string, string, string>; // numeric(5,2) percent
  supersedes_line_id: string | null;
  removed_at: Date | null;
  removed_by: string | null;
  created_at: Generated<Date>;
  created_by: string | null;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface UrgentFindingExclusionTable {
  id: Generated<string>;
  estimate_version_id: string;
  finding_id: string;
  reason: string;
  created_at: Generated<Date>;
  created_by: string | null;
  cleared_at: Date | null;
  cleared_by: string | null;
}

// I1-05b — in-person approval (migration 0012).
export type ApprovalMethod = "in_person_signature" | "link" | "phone" | "garage_reduction";
export type VerificationLevel = "possession" | "step_up" | "in_person";

export interface TermsTextTable {
  id: Generated<string>;
  kind: "estimate";
  language: "ar" | "en";
  version_no: number;
  body: string;
  created_at: Generated<Date>;
  created_by: string | null;
}

export interface ApprovalEventTable {
  id: Generated<string>;
  estimate_version_id: string;
  method: ApprovalMethod;
  verification_level: VerificationLevel;
  approver_name: string;
  signature_sha256: string | null;
  signature_storage_key: string | null;
  signature_content_type: string | null;
  contact_name: string;
  contact_mobile: string;
  displayed_language: "ar" | "en";
  terms_ar_id: string | null;
  terms_en_id: string | null;
  content_hash: string;
  idempotency_key: string;
  recorded_by: string | null;
  recorded_at: Generated<Date>;
  business_date: ColumnType<string, string | undefined, never>;
}

export interface RevisionDecisionTable {
  id: Generated<string>;
  approval_event_id: string;
  revision_id: string;
  decision: "approved" | "declined";
  urgent_ack_pending: Generated<boolean>;
}

// I1-06 — workshop (migration 0013).
export interface JobAssignmentTable {
  id: Generated<string>;
  job_id: string;
  assignee_id: string;
  bay: string | null;
  assigned_by: string | null;
  assigned_at: Generated<Date>;
  ended_by: string | null;
  ended_at: Date | null;
}

export interface JobLineOutcomeTable {
  id: Generated<string>;
  job_id: string;
  revision_line_id: string;
  outcome: "done" | "not_performed";
  reason: string | null;
  recorded_by: string;
  recorded_at: Generated<Date>;
}

export interface JobStatusEventTable {
  id: Generated<string>;
  job_id: string;
  from_status: string;
  to_status: string;
  reason: string | null;
  actor_id: string | null;
  occurred_at: Generated<Date>;
}

// I1-07 — parts for a job (migration 0014). Amounts numeric(14,2), quantities numeric(18,3), as strings.
type Num = ColumnType<string, string, string>;

export interface StockBalanceTable {
  item_id: string;
  qty: Num;
  value: Num;
  basis_qty: Num;
  basis_value: Num;
  updated_at: Generated<Date>;
}

export interface StockMovementTable {
  id: Generated<string>;
  item_id: string;
  kind: "receipt" | "issue";
  qty: Num;
  value: Num;
  supplier_name: string | null;
  supplier_ref: string | null;
  revision_line_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  business_date: ColumnType<string, string | undefined, never>;
}

export interface LineWipTable {
  revision_line_id: string;
  qty: Num;
  value: Num;
  basis_qty: Num;
  basis_value: Num;
  updated_at: Generated<Date>;
}

export interface LineCostMovementTable {
  id: Generated<string>;
  revision_line_id: string;
  kind: "stock_issue" | "purchase";
  qty: Num;
  value: Num;
  stock_movement_id: string | null;
  supplier_name: string | null;
  supplier_ref: string | null;
  over_reason: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  business_date: ColumnType<string, string | undefined, never>;
}

export interface DB {
  app_user: AppUserTable;
  user_role: UserRoleTable;
  user_session: UserSessionTable;
  audit_event: AuditEventTable;
  idempotency_key: IdempotencyKeyTable;
  outbox_message: OutboxMessageTable;
  number_series: NumberSeriesTable;
  issued_number: IssuedNumberTable;
  test_document: TestDocumentTable;
  test_document_issue: TestDocumentIssueTable;
  customer: CustomerTable;
  vehicle: VehicleTable;
  vehicle_plate: VehiclePlateTable;
  vehicle_ownership: VehicleOwnershipTable;
  app_setting: AppSettingTable;
  check_in: CheckInTable;
  repair_order: RepairOrderTable;
  media_asset: MediaAssetTable;
  inspection_assignment: InspectionAssignmentTable;
  checklist_template: ChecklistTemplateTable;
  checklist_template_item: ChecklistTemplateItemTable;
  finding: FindingTable;
  tax_profile: TaxProfileTable;
  tax_code: TaxCodeTable;
  tax_code_rate: TaxCodeRateTable;
  catalogue_item: CatalogueItemTable;
  catalogue_price: CataloguePriceTable;
  estimate: EstimateTable;
  estimate_version: EstimateVersionTable;
  repair_job: RepairJobTable;
  job_revision: JobRevisionTable;
  revision_line: RevisionLineTable;
  urgent_finding_exclusion: UrgentFindingExclusionTable;
  terms_text: TermsTextTable;
  approval_event: ApprovalEventTable;
  revision_decision: RevisionDecisionTable;
  job_assignment: JobAssignmentTable;
  job_line_outcome: JobLineOutcomeTable;
  job_status_event: JobStatusEventTable;
  stock_balance: StockBalanceTable;
  stock_movement: StockMovementTable;
  line_wip: LineWipTable;
  line_cost_movement: LineCostMovementTable;
  schema_migration: SchemaMigrationTable;
}
