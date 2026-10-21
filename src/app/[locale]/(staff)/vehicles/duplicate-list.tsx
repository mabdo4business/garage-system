import { Alert } from "../../../../components/ui";
import { t, type Locale } from "../../../../i18n";
import type { DuplicateVehicle } from "../../../../server/vehicle/service";

/** The duplicate-vehicle warning: the vehicles it is about, each with why it matched. */
export function DuplicateVehicleWarning({
  locale,
  matches,
}: {
  locale: Locale;
  matches: DuplicateVehicle[];
}) {
  return (
    <Alert tone="warning">
      <p>
        <strong>{t(locale, "vehicle.duplicate.heading")}</strong> — {t(locale, "vehicle.duplicate.body")}
      </p>
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
    </Alert>
  );
}
