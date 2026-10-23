"use client";

import { useActionState } from "react";
import { Button, Field } from "../../../../../components/ui";
import { t, type Locale } from "../../../../../i18n";
import { FormErrorMessage } from "../../../form-error";
import { EMPTY_FORM_STATE } from "../../../form-state";
import { addProfileAction, createCodeAction, setRateAction } from "./actions";

const CATEGORIES = ["standard", "zero_rated", "exempt", "out_of_scope", "not_registered"] as const;

export function AddProfileForm({
  locale,
  idempotencyKey,
  today,
}: {
  locale: Locale;
  idempotencyKey: string;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(addProfileAction, EMPTY_FORM_STATE);
  const values = state.values;
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormErrorMessage locale={locale} error={state.error} />
      <div className="form-grid">
        <Field id="registrationStatus" label={t(locale, "tax.status")}>
          <select
            id="registrationStatus"
            name="registrationStatus"
            defaultValue={values.registrationStatus || "registered"}
          >
            <option value="registered">{t(locale, "tax.status.registered")}</option>
            <option value="not_registered">{t(locale, "tax.status.not_registered")}</option>
          </select>
        </Field>
        <Field id="trn" label={t(locale, "tax.trn")} hint={t(locale, "tax.trnHint")}>
          <input
            id="trn"
            name="trn"
            inputMode="numeric"
            defaultValue={values.trn}
            dir="ltr"
            autoComplete="off"
          />
        </Field>
        <Field
          id="effectiveFrom"
          label={t(locale, "tax.effectiveFrom")}
          hint={t(locale, "tax.effectiveFromHint")}
        >
          <input
            id="effectiveFrom"
            name="effectiveFrom"
            type="date"
            defaultValue={values.effectiveFrom || today}
            required
            dir="ltr"
          />
        </Field>
      </div>
      <Field id="note" label={t(locale, "tax.note")} optionalLabel={t(locale, "common.optional")}>
        <input id="note" name="note" defaultValue={values.note} dir="auto" />
      </Field>
      <div className="form-actions">
        <Button disabled={pending}>{t(locale, "tax.addProfile")}</Button>
      </div>
    </form>
  );
}

export function CreateCodeForm({
  locale,
  today,
  idempotencyKey,
}: {
  locale: Locale;
  today: string;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(createCodeAction, EMPTY_FORM_STATE);
  const values = state.values;
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormErrorMessage locale={locale} error={state.error} />
      <div className="form-grid">
        <Field id="code" label={t(locale, "tax.code")}>
          <input id="code" name="code" defaultValue={values.code} required dir="ltr" autoComplete="off" />
        </Field>
        <Field id="category" label={t(locale, "tax.category")} hint={t(locale, "tax.categoryHint")}>
          <select id="category" name="category" defaultValue={values.category || "standard"}>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(locale, `tax.category.${category}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="labelEn" label={t(locale, "catalogue.nameEn")}>
          <input id="labelEn" name="labelEn" defaultValue={values.labelEn} required dir="ltr" />
        </Field>
        <Field id="labelAr" label={t(locale, "catalogue.nameAr")}>
          <input id="labelAr" name="labelAr" defaultValue={values.labelAr} required dir="rtl" />
        </Field>
        <Field id="rate" label={t(locale, "tax.rate")}>
          <input id="rate" name="rate" inputMode="decimal" defaultValue={values.rate} required dir="ltr" />
        </Field>
        <Field id="codeEffectiveFrom" label={t(locale, "tax.effectiveFrom")}>
          <input
            id="codeEffectiveFrom"
            name="effectiveFrom"
            type="date"
            defaultValue={values.effectiveFrom || today}
            required
            dir="ltr"
          />
        </Field>
      </div>
      <div className="form-actions">
        <Button disabled={pending}>{t(locale, "tax.createCode")}</Button>
      </div>
    </form>
  );
}

export function SetRateForm({
  locale,
  code,
  today,
  idempotencyKey,
}: {
  locale: Locale;
  code: string;
  today: string;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(setRateAction, EMPTY_FORM_STATE);
  const id = `rate-${code}`;
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormErrorMessage locale={locale} error={state.error} />
      <div className="form-grid">
        <Field id={id} label={t(locale, "tax.rate")}>
          <input
            id={id}
            name="rate"
            inputMode="decimal"
            defaultValue={state.values.rate}
            required
            dir="ltr"
          />
        </Field>
        <Field id={`${id}-from`} label={t(locale, "tax.effectiveFrom")}>
          <input
            id={`${id}-from`}
            name="effectiveFrom"
            type="date"
            defaultValue={state.values.effectiveFrom || today}
            required
            dir="ltr"
          />
        </Field>
      </div>
      <Button variant="secondary" disabled={pending}>
        {t(locale, "tax.setRate")}
      </Button>
    </form>
  );
}
