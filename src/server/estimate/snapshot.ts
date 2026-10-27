import type { Kysely } from "kysely";
import { canonicalJson, sha256Hex } from "../core/json";
import { Money } from "../core/money";
import type { DB, Emirate } from "../db/schema";
import { sumLines } from "./pricing";

/**
 * The canonical estimate snapshot (P0-11): a language-neutral data document — both Arabic and English
 * descriptions, amounts as exact decimal strings, the VAT method, the expiry and the ids of the terms texts
 * shown — hashed with a fixed serialization (`canonicalJson`, sorted keys). Every rendering of the estimate to
 * the customer, in either language, is made from this document, so the hash proves what was agreed (AT-20).
 *
 * Customer-facing (rule 9): no internal notes, costs, staff names or contact details. Built from a fixed list
 * of fields so new internal columns never leak by default.
 */

/** 2 (I2-01): adds `earlierApproved`, the work approved in earlier versions, shown as context only. */
export const SNAPSHOT_SCHEMA = 2;

export interface SnapshotLine {
  lineId: string;
  type: string;
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

export interface SnapshotJob {
  jobId: string;
  revisionId: string;
  revisionKind: string;
  title: string;
  /** "urgent" / "soon" / "ok" when the job comes from an inspection finding. */
  findingSeverity: string | null;
  lines: SnapshotLine[];
  total: string;
}

/**
 * Work the customer approved in an earlier version: context only, never re-decided (v0.2.1 §2.1 #4, AC21-01).
 * Totals as approved (VAT-inclusive, after line discounts).
 */
export interface SnapshotContextJob {
  jobId: string;
  revisionId: string;
  title: string;
  versionNo: number;
  total: string;
}

export interface EstimateSnapshot {
  schema: number;
  estimateVersionId: string;
  versionNo: number;
  repairOrderNumber: string;
  vehicle: {
    make: string;
    model: string;
    year: number;
    plate: { emirate: Emirate; code: string; number: string } | null;
  };
  currency: "AED";
  /** OD-14 and OD-18: prices quoted including VAT, VAT taken out per line, rounded half-up. */
  pricing: { pricesIncludeVat: true; vatMethod: "per_line_inclusive_half_up" };
  jobs: SnapshotJob[];
  /** Since schema 2; absent from version-1 snapshots made before I2-01. */
  earlierApproved?: SnapshotContextJob[];
  totals: {
    gross: string;
    discount: string;
    total: string;
    net: string;
    vat: string;
    byRate: { rate: string; net: string; vat: string }[];
  };
  expiresAt: string;
  terms: { ar: string | null; en: string | null };
}

export function hashSnapshot(snapshot: EstimateSnapshot): string {
  return sha256Hex(canonicalJson(snapshot));
}

/** Builds the snapshot of a version's live draft jobs (the caller holds the repair-order lock). */
export async function buildSnapshot(
  db: Kysely<DB>,
  versionId: string,
  input: { expiresAt: Date; terms: { ar: string | null; en: string | null } },
): Promise<EstimateSnapshot> {
  const head = await db
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .innerJoin("repair_order", "repair_order.id", "estimate.repair_order_id")
    .innerJoin("vehicle", "vehicle.id", "repair_order.vehicle_id")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .select([
      "estimate_version.version_no",
      "repair_order.id as repair_order_id",
      "repair_order.number",
      "vehicle.make",
      "vehicle.model",
      "vehicle.year",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number as plate_number",
    ])
    .where("estimate_version.id", "=", versionId)
    .executeTakeFirstOrThrow();

  const jobs = await db
    .selectFrom("repair_job")
    .innerJoin("job_revision", "job_revision.job_id", "repair_job.id")
    .leftJoin("finding", "finding.id", "repair_job.finding_id")
    .select([
      "repair_job.id",
      "repair_job.title",
      "finding.severity",
      "job_revision.id as revision_id",
      "job_revision.kind",
    ])
    .where("job_revision.proposed_in_version_id", "=", versionId)
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

  // Approved revisions of this repair order's jobs, proposed in other versions (§2.1 #4).
  const approved = await db
    .selectFrom("job_revision")
    .innerJoin("repair_job", "repair_job.id", "job_revision.job_id")
    .innerJoin("estimate_version", "estimate_version.id", "job_revision.proposed_in_version_id")
    .select([
      "repair_job.id as job_id",
      "repair_job.title",
      "job_revision.id as revision_id",
      "estimate_version.version_no",
    ])
    .where("repair_job.repair_order_id", "=", head.repair_order_id)
    .where("job_revision.status", "=", "approved")
    .where("job_revision.proposed_in_version_id", "<>", versionId)
    .orderBy("estimate_version.version_no")
    .orderBy("repair_job.created_at")
    .orderBy("repair_job.id")
    .execute();
  const approvedLines =
    approved.length === 0
      ? []
      : await db
          .selectFrom("revision_line")
          .select(["revision_id", "line_total"])
          .where(
            "revision_id",
            "in",
            approved.map((row) => row.revision_id),
          )
          .where("removed_at", "is", null)
          .execute();

  const amounts = lines.map((line) => ({
    gross: Money.parse(line.gross),
    discount: Money.parse(line.discount),
    total: Money.parse(line.line_total),
    net: Money.parse(line.net),
    vat: Money.parse(line.vat),
    rate: line.tax_rate,
  }));
  const totals = sumLines(amounts);

  return {
    schema: SNAPSHOT_SCHEMA,
    estimateVersionId: versionId,
    versionNo: head.version_no,
    repairOrderNumber: head.number,
    vehicle: {
      make: head.make,
      model: head.model,
      year: head.year,
      plate:
        head.emirate && head.code !== null && head.plate_number !== null
          ? { emirate: head.emirate, code: head.code, number: head.plate_number }
          : null,
    },
    currency: "AED",
    pricing: { pricesIncludeVat: true, vatMethod: "per_line_inclusive_half_up" },
    jobs: jobs.map((job) => {
      const own = lines.filter((line) => line.revision_id === job.revision_id);
      return {
        jobId: job.id,
        revisionId: job.revision_id,
        revisionKind: job.kind,
        title: job.title,
        findingSeverity: job.severity,
        total: own.reduce((sum, line) => sum.add(Money.parse(line.line_total)), Money.ZERO).toString(),
        lines: own.map((line) => ({
          lineId: line.id,
          type: line.line_type,
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
      };
    }),
    earlierApproved: approved.map((row) => ({
      jobId: row.job_id,
      revisionId: row.revision_id,
      title: row.title,
      versionNo: row.version_no,
      total: approvedLines
        .filter((line) => line.revision_id === row.revision_id)
        .reduce((sum, line) => sum.add(Money.parse(line.line_total)), Money.ZERO)
        .toString(),
    })),
    totals: {
      gross: totals.gross.toString(),
      discount: totals.discount.toString(),
      total: totals.total.toString(),
      net: totals.net.toString(),
      vat: totals.vat.toString(),
      byRate: totals.byRate.map((rate) => ({
        rate: rate.rate,
        net: rate.net.toString(),
        vat: rate.vat.toString(),
      })),
    },
    expiresAt: input.expiresAt.toISOString(),
    terms: input.terms,
  };
}
