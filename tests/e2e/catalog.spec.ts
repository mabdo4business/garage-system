import { expect, test, type Browser } from "@playwright/test";
import { signIn, uniqueDigits } from "./fixtures";

/** I1-04 price list and tax settings in a real browser (desktop and tablet projects share one database). */

async function pageFor(
  browser: Browser,
  user: "advisor" | "technician" | "manager" | "partner",
  locale: "en" | "ar" = "en",
) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, locale, user);
  return page;
}

/** Today (Asia/Dubai). Tax history only moves forward (OD-16): the first run of the day records today's
 * profile; a later run is refused with the forward-only message, and today's profile is in force either way. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
}

test("partner sets tax, manager prices items with history, advisor reads, technician has no access", async ({
  browser,
}) => {
  const partner = await pageFor(browser, "partner");
  await partner.getByRole("link", { name: "Tax settings" }).click();
  await partner.locator("summary", { hasText: "Add a profile from a date" }).click();
  await partner.locator("#registrationStatus").selectOption("registered");
  await partner.locator("#trn").fill("100123456700003");
  const effectiveFrom = today();
  await partner.locator("#effectiveFrom").fill(effectiveFrom);
  await partner.getByRole("button", { name: "Add a profile from a date" }).click();
  // Either saved now or refused because an earlier run saved today's profile: it is listed either way.
  await expect(partner.locator("tbody").first()).toContainText(effectiveFrom);
  await expect(partner.locator("main")).toContainText("100123456700003");

  const taxCode = `S${uniqueDigits(5)}`;
  await partner.locator("summary", { hasText: "Create a tax code" }).click();
  await partner.locator("#code").fill(taxCode);
  await partner.locator("#labelEn").fill("Standard");
  await partner.locator("#labelAr").fill("قياسي");
  await partner.locator("#rate").fill("5");
  await partner.getByRole("button", { name: "Create a tax code" }).click();
  await expect(partner.locator("main")).toContainText(taxCode);
  await expect(partner.locator("main")).toContainText("5.00%");

  const manager = await pageFor(browser, "manager");
  await manager.getByRole("link", { name: "Price list" }).click();
  await expect(manager.locator(".alert-warning")).toHaveCount(0); // a profile is in force now
  await manager.locator("summary", { hasText: "Add a labor rate" }).click();
  const code = `LAB-${uniqueDigits(6)}`;
  await manager.locator("#code").fill(code);
  await manager.locator("#price").fill("150");
  await manager.locator("#taxCode").selectOption(taxCode);
  await manager.locator("#nameEn").fill("General labour");
  await manager.locator("#nameAr").fill("عمالة عامة");
  await manager.getByRole("button", { name: "Save item" }).click();
  await expect(manager).toHaveURL(/\/en\/catalogue\/[0-9a-f-]{36}$/);
  const itemUrl = manager.url();

  await manager.locator("summary", { hasText: "Change price" }).click();
  await manager.locator("#price").fill("175.50");
  await manager.getByRole("button", { name: "Change price" }).click();
  const history = manager
    .locator(".card")
    .filter({ has: manager.getByRole("heading", { name: "Price history" }) });
  await expect(history.locator("tbody tr")).toHaveCount(2);
  await expect(history.locator("tbody tr").first()).toContainText("175.50");

  // Parts: a stock part and a non-stock (sublet) item.
  await manager.goto("/en/catalogue?kind=part");
  await manager.locator("summary", { hasText: "Add a part or non-stock item" }).click();
  await manager.locator("#code").fill(`SUB-${uniqueDigits(6)}`);
  await manager.locator("#price").fill("600");
  await manager.locator("#nameEn").fill("Cylinder head machining");
  await manager.locator("#nameAr").fill("خراطة رأس السلندر");
  await manager.locator("#unit").selectOption("job");
  await manager.locator("input[name=stockTracked]").uncheck();
  await manager.getByRole("button", { name: "Save item" }).click();
  await expect(manager.locator("main")).toContainText(
    "Non-stock: actual cost entered on the job line before invoicing",
  );

  // Advisor: reads prices, cannot change them.
  const advisor = await pageFor(browser, "advisor");
  await advisor.goto(itemUrl);
  await expect(advisor.locator("main")).toContainText("175.50");
  await expect(advisor.locator("summary", { hasText: "Change price" })).toHaveCount(0);
  await advisor.goto("/ar/catalogue");
  await expect(advisor.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(advisor.getByRole("heading", { level: 1 })).toContainText("قائمة الأسعار");

  // Technician: no prices at all.
  const technician = await pageFor(browser, "technician");
  await expect(technician.locator(".shell-nav")).not.toContainText("Price list");
  expect((await technician.goto("/en/catalogue"))?.status()).toBe(404);
  // Only partners reach tax settings.
  expect((await manager.goto("/en/settings/tax"))?.status()).toBe(404);
});
