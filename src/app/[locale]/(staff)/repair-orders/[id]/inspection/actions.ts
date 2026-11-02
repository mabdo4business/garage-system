"use server";

import { redirect } from "next/navigation";
import { getDb } from "../../../../../../server/db/client";
import {
  assignInspection,
  discardFindingPhoto,
  recordFinding,
  setFindingPhotoVisibility,
  updateFinding,
  withdrawFinding,
  type FindingInput,
} from "../../../../../../server/inspection/commands";
import {
  requireFindingAccess,
  requireMediaAccess,
  requireRepairOrderAccess,
} from "../../../../../../server/inspection/access";
import type { FormState } from "../../../../form-state";
import { errorFrom, field, localeOf, requireActionPermission, valuesOf } from "../../../../server-support";

/** Server actions for the inspection screen and the repair order's inspection card (I1-03). */

const FINDING_FIELDS = [
  "title",
  "severity",
  "faultCodes",
  "customerNote",
  "internalNote",
  "templateItemId",
] as const;

function findingFrom(values: Record<string, string>): FindingInput {
  return {
    title: values.title ?? "",
    severity: values.severity ?? "",
    faultCodes: values.faultCodes ?? "",
    customerNote: values.customerNote || null,
    internalNote: values.internalNote || null,
    templateItemId: values.templateItemId || null,
  };
}

const inspectionUrl = (locale: string, repairOrderId: string) =>
  `/${locale}/repair-orders/${repairOrderId}/inspection`;

export async function assignInspectionAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["technicianUserId"]);
  const repairOrderId = field(formData, "repairOrderId");
  try {
    const session = await requireActionPermission("inspection.assign");
    await assignInspection(getDb(), session, repairOrderId, values.technicianUserId ?? "");
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/repair-orders/${repairOrderId}`);
}

export async function recordFindingAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, FINDING_FIELDS);
  const repairOrderId = field(formData, "repairOrderId");
  try {
    const session = await requireActionPermission("finding.record");
    await requireRepairOrderAccess(getDb(), session, repairOrderId);
    await recordFinding(
      getDb(),
      session,
      repairOrderId,
      findingFrom(values),
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  const template = field(formData, "template");
  redirect(
    `${inspectionUrl(locale, repairOrderId)}${/^[a-z_]{2,40}$/.test(template) ? `?template=${template}` : ""}`,
  );
}

export async function updateFindingAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, FINDING_FIELDS);
  try {
    const session = await requireActionPermission("finding.record");
    await requireFindingAccess(getDb(), session, field(formData, "findingId"));
    await updateFinding(getDb(), session, field(formData, "findingId"), findingFrom(values));
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(inspectionUrl(locale, field(formData, "repairOrderId")));
}

export async function withdrawFindingAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["withdrawnReason"]);
  try {
    const session = await requireActionPermission("finding.record");
    await requireFindingAccess(getDb(), session, field(formData, "findingId"));
    await withdrawFinding(getDb(), session, field(formData, "findingId"), values.withdrawnReason ?? "");
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(inspectionUrl(locale, field(formData, "repairOrderId")));
}

/** "Show to customer" toggle (OD-11) and "Remove" for a finding photo. */
export async function findingPhotoAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const mediaId = field(formData, "mediaId");
  const intent = field(formData, "intent");
  try {
    const session = await requireActionPermission("finding.record");
    await requireMediaAccess(getDb(), session, mediaId);
    if (intent === "discard") await discardFindingPhoto(getDb(), session, mediaId);
    else
      await setFindingPhotoVisibility(
        getDb(),
        session,
        mediaId,
        intent === "share" ? "customer" : "internal",
      );
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(inspectionUrl(locale, field(formData, "repairOrderId")));
}
