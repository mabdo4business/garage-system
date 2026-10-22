import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, DataTable, PageHeader, StatusChip } from "../../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../../i18n";
import { formatAed, formatDubaiDateTime } from "../../../../../i18n/format";
import { hasPermission } from "../../../../../server/auth/permissions";
import { getCatalogueItem } from "../../../../../server/catalog/items";
import { Money } from "../../../../../server/core/money";
import { getDb } from "../../../../../server/db/client";
import { requirePagePermission } from "../../../server-support";
import { ActiveForm, EditItemForm, SetPriceForm } from "../catalogue-forms";
import { activeTaxCodes } from "../shared";

export const dynamic = "force-dynamic";

export default async function CatalogueItemPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "catalogue.read", {
    entityType: "catalogue_item",
    entityId: id,
  });
  const db = getDb();
  const item = await getCatalogueItem(db, id);
  if (!item) notFound();
  const canManage = hasPermission(session.roles, "pricing.manage");
  const taxCodes = canManage ? await activeTaxCodes(db, locale) : [];
  const none = t(locale, "repairOrder.none");

  return (
    <>
      <PageHeader
        title={locale === "ar" ? item.nameAr : item.nameEn}
        subtitle={
          <>
            <StatusChip>{t(locale, `catalogue.kind.${item.kind}` as MessageKey)}</StatusChip>{" "}
            <bdi dir="ltr">{item.code}</bdi>{" "}
            {item.active ? null : <StatusChip tone="neutral">{t(locale, "catalogue.inactive")}</StatusChip>}
          </>
        }
      />

      <Card title={t(locale, "catalogue.currentPrice")}>
        <dl className="detail-list">
          <dt>{t(locale, `catalogue.priceLabel.${item.kind}` as MessageKey)}</dt>
          <dd>{item.price ? <bdi>{formatAed(Money.parse(item.price), locale)}</bdi> : none}</dd>
          <dt>{t(locale, "catalogue.taxCode")}</dt>
          <dd>
            <bdi dir="ltr">{item.taxCode ?? none}</bdi>
          </dd>
        </dl>
        <p className="muted">{t(locale, "catalogue.priceInclVat")}</p>
        {canManage && taxCodes.length > 0 ? (
          <details className="disclosure">
            <summary>{t(locale, "catalogue.setPrice")}</summary>
            <SetPriceForm
              locale={locale}
              itemId={item.id}
              kind={item.kind}
              idempotencyKey={randomUUID()}
              taxCodes={taxCodes}
              currentTaxCode={item.taxCode}
            />
          </details>
        ) : null}
      </Card>

      <Card title={t(locale, "catalogue.details")}>
        <dl className="detail-list">
          <dt>{t(locale, "catalogue.nameEn")}</dt>
          <dd>
            <bdi dir="ltr">{item.nameEn}</bdi>
          </dd>
          <dt>{t(locale, "catalogue.nameAr")}</dt>
          <dd>
            <bdi dir="rtl">{item.nameAr}</bdi>
          </dd>
          {item.kind === "part" ? (
            <>
              <dt>{t(locale, "catalogue.partNo")}</dt>
              <dd>
                <bdi dir="ltr">{item.partNo ?? none}</bdi>
              </dd>
              <dt>{t(locale, "catalogue.brand")}</dt>
              <dd>
                <bdi>{item.brand ?? none}</bdi>
              </dd>
              <dt>{t(locale, "catalogue.partType")}</dt>
              <dd>{item.partType ? t(locale, `catalogue.partType.${item.partType}` as MessageKey) : none}</dd>
              <dt>{t(locale, "catalogue.unit")}</dt>
              <dd>{item.unit ? t(locale, `catalogue.unit.${item.unit}` as MessageKey) : none}</dd>
              <dt>{t(locale, "catalogue.stock")}</dt>
              <dd>
                {t(locale, item.stockTracked ? "catalogue.stockTrackedLong" : "catalogue.nonStockLong")}
              </dd>
            </>
          ) : null}
          {item.descriptionEn || item.descriptionAr ? (
            <>
              <dt>{t(locale, "catalogue.description")}</dt>
              <dd dir="auto">
                {locale === "ar"
                  ? (item.descriptionAr ?? item.descriptionEn)
                  : (item.descriptionEn ?? item.descriptionAr)}
              </dd>
            </>
          ) : null}
        </dl>
        {canManage ? (
          <>
            <details className="disclosure">
              <summary>{t(locale, "finding.edit")}</summary>
              <EditItemForm
                locale={locale}
                itemId={item.id}
                kind={item.kind}
                initial={{
                  nameEn: item.nameEn,
                  nameAr: item.nameAr,
                  descriptionEn: item.descriptionEn ?? "",
                  descriptionAr: item.descriptionAr ?? "",
                  partNo: item.partNo ?? "",
                  brand: item.brand ?? "",
                  partType: item.partType ?? "",
                  unit: item.unit ?? "",
                }}
              />
            </details>
            <ActiveForm locale={locale} itemId={item.id} active={item.active} />
          </>
        ) : null}
      </Card>

      <Card title={t(locale, "catalogue.priceHistory")}>
        <DataTable
          columns={[
            t(locale, "catalogue.from"),
            t(locale, `catalogue.priceLabel.${item.kind}` as MessageKey),
            t(locale, "catalogue.taxCode"),
            t(locale, "catalogue.setBy"),
          ]}
          rows={item.history.map((row) => [
            <bdi key="from">{formatDubaiDateTime(row.effectiveFrom, locale)}</bdi>,
            <bdi key="price">{formatAed(Money.parse(row.price), locale)}</bdi>,
            <bdi key="tax" dir="ltr">
              {row.taxCode}
            </bdi>,
            <bdi key="by">{row.setByName ?? none}</bdi>,
          ])}
        />
      </Card>
      <p>
        <a href={`/${locale}/catalogue?kind=${item.kind}`}>{t(locale, "catalogue.back")}</a>
      </p>
    </>
  );
}
