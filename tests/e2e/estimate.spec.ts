import { expect, test, type Browser, type Page } from "@playwright/test";
import { signIn, submitForm, uniqueDigits } from "./fixtures";

/** I1-05a estimate draft in a real browser: urgent finding pre-selected, lines, manager discount, totals, AR. */

async function pageFor(
  browser: Browser,
  user: "advisor" | "technician" | "manager" | "partner",
  locale: "en" | "ar" = "en",
) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, locale, user);
  return page;
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
}

/** A tax profile in force today and a fresh 5% tax code (values are test data a partner would enter). */
async function taxSetUp(partner: Page): Promise<string> {
  await partner.goto("/en/settings/tax");
  await partner.locator("summary", { hasText: "Add a profile from a date" }).click();
  await partner.locator("#registrationStatus").selectOption("registered");
  await partner.locator("#trn").fill("100123456700003");
  await partner.locator("#effectiveFrom").fill(today());
  await partner.getByRole("button", { name: "Add a profile from a date" }).click();
  // Saved now, or refused because another spec saved today's profile first (OD-16): in force either way.
  await expect(partner.locator("tbody").first()).toContainText(today());
  const taxCode = `E${uniqueDigits(5)}`;
  await partner.locator("summary", { hasText: "Create a tax code" }).click();
  await partner.locator("#code").fill(taxCode);
  await partner.locator("#labelEn").fill("Standard");
  await partner.locator("#labelAr").fill("قياسي");
  await partner.locator("#rate").fill("5");
  await partner.getByRole("button", { name: "Create a tax code" }).click();
  await expect(partner.locator("main")).toContainText(taxCode);
  return taxCode;
}

async function addItem(
  manager: Page,
  kind: "labor_rate" | "part",
  input: { code: string; price: string; taxCode: string; nameEn: string; nameAr: string },
) {
  await manager.goto(kind === "part" ? "/en/catalogue?kind=part" : "/en/catalogue");
  await manager
    .locator("summary", { hasText: kind === "part" ? "Add a part or non-stock item" : "Add a labor rate" })
    .click();
  await manager.locator("#code").fill(input.code);
  await manager.locator("#price").fill(input.price);
  await manager.locator("#taxCode").selectOption(input.taxCode);
  await manager.locator("#nameEn").fill(input.nameEn);
  await manager.locator("#nameAr").fill(input.nameAr);
  if (kind === "part") await manager.locator("#unit").selectOption("piece");
  await manager.getByRole("button", { name: "Save item" }).click();
  await expect(manager).toHaveURL(/\/en\/catalogue\/[0-9a-f-]{36}$/);
}

async function checkedInRepairOrder(page: Page): Promise<string> {
  await page.goto("/en/customers/new");
  await page.locator("#nameEn").fill(`Estimate Owner ${uniqueDigits(5)}`);
  await page.locator("#mobile").fill(`055${uniqueDigits(7)}`);
  await submitForm(page);
  await expect(page).toHaveURL(/\/en\/customers\/[0-9a-f-]{36}$/);
  const customerId = page.url().split("/").pop()!;
  await page.goto("/en/vehicles/new");
  await page.locator("#ownerCustomerId").fill(customerId);
  await page.locator("#plateEmirate").selectOption("sharjah");
  await page.locator("#plateCode").fill("ES");
  await page.locator("#plateNumber").fill(uniqueDigits(5));
  await page.locator("#make").fill("Nissan");
  await page.locator("#model").fill("Sunny");
  await page.locator("#year").fill("2020");
  await submitForm(page);
  await expect(page).toHaveURL(/\/en\/vehicles\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Check in this vehicle" }).click();
  await expect(page).toHaveURL(/\/en\/check-ins\//);
  await page.locator("#odometerKm").fill("61000");
  await page.locator("#concerns").fill("Squeal when braking");
  await page.locator("#photoShortfallReason").fill("Photos taken on the workshop camera");
  await page.getByRole("button", { name: "Complete check-in" }).click();
  await expect(page).toHaveURL(/\/en\/repair-orders\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop()!;
}

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
