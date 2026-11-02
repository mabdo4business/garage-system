import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, DataTable, EmptyState, PageHeader, StatusChip } from "../../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../../i18n";
import { dubaiDate } from "../../../../../i18n/format";
import { getTaxSettings, taxProfileOn } from "../../../../../server/catalog/tax";
import { getDb } from "../../../../../server/db/client";
import { requirePagePermission } from "../../../server-support";
import { NoTaxProfileBanner } from "../../catalogue/shared";
import { AddProfileForm, CreateCodeForm, SetRateForm } from "./tax-forms";

export const dynamic = "force-dynamic";

/** Tax settings (v0.2.1 §4.4): dated profiles (VAT mode, TRN) and tax codes with rate history. */
export default async function TaxSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requirePagePermission(locale, "tax.manage");
  const db = getDb();
  const today = dubaiDate(new Date());
  const settings = await getTaxSettings(db);
  const current = await taxProfileOn(db, today);

  return (
    <>
      <PageHeader title={t(locale, "nav.taxSettings")} subtitle={t(locale, "tax.subtitle")} />
      <NoTaxProfileBanner db={db} locale={locale} />

      <Card title={t(locale, "tax.profiles")}>
        {settings.profiles.length === 0 ? (
          <EmptyState title={t(locale, "tax.noProfiles")} />
        ) : (
          <DataTable
            columns={[
              t(locale, "tax.effectiveFrom"),
              t(locale, "tax.status"),
              t(locale, "tax.trn"),
              t(locale, "tax.note"),
            ]}
            rows={settings.profiles.map((profile) => [
              <span key="from">
                <bdi dir="ltr">{profile.effectiveFrom}</bdi>{" "}
                {current?.effectiveFrom === profile.effectiveFrom ? (
                  <StatusChip tone="success">{t(locale, "tax.inForce")}</StatusChip>
                ) : null}
              </span>,
              t(locale, `tax.status.${profile.registrationStatus}` as MessageKey),
              <bdi key="trn" dir="ltr">
                {profile.trn ?? ""}
              </bdi>,
              <bdi key="note">{profile.note ?? ""}</bdi>,
            ])}
          />
        )}
        <details className="disclosure">
          <summary>{t(locale, "tax.addProfile")}</summary>
          <AddProfileForm locale={locale} idempotencyKey={randomUUID()} today={today} />
        </details>
      </Card>

      <Card title={t(locale, "tax.codes")}>
        <p className="muted">{t(locale, "tax.codesHint")}</p>
        {settings.codes.length === 0 ? (
          <EmptyState title={t(locale, "tax.noCodes")} />
        ) : (
          <ul className="finding-list">
            {settings.codes.map((code) => (
              <li key={code.code} className="finding">
                <div className="finding-head">
                  <strong>
                    <bdi dir="ltr">{code.code}</bdi>
                  </strong>
                  <bdi>{locale === "ar" ? code.labelAr : code.labelEn}</bdi>
                  <StatusChip tone="neutral">
                    {t(locale, `tax.category.${code.category}` as MessageKey)}
                  </StatusChip>
                </div>
                <DataTable
                  columns={[t(locale, "tax.effectiveFrom"), t(locale, "tax.rate")]}
                  rows={code.rates.map((rate) => [
                    <bdi key="from" dir="ltr">
                      {rate.effectiveFrom}
                    </bdi>,
                    <bdi key="rate" dir="ltr">
                      {t(locale, "tax.percent", { rate: rate.rate })}
                    </bdi>,
                  ])}
                />
                <details className="disclosure">
                  <summary>{t(locale, "tax.setRate")}</summary>
                  <SetRateForm locale={locale} code={code.code} today={today} idempotencyKey={randomUUID()} />
                </details>
              </li>
            ))}
          </ul>
        )}
        <details className="disclosure">
          <summary>{t(locale, "tax.createCode")}</summary>
          <CreateCodeForm locale={locale} today={today} idempotencyKey={randomUUID()} />
        </details>
      </Card>
    </>
  );
}
