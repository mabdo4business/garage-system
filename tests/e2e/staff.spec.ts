import { expect, test, type Page } from "@playwright/test";
import { signIn, submitForm, uniqueDigits } from "./fixtures";

/**
 * I1-11 key flows in a real browser, run at desktop and tablet widths (playwright.config.ts).
 * Each test makes its own data with unique numbers, so the two projects never collide.
 */

async function registerCustomer(page: Page, name: string, mobile: string): Promise<string> {
  await page.goto("/en/customers/new");
  await page.locator("#nameEn").fill(name);
  await page.locator("#mobile").fill(mobile);
  await submitForm(page);
  await expect(page).toHaveURL(/\/en\/customers\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop()!;
}

test("advisor: Today, search, duplicate warning, vehicle, two plate changes without reloading", async ({
  page,
}) => {
  await signIn(page, "en", "advisor");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  // Today is the workshop dashboard for advisors, without money (OD-50: revenue and amounts are partner/manager).
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Workshop overview");
  await expect(page.locator(".kpi")).toHaveCount(3);
  await expect(page.locator("main")).not.toContainText("Revenue");
  await expect(page.locator("main")).not.toContainText("AED");
  await expect(page.locator(".orders-table th")).not.toContainText(["Amount"]);

  // The global search bar is on every staff screen; an unknown query shows the empty state.
  await page.locator("#shell-search").fill("Nobody Here Zzz");
  await page.locator("#shell-search").press("Enter");
  await expect(page).toHaveURL(/\/en\/search\?q=/);
  await expect(page.locator(".empty-state")).toBeVisible();

  const mobile = `050${uniqueDigits(7)}`;
  const customerId = await registerCustomer(page, "Khalid Test", mobile);

  // Same mobile again: warned with the existing customer, then created on confirmation.
  await page.goto("/en/customers/new");
  await page.locator("#nameEn").fill("Khalid Second");
  await page.locator("#mobile").fill(mobile);
  await submitForm(page);
  await expect(page.locator(".alert-warning")).toContainText("Khalid Test");
  await expect(page.locator("#nameEn")).toHaveValue("Khalid Second");
  expect(page.url()).not.toContain(mobile);
  await submitForm(page);
  await expect(page).toHaveURL(/\/en\/customers\/[0-9a-f-]{36}$/);

  // Vehicle for the first customer.
  const number = uniqueDigits(5);
  await page.goto("/en/vehicles/new");
  await page.locator("#ownerCustomerId").fill(customerId);
  await page.locator("#plateEmirate").selectOption("sharjah");
  await page.locator("#plateCode").fill("E");
  await page.locator("#plateNumber").fill(number);
  await page.locator("#make").fill("Nissan");
  await page.locator("#model").fill("Sunny");
  await page.locator("#year").fill("2019");
  await submitForm(page);
  await expect(page).toHaveURL(/\/en\/vehicles\/[0-9a-f-]{36}$/);
  await expect(page.locator(".page-header .plate")).toContainText(number);
  // Change-plate starts from the current emirate.
  await expect(page.locator("#plateEmirate")).toHaveValue("sharjah");

  // Two plate changes in a row on the same page (I1-01 re-review N7: no stale form key).
  for (const code of ["F", "G"]) {
    await page.locator("#plateCode").fill(code);
    await page.locator("#plateNumber").fill(number);
    await submitForm(page, 0);
    await expect(page.locator(".page-header .plate")).toContainText(code);
  }
  await expect(page.locator(".card").filter({ hasText: "Plate history" }).locator("tbody tr")).toHaveCount(3);

  // A full plate with the emirate finds it from the top bar.
  await page.locator("#shell-search").fill(`Sharjah G ${number}`);
  await page.locator("#shell-search").press("Enter");
  await expect(page.locator(".result-list a")).toHaveCount(1);
});

test("Arabic: right-to-left shell with Arabic labels, and the language switch keeps the page", async ({
  page,
}) => {
  await signIn(page, "ar", "advisor");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator(".shell-nav")).toContainText("العملاء والمركبات");

  await page.goto("/ar/search");
  await expect(page.locator(".empty-state")).toBeVisible();
  await page.locator(".topbar-user a[hreflang=en]").click();
  await expect(page).toHaveURL(/\/en\/search$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});

test("technician: search only, no phone numbers, no registration pages", async ({ browser }) => {
  const advisorPage = await (await browser.newContext()).newPage();
  await signIn(advisorPage, "en", "advisor");
  const name = `Contact Hidden ${uniqueDigits(6)}`;
  const mobile = `055${uniqueDigits(7)}`;
  await registerCustomer(advisorPage, name, mobile);

  const page = await (await browser.newContext()).newPage();
  await signIn(page, "en", "technician");
  // Technicians land on My jobs; Today sends them there too (OD-50).
  await expect(page).toHaveURL(/\/en\/jobs$/);
  await page.goto("/en");
  await expect(page).toHaveURL(/\/en\/jobs$/);

  await page.goto(`/en/search?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("link", { name: "New customer" })).toHaveCount(0);
  await page.locator(".result-list a").first().click();
  await expect(page.locator("main")).toContainText("Contact details are hidden");
  await expect(page.locator("main")).not.toContainText(mobile);

  // Searching by the number finds nothing for a technician.
  await page.goto(`/en/search?q=${mobile}`);
  await expect(page.locator(".result-list")).toHaveCount(0);

  const response = await page.goto("/en/customers/new");
  expect(response?.status()).toBe(404);
});

test("signed out: every staff page sends you to sign-in in the same language", async ({ page }) => {
  for (const [path, locale] of [
    ["/en", "en"],
    ["/en/search?q=1", "en"],
    ["/ar/customers/new", "ar"],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/${locale}/login$`));
  }
});
