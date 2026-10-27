import type { Kysely } from "kysely";
import { hasPermission } from "../auth/permissions";
import type { SessionUser } from "../auth/session";
import { runCommand, type CommandOutcome } from "../command/runner";
import { ConflictError, ForbiddenError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { normalizeMobile } from "../customer/service";
import type { DB } from "../db/schema";

/**
 * The garage's business profile (I1-09b, OD-42): legal name, address and phone printed on invoices. Insert-only
 * versions (OD-46): a change is a new row naming the version it replaces, and each invoice records the version in
 * force when it was issued, so a reprint never changes. Partners only (OD-42; like tax settings, T-15).
 */

export type Staff = Pick<SessionUser, "userId" | "roles">;

export interface BusinessProfileView {
  id: string;
  legalNameEn: string;
  legalNameAr: string;
  addressEn: string;
  addressAr: string;
  phone: string;
}

const PROFILE_CHANGED = "profile_changed";

function text(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length < 1 || trimmed.length > max)
    throw new ValidationError(`${field} is required`, { field });
  return trimmed;
}

/** T-33: as T-06's mobile rule — 6–15 digits once +971/00971/a leading 0 is removed; spaces and dashes allowed. */
function phoneOf(value: unknown): string {
  const raw = (typeof value === "string" ? value.trim() : "").replace(/\s+/g, " ");
  const digits = normalizeMobile(raw);
  if (!/^\+?[0-9][0-9 -]{4,28}[0-9]$/.test(raw) || digits.length < 6 || digits.length > 15) {
    throw new ValidationError("Enter a phone number of 6–15 digits", { field: "phone" });
  }
  return raw;
}

const viewOf = (row: {
  id: string;
  legal_name_en: string;
  legal_name_ar: string;
  address_en: string;
  address_ar: string;
  phone: string;
}): BusinessProfileView => ({
  id: row.id,
  legalNameEn: row.legal_name_en,
  legalNameAr: row.legal_name_ar,
  addressEn: row.address_en,
  addressAr: row.address_ar,
  phone: row.phone,
});

/** The latest version: the one no other version replaces. */
export async function currentBusinessProfile(db: Kysely<DB>): Promise<BusinessProfileView | null> {
  const row = await db
    .selectFrom("business_profile as p")
    .selectAll("p")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(selectFrom("business_profile as n").select("n.id").whereRef("n.supersedes_id", "=", "p.id")),
      ),
    )
    .executeTakeFirst();
  return row ? viewOf(row) : null;
}

export async function businessProfileById(db: Kysely<DB>, id: string): Promise<BusinessProfileView | null> {
  const row = await db.selectFrom("business_profile").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? viewOf(row) : null;
}

export async function businessProfileHistory(
  db: Kysely<DB>,
): Promise<(BusinessProfileView & { createdAt: Date; createdByName: string | null })[]> {
  const rows = await db
    .selectFrom("business_profile")
    .leftJoin("app_user", "app_user.id", "business_profile.created_by")
    .selectAll("business_profile")
    .select("app_user.display_name")
    .orderBy("business_profile.created_at", "desc")
    .execute();
  return rows.map((row) => ({ ...viewOf(row), createdAt: row.created_at, createdByName: row.display_name }));
}

/**
 * Saves a new version. `supersedesId` is the version the form was filled from (empty for the first one); if another
 * partner saved in between, the save is refused with `profile_changed` so the form is reloaded, never overwritten.
 */
export async function setBusinessProfile(
  db: Kysely<DB>,
  staff: Staff,
  input: {
    legalNameEn: unknown;
    legalNameAr: unknown;
    addressEn: unknown;
    addressAr: unknown;
    phone: unknown;
    supersedesId?: unknown;
  },
  idempotencyKey: string,
): Promise<CommandOutcome<{ profileId: string }>> {
  if (!hasPermission(staff.roles, "business_profile.manage")) {
    throw new ForbiddenError("business_profile.manage");
  }
  const supersedesId =
    typeof input.supersedesId === "string" && input.supersedesId !== "" ? input.supersedesId : null;
  if (supersedesId !== null && !isUuid(supersedesId)) {
    throw new ValidationError("Unknown profile version", { field: "supersedesId" });
  }
  const values = {
    legal_name_en: text(input.legalNameEn, "legalNameEn", 200),
    legal_name_ar: text(input.legalNameAr, "legalNameAr", 200),
    address_en: text(input.addressEn, "addressEn", 500),
    address_ar: text(input.addressAr, "addressAr", 500),
    phone: phoneOf(input.phone),
  };
  return runCommand(
    db,
    {
      name: "business_profile.change",
      actor: { kind: "user", userId: staff.userId },
      idempotency: { key: idempotencyKey, payload: { ...values, supersedesId } },
    },
    async (ctx) => {
      // No lock: the single-chain indexes refuse a second successor (23505), reported as the same conflict.
      const current = await currentBusinessProfile(ctx.tx);
      if ((current?.id ?? null) !== supersedesId) {
        throw new ConflictError(PROFILE_CHANGED, "The business profile was changed meanwhile: reload it");
      }
      const row = await ctx.tx
        .insertInto("business_profile")
        .values({ ...values, supersedes_id: supersedesId, created_by: staff.userId })
        .returning("id")
        .executeTakeFirstOrThrow()
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === "23505") {
            throw new ConflictError(PROFILE_CHANGED, "The business profile was changed meanwhile: reload it");
          }
          throw error;
        });
      await ctx.audit({
        action: "settings.business_profile_changed",
        entityType: "business_profile",
        entityId: row.id,
        before: current ? { ...current } : null,
        after: { ...viewOf({ id: row.id, ...values }) },
      });
      return { profileId: row.id };
    },
  );
}
