import { randomUUID } from "node:crypto";
import { expect, test, type Browser } from "@playwright/test";
import { uniqueDigits } from "./fixtures";
import { addItem, checkedInRepairOrder, pageFor, taxSetUp } from "./estimate-helpers";

/**
 * I2-03a and I2-03b in a real browser: the advisor makes a customer link to the sent estimate; the customer opens it
 * on a phone with no session, reads it in Arabic, decides through it, and the link stops working once revoked.
 */

/** A sent estimate — "Brake pads at 2 mm" (urgent finding) and, if asked, "AC service" — and its new link. */
async function sentEstimateWithLink(browser: Browser, withAc = false) {
  const partner = await pageFor(browser, "partner");
  const taxCode = await taxSetUp(partner);
  const manager = await pageFor(browser, "manager");
  await addItem(manager, "labor_rate", {
    code: `LAB-${uniqueDigits(6)}`,
    price: "150",
    taxCode,
    nameEn: "Workshop labour",
    nameAr: "عمالة الورشة",
  });
  const itemId = manager.url().split("/").pop()!;

  const advisor = await pageFor(browser, "advisor");
  const ro = await checkedInRepairOrder(advisor);
  const post = (path: string, data: Record<string, unknown>) =>
    advisor.request.post(path, { data: { idempotencyKey: randomUUID(), ...data } });
  expect(
    (
      await post(`/api/repair-orders/${ro}/findings`, {
        title: "Brake pads at 2 mm",
        severity: "urgent",
        faultCodes: "C1234",
        customerNote: "Front pads are almost worn through",
        internalNote: "E2E-INTERNAL-NOTE",
      })
    ).ok(),
  ).toBe(true);
  expect((await post(`/api/repair-orders/${ro}/estimate`, {})).ok()).toBe(true);
  if (withAc)
    expect((await post(`/api/repair-orders/${ro}/estimate/jobs`, { title: "AC service" })).ok()).toBe(true);
  const view = await (await advisor.request.get(`/api/repair-orders/${ro}/estimate`)).json();
  for (const job of view.jobs) {
    expect((await post(`/api/repair-jobs/${job.id}/lines`, { itemId, qty: "1" })).ok()).toBe(true);
  }
  expect((await post(`/api/repair-orders/${ro}/estimate/send`, {})).ok()).toBe(true);

  // The advisor makes the link; its address is shown once.
  await advisor.goto(`/en/repair-orders/${ro}/estimate`);
  await advisor.getByRole("button", { name: "Create link" }).click();
  const address = advisor.getByTestId("customer-link-url").locator("input");
  await expect(address).toHaveValue(/\/c\/[A-Za-z0-9_-]{43}$/);
  return { advisor, ro, url: await address.inputValue() };
}

test("advisor creates a customer link; the customer reads the estimate in Arabic; revoking ends it", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { advisor, url } = await sentEstimateWithLink(browser);

  // The customer: a phone with no staff session.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const customer = await phone.newPage();
  const response = await customer.goto(url);
  expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText("Your car's estimate");
  await expect(customer.locator(".estimate-document")).toContainText("Front pads are almost worn through");
  await expect(customer.locator(".estimate-document")).toContainText("C1234");
  await expect(customer.locator(".estimate-document")).toContainText("150.00");
  await expect(customer.locator("body")).not.toContainText("E2E-INTERNAL-NOTE");
  await expect(customer.locator(".plate .number")).toContainText("•••");
  // No horizontal scroll at phone width.
  expect(await customer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await customer.getByRole("link", { name: "العربية" }).click();
  await expect(customer.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText("تقدير تكلفة سيارتك");
  await expect(customer.locator(".estimate-document")).toContainText("عمالة الورشة");

  // A modified token is the generic page.
  await customer.goto(url.slice(0, -1) + (url.endsWith("A") ? "B" : "A"));
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText("This link is no longer valid");

  // The advisor sees it was opened, then revokes it.
  await advisor.reload();
  await expect(advisor.getByTestId("customer-link-live")).toContainText("Twice");
  await advisor.getByRole("button", { name: "Revoke link" }).click();
  await expect(advisor.getByText("No link has been made for this version.")).toBeVisible();
  await customer.goto(url);
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText("This link is no longer valid");
  await expect(customer.locator("body")).not.toContainText("Brake pads");
  await phone.close();
});

test("the customer approves one job and declines the other through the link, in Arabic on a phone", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { advisor, ro, url } = await sentEstimateWithLink(browser, true);

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const customer = await phone.newPage();
  await customer.goto(url.replace(/\/en\/c\//, "/ar/c/"));
  await expect(customer.locator("html")).toHaveAttribute("dir", "rtl");
  expect(await customer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const choice = (title: string) => customer.locator("fieldset.approval-choice").filter({ hasText: title });
  await choice("AC service").locator("label.choice-approved").click();
  await choice("Brake pads at 2 mm").locator("label.choice-declined").click();

  // Without a name the form says so and keeps the choices.
  await customer.locator("#approverName").fill(" ");
  await customer
    .locator("#approverName")
    .evaluate((input: HTMLInputElement) => input.removeAttribute("required"));
  await customer.getByRole("button", { name: "تأكيد القرار" }).click();
  await expect(customer.locator(".alert-danger")).toContainText("يرجى كتابة اسمك");
  await expect(choice("AC service").locator("input[value=approved]")).toBeChecked();

  await customer.locator("#approverName").fill("عمر الشامسي");
  await customer.getByRole("button", { name: "تأكيد القرار" }).click();
  await expect(customer.locator(".link-done")).toContainText("شكراً لك — تم تسجيل قرارك");
  await expect(customer.locator("form.link-decision-form")).toHaveCount(0); // decided: read-only now
  await expect(customer.locator(".estimate-document")).toContainText("تمت الموافقة");
  await expect(customer.locator(".estimate-document")).toContainText("مرفوض");
  expect(await customer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Staff see the decision and who gave it; the car is now in progress.
  await advisor.goto(`/en/repair-orders/${ro}/estimate`);
  await expect(advisor.getByTestId("decided-by-link")).toContainText("عمر الشامسي");
  await advisor.goto(`/en/repair-orders/${ro}`);
  await expect(advisor.locator("body")).toContainText("In progress");
  await phone.close();
});
