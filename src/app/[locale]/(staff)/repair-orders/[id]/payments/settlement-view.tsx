import type { ReactNode } from "react";
import { Card, StatusChip } from "../../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../../i18n";
import { formatAed, formatDubaiDateTime } from "../../../../../../i18n/format";
import type { Settlement } from "../../../../../../server/billing/payments";
import { Money } from "../../../../../../server/core/money";
import type { OldPartsDisposition, RepairOrderStatus } from "../../../../../../server/db/schema";

const aed = (amount: string, locale: Locale) => <bdi dir="ltr">{formatAed(Money.parse(amount), locale)}</bdi>;
/** An amount inside a sentence, isolated left-to-right (FSI … PDI). */
const inline = (amount: string, locale: Locale) => `⁨${formatAed(Money.parse(amount), locale)}⁩`;

/**
 * Payments and handover on the repair order (I1-10): the invoice total, what was paid and the balance due; the payment
 * form while a balance is due; the handover with the keys and belongings checklist (OD-54) and, for reference, the old
 * parts and odometer out from the QC pass. A balance due locks the handover and says why, unless the viewer may
 * release with a balance (partners, OD-53), who then must give a reason (AC2-27).
 */
export function SettlementView({
  locale,
  settlement,
  status,
  qc,
  can,
  renderPaymentForm,
  renderDeliverForm,
}: {
  locale: Locale;
  settlement: Settlement;
  status: RepairOrderStatus;
  qc: { oldParts: OldPartsDisposition | null; odometerOutKm: number | null } | null;
  can: { pay: boolean; deliver: boolean; releaseWithBalance: boolean };
  renderPaymentForm: () => ReactNode;
  renderDeliverForm: (override: boolean) => ReactNode;
}) {
  const balance = Money.parse(settlement.balance);
  const due = !balance.isZero();
  const payable = status === "ready" || status === "delivered";

  return (
    <Card title={t(locale, "payment.title")}>
      <div id="payments" className="settlement">
        <dl className="detail-list">
          <dt>{t(locale, "payment.total")}</dt>
          <dd className="num">
            <bdi dir="ltr">{settlement.invoice.number}</bdi> · {aed(settlement.invoice.total, locale)}
          </dd>
          <dt>{t(locale, "payment.paid")}</dt>
          <dd className="num">{aed(settlement.paid, locale)}</dd>
          <dt>
            <strong>{t(locale, "payment.balance")}</strong>
          </dt>
          <dd className="num">
            {due ? (
              <strong>{aed(settlement.balance, locale)}</strong>
            ) : (
              <StatusChip status="ready">{t(locale, "payment.paidInFull")}</StatusChip>
            )}
          </dd>
        </dl>

        {settlement.payments.length === 0 ? (
          <p className="muted">{t(locale, "payment.none")}</p>
        ) : (
          <ul className="result-list payment-list">
            {settlement.payments.map((payment) => (
              <li key={payment.id}>
                <span>
                  <strong>{aed(payment.amount, locale)}</strong>
                  {t(locale, "common.listSeparator")}
                  {t(locale, `payment.method.${payment.method}` as MessageKey)}
                  {payment.reference ? (
                    <>
                      {t(locale, "common.listSeparator")}
                      <bdi dir="ltr">{payment.reference}</bdi>
                    </>
                  ) : null}
                </span>
                <span className="meta">
                  {t(locale, "payment.by", {
                    name: payment.recordedByName ?? "—",
                    when: formatDubaiDateTime(payment.recordedAt, locale),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}

        {can.pay && payable && due ? renderPaymentForm() : null}

        <section className="handover" aria-labelledby="handover-title">
          <h3 id="handover-title">{t(locale, "delivery.title")}</h3>
          {qc ? (
            <dl className="detail-list">
              {qc.oldParts ? (
                <>
                  <dt>{t(locale, "qc.oldParts")}</dt>
                  <dd>{t(locale, `qc.oldParts.${qc.oldParts}` as MessageKey)}</dd>
                </>
              ) : null}
              {qc.odometerOutKm !== null ? (
                <>
                  <dt>{t(locale, "qc.odometerOut")}</dt>
                  <dd>
                    <bdi dir="ltr">{qc.odometerOutKm}</bdi>
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {settlement.delivery ? (
            <>
              <p>
                {t(locale, "delivery.done", {
                  when: formatDubaiDateTime(settlement.delivery.deliveredAt, locale),
                  name: settlement.delivery.deliveredByName ?? "—",
                })}
              </p>
              {settlement.delivery.overrideReason ? (
                <p className="board-stop">
                  {t(locale, "delivery.doneOverride", {
                    amount: inline(settlement.delivery.balanceDue, locale),
                    reason: settlement.delivery.overrideReason,
                  })}
                </p>
              ) : null}
            </>
          ) : status !== "ready" ? (
            <p className="muted">{t(locale, "delivery.notReady")}</p>
          ) : !can.deliver ? null : !due ? (
            renderDeliverForm(false)
          ) : can.releaseWithBalance ? (
            <>
              <button type="button" className="board-locked" disabled>
                {t(locale, "delivery.locked", { amount: inline(settlement.balance, locale) })}
              </button>
              {renderDeliverForm(true)}
            </>
          ) : (
            <>
              <button type="button" className="board-locked" disabled>
                {t(locale, "delivery.locked", { amount: inline(settlement.balance, locale) })}
              </button>
              <p className="muted">{t(locale, "delivery.lockedWhy")}</p>
            </>
          )}
        </section>
      </div>
    </Card>
  );
}
