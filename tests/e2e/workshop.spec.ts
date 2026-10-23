import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { makePng } from "../helpers/images";
import { uniqueDigits } from "./fixtures";
import { addItem, checkedInVehicle, pageFor, taxSetUp } from "./estimate-helpers";

/**
 * I1-06 in a real browser: manager assigns an approved job on the board; the technician starts, pauses, resumes
 * and completes it in Arabic without seeing a price; another technician gets "not found"; OQ-1 at check-in.
 */

/** Builds and approves a one-job estimate through the API (the estimate screens have their own specs). */
async function approvedJob(advisor: Page, ro: string, itemId: string): Promise<string> {
  const post = (path: string, data: Record<string, unknown>) =>
    advisor.request.post(path, { data: { idempotencyKey: randomUUID(), ...data } });
  expect((await post(`/api/repair-orders/${ro}/estimate`, {})).ok()).toBe(true);
  const job = await (await post(`/api/repair-orders/${ro}/estimate/jobs`, { title: "Brake service" })).json();
  expect((await post(`/api/repair-jobs/${job.jobId}/lines`, { itemId, qty: "1.5" })).ok()).toBe(true);
  const sent = await (await post(`/api/repair-orders/${ro}/estimate/send`, {})).json();
  const view = await (await advisor.request.get(`/api/repair-orders/${ro}/estimate`)).json();
  const approval = await advisor.request.post(`/api/estimate-versions/${sent.versionId}/approvals`, {
    multipart: {
      contentHash: sent.contentHash,
      language: "en",
      approverName: "Workshop Customer",
      idempotencyKey: randomUUID(),
      [`decision.${view.jobs[0].revisionId}`]: "approved",
      signature: { name: "signature.png", mimeType: "image/png", buffer: Buffer.from(makePng(300, 100, 5)) },
    },
  });
  expect(approval.ok()).toBe(true);
  return job.jobId;
}

test("manager assigns on the board; the technician runs the job in Arabic, without prices", async ({
  browser,
}) => {
  test.setTimeout(90_000); // tax set-up, pricing, check-in, approval, then the workshop flow
  const partner = await pageFor(browser, "partner");
  const taxCode = await taxSetUp(partner);
  const manager = await pageFor(browser, "manager");
  const code = `LAB-${uniqueDigits(6)}`;
  await addItem(manager, "labor_rate", {
    code,
    price: "150",
    taxCode,
    nameEn: "Brake labour",
    nameAr: "عمالة الفرامل",
  });
  const itemId = manager.url().split("/").pop()!;

  const advisor = await pageFor(browser, "advisor");
  const { ro, vehicleId } = await checkedInVehicle(advisor);
  const jobId = await approvedJob(advisor, ro, itemId);

  // Board: the approved job in the In progress column; the manager assigns it with a bay.
  await manager.goto("/en/workshop");
  const column = manager
    .locator(".board-column")
    .filter({ has: manager.getByRole("heading", { name: /In progress/ }) });
  const job = column.locator(`li[data-job="${jobId}"]`);
  await expect(job).toContainText("Approved");
  await job.locator("summary", { hasText: "Assign" }).click();
  await job.locator("select[name=assigneeId]").selectOption({ label: "Tariq Technician · Technician" });
  await job.locator("input[name=bay]").fill("Bay 3");
  await job.getByRole("button", { name: "Assign" }).click();
  await expect(manager.locator(`li[data-job="${jobId}"]`)).toContainText("Tariq Technician");
  await expect(manager.locator(`li[data-job="${jobId}"]`)).toContainText("Bay 3");

  // Technician, in Arabic.
  const tech = await pageFor(browser, "technician", "ar");
  await tech.getByRole("link", { name: "أعمالي" }).click();
  await tech.locator(`.result-list a[href$="/jobs/${jobId}"]`).click();
  await expect(tech).toHaveURL(new RegExp(`/ar/jobs/${jobId}$`));
  await expect(tech.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(tech.locator("main")).toContainText("عمالة الفرامل");
  await expect(tech.locator("main")).not.toContainText("150");
  await expect(tech.locator("main")).not.toContainText("درهم");

  await tech.getByRole("button", { name: "بدء العمل" }).click();
  await expect(tech.locator(".page-header")).toContainText("قيد التنفيذ");
  await tech.locator("summary", { hasText: "إيقاف مؤقت" }).click();
  await tech.locator("#pauseReason").fill("بانتظار قرار العميل");
  await tech.getByRole("button", { name: "إيقاف مؤقت" }).click();
  await expect(tech.locator(".page-header")).toContainText("متوقف مؤقتًا");
  await tech.getByRole("button", { name: "استئناف العمل" }).click();
  await expect(tech.locator(".page-header")).toContainText("قيد التنفيذ");
  await tech.locator("label.choice-approved").first().click();
  await tech.locator("#note").fill("تم تنظيف الفرامل");
  await tech.getByRole("button", { name: "تسجيل اكتمال العمل" }).click();
  await expect(tech.locator(".page-header")).toContainText("مكتمل");
  await expect(tech.locator("main")).toContainText("بانتظار قرار العميل"); // history keeps the pause reason

  await manager.goto("/en/workshop");
  await expect(manager.locator(`li[data-job="${jobId}"]`)).toContainText("Done");

  // AC2-30: another technician gets "not found".
  const other = await pageFor(browser, "technician2");
  expect((await other.goto(`/en/jobs/${jobId}`))?.status()).toBe(404);

  // OQ-1: checking the same vehicle in again warns and needs a confirmation.
  await advisor.goto(`/en/vehicles/${vehicleId}`);
  await advisor.getByRole("button", { name: "Check in this vehicle" }).click();
  await expect(advisor).toHaveURL(/\/en\/check-ins\//);
  await expect(
    advisor.locator(".alert-warning").filter({ hasText: "already has an open repair order" }),
  ).toBeVisible();
  await advisor.locator("#odometerKm").fill("61100");
  await advisor.locator("#concerns").fill("Rattle from the rear");
  await advisor.locator("#photoShortfallReason").fill("Photos taken on the workshop camera");
  await advisor.getByRole("button", { name: "Complete check-in" }).click();
  await expect(advisor.locator(".alert-danger")).toContainText("another open repair order");
  await advisor.locator("input[name=confirmOpenRepairOrder]").check();
  await advisor.getByRole("button", { name: "Complete check-in" }).click();
  await expect(advisor).toHaveURL(/\/en\/repair-orders\/[0-9a-f-]{36}$/);
  expect(advisor.url()).not.toContain(ro);
});
