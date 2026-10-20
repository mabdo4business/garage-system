import { t, type Locale } from "../../../i18n";
import { EMIRATES } from "../../../server/vehicle/emirates";

/** Emirate / code / number inputs, shared by vehicle registration and plate change. */
export function PlateFields({ locale, values }: { locale: Locale; values: Record<string, string> }) {
  return (
    <>
      <label htmlFor="plateEmirate">{t(locale, "vehicle.new.emirate")}</label>
      <select id="plateEmirate" name="plateEmirate" defaultValue={values.plateEmirate || EMIRATES[0]}>
        {EMIRATES.map((emirate) => (
          <option key={emirate} value={emirate}>
            {t(locale, `emirate.${emirate}`)}
          </option>
        ))}
      </select>

      <label htmlFor="plateCode">{t(locale, "vehicle.new.plateCode")}</label>
      <input id="plateCode" name="plateCode" defaultValue={values.plateCode} required dir="ltr" />

      <label htmlFor="plateNumber">{t(locale, "vehicle.new.plateNumber")}</label>
      <input id="plateNumber" name="plateNumber" defaultValue={values.plateNumber} required dir="ltr" />
    </>
  );
}
