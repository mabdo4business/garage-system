import type { Kysely, Transaction } from "kysely";
import { runCommand, type CommandContext, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import type { CustomerMessageKind, DB } from "../db/schema";
import { requirePermission, type Staff } from "../estimate/commands";
import { estimateMessage, LINK_PLACEHOLDER, readyMessage, whatsAppUrl, type MessageFacts } from "./text";

/**
 * Staff-initiated sharing (I2-09, PRD v0.2 E9-S2, OD-68–OD-71). A message is prepared — recorded with its text in
 * the customer's preferred language (OD-69) — and the advisor sends it from their own device, then confirms "I sent
 * it". A prepared message not confirmed within 15 minutes shows "Customer not yet informed" (AC2-28,
 * `notInformedSince`). Every step locks the repair order and is audited.
 */

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

/** What the advisor's screen needs to send a prepared message. */
export type PreparedMessage = {
  messageId: string;
  language: "ar" | "en";
  /** The text in both languages, so the advisor can switch before sending (OD-69). */
  bodies: { ar: string; en: string };
  /** WhatsApp click-to-chat addresses for each language (OD-70). */
  whatsApp: { ar: string; en: string };
};

async function factsOf(tx: Transaction<DB>, repairOrderId: string) {
  const row = await tx
    .selectFrom("repair_order")
    .innerJoin("vehicle", "vehicle.id", "repair_order.vehicle_id")
    .innerJoin("customer", "customer.id", "repair_order.customer_id")
    .select([
      "repair_order.status",
      "repair_order.contact_name",
      "repair_order.contact_mobile",
      "vehicle.make",
      "vehicle.model",
      "customer.preferred_language",
    ])
    .where("repair_order.id", "=", repairOrderId)
    .executeTakeFirstOrThrow();
  const profile = await tx
    .selectFrom("business_profile as p")
    .select(["p.legal_name_ar", "p.legal_name_en"])
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(selectFrom("business_profile as n").select("n.id").whereRef("n.supersedes_id", "=", "p.id")),
      ),
    )
    .executeTakeFirst();
  const facts: MessageFacts = {
    contactName: row.contact_name,
    make: row.make,
    model: row.model,
    garageName: profile ? { ar: profile.legal_name_ar, en: profile.legal_name_en } : null,
  };
  return { facts, status: row.status, mobile: row.contact_mobile, language: row.preferred_language };
}

async function insertMessage(
  ctx: CommandContext,
  staff: Staff,
  input: {
    repairOrderId: string;
    kind: CustomerMessageKind;
    linkId: string | null;
    language: "ar" | "en";
    stored: { ar: string; en: string };
    mobile: string;
  },
): Promise<string> {
  const row = await ctx.tx
    .insertInto("customer_message")
    .values({
      repair_order_id: input.repairOrderId,
      kind: input.kind,
      customer_link_id: input.linkId,
      language: input.language,
      // Both texts as the advisor's screen shows them (with [link]); "I sent it" only says which one went.
      body_ar: input.stored.ar,
      body_en: input.stored.en,
      recipient_mobile: input.mobile,
      prepared_by: staff.userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await ctx.audit({
    action: "message.prepared",
    entityType: "customer_message",
    entityId: row.id,
    after: { kind: input.kind, language: input.language, repairOrderId: input.repairOrderId },
  });
  return row.id;
}

/**
 * The estimate message, prepared together with its link (the token exists only at that moment, T-41). Called inside
 * `link.create`, which holds the repair-order lock. `url` is the link the customer opens; what is stored has
 * `[link]` in its place.
 */
export async function prepareEstimateMessage(
  ctx: CommandContext,
  staff: Staff,
  input: { repairOrderId: string; linkId: string; url: (locale: "ar" | "en") => string; expiresAt: Date },
): Promise<PreparedMessage> {
  const { facts, mobile, language } = await factsOf(ctx.tx, input.repairOrderId);
  const text = (locale: "ar" | "en", link: string) => estimateMessage(facts, locale, link, input.expiresAt);
  const bodies = { ar: text("ar", input.url("ar")), en: text("en", input.url("en")) };
  const messageId = await insertMessage(ctx, staff, {
    repairOrderId: input.repairOrderId,
    kind: "estimate_link",
    linkId: input.linkId,
    language,
    stored: { ar: text("ar", LINK_PLACEHOLDER), en: text("en", LINK_PLACEHOLDER) },
    mobile,
  });
  return {
    messageId,
    language,
    bodies,
    whatsApp: { ar: whatsAppUrl(mobile, bodies.ar), en: whatsAppUrl(mobile, bodies.en) },
  };
}

/** "Your car is ready for collection" for a Ready repair order (OD-71). */
export async function prepareReadyMessage(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
): Promise<CommandOutcome<PreparedMessage>> {
  requirePermission(staff, "message.share");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  return runCommand(db, { name: "message.prepare_ready", actor: actorOf(staff) }, async (ctx) => {
    await ctx.locks.acquire("repair_order", [repairOrderId]);
    const ro = await ctx.tx
      .selectFrom("repair_order")
      .select("status")
      .where("id", "=", repairOrderId)
      .executeTakeFirst();
    if (!ro) throw new NotFoundError("repair_order", repairOrderId);
    if (ro.status !== "ready") {
      throw new ConflictError("not_ready", "The car is not Ready", { status: ro.status });
    }
    const { facts, mobile, language } = await factsOf(ctx.tx, repairOrderId);
    const bodies = { ar: readyMessage(facts, "ar"), en: readyMessage(facts, "en") };
    const messageId = await insertMessage(ctx, staff, {
      repairOrderId,
      kind: "vehicle_ready",
      linkId: null,
      language,
      stored: bodies,
      mobile,
    });
    return {
      messageId,
      language,
      bodies,
      whatsApp: { ar: whatsAppUrl(mobile, bodies.ar), en: whatsAppUrl(mobile, bodies.en) },
    };
  });
}

/**
 * "I sent it" (OD-70): records the language actually sent and the confirmation, once. A second confirmation changes
 * nothing and says so.
 */
export async function markMessageShared(
  db: Kysely<DB>,
  staff: Staff,
  messageId: string,
  language: unknown,
): Promise<CommandOutcome<{ messageId: string; shared: boolean }>> {
  requirePermission(staff, "message.share");
  if (!isUuid(messageId)) throw new NotFoundError("customer_message", messageId);
  if (language !== "ar" && language !== "en")
    throw new ValidationError("Choose a language", { field: "language" });
  const owner = await db
    .selectFrom("customer_message")
    .select("repair_order_id")
    .where("id", "=", messageId)
    .executeTakeFirst();
  if (!owner) throw new NotFoundError("customer_message", messageId);
  return runCommand(db, { name: "message.mark_shared", actor: actorOf(staff) }, async (ctx) => {
    await ctx.locks.acquire("repair_order", [owner.repair_order_id]);
    const message = await ctx.tx
      .selectFrom("customer_message")
      .leftJoin("customer_link", "customer_link.id", "customer_message.customer_link_id")
      .select([
        "customer_message.kind",
        "customer_message.shared_at",
        "customer_message.repair_order_id",
        "customer_link.revoked_at",
      ])
      .where("customer_message.id", "=", messageId)
      .executeTakeFirstOrThrow();
    if (message.shared_at) {
      await ctx.audit({
        action: "message.share_repeated",
        entityType: "customer_message",
        entityId: messageId,
      });
      return { messageId, shared: false };
    }
    // The link in this message was replaced, revoked or ended by a contact change: confirming it would log a dead
    // link as the customer being told (the newer message is the one to send).
    if (message.kind === "estimate_link" && message.revoked_at) {
      throw new ConflictError("message_superseded", "A newer link replaced the one in this message");
    }
    await ctx.tx
      .updateTable("customer_message")
      // shared_at: the guard stamps the database's own time.
      .set({ language, shared_at: new Date(), shared_by: staff.userId })
      .where("id", "=", messageId)
      .execute();
    await ctx.audit({
      action: "message.shared",
      entityType: "customer_message",
      entityId: messageId,
      before: { shared: false },
      after: { shared: true, language },
      details: { repairOrderId: message.repair_order_id, kind: message.kind },
    });
    return { messageId, shared: true };
  });
}
