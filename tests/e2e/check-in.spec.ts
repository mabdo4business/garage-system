import { expect, test, type Page } from "@playwright/test";
import { makePng } from "../helpers/images";
import { signIn, submitForm, uniqueDigits } from "./fixtures";

/** I1-02 check-in in a real browser (desktop and tablet projects). */

async function registerVehicle(page: Page): Promise<string> {
  await page.goto("/en/customers/new");
  await page.locator("#nameEn").fill(`Check-in Driver ${uniqueDigits(5)}`);
  await page.locator("#mobile").fill(`052${uniqueDigits(7)}`);
  await submitForm(page);
  await expect(page).toHaveURL(/\/en\/customers\/[0-9a-f-]{36}$/);
  const customerId = page.url().split("/").pop()!;

  await page.goto("/en/vehicles/new");
  await page.locator("#ownerCustomerId").fill(customerId);
  await page.locator("#plateEmirate").selectOption("ajman");
  await page.locator("#plateCode").fill("K");
  await page.locator("#plateNumber").fill(uniqueDigits(5));
  await page.locator("#make").fill("Kia");
  await page.locator("#model").fill("Picanto");
  await page.locator("#year").fill("2021");
  await submitForm(page);
  await expect(page).toHaveURL(/\/en\/vehicles\/[0-9a-f-]{36}$/);
  return page.url();
}

async function uploadPhoto(page: Page, slot: string, seed: number) {
  const before = await page.locator(".photo-slot.filled").count();
  await page
    .locator(`input[type=file][data-slot=${slot}]`)
    .first()
    .setInputFiles({
      name: `${slot}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(makePng(1600, 1200, seed)),
    });
  await expect(page.locator(".photo-slot.filled")).toHaveCount(before + 1);
}

test("advisor checks in a vehicle: missing photos need a reason, then a numbered repair order with photos", async ({
  page,
}) => {
  await signIn(page, "en", "advisor");
  await registerVehicle(page);

  await page.getByRole("button", { name: "Check in this vehicle" }).click();
  await expect(page).toHaveURL(/\/en\/check-ins\/[0-9a-f-]{36}$/);
  // The owner is prefilled as the authorized contact.
  await expect(page.locator("#contactName")).toHaveValue(/Check-in Driver/);

  await uploadPhoto(page, "front", 1);
  await uploadPhoto(page, "rear", 2);
  await expect(page.locator(".alert-warning")).toContainText("Left side");

  await page.locator("#odometerKm").fill("45120");
  await page.locator(".segmented label", { hasText: "1/2" }).click();
  await page.locator("#concerns").fill("Air conditioning blows warm air");
  await page.locator("#keysReceived").fill("1");
  await page.getByRole("button", { name: "Complete check-in" }).click();

  // Refused: three photos missing and no reason. What was typed is kept.
  await expect(page.locator(".alert-danger")).toContainText("Reason for missing photos");
  await expect(page.locator("#concerns")).toHaveValue("Air conditioning blows warm air");

  await page.locator("#photoShortfallReason").fill("Vehicle parked against a wall");
  await page.getByRole("button", { name: "Complete check-in" }).click();
  await expect(page).toHaveURL(/\/en\/repair-orders\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Repair order RO-\d{6}/);
  await expect(page.locator(".chip").first()).toContainText("Checked in");
  await expect(page.locator("main")).toContainText("Vehicle parked against a wall");
  await expect(page.locator(".photo-slot img")).toHaveCount(2);
  // The photo really loads (authorized, private endpoint).
  const firstPhoto = await page.locator(".photo-slot img").first().getAttribute("src");
  const response = await page.request.get(firstPhoto!);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");

  const number = (await page.getByRole("heading", { level: 1 }).textContent())!.match(/RO-\d{6}/)![0];
  const repairOrderUrl = page.url();

  await page.goto("/en/repair-orders");
  await expect(page.locator(".data-table")).toContainText(number);

  await page.goto(repairOrderUrl.replace("/en/", "/ar/"));
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("أمر الإصلاح");
  await expect(page.locator(".chip").first()).toContainText("تم الاستلام");
});

test("technician: no Repair orders menu and no access to check-in pages", async ({ page }) => {
  await signIn(page, "en", "technician");
  await expect(page.locator(".shell-nav")).not.toContainText("Repair orders");
  const response = await page.goto("/en/repair-orders");
  expect(response?.status()).toBe(404);
});
