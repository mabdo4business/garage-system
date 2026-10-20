"use client";

import { useActionState } from "react";
import { t, type Locale } from "../../../../i18n";
import { FormErrorMessage } from "../../form-error";
import { EMPTY_FORM_STATE } from "../../form-state";
import { createCustomerAction, type CustomerFormState } from "./actions";

export function CustomerForm({ locale, idempotencyKey }: { locale: Locale; idempotencyKey: string }) {
  const [state, formAction, pending] = useActionState(
    createCustomerAction,
    EMPTY_FORM_STATE as CustomerFormState,
  );
  const values = state.values;
  const duplicate = state.duplicate;

  return (
    <form action={formAction} key={state.seq}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {duplicate ? <input type="hidden" name="confirmFor" value={duplicate.confirmFor} /> : null}

      {duplicate ? (
        <div role="alert" className="error">
          <p>
            {t(locale, "customer.duplicate.heading")} — {t(locale, "customer.duplicate.body")}
          </p>
          <ul>
            {duplicate.matches.map((match) => (
              <li key={match.id}>
                <a href={`/${locale}/customers/${match.id}`}>{match.name}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <FormErrorMessage locale={locale} error={state.error} />

      <label htmlFor="nameEn">{t(locale, "customer.new.nameEn")}</label>
      <input id="nameEn" name="nameEn" defaultValue={values.nameEn} dir="ltr" />

      <label htmlFor="nameAr">{t(locale, "customer.new.nameAr")}</label>
      <input id="nameAr" name="nameAr" defaultValue={values.nameAr} dir="rtl" />

      <label htmlFor="mobile">{t(locale, "customer.new.mobile")}</label>
      <input id="mobile" name="mobile" defaultValue={values.mobile} required dir="ltr" />

      <label htmlFor="email">{t(locale, "customer.new.email")}</label>
      <input id="email" name="email" type="email" defaultValue={values.email} dir="ltr" />

      <label htmlFor="preferredLanguage">{t(locale, "customer.new.language")}</label>
      <select
        id="preferredLanguage"
        name="preferredLanguage"
        defaultValue={values.preferredLanguage === "ar" ? "ar" : "en"}
      >
        <option value="en">{t(locale, "customer.new.languageEn")}</option>
        <option value="ar">{t(locale, "customer.new.languageAr")}</option>
      </select>

      <label>
        <input type="checkbox" name="marketingConsent" defaultChecked={values.marketingConsent === "on"} />{" "}
        {t(locale, "customer.new.marketingConsent")}
      </label>

      <button type="submit" disabled={pending}>
        {duplicate ? t(locale, "customer.duplicate.createAnyway") : t(locale, "customer.new.submit")}
      </button>
    </form>
  );
}
