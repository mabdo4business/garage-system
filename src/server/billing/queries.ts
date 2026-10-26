import type { Kysely } from "kysely";
import { ConflictError } from "../core/errors";
import { isUuid } from "../core/ids";
import { Money } from "../core/money";
import type { DB, Emirate } from "../db/schema";
import { businessProfileById, type BusinessProfileView } from "../settings/business-profile";
import { invoicePreview, type InvoiceAmounts } from "./invoice";

/**
 * Invoice reads (I1-09). `invoiceView` is the issued document as staff see it; `customerInvoice` (no COGS, no staff
 * data — rule 9) is what customer-facing output may use (print view, I1-09b).
 */

export interface InvoiceLineView {
  id: string;
  descriptionEn: string;
  descriptionAr: string;
  unit: string | null;
  qty: string;
  unitPrice: string;
  /** T-31: excl. VAT, after discount; reference only. */
  unitPriceNet: string;
  discount: string;
  net: string;
  vat: string;
  total: string;
  taxCode: string;
  taxCategory: string;
  taxRate: string;
}

export interface CustomerInvoice {
  id: string;
  number: string;
  businessDate: string;
  issuedAt: Date;
  repairOrderNumber: string;
  /** As at issue (T-32). */
  customerNameEn: string | null;
  customerNameAr: string | null;
  vehicle: {
    make: string;
    model: string;
    year: number;
    vin: string | null;
    plate: { emirate: Emirate; code: string; number: string } | null;
  };
  /** The garage details in force at issue (OD-46); null only for invoices issued before migration 0018. */
  business: BusinessProfileView | null;
  registrationStatus: "not_registered" | "registered";
  trn: string | null;
  gross: string;
  discount: string;
  net: string;
  vat: string;
  total: string;
  lines: InvoiceLineView[];
}

export interface InvoiceView extends CustomerInvoice {
  repairOrderId: string;
  issuedByName: string | null;
  taxChangeNotice: string | null;
  /** Staff-only: parts cost recognised at billing (T-28). */
  cogs: string;
}

export async function invoiceView(db: Kysely<DB>, invoiceId: string): Promise<InvoiceView | null> {
  if (!isUuid(invoiceId)) return null;
  // Customer and vehicle come from the invoice's own snapshot (T-32), never the live rows.
  const head = await db
    .selectFrom("invoice")
    .leftJoin("app_user", "app_user.id", "invoice.issued_by")
    .selectAll("invoice")
    .select("app_user.display_name")
    .where("invoice.id", "=", invoiceId)
    .executeTakeFirst();
  if (!head) return null;
  const lines = await db
    .selectFrom("invoice_line")
    .selectAll()
    .where("invoice_id", "=", invoiceId)
    .orderBy("position")
    .execute();
  const business = head.business_profile_id ? await businessProfileById(db, head.business_profile_id) : null;
  const cogs = lines.reduce((sum, line) => (line.cogs ? sum.add(Money.parse(line.cogs)) : sum), Money.ZERO);
  return {
    id: head.id,
    number: head.number,
    businessDate: head.business_date,
    issuedAt: head.issued_at,
    repairOrderId: head.repair_order_id,
    repairOrderNumber: head.ro_number,
    customerNameEn: head.customer_name_en,
    customerNameAr: head.customer_name_ar,
    vehicle: {
      make: head.vehicle_make,
      model: head.vehicle_model,
      year: head.vehicle_year,
      vin: head.vehicle_vin,
      plate:
        head.plate_emirate && head.plate_code !== null && head.plate_number !== null
          ? { emirate: head.plate_emirate, code: head.plate_code, number: head.plate_number }
          : null,
    },
    business,
    registrationStatus: head.registration_status,
    trn: head.trn,
    gross: head.gross,
    discount: head.discount,
    net: head.net,
    vat: head.vat,
    total: head.total,
    issuedByName: head.display_name,
    taxChangeNotice: head.tax_change_notice,
    cogs: cogs.toString(),
    lines: lines.map((line) => ({
      id: line.id,
      descriptionEn: line.description_en,
      descriptionAr: line.description_ar,
      unit: line.unit,
      qty: line.qty,
      unitPrice: line.unit_price,
      unitPriceNet: line.unit_price_net,
      discount: line.discount,
      net: line.net,
      vat: line.vat,
      total: line.total,
      taxCode: line.tax_code,
      taxCategory: line.tax_category,
      taxRate: line.tax_rate,
    })),
  };
}

/** Customer-facing view: built from a fixed list of fields — no COGS, notices or staff names (rule 9). */
export async function customerInvoice(db: Kysely<DB>, invoiceId: string): Promise<CustomerInvoice | null> {
  const view = await invoiceView(db, invoiceId);
  if (!view) return null;
  return {
    id: view.id,
    number: view.number,
    businessDate: view.businessDate,
    issuedAt: view.issuedAt,
    repairOrderNumber: view.repairOrderNumber,
    customerNameEn: view.customerNameEn,
    customerNameAr: view.customerNameAr,
    vehicle: view.vehicle,
    business: view.business,
    registrationStatus: view.registrationStatus,
    trn: view.trn,
    gross: view.gross,
    discount: view.discount,
    net: view.net,
    vat: view.vat,
    total: view.total,
    lines: view.lines,
  };
}

export interface RepairOrderBilling {
  invoice: { id: string; number: string; total: string } | null;
  drafts: {
    id: string;
    createdAt: Date;
    preview: InvoiceAmounts | null;
    /** Why there is no preview today (no tax profile or rate in force), so the page can say so. */
    previewError: "no_tax_profile" | "no_tax_rate" | null;
  }[];
}

/** The repair order's invoice (if issued) and its open drafts with today's preview. */
export async function repairOrderBilling(
  db: Kysely<DB>,
  repairOrderId: string,
  businessDate: string,
): Promise<RepairOrderBilling> {
  if (!isUuid(repairOrderId)) return { invoice: null, drafts: [] };
  const invoice = await db
    .selectFrom("invoice")
    .select(["id", "number", "total"])
    .where("repair_order_id", "=", repairOrderId)
    .orderBy("issued_at", "desc")
    .executeTakeFirst();
  const drafts = await db
    .selectFrom("invoice_draft")
    .select(["id", "created_at"])
    .where("repair_order_id", "=", repairOrderId)
    .where("status", "=", "draft")
    .orderBy("created_at")
    .execute();
  const result: RepairOrderBilling["drafts"] = [];
  for (const draft of drafts) {
    let preview: InvoiceAmounts | null = null;
    let previewError: "no_tax_profile" | "no_tax_rate" | null = null;
    try {
      preview = await invoicePreview(db, draft.id, businessDate);
    } catch (error) {
      if (
        error instanceof ConflictError &&
        (error.code === "no_tax_profile" || error.code === "no_tax_rate")
      ) {
        previewError = error.code;
      } else {
        throw error;
      }
    }
    result.push({ id: draft.id, createdAt: draft.created_at, preview, previewError });
  }
  return { invoice: invoice ?? null, drafts: result };
}
