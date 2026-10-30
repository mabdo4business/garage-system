"use client";

import { useParams } from "next/navigation";
import { isLocale, t } from "../../../../i18n";

/**
 * An unexpected failure on the customer's link page (I2-03b): the customer gets a translated, right-to-left-aware
 * message instead of the framework's own page, and nothing about the cause (it may hold internal detail).
 */
export default function LinkError({ reset }: { error: Error; reset: () => void }) {
  const params = useParams<{ locale: string }>();
  const locale = isLocale(params.locale) ? params.locale : "en";
  return (
    <main className="link-page">
      <section className="card link-message" role="alert">
        <h1>{t(locale, "link.error.title")}</h1>
        <p>{t(locale, "link.error.body")}</p>
        <button type="button" className="btn btn-secondary" onClick={reset}>
          {t(locale, "link.error.retry")}
        </button>
      </section>
    </main>
  );
}
