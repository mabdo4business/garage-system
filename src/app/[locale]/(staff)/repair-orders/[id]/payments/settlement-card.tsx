import { randomUUID } from "node:crypto";
import { t, type Locale } from "../../../../../../i18n";
import { hasPermission } from "../../../../../../server/auth/permissions";
import { settlementOf } from "../../../../../../server/billing/payments";
import { getDb } from "../../../../../../server/db/client";
import type { OldPartsDisposition, RepairOrderStatus } from "../../../../../../server/db/schema";
import { ActionForm } from "../../../../action-form";
import { deliverAction, recordPaymentAction } from "./actions";
import { PaymentForm } from "./payment-form";
import { SettlementView } from "./settlement-view";

/** The repair order's payments and handover (I1-10), wired to the server actions. Nothing before an invoice exists. */
export async function SettlementCard({
  locale,
  repairOrderId,
  status,
  roles,
  qc,
}: {
  locale: Locale;
  repairOrderId: string;
  status: RepairOrderStatus;
  roles: readonly string[];
  qc: { oldParts: OldPartsDisposition | null; odometerOutKm: number | null } | null;
}) {
  const settlement = await settlementOf(getDb(), repairOrderId);
  if (!settlement) return null;
  return (
    <SettlementView
      locale={locale}
      settlement={settlement}
      status={status}
      qc={qc}
      can={{
        pay: hasPermission(roles, "payment.record"),
        deliver: hasPermission(roles, "repair_order.deliver"),
        releaseWithBalance: hasPermission(roles, "repair_order.release_with_balance"),
      }}
      renderPaymentForm={() => (
        <PaymentForm
          locale={locale}
          action={recordPaymentAction}
          invoiceId={settlement.invoice.id}
          repairOrderId={repairOrderId}
          balance={settlement.balance}
          idempotencyKey={randomUUID()}
        />
      )}
      renderDeliverForm={(override) => (
        <ActionForm
          locale={locale}
          action={deliverAction}
          hidden={{ repairOrderId, idempotencyKey: randomUUID() }}
          submit={override ? "delivery.release" : "delivery.deliver"}
          variant="primary"
        >
          <label className="checkbox">
            <input type="checkbox" name="keysReturned" value="true" required />
            <span>{t(locale, "delivery.keys")}</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" name="belongingsReturned" value="true" required />
            <span>{t(locale, "delivery.belongings")}</span>
          </label>
          {override ? (
            <div className="field">
              <label htmlFor={`override-${repairOrderId}`}>{t(locale, "delivery.overrideReason")}</label>
              <textarea id={`override-${repairOrderId}`} name="overrideReason" required maxLength={500} />
              <span className="hint">{t(locale, "delivery.overrideHint")}</span>
            </div>
          ) : null}
        </ActionForm>
      )}
    />
  );
}
