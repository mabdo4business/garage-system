"use client";

import { useActionState } from "react";
import { Button, Field } from "../../../../../components/ui";
import { t, type Locale } from "../../../../../i18n";
import type { BusinessProfileView } from "../../../../../server/settings/business-profile";
import { FormErrorMessage } from "../../../form-error";
import { EMPTY_FORM_STATE } from "../../../form-state";
import { setBusinessProfileAction } from "./actions";

/** Filled from the current version; saving names it as the version replaced (OD-46). */
export function BusinessProfileForm({
  locale,
  idempotencyKey,
  current,
}: {
  locale: Locale;
  idempotencyKey: string;
  current: BusinessProfileView | null;
}) {
  const [state, formAction, pending] = useActionState(setBusinessProfileAction, EMPTY_FORM_STATE);
  const value = (name: keyof Omit<BusinessProfileView, "id">) => state.values[name] ?? current?.[name] ?? "";
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="supersedesId" value={current?.id ?? ""} />
      <FormErrorMessage locale={locale} error={state.error} />
      <div className="form-grid">
        <Field id="legalNameEn" label={t(locale, "businessProfile.legalNameEn")}>
          <input id="legalNameEn" name="legalNameEn" defaultValue={value("legalNameEn")} required dir="ltr" />
        </Field>
        <Field id="legalNameAr" label={t(locale, "businessProfile.legalNameAr")}>
          <input id="legalNameAr" name="legalNameAr" defaultValue={value("legalNameAr")} required dir="rtl" />
        </Field>
        <Field id="addressEn" label={t(locale, "businessProfile.addressEn")}>
          <textarea
            id="addressEn"
            name="addressEn"
            defaultValue={value("addressEn")}
            required
            dir="ltr"
            rows={2}
          />
        </Field>
        <Field id="addressAr" label={t(locale, "businessProfile.addressAr")}>
          <textarea
            id="addressAr"
            name="addressAr"
            defaultValue={value("addressAr")}
            required
            dir="rtl"
            rows={2}
          />
        </Field>
        <Field
          id="phone"
          label={t(locale, "businessProfile.phone")}
          hint={t(locale, "businessProfile.phoneHint")}
        >
          <input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            defaultValue={value("phone")}
            required
            dir="ltr"
            autoComplete="off"
          />
        </Field>
      </div>
      <div className="form-actions">
        <Button disabled={pending}>{t(locale, "businessProfile.save")}</Button>
      </div>
    </form>
  );
}
