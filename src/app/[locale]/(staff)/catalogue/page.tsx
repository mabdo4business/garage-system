import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, DataTable, EmptyState, PageHeader, StatusChip } from "../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../i18n";
import { formatAed } from "../../../../i18n/format";
import { hasPermission } from "../../../../server/auth/permissions";
import { KINDS, listCatalogue } from "../../../../server/catalog/items";
import { Money } from "../../../../server/core/money";
import { getDb } from "../../../../server/db/client";
import type { CatalogueKind } from "../../../../server/db/schema";
import { requirePagePermission } from "../../server-support";
import { CreateItemForm } from "./catalogue-forms";
import { activeTaxCodes, NoTaxProfileBanner } from "./shared";

export const dynamic = "force-dynamic";

/** Price list (US-06.1, US-08.1): one tab per kind; prices include VAT (OD-14). */
export default async function CataloguePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "catalogue.read");
  const query = await searchParams;
  const kind: CatalogueKind = KINDS.includes(query.kind as CatalogueKind)
    ? (query.kind as CatalogueKind)
    : "labor_rate";
  const search = typeof query.q === "string" ? query.q : "";
  const showInactive = query.inactive === "1";
  const db = getDb();
  const items = await listCatalogue(db, { kind, search, includeInactive: showInactive });
  const canManage = hasPermission(session.roles, "pricing.manage");
  const taxCodes = canManage ? await activeTaxCodes(db, locale) : [];
  const href = (next: Partial<{ kind: string; q: string; inactive: string }>) => {
    const params = new URLSearchParams({
      kind,
      ...(search ? { q: search } : {}),
      ...(showInactive ? { inactive: "1" } : {}),
      ...next,
    });
    return `/${locale}/catalogue?${params.toString()}`;
  };
  const name = (item: { nameEn: string; nameAr: string }) => (locale === "ar" ? item.nameAr : item.nameEn);

  return (
    <>
      <PageHeader title={t(locale, "nav.catalogue")} subtitle={t(locale, "catalogue.subtitle")} />
      <NoTaxProfileBanner db={db} locale={locale} />

      <nav className="form-actions" aria-label={t(locale, "nav.catalogue")}>
        {KINDS.map((candidate) => (
          <a
            key={candidate}
            href={href({ kind: candidate })}
            className={candidate === kind ? "btn btn-primary" : "btn btn-secondary"}
            aria-current={candidate === kind ? "page" : undefined}
          >
            {t(locale, `catalogue.kind.${candidate}` as MessageKey)}
          </a>
        ))}
      </nav>

      <form method="get" className="search-hero" role="search">
        <input type="hidden" name="kind" value={kind} />
        {showInactive ? <input type="hidden" name="inactive" value="1" /> : null}
        <label htmlFor="catalogue-q" className="visually-hidden">
          {t(locale, "catalogue.search")}
        </label>
        <input
          id="catalogue-q"
          name="q"
          type="search"
          defaultValue={search}
          placeholder={t(locale, "catalogue.search")}
          dir="auto"
        />
        <button type="submit" className="btn btn-secondary">
          {t(locale, "directory.search.submit")}
        </button>
      </form>
      <p>
        <a href={href({ inactive: showInactive ? "0" : "1" })}>
          {t(locale, showInactive ? "catalogue.hideInactive" : "catalogue.showInactive")}
        </a>
      </p>

      {items.length === 0 ? (
        <EmptyState
          title={t(locale, "catalogue.empty")}
          text={canManage ? t(locale, "catalogue.emptyHint") : undefined}
        />
      ) : (
        <Card>
          <DataTable
            columns={[
              t(locale, "catalogue.code"),
              t(locale, "catalogue.name"),
              ...(kind === "part" ? [t(locale, "catalogue.partNo"), t(locale, "catalogue.stock")] : []),
              t(locale, `catalogue.priceLabel.${kind}` as MessageKey),
              t(locale, "catalogue.taxCode"),
            ]}
            rows={items.map((item) => [
              <a key="code" href={`/${locale}/catalogue/${item.id}`}>
                <bdi dir="ltr">{item.code}</bdi>
              </a>,
              <span key="name">
                <bdi>{name(item)}</bdi>
                {item.active ? null : (
                  <>
                    {" "}
                    <StatusChip tone="neutral">{t(locale, "catalogue.inactive")}</StatusChip>
                  </>
                )}
              </span>,
              ...(kind === "part"
                ? [
                    <bdi key="partNo" dir="ltr">
                      {item.partNo ?? ""}
                    </bdi>,
                    <StatusChip key="stock" tone={item.stockTracked ? "info" : "warning"}>
                      {t(
                        locale,
                        item.stockTracked ? "catalogue.stockTrackedShort" : "catalogue.nonStockShort",
                      )}
                    </StatusChip>,
                  ]
                : []),
              item.price ? <bdi key="price">{formatAed(Money.parse(item.price), locale)}</bdi> : "",
              <bdi key="tax" dir="ltr">
                {item.taxCode ?? ""}
              </bdi>,
            ])}
          />
        </Card>
      )}

      {canManage ? (
        <Card title={t(locale, `catalogue.add.${kind}` as MessageKey)}>
          {taxCodes.length === 0 ? (
            <p className="muted">{t(locale, "catalogue.noTaxCodes")}</p>
          ) : (
            <details className="disclosure">
              <summary>{t(locale, `catalogue.add.${kind}` as MessageKey)}</summary>
              <CreateItemForm locale={locale} kind={kind} idempotencyKey={randomUUID()} taxCodes={taxCodes} />
            </details>
          )}
        </Card>
      ) : null}
    </>
  );
}
