import { expect, type Browser, type Page } from "@playwright/test";
import { signIn, submitForm, uniqueDigits } from "./fixtures";

/** Shared set-up for the estimate specs (I1-05a, I1-05b). */

export async function pageFor(
  browser: Browser,
  user: "advisor" | "technician" | "technician2" | "manager" | "partner",
  locale: "en" | "ar" = "en",
) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, locale, user);
  return page;
}

export function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
}

/** A tax profile in force today and a fresh 5% tax code (values are test data a partner would enter). */
export async function taxSetUp(partner: Page): Promise<string> {
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

export async function addItem(
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

export async function checkedInRepairOrder(page: Page): Promise<string> {
  return (await checkedInVehicle(page)).ro;
}

/** Like checkedInRepairOrder, and also returns the vehicle id (for a second check-in, OQ-1). */
export async function checkedInVehicle(page: Page): Promise<{ ro: string; vehicleId: string }> {
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
  const vehicleId = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "Check in this vehicle" }).click();
  await expect(page).toHaveURL(/\/en\/check-ins\//);
  await page.locator("#odometerKm").fill("61000");
  await page.locator("#concerns").fill("Squeal when braking");
  await page.locator("#photoShortfallReason").fill("Photos taken on the workshop camera");
  await page.getByRole("button", { name: "Complete check-in" }).click();
  await expect(page).toHaveURL(/\/en\/repair-orders\/[0-9a-f-]{36}$/);
  return { ro: page.url().split("/").pop()!, vehicleId };
}
