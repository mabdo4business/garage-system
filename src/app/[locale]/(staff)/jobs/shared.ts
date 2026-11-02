import type { JobExecutionStatus } from "../../../../server/db/schema";

/** Chip tone per job execution status (board and job screens). */
export const JOB_TONE: Record<JobExecutionStatus, "info" | "neutral" | "warning" | "success" | "danger"> = {
  not_authorized: "neutral",
  authorized: "info",
  waiting_parts: "warning",
  in_progress: "warning",
  paused: "danger",
  done: "success",
  stopped_by_customer: "neutral",
  cancelled: "neutral",
};
