import type { Kysely } from "kysely";
import { isUuid } from "../core/ids";
import { Money } from "../core/money";
import type { DB, EstimateVersionStatus, FindingSeverity, RevisionLineType } from "../db/schema";
import { findingsForEstimate } from "../inspection/queries";
import { sumLines, type EstimateTotals } from "./pricing";
import type { EstimateSnapshot } from "./snapshot";

/**
 * The staff estimate builder's read model (I1-05a). Callers check estimate.read first. Staff-only: it
 * lists finding titles and exclusion reasons; customer-facing output is built from the snapshot (I1-05b).
 */

export interface EstimateLineView {
  id: string;
  lineType: RevisionLineType;
  descriptionEn: string;
  descriptionAr: string;
  unit: string | null;
  qty: string;
  unitPrice: string;
  gross: string;
  discount: string;
  total: string;
  net: string;
  vat: string;
  taxCode: string;
  taxRate: string;
}

export interface EstimateJobView {
  id: string;
  revisionId: string;
  title: string;
  findingId: string | null;
  findingSeverity: FindingSeverity | null;
  revisionStatus: string;
  lines: EstimateLineView[];
  total: string;
}

export interface UrgentFindingStatus {
  findingId: string;
  title: string;
  /** "included" has a live job; "excluded" has a recorded reason; "open" needs one or the other (AC-05.2). */
  state: "included" | "excluded" | "open";
  reason: string | null;
}

export interface EstimateView {
  estimateId: string;
  versionId: string;
  versionNo: number;
  status: EstimateVersionStatus;
  sentAt: Date | null;
  expiresAt: Date | null;
  contentHash: string | null;
  jobs: EstimateJobView[];
  urgentFindings: UrgentFindingStatus[];
  /** Active non-urgent findings without a job, offered as optional jobs. */
  otherFindings: { findingId: string; title: string; severity: FindingSeverity }[];
  totals: {
    gross: string;
    discount: string;
    total: string;
    net: string;
    vat: string;
    byRate: { rate: string; net: string; vat: string }[];
  };
}

function totalsJson(totals: EstimateTotals): EstimateView["totals"] {
  return {
    gross: totals.gross.toString(),
    discount: totals.discount.toString(),
    total: totals.total.toString(),
    net: totals.net.toString(),
    vat: totals.vat.toString(),
    byRate: totals.byRate.map((r) => ({ rate: r.rate, net: r.net.toString(), vat: r.vat.toString() })),
  };
}

/** The latest version of the repair order's estimate, or null when none was started. */
export async function estimateView(db: Kysely<DB>, repairOrderId: string): Promise<EstimateView | null> {
  if (!isUuid(repairOrderId)) return null;
  const version = await db
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .select([
      "estimate.id as estimate_id",
      "estimate_version.id",
      "estimate_version.version_no",
      "estimate_version.status",
      "estimate_version.sent_at",
      "estimate_version.expires_at",
      "estimate_version.content_hash",
    ])
    .where("estimate.repair_order_id", "=", repairOrderId)
    .orderBy("estimate_version.version_no", "desc")
    .executeTakeFirst();
  if (!version) return null;

  const jobs = await db
    .selectFrom("repair_job")
    .innerJoin("job_revision", "job_revision.job_id", "repair_job.id")
    .leftJoin("finding", "finding.id", "repair_job.finding_id")
    .select([
      "repair_job.id",
      "repair_job.title",
      "repair_job.finding_id",
      "finding.severity",
      "job_revision.id as revision_id",
      "job_revision.status as revision_status",
    ])
    .where("job_revision.proposed_in_version_id", "=", version.id)
    .where("repair_job.removed_at", "is", null)
    .orderBy("repair_job.created_at")
    .orderBy("repair_job.id")
    .execute();
  const lines =
    jobs.length === 0
      ? []
      : await db
          .selectFrom("revision_line")
          .selectAll()
          .where(
            "revision_id",
            "in",
            jobs.map((job) => job.revision_id),
          )
          .where("removed_at", "is", null)
          .orderBy("created_at")
          .orderBy("id")
          .execute();

  const allAmounts = [];
  const jobViews: EstimateJobView[] = [];
  for (const job of jobs) {
    const own = lines.filter((line) => line.revision_id === job.revision_id);
    const amounts = own.map((line) => ({
      gross: Money.parse(line.gross),
      discount: Money.parse(line.discount),
      total: Money.parse(line.line_total),
      net: Money.parse(line.net),
      vat: Money.parse(line.vat),
      rate: line.tax_rate,
    }));
    allAmounts.push(...amounts);
    jobViews.push({
      id: job.id,
      revisionId: job.revision_id,
      title: job.title,
      findingId: job.finding_id,
      findingSeverity: job.severity,
      revisionStatus: job.revision_status,
      total: sumLines(amounts).total.toString(),
      lines: own.map((line) => ({
        id: line.id,
        lineType: line.line_type,
        descriptionEn: line.description_en,
        descriptionAr: line.description_ar,
        unit: line.unit,
        qty: line.qty,
        unitPrice: line.unit_price,
        gross: line.gross,
        discount: line.discount,
        total: line.line_total,
        net: line.net,
        vat: line.vat,
        taxCode: line.tax_code,
        taxRate: line.tax_rate,
      })),
    });
  }

  const exclusions = await db
    .selectFrom("urgent_finding_exclusion")
    .select(["finding_id", "reason"])
    .where("estimate_version_id", "=", version.id)
    .where("cleared_at", "is", null)
    .execute();
  const findings = await findingsForEstimate(db, repairOrderId);
  const included = new Set(jobViews.map((job) => job.findingId).filter((id) => id !== null));
  const urgentFindings: UrgentFindingStatus[] = findings
    .filter((finding) => finding.severity === "urgent")
    .map((finding) => {
      const exclusion = exclusions.find((row) => row.finding_id === finding.id);
      return {
        findingId: finding.id,
        title: finding.title,
        state: included.has(finding.id) ? "included" : exclusion ? "excluded" : "open",
        reason: exclusion?.reason ?? null,
      };
    });
  const otherFindings = findings
    .filter((finding) => finding.severity !== "urgent" && !included.has(finding.id))
    .map((finding) => ({ findingId: finding.id, title: finding.title, severity: finding.severity }));

  return {
    estimateId: version.estimate_id,
    versionId: version.id,
    versionNo: version.version_no,
    status: version.status,
    sentAt: version.sent_at,
    expiresAt: version.expires_at,
    contentHash: version.content_hash,
    jobs: jobViews,
    urgentFindings,
    otherFindings,
    totals: totalsJson(sumLines(allAmounts)),
  };
}

export interface ApprovalScreenView {
  repairOrderId: string;
  versionId: string;
  status: EstimateVersionStatus;
  contentHash: string;
  expiresAt: Date;
  /** The frozen snapshot: the approval screen renders only this (P0-11). */
  snapshot: EstimateSnapshot;
  /** Revisions still awaiting a decision. */
  pendingRevisionIds: string[];
  /** Bodies of the terms texts recorded in the snapshot, per language (none until the owners supply them). */
  termsBody: { ar: string | null; en: string | null };
}

/** The sent (or closed) version as the customer is shown it, or null while there is none. */
export async function approvalScreenView(
  db: Kysely<DB>,
  repairOrderId: string,
): Promise<ApprovalScreenView | null> {
  if (!isUuid(repairOrderId)) return null;
  const version = await db
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .select([
      "estimate_version.id",
      "estimate_version.status",
      "estimate_version.content_hash",
      "estimate_version.expires_at",
      "estimate_version.snapshot",
    ])
    .where("estimate.repair_order_id", "=", repairOrderId)
    .where("estimate_version.status", "in", ["sent", "closed"])
    .orderBy("estimate_version.version_no", "desc")
    .executeTakeFirst();
  if (!version || !version.content_hash || !version.expires_at) return null;
  const pending = await db
    .selectFrom("job_revision")
    .select("id")
    .where("proposed_in_version_id", "=", version.id)
    .where("status", "=", "pending")
    .execute();
  const snapshot = version.snapshot as EstimateSnapshot;
  const termIds = [snapshot.terms.ar, snapshot.terms.en].filter((id): id is string => id !== null);
  const terms =
    termIds.length === 0
      ? []
      : await db.selectFrom("terms_text").select(["id", "body"]).where("id", "in", termIds).execute();
  const body = (id: string | null) => terms.find((row) => row.id === id)?.body ?? null;
  return {
    repairOrderId,
    versionId: version.id,
    status: version.status,
    contentHash: version.content_hash,
    expiresAt: version.expires_at,
    snapshot,
    pendingRevisionIds: pending.map((row) => row.id),
    termsBody: { ar: body(snapshot.terms.ar), en: body(snapshot.terms.en) },
  };
}
