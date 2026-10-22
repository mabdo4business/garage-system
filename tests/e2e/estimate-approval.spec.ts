import { expect, test } from "@playwright/test";
import { uniqueDigits } from "./fixtures";
import { addItem, checkedInRepairOrder, pageFor, taxSetUp } from "./estimate-helpers";

/** I1-05b in a real browser: present the estimate, customer decides per job and signs (Arabic), work authorized. */

test("advisor presents the estimate; the customer approves one job, declines the other and signs", async ({
  browser,
}) => {
  test.setTimeout(90_000); // the longest flow: tax set-up, pricing, check-in, estimate, decision
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
  await advisor.goto(`/en/repair-orders/${ro}/inspection`);
  const addFinding = advisor
    .locator(".card")
    .filter({ has: advisor.getByRole("heading", { name: "Add a finding" }) });
  await addFinding.locator("input[name=title]").fill("Brake pads at 2 mm");
  await addFinding.locator("label.severity-urgent").click();
  await addFinding.getByRole("button", { name: "Save finding" }).click();
  await expect(advisor.locator(".finding-list").first()).toContainText("Brake pads at 2 mm");

  await advisor.goto(`/en/repair-orders/${ro}/estimate`);
  await advisor.getByRole("button", { name: "Start estimate" }).click();
  const addJob = advisor.locator(".card").filter({ has: advisor.getByRole("heading", { name: "Add job" }) });
  await addJob.locator("input[name=title]").fill("AC service");
  await addJob.getByRole("button", { name: "Add job" }).click();
  for (const [title, qty] of [
    ["Brake pads at 2 mm", "1.5"],
    ["AC service", "1"],
  ] as const) {
    const job = advisor.locator(".card").filter({ has: advisor.getByRole("heading", { name: title }) });
    await job.locator("summary", { hasText: "Add item" }).click();
    const form = job.locator("form", { has: advisor.locator("select[name=itemId]") });
    const value = await form.locator("option", { hasText: labor }).getAttribute("value");
    await form.locator("select[name=itemId]").selectOption(value!);
    await form.locator("input[name=qty]").fill(qty);
    await form.getByRole("button", { name: "Add item" }).click();
    await expect(job.locator("tbody")).toContainText("Workshop labour");
  }

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
