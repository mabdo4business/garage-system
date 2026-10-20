"use client";

import { useActionState } from "react";
import { t, type Locale } from "../../../../i18n";
import { FormErrorMessage } from "../../form-error";
import { EMPTY_FORM_STATE } from "../../form-state";
import { DuplicateVehicleList } from "../duplicate-list";
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

export function ChangePlateForm({ locale, vehicleId, idempotencyKey }: FormProps) {
  const [state, formAction, pending] = useActionState(
    changePlateAction,
    EMPTY_FORM_STATE as ChangePlateFormState,
  );
  const duplicate = state.duplicate;
  return (
    <form action={formAction} key={state.seq}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {duplicate ? <input type="hidden" name="confirmFor" value={duplicate.confirmFor} /> : null}
      {duplicate ? (
        <div role="alert" className="error">
          <p>
            {t(locale, "vehicle.duplicate.heading")} — {t(locale, "vehicle.duplicate.body")}
          </p>
          <DuplicateVehicleList locale={locale} matches={duplicate.matches} />
        </div>
      ) : null}
      <FormErrorMessage locale={locale} error={state.error} />
      <PlateFields locale={locale} values={state.values} />
      <button type="submit" disabled={pending}>
        {duplicate ? t(locale, "vehicle.duplicate.changeAnyway") : t(locale, "vehicle.profile.submit")}
      </button>
    </form>
  );
}

export function TransferOwnerForm({ locale, vehicleId, idempotencyKey }: FormProps) {
  const [state, formAction, pending] = useActionState(
    transferOwnerAction,
    EMPTY_FORM_STATE as TransferOwnerFormState,
  );
  return (
    <form action={formAction} key={state.seq}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormErrorMessage locale={locale} error={state.error} />
      <label htmlFor="newOwnerCustomerId">{t(locale, "vehicle.profile.newOwnerId")}</label>
      <input
        id="newOwnerCustomerId"
        name="newOwnerCustomerId"
        defaultValue={state.values.newOwnerCustomerId}
        required
        dir="ltr"
      />
      <button type="submit" disabled={pending}>
        {t(locale, "vehicle.profile.submit")}
      </button>
    </form>
  );
}
