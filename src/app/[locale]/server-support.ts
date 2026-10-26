import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, type Locale, type MessageKey } from "../../i18n";
import { hasPermission, type Permission } from "../../server/auth/permissions";
import { authorize } from "../../server/auth/service";
import { SESSION_COOKIE, validateSession, type SessionUser } from "../../server/auth/session";
import { DomainError, ForbiddenError } from "../../server/core/errors";
import { getDb } from "../../server/db/client";
import type { FormError } from "./form-state";

/** Server-only helpers shared by the staff pages and their server actions. */

async function currentSession(): Promise<SessionUser | null> {
  return validateSession(getDb(), (await cookies()).get(SESSION_COOKIE)?.value);
}

/** For pages every signed-in user may see (Today): no session → sign-in page. */
export async function requirePageSession(locale: Locale): Promise<SessionUser> {
  const session = await currentSession();
  if (!session) redirect(`/${locale}/login`);
  return session;
}

/**
 * Pages check the permission on the server like every handler (rule 8): no session → sign-in page;
 * missing permission → audited denial (authorize) and a not-found page, so the page does not
 * confirm that the record exists.
 */
export async function requirePagePermission(
  locale: Locale,
  permission: Permission,
  target?: { entityType: string; entityId: string },
  /** A second permission that also opens the page (checked instead when the viewer holds it). */
  alternative?: Permission,
): Promise<SessionUser> {
  const session = await currentSession();
  if (!session) redirect(`/${locale}/login`);
  const required = alternative && hasPermission(session.roles, alternative) ? alternative : permission;
  try {
    return await authorize(getDb(), session, required, target);
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
}

/** For server actions: throws UnauthenticatedError / ForbiddenError, which errorFrom translates. */
export async function requireActionPermission(
  permission: Permission,
  alternative?: Permission,
): Promise<SessionUser> {
  const session = await currentSession();
  // As requirePagePermission: the alternative is checked instead when the user holds it.
  const required =
    alternative && session && hasPermission(session.roles, alternative) ? alternative : permission;
  return authorize(getDb(), session, required);
}

export function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export function localeOf(formData: FormData): Locale {
  const raw = field(formData, "locale");
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

export function valuesOf(formData: FormData, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, field(formData, key)]));
}

const ERROR_KEYS: Record<string, MessageKey> = {
  validation_failed: "error.validationFailed",
  not_found: "error.notFound",
  plate_already_active: "error.plateAlreadyActive",
  try_again: "error.tryAgain",
  idempotency_payload_mismatch: "error.formReused",
  forbidden: "error.forbidden",
  unauthenticated: "error.signedOut",
  check_in_closed: "error.checkInClosed",
  owner_changed: "error.ownerChanged",
  inspection_closed: "error.inspectionClosed",
  already_assigned: "error.alreadyAssigned",
  finding_withdrawn: "error.findingWithdrawn",
  item_already_recorded: "error.itemAlreadyRecorded",
  item_code_taken: "error.itemCodeTaken",
  tax_code_exists: "error.taxCodeExists",
  tax_date_not_after_latest: "error.taxDateNotAfterLatest",
  photo_not_discardable: "error.photoLocked",
  photo_not_locked: "error.photoNotLocked",
  photo_already_excluded: "error.photoAlreadyExcluded",
  estimate_closed: "error.estimateClosed",
  estimate_exists: "error.estimateExists",
  no_draft: "error.noDraft",
  no_tax_profile: "error.noTaxProfile",
  no_tax_rate: "error.noTaxRate",
  finding_already_included: "error.findingAlreadyIncluded",
  finding_already_excluded: "error.findingAlreadyExcluded",
  finding_in_estimate: "error.findingInEstimate",
  estimate_empty: "error.estimateEmpty",
  job_without_lines: "error.jobWithoutLines",
  urgent_finding_open: "error.urgentFindingOpen",
  tax_rate_changed: "error.taxRateChanged",
  estimate_not_sent: "error.estimateNotSent",
  estimate_expired: "error.estimateExpired",
  estimate_changed: "error.estimateChanged",
  revision_not_pending: "error.revisionNotPending",
  open_repair_order_exists: "error.openRepairOrderExists",
  open_repair_order_gone: "error.openRepairOrderGone",
  job_not_assignable: "error.jobNotAssignable",
  job_not_authorized: "error.jobNotAuthorized",
  repair_order_not_in_progress: "error.repairOrderNotInProgress",
  not_assignee: "error.notAssignee",
  job_status_changed: "error.jobStatusChanged",
  not_stock_tracked: "error.notStockTracked",
  line_not_issuable: "error.lineNotIssuable",
  insufficient_stock: "error.insufficientStock",
  item_inactive: "error.itemInactive",
  decision_pending: "error.decisionPending",
  work_not_finished: "error.workNotFinished",
  qc_not_pending: "error.qcNotPending",
  qc_self_check: "error.qcSelfCheck",
  qc_not_passed: "error.qcNotPassed",
  nothing_to_invoice: "error.nothingToInvoice",
  draft_closed: "error.draftClosed",
  invoice_cap: "error.invoiceCap",
  parts_not_issued: "error.partsNotIssued",
};

/**
 * Turns a domain error into a translated form error (I1-01 review finding 12). Anything else —
 * including Next's redirect/notFound signals — is rethrown untouched.
 */
export function errorFrom(error: unknown): FormError {
  if (!(error instanceof DomainError)) throw error;
  const key = ERROR_KEYS[error.code];
  if (!key) throw error;
  const fieldName = error.details?.field;
  const version = error.details?.version;
  const params = typeof version === "string" ? { version } : undefined;
  return {
    key,
    ...(typeof fieldName === "string" ? { field: fieldName } : {}),
    ...(params ? { params } : {}),
  };
}
