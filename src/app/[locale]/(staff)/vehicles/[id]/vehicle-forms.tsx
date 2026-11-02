"use client";

import { useActionState } from "react";
import { Button, Field } from "../../../../../components/ui";
import { t, type Locale } from "../../../../../i18n";
import { FormErrorMessage } from "../../../form-error";
import { EMPTY_FORM_STATE } from "../../../form-state";
import { DuplicateVehicleWarning } from "../duplicate-list";
import { PlateFields } from "../plate-fields";
import {
  changePlateAction,
  transferOwnerAction,
  type ChangePlateFormState,
  type TransferOwnerFormState,
} from "./actions";

interface FormProps {
  locale: Locale;
  vehicleId: string;
  idempotencyKey: string;
}

export function ChangePlateForm({
  locale,
  vehicleId,
  idempotencyKey,
  currentEmirate,
}: FormProps & { currentEmirate?: string }) {
  const [state, formAction, pending] = useActionState(
    changePlateAction,
    EMPTY_FORM_STATE as ChangePlateFormState,
  );
  const duplicate = state.duplicate;
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {duplicate ? <input type="hidden" name="confirmFor" value={duplicate.confirmFor} /> : null}
      {duplicate ? <DuplicateVehicleWarning locale={locale} matches={duplicate.matches} /> : null}
      <FormErrorMessage locale={locale} error={state.error} />
      {/* Most plate changes stay in the same emirate, so start from the current one. */}
      <PlateFields locale={locale} values={{ plateEmirate: currentEmirate ?? "", ...state.values }} />
      <div className="form-actions">
        <Button variant={duplicate ? "primary" : "secondary"} disabled={pending}>
          {duplicate ? t(locale, "vehicle.duplicate.changeAnyway") : t(locale, "vehicle.profile.changePlate")}
        </Button>
      </div>
    </form>
  );
}

export function TransferOwnerForm({ locale, vehicleId, idempotencyKey }: FormProps) {
  const [state, formAction, pending] = useActionState(
    transferOwnerAction,
    EMPTY_FORM_STATE as TransferOwnerFormState,
  );
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormErrorMessage locale={locale} error={state.error} />
      <Field
        id="newOwnerCustomerId"
        label={t(locale, "vehicle.profile.newOwnerId")}
        hint={t(locale, "vehicle.new.ownerHint")}
      >
        <input
          id="newOwnerCustomerId"
          name="newOwnerCustomerId"
          defaultValue={state.values.newOwnerCustomerId}
          required
          dir="ltr"
          autoComplete="off"
        />
      </Field>
      <div className="form-actions">
        <Button variant="secondary" disabled={pending}>
          {t(locale, "vehicle.profile.transferOwner")}
        </Button>
      </div>
    </form>
  );
}
