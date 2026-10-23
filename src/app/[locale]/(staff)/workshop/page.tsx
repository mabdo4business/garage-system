import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, EmptyState, PageHeader, PlateBadge, StatusChip } from "../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../i18n";
import { formatDubaiDateTime } from "../../../../i18n/format";
import { hasPermission } from "../../../../server/auth/permissions";
import { getDb } from "../../../../server/db/client";
import type { RepairOrderStatus } from "../../../../server/db/schema";
import { assignableStaff, workshopBoard } from "../../../../server/workshop/queries";
import { ActionForm } from "../../action-form";
import { requirePagePermission } from "../../server-support";
import { assignJobAction } from "../jobs/actions";
import { JOB_TONE } from "../jobs/shared";

export const dynamic = "force-dynamic";

const COLUMNS: RepairOrderStatus[] = [
  "checked_in",
  "diagnosing",
  "awaiting_approval",
  "in_progress",
  "qc",
  "ready",
];

/** US-07.1: open repair orders by status, with each approved job's status, assignee and bay. No prices. */
export default async function WorkshopPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "workshop.board");
  const db = getDb();
  const board = await workshopBoard(db);
  const canAssign = hasPermission(session.roles, "workshop.assign");
  const staff = canAssign ? await assignableStaff(db) : [];

  return (
    <>
      <PageHeader title={t(locale, "workshop.title")} />
      {board.length === 0 ? <EmptyState title={t(locale, "workshop.empty")} /> : null}
      <div className="board">
        {COLUMNS.map((status) => {
          const orders = board.filter(
            (order) => order.status === status || (status === "qc" && order.status === "release_check"),
          );
          if (orders.length === 0) return null;
          return (
            <section key={status} className="board-column" aria-labelledby={`col-${status}`}>
              <h2 id={`col-${status}`}>
                {t(locale, `repairOrder.status.${status}` as MessageKey)}{" "}
                <bdi dir="ltr">({orders.length})</bdi>
              </h2>
              {orders.map((order) => (
                <Card
                  key={order.id}
                  title={order.number}
                  actions={order.plate ? <PlateBadge locale={locale} plate={order.plate} /> : undefined}
                >
                  <p className="muted">
                    <bdi dir="ltr">
                      {order.make} {order.model}
                    </bdi>
                    {order.promisedAt ? (
                      <>
                        {t(locale, "common.listSeparator")}
                        {t(locale, "workshop.promised", {
                          date: formatDubaiDateTime(order.promisedAt, locale),
                        })}
                      </>
                    ) : null}
                  </p>
                  <p className="board-flags">
                    {order.flags.awaitingDecision ? (
                      <StatusChip tone="warning">{t(locale, "workshop.flag.awaitingDecision")}</StatusChip>
                    ) : null}
                    {order.flags.paused ? (
                      <StatusChip tone="warning">{t(locale, "workshop.flag.paused")}</StatusChip>
                    ) : null}
                    {order.flags.workDone ? (
                      <StatusChip tone="success">{t(locale, "workshop.flag.workDone")}</StatusChip>
                    ) : null}
                    {order.flags.anotherOpen ? (
                      <StatusChip tone="info">{t(locale, "workshop.flag.anotherOpen")}</StatusChip>
                    ) : null}
                  </p>
                  {order.jobs.length === 0 ? <p className="muted">{t(locale, "workshop.noJobs")}</p> : null}
                  <ul className="finding-list">
                    {order.jobs.map((job) => (
                      <li key={job.id} className="finding" data-job={job.id}>
                        <div className="finding-head">
                          <a href={`/${locale}/jobs/${job.id}`}>
                            <strong dir="auto">{job.title}</strong>
                          </a>
                          <StatusChip tone={JOB_TONE[job.status]}>
                            {t(locale, `job.status.${job.status}` as MessageKey)}
                          </StatusChip>
                        </div>
                        <p className="muted">
                          {t(locale, "workshop.assignee")}:{" "}
                          <bdi>{job.assigneeName ?? t(locale, "workshop.unassigned")}</bdi>
                          {job.bay ? (
                            <>
                              {t(locale, "common.listSeparator")}
                              {t(locale, "workshop.bay")}: <bdi>{job.bay}</bdi>
                            </>
                          ) : null}
                        </p>
                        {canAssign && job.status !== "done" ? (
                          <details className="disclosure">
                            <summary>
                              {t(locale, job.assigneeId ? "workshop.reassign" : "workshop.assign")}
                            </summary>
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
                                      {person.displayName} ·{" "}
                                      {t(locale, `shell.role.${person.role}` as MessageKey)}
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
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Card>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
