import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createCustomer } from "../src/server/customer/service";
import { createHandlers } from "../src/server/http/handlers";
import {
  addFindingPhoto,
  assignInspection,
  discardFindingPhoto,
  recordFinding,
  setFindingPhotoVisibility,
  updateFinding,
  withdrawFinding,
  type Staff,
} from "../src/server/inspection/commands";
import {
  customerFindingsView,
  findingsForEstimate,
  getInspection,
  listChecklistTemplates,
  myInspections,
} from "../src/server/inspection/queries";
import { LocalDiskStorage } from "../src/server/media/storage";
import {
  addCheckInPhoto,
  completeCheckIn,
  startCheckIn,
  updateCheckIn,
} from "../src/server/repair-order/check-in";
import { createVehicle } from "../src/server/vehicle/service";
import {
  createTestDatabase,
  deferred,
  sqlErrorAs,
  waitForLockWaiters,
  type TestDatabase,
} from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/** I1-03 — inspection assignment, findings, finding photos, technician scoping (AC2-30), AC2-31 pattern. */

describe("S14 — inspection findings", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { username: string; token: string }> = {};

  const BASE = "http://localhost:3000";
  const cookie = (token: string): Record<string, string> => ({
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
  });
  const get = (path: string, token: string) => new Request(`${BASE}${path}`, { headers: cookie(token) });
  const post = (path: string, token: string, body: unknown) =>
    new Request(`${BASE}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...cookie(token) },
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-inspection-"));
    storage = new LocalDiskStorage(storageDir);
    handlers = createHandlers(db.app, storage);
    for (const [name, roles] of [
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["tech", ["technician"]],
      ["tech2", ["technician"]],
      ["storekeeper", ["store_keeper"]],
    ] as const) {
      const user = await makeUser(db.app, [...roles], name);
      const response = await handlers.login(
        new Request(`${BASE}/api/auth/login`, {
          method: "POST",
          body: new URLSearchParams({ username: user.username, password: TEST_PASSWORD, locale: "en" }),
        }),
      );
      const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(response.headers.get("set-cookie") ?? "");
      people[name] = {
        userId: user.userId,
        roles: [...roles],
        username: user.username,
        token: decodeURIComponent(match?.[1] ?? ""),
      };
    }
  });
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  let counter = 0;
  /** A repair order in Checked-in (completed check-in with a shortfall reason, no photos). */
  async function newRepairOrder(): Promise<string> {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `Inspection Customer ${counter}`,
          mobile: `0545${String(counter).padStart(6, "0")}`,
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
          model: "Hilux",
          year: 2017,
          plate: { emirate: "fujairah", code: "IN", number: String(30000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 150000,
      concerns: "Engine light on",
      warningLights: "Check engine",
      photoShortfallReason: "Test fixture",
    });
    return (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
  }

  const finding = (overrides: Record<string, unknown> = {}) => ({
    title: "Front brake pads worn",
    severity: "urgent",
    faultCodes: "p0301, P0420",
    customerNote: "Pads at 2 mm; replace soon for safe braking.",
    internalNote: "INTERNAL-TEST-123 left caliper slider sticky, check price with supplier",
    ...overrides,
  });

  // --- Assignment (OD-8, T-11, B1) ------------------------------------------------------------

  it("a manager assigns a technician: Checked-in → Diagnosing, audited; reassigning closes the old row", async () => {
    const ro = await newRepairOrder();
    await assignInspection(db.app, people.manager!, ro, people.tech!.userId);
    const status = await db.app
      .selectFrom("repair_order")
      .select("status")
      .where("id", "=", ro)
      .executeTakeFirst();
    expect(status!.status).toBe("diagnosing");
    const actions = (
      await db.app.selectFrom("audit_event").select("action").where("entity_id", "=", ro).execute()
    ).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["inspection.assigned", "ro.diagnosis_started"]));

    await assignInspection(db.app, people.manager!, ro, people.tech2!.userId);
    const rows = await db.app
      .selectFrom("inspection_assignment")
      .select(["technician_user_id", "ended_at"])
      .where("repair_order_id", "=", ro)
      .orderBy("assigned_at")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ended_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ technician_user_id: people.tech2!.userId, ended_at: null });
    await expect(assignInspection(db.app, people.manager!, ro, people.tech2!.userId)).rejects.toMatchObject({
      code: "already_assigned",
    });
  });

  it("only an active technician can be assigned, and only by a manager or partner", async () => {
    const ro = await newRepairOrder();
    await expect(assignInspection(db.app, people.manager!, ro, people.advisor!.userId)).rejects.toMatchObject(
      {
        details: { field: "technicianUserId" },
      },
    );
    for (const who of ["advisor", "tech"] as const) {
      const response = await handlers.assignInspection(
        post(`/api/repair-orders/${ro}/inspection/assign`, people[who]!.token, {
          technicianUserId: people.tech!.userId,
        }),
        ro,
      );
      expect(response.status).toBe(403);
    }
    const ok = await handlers.assignInspection(
      post(`/api/repair-orders/${ro}/inspection/assign`, people.manager!.token, {
        technicianUserId: people.tech!.userId,
      }),
      ro,
    );
    expect(ok.status).toBe(200);
  });

  it("an assignment arriving while another is in flight waits, then becomes a reassignment", async () => {
    const ro = await newRepairOrder();
    // Hold a first assignment (to tech) open before commit, while a second (to tech2) arrives.
    const gate = deferred();
    const { runCommand } = await import("../src/server/command/runner");
    const first = runCommand(
      db.app,
      {
        name: "test.assign",
        actor: { kind: "user", userId: people.manager!.userId },
        hooks: { beforeCommit: () => gate.promise },
      },
      async (ctx) => {
        await ctx.locks.acquire("repair_order", [ro]);
        await ctx.tx
          .insertInto("inspection_assignment")
          .values({
            repair_order_id: ro,
            technician_user_id: people.tech!.userId,
            assigned_by: people.manager!.userId,
          })
          .execute();
        await ctx.audit({ action: "test.assigned", entityType: "repair_order", entityId: ro });
        return {};
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = assignInspection(db.app, people.manager!, ro, people.tech2!.userId).then(
      () => "ok",
      (error: unknown) => error,
    );
    await waitForLockWaiters(db, 1);
    gate.resolve();
    await first;
    // With the repair-order lock the second sees the first and reassigns; without it, it would fail on
    // the unique index (23505).
    expect(await second).toBe("ok");
    const active = await db.app
      .selectFrom("inspection_assignment")
      .select("id")
      .where("repair_order_id", "=", ro)
      .where("ended_at", "is", null)
      .execute();
    expect(active).toHaveLength(1);
  });

  // --- AC2-30: technician scoping -----------------------------------------------------------

  it("an unassigned technician gets not-found everywhere and the attempt is logged; the assigned one gets in", async () => {
    const ro = await newRepairOrder();
    await assignInspection(db.app, people.manager!, ro, people.tech!.userId);
    const recorded = await recordFinding(db.app, people.advisor!, ro, finding(), randomUUID());
    const photo = await addFindingPhoto(
      db.app,
      storage,
      people.advisor!,
      { findingId: recorded.result.findingId, bytes: makePng(800, 600, 1) },
      randomUUID(),
    );

    const other = people.tech2!;
    const responses = [
      await handlers.getInspection(get(`/api/repair-orders/${ro}/inspection`, other.token), ro),
      await handlers.recordFinding(
        post(`/api/repair-orders/${ro}/findings`, other.token, {
          ...finding(),
          idempotencyKey: randomUUID(),
        }),
        ro,
      ),
      await handlers.getPhoto(get(`/api/media/${photo.result.mediaId}`, other.token), photo.result.mediaId),
    ];
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    await expect(updateFinding(db.app, other, recorded.result.findingId, finding())).rejects.toMatchObject({
      code: "not_found",
    });
    const denied = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "authz.denied")
      .where("actor_user_id", "=", other.userId)
      .where("entity_id", "=", ro)
      .execute();
    expect(denied.length).toBeGreaterThanOrEqual(3);

    const mine = await handlers.getInspection(
      get(`/api/repair-orders/${ro}/inspection`, people.tech!.token),
      ro,
    );
    expect(mine.status).toBe(200);
    const body = await mine.text();
    expect(body).toContain("INTERNAL-TEST-123"); // staff view: internal notes are for staff
    expect(body).not.toContain("0545"); // no customer mobile on the technician's screen
    const myPhoto = await handlers.getPhoto(
      get(`/api/media/${photo.result.mediaId}`, people.tech!.token),
      photo.result.mediaId,
    );
    expect(myPhoto.status).toBe(200);
    expect((await myInspections(db.app, people.tech!.userId)).map((item) => item.repairOrderId)).toContain(
      ro,
    );
    expect((await myInspections(db.app, other.userId)).map((item) => item.repairOrderId)).not.toContain(ro);
  });

  it("a store keeper (no finding rights) is refused", async () => {
    const ro = await newRepairOrder();
    const response = await handlers.getInspection(
      get(`/api/repair-orders/${ro}/inspection`, people.storekeeper!.token),
      ro,
    );
    expect(response.status).toBe(403);
  });

  // --- Findings -----------------------------------------------------------------------------

  it("records a finding with severity, fault codes and both notes; validation names the field", async () => {
    const ro = await newRepairOrder();
    await assignInspection(db.app, people.manager!, ro, people.tech!.userId);
    const { findingId } = (await recordFinding(db.app, people.tech!, ro, finding(), randomUUID())).result;
    const view = await getInspection(db.app, ro);
    expect(view!.findings[0]).toMatchObject({
      id: findingId,
      severity: "urgent",
      faultCodes: ["P0301", "P0420"],
      internalNote: expect.stringContaining("INTERNAL-TEST-123"),
    });

    await expect(
      recordFinding(db.app, people.tech!, ro, finding({ severity: "critical" }), randomUUID()),
    ).rejects.toMatchObject({
      details: { field: "severity" },
    });
    await expect(
      recordFinding(db.app, people.tech!, ro, finding({ title: " " }), randomUUID()),
    ).rejects.toMatchObject({
      details: { field: "title" },
    });
    await expect(
      recordFinding(db.app, people.tech!, ro, finding({ faultCodes: "P0301 <script>" }), randomUUID()),
    ).rejects.toMatchObject({ details: { field: "faultCodes" } });
    await expect(
      recordFinding(db.app, people.tech!, ro, finding({ templateItemId: randomUUID() }), randomUUID()),
    ).rejects.toMatchObject({ details: { field: "templateItemId" } });
  });

  it("a checklist item becomes a finding linked to its template item", async () => {
    const ro = await newRepairOrder();
    const [periodic] = await listChecklistTemplates(db.app);
    const item = periodic!.items[0]!;
    await recordFinding(
      db.app,
      people.advisor!,
      ro,
      { title: item.labelEn, severity: "ok", templateItemId: item.id },
      randomUUID(),
    );
    const view = await getInspection(db.app, ro);
    expect(view!.findings[0]).toMatchObject({ templateItemId: item.id, severity: "ok" });
  });

  it("seeded checklist templates exist in both languages", async () => {
    const templates = await listChecklistTemplates(db.app);
    expect(templates.map((template) => template.code)).toEqual([
      "periodic_service",
      "air_conditioning",
      "electrical",
    ]);
    for (const template of templates) {
      expect(template.nameAr.trim()).not.toBe("");
      expect(template.items.length).toBeGreaterThan(3);
      for (const item of template.items) {
        expect(item.labelEn.trim()).not.toBe("");
        expect(item.labelAr.trim()).not.toBe("");
      }
    }
  });

  it("editing keeps a before/after audit; withdrawing needs a reason and freezes the finding", async () => {
    const ro = await newRepairOrder();
    const { findingId } = (await recordFinding(db.app, people.advisor!, ro, finding(), randomUUID())).result;
    await updateFinding(
      db.app,
      people.advisor!,
      findingId,
      finding({ severity: "soon", title: "Pads worn" }),
    );
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["before_state", "after_state"])
      .where("action", "=", "finding.updated")
      .where("entity_id", "=", findingId)
      .executeTakeFirstOrThrow();
    expect(audit.before_state).toMatchObject({ severity: "urgent", title: "Front brake pads worn" });
    expect(audit.after_state).toMatchObject({ severity: "soon", title: "Pads worn" });

    await expect(withdrawFinding(db.app, people.advisor!, findingId, "  ")).rejects.toMatchObject({
      details: { field: "withdrawnReason" },
    });
    await withdrawFinding(db.app, people.advisor!, findingId, "Duplicate of another finding");
    await expect(updateFinding(db.app, people.advisor!, findingId, finding())).rejects.toMatchObject({
      code: "finding_withdrawn",
    });
    expect((await findingsForEstimate(db.app, ro)).map((f) => f.id)).not.toContain(findingId);
  });

  it("findings for the estimate: active only, urgent first (basis for AC-05.2 in I1-05)", async () => {
    const ro = await newRepairOrder();
    const ok = (
      await recordFinding(
        db.app,
        people.advisor!,
        ro,
        finding({ severity: "ok", title: "Wipers" }),
        randomUUID(),
      )
    ).result.findingId;
    const urgent = (
      await recordFinding(db.app, people.advisor!, ro, finding({ title: "Brakes" }), randomUUID())
    ).result.findingId;
    const soon = (
      await recordFinding(
        db.app,
        people.advisor!,
        ro,
        finding({ severity: "soon", title: "Tyres" }),
        randomUUID(),
      )
    ).result.findingId;
    expect((await findingsForEstimate(db.app, ro)).map((f) => f.id)).toEqual([urgent, soon, ok]);
  });

  // --- AC2-31 pattern and photo visibility (OD-11) -----------------------------------------------

  it("the customer view never carries the internal note; photos appear only when ticked for the customer", async () => {
    const ro = await newRepairOrder();
    const { findingId } = (await recordFinding(db.app, people.advisor!, ro, finding(), randomUUID())).result;
    const internalPhoto = (
      await addFindingPhoto(
        db.app,
        storage,
        people.advisor!,
        { findingId, bytes: makePng(800, 600, 2) },
        randomUUID(),
      )
    ).result.mediaId;
    const sharedPhoto = (
      await addFindingPhoto(
        db.app,
        storage,
        people.advisor!,
        { findingId, bytes: makePng(800, 600, 3) },
        randomUUID(),
      )
    ).result.mediaId;
    await setFindingPhotoVisibility(db.app, people.advisor!, sharedPhoto, "customer");

    const view = await customerFindingsView(db.app, ro);
    const text = JSON.stringify(view);
    expect(text).not.toContain("INTERNAL-TEST-123");
    expect(text).not.toContain(internalPhoto);
    expect(view[0]).toEqual({
      title: "Front brake pads worn",
      severity: "urgent",
      faultCodes: ["P0301", "P0420"],
      note: "Pads at 2 mm; replace soon for safe braking.",
      photoIds: [sharedPhoto],
    });

    await discardFindingPhoto(db.app, people.advisor!, sharedPhoto);
    expect((await customerFindingsView(db.app, ro))[0]!.photoIds).toEqual([]);
  });

  // --- Database guards (as the app role) ---------------------------------------------------------

  it("the app role cannot delete or rewrite findings, assignments or finding photos", async () => {
    const ro = await newRepairOrder();
    await assignInspection(db.app, people.manager!, ro, people.tech!.userId);
    const { findingId } = (await recordFinding(db.app, people.advisor!, ro, finding(), randomUUID())).result;
    const { mediaId } = (
      await addFindingPhoto(
        db.app,
        storage,
        people.advisor!,
        { findingId, bytes: makePng(800, 600, 4) },
        randomUUID(),
      )
    ).result;

    expect((await sqlErrorAs(db.appUrl, `DELETE FROM finding WHERE id = '${findingId}'`))?.code).toBe(
      "42501",
    );
    expect((await sqlErrorAs(db.appUrl, `DELETE FROM inspection_assignment`))?.code).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE finding SET repair_order_id = gen_random_uuid()`))?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE media_asset SET storage_key = 'x' WHERE id = '${mediaId}'`))?.code,
    ).toBe("42501");
    // A finding photo is never locked onto a repair order or excluded.
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE media_asset SET locked_at = now() WHERE id = '${mediaId}'`))?.code,
    ).toBe("42501");
    // Withdrawn findings and ended assignments are frozen.
    await withdrawFinding(db.app, people.advisor!, findingId, "Wrong vehicle");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE finding SET title = 'x' WHERE id = '${findingId}'`))?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE media_asset SET visibility = 'customer' WHERE id = '${mediaId}'`))
        ?.code,
    ).toBe("42501");
    await assignInspection(db.app, people.manager!, ro, people.tech2!.userId);
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE inspection_assignment SET ended_at = NULL WHERE repair_order_id = '${ro}' AND ended_at IS NOT NULL`,
        )
      )?.code,
    ).toBe("42501");
    // Inserting a finding already withdrawn, or assigning a non-technician directly, is refused too.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO finding (repair_order_id, title, severity, status, withdrawn_reason) VALUES ('${ro}', 'x', 'ok', 'withdrawn', 'x')`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO inspection_assignment (repair_order_id, technician_user_id) VALUES ('${ro}', '${people.advisor!.userId}')`,
        )
      )?.code,
    ).toBe("42501");
  });

  it("check-in photo rules are unchanged: their visibility cannot be switched to customer", async () => {
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    // A second check-in on an existing vehicle, with one draft photo to try.
    const ro = await db.app
      .selectFrom("repair_order")
      .select("vehicle_id")
      .where("id", "=", await newRepairOrder())
      .executeTakeFirstOrThrow();
    const draft = (await startCheckIn(db.app, advisor, ro.vehicle_id, randomUUID())).result.checkInId;
    const { mediaId } = (
      await addCheckInPhoto(
        db.app,
        storage,
        advisor,
        { checkInId: draft, slot: "front", bytes: makePng(800, 600, 5) },
        randomUUID(),
      )
    ).result;
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE media_asset SET visibility = 'customer' WHERE id = '${mediaId}'`))
        ?.code,
    ).toBe("42501");
  });

  it("findings freeze once the repair order leaves inspection", async () => {
    const ro = await newRepairOrder();
    const { findingId } = (await recordFinding(db.app, people.advisor!, ro, finding(), randomUUID())).result;
    // Simulate a later stage (later stories move the status through their own commands).
    await db.owner.updateTable("repair_order").set({ status: "cancelled" }).where("id", "=", ro).execute();
    await expect(updateFinding(db.app, people.advisor!, findingId, finding())).rejects.toMatchObject({
      code: "inspection_closed",
    });
    await expect(recordFinding(db.app, people.advisor!, ro, finding(), randomUUID())).rejects.toMatchObject({
      code: "inspection_closed",
    });
  });

  it("recording a finding waits for an in-flight reassignment and then sees the new technician", async () => {
    const ro = await newRepairOrder();
    await assignInspection(db.app, people.manager!, ro, people.tech!.userId);
    // Hold a reassignment to tech2 open; tech (being removed) tries to record meanwhile.
    const gate = deferred();
    const { runCommand } = await import("../src/server/command/runner");
    const reassignment = runCommand(
      db.app,
      {
        name: "test.reassign",
        actor: { kind: "user", userId: people.manager!.userId },
        hooks: { beforeCommit: () => gate.promise },
      },
      async (ctx) => {
        await ctx.locks.acquire("repair_order", [ro]);
        await ctx.tx
          .updateTable("inspection_assignment")
          .set({ ended_at: ctx.txTime, ended_by: people.manager!.userId })
          .where("repair_order_id", "=", ro)
          .where("ended_at", "is", null)
          .execute();
        await ctx.tx
          .insertInto("inspection_assignment")
          .values({
            repair_order_id: ro,
            technician_user_id: people.tech2!.userId,
            assigned_by: people.manager!.userId,
          })
          .execute();
        await ctx.audit({ action: "test.reassigned", entityType: "repair_order", entityId: ro });
        return {};
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const attempt = recordFinding(db.app, people.tech!, ro, finding(), randomUUID()).then(
      () => "ok",
      (error: unknown) => error,
    );
    await waitForLockWaiters(db, 1);
    gate.resolve();
    await reassignment;
    expect(await attempt).toMatchObject({ code: "not_found" });
  });

  // --- Review fixes ------------------------------------------------------------------------------

  it("every finding and photo endpoint answers an unassigned technician 'not found', logs it, and names no id", async () => {
    const ro = await newRepairOrder();
    await assignInspection(db.app, people.manager!, ro, people.tech!.userId);
    const { findingId } = (await recordFinding(db.app, people.advisor!, ro, finding(), randomUUID())).result;
    const { mediaId } = (
      await addFindingPhoto(
        db.app,
        storage,
        people.advisor!,
        { findingId, bytes: makePng(800, 600, 41) },
        randomUUID(),
      )
    ).result;
    const other = people.tech2!;
    const before = await db.app
      .selectFrom("audit_event")
      .select(db.app.fn.countAll<string>().as("n"))
      .where("action", "=", "authz.denied")
      .where("actor_user_id", "=", other.userId)
      .executeTakeFirstOrThrow();

    const form = new FormData();
    form.set("idempotencyKey", randomUUID());
    form.set("photo", new Blob([new Uint8Array(makePng(800, 600, 42))]), "p.png");
    const responses = [
      await handlers.updateFinding(post(`/api/findings/${findingId}`, other.token, finding()), findingId),
      await handlers.withdrawFinding(
        post(`/api/findings/${findingId}/withdraw`, other.token, { reason: "x" }),
        findingId,
      ),
      await handlers.addFindingPhoto(
        new Request(`${BASE}/api/findings/${findingId}/photos`, {
          method: "POST",
          body: form,
          headers: cookie(other.token),
        }),
        findingId,
      ),
      await handlers.setPhotoVisibility(
        post(`/api/media/${mediaId}/visibility`, other.token, { visibility: "customer" }),
        mediaId,
      ),
      // An id that doesn't exist answers exactly the same way.
      await handlers.updateFinding(
        post(`/api/findings/${randomUUID()}`, other.token, finding()),
        randomUUID(),
      ),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found", message: "Not found" });
    }
    const after = await db.app
      .selectFrom("audit_event")
      .select(db.app.fn.countAll<string>().as("n"))
      .where("action", "=", "authz.denied")
      .where("actor_user_id", "=", other.userId)
      .executeTakeFirstOrThrow();
    expect(Number(after.n) - Number(before.n)).toBe(responses.length);
  });

  it("an assigned technician's access ends when the repair order leaves inspection", async () => {
    const ro = await newRepairOrder();
    await assignInspection(db.app, people.manager!, ro, people.tech!.userId);
    expect(
      (await handlers.getInspection(get(`/api/repair-orders/${ro}/inspection`, people.tech!.token), ro))
        .status,
    ).toBe(200);
    await db.owner.updateTable("repair_order").set({ status: "cancelled" }).where("id", "=", ro).execute();
    expect(
      (await handlers.getInspection(get(`/api/repair-orders/${ro}/inspection`, people.tech!.token), ro))
        .status,
    ).toBe(404);
  });

  it("the database keeps the inspection rules when the repair order has moved on", async () => {
    const ro = await newRepairOrder();
    await assignInspection(db.app, people.manager!, ro, people.tech!.userId);
    const { findingId } = (await recordFinding(db.app, people.advisor!, ro, finding(), randomUUID())).result;
    const { mediaId } = (
      await addFindingPhoto(
        db.app,
        storage,
        people.advisor!,
        { findingId, bytes: makePng(800, 600, 43) },
        randomUUID(),
      )
    ).result;
    await db.owner.updateTable("repair_order").set({ status: "cancelled" }).where("id", "=", ro).execute();
    const sql = (statement: string) => sqlErrorAs(db.appUrl, statement).then((error) => error?.code);

    expect(await sql(`UPDATE finding SET title = 'x' WHERE id = '${findingId}'`)).toBe("42501");
    expect(
      await sql(`INSERT INTO finding (repair_order_id, title, severity) VALUES ('${ro}', 'x', 'ok')`),
    ).toBe("42501");
    expect(
      await sql(`INSERT INTO media_asset (finding_id, slot, storage_key, content_type, byte_size, sha256, width, height)
                 VALUES ('${findingId}', 'other', 'photos/aa/y.png', 'image/png', 1, '${"b".repeat(64)}', 1, 1)`),
    ).toBe("42501");
    expect(await sql(`UPDATE media_asset SET visibility = 'customer' WHERE id = '${mediaId}'`)).toBe("42501");
    // No new assignment outside inspection, not even directly.
    expect(
      await sql(
        `INSERT INTO inspection_assignment (repair_order_id, technician_user_id) VALUES ('${ro}', '${people.tech2!.userId}')`,
      ),
    ).toBe("42501");
  });

  it("the database stamps its own times and keeps a withdrawn finding's content", async () => {
    const ro = await newRepairOrder();
    const { findingId } = (await recordFinding(db.app, people.advisor!, ro, finding(), randomUUID())).result;
    const { mediaId } = (
      await addFindingPhoto(
        db.app,
        storage,
        people.advisor!,
        { findingId, bytes: makePng(800, 600, 44) },
        randomUUID(),
      )
    ).result;
    const sql = (statement: string) => sqlErrorAs(db.appUrl, statement).then((error) => error?.code);

    expect(
      await sql(`UPDATE finding SET updated_at = '2000-01-01' WHERE id = '${findingId}'`),
    ).toBeUndefined();
    expect(
      await sql(`UPDATE media_asset SET discarded_at = '2000-01-01' WHERE id = '${mediaId}'`),
    ).toBeUndefined();
    const row = await db.app
      .selectFrom("finding")
      .select("updated_at")
      .where("id", "=", findingId)
      .executeTakeFirstOrThrow();
    const photo = await db.app
      .selectFrom("media_asset")
      .select("discarded_at")
      .where("id", "=", mediaId)
      .executeTakeFirstOrThrow();
    expect(row.updated_at.getFullYear()).toBeGreaterThan(2020);
    expect(photo.discarded_at!.getFullYear()).toBeGreaterThan(2020);

    expect(
      await sql(
        `UPDATE finding SET status = 'withdrawn', withdrawn_reason = 'x', title = 'Rewritten' WHERE id = '${findingId}'`,
      ),
    ).toBe("42501");
  });

  it("a checklist item is recorded once per repair order; withdrawing frees it (T-12)", async () => {
    const ro = await newRepairOrder();
    const [periodic] = await listChecklistTemplates(db.app);
    const item = periodic!.items[1]!;
    const record = () =>
      recordFinding(
        db.app,
        people.advisor!,
        ro,
        { title: item.labelEn, severity: "soon", templateItemId: item.id },
        randomUUID(),
      );
    const { findingId } = (await record()).result;
    await expect(record()).rejects.toMatchObject({ code: "item_already_recorded" });
    await withdrawFinding(db.app, people.advisor!, findingId, "Recorded on the wrong vehicle");
    await expect(record()).resolves.toMatchObject({ replayed: false });
  });

  it("recording a finding twice with the same key replays it", async () => {
    const ro = await newRepairOrder();
    const key = randomUUID();
    const first = await recordFinding(db.app, people.advisor!, ro, finding(), key);
    const again = await recordFinding(db.app, people.advisor!, ro, finding(), key);
    expect(again).toMatchObject({ replayed: true, result: first.result });
    expect((await getInspection(db.app, ro))!.findings).toHaveLength(1);
  });
});
