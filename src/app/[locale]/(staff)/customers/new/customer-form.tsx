"use client";

import { useActionState } from "react";
import { Alert, Button, Field } from "../../../../../components/ui";
import { t, type Locale } from "../../../../../i18n";
import { FormErrorMessage } from "../../../form-error";
import { EMPTY_FORM_STATE } from "../../../form-state";
import { createCustomerAction, type CustomerFormState } from "./actions";

export function CustomerForm({ locale, idempotencyKey }: { locale: Locale; idempotencyKey: string }) {
  const [state, formAction, pending] = useActionState(
    createCustomerAction,
    EMPTY_FORM_STATE as CustomerFormState,
  );
  const values = state.values;
  const duplicate = state.duplicate;
  const optional = t(locale, "common.optional");

  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {duplicate ? <input type="hidden" name="confirmFor" value={duplicate.confirmFor} /> : null}

      {duplicate ? (
        <Alert tone="warning">
          <p>
            <strong>{t(locale, "customer.duplicate.heading")}</strong> —{" "}
            {t(locale, "customer.duplicate.body")}
          </p>
          <ul>
            {duplicate.matches.map((match) => (
              <li key={match.id}>
                <a href={`/${locale}/customers/${match.id}`}>{match.name}</a>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <FormErrorMessage locale={locale} error={state.error} />

      <div className="form-grid">
        <Field id="nameEn" label={t(locale, "customer.new.nameEn")} hint={t(locale, "customer.new.nameHint")}>
          <input id="nameEn" name="nameEn" defaultValue={values.nameEn} dir="ltr" autoComplete="off" />
        </Field>
        <Field id="nameAr" label={t(locale, "customer.new.nameAr")}>
          <input id="nameAr" name="nameAr" defaultValue={values.nameAr} dir="rtl" autoComplete="off" />
        </Field>
        <Field id="mobile" label={t(locale, "customer.new.mobile")}>
          <input
            id="mobile"
            name="mobile"
            type="tel"
            defaultValue={values.mobile}
            required
            dir="ltr"
            autoComplete="off"
          />
        </Field>
        <Field id="email" label={t(locale, "customer.new.email")} optionalLabel={optional}>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={values.email}
            dir="ltr"
            autoComplete="off"
          />
        </Field>
        <Field id="preferredLanguage" label={t(locale, "customer.new.language")}>
          <select
            id="preferredLanguage"
            name="preferredLanguage"
            defaultValue={values.preferredLanguage === "ar" ? "ar" : "en"}
          >
            <option value="en">{t(locale, "customer.new.languageEn")}</option>
            <option value="ar">{t(locale, "customer.new.languageAr")}</option>
          </select>
        </Field>
      </div>

      <label className="checkbox">
        <input type="checkbox" name="marketingConsent" defaultChecked={values.marketingConsent === "on"} />
        {t(locale, "customer.new.marketingConsent")}
      </label>

      <div className="form-actions">
        <Button disabled={pending}>
          {duplicate ? t(locale, "customer.duplicate.createAnyway") : t(locale, "customer.new.submit")}
        </Button>
      </div>
    </form>
  );
}
