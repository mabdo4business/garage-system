import { sql, type Kysely } from "kysely";
import { runCommand, type CommandContext, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError } from "../core/errors";
import { isUuid } from "../core/ids";
import type { DB } from "../db/schema";
import { lockRepairOrder, requirePermission, type Staff } from "../estimate/commands";
import { linkPath, newLinkToken } from "./token";

/**
 * Customer links, staff side (I2-03a, PRD v0.2 §6.4). A link points at one sent estimate version of one repair
 * order (scope), expires with the version (expiry) and is revoked by hand or by a newer link for the same version
 * (T-41). Both commands lock the repair order first, like every command that touches its estimate (T-19).
 *
 * No idempotency key on purpose: the result carries the token, and stored results are kept (A.3) — the token must
 * exist only in the URL. A repeated request makes a second link that replaces the first, which is harmless.
 */

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });
/** Statuses in which the customer can still decide on a sent version. */
const OPEN_FOR_LINK = ["awaiting_approval", "in_progress"] as const;

async function revokeLive(
  ctx: CommandContext,
  staff: Staff,
  where: { versionId: string } | { linkId: string },
  reason: "manual" | "replaced",
): Promise<string[]> {
  let query = ctx.tx
    .updateTable("customer_link")
    .set({ revoked_at: sql<Date>`now()`, revoked_by: staff.userId, revoke_reason: reason })
    .where("revoked_at", "is", null);
  query =
    "versionId" in where
      ? query.where("estimate_version_id", "=", where.versionId)
      : query.where("id", "=", where.linkId);
  const rows = await query.returning(["id", "estimate_version_id"]).execute();
  for (const row of rows) {
    await ctx.audit({
      action: "link.revoked",
      entityType: "customer_link",
      entityId: row.id,
      before: { revoked: false },
      after: { revoked: true, reason },
      details: { versionId: row.estimate_version_id },
    });
  }
  return rows.map((row) => row.id);
}

/** Creates the link to the repair order's sent estimate; a live link to the same version is revoked (replaced). */
export async function createCustomerLink(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
): Promise<CommandOutcome<{ linkId: string; token: string; path: string; expiresAt: string }>> {
  requirePermission(staff, "customer_link.create");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  return runCommand(db, { name: "link.create", actor: actorOf(staff) }, async (ctx) => {
    await lockRepairOrder(ctx, repairOrderId, OPEN_FOR_LINK);
    const version = await ctx.tx
      .selectFrom("estimate_version")
      .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
      .innerJoin("repair_order", "repair_order.id", "estimate.repair_order_id")
      .innerJoin("customer", "customer.id", "repair_order.customer_id")
      .select([
        "estimate_version.id",
        "estimate_version.version_no",
        "estimate_version.status",
        "estimate_version.expires_at",
        "customer.preferred_language",
        sql<boolean>`estimate_version.expires_at <= now()`.as("past_expiry"),
      ])
      .where("estimate.repair_order_id", "=", repairOrderId)
      .orderBy("estimate_version.version_no", "desc")
      .executeTakeFirst();
    if (!version || version.status !== "sent") {
      throw new ConflictError("estimate_not_sent", "There is no estimate awaiting the customer's decision", {
        status: version?.status ?? "none",
      });
    }
    // An overdue version is not expired here: the customer's next action, or the scheduler, records that (T-37).
    if (version.past_expiry || !version.expires_at) {
      throw new ConflictError("estimate_expired", "This estimate has expired");
    }

    const replaced = await revokeLive(ctx, staff, { versionId: version.id }, "replaced");
    const { token, hash } = newLinkToken();
    const link = await ctx.tx
      .insertInto("customer_link")
      .values({
        purpose: "estimate_approval",
        repair_order_id: repairOrderId,
        estimate_version_id: version.id,
        token_hash: hash,
        expires_at: version.expires_at,
        created_by: staff.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.audit({
      action: "link.created",
      entityType: "customer_link",
      entityId: link.id,
      // Never the token (rule: only its hash exists outside the customer's URL).
      after: {
        purpose: "estimate_approval",
        versionId: version.id,
        versionNo: version.version_no,
        expiresAt: version.expires_at.toISOString(),
        replaced,
      },
      details: { repairOrderId },
    });
    return {
      linkId: link.id,
      token,
      path: linkPath(version.preferred_language, token),
      expiresAt: version.expires_at.toISOString(),
    };
  });
}

/** Revokes a live link by hand (§6.4 "manual by ADV"). Revoking an already revoked link changes nothing. */
export async function revokeCustomerLink(
  db: Kysely<DB>,
  staff: Staff,
  linkId: string,
): Promise<CommandOutcome<{ linkId: string; revoked: boolean }>> {
  requirePermission(staff, "customer_link.revoke");
  if (!isUuid(linkId)) throw new NotFoundError("customer_link", linkId);
  const owner = await db
    .selectFrom("customer_link")
    .select("repair_order_id")
    .where("id", "=", linkId)
    .executeTakeFirst();
  if (!owner) throw new NotFoundError("customer_link", linkId);
  return runCommand(db, { name: "link.revoke", actor: actorOf(staff) }, async (ctx) => {
    // Any status: a link is revoked as readily after the repair order moved on as before.
    await ctx.locks.acquire("repair_order", [owner.repair_order_id]);
    const revoked = await revokeLive(ctx, staff, { linkId }, "manual");
    if (revoked.length === 0) {
      await ctx.audit({ action: "link.revoke_repeated", entityType: "customer_link", entityId: linkId });
    }
    return { linkId, revoked: revoked.length > 0 };
  });
}
