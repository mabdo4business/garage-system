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
  valid_from: Generated<Date>;
  valid_to: Timestamp | null;
  changed_by: string | null;
}

export interface VehicleOwnershipTable {
  id: Generated<string>;
  vehicle_id: string;
  customer_id: string;
  valid_from: Generated<Date>;
  valid_to: Timestamp | null;
  changed_by: string | null;
}

export interface SchemaMigrationTable {
  version: string;
  checksum: string;
  applied_at: Generated<Date>;
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
  schema_migration: SchemaMigrationTable;
}
