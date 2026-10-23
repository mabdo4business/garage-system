import type { Kysely } from "kysely";
import type { SessionUser } from "../auth/session";
import { runCommand, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { Money } from "../core/money";
import type { DB, TaxCategory } from "../db/schema";

/**
 * Tax configuration (v0.2.1 §4.4, v0.2 §4.2, OD-13). Dated history only: a change is a new row
 * effective from a business date, never an edit. Invoices snapshot what applied on their business
 * date (I1-09), so a profile or rate may be dated in the past (a registration often takes effect
 * before it is entered). Which codes, categories and rates exist is for the tax agent (V-2).
 */

export type Staff = Pick<SessionUser, "userId" | "roles">;
export const TAX_CATEGORIES: readonly TaxCategory[] = [
  "standard",
  "zero_rated",
  "exempt",
  "out_of_scope",
  "not_registered",
];

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

/** A concurrent insert of the same date hits the unique index: report it as the same conflict. */
export function conflictOnDuplicate(code: string, message: string) {
  return (error: unknown): never => {
    if ((error as { code?: unknown } | null)?.code === "23505") throw new ConflictError(code, message);
    throw error;
  };
}

const NOT_AFTER_LATEST = "tax_date_not_after_latest";

/** OD-16: the database refuses (23514) or the unique date index (23505) catches a concurrent insert. */
function forwardOnlyConflict(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23505" || code === "23514") {
    throw new ConflictError(NOT_AFTER_LATEST, "Tax history only moves forward: start after the latest date");
  }
  throw error;
}

/** "YYYY-MM-DD" that is a real calendar date. */
export function parseBusinessDate(value: unknown, field: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!date || date.toISOString().slice(0, 10) !== raw) {
    throw new ValidationError("Enter a valid date", { field });
  }
  return raw;
}

/** A percentage with at most 2 decimals, 0–100. Exact decimal, never a float. */
export function parseRate(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw))
    throw new ValidationError("Rate is a percentage like 5 or 5.00", { field: "rate" });
  const rate = Money.parse(raw);
  if (rate.compare(Money.parse("100")) > 0)
    throw new ValidationError("Rate cannot exceed 100%", { field: "rate" });
  return rate.toString();
}

function text(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length < 1 || trimmed.length > max)
    throw new ValidationError(`${field} is required`, { field });
  return trimmed;
}

// --------------------------------------------------------------------------- profiles

export async function addTaxProfile(
  db: Kysely<DB>,
  staff: Staff,
  input: { registrationStatus: unknown; trn?: unknown; effectiveFrom: unknown; note?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ profileId: string }>> {
  const status = input.registrationStatus;
  if (status !== "registered" && status !== "not_registered") {
    throw new ValidationError("Choose registered or not registered", { field: "registrationStatus" });
  }
  const trn = typeof input.trn === "string" ? input.trn.replace(/\s/g, "") : "";
  if (status === "registered" && !/^\d{15}$/.test(trn)) {
    throw new ValidationError("A TRN has 15 digits", { field: "trn" }); // T-14
  }
  const effectiveFrom = parseBusinessDate(input.effectiveFrom, "effectiveFrom");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null;
  const values = {
    registration_status: status,
    trn: status === "registered" ? trn : null,
    effective_from: effectiveFrom,
    note,
  } as const;
  return runCommand(
    db,
    { name: "tax.add_profile", actor: actorOf(staff), idempotency: { key: idempotencyKey, payload: values } },
    async (ctx) => {
      // OD-16: after the latest profile (the database enforces the same under a lock).
      const later = await ctx.tx
        .selectFrom("tax_profile")
        .select("effective_from")
        .where("effective_from", ">=", effectiveFrom)
        .executeTakeFirst();
      if (later) {
        throw new ConflictError(
          NOT_AFTER_LATEST,
          "Tax history only moves forward: start after the latest date",
          {
            latest: later.effective_from,
          },
        );
      }
      const row = await ctx.tx
        .insertInto("tax_profile")
        .values({ ...values, created_by: staff.userId })
        .returning("id")
        .executeTakeFirstOrThrow()
        .catch(forwardOnlyConflict);
      await ctx.audit({
        action: "tax.profile_added",
        entityType: "tax_profile",
        entityId: row.id,
        after: values,
      });
      return { profileId: row.id };
    },
  );
}

export interface TaxProfileView {
  registrationStatus: "not_registered" | "registered";
  trn: string | null;
  effectiveFrom: string;
}

/** The profile in force on a business date, or null if none starts on or before it. */
export async function taxProfileOn(db: Kysely<DB>, businessDate: string): Promise<TaxProfileView | null> {
  const row = await db
    .selectFrom("tax_profile")
    .select(["registration_status", "trn", "effective_from"])
    .where("effective_from", "<=", businessDate)
    .orderBy("effective_from", "desc")
    .executeTakeFirst();
  return row
    ? { registrationStatus: row.registration_status, trn: row.trn, effectiveFrom: row.effective_from }
    : null;
}

// --------------------------------------------------------------------------- codes and rates

export async function createTaxCode(
  db: Kysely<DB>,
  staff: Staff,
  input: {
    code: unknown;
    labelEn: unknown;
    labelAr: unknown;
    category: unknown;
    rate: unknown;
    effectiveFrom: unknown;
  },
  idempotencyKey: string,
): Promise<CommandOutcome<{ code: string }>> {
  const code = text(input.code, "code", 20).toUpperCase();
  if (!/^[A-Z0-9_-]{1,20}$/.test(code))
    throw new ValidationError("Code is letters, digits, - or _", { field: "code" });
  const category = input.category as TaxCategory;
  if (!TAX_CATEGORIES.includes(category))
    throw new ValidationError("Choose a category", { field: "category" });
  const values = {
    code,
    label_en: text(input.labelEn, "labelEn", 100),
    label_ar: text(input.labelAr, "labelAr", 100),
    category,
  };
  const rate = parseRate(input.rate);
  const effectiveFrom = parseBusinessDate(input.effectiveFrom, "effectiveFrom");
  return runCommand(
    db,
    {
      name: "tax.create_code",
      actor: actorOf(staff),
      idempotency: { key: idempotencyKey, payload: { ...values, rate, effectiveFrom } },
    },
    async (ctx) => {
      const existing = await ctx.tx
        .selectFrom("tax_code")
        .select("code")
        .where("code", "=", code)
        .executeTakeFirst();
      if (existing) throw new ConflictError("tax_code_exists", "This tax code already exists");
      await ctx.tx
        .insertInto("tax_code")
        .values({ ...values, created_by: staff.userId })
        .execute();
      await ctx.tx
        .insertInto("tax_code_rate")
        .values({ code, rate, effective_from: effectiveFrom, created_by: staff.userId })
        .execute();
      await ctx.audit({
        action: "tax.code_created",
        entityType: "tax_code",
        entityId: code,
        after: { ...values, rate, effectiveFrom },
      });
      return { code };
    },
  );
}

export async function setTaxCodeRate(
  db: Kysely<DB>,
  staff: Staff,
  code: string,
  input: { rate: unknown; effectiveFrom: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ code: string }>> {
  const rate = parseRate(input.rate);
  const effectiveFrom = parseBusinessDate(input.effectiveFrom, "effectiveFrom");
  return runCommand(
    db,
    {
      name: "tax.set_rate",
      actor: actorOf(staff),
      idempotency: { key: idempotencyKey, payload: { code, rate, effectiveFrom } },
    },
    async (ctx) => {
      const existing = await ctx.tx
        .selectFrom("tax_code")
        .select("code")
        .where("code", "=", code)
        .executeTakeFirst();
      if (!existing) throw new NotFoundError("tax_code", code);
      // OD-16: after the latest rate for this code.
      const later = await ctx.tx
        .selectFrom("tax_code_rate")
        .select("effective_from")
        .where("code", "=", code)
        .where("effective_from", ">=", effectiveFrom)
        .executeTakeFirst();
      if (later) {
        throw new ConflictError(
          NOT_AFTER_LATEST,
          "Tax history only moves forward: start after the latest date",
          {
            latest: later.effective_from,
          },
        );
      }
      const before = await taxCodeRateOn(ctx.tx, code, effectiveFrom);
      await ctx.tx
        .insertInto("tax_code_rate")
        .values({ code, rate, effective_from: effectiveFrom, created_by: staff.userId })
        .execute()
        .catch(forwardOnlyConflict);
      await ctx.audit({
        action: "tax.rate_set",
        entityType: "tax_code",
        entityId: code,
        before: before ? { rate: before } : null,
        after: { rate, effectiveFrom },
      });
      return { code };
    },
  );
}

/** The rate (percent, exact string) of a code on a business date, or null. */
export async function taxCodeRateOn(
  db: Kysely<DB>,
  code: string,
  businessDate: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("tax_code_rate")
    .select("rate")
    .where("code", "=", code)
    .where("effective_from", "<=", businessDate)
    .orderBy("effective_from", "desc")
    .executeTakeFirst();
  return row?.rate ?? null;
}

export interface TaxSettingsView {
  profiles: (TaxProfileView & { note: string | null; createdAt: Date })[];
  codes: {
    code: string;
    labelEn: string;
    labelAr: string;
    category: TaxCategory;
    active: boolean;
    rates: { rate: string; effectiveFrom: string }[];
  }[];
}

export async function getTaxSettings(db: Kysely<DB>): Promise<TaxSettingsView> {
  const profiles = await db.selectFrom("tax_profile").selectAll().orderBy("effective_from", "desc").execute();
  const codes = await db.selectFrom("tax_code").selectAll().orderBy("code").execute();
  const rates = await db.selectFrom("tax_code_rate").selectAll().orderBy("effective_from", "desc").execute();
  return {
    profiles: profiles.map((row) => ({
      registrationStatus: row.registration_status,
      trn: row.trn,
      effectiveFrom: row.effective_from,
      note: row.note,
      createdAt: row.created_at,
    })),
    codes: codes.map((row) => ({
      code: row.code,
      labelEn: row.label_en,
      labelAr: row.label_ar,
      category: row.category,
      active: row.active,
      rates: rates
        .filter((rate) => rate.code === row.code)
        .map((rate) => ({ rate: rate.rate, effectiveFrom: rate.effective_from })),
    })),
  };
}
