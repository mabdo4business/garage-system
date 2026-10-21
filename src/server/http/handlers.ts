import type { Kysely } from "kysely";
import { DomainError } from "../core/errors";
import { isUuid } from "../core/ids";
import { idempotencyKeyUsed } from "../command/runner";
import { logger } from "../core/logger";
import { authorize, deactivateUser, login, logout } from "../auth/service";
import { SESSION_COOKIE, sessionPolicy, validateSession, type SessionUser } from "../auth/session";
import type { DB } from "../db/schema";
import { createTestDocument, issueTestDocument } from "../test-document/service";
import {
  createCustomer,
  findDuplicateCustomersByMobile,
  getCustomer,
  type CustomerInput,
} from "../customer/service";
import { searchDirectory } from "../directory/service";
import { getMediaStorage, type MediaStorage } from "../media/storage";
import {
  addCheckInPhoto,
  checkInFieldsFrom,
  getCheckInSettings,
  completeCheckIn,
  excludePhoto,
  startCheckIn,
  updateCheckIn,
} from "../repair-order/check-in";
import { getPhotoFile, getRepairOrder } from "../repair-order/queries";
import {
  changePlate,
  createVehicle,
  duplicateConfirmKey,
  findDuplicateVehicles,
  getVehicle,
  transferOwnership,
  type VehicleInput,
} from "../vehicle/service";
import { isLocale, DEFAULT_LOCALE } from "../../i18n";

/**
 * HTTP handlers, independent of Next.js. Next route files only forward requests here, so the
 * same code is exercised by tests that call these functions directly with Request objects —
 * i.e. "calling the endpoint directly" without the UI.
 */

const STATUS_BY_CODE: Record<string, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  idempotency_payload_mismatch: 409,
  document_already_issued: 409,
  username_taken: 409,
  plate_already_active: 409,
  check_in_closed: 409,
  owner_changed: 409,
  photo_not_discardable: 409,
  photo_not_locked: 409,
  photo_already_excluded: 409,
  try_again: 503,
};

function toBool(value: unknown): boolean {
  return value === true || value === "true" || value === "on" || value === "1";
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

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

function plateFrom(body: Record<string, unknown>): VehicleInput["plate"] {
  return {
    emirate: toStr(body.plateEmirate) as VehicleInput["plate"]["emirate"],
    code: toStr(body.plateCode),
    number: toStr(body.plateNumber),
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    const status = STATUS_BY_CODE[error.code] ?? 400;
    // Only the field name and a fixed reason code leave the server: details may carry ids or other
    // internal context.
    const field = error.details?.field;
    const reason = error.details?.reason;
    const details = {
      ...(typeof field === "string" ? { field } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
    };
    return json(status, {
      error: error.code,
      message: error.message,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    });
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

/**
 * The request body, or null once it exceeds `limit` bytes: a declared Content-Length over the limit is
 * refused without reading, and an undeclared or chunked body is counted while it streams.
 */
async function readLimited(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

export function createHandlers(db: Kysely<DB>, storage: MediaStorage = getMediaStorage()) {
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
        if (!isUuid(documentId)) return json(404, { error: "not_found" });
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
        if (!isUuid(userId)) return json(404, { error: "not_found" });
        await deactivateUser(db, session, userId);
        return json(200, { ok: true });
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** GET /api/search?q=… — the one search box (plate/mobile/name/VIN). */
    async search(request: Request): Promise<Response> {
      try {
        const session = await authorize(db, await currentSession(request), "directory.search");
        const q = new URL(request.url).searchParams.get("q") ?? "";
        const result = await searchDirectory(db, session.roles, q);
        return json(200, result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/customers — JSON/form { nameEn?, nameAr?, mobile, email?, preferredLanguage,
     * marketingConsent?, confirmDuplicate?, idempotencyKey }. Warns on duplicate mobile (AC-02.4)
     * unless confirmDuplicate is set. A retry with an already-used key skips the warning so the
     * original result is replayed. */
    async createCustomer(request: Request): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "customer.write");
        const body = await readBody(request);
        const idempotencyKey = toStr(body.idempotencyKey);
        const input: CustomerInput = {
          nameEn: toStr(body.nameEn) || null,
          nameAr: toStr(body.nameAr) || null,
          mobile: toStr(body.mobile),
          email: toStr(body.email) || null,
          preferredLanguage: toStr(body.preferredLanguage) === "ar" ? "ar" : "en",
          marketingConsent: toBool(body.marketingConsent),
        };
        if (
          !toBool(body.confirmDuplicate) &&
          !(await idempotencyKeyUsed(db, "customer.create", idempotencyKey))
        ) {
          const duplicates = await findDuplicateCustomersByMobile(db, input.mobile);
          if (duplicates.length > 0) {
            return json(200, { status: "duplicate" as const, matches: duplicates });
          }
        }
        const outcome = await createCustomer(
          db,
          { kind: "user", userId: session.userId },
          input,
          idempotencyKey,
        );
        return json(outcome.replayed ? 200 : 201, { status: "created" as const, ...outcome.result });
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** GET /api/customers/:id — mobile/email omitted unless the viewer has customer.read_contact. */
    async getCustomer(request: Request, customerId: string): Promise<Response> {
      try {
        const session = await authorize(db, await currentSession(request), "customer.read", {
          entityType: "customer",
          entityId: customerId,
        });
        if (!isUuid(customerId)) return json(404, { error: "not_found" });
        const profile = await getCustomer(db, session.roles, customerId);
        if (!profile) return json(404, { error: "not_found" });
        return json(200, profile);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/vehicles — JSON/form vehicle fields + plate parts + ownerCustomerId. Warns on
     * duplicate VIN or a plate active/previously active on a different vehicle; confirming moves a
     * still-active plate to the new vehicle (OD-1). Confirming means sending back the
     * `confirmFor` key from the warning; it only counts for the same VIN and plate. */
    async createVehicle(request: Request): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "vehicle.write");
        const body = await readBody(request);
        const idempotencyKey = toStr(body.idempotencyKey);
        const plate = plateFrom(body);
        const input: VehicleInput = {
          vin: toStr(body.vin) || null,
          make: toStr(body.make),
          model: toStr(body.model),
          year: Number(body.year),
          colour: toStr(body.colour) || null,
          plate,
          ownerCustomerId: toStr(body.ownerCustomerId),
        };
        const confirmFor = duplicateConfirmKey({ vin: input.vin, plate });
        const confirmed = toStr(body.confirmFor) === confirmFor;
        if (!confirmed && !(await idempotencyKeyUsed(db, "vehicle.create", idempotencyKey))) {
          const duplicates = await findDuplicateVehicles(db, { vin: input.vin, plate });
          if (duplicates.length > 0) {
            return json(200, { status: "duplicate" as const, matches: duplicates, confirmFor });
          }
        }
        const outcome = await createVehicle(
          db,
          { kind: "user", userId: session.userId },
          input,
          idempotencyKey,
          {
            movePlate: confirmed,
          },
        );
        return json(outcome.replayed ? 200 : 201, { status: "created" as const, ...outcome.result });
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** GET /api/vehicles/:id — current owner, current plate, plate and ownership history. */
    async getVehicle(request: Request, vehicleId: string): Promise<Response> {
      try {
        await authorize(db, await currentSession(request), "vehicle.read", {
          entityType: "vehicle",
          entityId: vehicleId,
        });
        if (!isUuid(vehicleId)) return json(404, { error: "not_found" });
        const profile = await getVehicle(db, vehicleId);
        if (!profile) return json(404, { error: "not_found" });
        return json(200, profile);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/vehicles/:id/plate — JSON/form { plateEmirate, plateCode, plateNumber,
     * confirmFor?, idempotencyKey }. Warns like createVehicle when the plate is or was on
     * another vehicle; confirming moves a still-active plate here. */
    async changeVehiclePlate(request: Request, vehicleId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "vehicle.write", {
          entityType: "vehicle",
          entityId: vehicleId,
        });
        if (!isUuid(vehicleId)) return json(404, { error: "not_found" });
        const body = await readBody(request);
        const idempotencyKey = toStr(body.idempotencyKey);
        const plate = plateFrom(body);
        const confirmFor = duplicateConfirmKey({ plate });
        const confirmed = toStr(body.confirmFor) === confirmFor;
        if (!confirmed && !(await idempotencyKeyUsed(db, "vehicle.change_plate", idempotencyKey))) {
          const duplicates = await findDuplicateVehicles(db, { plate, excludeVehicleId: vehicleId });
          if (duplicates.length > 0) {
            return json(200, { status: "duplicate" as const, matches: duplicates, confirmFor });
          }
        }
        const outcome = await changePlate(
          db,
          { kind: "user", userId: session.userId },
          vehicleId,
          plate,
          idempotencyKey,
          { movePlate: confirmed },
        );
        return json(200, { status: "changed" as const, ...outcome.result });
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/vehicles/:id/transfer-owner — JSON/form { newOwnerCustomerId, idempotencyKey }. */
    async transferVehicleOwner(request: Request, vehicleId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "vehicle.write", {
          entityType: "vehicle",
          entityId: vehicleId,
        });
        if (!isUuid(vehicleId)) return json(404, { error: "not_found" });
        const body = await readBody(request);
        const outcome = await transferOwnership(
          db,
          { kind: "user", userId: session.userId },
          vehicleId,
          toStr(body.newOwnerCustomerId),
          toStr(body.idempotencyKey),
        );
        return json(200, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    // ------------------------------------------------------------------ I1-02 check-in

    /** POST /api/check-ins — JSON/form { vehicleId, idempotencyKey }. */
    async startCheckIn(request: Request): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "repair_order.check_in");
        const body = await readBody(request);
        const outcome = await startCheckIn(
          db,
          { kind: "user", userId: session.userId },
          toStr(body.vehicleId),
          toStr(body.idempotencyKey),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/check-ins/:id — JSON/form draft fields (all optional until completion). */
    async updateCheckIn(request: Request, checkInId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "repair_order.check_in", {
          entityType: "check_in",
          entityId: checkInId,
        });
        if (!isUuid(checkInId)) return json(404, { error: "not_found" });
        const body = await readBody(request);
        const outcome = await updateCheckIn(
          db,
          { kind: "user", userId: session.userId },
          checkInId,
          checkInFieldsFrom(body),
        );
        return json(200, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/check-ins/:id/photos — multipart { slot, idempotencyKey, photo (file) }. */
    async addCheckInPhoto(request: Request, checkInId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "repair_order.check_in", {
          entityType: "check_in",
          entityId: checkInId,
        });
        if (!isUuid(checkInId)) return json(404, { error: "not_found" });
        // Never hold more than the photo limit (plus the multipart envelope) in memory.
        const { maxPhotoBytes } = await getCheckInSettings(db);
        const body = await readLimited(request, maxPhotoBytes + 64 * 1024);
        if (!body) {
          return json(413, { error: "validation_failed", details: { field: "photo", reason: "too_large" } });
        }
        const form = await new Response(body, {
          headers: { "content-type": request.headers.get("content-type") ?? "" },
        }).formData();
        const file = form.get("photo");
        if (!(file instanceof Blob))
          return json(422, { error: "validation_failed", details: { field: "photo" } });
        const outcome = await addCheckInPhoto(
          db,
          storage,
          { kind: "user", userId: session.userId },
          { checkInId, slot: toStr(form.get("slot")), bytes: new Uint8Array(await file.arrayBuffer()) },
          toStr(form.get("idempotencyKey")),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/check-ins/:id/complete — JSON/form { idempotencyKey }. */
    async completeCheckIn(request: Request, checkInId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "repair_order.check_in", {
          entityType: "check_in",
          entityId: checkInId,
        });
        if (!isUuid(checkInId)) return json(404, { error: "not_found" });
        const body = await readBody(request);
        const outcome = await completeCheckIn(
          db,
          { kind: "user", userId: session.userId },
          checkInId,
          toStr(body.idempotencyKey),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** GET /api/repair-orders/:id — the authorized contact's mobile only with customer.read_contact. */
    async getRepairOrder(request: Request, repairOrderId: string): Promise<Response> {
      try {
        const session = await authorize(db, await currentSession(request), "repair_order.read", {
          entityType: "repair_order",
          entityId: repairOrderId,
        });
        const view = await getRepairOrder(db, session.roles, repairOrderId);
        if (!view) return json(404, { error: "not_found" });
        return json(200, view);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/media/:id/exclude — JSON/form { reason }. Manager or partner (AC2-33). */
    async excludePhoto(request: Request, mediaId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "media.exclude", {
          entityType: "media_asset",
          entityId: mediaId,
        });
        if (!isUuid(mediaId)) return json(404, { error: "not_found" });
        const body = await readBody(request);
        const outcome = await excludePhoto(
          db,
          { kind: "user", userId: session.userId },
          mediaId,
          toStr(body.reason),
        );
        return json(200, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** GET /api/media/:id — the photo itself, never cached by shared caches. */
    async getPhoto(request: Request, mediaId: string): Promise<Response> {
      try {
        await authorize(db, await currentSession(request), "repair_order.read", {
          entityType: "media_asset",
          entityId: mediaId,
        });
        const file = await getPhotoFile(db, mediaId);
        const bytes = file ? await storage.get(file.storageKey) : null;
        if (!file || !bytes) return json(404, { error: "not_found" });
        return new Response(Buffer.from(bytes), {
          status: 200,
          headers: {
            "content-type": file.contentType,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            // Even a file that only looks like an image must never run as a page.
            "content-security-policy": "default-src 'none'; sandbox",
            "content-disposition": "inline",
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
