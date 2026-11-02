import { sql, type Kysely } from "kysely";
import { isUuid } from "../core/ids";
import type { CustomerMessageKind, DB } from "../db/schema";

/**
 * AC2-28 (OD-71): of these repair orders, the ones whose customer has not been told — the newest message prepared
 * for them was not confirmed sent within 15 minutes, while it still matters: the estimate message while its version
 * awaits the customer (a newer link revokes the older, so the newest is the one that counts), the ready message while
 * the car is Ready and no ready message was confirmed sent yet.
 */
export async function notInformed(db: Kysely<DB>, repairOrderIds: readonly string[]): Promise<Set<string>> {
  if (repairOrderIds.length === 0) return new Set();
  const rows = await sql<{ repair_order_id: string }>`
    SELECT newest.repair_order_id
      FROM (SELECT DISTINCT ON (m.repair_order_id, m.kind) m.*
              FROM customer_message m
             WHERE m.repair_order_id = ANY(${sql.val([...repairOrderIds])}::uuid[])
             ORDER BY m.repair_order_id, m.kind, m.prepared_at DESC, m.id DESC) newest
      JOIN repair_order ro ON ro.id = newest.repair_order_id
      LEFT JOIN customer_link l ON l.id = newest.customer_link_id
      LEFT JOIN estimate_version v ON v.id = l.estimate_version_id
     WHERE newest.shared_at IS NULL
       AND newest.prepared_at <= now() - interval '15 minutes'
       AND ((newest.kind = 'estimate_link' AND v.status = 'sent' AND v.expires_at > now())
            OR (newest.kind = 'vehicle_ready' AND ro.status = 'ready'
                -- Once any ready message was confirmed sent, the customer was told; a later one left unsent
                -- (e.g. prepared again by a second advisor who saw it had gone) does not undo that.
                AND NOT EXISTS (SELECT 1 FROM customer_message s
                                 WHERE s.repair_order_id = newest.repair_order_id AND s.kind = 'vehicle_ready'
                                   AND s.shared_at IS NOT NULL)))`.execute(db);
  return new Set(rows.rows.map((row) => row.repair_order_id));
}

/** The newest message of a kind for the repair order, as the staff page summarises it. */
export async function latestMessage(db: Kysely<DB>, repairOrderId: string, kind: CustomerMessageKind) {
  if (!isUuid(repairOrderId)) return null;
  return (
    (await db
      .selectFrom("customer_message")
      .leftJoin("app_user", "app_user.id", "customer_message.shared_by")
      .select([
        "customer_message.id",
        "customer_message.prepared_at as preparedAt",
        "customer_message.shared_at as sharedAt",
        "app_user.display_name as sharedByName",
      ])
      .where("customer_message.repair_order_id", "=", repairOrderId)
      .where("customer_message.kind", "=", kind)
      .orderBy("customer_message.prepared_at", "desc")
      .orderBy("customer_message.id", "desc")
      .executeTakeFirst()) ?? null
  );
}
