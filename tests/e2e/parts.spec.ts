import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { makePng } from "../helpers/images";
import { uniqueDigits } from "./fixtures";
import { checkedInRepairOrder, pageFor, taxSetUp } from "./estimate-helpers";

/**
 * I1-07 in a real browser: the store keeper receives stock and issues it to an approved part line, records a
 * non-stock item's supplier cost (receive-and-issue), and the technician sees what arrived without any cost.
 */

async function item(manager: Page, data: Record<string, unknown>): Promise<string> {
  const response = await manager.request.post("/api/catalogue", {
    data: { idempotencyKey: randomUUID(), ...data },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { itemId: string }).itemId;
}

/** A one-job estimate with the given part lines, approved in person, through the API. */
async function approvedJob(advisor: Page, ro: string, lines: { itemId: string; qty: string }[]) {
  const post = (path: string, data: Record<string, unknown>) =>
    advisor.request.post(path, { data: { idempotencyKey: randomUUID(), ...data } });
  expect((await post(`/api/repair-orders/${ro}/estimate`, {})).ok()).toBe(true);
  const job = await (await post(`/api/repair-orders/${ro}/estimate/jobs`, { title: "Brake service" })).json();
  for (const line of lines) expect((await post(`/api/repair-jobs/${job.jobId}/lines`, line)).ok()).toBe(true);
  const sent = await (await post(`/api/repair-orders/${ro}/estimate/send`, {})).json();
  const view = await (await advisor.request.get(`/api/repair-orders/${ro}/estimate`)).json();
  const approval = await advisor.request.post(`/api/estimate-versions/${sent.versionId}/approvals`, {
    multipart: {
      contentHash: sent.contentHash,
      language: "en",
      approverName: "Parts Customer",
      idempotencyKey: randomUUID(),
      [`decision.${view.jobs[0].revisionId}`]: "approved",
      signature: { name: "signature.png", mimeType: "image/png", buffer: Buffer.from(makePng(300, 100, 6)) },
    },
  });
  expect(approval.ok()).toBe(true);
  const lineIds = (view.jobs[0].lines as { id: string }[]).map((line) => line.id);
  return { jobId: job.jobId as string, lineIds };
}

test("store keeper receives stock, issues it to a job and records a non-stock cost; no cost for technicians", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const partner = await pageFor(browser, "partner");
  const taxCode = await taxSetUp(partner);
  const manager = await pageFor(browser, "manager");
  const padCode = `PAD-${uniqueDigits(6)}`;
  const pad = await item(manager, {
    kind: "part",
    code: padCode,
    price: "120",
    taxCode,
    nameEn: "Brake pad set",
    nameAr: "طقم فحمات",
    unit: "set",
    stockTracked: true,
  });
  const machining = await item(manager, {
    kind: "part",
    code: `MCH-${uniqueDigits(6)}`,
    price: "600",
    taxCode,
    nameEn: "Disc machining",
    nameAr: "خراطة الأقراص",
    unit: "job",
    stockTracked: false,
  });
  const advisor = await pageFor(browser, "advisor");
  const ro = await checkedInRepairOrder(advisor);
  const { jobId, lineIds } = await approvedJob(advisor, ro, [
    { itemId: pad, qty: "1" },
    { itemId: machining, qty: "1" },
  ]);

  // Receive 3 sets for 10.00 (excl. VAT).
  const store = await pageFor(browser, "storekeeper", "ar");
  await store.goto("/en/stock");
  await store.locator("#itemId").selectOption({ label: `${padCode} · Brake pad set` });
  await store.locator("#qty").fill("3");
  await store.locator("#amount").fill("10");
  await store.locator("#supplierName").fill("Al Futtaim Parts");
  await store.locator("#supplierRef").fill("INV-5512");
  await store.getByRole("button", { name: "Receive stock" }).click();
  const row = store.locator("tbody tr").filter({ hasText: padCode });
  await expect(row).toContainText("3");
  await expect(row).toContainText("10.00");

  // Parts for jobs, in Arabic: issue the pad, receive-and-issue the machining.
  await store.goto("/ar/parts");
  await expect(store.locator("html")).toHaveAttribute("dir", "rtl");
  const padLine = store.locator(`li[data-line="${lineIds[0]}"]`);
  await padLine.locator("summary", { hasText: "صرف من المخزون" }).click();
  await padLine.getByRole("button", { name: "صرف من المخزون" }).click();
  await expect(store.locator(`li[data-line="${lineIds[0]}"]`)).toContainText("تم استلام 1 من 1");
  const machLine = store.locator(`li[data-line="${lineIds[1]}"]`);
  await expect(machLine.locator("summary", { hasText: "صرف من المخزون" })).toHaveCount(0); // non-stock: no shelf issue
  await machLine.locator("summary", { hasText: "استلام وصرف" }).click();
  await machLine.locator("input[name=qty]").fill("1");
  await machLine.locator("input[name=amount]").fill("420");
  await machLine.locator("input[name=supplierName]").fill("Sharjah Machining");
  await machLine.locator("input[name=supplierRef]").fill("SM-114");
  await machLine.getByRole("button", { name: "استلام وصرف" }).click();
  await expect(store.locator(`li[data-line="${lineIds[1]}"]`)).toContainText("420.00");

  // Stock now 2 sets; the job's technician sees what arrived, never what it cost.
  await store.goto("/en/stock");
  await expect(store.locator("tbody tr").filter({ hasText: padCode })).toContainText("6.67");
  await manager.request.post(`/api/jobs/${jobId}/assign`, {
    data: { idempotencyKey: randomUUID(), assigneeId: await technicianId(manager) },
  });
  const tech = await pageFor(browser, "technician");
  await tech.goto(`/en/jobs/${jobId}`);
  await expect(tech.locator("main")).toContainText("Parts received: 1");
  await expect(tech.locator("main")).not.toContainText("420");
  await expect(tech.locator("main")).not.toContainText("3.33");
  expect((await tech.goto("/en/stock"))?.status()).toBe(404);
});

/** The e2e technician's user id, read from the board's assign form. */
async function technicianId(manager: Page): Promise<string> {
  await manager.goto("/en/workshop");
  const option = manager.locator("select[name=assigneeId] option", { hasText: "Tariq Technician" }).first();
  return (await option.getAttribute("value"))!;
}
