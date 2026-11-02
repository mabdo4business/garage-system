import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { LiveRefresh } from "../../../../components/dashboard/motion";
import { isLocale, t, type MessageKey } from "../../../../i18n";
import { dubaiDate, formatDubaiTime } from "../../../../i18n/format";
import { invoicesForRepairOrders } from "../../../../server/billing/queries";
import { getDb } from "../../../../server/db/client";
import { boardAccessFor, boardInvoicesFor } from "../../../../server/workshop/board-access";
import { assignableStaff, workshopBoard } from "../../../../server/workshop/queries";
import { ActionForm } from "../../action-form";
import { requirePagePermission } from "../../server-support";
import { assignJobAction } from "../jobs/actions";
import { requestQcAction } from "../repair-orders/[id]/qc/actions";
import { BoardView } from "./board-view";

export const dynamic = "force-dynamic";

/** US-07.1 workshop board (UI-R2). Amounts appear only on Ready cards and only for dashboard.money holders (OD-50). */
export default async function WorkshopPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "workshop.board");
  const db = getDb();
  const now = new Date();
  const board = await workshopBoard(db);
  const access = boardAccessFor(session.roles);
  const staff = access.canAssign ? await assignableStaff(db) : [];
  const ready = board.filter((order) => order.status === "ready").map((order) => order.id);
  const invoices = boardInvoicesFor(access, await invoicesForRepairOrders(db, ready));

  return (
    <BoardView
      locale={locale}
      board={board}
      invoices={invoices}
      now={now}
      businessDate={dubaiDate(now)}
      can={access.can}
      viewerId={session.userId}
      live={<LiveRefresh locale={locale} renderedAt={formatDubaiTime(now, locale)} />}
      renderRequestQc={(order) => (
        <ActionForm
          locale={locale}
          action={requestQcAction}
          hidden={{ repairOrderId: order.id, idempotencyKey: randomUUID(), back: "/workshop" }}
          submit="board.action.requestQc"
          variant="primary"
          className="form board-form"
        />
      )}
      renderAssign={
        access.canAssign
          ? (job) => (
              <details className="disclosure">
                <summary>{t(locale, job.assigneeId ? "workshop.reassign" : "workshop.assign")}</summary>
                <ActionForm
                  locale={locale}
                  action={assignJobAction}
                  hidden={{ jobId: job.id, idempotencyKey: randomUUID() }}
                  submit="workshop.assign"
                >
                  <div className="field">
                    <label htmlFor={`assignee-${job.id}`}>{t(locale, "workshop.assignee")}</label>
                    <select
                      id={`assignee-${job.id}`}
                      name="assigneeId"
                      required
                      defaultValue={job.assigneeId ?? ""}
                    >
                      <option value="" />
                      {staff.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.displayName} · {t(locale, `shell.role.${person.role}` as MessageKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`bay-${job.id}`}>
                      {t(locale, "workshop.bay")}{" "}
                      <span className="optional">{t(locale, "common.optional")}</span>
                    </label>
                    <input
                      id={`bay-${job.id}`}
                      name="bay"
                      defaultValue={job.bay ?? ""}
                      maxLength={20}
                      dir="auto"
                    />
                  </div>
                </ActionForm>
              </details>
            )
          : undefined
      }
    />
  );
}
