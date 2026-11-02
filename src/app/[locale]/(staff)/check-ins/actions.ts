"use server";

import { redirect } from "next/navigation";
import { idempotencyKeyUsed } from "../../../../server/command/runner";
import { getDb } from "../../../../server/db/client";
import {
  abandonCheckIn,
  checkInFieldsFrom,
  completeCheckIn,
  discardCheckInPhoto,
  startCheckIn,
  updateCheckIn,
} from "../../../../server/repair-order/check-in";
import type { FormState } from "../../form-state";
import { errorFrom, field, localeOf, requireActionPermission, valuesOf } from "../../server-support";

/** Server actions for the check-in screen (I1-02). Photos upload through POST /api/check-ins/:id/photos. */

export type CheckInFormState = FormState<never> & { saved?: boolean };

const FIELDS = [
  "contactName",
  "contactMobile",
  "contactRelationship",
  "odometerKm",
  "fuelEighths",
  "warningLights",
  "concerns",
  "belongings",
  "keysReceived",
  "keyTag",
  "promisedAt",
  "photoShortfallReason",
] as const;

/** "Check in" on a vehicle: creates the draft and opens it. */
export async function startCheckInAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const session = await requireActionPermission("repair_order.check_in");
  const outcome = await startCheckIn(
    getDb(),
    { kind: "user", userId: session.userId },
    field(formData, "vehicleId"),
    field(formData, "idempotencyKey"),
  );
  redirect(`/${locale}/check-ins/${outcome.result.checkInId}`);
}

/**
 * The check-in form's two buttons: "Save" keeps the draft; "Complete check-in" saves the same fields
 * and then completes, so nothing typed is lost when completion is refused (e.g. a missing reason).
 */
export async function saveCheckInAction(
  previous: CheckInFormState,
  formData: FormData,
): Promise<CheckInFormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, FIELDS);
  const seq = previous.seq + 1;
  const checkInId = field(formData, "checkInId");
  const complete = field(formData, "intent") === "complete";
  const db = getDb();

  let repairOrderId: string | undefined;
  try {
    const session = await requireActionPermission("repair_order.check_in");
    const actor = { kind: "user" as const, userId: session.userId };
    // A repeated "Complete" from the same form (double tap, network retry) replays the completion
    // instead of failing in the save step on a check-in that is already completed.
    const key = field(formData, "idempotencyKey");
    const confirm = field(formData, "confirmOpenRepairOrder") || null;
    if (complete && (await idempotencyKeyUsed(db, "check_in.complete", key))) {
      repairOrderId = (
        await completeCheckIn(db, actor, checkInId, key, undefined, { confirmOpenRepairOrder: confirm })
      ).result.repairOrderId;
    } else {
      // Only fields the form actually has (a role without contact rights gets no mobile field).
      const present = Object.fromEntries(
        FIELDS.filter((key) => formData.has(key)).map((key) => [key, field(formData, key)]),
      );
      await updateCheckIn(db, actor, checkInId, checkInFieldsFrom(present));
      if (complete) {
        const outcome = await completeCheckIn(
          db,
          actor,
          checkInId,
          field(formData, "idempotencyKey"),
          undefined,
          {
            confirmOpenRepairOrder: confirm,
          },
        );
        repairOrderId = outcome.result.repairOrderId;
      }
    }
  } catch (error) {
    return { seq, values, error: errorFrom(error) };
  }
  if (repairOrderId) redirect(`/${locale}/repair-orders/${repairOrderId}`);
  return { seq, values, saved: true };
}

export async function abandonCheckInAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["abandonedReason"]);
  try {
    const session = await requireActionPermission("repair_order.check_in");
    await abandonCheckIn(
      getDb(),
      { kind: "user", userId: session.userId },
      field(formData, "checkInId"),
      values.abandonedReason ?? "",
    );
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/repair-orders`);
}

export async function discardPhotoAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const checkInId = field(formData, "checkInId");
  try {
    const session = await requireActionPermission("repair_order.check_in");
    await discardCheckInPhoto(getDb(), { kind: "user", userId: session.userId }, field(formData, "mediaId"));
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(`/${locale}/check-ins/${checkInId}`);
}
