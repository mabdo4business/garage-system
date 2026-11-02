import type { Kysely } from "kysely";
import { runCommand } from "../command/runner";
import { DomainError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import type { DB } from "../db/schema";
import { parseDecisions, recordDecisions } from "../estimate/approval";
import { ipBlocked, limits, linkBusy, recordAccess, resolve, type LinkRequester } from "./customer";

/**
 * Approval through the customer link (I2-03b, PRD v0.2 §6.4, OD-60–OD-62): the customer types their name and
 * decides whole jobs; the decision is recorded at link-possession level (L1) with the link, IP and browser as
 * evidence, under the repair-order lock like every approval (A.4). Any amount until step-up arrives (I2-04, OD-62).
 *
 * Nobody is signed in, so anything that is not a recorded decision answers with one of the link's fixed pages:
 * the generic invalid page, "too many attempts", "this estimate has been updated", or the estimate as decided.
 * A form with a missing name or no job chosen is a ValidationError, shown on the form with its values kept.
 */

export type LinkApprovalOutcome =
  | { kind: "recorded"; approvalEventId: string; replayed: boolean }
  /** Which page the customer is sent to instead; nothing was recorded. */
  | { kind: "refused"; page: "invalid" | "blocked" | "updated" | "decided" };

export interface LinkApprovalInput {
  approverName: unknown;
  decisions: unknown;
  language: unknown;
}

/** Refusals inside the command, mapped to the page the customer is shown (AC2-02, AC2-04, AC21-05, AC21-07). */
const PAGE_BY_CODE: Record<string, "invalid" | "updated" | "decided"> = {
  estimate_expired: "invalid",
  estimate_closed: "invalid",
  link_revoked: "invalid",
  estimate_updated: "updated",
  estimate_not_sent: "updated",
  // Already decided another way (in person, another tab), or the same form sent again with other choices.
  revision_not_pending: "decided",
  idempotency_payload_mismatch: "decided",
};

export async function recordLinkApproval(
  db: Kysely<DB>,
  token: string,
  input: LinkApprovalInput,
  requester: LinkRequester,
  idempotencyKey: string,
): Promise<LinkApprovalOutcome> {
  const approverName = typeof input.approverName === "string" ? input.approverName.trim() : "";
  if (approverName.length < 1 || approverName.length > 200) {
    throw new ValidationError("Type your name", { field: "approverName" });
  }
  const language = input.language === "ar" ? "ar" : "en";
  const decisions = parseDecisions(input.decisions);
  if (!isUuid(idempotencyKey)) throw new ValidationError("Reload the page", { field: "form" });

  const max = await limits(db);
  if (await ipBlocked(db, requester.ip, max.invalidPerIp)) return { kind: "refused", page: "blocked" };
  const link = await resolve(db, token);
  if (!link || (link.state === "invalid" && !link.due)) {
    await recordAccess(db, requester, link?.linkId ?? null, "invalid");
    return { kind: "refused", page: "invalid" };
  }
  if (link.state === "updated") return { kind: "refused", page: "updated" };
  if (await linkBusy(db, link.linkId, max.requestsPerLink)) return { kind: "refused", page: "blocked" };
  // Every submission counts toward the link's request limit (T-42), so a loop of forms cannot hold the
  // repair order's lock for free. A version past its expiry is an invalid attempt that still goes on below:
  // the command records the expiry before refusing (AC21-07, T-37).
  await recordAccess(db, requester, link.linkId, link.due ? "invalid" : "submitted");
  // AC2-05: a job from another estimate (an edited form) is a tampered parameter, not a stale form.
  const own = await db
    .selectFrom("job_revision")
    .select("id")
    .where("proposed_in_version_id", "=", link.versionId)
    .execute();
  const ownIds = new Set(own.map((row) => row.id));
  if (decisions.some((d) => !ownIds.has(d.revisionId))) {
    await recordAccess(db, requester, link.linkId, "invalid");
    return { kind: "refused", page: "invalid" };
  }

  const options = {
    name: "estimate.record_link_approval",
    actor: { kind: "anonymous" as const },
    // Never the token: the link id says which link it was.
    idempotency: {
      key: idempotencyKey,
      payload: {
        linkId: link.linkId,
        approverName,
        language,
        decisions: decisions.map((d) => ({ revisionId: d.revisionId, decision: d.decision })),
      },
    },
  };
  try {
    const outcome = await runCommand(db, options, async (ctx) => {
      await ctx.locks.acquire("repair_order", [link.repairOrderId]);
      const current = await ctx.tx
        .selectFrom("customer_link")
        .innerJoin("estimate_version", "estimate_version.id", "customer_link.estimate_version_id")
        .select(["customer_link.revoked_at", "estimate_version.content_hash"])
        .where("customer_link.id", "=", link.linkId)
        .executeTakeFirstOrThrow();
      if (current.revoked_at) {
        // Revoked (or replaced) while the customer was deciding.
        throw new DomainError("link_revoked", "This link is no longer valid");
      }
      return recordDecisions(ctx, link.repairOrderId, link.versionId, decisions, {
        method: "link",
        verificationLevel: "possession",
        approverName,
        language,
        // The version is frozen once sent, so the hash read under the lock is what the page showed.
        contentHash: current.content_hash!,
        idempotencyKey,
        recordedBy: null,
        signature: null,
        link: { linkId: link.linkId, ip: requester.ip, userAgent: requester.userAgent },
      });
    });
    // AC21-07: the expiry was recorded; the customer gets the page an expired link gets.
    if (outcome.result.kind === "expired") return { kind: "refused", page: "invalid" };
    return { kind: "recorded", approvalEventId: outcome.result.approvalEventId, replayed: outcome.replayed };
  } catch (error) {
    const page = error instanceof DomainError ? PAGE_BY_CODE[error.code] : undefined;
    if (page) return { kind: "refused", page };
    throw error;
  }
}
