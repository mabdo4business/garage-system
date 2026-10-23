"use server";

import { redirect } from "next/navigation";
import { getDb } from "../../../../server/db/client";
import { assignJob, completeJob, pauseJob, resumeJob, startJob } from "../../../../server/workshop/commands";
import type { FormState } from "../../form-state";
import { errorFrom, field, localeOf, requireActionPermission } from "../../server-support";

/** Workshop actions (I1-06). Each re-checks the permission; the commands check the assignee and the job's state. */

async function run(
  previous: FormState,
  formData: FormData,
  back: (locale: string) => string,
  step: () => Promise<unknown>,
): Promise<FormState> {
  const locale = localeOf(formData);
  try {
    await step();
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(back(locale));
}

const jobUrl = (formData: FormData) => (locale: string) => `/${locale}/jobs/${field(formData, "jobId")}`;

export async function assignJobAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(
    previous,
    formData,
    (locale) => `/${locale}/workshop`,
    async () => {
      const session = await requireActionPermission("workshop.assign");
      await assignJob(
        getDb(),
        session,
        field(formData, "jobId"),
        { assigneeId: field(formData, "assigneeId"), bay: field(formData, "bay") },
        field(formData, "idempotencyKey"),
      );
    },
  );
}

export async function startJobAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, jobUrl(formData), async () => {
    const session = await requireActionPermission("workshop.my_jobs");
    await startJob(getDb(), session, field(formData, "jobId"), field(formData, "idempotencyKey"));
  });
}

export async function pauseJobAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, jobUrl(formData), async () => {
    const session = await requireActionPermission("workshop.my_jobs");
    await pauseJob(
      getDb(),
      session,
      field(formData, "jobId"),
      { reason: field(formData, "pauseReason") },
      field(formData, "idempotencyKey"),
    );
  });
}

export async function resumeJobAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, jobUrl(formData), async () => {
    const session = await requireActionPermission("workshop.my_jobs");
    await resumeJob(getDb(), session, field(formData, "jobId"), field(formData, "idempotencyKey"));
  });
}

/** Lines arrive as outcome.<lineId> = done | not_performed and reason.<lineId>. */
export async function completeJobAction(previous: FormState, formData: FormData): Promise<FormState> {
  return run(previous, formData, jobUrl(formData), async () => {
    const session = await requireActionPermission("workshop.my_jobs");
    const lines = [...formData.keys()]
      .filter((key) => key.startsWith("outcome."))
      .map((key) => {
        const lineId = key.slice("outcome.".length);
        return { lineId, outcome: field(formData, key), reason: field(formData, `reason.${lineId}`) };
      });
    await completeJob(
      getDb(),
      session,
      field(formData, "jobId"),
      { lines, note: field(formData, "note") },
      field(formData, "idempotencyKey"),
    );
  });
}
