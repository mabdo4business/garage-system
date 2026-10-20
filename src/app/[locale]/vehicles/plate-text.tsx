import { t, type Locale } from "../../../i18n";
import type { PlateInput } from "../../../server/vehicle/service";

/** "Sharjah A 12345": the emirate follows the page direction; only code and number are isolated LTR. */
export function PlateText({ locale, plate }: { locale: Locale; plate: PlateInput }) {
  return (
    <span>
      {t(locale, `emirate.${plate.emirate}`)}{" "}
      <bdi dir="ltr">
        {plate.code} {plate.number}
      </bdi>
    </span>
  );
}
