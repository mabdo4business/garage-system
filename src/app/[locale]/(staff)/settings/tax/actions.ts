"use server";

import { redirect } from "next/navigation";
import { addTaxProfile, createTaxCode, setTaxCodeRate } from "../../../../../server/catalog/tax";
import { getDb } from "../../../../../server/db/client";
import type { FormState } from "../../../form-state";
import { errorFrom, field, localeOf, requireActionPermission, valuesOf } from "../../../server-support";

/** Tax settings actions (I1-04): partners only until dual control (T-15). */

export async function addProfileAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["registrationStatus", "trn", "effectiveFrom", "note"]);
  try {
    const session = await requireActionPermission("tax.manage");
    await addTaxProfile(
      getDb(),
      session,
      {
        registrationStatus: values.registrationStatus,
        trn: values.trn,
        effectiveFrom: values.effectiveFrom,
        note: values.note,
      },
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/settings/tax`);
}

export async function createCodeAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["code", "labelEn", "labelAr", "category", "rate", "effectiveFrom"]);
  try {
    const session = await requireActionPermission("tax.manage");
    await createTaxCode(
      getDb(),
      session,
      {
        code: values.code,
        labelEn: values.labelEn,
        labelAr: values.labelAr,
        category: values.category,
        rate: values.rate,
        effectiveFrom: values.effectiveFrom,
      },
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/settings/tax`);
}

export async function setRateAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["rate", "effectiveFrom"]);
  try {
    const session = await requireActionPermission("tax.manage");
    await setTaxCodeRate(
      getDb(),
      session,
      field(formData, "code"),
      {
        rate: values.rate,
        effectiveFrom: values.effectiveFrom,
      },
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/settings/tax`);
}
