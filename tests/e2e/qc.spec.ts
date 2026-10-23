import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { makePng } from "../helpers/images";
import { uniqueDigits } from "./fixtures";
import { checkedInRepairOrder, pageFor, taxSetUp } from "./estimate-helpers";

/**
 * I1-08 in a real browser: the technician requests QC from the job card; a manager fails it and returns the job;
 * the technician redoes it and requests again; the manager passes it in Arabic.
 */

const post = (page: Page, path: string, data: Record<string, unknown> = {}) =>
  page.request.post(path, { data: { idempotencyKey: randomUUID(), ...data } });

async function approvedJob(
  advisor: Page,
  manager: Page,
  ro: string,
  taxCode: string,
): Promise<{ jobId: string; lineId: string }> {
  const item = await (
    await post(manager, "/api/catalogue", {
      kind: "labor_rate",
      code: `QC-${uniqueDigits(6)}`,
      price: "150",
      taxCode,
      nameEn: "Brake labour",
      nameAr: "عمالة الفرامل",
    })
  ).json();
  expect((await post(advisor, `/api/repair-orders/${ro}/estimate`)).ok()).toBe(true);
  const job = await (
    await post(advisor, `/api/repair-orders/${ro}/estimate/jobs`, { title: "Brake service" })
  ).json();
  const line = await (
    await post(advisor, `/api/repair-jobs/${job.jobId}/lines`, { itemId: item.itemId, qty: "1" })
  ).json();
  const sent = await (await post(advisor, `/api/repair-orders/${ro}/estimate/send`)).json();
  const view = await (await advisor.request.get(`/api/repair-orders/${ro}/estimate`)).json();
  const approval = await advisor.request.post(`/api/estimate-versions/${sent.versionId}/approvals`, {
    multipart: {
      contentHash: sent.contentHash,
      language: "en",
      approverName: "QC Customer",
      idempotencyKey: randomUUID(),
      [`decision.${view.jobs[0].revisionId}`]: "approved",
      signature: { name: "signature.png", mimeType: "image/png", buffer: Buffer.from(makePng(300, 100, 9)) },
    },
  });
  expect(approval.ok()).toBe(true);
  return { jobId: job.jobId, lineId: line.lineId };
}

async function doTheWork(tech: Page, jobId: string, lineId: string) {
  expect((await post(tech, `/api/jobs/${jobId}/start`)).ok()).toBe(true);
  const done = await post(tech, `/api/jobs/${jobId}/complete`, {
    lines: [{ lineId, outcome: "done" }],
    note: "Done",
  });
  expect(done.ok()).toBe(true);
}

test("technician requests QC; manager fails it and the job is redone; then QC passes (Arabic)", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const partner = await pageFor(browser, "partner");
  const taxCode = await taxSetUp(partner);
  const manager = await pageFor(browser, "manager");
  const advisor = await pageFor(browser, "advisor");
  const ro = await checkedInRepairOrder(advisor);
  const { jobId, lineId } = await approvedJob(advisor, manager, ro, taxCode);

  await manager.goto("/en/workshop");
  const techId = await manager
    .locator(`li[data-job="${jobId}"] select[name=assigneeId] option`, { hasText: "Tariq Technician" })
    .getAttribute("value");
  expect((await post(manager, `/api/jobs/${jobId}/assign`, { assigneeId: techId })).ok()).toBe(true);

  const tech = await pageFor(browser, "technician");
  await doTheWork(tech, jobId, lineId);
  await tech.goto(`/en/jobs/${jobId}`);
  await tech.getByRole("button", { name: "Request QC" }).click();
  // Done when the button is gone (the repair order is in QC now).
  await expect(tech.getByRole("button", { name: "Request QC" })).toHaveCount(0);

  // Manager fails it, returning the job.
  await manager.goto(`/en/repair-orders/${ro}/qc`);
  const fail = manager.locator(".card").filter({ has: manager.getByRole("heading", { name: "Fail QC" }) });
  await fail.locator(`input[name=jobIds][value="${jobId}"]`).check();
  await fail.locator("#fail-notes").fill("Brake squeal on the road test");
  await fail.getByRole("button", { name: "Fail QC" }).click();
  await expect(manager.locator("main")).toContainText("QC failed — work returned");

  // The technician sees the job back with the reason, redoes it, requests again.
  await tech.goto(`/en/jobs/${jobId}`);
  await expect(tech.locator(".page-header")).toContainText("Approved");
  await expect(tech.locator("main")).toContainText("Brake squeal on the road test");
  await doTheWork(tech, jobId, lineId);
  await tech.goto(`/en/jobs/${jobId}`);
  await tech.getByRole("button", { name: "Request QC" }).click();
  // Done when the button is gone (the repair order is in QC now).
  await expect(tech.getByRole("button", { name: "Request QC" })).toHaveCount(0);

  // Manager passes it, in Arabic.
  await manager.goto(`/ar/repair-orders/${ro}/qc`);
  await expect(manager.locator("html")).toHaveAttribute("dir", "rtl");
  const pass = manager
    .locator(".card")
    .filter({ has: manager.getByRole("heading", { name: "اجتياز فحص الجودة" }) });
  for (const name of ["noNewWarningLights", "fluidsOk", "cleanlinessOk", "belongingsOk"]) {
    await pass.locator(`input[name=${name}]`).check();
  }
  await pass.locator("input[name=roadTest][value=done]").check({ force: true });
  await pass.locator("#odometerOutKm").fill("61020");
  await pass.locator("#oldParts").selectOption("returned_to_customer");
  await pass.getByRole("button", { name: "اجتياز فحص الجودة" }).click();
  await expect(manager.locator("main")).toContainText("اجتاز فحص الجودة");

  await advisor.goto(`/en/repair-orders/${ro}`);
  await expect(advisor.locator("main")).toContainText("QC passed");
  // Technicians never decide QC.
  expect((await tech.goto(`/en/repair-orders/${ro}/qc`))?.status()).toBe(404);
});
