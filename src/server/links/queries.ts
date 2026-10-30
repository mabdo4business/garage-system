import { sql, type Kysely } from "kysely";
import { isUuid } from "../core/ids";
import type { DB } from "../db/schema";

/** What the estimate screen shows about the customer link of the repair order's latest version (I2-03a). */
export interface CustomerLinkStatus {
  /** A link can be created: the latest version is sent and not past its expiry. */
  canCreate: boolean;
  live: {
    linkId: string;
    createdAt: Date;
    createdByName: string | null;
    expiresAt: Date;
    /** Requests that opened the page; invalid attempts are not counted here. */
    opens: number;
    lastOpenedAt: Date | null;
  } | null;
}

export async function customerLinkStatus(db: Kysely<DB>, repairOrderId: string): Promise<CustomerLinkStatus> {
  if (!isUuid(repairOrderId)) return { canCreate: false, live: null };
  const version = await db
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .innerJoin("repair_order", "repair_order.id", "estimate.repair_order_id")
    .select([
      "estimate_version.id",
      "estimate_version.status",
      "repair_order.status as ro_status",
      sql<boolean>`estimate_version.expires_at > now()`.as("in_date"),
    ])
    .where("estimate.repair_order_id", "=", repairOrderId)
    .orderBy("estimate_version.version_no", "desc")
    .executeTakeFirst();
  if (!version) return { canCreate: false, live: null };
  const canCreate =
    version.status === "sent" &&
    version.in_date === true &&
    ["awaiting_approval", "in_progress"].includes(version.ro_status);
  const link = await db
    .selectFrom("customer_link")
    .leftJoin("app_user", "app_user.id", "customer_link.created_by")
    .select([
      "customer_link.id",
      "customer_link.created_at",
      "customer_link.expires_at",
      "app_user.display_name",
      (eb) =>
        eb
          .selectFrom("customer_link_access")
          .select((inner) => inner.fn.countAll<string>().as("n"))
          .whereRef("customer_link_access.customer_link_id", "=", "customer_link.id")
          .where("customer_link_access.outcome", "=", "opened")
          .as("opens"),
      (eb) =>
        eb
          .selectFrom("customer_link_access")
          .select((inner) => inner.fn.max("customer_link_access.at").as("last"))
          .whereRef("customer_link_access.customer_link_id", "=", "customer_link.id")
          .where("customer_link_access.outcome", "=", "opened")
          .as("last_opened_at"),
    ])
    .where("customer_link.estimate_version_id", "=", version.id)
    .where("customer_link.revoked_at", "is", null)
    .executeTakeFirst();
  return {
    canCreate,
    live: link
      ? {
          linkId: link.id,
          createdAt: link.created_at,
          createdByName: link.display_name,
          expiresAt: link.expires_at,
          opens: Number.parseInt(String(link.opens ?? "0"), 10),
          lastOpenedAt: link.last_opened_at ? new Date(link.last_opened_at) : null,
        }
      : null,
  };
}
