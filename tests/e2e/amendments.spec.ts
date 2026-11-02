import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { uniqueDigits } from "./fixtures";
import { addItem, checkedInRepairOrder, pageFor, taxSetUp } from "./estimate-helpers";

/**
 * I2-02a in a real browser: an approved job's labour is raised in version 2 (a price change). The draft shows what
 * the new line replaces and the difference; the customer sees the approved work as context and decides the change;
 * the estimate reads in Arabic afterwards.
 */

async function sign(page: Page) {
  const pad = page.locator("canvas.signature-pad");
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 120);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(box.x + 30 + step * 25, box.y + 120 - (step % 2) * 50);
  }
  await page.mouse.up();
}

test("change approved work in version 2: the labour is raised and approved, the earlier approval stays", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const partner = await pageFor(browser, "partner");
  const taxCode = await taxSetUp(partner);
  const manager = await pageFor(browser, "manager");
  await addItem(manager, "labor_rate", {
    code: `LAB-${uniqueDigits(6)}`,
    price: "200",
    taxCode,
    nameEn: "Brake labour",
    nameAr: "عمالة الفرامل",
  });
  const itemId = manager.url().split("/").pop()!;

  const advisor = await pageFor(browser, "advisor");
  const ro = await checkedInRepairOrder(advisor);
  const post = (path: string, data: Record<string, unknown> = {}) =>
    advisor.request.post(path, { data: { idempotencyKey: randomUUID(), ...data } });
  expect((await post(`/api/repair-orders/${ro}/estimate`)).ok()).toBe(true);
  expect((await post(`/api/repair-orders/${ro}/estimate/jobs`, { title: "Front brakes" })).ok()).toBe(true);
  const view = await (await advisor.request.get(`/api/repair-orders/${ro}/estimate`)).json();
  expect((await post(`/api/repair-jobs/${view.jobs[0].id}/lines`, { itemId, qty: "1" })).ok()).toBe(true);
  expect((await post(`/api/repair-orders/${ro}/estimate/send`)).ok()).toBe(true);

  // v1 approved at the counter.
  await advisor.goto(`/en/repair-orders/${ro}/estimate/approve`);
  const choice = (title: string) => advisor.locator("fieldset.approval-choice").filter({ hasText: title });
  await choice("Front brakes").locator("label.choice-approved").click();
  await advisor.locator("#approverName").fill("Omar Saeed");
  await sign(advisor);
  await advisor.getByRole("button", { name: "Confirm decision" }).click();
  await expect(advisor).toHaveURL(new RegExp(`/en/repair-orders/${ro}/estimate$`));

  // v2: change the approved job — 1.5 hours instead of 1.
  await advisor.getByRole("button", { name: "Start version 2" }).click();
  const card = (heading: string) =>
    advisor.locator(".card").filter({ has: advisor.getByRole("heading", { name: heading, exact: true }) });
  await card("Approved earlier").getByRole("button", { name: "Change this job" }).click();
  const job = card("Front brakes");
  await expect(job).toContainText("Change to approved work");
  await job.locator("summary", { hasText: "Replace an approved line" }).click();
  const row = job.locator(".replace-lines li").first();
  await row.locator("input[name=qty]").fill("1.5");
  await row.getByRole("button", { name: "Replace" }).click();
  const changed = card("Front brakes");
  await expect(changed).toContainText("Replaces:");
  await expect(changed).toContainText("300.00");
  await expect(changed.locator(".estimate-job-difference")).toContainText("100.00");
  await advisor.getByRole("button", { name: "Present to customer" }).click();
  await expect(advisor).toHaveURL(new RegExp(`/en/repair-orders/${ro}/estimate/approve$`));

  // The customer: the 200.00 approved earlier as context, the price change to decide.
  const context = advisor.locator(".estimate-document-context");
  await expect(context).toContainText("Front brakes");
  await expect(context.locator("input, button, select")).toHaveCount(0);
  await expect(advisor.locator(".estimate-document-job")).toContainText("Price change");
  await expect(advisor.locator(".estimate-document-job")).toContainText("Replaces:");
  await choice("Front brakes").locator("label.choice-approved").click();
  await advisor.locator("#approverName").fill("Omar Saeed");
  await sign(advisor);
  await advisor.getByRole("button", { name: "Confirm decision" }).click();
  await expect(advisor).toHaveURL(new RegExp(`/en/repair-orders/${ro}/estimate$`));
  await expect(advisor.locator(".page-header")).toContainText("Closed");

  // In Arabic.
  await advisor.goto(`/ar/repair-orders/${ro}/estimate`);
  await expect(advisor.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(advisor.locator("main")).toContainText("تغيير في السعر");
  await expect(advisor.locator("main")).toContainText("بدلاً من:");
});
