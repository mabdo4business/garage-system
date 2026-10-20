import type { Kysely } from "kysely";
import { ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { runCommand, type Actor, type CommandOutcome } from "../command/runner";
import type { DB } from "../db/schema";
import { hasPermission } from "../auth/permissions";

/**
 * Customers (I1-01). Duplicate mobile numbers are allowed by design (US-02.4 only warns) —
 * this module never enforces uniqueness on mobile, only normalises it for search/matching.
 */

export interface CustomerInput {
  nameEn?: string | null;
  nameAr?: string | null;
  mobile: string;
  email?: string | null;
  preferredLanguage: "ar" | "en";
  marketingConsent: boolean;
}

export interface CustomerContact {
  mobile: string;
  email: string | null;
}

export interface CustomerProfile {
  id: string;
  nameEn: string | null;
  nameAr: string | null;
  preferredLanguage: "ar" | "en";
  marketingConsent: boolean;
  contact: CustomerContact | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Digits only, country-code and trunk-prefix stripped, for matching across input formats. */
export function normalizeMobile(input: string): string {
  let digits = input.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.startsWith("971")) {
    digits = digits.slice(3);
  }
  return digits;
}

function validate(input: CustomerInput): {
  nameEn: string | null;
  nameAr: string | null;
  mobile: string;
  mobileNormalized: string;
  email: string | null;
  preferredLanguage: "ar" | "en";
  marketingConsent: boolean;
} {
  const nameEn = input.nameEn?.trim() || null;
  const nameAr = input.nameAr?.trim() || null;
  if (!nameEn && !nameAr) {
    throw new ValidationError("At least one of nameEn or nameAr is required", { field: "name" });
  }
  if ((nameEn && nameEn.length > 200) || (nameAr && nameAr.length > 200)) {
    throw new ValidationError("Name must be 1–200 characters", { field: "name" });
  }
  const mobile = input.mobile.trim();
  if (mobile.length < 6 || mobile.length > 20) {
    throw new ValidationError("Mobile must be 6–20 characters", { field: "mobile" });
  }
  const mobileNormalized = normalizeMobile(mobile);
  if (!/^[0-9]{6,15}$/.test(mobileNormalized)) {
    throw new ValidationError("Mobile must contain 6–15 digits", { field: "mobile" });
  }
  const email = input.email?.trim() || null;
  if (email && (!EMAIL_PATTERN.test(email) || email.length > 254)) {
    throw new ValidationError("Email is not a valid address", { field: "email" });
  }
  if (input.preferredLanguage !== "ar" && input.preferredLanguage !== "en") {
    throw new ValidationError("preferredLanguage must be 'ar' or 'en'", { field: "preferredLanguage" });
  }
  return {
    nameEn,
    nameAr,
    mobile,
    mobileNormalized,
    email,
    preferredLanguage: input.preferredLanguage,
    marketingConsent: Boolean(input.marketingConsent),
  };
}

export interface DuplicateCustomer {
  id: string;
  nameEn: string | null;
  nameAr: string | null;
}

/** Plain read (rule 1: reads are fine outside a command) — used before create to warn (AC-02.4). */
export async function findDuplicateCustomersByMobile(
  db: Kysely<DB>,
  mobile: string,
): Promise<DuplicateCustomer[]> {
  const mobileNormalized = normalizeMobile(mobile);
  const rows = await db
    .selectFrom("customer")
    .select(["id", "name_en", "name_ar"])
    .where("mobile_normalized", "=", mobileNormalized)
    .execute();
  return rows.map((row) => ({ id: row.id, nameEn: row.name_en, nameAr: row.name_ar }));
}

export type CreateCustomerResult = { customerId: string };

export async function createCustomer(
  db: Kysely<DB>,
  actor: Actor,
  input: CustomerInput,
  idempotencyKey: string,
): Promise<CommandOutcome<CreateCustomerResult>> {
  const valid = validate(input);
  return runCommand(
    db,
    {
      name: "customer.create",
      actor,
      idempotency: { key: idempotencyKey, payload: valid },
    },
    async (ctx) => {
      const row = await ctx.tx
        .insertInto("customer")
        .values({
          name_en: valid.nameEn,
          name_ar: valid.nameAr,
          mobile: valid.mobile,
          mobile_normalized: valid.mobileNormalized,
          email: valid.email,
          preferred_language: valid.preferredLanguage,
          marketing_consent: valid.marketingConsent,
          created_by: actor.kind === "user" ? actor.userId : null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await ctx.audit({
        action: "customer.created",
        entityType: "customer",
        entityId: row.id,
        after: {
          nameEn: valid.nameEn,
          nameAr: valid.nameAr,
          mobile: valid.mobile,
          email: valid.email,
          preferredLanguage: valid.preferredLanguage,
          marketingConsent: valid.marketingConsent,
        },
      });
      return { customerId: row.id };
    },
  );
}

/** True when the viewer's roles may see mobile/email (not technician or store_keeper, I1-01). */
export function canReadContact(roles: readonly string[]): boolean {
  return hasPermission(roles, "customer.read_contact");
}

/** Plain read. Contact fields are omitted entirely unless the viewer may see them. */
export async function getCustomer(
  db: Kysely<DB>,
  viewerRoles: readonly string[],
  id: string,
): Promise<CustomerProfile | null> {
  if (!isUuid(id)) return null;
  const row = await db
    .selectFrom("customer")
    .select(["id", "name_en", "name_ar", "mobile", "email", "preferred_language", "marketing_consent"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    nameEn: row.name_en,
    nameAr: row.name_ar,
    preferredLanguage: row.preferred_language,
    marketingConsent: row.marketing_consent,
    contact: canReadContact(viewerRoles) ? { mobile: row.mobile, email: row.email } : null,
  };
}
