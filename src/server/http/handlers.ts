import type { Kysely } from "kysely";
import { DomainError } from "../core/errors";
import { logger } from "../core/logger";
import { authorize, deactivateUser, login, logout } from "../auth/service";
import { SESSION_COOKIE, sessionPolicy, validateSession, type SessionUser } from "../auth/session";
import type { DB } from "../db/schema";
import { createTestDocument, issueTestDocument } from "../test-document/service";
import { isLocale, DEFAULT_LOCALE } from "../../i18n";

/**
 * HTTP handlers, independent of Next.js. Next route files only forward requests here, so the
 * same code is exercised by tests that call these functions directly with Request objects —
 * i.e. "calling the endpoint directly" without the UI.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_BY_CODE: Record<string, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  idempotency_payload_mismatch: 409,
  document_already_issued: 409,
  username_taken: 409,
  try_again: 503,
};

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}

function errorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    const status = STATUS_BY_CODE[error.code] ?? 400;
    return json(status, { error: error.code, message: error.message });
  }
  logger.error("http.unhandled_error", { error });
  return json(500, { error: "internal_error" });
}

/** Rejects cross-site state-changing requests whose Origin does not match the Host. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser clients; cookies are SameSite=Lax
  const host = request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  }
  const form = await request.formData();
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

export function createHandlers(db: Kysely<DB>) {
  async function currentSession(request: Request): Promise<SessionUser | null> {
    return validateSession(db, readCookie(request, SESSION_COOKIE));
  }

  return {
    currentSession,

    /** POST /api/auth/login — HTML form or JSON. Redirects back to the login page on failure. */
    async login(request: Request): Promise<Response> {
      if (!sameOrigin(request)) return json(403, { error: "forbidden" });
      const body = await readBody(request);
      const locale = typeof body.locale === "string" && isLocale(body.locale) ? body.locale : DEFAULT_LOCALE;
      const result = await login(db, body.username, body.password);
      if (!result.ok) {
        return redirect(`/${locale}/login?error=1`);
      }
      const maxAge = sessionPolicy().absoluteHours * 3600;
      return redirect(`/${locale}`, { "set-cookie": sessionCookie(result.token, maxAge) });
    },

    /** POST /api/auth/logout */
    async logout(request: Request): Promise<Response> {
      if (!sameOrigin(request)) return json(403, { error: "forbidden" });
      const body = await readBody(request).catch(() => ({}) as Record<string, unknown>);
      const locale = typeof body.locale === "string" && isLocale(body.locale) ? body.locale : DEFAULT_LOCALE;
      await logout(db, readCookie(request, SESSION_COOKIE));
      return redirect(`/${locale}/login`, { "set-cookie": sessionCookie("", 0) });
    },

    /** POST /api/test-documents — JSON { title, amount, idempotencyKey } */
    async createTestDocument(request: Request): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "test_document.create");
        const body = await readBody(request);
        const outcome = await createTestDocument(
          db,
          { kind: "user", userId: session.userId },
          { title: String(body.title ?? ""), amount: body.amount as string },
          String(body.idempotencyKey ?? ""),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/test-documents/:id/issue — JSON { idempotencyKey } */
    async issueTestDocument(request: Request, documentId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "test_document.issue", {
          entityType: "test_document",
          entityId: documentId,
        });
        if (!UUID.test(documentId)) return json(404, { error: "not_found" });
        const body = await readBody(request);
        const outcome = await issueTestDocument(
          db,
          { kind: "user", userId: session.userId },
          documentId,
          String(body.idempotencyKey ?? ""),
        );
        return json(200, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/users/:id/deactivate */
    async deactivateUser(request: Request, userId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "user.deactivate", {
          entityType: "app_user",
          entityId: userId,
        });
        if (!UUID.test(userId)) return json(404, { error: "not_found" });
        await deactivateUser(db, session, userId);
        return json(200, { ok: true });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
