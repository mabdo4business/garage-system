import { t, type Locale } from "../../../i18n";
import type { DuplicateVehicle } from "../../../server/vehicle/service";

/** The vehicles a duplicate warning is about, each with why it matched. */
export function DuplicateVehicleList({ locale, matches }: { locale: Locale; matches: DuplicateVehicle[] }) {
  return (
    <ul>
      {matches.map((match, index) => (
        <li key={`${match.id}-${index}`}>
          <a href={`/${locale}/vehicles/${match.id}`} dir="ltr">
            {match.make} {match.model}
          </a>{" "}
          — {t(locale, `vehicle.duplicate.reason.${match.reason}`)}
        </li>
      ))}
    </ul>
  );
}
