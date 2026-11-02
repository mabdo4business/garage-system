"use server";

import { redirect } from "next/navigation";
import { getDb } from "../../../../../server/db/client";
import { setBusinessProfile } from "../../../../../server/settings/business-profile";
import type { FormState } from "../../../form-state";
import { errorFrom, field, localeOf, requireActionPermission, valuesOf } from "../../../server-support";

/** Business profile (I1-09b): partners only (OD-42). */
export async function setBusinessProfileAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["legalNameEn", "legalNameAr", "addressEn", "addressAr", "phone"]);
  try {
    const session = await requireActionPermission("business_profile.manage");
    await setBusinessProfile(
      getDb(),
      session,
      {
        legalNameEn: values.legalNameEn,
        legalNameAr: values.legalNameAr,
        addressEn: values.addressEn,
        addressAr: values.addressAr,
        phone: values.phone,
        supersedesId: field(formData, "supersedesId"),
      },
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/settings/business`);
}
