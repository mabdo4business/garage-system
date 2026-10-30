"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { MessageKey } from "../../../../i18n";
import { DomainError, ValidationError } from "../../../../server/core/errors";
import { getDb } from "../../../../server/db/client";
import { recordLinkApproval, type LinkApprovalOutcome } from "../../../../server/links/approval";
import { requesterFrom } from "../../../../server/links/customer";
import { field, localeOf } from "../../server-support";

/** The customer's form: values come back in this state, never in the address (it is in the customer's history). */
export interface LinkDecisionState {
  seq: number;
  values: Record<string, string>;
  error?: MessageKey;
  /** The link stopped working (or this IP is resting): shown where the form was, without loading the page again. */
  page?: "invalid" | "blocked";
}

const DECISION_PREFIX = "decision.";

/** Messages for the only refusals a customer can fix on the form. */
const ERROR_BY_FIELD: Record<string, MessageKey> = {
  approverName: "link.form.nameRequired",
  decisions: "link.form.chooseOne",
};

/**
 * Records the customer's decision through the link (I2-03b, T-44). A recorded decision, "updated" and "already
 * decided" return to the link page, which shows what is true now. An invalid link or a resting IP is shown in place
 * of the form instead: loading the page again would count the same attempt twice (AC2-05, T-42).
 */
export async function submitLinkDecision(
  previous: LinkDecisionState,
  formData: FormData,
): Promise<LinkDecisionState> {
  const locale = localeOf(formData);
  const token = field(formData, "token");
  const values: Record<string, string> = { approverName: field(formData, "approverName") };
  const decisions: { revisionId: string; decision: string }[] = [];
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith(DECISION_PREFIX) || typeof value !== "string") continue;
    values[name] = value;
    // "Later" leaves the job pending (T-22).
    if (value) decisions.push({ revisionId: name.slice(DECISION_PREFIX.length), decision: value });
  }
  const next = (state: Omit<LinkDecisionState, "seq" | "values">): LinkDecisionState => ({
    seq: previous.seq + 1,
    values,
    ...state,
  });
  let outcome: LinkApprovalOutcome;
  try {
    outcome = await recordLinkApproval(
      getDb(),
      token,
      { approverName: values.approverName, decisions, language: locale },
      requesterFrom(await headers()),
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return next({ error: ERROR_BY_FIELD[String(error.details?.field ?? "")] ?? "link.form.reload" });
    }
    // The garage is busy with this repair order (lock timeout): nothing was recorded, the same form can be sent again.
    if (error instanceof DomainError && error.code === "try_again")
      return next({ error: "link.form.tryAgain" });
    throw error;
  }
  if (outcome.kind === "refused" && (outcome.page === "invalid" || outcome.page === "blocked")) {
    return next({ page: outcome.page });
  }
  redirect(`/${locale}/c/${token}${outcome.kind === "recorded" ? "?done=1" : ""}`);
}
