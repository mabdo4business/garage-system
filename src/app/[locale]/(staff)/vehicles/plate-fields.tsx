import { Field } from "../../../../components/ui";
import { t, type Locale } from "../../../../i18n";
import { EMIRATES } from "../../../../server/vehicle/emirates";

/** Emirate / code / number inputs, shared by vehicle registration and plate change. */
export function PlateFields({ locale, values }: { locale: Locale; values: Record<string, string> }) {
  return (
    <div className="form-grid">
      <Field id="plateEmirate" label={t(locale, "vehicle.new.emirate")}>
        <select id="plateEmirate" name="plateEmirate" defaultValue={values.plateEmirate || EMIRATES[0]}>
          {EMIRATES.map((emirate) => (
            <option key={emirate} value={emirate}>
              {t(locale, `emirate.${emirate}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="plateCode" label={t(locale, "vehicle.new.plateCode")}>
        <input id="plateCode" name="plateCode" defaultValue={values.plateCode} required dir="ltr" />
      </Field>
      <Field id="plateNumber" label={t(locale, "vehicle.new.plateNumber")}>
        <input
          id="plateNumber"
          name="plateNumber"
          defaultValue={values.plateNumber}
          required
          dir="ltr"
          inputMode="numeric"
        />
      </Field>
    </div>
  );
}
