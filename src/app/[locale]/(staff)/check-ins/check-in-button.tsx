import { randomUUID } from "node:crypto";
import { t, type Locale } from "../../../../i18n";
import { startCheckInAction } from "./actions";

/** "Check in this vehicle": starts a check-in draft and opens it. Works without client JavaScript. */
export function CheckInButton({ locale, vehicleId }: { locale: Locale; vehicleId: string }) {
  return (
    <form action={startCheckInAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <button type="submit" className="btn btn-primary">
        {t(locale, "checkIn.start")}
      </button>
    </form>
  );
}
