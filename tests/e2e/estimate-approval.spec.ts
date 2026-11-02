import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { uniqueDigits } from "./fixtures";
import { addItem, checkedInRepairOrder, pageFor, taxSetUp } from "./estimate-helpers";

/** I1-05b in a real browser: present the estimate, customer decides per job and signs (Arabic), work authorized. */

test("advisor presents the estimate; the customer approves one job, declines the other and signs", async ({
  browser,
}) => {
  test.setTimeout(120_000); // the longest flow: tax set-up, pricing, check-in, estimate, decision
  const partner = await pageFor(browser, "partner");
  const taxCode = await taxSetUp(partner);
  const manager = await pageFor(browser, "manager");
  const labor = `LAB-${uniqueDigits(6)}`;
  await addItem(manager, "labor_rate", {
    code: labor,
    price: "150",
    taxCode,
    nameEn: "Workshop labour",
    nameAr: "عمالة الورشة",
  });

  const advisor = await pageFor(browser, "advisor");
  const ro = await checkedInRepairOrder(advisor);
  const itemId = manager.url().split("/").pop()!;
  // Set-up through the API (the finding and estimate screens have their own specs): an urgent finding becomes
  // the first job (AC-05.2), then an AC job; each gets a labour line.
  const post = (path: string, data: Record<string, unknown>) =>
    advisor.request.post(path, { data: { idempotencyKey: randomUUID(), ...data } });
  expect(
    (
      await post(`/api/repair-orders/${ro}/findings`, { title: "Brake pads at 2 mm", severity: "urgent" })
    ).ok(),
  ).toBe(true);
  expect((await post(`/api/repair-orders/${ro}/estimate`, {})).ok()).toBe(true);
  expect((await post(`/api/repair-orders/${ro}/estimate/jobs`, { title: "AC service" })).ok()).toBe(true);
  const view = await (await advisor.request.get(`/api/repair-orders/${ro}/estimate`)).json();
  for (const [job, qty] of [
    [view.jobs[0].id, "1.5"],
    [view.jobs[1].id, "1"],
  ]) {
    expect((await post(`/api/repair-jobs/${job}/lines`, { itemId, qty })).ok()).toBe(true);
  }
  await advisor.goto(`/en/repair-orders/${ro}/estimate`);

  // Present: the estimate is frozen and the decision screen opens.
  await advisor.getByRole("button", { name: "Present to customer" }).click();
  await expect(advisor).toHaveURL(new RegExp(`/en/repair-orders/${ro}/estimate/approve$`));
  await expect(advisor.locator(".estimate-document")).toContainText("375.00"); // 225.00 + 150.00

  // The customer reads Arabic.
  await advisor
    .locator(".page-header")
    .getByRole("link", { name: /العربية/ })
    .click();
  await expect(advisor).toHaveURL(new RegExp(`/ar/repair-orders/${ro}/estimate/approve$`));
  await expect(advisor.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(advisor.getByRole("heading", { level: 1 })).toContainText("قرار العميل");
  await expect(advisor.locator(".estimate-document")).toContainText("عمالة الورشة");

  const choice = (title: string) => advisor.locator("fieldset.approval-choice").filter({ hasText: title });
  // Submitting without a signature is stopped on the screen.
  await choice("AC service").locator("label.choice-approved").click();
  await choice("Brake pads at 2 mm").locator("label.choice-declined").click();
  await advisor.locator("#approverName").fill("فاطمة العلي");
  await advisor.getByRole("button", { name: "تأكيد القرار" }).click();
  await expect(advisor.locator(".alert-danger")).toContainText("يرجى التوقيع");

  const pad = advisor.locator("canvas.signature-pad");
  const box = (await pad.boundingBox())!;
  await advisor.mouse.move(box.x + 30, box.y + 120);
  await advisor.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await advisor.mouse.move(box.x + 30 + step * 25, box.y + 120 - (step % 2) * 50);
  }
  await advisor.mouse.up();
  await advisor.getByRole("button", { name: "تأكيد القرار" }).click();

  await expect(advisor).toHaveURL(new RegExp(`/ar/repair-orders/${ro}/estimate$`));
  const card = (title: string) =>
    advisor.locator(".card").filter({ has: advisor.getByRole("heading", { name: title }) });
  await expect(card("AC service")).toContainText("موافق عليه");
  await expect(card("Brake pads at 2 mm")).toContainText("مرفوض");
  await expect(advisor.locator("main")).toContainText("مغلق"); // version closed

  await advisor.goto(`/en/repair-orders/${ro}`);
  await expect(advisor.locator(".page-header")).toContainText("In progress");

  // Technicians never reach the decision screen.
  const technician = await pageFor(browser, "technician");
  expect((await technician.goto(`/en/repair-orders/${ro}/estimate/approve`))?.status()).toBe(404);
});
