import { expect, test } from "@playwright/test";
import { uniqueDigits } from "./fixtures";
import { addItem, checkedInRepairOrder, pageFor, taxSetUp } from "./estimate-helpers";

/** I1-05a estimate draft in a real browser: urgent finding pre-selected, lines, manager discount, totals, AR. */

test("advisor builds an estimate from an urgent finding, manager discounts, totals to the fil", async ({
  browser,
}) => {
  const partner = await pageFor(browser, "partner");
  const taxCode = await taxSetUp(partner);
  const manager = await pageFor(browser, "manager");
  const labor = `LAB-${uniqueDigits(6)}`;
  const part = `PAD-${uniqueDigits(6)}`;
  await addItem(manager, "labor_rate", {
    code: labor,
    price: "150",
    taxCode,
    nameEn: "Brake labour",
    nameAr: "عمالة الفرامل",
  });
  await addItem(manager, "part", {
    code: part,
    price: "12.35",
    taxCode,
    nameEn: "Brake pad",
    nameAr: "فحمة فرامل",
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

  // Start: the urgent finding is already a job (AC-05.2).
  await advisor.goto(`/en/repair-orders/${ro}`);
  await advisor.getByRole("link", { name: "Open estimate" }).click();
  await advisor.getByRole("button", { name: "Start estimate" }).click();
  const urgent = advisor
    .locator(".card")
    .filter({ has: advisor.getByRole("heading", { name: "Urgent findings" }) });
  await expect(urgent).toContainText("In the estimate");
  const job = advisor
    .locator(".card")
    .filter({ has: advisor.getByRole("heading", { name: "Brake pads at 2 mm" }) });
  await expect(job).toBeVisible();

  const addLine = async (code: string, qty: string) => {
    await job.locator("summary", { hasText: "Add item" }).click();
    const form = job.locator("form", { has: advisor.locator("select[name=itemId]") });
    const value = await form.locator("option", { hasText: code }).getAttribute("value");
    await form.locator("select[name=itemId]").selectOption(value!);
    await form.locator("input[name=qty]").fill(qty);
    await form.getByRole("button", { name: "Add item" }).click();
    await expect(job.locator("tbody")).toContainText(code === labor ? "Brake labour" : "Brake pad");
  };
  await addLine(labor, "1.5");
  await addLine(part, "3");
  const totals = advisor.locator(".card").filter({ has: advisor.getByRole("heading", { name: "Totals" }) });
  await expect(totals).toContainText("262.05"); // 225.00 + 37.05
  // Advisors cannot discount (OD-19).
  await job.locator("tbody tr").first().locator("summary").click();
  await expect(job.getByRole("button", { name: "Set discount" })).toHaveCount(0);

  // Manager: 20.00 off the labour line.
  await manager.goto(`/en/repair-orders/${ro}/estimate`);
  const managerJob = manager
    .locator(".card")
    .filter({ has: manager.getByRole("heading", { name: "Brake pads at 2 mm" }) });
  await managerJob.locator("tbody tr").first().locator("summary").click();
  const discount = managerJob.locator("form", { has: manager.locator("input[name=discount]") }).first();
  await discount.locator("input[name=discount]").fill("20");
  await discount.getByRole("button", { name: "Set discount" }).click();
  const managerTotals = manager
    .locator(".card")
    .filter({ has: manager.getByRole("heading", { name: "Totals" }) });
  await expect(managerTotals).toContainText("242.05");
  // VAT out of 205.00 + 37.05: 195.24 + 35.29 net → 11.52 VAT.
  await expect(managerTotals).toContainText("11.52");
  await expect(managerTotals).toContainText("230.53");

  // Arabic, right to left.
  await advisor.goto(`/ar/repair-orders/${ro}/estimate`);
  await expect(advisor.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(advisor.getByRole("heading", { level: 1 })).toContainText("التقدير");
  await expect(advisor.locator("main")).toContainText("فحمة فرامل");

  // Technicians never see estimates or prices.
  const technician = await pageFor(browser, "technician");
  expect((await technician.goto(`/en/repair-orders/${ro}/estimate`))?.status()).toBe(404);
});
