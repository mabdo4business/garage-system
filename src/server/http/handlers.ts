import type { Kysely } from "kysely";
import { DomainError, UnauthenticatedError } from "../core/errors";
import { isUuid } from "../core/ids";
import { idempotencyKeyUsed } from "../command/runner";
import { logger } from "../core/logger";
import { authorize, deactivateUser, login, logout } from "../auth/service";
import { hasPermission } from "../auth/permissions";
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
import { requireFindingAccess, requireMediaAccess, requireRepairOrderAccess } from "../inspection/access";
import {
  addFindingPhoto,
  assignInspection,
  recordFinding,
  setFindingPhotoVisibility,
  updateFinding,
  withdrawFinding,
  type FindingInput,
} from "../inspection/commands";
import { getInspection } from "../inspection/queries";
import { createItem, getCatalogueItem, KINDS, listCatalogue, setPrice } from "../catalog/items";
import { addTaxProfile, getTaxSettings } from "../catalog/tax";
import { addJob, addLine, openEstimate, setLineDiscount } from "../estimate/commands";
import { estimateView } from "../estimate/queries";
import { recordInPersonApproval, sendVersion } from "../estimate/approval";
import {
  assignJob,
  completeJob,
  pauseJob,
  requireJobAccess,
  resumeJob,
  startJob,
} from "../workshop/commands";
import { jobCard, workshopBoard } from "../workshop/queries";
import {
  clearWaitingParts,
  issueFromStock,
  markWaitingParts,
  receiveAndIssue,
  receiveStock,
} from "../inventory/commands";
import { partsForOpenJobs, stockList } from "../inventory/queries";
import { failQc, passQc, requestQc } from "../quality/commands";
import { qcView } from "../quality/queries";
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
  inspection_closed: 409,
  already_assigned: 409,
  finding_withdrawn: 409,
  item_already_recorded: 409,
  item_code_taken: 409,
  tax_code_exists: 409,
  tax_date_not_after_latest: 409,
  photo_not_discardable: 409,
  photo_not_locked: 409,
  photo_already_excluded: 409,
  estimate_closed: 409,
  estimate_exists: 409,
  no_draft: 409,
  no_tax_profile: 409,
  no_tax_rate: 409,
  finding_already_included: 409,
  finding_already_excluded: 409,
  finding_in_estimate: 409,
  estimate_empty: 409,
  job_without_lines: 409,
  urgent_finding_open: 409,
  tax_rate_changed: 409,
  estimate_not_sent: 409,
  estimate_expired: 409,
  estimate_changed: 409,
  revision_not_pending: 409,
  open_repair_order_exists: 409,
  open_repair_order_gone: 409,
  job_not_assignable: 409,
  job_not_authorized: 409,
  repair_order_not_in_progress: 409,
  not_assignee: 409,
  job_status_changed: 409,
  not_stock_tracked: 409,
  line_not_issuable: 409,
  insufficient_stock: 409,
  item_inactive: 409,
  decision_pending: 409,
  work_not_finished: 409,
  qc_not_pending: 409,
  qc_self_check: 409,
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

function findingFrom(body: Record<string, unknown>): FindingInput {
  return {
    title: toStr(body.title),
    severity: toStr(body.severity),
    faultCodes: toStr(body.faultCodes),
    customerNote: toStr(body.customerNote) || null,
    internalNote: toStr(body.internalNote) || null,
    templateItemId: toStr(body.templateItemId) || null,
  };
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
    // OQ-1: the open repair order's number is what the client must confirm, so it travels too.
    const open = error.code === "open_repair_order_exists" ? error.details?.openRepairOrder : undefined;
    const details = {
      ...(typeof field === "string" ? { field } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
      ...(typeof open === "string" ? { openRepairOrder: open } : {}),
    };
    return json(status, {
      error: error.code,
      // "Not found" never says what was looked up (ids would confirm what exists).
      message: error.code === "not_found" ? "Not found" : error.message,
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
          undefined,
          { confirmOpenRepairOrder: toStr(body.confirmOpenRepairOrder) || null },
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
        const session = await currentSession(request);
        if (!session) throw new UnauthenticatedError();
        // Staff with repair_order.read see every photo; a technician only those of the repair order they
        // are assigned to. Anything else is "not found" and audited (AC2-30), whether or not it exists.
        await requireMediaAccess(db, session, mediaId);
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

    // ------------------------------------------------------------------ I1-03 inspection

    /** POST /api/repair-orders/:id/inspection/assign — JSON/form { technicianUserId }. Manager or partner. */
    async assignInspection(request: Request, repairOrderId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "inspection.assign", {
          entityType: "repair_order",
          entityId: repairOrderId,
        });
        if (!isUuid(repairOrderId)) return json(404, { error: "not_found" });
        const body = await readBody(request);
        const outcome = await assignInspection(db, session, repairOrderId, toStr(body.technicianUserId));
        return json(200, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** GET /api/repair-orders/:id/inspection — findings with internal notes (staff only, AC2-30 scoped). */
    async getInspection(request: Request, repairOrderId: string): Promise<Response> {
      try {
        const session = await authorize(db, await currentSession(request), "finding.record", {
          entityType: "repair_order",
          entityId: repairOrderId,
        });
        await requireRepairOrderAccess(db, session, repairOrderId);
        const view = await getInspection(db, repairOrderId);
        if (!view) return json(404, { error: "not_found" });
        return json(200, view);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/repair-orders/:id/findings — JSON/form finding fields + idempotencyKey. */
    async recordFinding(request: Request, repairOrderId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "finding.record", {
          entityType: "repair_order",
          entityId: repairOrderId,
        });
        await requireRepairOrderAccess(db, session, repairOrderId);
        const body = await readBody(request);
        const outcome = await recordFinding(
          db,
          session,
          repairOrderId,
          findingFrom(body),
          toStr(body.idempotencyKey),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/findings/:id — JSON/form finding fields (replaces them; before/after audited). */
    async updateFinding(request: Request, findingId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "finding.record", {
          entityType: "finding",
          entityId: findingId,
        });
        await requireFindingAccess(db, session, findingId);
        const body = await readBody(request);
        const outcome = await updateFinding(db, session, findingId, findingFrom(body));
        return json(200, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/findings/:id/withdraw — JSON/form { reason }. */
    async withdrawFinding(request: Request, findingId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "finding.record", {
          entityType: "finding",
          entityId: findingId,
        });
        await requireFindingAccess(db, session, findingId);
        const body = await readBody(request);
        const outcome = await withdrawFinding(db, session, findingId, toStr(body.reason));
        return json(200, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/findings/:id/photos — multipart { idempotencyKey, photo (file) }; starts internal (OD-11). */
    async addFindingPhoto(request: Request, findingId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "finding.record", {
          entityType: "finding",
          entityId: findingId,
        });
        await requireFindingAccess(db, session, findingId);
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
        const outcome = await addFindingPhoto(
          db,
          storage,
          session,
          { findingId, bytes: new Uint8Array(await file.arrayBuffer()) },
          toStr(form.get("idempotencyKey")),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/media/:id/visibility — JSON/form { visibility: "internal" | "customer" } for a finding photo. */
    async setPhotoVisibility(request: Request, mediaId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "finding.record", {
          entityType: "media_asset",
          entityId: mediaId,
        });
        await requireMediaAccess(db, session, mediaId);
        const body = await readBody(request);
        const outcome = await setFindingPhotoVisibility(db, session, mediaId, toStr(body.visibility));
        return json(200, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    // ------------------------------------------------------------------ I1-05 estimate

    /** GET /api/repair-orders/:id/estimate — the staff estimate builder (no technicians: no prices, AC2-30). */
    async getEstimate(request: Request, repairOrderId: string): Promise<Response> {
      try {
        await authorize(db, await currentSession(request), "estimate.read", {
          entityType: "repair_order",
          entityId: repairOrderId,
        });
        const view = await estimateView(db, repairOrderId);
        if (!view) return json(404, { error: "not_found" });
        return json(200, view);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/repair-orders/:id/estimate — { idempotencyKey }; starts the draft (urgent findings pre-selected, AC-05.2). */
    async openEstimate(request: Request, repairOrderId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "estimate.edit", {
          entityType: "repair_order",
          entityId: repairOrderId,
        });
        const body = await readBody(request);
        const outcome = await openEstimate(db, session, repairOrderId, toStr(body.idempotencyKey));
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/repair-orders/:id/estimate/jobs — JSON/form { title?, findingId?, idempotencyKey }. */
    async addEstimateJob(request: Request, repairOrderId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "estimate.edit", {
          entityType: "repair_order",
          entityId: repairOrderId,
        });
        const body = await readBody(request);
        const outcome = await addJob(
          db,
          session,
          repairOrderId,
          { title: body.title, findingId: body.findingId },
          toStr(body.idempotencyKey),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/repair-jobs/:id/lines — JSON/form { itemId, qty, idempotencyKey }. */
    async addEstimateLine(request: Request, jobId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "estimate.edit", {
          entityType: "repair_job",
          entityId: jobId,
        });
        const body = await readBody(request);
        const outcome = await addLine(
          db,
          session,
          jobId,
          { itemId: body.itemId, qty: body.qty },
          toStr(body.idempotencyKey),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/revision-lines/:id/discount — JSON/form { discount, idempotencyKey }. Manager or partner (OD-19). */
    async setEstimateLineDiscount(request: Request, lineId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "estimate.discount", {
          entityType: "revision_line",
          entityId: lineId,
        });
        const body = await readBody(request);
        const outcome = await setLineDiscount(
          db,
          session,
          lineId,
          { discount: body.discount },
          toStr(body.idempotencyKey),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/repair-orders/:id/estimate/send — { idempotencyKey }; freezes the snapshot (P0-11). */
    async sendEstimate(request: Request, repairOrderId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "estimate.send", {
          entityType: "repair_order",
          entityId: repairOrderId,
        });
        const body = await readBody(request);
        const outcome = await sendVersion(db, session, repairOrderId, toStr(body.idempotencyKey));
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /**
     * POST /api/estimate-versions/:id/approvals — multipart: contentHash, language, approverName,
     * decision.<revisionId> = approved | declined, signature (image), idempotencyKey. In person (L3, OD-20).
     */
    async recordEstimateApproval(request: Request, versionId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "estimate.record_approval", {
          entityType: "estimate_version",
          entityId: versionId,
        });
        if (!isUuid(versionId)) return json(404, { error: "not_found" });
        const body = await readLimited(request, 2 * 1024 * 1024 + 64 * 1024);
        if (!body) {
          return json(413, {
            error: "validation_failed",
            details: { field: "signature", reason: "too_large" },
          });
        }
        const form = await new Response(body, {
          headers: { "content-type": request.headers.get("content-type") ?? "" },
        }).formData();
        const signature = form.get("signature");
        const decisions = [...form.entries()]
          .filter(([key, value]) => key.startsWith("decision.") && value !== "")
          .map(([key, value]) => ({ revisionId: key.slice("decision.".length), decision: value }));
        const outcome = await recordInPersonApproval(
          db,
          storage,
          session,
          {
            versionId,
            contentHash: form.get("contentHash"),
            language: form.get("language"),
            approverName: form.get("approverName"),
            decisions,
            signature:
              signature instanceof Blob ? new Uint8Array(await signature.arrayBuffer()) : new Uint8Array(0),
          },
          toStr(form.get("idempotencyKey")),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    // ------------------------------------------------------------------ I1-06 workshop

    /** GET /api/workshop/board — open repair orders with jobs (no prices). */
    async getWorkshopBoard(request: Request): Promise<Response> {
      try {
        await authorize(db, await currentSession(request), "workshop.board");
        return json(200, await workshopBoard(db));
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** GET /api/jobs/:id — the job card (AC2-30: assignee or board staff only; never prices). */
    async getJob(request: Request, jobId: string): Promise<Response> {
      try {
        const current = await currentSession(request);
        // Board staff (advisors included) and assignees read job cards; anyone else is refused and logged.
        const permission =
          current && hasPermission(current.roles, "workshop.board") ? "workshop.board" : "workshop.my_jobs";
        const session = await authorize(db, current, permission, {
          entityType: "repair_job",
          entityId: jobId,
        });
        await requireJobAccess(db, session, jobId);
        const card = await jobCard(db, jobId);
        if (!card) return json(404, { error: "not_found" });
        return json(200, card);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /**
     * POST /api/jobs/:id/:action — action = assign { assigneeId, bay? } | start | pause { reason } | resume |
     * complete { lines: [{ lineId, outcome, reason? }], note? }; every body carries an idempotencyKey.
     */
    async jobAction(request: Request, jobId: string, action: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const current = await currentSession(request);
        // Waiting parts is set by staff handling parts (OD-29) or by the assignee; the command checks which.
        const parts = action === "waiting-parts" || action === "parts-arrived";
        const permission =
          action === "assign"
            ? "workshop.assign"
            : parts && current && hasPermission(current.roles, "stock.issue")
              ? "stock.issue"
              : "workshop.my_jobs";
        const session = await authorize(db, current, permission, {
          entityType: "repair_job",
          entityId: jobId,
        });
        const body = await readBody(request);
        const key = toStr(body.idempotencyKey);
        const outcome =
          action === "assign"
            ? await assignJob(db, session, jobId, { assigneeId: body.assigneeId, bay: body.bay }, key)
            : action === "start"
              ? await startJob(db, session, jobId, key)
              : action === "pause"
                ? await pauseJob(db, session, jobId, { reason: body.reason }, key)
                : action === "resume"
                  ? await resumeJob(db, session, jobId, key)
                  : action === "complete"
                    ? await completeJob(db, session, jobId, { lines: body.lines, note: body.note }, key)
                    : action === "waiting-parts"
                      ? await markWaitingParts(db, session, jobId, key)
                      : action === "parts-arrived"
                        ? await clearWaitingParts(db, session, jobId, key)
                        : null;
        if (!outcome) return json(404, { error: "not_found" });
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    // ------------------------------------------------------------------ I1-07 parts

    /** GET /api/stock — stock-tracked parts with on hand, value and unit cost (stock roles only, T-24). */
    async getStock(request: Request): Promise<Response> {
      try {
        await authorize(db, await currentSession(request), "stock.read");
        return json(200, await stockList(db));
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** GET /api/stock/parts-for-jobs — approved part lines of running work, with what is costed so far. */
    async getPartsForJobs(request: Request): Promise<Response> {
      try {
        await authorize(db, await currentSession(request), "stock.read");
        return json(200, await partsForOpenJobs(db));
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/stock/:itemId/receipts — { qty, amount (excl. VAT, total), supplierName, supplierRef, idempotencyKey }. */
    async receiveStock(request: Request, itemId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "stock.receive", {
          entityType: "catalogue_item",
          entityId: itemId,
        });
        const body = await readBody(request);
        const outcome = await receiveStock(
          db,
          session,
          itemId,
          {
            qty: body.qty,
            amount: body.amount,
            supplierName: body.supplierName,
            supplierRef: body.supplierRef,
          },
          toStr(body.idempotencyKey),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /**
     * POST /api/revision-lines/:id/:action — action = issue { qty, overReason? } | receive-and-issue { qty, amount,
     * supplierName, supplierRef, overReason? }; every body carries an idempotencyKey.
     */
    async lineParts(request: Request, lineId: string, action: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "stock.issue", {
          entityType: "revision_line",
          entityId: lineId,
        });
        const body = await readBody(request);
        const key = toStr(body.idempotencyKey);
        const outcome =
          action === "issue"
            ? await issueFromStock(db, session, lineId, { qty: body.qty, overReason: body.overReason }, key)
            : action === "receive-and-issue"
              ? await receiveAndIssue(
                  db,
                  session,
                  lineId,
                  {
                    qty: body.qty,
                    amount: body.amount,
                    supplierName: body.supplierName,
                    supplierRef: body.supplierRef,
                    overReason: body.overReason,
                  },
                  key,
                )
              : null;
        if (!outcome) return json(404, { error: "not_found" });
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    // ------------------------------------------------------------------ I1-08 quality check

    /** GET /api/repair-orders/:id/qc — QC records and what still blocks a request (managers, partners, advisors). */
    async getQc(request: Request, repairOrderId: string): Promise<Response> {
      try {
        await authorize(db, await currentSession(request), "repair_order.read", {
          entityType: "repair_order",
          entityId: repairOrderId,
        });
        const view = await qcView(db, repairOrderId);
        if (!view) return json(404, { error: "not_found" });
        return json(200, view);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /**
     * POST /api/repair-orders/:id/qc/:action — action = request | pass { checklist… } | fail { notes, jobIds };
     * every body carries an idempotencyKey.
     */
    async qcAction(request: Request, repairOrderId: string, action: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(
          db,
          await currentSession(request),
          action === "request" ? "qc.request" : "qc.decide",
          {
            entityType: "repair_order",
            entityId: repairOrderId,
          },
        );
        const body = await readBody(request);
        const key = toStr(body.idempotencyKey);
        const outcome =
          action === "request"
            ? await requestQc(db, session, repairOrderId, key)
            : action === "pass"
              ? await passQc(db, session, repairOrderId, body, key)
              : action === "fail"
                ? await failQc(db, session, repairOrderId, { notes: body.notes, jobIds: body.jobIds }, key)
                : null;
        if (!outcome) return json(404, { error: "not_found" });
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    // ------------------------------------------------------------------ I1-04 catalog & tax

    /** GET /api/catalogue?kind=labor_rate|package|part&q=&inactive=1 — current VAT-inclusive prices. */
    async listCatalogue(request: Request): Promise<Response> {
      try {
        await authorize(db, await currentSession(request), "catalogue.read");
        const url = new URL(request.url);
        const kind = url.searchParams.get("kind") ?? "";
        if (!(KINDS as readonly string[]).includes(kind)) {
          return json(422, { error: "validation_failed", details: { field: "kind" } });
        }
        const items = await listCatalogue(db, {
          kind: kind as (typeof KINDS)[number],
          includeInactive: url.searchParams.get("inactive") === "1",
          search: url.searchParams.get("q") ?? "",
        });
        return json(200, items);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** GET /api/catalogue/:id — details and price history. */
    async getCatalogueItem(request: Request, itemId: string): Promise<Response> {
      try {
        await authorize(db, await currentSession(request), "catalogue.read", {
          entityType: "catalogue_item",
          entityId: itemId,
        });
        const item = await getCatalogueItem(db, itemId);
        if (!item) return json(404, { error: "not_found" });
        return json(200, item);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/catalogue — new item with its first price (OD-12: partner or manager). */
    async createCatalogueItem(request: Request): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "pricing.manage");
        const body = await readBody(request);
        const outcome = await createItem(
          db,
          session,
          { ...body, stockTracked: toBool(body.stockTracked) } as Parameters<typeof createItem>[2],
          toStr(body.idempotencyKey),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/catalogue/:id/price — JSON/form { price, taxCode, idempotencyKey }. */
    async setCataloguePrice(request: Request, itemId: string): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "pricing.manage", {
          entityType: "catalogue_item",
          entityId: itemId,
        });
        const body = await readBody(request);
        const outcome = await setPrice(
          db,
          session,
          itemId,
          { price: body.price, taxCode: body.taxCode },
          toStr(body.idempotencyKey),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** GET /api/tax — tax profiles and codes with rate history (partners, T-15). */
    async getTaxSettings(request: Request): Promise<Response> {
      try {
        await authorize(db, await currentSession(request), "tax.manage");
        return json(200, await getTaxSettings(db));
      } catch (error) {
        return errorResponse(error);
      }
    },

    /** POST /api/tax/profiles — JSON/form { registrationStatus, trn?, effectiveFrom, note?, idempotencyKey }. */
    async addTaxProfile(request: Request): Promise<Response> {
      try {
        if (!sameOrigin(request)) return json(403, { error: "forbidden" });
        const session = await authorize(db, await currentSession(request), "tax.manage");
        const body = await readBody(request);
        const outcome = await addTaxProfile(
          db,
          session,
          body as Parameters<typeof addTaxProfile>[2],
          toStr(body.idempotencyKey),
        );
        return json(outcome.replayed ? 200 : 201, outcome.result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
