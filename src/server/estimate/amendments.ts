import type { Kysely } from "kysely";
import { runCommand, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { Money } from "../core/money";
import type { DB } from "../db/schema";
import { authorizedScope } from "./approval";
import {
  insertPricedLine,
  lockDraft,
  priceCatalogueLine,
  repairOrderOfJob,
  requireAllowedQty,
  requirePermission,
  type Staff,
} from "./commands";
import { parseQty } from "./pricing";

/**
 * Amendments of approved work (I2-02a, v0.2.1 §2.1–§2.3, §3.2): a later version proposes a new revision of a job the
 * customer already approved. It may add lines (added scope) and replace authorized lines — the same item at a
 * higher amount (price change) or another item of the same type (substitution). The earlier approval and its
 * decision are never touched (AC21-01); until the customer decides, the replaced line stays authorized and is
 * frozen for parts (AC21-08), and the new lines cannot be worked or billed (AC2-06).
 *
 * The revision is created as "add_scope"; sending fixes its kind from its lines (T-47). Removing it from the draft
 * uses `removeJob` (the revision is discarded; the job and its approved work stay). Every command locks the repair
 * order first, then the line it replaces (repair order → revision line, F-13).
 */

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

/** Opens an amendment of an approved job in the current draft version. */
export async function amendJob(
  db: Kysely<DB>,
  staff: Staff,
  jobId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ revisionId: string }>> {
  requirePermission(staff, "estimate.edit");
  const repairOrderId = await repairOrderOfJob(db, jobId);
  const options = {
    name: "estimate.amend_job",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { jobId } },
  };
  return runCommand(db, options, async (ctx) => {
    const { versionId } = await lockDraft(ctx, repairOrderId);
    const job = await ctx.tx
      .selectFrom("repair_job")
      .select(["id", "title", "removed_at", "execution_status"])
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow();
    const revisions = await ctx.tx
      .selectFrom("job_revision")
      .select(["revision_no", "status"])
      .where("job_id", "=", jobId)
      .orderBy("revision_no", "desc")
      .execute();
    if (job.removed_at !== null || !revisions.some((row) => row.status === "approved")) {
      throw new ConflictError("not_amendable", "Only a job the customer approved can be changed");
    }
    if (revisions.some((row) => row.status === "draft" || row.status === "pending")) {
      throw new ConflictError("amendment_open", "This job already has a change waiting");
    }
    const revision = await ctx.tx
      .insertInto("job_revision")
      .values({
        job_id: jobId,
        revision_no: revisions[0]!.revision_no + 1,
        kind: "add_scope",
        proposed_in_version_id: versionId,
        lapse_reason: null,
        created_by: staff.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.audit({
      action: "estimate.amendment_opened",
      entityType: "repair_job",
      entityId: jobId,
      after: { versionId, revisionId: revision.id, title: job.title, jobStatus: job.execution_status },
    });
    return { revisionId: revision.id };
  });
}

/**
 * Replaces an authorized line of a job with a new line in the job's open amendment: the item chosen (the same
 * item by default) at today's price (T-18) and the quantity given. Refused, with the reason, when the line may
 * not be replaced (§2.3 guards), when the types differ, or when the same item would not cost more (a lower amount
 * is a garage reduction, I2-02b).
 */
export async function replaceLine(
  db: Kysely<DB>,
  staff: Staff,
  lineId: string,
  input: { itemId?: unknown; qty?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ lineId: string }>> {
  requirePermission(staff, "estimate.edit");
  if (!isUuid(lineId)) throw new NotFoundError("revision_line", lineId);
  const head = await db
    .selectFrom("revision_line")
    .innerJoin("job_revision", "job_revision.id", "revision_line.revision_id")
    .select(["job_revision.job_id", "revision_line.catalogue_item_id"])
    .where("revision_line.id", "=", lineId)
    .executeTakeFirst();
  if (!head) throw new NotFoundError("revision_line", lineId);
  const repairOrderId = await repairOrderOfJob(db, head.job_id);
  const rawItem =
    typeof input.itemId === "string" && input.itemId !== "" ? input.itemId : head.catalogue_item_id;
  if (!rawItem || !isUuid(rawItem)) {
    throw new ValidationError("Choose an item from the price list", { field: "itemId" });
  }
  const itemId = rawItem;
  const qty = parseQty(input.qty);
  const options = {
    name: "estimate.replace_line",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { lineId, itemId, qty: qty.toString() } },
  };
  return runCommand(db, options, async (ctx) => {
    const { versionId } = await lockDraft(ctx, repairOrderId);
    await ctx.locks.acquire("revision_line", [lineId]);
    const old = await ctx.tx
      .selectFrom("revision_line")
      .select(["id", "line_type", "catalogue_item_id", "qty", "line_total"])
      .where("id", "=", lineId)
      .executeTakeFirstOrThrow();
    const amendment = await ctx.tx
      .selectFrom("job_revision")
      .select(["id"])
      .where("job_id", "=", head.job_id)
      .where("proposed_in_version_id", "=", versionId)
      .where("status", "=", "draft")
      .where("kind", "=", "add_scope")
      .executeTakeFirst();
    if (!amendment) throw new ConflictError("no_amendment", "Open a change of this job first");

    if (!(await authorizedScope(ctx.tx, head.job_id)).includes(lineId)) {
      throw new ConflictError("line_not_authorized", "Only a line the customer approved can be replaced");
    }
    const replaced = await ctx.tx
      .selectFrom("revision_line")
      .select("id")
      .where("supersedes_line_id", "=", lineId)
      .where("revision_id", "=", amendment.id)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    if (replaced)
      throw new ConflictError("line_already_replaced", "This line is already replaced in the change");
    const billed = await ctx.tx
      .selectFrom("revision_line_billing")
      .select("revision_line_id")
      .where("revision_line_id", "=", lineId)
      .where("net_billed_qty", ">", "0")
      .executeTakeFirst();
    if (billed) throw new ConflictError("line_billed", "This line is already invoiced");
    const costed = await ctx.tx
      .selectFrom("line_cost_movement")
      .select("id")
      .where("revision_line_id", "=", lineId)
      .executeTakeFirst();
    if (costed) {
      throw new ConflictError("line_has_parts", "Parts or costs are already recorded on this line");
    }

    const priced = await priceCatalogueLine(ctx, itemId, qty);
    if (!priced.ok) {
      switch (priced.reason) {
        case "inactive":
          throw new ValidationError("Choose an active item from the price list", { field: "itemId" });
        case "no_price":
          throw new ValidationError("This item has no price yet", { field: "itemId" });
        case "fraction":
          requireAllowedQty(qty, priced.unit);
          throw new ValidationError("This item is counted in whole numbers", { field: "qty" });
        case "no_tax_rate":
          throw new ConflictError("no_tax_rate", `Tax code ${priced.taxCode} has no rate in force`, {
            taxCode: priced.taxCode,
          });
      }
    }
    if (priced.line.lineType !== old.line_type) {
      throw new ConflictError("line_type_differs", "Replace a line with an item of the same type", {
        field: "itemId",
      });
    }
    if (
      priced.line.itemId === old.catalogue_item_id &&
      priced.line.amounts.total.compare(Money.parse(old.line_total)) <= 0
    ) {
      throw new ConflictError(
        "price_not_higher",
        "The same item at the same or a lower amount is not a price change",
      );
    }
    const newLineId = await insertPricedLine(ctx, staff, head.job_id, amendment.id, priced.line, {
      lineId,
      itemId: old.catalogue_item_id,
      qty: old.qty,
      total: old.line_total,
    });
    return { lineId: newLineId };
  });
}
