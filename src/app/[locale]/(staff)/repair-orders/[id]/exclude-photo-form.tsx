"use client";

import { useActionState } from "react";
import { Button, Field } from "../../../../../components/ui";
import { t, type Locale } from "../../../../../i18n";
import { FormErrorMessage } from "../../../form-error";
import { EMPTY_FORM_STATE } from "../../../form-state";
import { excludePhotoAction } from "./actions";

export function ExcludePhotoForm({
  locale,
  repairOrderId,
  mediaId,
}: {
  locale: Locale;
  repairOrderId: string;
  mediaId: string;
}) {
  const [state, formAction, pending] = useActionState(excludePhotoAction, EMPTY_FORM_STATE);
  const inputId = `exclude-${mediaId}`;
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="repairOrderId" value={repairOrderId} />
      <input type="hidden" name="mediaId" value={mediaId} />
      <FormErrorMessage locale={locale} error={state.error} />
      <Field id={inputId} label={t(locale, "repairOrder.excludeReason")}>
        <input id={inputId} name="excludedReason" defaultValue={state.values.excludedReason} required />
      </Field>
      <Button variant="secondary" disabled={pending}>
        {t(locale, "repairOrder.excludePhoto")}
      </Button>
    </form>
  );
}
