"use client";

import { useActionState } from "react";
import { Button, Field } from "../../../../../components/ui";
import { t, type Locale } from "../../../../../i18n";
import { FormErrorMessage } from "../../../form-error";
import { EMPTY_FORM_STATE } from "../../../form-state";
import { DuplicateVehicleWarning } from "../duplicate-list";
import { PlateFields } from "../plate-fields";
import { createVehicleAction, type VehicleFormState } from "./actions";

export function VehicleForm({ locale, idempotencyKey }: { locale: Locale; idempotencyKey: string }) {
  const [state, formAction, pending] = useActionState(
    createVehicleAction,
    EMPTY_FORM_STATE as VehicleFormState,
  );
  const values = state.values;
  const duplicate = state.duplicate;
  const optional = t(locale, "common.optional");

  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {duplicate ? <input type="hidden" name="confirmFor" value={duplicate.confirmFor} /> : null}

      {duplicate ? <DuplicateVehicleWarning locale={locale} matches={duplicate.matches} /> : null}
      <FormErrorMessage locale={locale} error={state.error} />

      <Field
        id="ownerCustomerId"
        label={t(locale, "vehicle.new.owner")}
        hint={t(locale, "vehicle.new.ownerHint")}
      >
        <input
          id="ownerCustomerId"
          name="ownerCustomerId"
          defaultValue={values.ownerCustomerId}
          required
          dir="ltr"
          autoComplete="off"
        />
      </Field>

      <h3>{t(locale, "vehicle.new.plateSection")}</h3>
      <PlateFields locale={locale} values={values} />

      <h3>{t(locale, "vehicle.new.detailsSection")}</h3>
      <div className="form-grid">
        <Field id="make" label={t(locale, "vehicle.new.make")}>
          <input id="make" name="make" defaultValue={values.make} required dir="ltr" />
        </Field>
        <Field id="model" label={t(locale, "vehicle.new.model")}>
          <input id="model" name="model" defaultValue={values.model} required dir="ltr" />
        </Field>
        <Field id="year" label={t(locale, "vehicle.new.year")}>
          <input
            id="year"
            name="year"
            type="number"
            inputMode="numeric"
            defaultValue={values.year}
            required
            dir="ltr"
          />
        </Field>
        <Field id="colour" label={t(locale, "vehicle.new.colour")} optionalLabel={optional}>
          <input id="colour" name="colour" defaultValue={values.colour} />
        </Field>
        <Field id="vin" label={t(locale, "vehicle.new.vin")} optionalLabel={optional}>
          <input id="vin" name="vin" defaultValue={values.vin} dir="ltr" autoComplete="off" />
        </Field>
      </div>

      <div className="form-actions">
        <Button disabled={pending}>
          {duplicate ? t(locale, "vehicle.duplicate.createAnyway") : t(locale, "vehicle.new.submit")}
        </Button>
      </div>
    </form>
  );
}
