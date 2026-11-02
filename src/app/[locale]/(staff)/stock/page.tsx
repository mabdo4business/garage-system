import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, DataTable, EmptyState, PageHeader } from "../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../i18n";
import { formatAed } from "../../../../i18n/format";
import { hasPermission } from "../../../../server/auth/permissions";
import { Money } from "../../../../server/core/money";
import { getDb } from "../../../../server/db/client";
import { stockList } from "../../../../server/inventory/queries";
import { ActionForm } from "../../action-form";
import { requirePagePermission } from "../../server-support";
import { receiveStockAction } from "./actions";

export const dynamic = "force-dynamic";

const trim = (qty: string) => qty.replace(/\.?0+$/, "") || "0";

/** Stock-tracked parts on hand, with value (T-24: stock roles only) and a goods receipt form (OD-28). */
export default async function StockPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "stock.read");
  const rows = await stockList(getDb());
  const canReceive = hasPermission(session.roles, "stock.receive");
  const name = (row: { nameEn: string; nameAr: string }) => (locale === "ar" ? row.nameAr : row.nameEn);

  return (
    <>
      <PageHeader title={t(locale, "stock.title")} subtitle={t(locale, "stock.subtitle")} />
      {rows.length === 0 ? (
        <EmptyState title={t(locale, "stock.empty")} text={t(locale, "stock.emptyHint")} />
      ) : (
        <Card>
          <DataTable
            columns={[
              t(locale, "catalogue.code"),
              t(locale, "estimate.line.description"),
              t(locale, "stock.onHand"),
              t(locale, "stock.value"),
              t(locale, "stock.unitCost"),
            ]}
            rows={rows.map((row) => [
              <bdi key="code" dir="ltr">
                {row.code}
              </bdi>,
              <bdi key="name">{name(row)}</bdi>,
              <span key="qty" className="num">
                <bdi dir="ltr">{trim(row.qty)}</bdi>{" "}
                {row.unit ? t(locale, `catalogue.unit.${row.unit}` as MessageKey) : ""}
              </span>,
              <span key="value" className="num">
                <bdi>{formatAed(Money.parse(row.value), locale)}</bdi>
              </span>,
              <span key="unit" className="num">
                <bdi dir="ltr">{row.unitCost ?? "—"}</bdi>
              </span>,
            ])}
          />
        </Card>
      )}
      {canReceive && rows.length > 0 ? (
        <Card title={t(locale, "stock.receive")}>
          <p className="muted">{t(locale, "stock.costHint")}</p>
          <ActionForm
            locale={locale}
            action={receiveStockAction}
            hidden={{ idempotencyKey: randomUUID() }}
            submit="stock.receive"
            variant="primary"
          >
            <div className="form-grid">
              <div className="field">
                <label htmlFor="itemId">{t(locale, "stock.part")}</label>
                <select id="itemId" name="itemId" required defaultValue="">
                  <option value="" />
                  {rows
                    .filter((row) => row.active)
                    .map((row) => (
                      <option key={row.itemId} value={row.itemId}>
                        {row.code} · {name(row)}
                      </option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="qty">{t(locale, "estimate.line.qty")}</label>
                <input id="qty" name="qty" required inputMode="decimal" dir="ltr" />
              </div>
              <div className="field">
                <label htmlFor="amount">{t(locale, "stock.amount")}</label>
                <input id="amount" name="amount" required inputMode="decimal" dir="ltr" />
              </div>
              <div className="field">
                <label htmlFor="supplierName">{t(locale, "stock.supplierName")}</label>
                <input id="supplierName" name="supplierName" required dir="auto" />
              </div>
              <div className="field">
                <label htmlFor="supplierRef">{t(locale, "stock.supplierRef")}</label>
                <input id="supplierRef" name="supplierRef" required dir="ltr" />
              </div>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
