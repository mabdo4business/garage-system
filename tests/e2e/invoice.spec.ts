import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { makePng } from "../helpers/images";
import { uniqueDigits } from "./fixtures";
import { checkedInRepairOrder, pageFor, taxSetUp } from "./estimate-helpers";

/** I1-09a in a real browser: after QC passes, the advisor prepares and issues the invoice; Arabic; Ready. */

const post = (page: Page, path: string, data: Record<string, unknown> = {}) =>
  page.request.post(path, { data: { idempotencyKey: randomUUID(), ...data } });

test("advisor prepares and issues the invoice after QC; the repair order becomes Ready", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const partner = await pageFor(browser, "partner");
  const taxCode = await taxSetUp(partner);
  const manager = await pageFor(browser, "manager");
  const advisor = await pageFor(browser, "advisor");
  const tech = await pageFor(browser, "technician");
  const ro = await checkedInRepairOrder(advisor);

  // Set-up through the API: one approved job with a labour line, done, QC passed.
  const item = await (
    await post(manager, "/api/catalogue", {
      kind: "labor_rate",
      code: `INV-${uniqueDigits(6)}`,
      price: "210",
      taxCode,
      nameEn: "Engine service",
      nameAr: "صيانة المحرك",
    })
  ).json();
  expect((await post(advisor, `/api/repair-orders/${ro}/estimate`)).ok()).toBe(true);
  const job = await (
    await post(advisor, `/api/repair-orders/${ro}/estimate/jobs`, { title: "Engine service" })
  ).json();
  const line = await (
    await post(advisor, `/api/repair-jobs/${job.jobId}/lines`, { itemId: item.itemId, qty: "1" })
  ).json();
  const sent = await (await post(advisor, `/api/repair-orders/${ro}/estimate/send`)).json();
  const view = await (await advisor.request.get(`/api/repair-orders/${ro}/estimate`)).json();
  expect(
    (
      await advisor.request.post(`/api/estimate-versions/${sent.versionId}/approvals`, {
        multipart: {
          contentHash: sent.contentHash,
          language: "en",
          approverName: "Invoice Customer",
          idempotencyKey: randomUUID(),
          [`decision.${view.jobs[0].revisionId}`]: "approved",
          signature: {
            name: "signature.png",
            mimeType: "image/png",
            buffer: Buffer.from(makePng(300, 100, 11)),
          },
        },
      })
    ).ok(),
  ).toBe(true);
  await manager.goto("/en/workshop");
  const techId = await manager
    .locator(`li[data-job="${job.jobId}"] select[name=assigneeId] option`, { hasText: "Tariq Technician" })
    .getAttribute("value");
  expect((await post(manager, `/api/jobs/${job.jobId}/assign`, { assigneeId: techId })).ok()).toBe(true);
  expect((await post(tech, `/api/jobs/${job.jobId}/start`)).ok()).toBe(true);
  expect(
    (
      await post(tech, `/api/jobs/${job.jobId}/complete`, {
        lines: [{ lineId: line.lineId, outcome: "done" }],
        note: "Done",
      })
    ).ok(),
  ).toBe(true);
  expect((await post(tech, `/api/repair-orders/${ro}/qc/request`)).ok()).toBe(true);
  expect(
    (
      await post(partner, `/api/repair-orders/${ro}/qc/pass`, {
        noNewWarningLights: true,
        roadTest: "done",
        odometerOutKm: "61050",
        fluidsOk: true,
        cleanlinessOk: true,
        belongingsOk: true,
        oldParts: "none_replaced",
      })
    ).ok(),
  ).toBe(true);

  // The advisor prepares the invoice and issues it, in Arabic.
  await advisor.goto(`/ar/repair-orders/${ro}`);
  await expect(advisor.locator("html")).toHaveAttribute("dir", "rtl");
  await advisor.getByRole("button", { name: "إعداد الفاتورة" }).click();
  const card = advisor.locator(".card").filter({ has: advisor.getByRole("heading", { name: "الفاتورة" }) });
  await expect(card).toContainText("صيانة المحرك");
  await expect(card).toContainText("210.00");
  await card.getByRole("button", { name: "إصدار الفاتورة" }).click();
  await expect(advisor).toHaveURL(/\/ar\/invoices\/[0-9a-f-]{36}$/);
  await expect(advisor.locator(".page-header")).toContainText(/INV-\d{6}/);
  await expect(advisor.locator("main")).toContainText("210.00");
  await expect(advisor.locator("main")).toContainText("100123456700003"); // TRN of the registered profile

  await advisor.goto(`/en/repair-orders/${ro}`);
  await expect(advisor.locator(".page-header")).toContainText("Ready");
  // Technicians never see invoices.
  const invoiceUrl = (await (await advisor.request.get(`/api/repair-orders/${ro}/invoice`)).json()).invoice
    .id;
  expect((await tech.goto(`/en/invoices/${invoiceUrl}`))?.status()).toBe(404);
});
