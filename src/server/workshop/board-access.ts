import { hasPermission } from "../auth/permissions";
import type { RepairOrderInvoiceSummary } from "../billing/queries";
import { dashboardModeFor } from "../reporting/dashboard";

/**
 * What the workshop board offers a viewer (UI-R2). The board page uses exactly this, so it is tested per role:
 * invoice amounts only with dashboard.money (OD-50), and each one-step action only with the permission its server
 * action checks again.
 */
export interface BoardAccess {
  money: boolean;
  canAssign: boolean;
  can: { editEstimate: boolean; recordApproval: boolean; requestQc: boolean; decideQc: boolean };
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
    },
  };
}

/** Ready cards' invoices for this viewer: the number always, the total only for money holders. */
export function boardInvoicesFor(
  access: BoardAccess,
  invoices: readonly RepairOrderInvoiceSummary[],
): Map<string, { number: string; total: string | null }> {
  return new Map(
    invoices.map((invoice) => [
      invoice.repairOrderId,
      { number: invoice.number, total: access.money ? invoice.total : null },
    ]),
  );
}
