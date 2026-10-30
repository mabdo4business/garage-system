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

test("changing the authorized contact by callback stops the customer's link (F-10, T-08)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { advisor, ro, url } = await sentEstimateWithLink(browser);

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const customer = await phone.newPage();
  await customer.goto(url);
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText("Your car's estimate");

  // The owner calls in: the advisor calls back the owner's number on file and changes the contact.
  await advisor.goto(`/en/repair-orders/${ro}`);
  await advisor.getByText("Change authorized contact").click();
  await advisor.getByLabel("New contact's name").fill("Fleet Manager");
  await advisor.getByLabel("New contact's mobile").fill("0501112233");
  await advisor.getByLabel("Relationship to the vehicle").selectOption("company_representative");
  await advisor.getByLabel("Reason", { exact: true }).fill("Company fleet manager takes over");
  await advisor.locator("label").filter({ hasText: "The owner:" }).click();
  await advisor.locator("label").filter({ hasText: "Callback to the number on file" }).click();
  await expect(advisor.getByTestId("contact-call-number")).toContainText(/\d{6,}/);
  const dubaiNow = new Date(Date.now() + 4 * 3_600_000 - 60_000).toISOString().slice(0, 16);
  await advisor.getByLabel("Time of the call").fill(dubaiNow);
  await advisor.getByLabel("Person spoken to").fill("The owner");
  await advisor.getByRole("button", { name: "Change contact" }).click();

  await expect(advisor.getByTestId("contact-history")).toContainText("Fleet Manager");
  await expect(advisor.getByTestId("contact-history")).toContainText("by callback, spoke to");

  await customer.reload();
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText("This link is no longer valid");
  await phone.close();
});

test("changing the contact in person: the signature pad fits its box, and a signature lost by switching is not sent", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { advisor, ro } = await sentEstimateWithLink(browser);
  await advisor.goto(`/en/repair-orders/${ro}`);
  await advisor.getByText("Change authorized contact").click();
  await advisor.getByLabel("New contact's name").fill("Sara Driver");
  await advisor.getByLabel("New contact's mobile").fill("0504445566");
  await advisor.getByLabel("Relationship to the vehicle").selectOption("driver");
  await advisor.getByLabel("Reason", { exact: true }).fill("Owner sends a driver to collect");
  await advisor.locator("label").filter({ hasText: "The owner:" }).click();
  await advisor.locator("label").filter({ hasText: "In person — they sign below" }).click();
  await advisor.getByLabel("Name of the person signing").fill("The owner");

  // The canvas appeared only now; its drawing surface must match its box, or ink lands in the wrong place.
  const pad = advisor.locator("form.contact-change-form canvas.signature-pad");
  const sized = await pad.evaluate((canvas: HTMLCanvasElement) => {
    const ratio = window.devicePixelRatio || 1;
    return canvas.width === Math.round(canvas.clientWidth * ratio) && canvas.clientWidth > 300;
  });
  expect(sized).toBe(true);
  const sign = async () => {
    const box = (await pad.boundingBox())!;
    await advisor.mouse.move(box.x + 20, box.y + 100);
    await advisor.mouse.down();
    for (let step = 1; step <= 12; step++) {
      await advisor.mouse.move(box.x + 20 + step * ((box.width - 40) / 12), box.y + 100 - (step % 2) * 50);
    }
    await advisor.mouse.up();
  };
  await sign();

  // Switching to callback and back shows a fresh, blank pad: sending now must ask for a signature.
  await advisor.locator("label").filter({ hasText: "Callback to the number on file" }).click();
  await advisor.locator("label").filter({ hasText: "In person — they sign below" }).click();
  await advisor.getByLabel("Name of the person signing").fill("The owner");
  await advisor.getByRole("button", { name: "Change contact" }).click();
  await expect(advisor.locator(".alert-danger")).toContainText("Please sign first.");

  await sign();
  // Ink reached the far end of the pad (nothing cropped at the default 300 px bitmap).
  const inkAtFarEnd = await pad.evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d")!;
    const x = Math.floor(canvas.width * 0.9);
    const column = context.getImageData(x - 10, 0, 20, canvas.height).data;
    return column.some((value, index) => index % 4 === 3 && value > 0);
  });
  expect(inkAtFarEnd).toBe(true);
  await advisor.getByRole("button", { name: "Change contact" }).click();
  await expect(advisor.getByTestId("contact-history")).toContainText("in person, signed by");
  await expect(advisor.getByTestId("contact-history")).toContainText("Sara Driver");
});
