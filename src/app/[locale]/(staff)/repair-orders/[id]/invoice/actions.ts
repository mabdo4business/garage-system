"use server";

import { redirect } from "next/navigation";
import {
  createInvoiceDraft,
  discardInvoiceDraft,
  issueInvoice,
} from "../../../../../../server/billing/invoice";
import { getDb } from "../../../../../../server/db/client";
import type { FormState } from "../../../../form-state";
import { errorFrom, field, localeOf, requireActionPermission } from "../../../../server-support";

/** Invoice actions (I1-09a). Each re-checks the permission; the commands check QC, the cap, P0-06 and tax. */

export async function createDraftAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const repairOrderId = field(formData, "repairOrderId");
  try {
    const session = await requireActionPermission("invoice.issue");
    await createInvoiceDraft(getDb(), session, repairOrderId, field(formData, "idempotencyKey"));
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(`/${locale}/repair-orders/${repairOrderId}`);
}

export async function issueAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  let invoiceId: string;
  try {
    const session = await requireActionPermission("invoice.issue");
    const outcome = await issueInvoice(
      getDb(),
      session,
      field(formData, "draftId"),
      { taxChangeNotice: field(formData, "taxChangeNotice") },
      field(formData, "idempotencyKey"),
    );
    invoiceId = outcome.result.invoiceId;
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(`/${locale}/invoices/${invoiceId}`);
}

export async function discardAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  try {
    const session = await requireActionPermission("invoice.issue");
    await discardInvoiceDraft(
      getDb(),
      session,
      field(formData, "draftId"),
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(`/${locale}/repair-orders/${field(formData, "repairOrderId")}`);
}
