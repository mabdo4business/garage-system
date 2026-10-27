import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { uniqueDigits } from "./fixtures";
import { addItem, checkedInRepairOrder, pageFor, taxSetUp } from "./estimate-helpers";

/**
 * I2-01 in a real browser: version 1 partly approved, withdrawn for no response, version 2 offers the lapsed job
 * again; the customer sees the earlier approval as context and decides the new one; the history reads in Arabic.
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

test("withdraw a partly approved version, offer the lapsed job again in version 2, approve it", async ({
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
    nameEn: "Workshop labour",
    nameAr: "عمالة الورشة",
  });
  const itemId = manager.url().split("/").pop()!;

  const advisor = await pageFor(browser, "advisor");
  const ro = await checkedInRepairOrder(advisor);
  const post = (path: string, data: Record<string, unknown> = {}) =>
    advisor.request.post(path, { data: { idempotencyKey: randomUUID(), ...data } });
  expect((await post(`/api/repair-orders/${ro}/estimate`)).ok()).toBe(true);
  for (const title of ["Front brakes", "AC service"]) {
    expect((await post(`/api/repair-orders/${ro}/estimate/jobs`, { title })).ok()).toBe(true);
  }
  const view = await (await advisor.request.get(`/api/repair-orders/${ro}/estimate`)).json();
  for (const job of view.jobs) {
    expect((await post(`/api/repair-jobs/${job.id}/lines`, { itemId, qty: "1" })).ok()).toBe(true);
  }
  expect((await post(`/api/repair-orders/${ro}/estimate/send`)).ok()).toBe(true);

  // v1: the customer approves the brakes only; the AC stays undecided.
  await advisor.goto(`/en/repair-orders/${ro}/estimate/approve`);
  const choice = (title: string) => advisor.locator("fieldset.approval-choice").filter({ hasText: title });
  await choice("Front brakes").locator("label.choice-approved").click();
  await advisor.locator("#approverName").fill("Omar Saeed");
  await sign(advisor);
  await advisor.getByRole("button", { name: "Confirm decision" }).click();
  await expect(advisor).toHaveURL(new RegExp(`/en/repair-orders/${ro}/estimate$`));

  // Withdraw v1: the customer never answered on the AC.
  await advisor.locator("summary", { hasText: "Withdraw this version" }).click();
  await advisor.locator("select[name=reasonCode]").selectOption("no_response");
  await advisor.locator("details[open]").getByRole("button", { name: "Withdraw this version" }).click();
  await expect(advisor.locator(".page-header")).toContainText("Withdrawn");
  const card = (heading: string) =>
    advisor.locator(".card").filter({ has: advisor.getByRole("heading", { name: heading, exact: true }) });
  // v1 is still the latest version: its jobs show their outcome.
  await expect(card("Front brakes")).toContainText("Approved");
  await expect(card("AC service")).toContainText("Lapsed");

  // v2: offer the AC again; the brakes are shown as approved earlier.
  await advisor.getByRole("button", { name: "Start version 2" }).click();
  await expect(advisor.locator(".estimate-versions")).toContainText(
    "v1 · Withdrawn · No response from customer",
  );
  await expect(card("Approved earlier")).toContainText("Front brakes");
  const notApproved = card("Declined or lapsed");
  await expect(notApproved).toContainText("AC service");
  await expect(notApproved).toContainText("version withdrawn");
  await notApproved.getByRole("button", { name: "Offer again" }).click();
  await expect(
    advisor.locator(".card").filter({ has: advisor.getByRole("heading", { name: "AC service" }) }),
  ).toContainText("200.00");
  await advisor.getByRole("button", { name: "Present to customer" }).click();
  await expect(advisor).toHaveURL(new RegExp(`/en/repair-orders/${ro}/estimate/approve$`));

  // The customer sees the brakes as already approved (no choice), and decides the AC.
  const context = advisor.locator(".estimate-document-context");
  await expect(context).toContainText("Already approved");
  await expect(context).toContainText("Front brakes");
  await expect(context.locator("input, button, select")).toHaveCount(0);
  await expect(advisor.locator("fieldset.approval-choice")).toHaveCount(1);
  await choice("AC service").locator("label.choice-approved").click();
  await advisor.locator("#approverName").fill("Omar Saeed");
  await sign(advisor);
  await advisor.getByRole("button", { name: "Confirm decision" }).click();
  await expect(advisor).toHaveURL(new RegExp(`/en/repair-orders/${ro}/estimate$`));
  await expect(advisor.locator(".page-header")).toContainText("Closed");

  // The history in Arabic.
  await advisor.goto(`/ar/repair-orders/${ro}/estimate`);
  await expect(advisor.locator("html")).toHaveAttribute("dir", "rtl");
  const versions = advisor.locator(".estimate-versions");
  await expect(versions).toContainText("الإصدار 1");
  await expect(versions).toContainText("لم يرد العميل");
  await expect(versions).toContainText("الإصدار 2");
});
