"use server";

import { redirect } from "next/navigation";
import { getDb } from "../../../../../../server/db/client";
import { failQc, passQc, requestQc } from "../../../../../../server/quality/commands";
import type { FormState } from "../../../../form-state";
import { errorFrom, field, localeOf, requireActionPermission } from "../../../../server-support";

/** QC actions (I1-08). Each re-checks the permission; the commands check the repair order and the checker. */

async function run(
  previous: FormState,
  formData: FormData,
  back: string,
  step: () => Promise<unknown>,
): Promise<FormState> {
  const locale = localeOf(formData);
  try {
    await step();
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(`/${locale}${back}`);
}

export async function requestQcAction(previous: FormState, formData: FormData): Promise<FormState> {
  const back = field(formData, "back") || `/repair-orders/${field(formData, "repairOrderId")}`;
  return run(previous, formData, back.startsWith("/") ? back : "/", async () => {
    const session = await requireActionPermission("qc.request");
    await requestQc(getDb(), session, field(formData, "repairOrderId"), field(formData, "idempotencyKey"));
  });
}

export async function passQcAction(previous: FormState, formData: FormData): Promise<FormState> {
  const repairOrderId = field(formData, "repairOrderId");
  return run(previous, formData, `/repair-orders/${repairOrderId}/qc`, async () => {
    const session = await requireActionPermission("qc.decide");
    await passQc(
      getDb(),
      session,
      repairOrderId,
      {
        noNewWarningLights: field(formData, "noNewWarningLights"),
        roadTest: field(formData, "roadTest"),
        roadTestReason: field(formData, "roadTestReason"),
        odometerOutKm: field(formData, "odometerOutKm"),
        odometerReason: field(formData, "odometerReason"),
        fluidsOk: field(formData, "fluidsOk"),
        cleanlinessOk: field(formData, "cleanlinessOk"),
        belongingsOk: field(formData, "belongingsOk"),
        oldParts: field(formData, "oldParts"),
        notes: field(formData, "notes"),
      },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function failQcAction(previous: FormState, formData: FormData): Promise<FormState> {
  const repairOrderId = field(formData, "repairOrderId");
  return run(previous, formData, `/repair-orders/${repairOrderId}/qc`, async () => {
    const session = await requireActionPermission("qc.decide");
    const jobIds = formData.getAll("jobIds").filter((value): value is string => typeof value === "string");
    await failQc(
      getDb(),
      session,
      repairOrderId,
      { notes: field(formData, "notes"), jobIds },
      field(formData, "idempotencyKey"),
    );
  });
}
