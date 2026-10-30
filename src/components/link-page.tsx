import { t, type Locale } from "../i18n";
import { formatDubaiDateTime } from "../i18n/format";
import type { CustomerLinkPage } from "../server/links/customer";
import { EstimateDocument } from "./estimate-document";
import { PlateBadge } from "./ui";

/**
 * What a customer link shows (I2-03a). Mobile-first, no staff shell. Everything comes from the customer view
 * (`openCustomerLink`), which carries nothing internal (rule 9); the three message pages carry nothing at all
 * besides fixed text, so an invalid, expired or revoked link cannot be told apart (AC2-04).
 */
export function LinkPage({ locale, token, page }: { locale: Locale; token: string; page: CustomerLinkPage }) {
  if (page.kind !== "estimate") {
    const key = page.kind === "updated" ? "updated" : page.kind === "blocked" ? "blocked" : "invalid";
    return (
      <main className="link-page">
        <section className="card link-message" data-link-state={key}>
          <h1>{t(locale, `link.${key}.title`)}</h1>
          <p>{t(locale, `link.${key}.body`)}</p>
        </section>
      </main>
    );
  }

  const view = page.estimate;
  const other = locale === "ar" ? "en" : "ar";
  const garage = view.garageName ? (locale === "ar" ? view.garageName.ar : view.garageName.en) : null;
  const name = view.customerFirstName[locale] ?? view.customerFirstName[other];
  const decisions = new Map(view.decisions.map((d) => [d.revisionId, d.decision]));
  const terms = view.termsBody[locale];
  return (
    <main className="link-page">
      <header className="link-head">
        <div>
          {garage ? (
            <p className="link-garage" dir="auto">
              {garage}
            </p>
          ) : null}
          <h1>{t(locale, "link.title")}</h1>
        </div>
        <a className="btn btn-secondary" href={`/${other}/c/${token}`} lang={other}>
          {t(other, "common.languageName")}
        </a>
      </header>
      <section className="card link-summary">
        {name ? <p>{t(locale, "link.greeting", { name: "⁨" + name + "⁩" })}</p> : null}
        <p className="link-vehicle">
          <bdi>
            {view.vehicle.make} {view.vehicle.model} {view.vehicle.year}
          </bdi>
          {view.vehicle.plate ? <PlateBadge locale={locale} plate={view.vehicle.plate} /> : null}
        </p>
        <p className="muted">
          {t(locale, "approval.validUntil", { date: formatDubaiDateTime(view.expiresAt, locale) })}
        </p>
        <p>
          {view.status === "sent" && view.pendingRevisionIds.length > 0
            ? t(locale, "link.pendingNote")
            : t(locale, "approval.nothingPending")}
        </p>
      </section>
      <EstimateDocument
        snapshot={view}
        locale={locale}
        photoUrl={(photoId) => `/c/${token}/photo/${photoId}`}
        visiblePhotoIds={view.visiblePhotoIds}
        decisions={decisions}
      />
      {terms ? (
        <section className="card">
          <h2>{t(locale, "approval.terms")}</h2>
          <p className="terms-text">{terms}</p>
        </section>
      ) : null}
    </main>
  );
}
