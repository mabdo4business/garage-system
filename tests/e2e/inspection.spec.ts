import { expect, test, type Browser, type Page } from "@playwright/test";
import { makePng } from "../helpers/images";
import { signIn, submitForm, uniqueDigits } from "./fixtures";

/** I1-03 inspection in a real browser: assign → technician records → advisor sees; AC2-30 scoping. */

async function pageFor(
  browser: Browser,
  user: "advisor" | "technician" | "technician2" | "manager",
  locale: "en" | "ar" = "en",
) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, locale, user);
  return page;
}

/** Advisor registers a customer and vehicle and completes a check-in (reason instead of photos). */
async function checkedInRepairOrder(page: Page): Promise<{ ro: string; mobile: string }> {
  const mobile = `054${uniqueDigits(7)}`;
  await page.goto("/en/customers/new");
  await page.locator("#nameEn").fill(`Inspection Owner ${uniqueDigits(5)}`);
  await page.locator("#mobile").fill(mobile);
  await submitForm(page);
  await expect(page).toHaveURL(/\/en\/customers\/[0-9a-f-]{36}$/);
  const customerId = page.url().split("/").pop()!;
  await page.goto("/en/vehicles/new");
  await page.locator("#ownerCustomerId").fill(customerId);
  await page.locator("#plateEmirate").selectOption("dubai");
  await page.locator("#plateCode").fill("IS");
  await page.locator("#plateNumber").fill(uniqueDigits(5));
  await page.locator("#make").fill("Ford");
  await page.locator("#model").fill("Ranger");
  await page.locator("#year").fill("2018");
  await submitForm(page);
  await expect(page).toHaveURL(/\/en\/vehicles\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Check in this vehicle" }).click();
  await expect(page).toHaveURL(/\/en\/check-ins\//);
  await page.locator("#odometerKm").fill("98000");
  await page.locator("#concerns").fill("Grinding noise when braking");
  await page.locator("#photoShortfallReason").fill("Photos taken on the workshop camera");
  await page.getByRole("button", { name: "Complete check-in" }).click();
  await expect(page).toHaveURL(/\/en\/repair-orders\/[0-9a-f-]{36}$/);
  return { ro: page.url().split("/").pop()!, mobile };
}

test("manager assigns, the technician records an urgent checklist finding with a photo, the advisor sees it", async ({
  browser,
}) => {
  const advisor = await pageFor(browser, "advisor");
  const { ro, mobile } = await checkedInRepairOrder(advisor);

  const manager = await pageFor(browser, "manager");
  await manager.goto(`/en/repair-orders/${ro}`);
  await manager.locator("#technicianUserId").selectOption({ label: "Tariq Technician" });
  await manager.getByRole("button", { name: "Assign" }).click();
  await expect(manager.locator("main")).toContainText("Tariq Technician");
  await expect(manager.locator(".chip").first()).toContainText("Diagnosing");

  const tech = await pageFor(browser, "technician");
  await tech.getByRole("link", { name: "My inspections" }).click();
  await tech.locator(".result-list a").filter({ hasText: "Grinding noise" }).first().click();
  await expect(tech).toHaveURL(new RegExp(`/repair-orders/${ro}/inspection$`));
  // No customer contact on the technician's screen.
  await expect(tech.locator("main")).not.toContainText(mobile);

  await tech.getByRole("link", { name: "Periodic service" }).click();
  const checklist = tech.locator(".card").filter({ has: tech.getByRole("heading", { name: "Checklist" }) });
  const item = checklist.locator(".finding").filter({ hasText: "Front brake pads and discs" });
  await item.locator("summary").click();
  await item.locator("label.severity-urgent").click();
  await item.locator("textarea[name=customerNote]").fill("Pads worn to 2 mm.");
  await item.locator("textarea[name=internalNote]").fill("INTERNAL-TEST-123 caliper slider sticky");
  await item.getByRole("button", { name: "Save finding" }).click();
  await expect(item.locator(".chip")).toContainText("Recorded");

  const finding = tech.locator(".finding-list").first().locator(".finding").first();
  await expect(finding).toContainText("Urgent");
  await finding.locator("input[type=file]").setInputFiles({
    name: "pads.png",
    mimeType: "image/png",
    buffer: Buffer.from(makePng(1200, 900, 21)),
  });
  await expect(finding.locator(".photo-slot img")).toHaveCount(1);
  await expect(finding.locator(".photo-slot")).toContainText("Internal");
  await finding.getByRole("button", { name: "Show to customer" }).click();
  await expect(tech.locator(".finding-list").first().locator(".photo-slot").first()).toContainText(
    "Shown to customer",
  );

  await advisor.goto(`/en/repair-orders/${ro}`);
  await expect(advisor.locator("main")).toContainText("1 urgent");
  await advisor.getByRole("link", { name: "Open inspection" }).click();
  await expect(advisor.locator(".internal-note")).toContainText("INTERNAL-TEST-123");

  // Arabic layout of the technician's screen.
  await tech.goto(`/ar/repair-orders/${ro}/inspection`);
  await expect(tech.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(tech.getByRole("heading", { level: 1 })).toContainText("الفحص");
  await expect(tech.locator(".finding-list").first()).toContainText("عاجل");

  // AC2-30: another technician gets "not found".
  const other = await pageFor(browser, "technician2");
  const response = await other.goto(`/en/repair-orders/${ro}/inspection`);
  expect(response?.status()).toBe(404);
});
