"use server";

import { redirect } from "next/navigation";
import { getDb } from "../../../../../server/db/client";
import { excludePhoto } from "../../../../../server/repair-order/check-in";
import type { FormState } from "../../../form-state";
import { errorFrom, field, localeOf, requireActionPermission, valuesOf } from "../../../server-support";

/** AC2-33: a manager marks a locked check-in photo as excluded, with a reason; the photo is kept. */
export async function excludePhotoAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["excludedReason"]);
  const repairOrderId = field(formData, "repairOrderId");
  try {
    const session = await requireActionPermission("media.exclude");
    await excludePhoto(
      getDb(),
      { kind: "user", userId: session.userId },
      field(formData, "mediaId"),
      values.excludedReason ?? "",
    );
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/repair-orders/${repairOrderId}`);
}
