import type { Kysely } from "kysely";
import { isUuid } from "../core/ids";
import { Money } from "../core/money";
import type {
  DB,
  EstimateVersionStatus,
  FindingSeverity,
  RevisionLineType,
  VersionEndOutcome,
  WithdrawReasonCode,
} from "../db/schema";
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
  /**
   * "included": its job is in this version; "decided": the customer approved or declined it earlier; "excluded":
   * a reason is recorded for this version; "open": needs one or the other before sending (AC-05.2, OD-58).
   */
  state: "included" | "decided" | "excluded" | "open";
  reason: string | null;
  /** Its job, when that job lapsed and is offered again rather than included anew (OD-55). */
  reofferJobId: string | null;
}

/** One version in the estimate's history (I2-01). */
export interface VersionSummary {
  versionNo: number;
  status: EstimateVersionStatus;
  sentAt: Date | null;
  outcome: VersionEndOutcome | null;
  reasonCode: WithdrawReasonCode | null;
  reason: string | null;
  endedAt: Date | null;
}

/** A job of an earlier version: approved work (context), or declined / lapsed work that may be offered again. */
export interface EarlierJob {
  jobId: string;
  revisionId: string;
  title: string;
  findingSeverity: FindingSeverity | null;
  versionNo: number;
  status: "approved" | "declined" | "lapsed";
  lapseReason: "withdrawn" | "expired" | null;
  total: string;
}

export interface EstimateView {
  estimateId: string;
  versionId: string;
  versionNo: number;
  status: EstimateVersionStatus;
  /** Sent, and past its expiry though not yet recorded as expired (the next action on it expires it). */
  overdue: boolean;
  versions: VersionSummary[];
  /** Approved jobs from earlier versions (context only). */
  earlierApproved: EarlierJob[];
  /** Jobs whose latest proposal was declined or lapsed and that are not in this version (OD-55). */
  reofferable: EarlierJob[];
  sentAt: Date | null;
  expiresAt: Date | null;
  contentHash: string | null;
  /** I2-03b: decisions the customer gave through the link on this version (typed name, when). */
  linkDecisions: { approverName: string; recordedAt: Date }[];
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
    .where("job_revision.status", "<>", "discarded")
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
  const history = await earlierJobs(db, repairOrderId, version.id);
  // OD-58: decided by the customer if any revision of the finding's job was approved or declined (as send checks),
  // even when a later re-offer of it lapsed.
  const decidedRows = await db
    .selectFrom("repair_job")
    .innerJoin("job_revision", "job_revision.job_id", "repair_job.id")
    .select("repair_job.finding_id")
    .where("repair_job.repair_order_id", "=", repairOrderId)
    .where("repair_job.removed_at", "is", null)
    .where("repair_job.finding_id", "is not", null)
    .where("job_revision.status", "in", ["approved", "declined"])
    .execute();
  const decided = new Set(decidedRows.map((row) => row.finding_id));
  const withJob = new Set(history.map((job) => job.findingId).filter((id) => id !== null));
  const urgentFindings: UrgentFindingStatus[] = findings
    .filter((finding) => finding.severity === "urgent")
    .map((finding) => {
      const exclusion = exclusions.find((row) => row.finding_id === finding.id);
      return {
        findingId: finding.id,
        title: finding.title,
        state: included.has(finding.id)
          ? "included"
          : decided.has(finding.id)
            ? "decided"
            : exclusion
              ? "excluded"
              : "open",
        reason: exclusion?.reason ?? null,
        reofferJobId: history.find((job) => job.findingId === finding.id && job.reofferable)?.jobId ?? null,
      };
    });
  const otherFindings = findings
    .filter(
      (finding) => finding.severity !== "urgent" && !included.has(finding.id) && !withJob.has(finding.id),
    )
    .map((finding) => ({ findingId: finding.id, title: finding.title, severity: finding.severity }));

  return {
    estimateId: version.estimate_id,
    versionId: version.id,
    versionNo: version.version_no,
    status: version.status,
    overdue:
      version.status === "sent" && version.expires_at !== null && version.expires_at.getTime() <= Date.now(),
    versions: await versionHistory(db, version.estimate_id),
    earlierApproved: history.filter((job) => job.status === "approved").map(earlierJob),
    reofferable: history.filter((job) => job.reofferable).map(earlierJob),
    sentAt: version.sent_at,
    expiresAt: version.expires_at,
    contentHash: version.content_hash,
    jobs: jobViews,
    urgentFindings,
    otherFindings,
    totals: totalsJson(sumLines(allAmounts)),
    linkDecisions: await db
      .selectFrom("approval_event")
      .select(["approver_name as approverName", "recorded_at as recordedAt"])
      .where("estimate_version_id", "=", version.id)
      .where("method", "=", "link")
      .orderBy("recorded_at")
      .execute(),
  };
}

const earlierJob = (job: EarlierJob): EarlierJob => ({
  jobId: job.jobId,
  revisionId: job.revisionId,
  title: job.title,
  findingSeverity: job.findingSeverity,
  versionNo: job.versionNo,
  status: job.status,
  lapseReason: job.lapseReason,
  total: job.total,
});

async function versionHistory(db: Kysely<DB>, estimateId: string): Promise<VersionSummary[]> {
  const rows = await db
    .selectFrom("estimate_version")
    .leftJoin("estimate_version_end", "estimate_version_end.estimate_version_id", "estimate_version.id")
    .select([
      "estimate_version.version_no",
      "estimate_version.status",
      "estimate_version.sent_at",
      "estimate_version_end.outcome",
      "estimate_version_end.reason_code",
      "estimate_version_end.reason",
      "estimate_version_end.ended_at",
    ])
    .where("estimate_version.estimate_id", "=", estimateId)
    .orderBy("estimate_version.version_no")
    .execute();
  return rows.map((row) => ({
    versionNo: row.version_no,
    status: row.status,
    sentAt: row.sent_at,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    reason: row.reason,
    endedAt: row.ended_at,
  }));
}

/**
 * Each job's latest decided-or-lapsed revision from versions other than `versionId`: approved work, or declined /
 * lapsed work. A job with an open revision elsewhere, or approved at all, is not offered again (OD-55).
 */
async function earlierJobs(
  db: Kysely<DB>,
  repairOrderId: string,
  versionId: string,
): Promise<(EarlierJob & { findingId: string | null; reofferable: boolean })[]> {
  const rows = await db
    .selectFrom("job_revision")
    .innerJoin("repair_job", "repair_job.id", "job_revision.job_id")
    .innerJoin("estimate_version", "estimate_version.id", "job_revision.proposed_in_version_id")
    .leftJoin("finding", "finding.id", "repair_job.finding_id")
    .select([
      "repair_job.id as job_id",
      "repair_job.title",
      "repair_job.finding_id",
      "finding.severity",
      "job_revision.id as revision_id",
      "job_revision.revision_no",
      "job_revision.status",
      "job_revision.lapse_reason",
      "job_revision.proposed_in_version_id",
      "estimate_version.version_no",
    ])
    .where("repair_job.repair_order_id", "=", repairOrderId)
    .where("repair_job.removed_at", "is", null)
    .orderBy("repair_job.created_at")
    .orderBy("repair_job.id")
    .orderBy("job_revision.revision_no", "desc")
    .execute();
  const settled = rows.filter(
    (row) =>
      row.proposed_in_version_id !== versionId &&
      (row.status === "approved" || row.status === "declined" || row.status === "lapsed"),
  );
  const lines =
    settled.length === 0
      ? []
      : await db
          .selectFrom("revision_line")
          .select(["revision_id", "line_total"])
          .where(
            "revision_id",
            "in",
            settled.map((row) => row.revision_id),
          )
          .where("removed_at", "is", null)
          .execute();
  const result: (EarlierJob & { findingId: string | null; reofferable: boolean })[] = [];
  const seen = new Set<string>();
  for (const row of settled) {
    const own = rows.filter((other) => other.job_id === row.job_id);
    const approved = own.some((other) => other.status === "approved");
    // Approved revisions are all listed (context); otherwise only the latest settled one per job.
    if (row.status !== "approved" && (approved || seen.has(row.job_id))) continue;
    if (row.status !== "approved") seen.add(row.job_id);
    result.push({
      jobId: row.job_id,
      revisionId: row.revision_id,
      title: row.title,
      findingId: row.finding_id,
      findingSeverity: row.severity,
      versionNo: row.version_no,
      status: row.status as EarlierJob["status"],
      lapseReason: row.lapse_reason,
      total: lines
        .filter((line) => line.revision_id === row.revision_id)
        .reduce((sum, line) => sum.add(Money.parse(line.line_total)), Money.ZERO)
        .toString(),
      reofferable:
        row.status !== "approved" && !own.some((other) => ["draft", "pending"].includes(other.status)),
    });
  }
  return result;
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

/** The latest version as the customer is shown it, if it is sent (or closed); otherwise null. */
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
    .orderBy("estimate_version.version_no", "desc")
    .executeTakeFirst();
  // Only the latest version, and only once sent: an earlier closed version is never shown in place of a newer
  // draft, withdrawn or expired one (I2-01).
  if (
    !version ||
    !["sent", "closed"].includes(version.status) ||
    !version.content_hash ||
    !version.expires_at
  )
    return null;
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
