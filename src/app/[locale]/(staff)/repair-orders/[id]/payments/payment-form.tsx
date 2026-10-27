"use client";

import { useActionState } from "react";
import { Button } from "../../../../../../components/ui";
import { t, type Locale } from "../../../../../../i18n";
import { FormErrorMessage } from "../../../../form-error";
import { EMPTY_FORM_STATE, type FormState } from "../../../../form-state";

/**
 * Record a payment (I1-10, PRD v0.2 §D2). The amount starts at the balance due; card and transfer need their reference
 * (AC2-22, OD-51). When the server answers "possible duplicate" (AC2-20) the form keeps what was typed and asks for a
 * confirmation; the same form key is sent again, so a double click still records one payment.
 */
export function PaymentForm({
  locale,
  action,
  invoiceId,
  repairOrderId,
  balance,
  idempotencyKey,
}: {
  locale: Locale;
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  invoiceId: string;
  repairOrderId: string;
  balance: string;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const duplicate = state.error?.key === "error.possibleDuplicate";
  const method = state.values.method || "cash";
  return (
    <form action={formAction} className="form payment-form" key={state.seq}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="repairOrderId" value={repairOrderId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormErrorMessage locale={locale} error={state.error} />
      <fieldset className="segmented segmented-3">
        <legend>{t(locale, "payment.method")}</legend>
        {(["cash", "card", "transfer"] as const).map((value) => (
          <label key={value}>
            <input type="radio" name="method" value={value} defaultChecked={method === value} required />
            <span>{t(locale, `payment.method.${value}`)}</span>
          </label>
        ))}
      </fieldset>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`amount-${invoiceId}`}>{t(locale, "payment.amount")}</label>
          <input
            id={`amount-${invoiceId}`}
            name="amount"
            inputMode="decimal"
            dir="ltr"
            required
            pattern="[0-9]+(\.[0-9]{1,2})?"
            defaultValue={state.values.amount ?? balance}
          />
        </div>
        <div className="field">
          <label htmlFor={`reference-${invoiceId}`}>{t(locale, "payment.reference")}</label>
          <input
            id={`reference-${invoiceId}`}
            name="reference"
            dir="ltr"
            maxLength={40}
            autoComplete="off"
            defaultValue={state.values.reference ?? ""}
          />
          <span className="hint">{t(locale, "payment.referenceHint")}</span>
        </div>
      </div>
      {duplicate ? (
        <label className="checkbox">
          <input type="checkbox" name="confirmDuplicate" value="true" required />
          <span>{t(locale, "payment.confirmDuplicate")}</span>
        </label>
      ) : null}
      <div className="form-actions">
        <Button variant="primary" disabled={pending}>
          {t(locale, "payment.record")}
        </Button>
      </div>
    </form>
  );
}
