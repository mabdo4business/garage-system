"use client";

import { useActionState } from "react";
import { t, type Locale } from "../../../../i18n";
import { FormErrorMessage } from "../../form-error";
import { EMPTY_FORM_STATE } from "../../form-state";
import { DuplicateVehicleList } from "../duplicate-list";
import { PlateFields } from "../plate-fields";
import { createVehicleAction, type VehicleFormState } from "./actions";

export function VehicleForm({ locale, idempotencyKey }: { locale: Locale; idempotencyKey: string }) {
  const [state, formAction, pending] = useActionState(
    createVehicleAction,
    EMPTY_FORM_STATE as VehicleFormState,
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
            {t(locale, "vehicle.duplicate.heading")} — {t(locale, "vehicle.duplicate.body")}
          </p>
          <DuplicateVehicleList locale={locale} matches={duplicate.matches} />
        </div>
      ) : null}
      <FormErrorMessage locale={locale} error={state.error} />

      <label htmlFor="ownerCustomerId">{t(locale, "vehicle.new.owner")}</label>
      <input
        id="ownerCustomerId"
        name="ownerCustomerId"
        defaultValue={values.ownerCustomerId}
        required
        dir="ltr"
      />

      <label htmlFor="vin">{t(locale, "vehicle.new.vin")}</label>
      <input id="vin" name="vin" defaultValue={values.vin} dir="ltr" />

      <label htmlFor="make">{t(locale, "vehicle.new.make")}</label>
      <input id="make" name="make" defaultValue={values.make} required dir="ltr" />

      <label htmlFor="model">{t(locale, "vehicle.new.model")}</label>
      <input id="model" name="model" defaultValue={values.model} required dir="ltr" />

      <label htmlFor="year">{t(locale, "vehicle.new.year")}</label>
      <input id="year" name="year" type="number" defaultValue={values.year} required dir="ltr" />

      <label htmlFor="colour">{t(locale, "vehicle.new.colour")}</label>
      <input id="colour" name="colour" defaultValue={values.colour} dir="ltr" />

      <PlateFields locale={locale} values={values} />

      <button type="submit" disabled={pending}>
        {duplicate ? t(locale, "vehicle.duplicate.createAnyway") : t(locale, "vehicle.new.submit")}
      </button>
    </form>
  );
}
