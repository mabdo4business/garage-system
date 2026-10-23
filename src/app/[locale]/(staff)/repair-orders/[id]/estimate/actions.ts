"use server";

import { redirect } from "next/navigation";
import { getDb } from "../../../../../../server/db/client";
import {
  addJob,
  addLine,
  excludeUrgentFinding,
  openEstimate,
  removeJob,
  removeLine,
  setLineDiscount,
  updateLineQty,
} from "../../../../../../server/estimate/commands";
import { sendVersion } from "../../../../../../server/estimate/approval";
import type { FormState } from "../../../../form-state";
import { errorFrom, field, localeOf, requireActionPermission, valuesOf } from "../../../../server-support";

/**
 * Estimate builder actions (I1-05a). Every action re-checks the permission on the server; the commands
 * check it again together with the draft's state, under the repair-order lock.
 */

const estimateUrl = (locale: string, repairOrderId: string) =>
  `/${locale}/repair-orders/${repairOrderId}/estimate`;

type Step = (formData: FormData, values: Record<string, string>) => Promise<unknown>;

/** Runs one estimate step and returns to the estimate, or reports the error to the form. */
async function run(
  previous: FormState,
  formData: FormData,
  names: readonly string[],
  step: Step,
): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, names);
  const repairOrderId = field(formData, "repairOrderId");
  try {
    await step(formData, values);
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(estimateUrl(locale, repairOrderId));
}

export async function openEstimateAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, [], async () => {
    const session = await requireActionPermission("estimate.edit");
    await openEstimate(getDb(), session, field(formData, "repairOrderId"), field(formData, "idempotencyKey"));
  });
}

export async function addJobAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, ["title"], async (_, values) => {
    const session = await requireActionPermission("estimate.edit");
    await addJob(
      getDb(),
      session,
      field(formData, "repairOrderId"),
      { title: values.title, findingId: field(formData, "findingId") },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function removeJobAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, ["reason"], async (_, values) => {
    const session = await requireActionPermission("estimate.edit");
    await removeJob(
      getDb(),
      session,
      field(formData, "jobId"),
      { reason: values.reason },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function excludeFindingAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, ["reason"], async (_, values) => {
    const session = await requireActionPermission("estimate.edit");
    await excludeUrgentFinding(
      getDb(),
      session,
      field(formData, "repairOrderId"),
      {
        findingId: field(formData, "findingId"),
        reason: values.reason,
      },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function addLineAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, ["itemId", "qty"], async (_, values) => {
    const session = await requireActionPermission("estimate.edit");
    await addLine(
      getDb(),
      session,
      field(formData, "jobId"),
      { itemId: values.itemId, qty: values.qty },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function updateQtyAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, ["qty"], async (_, values) => {
    const session = await requireActionPermission("estimate.edit");
    await updateLineQty(
      getDb(),
      session,
      field(formData, "lineId"),
      { qty: values.qty },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function discountAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, ["discount"], async (_, values) => {
    const session = await requireActionPermission("estimate.discount");
    await setLineDiscount(
      getDb(),
      session,
      field(formData, "lineId"),
      { discount: values.discount },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function removeLineAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, [], async () => {
    const session = await requireActionPermission("estimate.edit");
    await removeLine(getDb(), session, field(formData, "lineId"), field(formData, "idempotencyKey"));
  });
}

/** Presents the estimate (I1-05b): freezes the snapshot, then opens the customer's decision screen. */
export async function sendEstimateAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const repairOrderId = field(formData, "repairOrderId");
  try {
    const session = await requireActionPermission("estimate.send");
    await sendVersion(getDb(), session, repairOrderId, field(formData, "idempotencyKey"));
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(`/${locale}/repair-orders/${repairOrderId}/estimate/approve`);
}
