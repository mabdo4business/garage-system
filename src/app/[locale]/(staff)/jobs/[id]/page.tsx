import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { BayClock } from "../../../../../components/bay/bay-clock";
import { isLocale, t } from "../../../../../i18n";
import { dubaiDate, formatDubaiTime } from "../../../../../i18n/format";
import { hasPermission } from "../../../../../server/auth/permissions";
import { NotFoundError } from "../../../../../server/core/errors";
import { getDb } from "../../../../../server/db/client";
import { qcView } from "../../../../../server/quality/queries";
import { requireJobAccess } from "../../../../../server/workshop/commands";
import { jobCard, myJobs, workedSeconds } from "../../../../../server/workshop/queries";
import { ActionForm } from "../../../action-form";
import { requirePagePermission } from "../../../server-support";
import { requestQcAction } from "../../repair-orders/[id]/qc/actions";
import { waitingPartsAction } from "../../stock/actions";
import { completeJobAction, pauseJobAction, resumeJobAction, startJobAction } from "../actions";
import { BayView } from "./bay-view";

export const dynamic = "force-dynamic";

/**
 * The job card as the technician's bay screen (US-07.3/07.4; redesign UI-R3): what to do on which car — never what it
 * costs (AC2-30). Front-office staff open the same screen from the board, read-only.
 */
export default async function JobPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(
    locale,
    // Front-office staff read job cards from the board; assignees from My jobs.
    "workshop.my_jobs",
    { entityType: "repair_job", entityId: id },
    "workshop.board",
  );
  const db = getDb();
  try {
    await requireJobAccess(db, session, id); // AC2-30: not found (and logged) for anyone else
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const job = await jobCard(db, id);
  if (!job) notFound();
  const mine = job.assigneeId === session.userId && hasPermission(session.roles, "workshop.my_jobs");
  const now = new Date();
  const qc = mine && job.status === "done" ? await qcView(db, job.repairOrderId) : null;
  const hidden = () => ({ jobId: job.id, idempotencyKey: randomUUID() });
  const queue = mine ? (await myJobs(db, session.userId)).filter((other) => other.id !== job.id) : [];

  return (
    <BayView
      locale={locale}
      job={job}
      mine={mine}
      queue={queue}
      worked={workedSeconds(
        job.history.map((event) => ({ to: event.to, at: event.at })),
        now,
      )}
      businessDate={dubaiDate(now)}
      clock={<BayClock locale={locale} initial={formatDubaiTime(now, locale)} />}
      canRequestQc={qc !== null && qc.blocker === null && hasPermission(session.roles, "qc.request")}
      completeAction={completeJobAction}
      completeHidden={hidden()}
      forms={{
        start: () => (
          <ActionForm
            locale={locale}
            action={startJobAction}
            hidden={hidden()}
            submit="job.start"
            variant="primary"
            className="form bay-form-inline"
          />
        ),
        waitingParts: () => (
          <ActionForm
            locale={locale}
            action={waitingPartsAction}
            hidden={{ ...hidden(), back: "job" }}
            submit="parts.markWaiting"
            variant="quiet"
            className="form bay-form-inline"
          />
        ),
        resume: () => (
          <ActionForm
            locale={locale}
            action={resumeJobAction}
            hidden={hidden()}
            submit="job.resume"
            variant="primary"
            className="form bay-form-inline"
          />
        ),
        pause: () => (
          <details className="disclosure bay-pause">
            <summary>{t(locale, "job.pause")}</summary>
            <ActionForm locale={locale} action={pauseJobAction} hidden={hidden()} submit="job.pause">
              <div className="field">
                <label htmlFor="pauseReason">{t(locale, "job.pauseReason")}</label>
                <input id="pauseReason" name="pauseReason" required dir="auto" />
              </div>
            </ActionForm>
          </details>
        ),
        requestQc: () => (
          <ActionForm
            locale={locale}
            action={requestQcAction}
            hidden={{
              repairOrderId: job.repairOrderId,
              idempotencyKey: randomUUID(),
              back: `/jobs/${job.id}`,
            }}
            submit="qc.request"
            variant="primary"
            className="form bay-form-inline"
          />
        ),
      }}
    />
  );
}
