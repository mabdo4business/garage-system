import type { Kysely } from "kysely";
import { hasPermission } from "../auth/permissions";
import type { SessionUser } from "../auth/session";
import { runCommand } from "../command/runner";
import { NotFoundError } from "../core/errors";
import { isUuid } from "../core/ids";
import type { DB } from "../db/schema";

/**
 * Who may see a repair order (AC2-30): staff with repair_order.read, or the technician currently
 * assigned to its inspection (OD-8). Anyone else gets "not found" — the response does not confirm
 * that the repair order exists — and the attempt is written to the audit log.
 */

export async function assignedTechnician(
  db: Kysely<DB>,
  repairOrderId: string,
): Promise<{ userId: string; displayName: string } | null> {
  if (!isUuid(repairOrderId)) return null;
  const row = await db
    .selectFrom("inspection_assignment")
    .innerJoin("app_user", "app_user.id", "inspection_assignment.technician_user_id")
    .select(["app_user.id", "app_user.display_name"])
    .where("inspection_assignment.repair_order_id", "=", repairOrderId)
    .where("inspection_assignment.ended_at", "is", null)
    .executeTakeFirst();
  return row ? { userId: row.id, displayName: row.display_name } : null;
}

export async function canAccessRepairOrder(
  db: Kysely<DB>,
  session: Pick<SessionUser, "userId" | "roles">,
  repairOrderId: string,
): Promise<boolean> {
  if (!isUuid(repairOrderId)) return false;
  if (hasPermission(session.roles, "repair_order.read")) return true;
  if (!session.roles.includes("technician")) return false;
  // A technician's access is the inspection only: it ends when the repair order leaves Checked-in or
  // Diagnosing. Workshop jobs (I1-06) get their own scoping rule; do not reuse this one for them.
  const ro = await db
    .selectFrom("repair_order")
    .select("status")
    .where("id", "=", repairOrderId)
    .executeTakeFirst();
  if (!ro || (ro.status !== "checked_in" && ro.status !== "diagnosing")) return false;
  return (await assignedTechnician(db, repairOrderId))?.userId === session.userId;
}

/** Audits a denied attempt and answers "not found" (AC2-30), without saying whether the record exists. */
export async function denyAsNotFound(
  db: Kysely<DB>,
  session: Pick<SessionUser, "userId" | "roles">,
  entityType: string,
  entityId: string,
): Promise<never> {
  await runCommand(
    db,
    { name: "authz.check", actor: { kind: "user", userId: session.userId } },
    async (ctx) => {
      await ctx.audit({
        action: "authz.denied",
        entityType,
        entityId,
        details: { permission: "repair_order.access", roles: session.roles },
      });
      return { denied: true };
    },
  );
  throw new NotFoundError(entityType, entityId);
}

/** Throws NotFoundError (and audits the denial) unless the viewer may see the repair order. */
export async function requireRepairOrderAccess(
  db: Kysely<DB>,
  session: Pick<SessionUser, "userId" | "roles">,
  repairOrderId: string,
): Promise<void> {
  if (await canAccessRepairOrder(db, session, repairOrderId)) return;
  await denyAsNotFound(db, session, "repair_order", repairOrderId);
}

/**
 * Same check for a finding or a photo, through the repair order it belongs to. An unknown id is
 * treated like a repair order the viewer may not see, so the answer never reveals what exists.
 */
export async function requireFindingAccess(
  db: Kysely<DB>,
  session: Pick<SessionUser, "userId" | "roles">,
  findingId: string,
): Promise<void> {
  const row = isUuid(findingId)
    ? await db.selectFrom("finding").select("repair_order_id").where("id", "=", findingId).executeTakeFirst()
    : undefined;
  if (row) return requireRepairOrderAccess(db, session, row.repair_order_id);
  if (hasPermission(session.roles, "repair_order.read")) throw new NotFoundError("finding", findingId);
  await denyAsNotFound(db, session, "finding", findingId);
}

export async function requireMediaAccess(
  db: Kysely<DB>,
  session: Pick<SessionUser, "userId" | "roles">,
  mediaId: string,
): Promise<void> {
  const row = isUuid(mediaId)
    ? await db
        .selectFrom("media_asset")
        .leftJoin("finding", "finding.id", "media_asset.finding_id")
        .select(["media_asset.repair_order_id", "finding.repair_order_id as finding_repair_order_id"])
        .where("media_asset.id", "=", mediaId)
        .executeTakeFirst()
    : undefined;
  const repairOrderId = row?.repair_order_id ?? row?.finding_repair_order_id;
  if (repairOrderId) return requireRepairOrderAccess(db, session, repairOrderId);
  if (hasPermission(session.roles, "repair_order.read")) {
    if (!row) throw new NotFoundError("media_asset", mediaId);
    return; // a check-in still in progress: staff with repair_order.read only
  }
  await denyAsNotFound(db, session, "media_asset", mediaId);
}
