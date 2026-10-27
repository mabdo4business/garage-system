import { hasPermission } from "../auth/permissions";
import type { RepairOrderInvoiceSummary } from "../billing/queries";
import { Money } from "../core/money";
import { dashboardModeFor } from "../reporting/dashboard";

/**
 * What the workshop board offers a viewer (UI-R2, I1-10). The board page uses exactly this, so it is tested per role:
 * invoice amounts only with dashboard.money (OD-50), and each action only with the permission its server action
 * checks again.
 */
export interface BoardAccess {
  money: boolean;
  canAssign: boolean;
  can: {
    editEstimate: boolean;
    recordApproval: boolean;
    requestQc: boolean;
    decideQc: boolean;
    takePayment: boolean;
    deliver: boolean;
  };
}

export function boardAccessFor(roles: readonly string[]): BoardAccess {
  return {
    money: dashboardModeFor(roles).money,
    canAssign: hasPermission(roles, "workshop.assign"),
    can: {
      editEstimate: hasPermission(roles, "estimate.edit"),
      recordApproval: hasPermission(roles, "estimate.record_approval"),
      requestQc: hasPermission(roles, "qc.request"),
      decideQc: hasPermission(roles, "qc.decide"),
      takePayment: hasPermission(roles, "payment.record"),
      deliver: hasPermission(roles, "repair_order.deliver"),
    },
  };
}

export interface BoardInvoice {
  number: string;
  /** Whether the balance is fully paid (everyone may know; it decides what the card offers). */
  paid: boolean;
  /** The balance due, only for money holders (OD-50); null otherwise. */
  balance: string | null;
}

/** Ready cards' invoices for this viewer: the number and paid/unpaid always, the amount only for money holders. */
export function boardInvoicesFor(
  access: BoardAccess,
  invoices: readonly RepairOrderInvoiceSummary[],
): Map<string, BoardInvoice> {
  return new Map(
    invoices.map((invoice) => [
      invoice.repairOrderId,
      {
        number: invoice.number,
        paid: Money.parse(invoice.balance).isZero(),
        balance: access.money ? invoice.balance : null,
      },
    ]),
  );
}
