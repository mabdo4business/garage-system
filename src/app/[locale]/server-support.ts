import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, type Locale, type MessageKey } from "../../i18n";
import type { Permission } from "../../server/auth/permissions";
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
): Promise<SessionUser> {
  const session = await currentSession();
  if (!session) redirect(`/${locale}/login`);
  try {
    return await authorize(getDb(), session, permission, target);
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
}

/** For server actions: throws UnauthenticatedError / ForbiddenError, which errorFrom translates. */
export async function requireActionPermission(permission: Permission): Promise<SessionUser> {
  return authorize(getDb(), await currentSession(), permission);
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
  return typeof fieldName === "string" ? { key, field: fieldName } : { key };
}
