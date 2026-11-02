"use server";

import { redirect } from "next/navigation";
import { getDb } from "../../../../server/db/client";
import {
  issueFromStock,
  markWaitingParts,
  receiveAndIssue,
  receiveStock,
} from "../../../../server/inventory/commands";
import type { FormState } from "../../form-state";
import { errorFrom, field, localeOf, requireActionPermission } from "../../server-support";

/** Stock and parts-for-jobs actions (I1-07, OD-29). Each re-checks the permission on the server. */

async function run(previous: FormState, formData: FormData, path: string, step: () => Promise<unknown>) {
  const locale = localeOf(formData);
  try {
    await step();
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) } satisfies FormState;
  }
  redirect(`/${locale}${path}`);
}

export async function receiveStockAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, "/stock", async () => {
    const session = await requireActionPermission("stock.receive");
    await receiveStock(
      getDb(),
      session,
      field(formData, "itemId"),
      {
        qty: field(formData, "qty"),
        amount: field(formData, "amount"),
        supplierName: field(formData, "supplierName"),
        supplierRef: field(formData, "supplierRef"),
      },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function issueAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, "/parts", async () => {
    const session = await requireActionPermission("stock.issue");
    await issueFromStock(
      getDb(),
      session,
      field(formData, "lineId"),
      { qty: field(formData, "qty"), overReason: field(formData, "overReason") },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function receiveAndIssueAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, "/parts", async () => {
    const session = await requireActionPermission("stock.issue");
    await receiveAndIssue(
      getDb(),
      session,
      field(formData, "lineId"),
      {
        qty: field(formData, "qty"),
        amount: field(formData, "amount"),
        supplierName: field(formData, "supplierName"),
        supplierRef: field(formData, "supplierRef"),
        overReason: field(formData, "overReason"),
      },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function waitingPartsAction(previous: FormState, formData: FormData): Promise<FormState> {
  const back = field(formData, "back") === "job" ? `/jobs/${field(formData, "jobId")}` : "/parts";
  return run(previous, formData, back, async () => {
    // Staff handling parts, or the job's assignee (the command checks which).
    const session = await requireActionPermission("workshop.my_jobs", "stock.issue");
    await markWaitingParts(getDb(), session, field(formData, "jobId"), field(formData, "idempotencyKey"));
  });
}
