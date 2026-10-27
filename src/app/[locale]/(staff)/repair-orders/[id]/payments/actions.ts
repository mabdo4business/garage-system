"use server";

import { redirect } from "next/navigation";
import { deliverVehicle, recordPayment } from "../../../../../../server/billing/payments";
import { getDb } from "../../../../../../server/db/client";
import type { FormState } from "../../../../form-state";
import { errorFrom, field, localeOf, requireActionPermission } from "../../../../server-support";

/** Payment and handover actions (I1-10). Each re-checks the permission; the commands check the balance and status. */

export async function recordPaymentAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = {
    amount: field(formData, "amount"),
    method: field(formData, "method"),
    reference: field(formData, "reference"),
  };
  try {
    const session = await requireActionPermission("payment.record");
    await recordPayment(
      getDb(),
      session,
      field(formData, "invoiceId"),
      { ...values, confirmDuplicate: field(formData, "confirmDuplicate") === "true" },
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    // The entered values come back so a "possible duplicate" can be confirmed without retyping (AC2-20).
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/repair-orders/${field(formData, "repairOrderId")}`);
}

export async function deliverAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const repairOrderId = field(formData, "repairOrderId");
  try {
    const session = await requireActionPermission("repair_order.deliver");
    await deliverVehicle(
      getDb(),
      session,
      repairOrderId,
      {
        keysReturned: field(formData, "keysReturned") === "true",
        belongingsReturned: field(formData, "belongingsReturned") === "true",
        overrideReason: field(formData, "overrideReason"),
      },
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(`/${locale}/repair-orders/${repairOrderId}`);
}
