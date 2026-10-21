import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/server/command/runner";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createCustomer } from "../src/server/customer/service";
import { createHandlers } from "../src/server/http/handlers";
import { inspectImage } from "../src/server/media/image";
import { LocalDiskStorage } from "../src/server/media/storage";
import { findNumberGaps } from "../src/server/numbering/numbering";
import {
  abandonCheckIn,
  addCheckInPhoto,
  completeCheckIn,
  discardCheckInPhoto,
  excludePhoto,
  parseDubaiLocalDateTime,
  startCheckIn,
  updateCheckIn,
} from "../src/server/repair-order/check-in";
import { getRepairOrder, listOpenWork } from "../src/server/repair-order/queries";
import { createVehicle, transferOwnership } from "../src/server/vehicle/service";
import {
  createTestDatabase,
  deferred,
  sqlErrorAs,
  waitForLockWaiters,
  type TestDatabase,
} from "./helpers/db";
import { makeJpegHeader, makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/** I1-02 — repair order & check-in: commands, rules, locking, grants. */

const REQUIRED = ["front", "rear", "left", "right", "odometer"] as const;

describe("S13 — check-in and repair order", () => {
  let db: TestDatabase;
  let advisor: Actor;
  let manager: Actor;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let seed = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    advisor = (await makeUser(db.app, ["service_advisor"], "advisor")).actor;
    manager = (await makeUser(db.app, ["manager"], "manager")).actor;
    storageDir = mkdtempSync(join(tmpdir(), "garage-media-test-"));
    storage = new LocalDiskStorage(storageDir);
  });
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  let counter = 0;
  async function newVehicle() {
    counter++;
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `Check-in Customer ${counter}`,
          mobile: `0567${String(counter).padStart(6, "0")}`,
          preferredLanguage: "en",
          marketingConsent: false,
        },
        randomUUID(),
      )
    ).result.customerId;
    const vehicleId = (
      await createVehicle(
        db.app,
        advisor,
        {
          make: "Toyota",
          model: "Camry",
          year: 2020,
          plate: { emirate: "sharjah", code: "CI", number: String(10000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    return { customerId, vehicleId };
  }

  const arrival = {
    odometerKm: 84210,
    fuelEighths: 3,
    concerns: "Squeal when braking",
    keysReceived: 1,
    warningLights: "Check engine",
    belongings: "Child seat",
    keyTag: "K-17",
  };

  async function draftWithArrival() {
    const { customerId, vehicleId } = await newVehicle();
    const checkInId = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result.checkInId;
    await updateCheckIn(db.app, advisor, checkInId, {
      contactName: "Ali Driver",
      contactMobile: "0501112233",
      contactRelationship: "driver",
      ...arrival,
    });
    return { customerId, vehicleId, checkInId };
  }

  const photo = (checkInId: string, slot: string, bytes = makePng(1600, 1200, ++seed)) =>
    addCheckInPhoto(db.app, storage, advisor, { checkInId, slot, bytes }, randomUUID());

  async function withAllPhotos() {
    const draft = await draftWithArrival();
    for (const slot of REQUIRED) await photo(draft.checkInId, slot);
    return draft;
  }

  // --- Happy path --------------------------------------------------------------------------

  it("completing a check-in with all five photos creates a numbered repair order and locks the photos", async () => {
    const { checkInId, customerId, vehicleId } = await withAllPhotos();
    const outcome = await completeCheckIn(db.app, advisor, checkInId, randomUUID());
    expect(outcome.result.number).toMatch(/^RO-\d{6}$/);

    const ro = await getRepairOrder(db.app, ["service_advisor"], outcome.result.repairOrderId);
    expect(ro).toMatchObject({
      status: "checked_in",
      customerId,
      vehicleId,
      contactName: "Ali Driver",
      contactMobile: "0501112233",
      contactRelationship: "driver",
      odometerKm: 84210,
      fuelEighths: 3,
      photoShortfallReason: null,
    });
    expect(ro!.photos.map((p) => p.slot).sort()).toEqual([...REQUIRED].sort());

    const media = await db.app
      .selectFrom("media_asset")
      .select(["locked_at", "repair_order_id"])
      .where("check_in_id", "=", checkInId)
      .where("discarded_at", "is", null)
      .execute();
    expect(
      media.every((m) => m.locked_at !== null && m.repair_order_id === outcome.result.repairOrderId),
    ).toBe(true);

    const draft = await db.app
      .selectFrom("check_in")
      .select("status")
      .where("id", "=", checkInId)
      .executeTakeFirst();
    expect(draft!.status).toBe("completed");

    // Audit: ro.checked_in records the authorized contact (GAP-10) and the photo slots.
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["after_state"])
      .where("action", "=", "ro.checked_in")
      .where("entity_id", "=", outcome.result.repairOrderId)
      .executeTakeFirstOrThrow();
    expect(audit.after_state).toMatchObject({
      number: outcome.result.number,
      authorizedContact: { name: "Ali Driver", mobile: "0501112233", relationship: "driver" },
      missingSlots: [],
    });

    expect((await listOpenWork(db.app)).repairOrders.map((r) => r.id)).toContain(
      outcome.result.repairOrderId,
    );
  });

  it("stores the photo bytes in storage under their checksum", async () => {
    const { checkInId } = await draftWithArrival();
    const bytes = makePng(1400, 1050, 999);
    const { mediaId } = (await photo(checkInId, "front", bytes)).result;
    const row = await db.app
      .selectFrom("media_asset")
      .select(["storage_key", "sha256", "width", "height", "content_type"])
      .where("id", "=", mediaId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ width: 1400, height: 1050, content_type: "image/png" });
    expect(row.storage_key).toContain(row.sha256);
    expect(Buffer.from(readFileSync(join(storageDir, row.storage_key))).equals(Buffer.from(bytes))).toBe(
      true,
    );
  });

  // --- AC-04.2 / AC2-33: fewer photos needs a reason --------------------------------------

  it("completing with fewer than the required photos is refused without a reason and kept with one", async () => {
    const { checkInId } = await draftWithArrival();
    await photo(checkInId, "front");
    await photo(checkInId, "rear");

    await expect(completeCheckIn(db.app, advisor, checkInId, randomUUID())).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "photoShortfallReason", missingSlots: ["left", "right", "odometer"] },
    });
    expect(
      await db.app.selectFrom("repair_order").select("id").where("check_in_id", "=", checkInId).execute(),
    ).toEqual([]);

    await updateCheckIn(db.app, advisor, checkInId, {
      contactName: "Ali Driver",
      contactMobile: "0501112233",
      contactRelationship: "driver",
      ...arrival,
      photoShortfallReason: "Heavy rain at the gate",
    });
    const done = await completeCheckIn(db.app, advisor, checkInId, randomUUID());
    const ro = await getRepairOrder(db.app, ["service_advisor"], done.result.repairOrderId);
    expect(ro!.photoShortfallReason).toBe("Heavy rain at the gate");
    const audit = await db.app
      .selectFrom("audit_event")
      .select("after_state")
      .where("action", "=", "ro.checked_in")
      .where("entity_id", "=", done.result.repairOrderId)
      .executeTakeFirstOrThrow();
    expect(audit.after_state).toMatchObject({
      missingSlots: ["left", "right", "odometer"],
      photoShortfallReason: "Heavy rain at the gate",
    });
  });

  it.each([
    ["contactName", { contactName: null }],
    ["contactMobile", { contactMobile: null }],
    ["odometerKm", { odometerKm: null }],
    ["concerns", { concerns: "  " }],
    ["contactRelationship", { contactRelationship: null }],
  ])("completion requires %s", async (field, override) => {
    const { checkInId } = await withAllPhotos();
    await updateCheckIn(db.app, advisor, checkInId, {
      contactName: "Ali Driver",
      contactMobile: "0501112233",
      contactRelationship: "driver",
      ...arrival,
      ...override,
    });
    await expect(completeCheckIn(db.app, advisor, checkInId, randomUUID())).rejects.toMatchObject({
      code: "validation_failed",
      details: { field },
    });
  });

  it("rejects out-of-range arrival values", async () => {
    const { checkInId } = await draftWithArrival();
    await expect(updateCheckIn(db.app, advisor, checkInId, { fuelEighths: 9 })).rejects.toMatchObject({
      details: { field: "fuelEighths" },
    });
    await expect(updateCheckIn(db.app, advisor, checkInId, { odometerKm: -1 })).rejects.toMatchObject({
      details: { field: "odometerKm" },
    });
    await expect(
      updateCheckIn(db.app, advisor, checkInId, { contactRelationship: "cousin" }),
    ).rejects.toMatchObject({
      details: { field: "contactRelationship" },
    });
    await expect(updateCheckIn(db.app, advisor, checkInId, { contactMobile: "12" })).rejects.toMatchObject({
      details: { field: "contactMobile" },
    });
  });

  // --- Upload validation -------------------------------------------------------------------

  it("accepts only real JPEG/PNG/WebP photos within the size and resolution limits", async () => {
    const { checkInId } = await draftWithArrival();
    const reject = (bytes: Uint8Array, reason: string) =>
      expect(photo(checkInId, "front", bytes)).rejects.toMatchObject({ details: { field: "photo", reason } });

    await reject(new TextEncoder().encode("not an image at all"), "not_image");
    await reject(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(100)]), "not_image");
    // A header claiming an impossible size is not a photo (and would overflow the columns).
    await reject(makePng(70_000, 1, 2), "not_image");
    // No minimum resolution (B-12): a small real photo is accepted.
    await expect(photo(checkInId, "rear", makePng(640, 480, 5))).resolves.toMatchObject({ replayed: false });
    await reject(Buffer.alloc(16 * 1024 * 1024, 1), "too_large");
    await expect(photo(checkInId, "roof")).rejects.toMatchObject({ details: { field: "slot" } });

    // The type comes from the bytes: a JPEG header is recognised as JPEG whatever the client says.
    expect(inspectImage(makeJpegHeader(3000, 2000))).toMatchObject({
      contentType: "image/jpeg",
      width: 3000,
      height: 2000,
    });
  });

  it("a new photo for a slot replaces the previous draft photo, which is kept but discarded", async () => {
    const { checkInId } = await draftWithArrival();
    const first = (await photo(checkInId, "front")).result.mediaId;
    const second = (await photo(checkInId, "front")).result.mediaId;
    const rows = await db.app
      .selectFrom("media_asset")
      .select(["id", "discarded_at"])
      .where("check_in_id", "=", checkInId)
      .where("slot", "=", "front")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first)!.discarded_at).not.toBeNull();
    expect(rows.find((r) => r.id === second)!.discarded_at).toBeNull();
  });

  // --- AC-04.2b: photos are not deletable after check-in ------------------------------------

  it("after completion photos cannot be discarded, and the app role cannot delete or alter them", async () => {
    const { checkInId } = await withAllPhotos();
    await completeCheckIn(db.app, advisor, checkInId, randomUUID());
    const media = await db.app
      .selectFrom("media_asset")
      .select("id")
      .where("check_in_id", "=", checkInId)
      .executeTakeFirstOrThrow();

    await expect(discardCheckInPhoto(db.app, advisor, media.id)).rejects.toMatchObject({
      code: "check_in_closed",
    });
    await expect(photo(checkInId, "other")).rejects.toMatchObject({ code: "check_in_closed" });

    const where = `id = '${media.id}'`;
    expect((await sqlErrorAs(db.appUrl, `DELETE FROM media_asset WHERE ${where}`))?.code).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE media_asset SET discarded_at = now() WHERE ${where}`))?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE media_asset SET locked_at = NULL WHERE ${where}`))?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE media_asset SET storage_key = 'x' WHERE ${where}`))?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE check_in SET concerns = 'x' WHERE id = '${checkInId}'`))?.code,
    ).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, "UPDATE repair_order SET odometer_km = 1"))?.code).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, "DELETE FROM repair_order"))?.code).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, "UPDATE app_setting SET value = '1'"))?.code).toBe("42501");
  });

  it("a manager can exclude a locked photo with a reason, once; the file and row are kept", async () => {
    const { checkInId } = await withAllPhotos();
    await completeCheckIn(db.app, advisor, checkInId, randomUUID());
    const media = await db.app
      .selectFrom("media_asset")
      .select(["id", "storage_key"])
      .where("check_in_id", "=", checkInId)
      .executeTakeFirstOrThrow();

    await expect(excludePhoto(db.app, manager, media.id, " ")).rejects.toMatchObject({
      details: { field: "excludedReason" },
    });
    await excludePhoto(db.app, manager, media.id, "Customer's face visible");
    await expect(excludePhoto(db.app, manager, media.id, "again")).rejects.toMatchObject({
      code: "photo_already_excluded",
    });

    const row = await db.app
      .selectFrom("media_asset")
      .select(["excluded_reason", "locked_at"])
      .where("id", "=", media.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ excluded_reason: "Customer's face visible" });
    expect(readFileSync(join(storageDir, media.storage_key)).length).toBeGreaterThan(0);
  });

  it("draft photos are discarded, not excluded", async () => {
    const { checkInId } = await draftWithArrival();
    const { mediaId } = (await photo(checkInId, "front")).result;
    await expect(excludePhoto(db.app, manager, mediaId, "no")).rejects.toMatchObject({
      code: "photo_not_locked",
    });
    await discardCheckInPhoto(db.app, advisor, mediaId);
    await expect(discardCheckInPhoto(db.app, advisor, mediaId)).rejects.toMatchObject({
      code: "photo_not_discardable",
    });
  });

  // --- Abandon -----------------------------------------------------------------------------

  it("an abandoned check-in needs a reason and can no longer change or complete", async () => {
    const { checkInId } = await withAllPhotos();
    await expect(abandonCheckIn(db.app, advisor, checkInId, "")).rejects.toMatchObject({
      details: { field: "abandonedReason" },
    });
    await abandonCheckIn(db.app, advisor, checkInId, "Customer left");
    await expect(completeCheckIn(db.app, advisor, checkInId, randomUUID())).rejects.toMatchObject({
      code: "check_in_closed",
    });
    await expect(updateCheckIn(db.app, advisor, checkInId, { concerns: "x" })).rejects.toMatchObject({
      code: "check_in_closed",
    });
    expect((await listOpenWork(db.app)).checkIns.map((c) => c.id)).not.toContain(checkInId);
  });

  // --- Idempotency and concurrency ---------------------------------------------------------

  it("completing twice with the same key replays; with a new key it is refused", async () => {
    const { checkInId } = await withAllPhotos();
    const key = randomUUID();
    const first = await completeCheckIn(db.app, advisor, checkInId, key);
    const again = await completeCheckIn(db.app, advisor, checkInId, key);
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    await expect(completeCheckIn(db.app, advisor, checkInId, randomUUID())).rejects.toMatchObject({
      code: "check_in_closed",
    });
  });

  it("an uploaded photo replays on a repeated key instead of being added twice", async () => {
    const { checkInId } = await draftWithArrival();
    const key = randomUUID();
    const bytes = makePng(1600, 1200, 4242);
    const first = await addCheckInPhoto(db.app, storage, advisor, { checkInId, slot: "other", bytes }, key);
    const again = await addCheckInPhoto(db.app, storage, advisor, { checkInId, slot: "other", bytes }, key);
    expect(again.replayed).toBe(true);
    expect(again.result.mediaId).toBe(first.result.mediaId);
    const rows = await db.app
      .selectFrom("media_asset")
      .select("id")
      .where("check_in_id", "=", checkInId)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("two overlapping completions of one check-in create exactly one repair order", async () => {
    const { checkInId } = await withAllPhotos();
    // Hold the first completion open just before commit until the second is waiting on a lock, so
    // the two really overlap. With the check-in lock the second re-reads the draft after the first
    // commits and is refused cleanly; without it, it would already have read "in progress".
    const gate = deferred();
    const first = completeCheckIn(db.app, advisor, checkInId, randomUUID(), {
      beforeCommit: () => gate.promise,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = completeCheckIn(db.app, advisor, checkInId, randomUUID()).then(
      () => "ok",
      (error: unknown) => error,
    );
    await waitForLockWaiters(db, 1);
    gate.resolve();
    await first;
    expect(await second).toMatchObject({ code: "check_in_closed" });
    const ros = await db.app
      .selectFrom("repair_order")
      .select("id")
      .where("check_in_id", "=", checkInId)
      .execute();
    expect(ros).toHaveLength(1);
  });

  it("check-ins completed at the same time get distinct numbers with no gaps", async () => {
    const drafts = [
      await withAllPhotos(),
      await withAllPhotos(),
      await withAllPhotos(),
      await withAllPhotos(),
    ];
    const results = await Promise.all(
      drafts.map((d) => completeCheckIn(db.app, advisor, d.checkInId, randomUUID())),
    );
    const numbers = results.map((r) => r.result.number);
    expect(new Set(numbers).size).toBe(4);
    expect(await findNumberGaps(db.app, "repair_order")).toEqual([]);
  });

  it("a completion that fails after allocating its number rolls everything back and leaves no gap", async () => {
    const { checkInId } = await withAllPhotos();
    await expect(
      completeCheckIn(db.app, advisor, checkInId, randomUUID(), {
        beforeCommit: () => {
          throw new Error("injected fault after number allocation");
        },
      }),
    ).rejects.toThrow("injected fault");

    expect(
      await db.app.selectFrom("repair_order").select("id").where("check_in_id", "=", checkInId).execute(),
    ).toEqual([]);
    const draft = await db.app
      .selectFrom("check_in")
      .select("status")
      .where("id", "=", checkInId)
      .executeTakeFirst();
    expect(draft!.status).toBe("in_progress");
    const locked = await db.app
      .selectFrom("media_asset")
      .select("id")
      .where("check_in_id", "=", checkInId)
      .where("locked_at", "is not", null)
      .execute();
    expect(locked).toEqual([]);

    // The number went back: the retry takes it, and the series has no gap.
    await completeCheckIn(db.app, advisor, checkInId, randomUUID());
    expect(await findNumberGaps(db.app, "repair_order")).toEqual([]);
  });

  it("starting a check-in prefills the owner as the authorized contact", async () => {
    const { vehicleId, customerId } = await newVehicle();
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    const row = await db.app
      .selectFrom("check_in")
      .selectAll()
      .where("id", "=", checkInId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      customer_id: customerId,
      contact_relationship: "owner",
      status: "in_progress",
    });
    expect(row.contact_mobile).toMatch(/^0567/);
    await expect(startCheckIn(db.app, advisor, randomUUID(), randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
  });

  // --- Review fixes ------------------------------------------------------------------------

  it("fuel level and keys are optional at completion (OD-6)", async () => {
    const { checkInId } = await withAllPhotos();
    await updateCheckIn(db.app, advisor, checkInId, { fuelEighths: null, keysReceived: null });
    const done = await completeCheckIn(db.app, advisor, checkInId, randomUUID());
    const ro = await getRepairOrder(db.app, ["service_advisor"], done.result.repairOrderId);
    expect(ro).toMatchObject({ fuelEighths: null, keysReceived: null });
  });

  it("an update changes only the fields it is given", async () => {
    const { checkInId } = await draftWithArrival();
    await updateCheckIn(db.app, advisor, checkInId, { concerns: "Only this changes" });
    const row = await db.app
      .selectFrom("check_in")
      .selectAll()
      .where("id", "=", checkInId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      concerns: "Only this changes",
      contact_mobile: "0501112233",
      odometer_km: 84210,
    });
  });

  it("an impossible promised time is refused instead of rolling over", async () => {
    const { checkInId } = await draftWithArrival();
    for (const promisedAt of [
      parseDubaiLocalDateTime("2026-02-31T10:00"),
      parseDubaiLocalDateTime("2026-10-21T24:00"),
    ]) {
      await expect(updateCheckIn(db.app, advisor, checkInId, { promisedAt })).rejects.toMatchObject({
        details: { field: "promisedAt" },
      });
    }
    expect(parseDubaiLocalDateTime("2026-10-21T17:30")!.toISOString()).toBe("2026-10-21T13:30:00.000Z");
  });

  it("a photo for a closed or unknown check-in is refused before any bytes are stored", async () => {
    const { checkInId } = await withAllPhotos();
    await completeCheckIn(db.app, advisor, checkInId, randomUUID());
    const countFiles = () => readdirSync(join(storageDir, "photos"), { recursive: true }).length;
    const before = countFiles();
    await expect(photo(checkInId, "other", makePng(1600, 1200, 777777))).rejects.toMatchObject({
      code: "check_in_closed",
    });
    await expect(photo(randomUUID(), "other", makePng(1600, 1200, 777778))).rejects.toMatchObject({
      code: "not_found",
    });
    expect(countFiles()).toBe(before);
  });

  it("completing is refused when the vehicle changed owner meanwhile (T-09)", async () => {
    const { checkInId, vehicleId } = await withAllPhotos();
    const { customerId: newOwner } = await newVehicle();
    await transferOwnership(db.app, advisor, vehicleId, newOwner, randomUUID());
    await expect(completeCheckIn(db.app, advisor, checkInId, randomUUID())).rejects.toMatchObject({
      code: "owner_changed",
    });
  });

  it("the contact mobile is hidden from roles without contact rights", async () => {
    const { checkInId } = await withAllPhotos();
    const done = await completeCheckIn(db.app, advisor, checkInId, randomUUID());
    const asStoreKeeper = await getRepairOrder(db.app, ["store_keeper"], done.result.repairOrderId);
    expect(asStoreKeeper!.contactMobile).toBeNull();
    expect(asStoreKeeper!.contactName).toBe("Ali Driver");
  });

  it("the app role cannot insert evidence that looks locked, completed or numbered", async () => {
    const { checkInId, customerId, vehicleId } = await withAllPhotos();
    const done = await completeCheckIn(db.app, advisor, checkInId, randomUUID());
    const roId = done.result.repairOrderId;
    const sha = "a".repeat(64);
    const fakeMedia = (extra: string, values: string, target = checkInId) =>
      sqlErrorAs(
        db.appUrl,
        `INSERT INTO media_asset (check_in_id, slot, storage_key, content_type, byte_size, sha256, width, height${extra})
         VALUES ('${target}', 'front', 'photos/aa/x.png', 'image/png', 10, '${sha}', 10, 10${values})`,
      );
    // A "locked" photo inserted straight onto a completed repair order.
    expect(
      (await fakeMedia(", repair_order_id, locked_at", `, '${roId}', now() - interval '1 day'`))?.code,
    ).toBe("42501");
    // Any new photo on a check-in that is no longer in progress.
    expect((await fakeMedia("", ""))?.code).toBe("42501");
    // A check-in born completed.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO check_in (customer_id, vehicle_id, status) VALUES ('${customerId}', '${vehicleId}', 'completed')`,
        )
      )?.code,
    ).toBe("42501");
  });

  it("the app role cannot lock a draft photo on its own, onto another repair order, or complete without one", async () => {
    const other = await withAllPhotos();
    const otherRo = (await completeCheckIn(db.app, advisor, other.checkInId, randomUUID())).result
      .repairOrderId;
    const { checkInId } = await draftWithArrival();
    const { mediaId } = (await photo(checkInId, "front")).result;
    const where = `id = '${mediaId}'`;

    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE media_asset SET locked_at = now() WHERE ${where}`))?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE media_asset SET locked_at = now(), repair_order_id = '${otherRo}' WHERE ${where}`,
        )
      )?.code,
    ).toBe("23503");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE check_in SET status = 'completed' WHERE id = '${checkInId}'`))
        ?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO repair_order (number, customer_id, vehicle_id, check_in_id, contact_name,
         contact_mobile, contact_relationship, odometer_km, concerns, business_date)
         SELECT 'RO-999999', customer_id, vehicle_id, id, 'x', '0500000000', 'owner', 1, 'x', current_date
         FROM check_in WHERE id = '${checkInId}'`,
        )
      )?.code,
    ).toBe("42501");
  });

  it("an excluded photo cannot be excluded again or re-explained, even directly in SQL", async () => {
    const { checkInId } = await withAllPhotos();
    await completeCheckIn(db.app, advisor, checkInId, randomUUID());
    const media = await db.app
      .selectFrom("media_asset")
      .select("id")
      .where("check_in_id", "=", checkInId)
      .executeTakeFirstOrThrow();
    await excludePhoto(db.app, manager, media.id, "First reason");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE media_asset SET excluded_reason = 'Rewritten' WHERE id = '${media.id}'`,
        )
      )?.code,
    ).toBe("42501");
  });

  it("storage never rewrites an existing file", async () => {
    const bytes = makePng(1600, 1200, 31337);
    const key = `photos/zz/${randomUUID()}.png`;
    await storage.put(key, bytes);
    await storage.put(key, new Uint8Array([1, 2, 3]));
    expect(Buffer.from((await storage.get(key))!).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe("S13 — check-in over HTTP", () => {
  let db: TestDatabase;
  let storageDir: string;
  let handlers: ReturnType<typeof createHandlers>;
  let advisorToken: string;
  let technicianToken: string;
  let managerToken: string;
  let vehicleId: string;

  const BASE = "http://localhost:3000";
  const cookie = (token?: string): Record<string, string> =>
    token ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } : {};
  const post = (path: string, token: string | undefined, body: unknown, origin?: string) =>
    new Request(`${BASE}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...cookie(token), ...(origin ? { origin } : {}) },
    });
  const get = (path: string, token?: string) => new Request(`${BASE}${path}`, { headers: cookie(token) });
  const upload = (checkInId: string, token: string | undefined, slot: string, bytes: Uint8Array) => {
    const form = new FormData();
    form.set("slot", slot);
    form.set("idempotencyKey", randomUUID());
    form.set("photo", new Blob([new Uint8Array(bytes)]), "photo.png");
    return handlers.addCheckInPhoto(
      new Request(`${BASE}/api/check-ins/${checkInId}/photos`, {
        method: "POST",
        body: form,
        headers: cookie(token),
      }),
      checkInId,
    );
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-media-http-"));
    handlers = createHandlers(db.app, new LocalDiskStorage(storageDir));
    const signIn = async (roles: string[], prefix: string) => {
      const user = await makeUser(db.app, roles, prefix);
      const response = await handlers.login(
        new Request(`${BASE}/api/auth/login`, {
          method: "POST",
          body: new URLSearchParams({ username: user.username, password: TEST_PASSWORD, locale: "en" }),
        }),
      );
      const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(response.headers.get("set-cookie") ?? "");
      return { token: decodeURIComponent(match?.[1] ?? ""), actor: user.actor };
    };
    const advisor = await signIn(["service_advisor"], "advisor");
    advisorToken = advisor.token;
    technicianToken = (await signIn(["technician"], "tech")).token;
    managerToken = (await signIn(["manager"], "manager")).token;
    const customerId = (
      await createCustomer(
        db.app,
        advisor.actor,
        { nameEn: "HTTP Customer", mobile: "0569990000", preferredLanguage: "en", marketingConsent: false },
        randomUUID(),
      )
    ).result.customerId;
    vehicleId = (
      await createVehicle(
        db.app,
        advisor.actor,
        {
          make: "Honda",
          model: "Accord",
          year: 2018,
          plate: { emirate: "dubai", code: "H", number: "70001" },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
  });
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("an advisor checks in a vehicle end to end over HTTP, and the photo is served privately", async () => {
    const started = await handlers.startCheckIn(
      post("/api/check-ins", advisorToken, { vehicleId, idempotencyKey: randomUUID() }),
    );
    expect(started.status).toBe(201);
    const { checkInId } = (await started.json()) as { checkInId: string };

    const updated = await handlers.updateCheckIn(
      post(`/api/check-ins/${checkInId}`, advisorToken, {
        odometerKm: "120500",
        fuelEighths: "4",
        concerns: "Battery light",
        keysReceived: "2",
        promisedAt: "2026-10-22T17:30",
      }),
      checkInId,
    );
    expect(updated.status).toBe(200);
    const stored = await db.app
      .selectFrom("check_in")
      .select(["promised_at", "contact_name"])
      .where("id", "=", checkInId)
      .executeTakeFirstOrThrow();
    // 17:30 in Dubai is 13:30 UTC; fields not sent (the contact) are unchanged.
    expect(stored.promised_at!.toISOString()).toBe("2026-10-22T13:30:00.000Z");
    expect(stored.contact_name).toBe("HTTP Customer");

    const notImage = await upload(checkInId, advisorToken, "front", new TextEncoder().encode("hello"));
    expect(notImage.status).toBe(422);
    expect(await notImage.json()).toMatchObject({ details: { field: "photo", reason: "not_image" } });

    let mediaId = "";
    for (const [index, slot] of REQUIRED.entries()) {
      const response = await upload(checkInId, advisorToken, slot, makePng(1600, 1200, 100 + index));
      expect(response.status).toBe(201);
      mediaId = ((await response.json()) as { mediaId: string }).mediaId;
    }

    const completed = await handlers.completeCheckIn(
      post(`/api/check-ins/${checkInId}/complete`, advisorToken, { idempotencyKey: randomUUID() }),
      checkInId,
    );
    expect(completed.status).toBe(201);
    const { repairOrderId, number } = (await completed.json()) as { repairOrderId: string; number: string };
    expect(number).toMatch(/^RO-\d{6}$/);

    const view = await handlers.getRepairOrder(
      get(`/api/repair-orders/${repairOrderId}`, advisorToken),
      repairOrderId,
    );
    expect(await view.json()).toMatchObject({ number, status: "checked_in", contactMobile: "0569990000" });

    const photo = await handlers.getPhoto(get(`/api/media/${mediaId}`, advisorToken), mediaId);
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(photo.headers.get("cache-control")).toBe("private, no-store");
    expect(photo.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await photo.arrayBuffer()).byteLength).toBeGreaterThan(0);

    expect((await handlers.getPhoto(get(`/api/media/${mediaId}`), mediaId)).status).toBe(401);
    expect((await handlers.getPhoto(get(`/api/media/${mediaId}`, technicianToken), mediaId)).status).toBe(
      403,
    );

    // Exclusion: advisor refused, manager allowed.
    const byAdvisor = await handlers.excludePhoto(
      post(`/api/media/${mediaId}/exclude`, advisorToken, { reason: "x" }),
      mediaId,
    );
    expect(byAdvisor.status).toBe(403);
    const byManager = await handlers.excludePhoto(
      post(`/api/media/${mediaId}/exclude`, managerToken, { reason: "Reflection hides damage" }),
      mediaId,
    );
    expect(byManager.status).toBe(200);
  });

  it("a technician is refused by every check-in and repair-order endpoint, and each denial is audited", async () => {
    const id = randomUUID();
    const responses = [
      await handlers.startCheckIn(
        post("/api/check-ins", technicianToken, { vehicleId, idempotencyKey: randomUUID() }),
      ),
      await handlers.updateCheckIn(post(`/api/check-ins/${id}`, technicianToken, { concerns: "x" }), id),
      await upload(id, technicianToken, "front", makePng(1600, 1200, 7)),
      await handlers.completeCheckIn(
        post(`/api/check-ins/${id}/complete`, technicianToken, { idempotencyKey: randomUUID() }),
        id,
      ),
      await handlers.getRepairOrder(get(`/api/repair-orders/${id}`, technicianToken), id),
      await handlers.excludePhoto(post(`/api/media/${id}/exclude`, technicianToken, { reason: "x" }), id),
    ];
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403]);
    const denied = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "authz.denied")
      .execute();
    const permissions = denied.map((row) => (row.details as { permission: string }).permission);
    expect(permissions).toEqual(
      expect.arrayContaining(["repair_order.check_in", "repair_order.read", "media.exclude"]),
    );
  });

  it("refuses an upload larger than the limit, declared or not", async () => {
    const started = await handlers.startCheckIn(
      post("/api/check-ins", advisorToken, { vehicleId, idempotencyKey: randomUUID() }),
    );
    const { checkInId } = (await started.json()) as { checkInId: string };
    const request = (body: BodyInit, declared?: number) =>
      new Request(`${BASE}/api/check-ins/${checkInId}/photos`, {
        method: "POST",
        body,
        headers: {
          ...cookie(advisorToken),
          "content-type": "multipart/form-data; boundary=x",
          ...(declared ? { "content-length": String(declared) } : {}),
        },
        // Node needs this for a streamed request body.
        ...({ duplex: "half" } as object),
      });

    // Declared too large: refused without reading.
    const declared = await handlers.addCheckInPhoto(request("x", 50 * 1024 * 1024), checkInId);
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({ details: { reason: "too_large" } });

    // Not declared (streamed in chunks): refused once the count passes the limit.
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        if (sent > 30 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const streamed = await handlers.addCheckInPhoto(request(stream), checkInId);
    expect(streamed.status).toBe(413);
    // It stopped reading early instead of taking in all 30 MB.
    expect(sent).toBeLessThan(15 * 1024 * 1024);
  });

  it("refuses cross-site uploads and starts", async () => {
    const form = new FormData();
    form.set("slot", "front");
    form.set("idempotencyKey", randomUUID());
    form.set("photo", new Blob([new Uint8Array(makePng(1600, 1200, 9))]), "photo.png");
    const crossUpload = await handlers.addCheckInPhoto(
      new Request(`${BASE}/api/check-ins/${randomUUID()}/photos`, {
        method: "POST",
        body: form,
        headers: { ...cookie(advisorToken), origin: "https://evil.example" },
      }),
      randomUUID(),
    );
    expect(crossUpload.status).toBe(403);
    const response = await handlers.startCheckIn(
      post(
        "/api/check-ins",
        advisorToken,
        { vehicleId, idempotencyKey: randomUUID() },
        "https://evil.example",
      ),
    );
    expect(response.status).toBe(403);
  });
});
