import type { Kysely } from "kysely";
import { runCommand, type CommandOutcome } from "../command/runner";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { hasPermission } from "../auth/permissions";
import type { SessionUser } from "../auth/session";
import { normalizeMobile } from "../customer/service";
import type { ContactRelationship, DB } from "../db/schema";
import { inspectImage } from "../media/image";
import type { MediaStorage } from "../media/storage";
import { parseDubaiLocalDateTime } from "./check-in";

/**
 * Changing a repair order's authorized contact (I2-06; Final Consistency Review F-10, Amendment A.4, v0.2.1 §3.7).
 * Verified in person (L3, the authorizing person signs) or by callback (L2, the advisor calls the authorizing
 * person's mobile on file) — OD-64; authorized by the owner on record or the current contact — OD-65; with a reason
 * — OD-67. Recording the change applies it and revokes every live customer link in the same transaction; the
 * database does both on insert (0023), so the contact cannot change without the links going.
 */

type Staff = Pick<SessionUser, "userId" | "roles">;

const RELATIONSHIPS: readonly ContactRelationship[] = ["owner", "driver", "company_representative", "other"];
const OPEN = ["checked_in", "diagnosing", "awaiting_approval", "in_progress", "qc", "release_check", "ready"];
/** A finger-drawn signature is a few tens of kilobytes; the same limit as approval signatures. */
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

export interface ContactChangeInput {
  /** The contact the form showed: a change made since by someone else is refused, never overwritten. */
  expectedName: unknown;
  expectedMobile: unknown;
  expectedRelationship: unknown;
  newName: unknown;
  newMobile: unknown;
  newRelationship: unknown;
  reason: unknown;
  authorizedBy: unknown;
  verification: unknown;
  /** In person: who signed, and the signature image. */
  signerName?: unknown;
  signature?: Uint8Array | null;
  /** Callback: when the call was made (Dubai local time, "2026-10-31T10:15") and who answered. */
  calledAt?: unknown;
  spokenTo?: unknown;
}

function text(value: unknown, max: number, field: string, message: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length < 1 || trimmed.length > max) throw new ValidationError(message, { field });
  return trimmed;
}

export async function changeContact(
  db: Kysely<DB>,
  storage: MediaStorage,
  staff: Staff,
  repairOrderId: string,
  input: ContactChangeInput,
  idempotencyKey: string,
): Promise<CommandOutcome<{ changeId: string; linksRevoked: number }>> {
  if (!hasPermission(staff.roles, "repair_order.change_contact")) {
    throw new ForbiddenError("repair_order.change_contact");
  }
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const expectedName = typeof input.expectedName === "string" ? input.expectedName : "";
  const expectedMobile = typeof input.expectedMobile === "string" ? input.expectedMobile : "";
  const expectedRelationship =
    typeof input.expectedRelationship === "string" ? input.expectedRelationship : "";
  const newName = text(input.newName, 200, "newName", "The new contact's name is required");
  const newMobile = text(input.newMobile, 20, "newMobile", "The new contact's mobile is required");
  if (!/^[0-9]{6,15}$/.test(normalizeMobile(newMobile))) {
    throw new ValidationError("Mobile must contain 6–15 digits", { field: "newMobile" });
  }
  const newRelationship = input.newRelationship as ContactRelationship;
  if (!RELATIONSHIPS.includes(newRelationship)) {
    throw new ValidationError("Choose the relationship", { field: "newRelationship" });
  }
  const reason = text(input.reason, 500, "reason", "Say why the contact changes");
  const authorizedBy = input.authorizedBy;
  if (authorizedBy !== "owner" && authorizedBy !== "current_contact") {
    throw new ValidationError("Choose who authorized the change", { field: "authorizedBy" });
  }
  const verification = input.verification;
  if (verification !== "in_person" && verification !== "callback") {
    throw new ValidationError("Choose how the change was verified", { field: "verification" });
  }

  let inPerson: {
    signerName: string;
    sha256: string;
    storageKey: string;
    contentType: "image/png" | "image/jpeg" | "image/webp";
  } | null = null;
  let callback: { calledAt: Date; spokenTo: string } | null = null;
  if (verification === "in_person") {
    const signerName = text(input.signerName, 200, "signerName", "Who signed is required");
    const bytes = input.signature ?? new Uint8Array();
    if (bytes.byteLength > MAX_SIGNATURE_BYTES) {
      throw new ValidationError("The signature image is too large", {
        field: "signature",
        reason: "too_large",
      });
    }
    const image = inspectImage(bytes);
    if (!image)
      throw new ValidationError("A signature is required", { field: "signature", reason: "not_image" });
    const extension =
      image.contentType === "image/png" ? "png" : image.contentType === "image/jpeg" ? "jpg" : "webp";
    // Evidence, kept apart from photos like approval signatures, so a photo clean-up never reaches it (rule 3:
    // the file first, outside the transaction; a failure afterwards leaves only an unreferenced file).
    const storageKey = `signatures/${image.sha256.slice(0, 2)}/${image.sha256}.${extension}`;
    await storage.put(storageKey, bytes);
    inPerson = { signerName, sha256: image.sha256, storageKey, contentType: image.contentType };
  } else {
    const calledAt = parseDubaiLocalDateTime(input.calledAt);
    if (!calledAt || Number.isNaN(calledAt.getTime())) {
      throw new ValidationError("When was the call made?", { field: "calledAt" });
    }
    callback = {
      calledAt,
      spokenTo: text(input.spokenTo, 200, "spokenTo", "Who answered the call is required"),
    };
  }

  const options = {
    name: "repair_order.change_contact",
    actor: { kind: "user" as const, userId: staff.userId },
    idempotency: {
      key: idempotencyKey,
      payload: {
        repairOrderId,
        expectedName,
        expectedMobile,
        expectedRelationship,
        newName,
        newMobile,
        newRelationship,
        reason,
        authorizedBy,
        verification,
        signature: inPerson?.sha256 ?? null,
        signerName: inPerson?.signerName ?? null,
        calledAt: callback?.calledAt.toISOString() ?? null,
        spokenTo: callback?.spokenTo ?? null,
      },
    },
  };
  return runCommand(db, options, async (ctx) => {
    await ctx.locks.acquire("repair_order", [repairOrderId]);
    const ro = await ctx.tx
      .selectFrom("repair_order")
      .innerJoin("customer", "customer.id", "repair_order.customer_id")
      .select([
        "repair_order.status",
        "repair_order.contact_name",
        "repair_order.contact_mobile",
        "repair_order.contact_relationship",
        "customer.mobile as owner_mobile",
      ])
      .where("repair_order.id", "=", repairOrderId)
      .executeTakeFirst();
    if (!ro) throw new NotFoundError("repair_order", repairOrderId);
    if (!OPEN.includes(ro.status)) {
      throw new ConflictError("repair_order_closed", `Repair order is ${ro.status}`, { status: ro.status });
    }
    if (
      ro.contact_name !== expectedName ||
      ro.contact_mobile !== expectedMobile ||
      ro.contact_relationship !== expectedRelationship
    ) {
      throw new ConflictError("contact_changed", "The contact was changed meanwhile; reload and check");
    }
    // T-45: a "change" to the same contact would only revoke the customer's links.
    if (
      ro.contact_name === newName &&
      ro.contact_mobile === newMobile &&
      ro.contact_relationship === newRelationship
    ) {
      throw new ValidationError("This is already the contact", { field: "newName", reason: "unchanged" });
    }
    if (callback) {
      const now = Date.now();
      if (callback.calledAt.getTime() > now || callback.calledAt.getTime() < now - 24 * 3_600_000) {
        throw new ValidationError("The call must be within the last 24 hours", { field: "calledAt" });
      }
    }
    const links = await ctx.tx
      .selectFrom("customer_link")
      .select("id")
      .where("repair_order_id", "=", repairOrderId)
      .where("revoked_at", "is", null)
      .execute();
    // The trigger applies the contact and revokes these links in this statement (0023).
    const change = await ctx.tx
      .insertInto("contact_change")
      .values({
        repair_order_id: repairOrderId,
        old_name: ro.contact_name,
        old_mobile: ro.contact_mobile,
        old_relationship: ro.contact_relationship,
        new_name: newName,
        new_mobile: newMobile,
        new_relationship: newRelationship,
        reason,
        authorized_by: authorizedBy,
        verification,
        signer_name: inPerson?.signerName ?? null,
        signature_sha256: inPerson?.sha256 ?? null,
        signature_storage_key: inPerson?.storageKey ?? null,
        signature_content_type: inPerson?.contentType ?? null,
        // OD-65: the number on file of the person who authorized it.
        called_number: callback ? (authorizedBy === "owner" ? ro.owner_mobile : ro.contact_mobile) : null,
        called_at: callback?.calledAt ?? null,
        spoken_to: callback?.spokenTo ?? null,
        idempotency_key: idempotencyKey,
        changed_by: staff.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.audit({
      action: "ro.contact_changed",
      entityType: "repair_order",
      entityId: repairOrderId,
      before: { name: ro.contact_name, mobile: ro.contact_mobile, relationship: ro.contact_relationship },
      after: { name: newName, mobile: newMobile, relationship: newRelationship },
      details: { changeId: change.id, reason, authorizedBy, verification },
    });
    for (const link of links) {
      await ctx.audit({
        action: "link.revoked",
        entityType: "customer_link",
        entityId: link.id,
        before: { revoked: false },
        after: { revoked: true, reason: "contact_changed" },
        details: { repairOrderId, changeId: change.id },
      });
    }
    return { changeId: change.id, linksRevoked: links.length };
  });
}

/** The repair order's contact history, newest first (staff only; mobiles follow T-05 like the contact itself). */
export async function contactHistory(db: Kysely<DB>, repairOrderId: string) {
  if (!isUuid(repairOrderId)) return [];
  return db
    .selectFrom("contact_change")
    .innerJoin("app_user", "app_user.id", "contact_change.changed_by")
    .select([
      "contact_change.id",
      "contact_change.old_name as oldName",
      "contact_change.new_name as newName",
      "contact_change.new_relationship as newRelationship",
      "contact_change.reason",
      "contact_change.authorized_by as authorizedBy",
      "contact_change.verification",
      "contact_change.spoken_to as spokenTo",
      "contact_change.signer_name as signerName",
      "contact_change.changed_at as changedAt",
      "app_user.display_name as changedByName",
    ])
    .where("contact_change.repair_order_id", "=", repairOrderId)
    .orderBy("contact_change.changed_at", "desc")
    .execute();
}

/** The owner on record as the change form needs them: who may authorize, and the number a callback goes to. */
export async function ownerForContactChange(
  db: Kysely<DB>,
  customerId: string,
  locale: "ar" | "en",
): Promise<{ name: string; mobile: string } | null> {
  const row = await db
    .selectFrom("customer")
    .select(["name_en", "name_ar", "mobile"])
    .where("id", "=", customerId)
    .executeTakeFirst();
  const name = locale === "ar" ? (row?.name_ar ?? row?.name_en) : (row?.name_en ?? row?.name_ar);
  return row ? { name: name ?? "", mobile: row.mobile } : null;
}

/** Repair-order statuses in which the contact may still change (until the car is handed over). */
export const CONTACT_CHANGE_OPEN: readonly string[] = OPEN;
