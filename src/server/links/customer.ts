import { sql, type Kysely } from "kysely";
import { runCommand } from "../command/runner";
import { isUuid } from "../core/ids";
import type { DB, Emirate, EstimateVersionStatus } from "../db/schema";
import type { EstimateSnapshot, SnapshotContextJob, SnapshotJob } from "../estimate/snapshot";
import { currentBusinessProfile } from "../settings/business-profile";
import { hashLinkToken } from "./token";

/**
 * Customer links, customer side (I2-03a, PRD v0.2 §6.4, AC2-04, AC2-05). Nobody is signed in: the token is the
 * only key, so every answer that is not the estimate itself is one of three fixed pages, and an invalid, expired or
 * revoked token — or one for a closed repair order — gets exactly the same one (AC2-04).
 *
 * What the customer sees (rule 9, §6.4 "data shown"): the garage name, make/model/year, a masked plate, their
 * first name, and the estimate as frozen in its snapshot — jobs, prices, the customer note, fault codes (OD-63) and
 * photos marked for the customer. Never internal notes, costs, phone numbers, staff names or other vehicles.
 */

/** Who is asking: IP (rate limits, evidence) and browser, as the request carried them. */
export interface LinkRequester {
  ip: string;
  userAgent: string | null;
}

export type CustomerLinkPage =
  | { kind: "invalid" }
  | { kind: "blocked" }
  /** AC2-02: the version was withdrawn; never shows the newer version. */
  | { kind: "updated" }
  | { kind: "estimate"; estimate: CustomerEstimateView };

export interface CustomerEstimateView {
  linkId: string;
  versionId: string;
  status: Extract<EstimateVersionStatus, "sent" | "closed">;
  contentHash: string;
  expiresAt: Date;
  garageName: { ar: string; en: string } | null;
  customerFirstName: { ar: string | null; en: string | null };
  vehicle: {
    make: string;
    model: string;
    year: number;
    /** Masked to the last two digits (T-43). */
    plate: { emirate: Emirate; code: string; number: string } | null;
  };
  jobs: SnapshotJob[];
  earlierApproved: SnapshotContextJob[];
  totals: EstimateSnapshot["totals"];
  /** Jobs still awaiting the customer's decision, and those already decided (shown read-only). */
  pendingRevisionIds: string[];
  decisions: { revisionId: string; decision: "approved" | "declined" }[];
  /** Photo ids from the snapshot still marked for the customer (OD-11): one turned internal since stops showing. */
  visiblePhotoIds: string[];
  termsBody: { ar: string | null; en: string | null };
}

/** The window the rate limits count over (AC2-05: "within 10 minutes"). */
const WINDOW = sql<Date>`now() - interval '10 minutes'`;
/** Repair-order statuses past which an approval link no longer opens (§6.4: cancelled; delivered and closed too). */
const ENDED_ORDER = ["delivered", "closed", "cancelled"];

async function limits(db: Kysely<DB>): Promise<{ invalidPerIp: number; requestsPerLink: number }> {
  const rows = await db
    .selectFrom("app_setting")
    .select(["key", "value"])
    .where("key", "in", ["link.invalid_per_ip_10min", "link.requests_per_link_10min"])
    .execute();
  const read = (key: string) => {
    const value = String(rows.find((row) => row.key === key)?.value ?? "");
    if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error(`Invalid ${key} ${value}`);
    return Number.parseInt(value, 10);
  };
  return {
    invalidPerIp: read("link.invalid_per_ip_10min"),
    requestsPerLink: read("link.requests_per_link_10min"),
  };
}

/** AC2-05: more than the configured number of invalid attempts from this IP in 10 minutes blocks it for a while. */
async function ipBlocked(db: Kysely<DB>, ip: string, max: number): Promise<boolean> {
  const row = await db
    .selectFrom("customer_link_access")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("outcome", "=", "invalid")
    .where("ip", "=", ip)
    .where("at", ">", WINDOW)
    .executeTakeFirstOrThrow();
  return Number.parseInt(row.n, 10) > max;
}

async function linkBusy(db: Kysely<DB>, linkId: string, max: number): Promise<boolean> {
  const row = await db
    .selectFrom("customer_link_access")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("customer_link_id", "=", linkId)
    .where("at", ">", WINDOW)
    .executeTakeFirstOrThrow();
  return Number.parseInt(row.n, 10) >= max;
}

/** Records the request (insert-only) and audits it. Blocked requests are not recorded, so a flood writes nothing. */
async function recordAccess(
  db: Kysely<DB>,
  requester: LinkRequester,
  linkId: string | null,
  outcome: "opened" | "invalid",
): Promise<void> {
  await runCommand(db, { name: "link.record_access", actor: { kind: "anonymous" } }, async (ctx) => {
    const access = await ctx.tx
      .insertInto("customer_link_access")
      .values({
        customer_link_id: linkId,
        outcome,
        ip: requester.ip,
        user_agent: requester.userAgent,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // The IP stays in the access record only: that copy can be purged once V-1 sets retention (P1-09); the
    // audit log, which never changes, points to it instead.
    await ctx.audit({
      action: outcome === "opened" ? "link.opened" : "link.invalid",
      entityType: "customer_link",
      entityId: linkId ?? "(unknown)",
      details: { accessId: access.id },
    });
    return { ok: true };
  });
}

interface ResolvedLink {
  linkId: string;
  versionId: string;
  repairOrderId: string;
  state: "invalid" | "updated" | "open";
}

/** Which page a token leads to, from the link and its version as they are now (T-40); no writes. */
async function resolve(db: Kysely<DB>, token: string): Promise<ResolvedLink | null> {
  const hash = hashLinkToken(token);
  if (!hash) return null;
  const row = await db
    .selectFrom("customer_link")
    .innerJoin("estimate_version", "estimate_version.id", "customer_link.estimate_version_id")
    .innerJoin("repair_order", "repair_order.id", "customer_link.repair_order_id")
    .select([
      "customer_link.id",
      "customer_link.estimate_version_id",
      "customer_link.repair_order_id",
      "customer_link.revoked_at",
      "estimate_version.status",
      "repair_order.status as ro_status",
      // The link expires with its version (copied at creation); the version's own date is checked as well.
      sql<boolean>`customer_link.expires_at <= now() OR estimate_version.expires_at <= now()`.as(
        "past_expiry",
      ),
      // §6.4 "supersede": a later version has been sent to the customer since.
      sql<boolean>`EXISTS (SELECT 1 FROM estimate_version later
                            WHERE later.estimate_id = estimate_version.estimate_id
                              AND later.version_no > estimate_version.version_no
                              AND later.sent_at IS NOT NULL)`.as("superseded"),
    ])
    .where("customer_link.token_hash", "=", hash)
    .executeTakeFirst();
  if (!row) return null;
  const base = { linkId: row.id, versionId: row.estimate_version_id, repairOrderId: row.repair_order_id };
  if (row.revoked_at || row.past_expiry || ENDED_ORDER.includes(row.ro_status)) {
    return { ...base, state: "invalid" };
  }
  if (row.status === "withdrawn" || row.superseded) return { ...base, state: "updated" };
  if (row.status === "sent" || row.status === "closed") return { ...base, state: "open" };
  return { ...base, state: "invalid" }; // expired (or anything a link should never point at)
}

/** Name parts that do not stand alone as a first name ("عبد الله", "Abdul Rahman", "أبو بكر"). */
const COMPOUND_PREFIXES = new Set(["عبد", "عبدال", "أبو", "ابو", "abd", "abdul", "abdel", "abdal", "abu"]);

export function firstName(name: string | null): string | null {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return null;
  return COMPOUND_PREFIXES.has(words[0]!.toLowerCase()) && words.length > 1
    ? `${words[0]} ${words[1]}`
    : words[0]!;
}

/**
 * T-43: at most the last two digits stay visible, and only while at least three stay hidden — so 1–3 digit plates
 * (the most recognisable) are fully masked. The mask has a fixed width, so it does not reveal the length either.
 */
export function maskPlateNumber(number: string): string {
  const shown = Math.min(2, Math.max(0, number.length - 3));
  return `•••${shown === 0 ? "" : number.slice(-shown)}`;
}

async function estimateFor(db: Kysely<DB>, link: ResolvedLink): Promise<CustomerEstimateView> {
  const version = await db
    .selectFrom("estimate_version")
    .innerJoin("customer_link", "customer_link.estimate_version_id", "estimate_version.id")
    .innerJoin("repair_order", "repair_order.id", "customer_link.repair_order_id")
    .innerJoin("customer", "customer.id", "repair_order.customer_id")
    .select([
      "estimate_version.status",
      "estimate_version.content_hash",
      "estimate_version.snapshot",
      "customer_link.expires_at",
      "customer.name_ar",
      "customer.name_en",
    ])
    .where("customer_link.id", "=", link.linkId)
    .executeTakeFirstOrThrow();
  const snapshot = version.snapshot as EstimateSnapshot;
  const revisions = await db
    .selectFrom("job_revision")
    .leftJoin("revision_decision", "revision_decision.revision_id", "job_revision.id")
    .select(["job_revision.id", "job_revision.status", "revision_decision.decision"])
    .where("job_revision.proposed_in_version_id", "=", link.versionId)
    .execute();
  const photoIds = snapshot.jobs.flatMap((job) => job.finding?.photoIds ?? []);
  const visible =
    photoIds.length === 0
      ? []
      : await db
          .selectFrom("media_asset")
          .select("id")
          .where("id", "in", photoIds)
          .where("visibility", "=", "customer")
          .where("discarded_at", "is", null)
          .where("excluded_at", "is", null)
          .execute();
  const termIds = [snapshot.terms.ar, snapshot.terms.en].filter((id): id is string => id !== null);
  const terms =
    termIds.length === 0
      ? []
      : await db.selectFrom("terms_text").select(["id", "body"]).where("id", "in", termIds).execute();
  const body = (id: string | null) => terms.find((row) => row.id === id)?.body ?? null;
  const profile = await currentBusinessProfile(db);
  const plate = snapshot.vehicle.plate;
  return {
    linkId: link.linkId,
    versionId: link.versionId,
    status: version.status as "sent" | "closed",
    contentHash: version.content_hash!,
    expiresAt: version.expires_at,
    garageName: profile ? { ar: profile.legalNameAr, en: profile.legalNameEn } : null,
    customerFirstName: { ar: firstName(version.name_ar), en: firstName(version.name_en) },
    vehicle: {
      make: snapshot.vehicle.make,
      model: snapshot.vehicle.model,
      year: snapshot.vehicle.year,
      plate: plate ? { ...plate, number: maskPlateNumber(plate.number) } : null,
    },
    jobs: snapshot.jobs,
    earlierApproved: snapshot.earlierApproved ?? [],
    totals: snapshot.totals,
    pendingRevisionIds: revisions.filter((row) => row.status === "pending").map((row) => row.id),
    decisions: revisions.flatMap((row) =>
      row.decision ? [{ revisionId: row.id, decision: row.decision }] : [],
    ),
    visiblePhotoIds: visible.map((row) => row.id),
    termsBody: { ar: body(snapshot.terms.ar), en: body(snapshot.terms.en) },
  };
}

/** Opens a link page: rate limits first, then the token, then the request is recorded (AC2-04, AC2-05). */
export async function openCustomerLink(
  db: Kysely<DB>,
  token: string,
  requester: LinkRequester,
): Promise<CustomerLinkPage> {
  const max = await limits(db);
  if (await ipBlocked(db, requester.ip, max.invalidPerIp)) return { kind: "blocked" };
  const link = await resolve(db, token);
  if (!link || link.state === "invalid") {
    await recordAccess(db, requester, link?.linkId ?? null, "invalid");
    return { kind: "invalid" };
  }
  if (await linkBusy(db, link.linkId, max.requestsPerLink)) return { kind: "blocked" };
  await recordAccess(db, requester, link.linkId, "opened");
  if (link.state === "updated") return { kind: "updated" };
  return { kind: "estimate", estimate: await estimateFor(db, link) };
}

/**
 * A photo shown on the link page: only one listed in the version's snapshot and still marked for the customer,
 * through an open link from an IP that is not blocked. Anything else is null (the caller answers "not found").
 * A photo the page shows is not recorded (a page loads several, revealing nothing the page did not); a refused one
 * is an invalid attempt like any other (AC2-05: a modified token or URL parameter).
 */
export async function customerLinkPhoto(
  db: Kysely<DB>,
  token: string,
  photoId: string,
  requester: LinkRequester,
): Promise<{ storageKey: string; contentType: string } | null> {
  const max = await limits(db);
  if (await ipBlocked(db, requester.ip, max.invalidPerIp)) return null;
  const link = await resolve(db, token);
  const refuse = async () => {
    await recordAccess(db, requester, link?.linkId ?? null, "invalid");
    return null;
  };
  if (!link || link.state !== "open" || !isUuid(photoId)) return refuse();
  const version = await db
    .selectFrom("estimate_version")
    .select("snapshot")
    .where("id", "=", link.versionId)
    .executeTakeFirstOrThrow();
  const snapshot = version.snapshot as EstimateSnapshot;
  if (!snapshot.jobs.some((job) => job.finding?.photoIds.includes(photoId))) return refuse();
  const photo = await db
    .selectFrom("media_asset")
    .select(["storage_key", "content_type"])
    .where("id", "=", photoId)
    .where("visibility", "=", "customer")
    .where("discarded_at", "is", null)
    .where("excluded_at", "is", null)
    .executeTakeFirst();
  return photo ? { storageKey: photo.storage_key, contentType: photo.content_type } : refuse();
}

/**
 * Trusted proxy hops in front of the app (T-42): the client IP is the x-forwarded-for entry the outermost trusted
 * proxy appended, counted from the end — never the first entry, which the client writes itself. Next.js only fills
 * the header in when it is missing, so without a proxy the client controls it: production must run behind a proxy
 * that appends the address it sees, and hosting (I5-09) sets `TRUSTED_PROXY_HOPS` to the number of such proxies.
 */
function trustedHops(): number {
  const value = process.env.TRUSTED_PROXY_HOPS ?? "1";
  return /^[1-9]$/.test(value) ? Number.parseInt(value, 10) : 1;
}

/** The customer's IP and browser as the trusted proxies report them; "unknown" when there is no such entry. */
export function requesterFrom(headers: Headers, hops = trustedHops()): LinkRequester {
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const ip = (entries[entries.length - hops] ?? "unknown").slice(0, 64);
  const userAgent = headers.get("user-agent")?.slice(0, 500) ?? null;
  return { ip, userAgent };
}
