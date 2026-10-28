import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { submitForm, uniqueDigits } from "./fixtures";
import { businessProfileSetUp, pageFor, taxSetUp } from "./estimate-helpers";

/**
 * Increment 1 exit criterion (docs/implementation-plan.md): one repair order end to end through the screens — register,
 * check in, inspect, estimate, signed in-person approval, assign, work, QC, invoice, pay, hand over — in Arabic and in
 * English, with the P0-06 guard refusing the invoice until the part used is issued. Only master data (tax, business
 * profile, price list) is set up beforehand; every step of the repair order itself is a click on a staff screen.
 */

type Locale = "ar" | "en";
const catalogs: Record<Locale, Record<string, string>> = {
  ar: JSON.parse(readFileSync(join(process.cwd(), "src/i18n/messages/ar.json"), "utf8")),
  en: JSON.parse(readFileSync(join(process.cwd(), "src/i18n/messages/en.json"), "utf8")),
};

// Fail a stuck step in seconds rather than at the end of the four-minute budget.
test.use({ actionTimeout: 30_000 });

for (const locale of ["ar", "en"] as const) {
  test(`Increment 1 exit (${locale}): a repair order from check-in to handover, closed and paid`, async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    /** The screen's text for a message key, in this run's language. */
    const tr = (key: string) => {
      const text = catalogs[locale][key];
      if (!text) throw new Error(`missing message ${key}`);
      return text;
    };
    const exact = (key: string) => ({ name: tr(key), exact: true });
    const cardTitled = (page: Page, key: string) =>
      page.locator(".card").filter({ has: page.getByRole("heading", { name: tr(key), exact: true }) });

    // ---------------------------------------------------------------- master data (not the repair order)
    const partner = await pageFor(browser, "partner");
    const taxCode = await taxSetUp(partner);
    await businessProfileSetUp(await pageFor(browser, "partner", "ar"), `Exit Garage ${uniqueDigits(5)} LLC`);
    const manager = await pageFor(browser, "manager", locale);
    const labourCode = `EXL-${uniqueDigits(6)}`;
    const partCode = `EXP-${uniqueDigits(6)}`;
    for (const data of [
      { kind: "labor_rate", code: labourCode, price: "200", nameEn: "Brake labour", nameAr: "عمالة الفرامل" },
      {
        kind: "part",
        code: partCode,
        price: "100",
        nameEn: "Brake pad set",
        nameAr: "طقم فحمات",
        unit: "set",
        stockTracked: true,
      },
    ]) {
      const response = await manager.request.post("/api/catalogue", {
        data: { idempotencyKey: randomUUID(), taxCode, ...data },
      });
      expect(response.ok()).toBe(true);
    }
    const partName = locale === "ar" ? "طقم فحمات" : "Brake pad set";

    // ---------------------------------------------------------------- 1. advisor: customer, vehicle, check-in
    const advisor = await pageFor(browser, "advisor", locale);
    await advisor.goto(`/${locale}/customers/new`);
    await expect(advisor.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await advisor.locator("#nameEn").fill(`Exit Customer ${uniqueDigits(5)}`);
    await advisor.locator("#mobile").fill(`056${uniqueDigits(7)}`);
    await submitForm(advisor);
    await expect(advisor).toHaveURL(new RegExp(`/${locale}/customers/[0-9a-f-]{36}$`));
    const customerId = advisor.url().split("/").pop()!;
    await advisor.goto(`/${locale}/vehicles/new`);
    await advisor.locator("#ownerCustomerId").fill(customerId);
    await advisor.locator("#plateEmirate").selectOption("sharjah");
    await advisor.locator("#plateCode").fill("EX");
    await advisor.locator("#plateNumber").fill(uniqueDigits(5));
    await advisor.locator("#make").fill("Toyota");
    await advisor.locator("#model").fill("Corolla");
    await advisor.locator("#year").fill("2019");
    await submitForm(advisor);
    await expect(advisor).toHaveURL(new RegExp(`/${locale}/vehicles/[0-9a-f-]{36}$`));
    await advisor.getByRole("button", exact("checkIn.start")).click();
    await expect(advisor).toHaveURL(new RegExp(`/${locale}/check-ins/`));
    const concerns = `Brakes squeal ${uniqueDigits(4)}`;
    await advisor.locator("#odometerKm").fill("72000");
    await advisor.locator("#concerns").fill(concerns);
    await advisor.locator("#photoShortfallReason").fill("Photos taken on the workshop camera");
    await advisor.getByRole("button", exact("checkIn.complete")).click();
    await expect(advisor).toHaveURL(new RegExp(`/${locale}/repair-orders/[0-9a-f-]{36}$`));
    const ro = advisor.url().split("/").pop()!;
    const roNumber = (await advisor.getByRole("heading", { level: 1 }).textContent())!.match(/RO-\d{6}/)![0];
    await expect(advisor.locator(".chip").first()).toContainText(tr("repairOrder.status.checked_in"));

    // ---------------------------------------------------------------- 2. manager assigns the inspection
    await manager.goto(`/${locale}/repair-orders/${ro}`);
    await manager.locator("#technicianUserId").selectOption({ label: "Tariq Technician" });
    await manager.getByRole("button", exact("inspection.assign")).click();
    await expect(manager.locator(".chip").first()).toContainText(tr("repairOrder.status.diagnosing"));

    // ---------------------------------------------------------------- 3. technician records an urgent finding
    const tech = await pageFor(browser, "technician", locale);
    await tech.goto(`/${locale}/inspections`);
    await tech.locator(".result-list a").filter({ hasText: concerns }).first().click();
    await expect(tech).toHaveURL(new RegExp(`/repair-orders/${ro}/inspection$`));
    const findingTitle = `Brake pads at 2 mm ${uniqueDigits(3)}`;
    const addFinding = cardTitled(tech, "inspection.addFinding");
    await addFinding.locator("input[name=title]").fill(findingTitle);
    await addFinding.locator("label.severity-urgent").click();
    await addFinding.locator("textarea[name=customerNote]").fill("Front pads worn to 2 mm.");
    await addFinding.getByRole("button", exact("finding.save")).click();
    await expect(tech.locator(".finding-list").first()).toContainText(findingTitle);

    // ---------------------------------------------------------------- 4. advisor builds the estimate
    await advisor.goto(`/${locale}/repair-orders/${ro}`);
    await advisor.getByRole("link", exact("estimate.open")).click();
    await advisor.getByRole("button", exact("estimate.start")).click();
    const job = advisor
      .locator(".card")
      .filter({ has: advisor.getByRole("heading", { name: findingTitle }) });
    await expect(job).toBeVisible(); // the urgent finding is already a job (AC-05.2)
    for (const [code, qty] of [
      [labourCode, "1"],
      [partCode, "1"],
    ] as const) {
      const rows = await job.locator("tbody tr").count();
      await job.locator("summary", { hasText: tr("estimate.addLine") }).click();
      const form = job.locator("form", { has: advisor.locator("select[name=itemId]") });
      const value = await form.locator("option", { hasText: code }).getAttribute("value");
      await form.locator("select[name=itemId]").selectOption(value!);
      await form.locator("input[name=qty]").fill(qty);
      await form.getByRole("button", exact("estimate.addLine")).click();
      await expect(job.locator("tbody tr")).toHaveCount(rows + 1);
    }
    await expect(cardTitled(advisor, "estimate.totals")).toContainText("300.00");

    // ---------------------------------------------------------------- 5. presented; the customer approves and signs
    await advisor.getByRole("button", exact("estimate.send")).click();
    await expect(advisor).toHaveURL(new RegExp(`/${locale}/repair-orders/${ro}/estimate/approve$`));
    await advisor
      .locator("fieldset.approval-choice")
      .filter({ hasText: findingTitle })
      .locator("label.choice-approved")
      .click();
    await advisor.locator("#approverName").fill(locale === "ar" ? "سالم الكعبي" : "Salem Al Kaabi");
    const pad = advisor.locator("canvas.signature-pad");
    await pad.scrollIntoViewIfNeeded(); // the mouse signs only what is on screen
    const box = (await pad.boundingBox())!;
    await advisor.mouse.move(box.x + 30, box.y + 110);
    await advisor.mouse.down();
    for (let step = 1; step <= 10; step++) {
      await advisor.mouse.move(box.x + 30 + step * 25, box.y + 110 - (step % 2) * 45);
    }
    await advisor.mouse.up();
    await advisor.getByRole("button", exact("approval.submit")).click();
    await expect(advisor).toHaveURL(new RegExp(`/${locale}/repair-orders/${ro}/estimate$`));
    await advisor.goto(`/${locale}/repair-orders/${ro}`);
    await expect(advisor.locator(".page-header")).toContainText(tr("repairOrder.status.in_progress"));

    // ---------------------------------------------------------------- 6. manager assigns the job on the board
    await manager.goto(`/${locale}/workshop`);
    const boardJob = manager.locator("li.board-job").filter({ hasText: findingTitle });
    // UI-R5: the job's assign form is in its card's side panel.
    await manager.locator("[data-card]").filter({ has: boardJob }).locator(".board-card-details").click();
    await boardJob.locator("summary", { hasText: tr("workshop.assign") }).click();
    await boardJob
      .locator("select[name=assigneeId]")
      .selectOption({ label: `Tariq Technician · ${tr("shell.role.technician")}` });
    await boardJob.locator("input[name=bay]").fill("2");
    await boardJob.getByRole("button", exact("workshop.assign")).click();
    // The assignee line, not the open form (whose options also name Tariq): the assignment is saved.
    await expect(
      manager.locator("li.board-job").filter({ hasText: findingTitle }).locator(".board-job-who"),
    ).toContainText("Tariq Technician");

    // ---------------------------------------------------------------- 7. technician does the work (no prices)
    await tech.goto(`/${locale}/jobs`);
    await tech.locator(".result-list a").filter({ hasText: findingTitle }).first().click();
    await expect(tech).toHaveURL(new RegExp(`/${locale}/jobs/[0-9a-f-]{36}$`));
    await tech.getByRole("button", exact("job.start")).click();
    await expect(tech.locator(".bay-status")).toContainText(tr("job.status.in_progress"));
    await expect(tech.locator("main")).not.toContainText("300.00");
    for (const tick of await tech.locator(".bay-tick").all()) await tick.click();
    await tech.locator("#note").fill("Pads and labour done");
    await tech.getByRole("button", exact("job.complete")).click();
    await expect(tech.locator(".bay-finished")).toContainText(tr("bay.done.title"));
    await tech.getByRole("button", exact("qc.request")).click();
    await expect(tech.getByRole("button", exact("qc.request"))).toHaveCount(0);

    // ---------------------------------------------------------------- 8. manager passes QC
    await manager.goto(`/${locale}/repair-orders/${ro}/qc`);
    const pass = cardTitled(manager, "qc.pass");
    for (const name of ["noNewWarningLights", "fluidsOk", "cleanlinessOk", "belongingsOk"]) {
      await pass.locator(`input[name=${name}]`).check();
    }
    await pass.locator("input[name=roadTest][value=done]").check({ force: true });
    await pass.locator("#odometerOutKm").fill("72015");
    await pass.locator("#oldParts").selectOption("returned_to_customer");
    await pass.getByRole("button", exact("qc.pass")).click();
    await expect(manager.locator("main")).toContainText(tr("qc.status.passed"));

    // ---------------------------------------------------------------- 9. invoice refused until the part is issued (P0-06)
    await advisor.goto(`/${locale}/repair-orders/${ro}`);
    await advisor.getByRole("button", exact("invoice.createDraft")).click();
    const invoiceCard = cardTitled(advisor, "invoice.title");
    await expect(invoiceCard).toContainText("300.00");
    await invoiceCard.getByRole("button", exact("invoice.issue")).click();
    await expect(invoiceCard.locator(".alert")).toContainText(tr("error.partsNotIssued").slice(0, 25));

    const store = await pageFor(browser, "storekeeper", locale);
    await store.goto(`/${locale}/stock`);
    const stockItem = await store.locator("#itemId option", { hasText: partCode }).getAttribute("value");
    await store.locator("#itemId").selectOption(stockItem!);
    await store.locator("#qty").fill("1");
    await store.locator("#amount").fill("40");
    await store.locator("#supplierName").fill("Al Futtaim Parts");
    await store.locator("#supplierRef").fill(`INV-${uniqueDigits(4)}`);
    await store.getByRole("button", exact("stock.receive")).click();
    await expect(store.locator("tbody tr").filter({ hasText: partCode })).toBeVisible();
    await store.goto(`/${locale}/parts`);
    const line = store.locator("li[data-line]").filter({ hasText: roNumber }).filter({ hasText: partName });
    await line.locator("summary", { hasText: tr("parts.issue") }).click();
    await line.getByRole("button", exact("parts.issue")).click();
    await expect(
      store.locator("li[data-line]").filter({ hasText: roNumber }).filter({ hasText: partName }),
    ).toContainText(tr("parts.progress").replace("{costed}", "1").replace("{approved}", "1"));

    // ---------------------------------------------------------------- 10. invoice issued; printed document
    await advisor.goto(`/${locale}/repair-orders/${ro}`);
    await cardTitled(advisor, "invoice.title").getByRole("button", exact("invoice.issue")).click();
    await expect(advisor).toHaveURL(new RegExp(`/${locale}/invoices/[0-9a-f-]{36}$`));
    await expect(advisor.locator(".page-header")).toContainText(/INV-\d{6}/);
    await expect(advisor.locator("main")).toContainText("300.00");
    await advisor.getByRole("link", exact("invoice.print")).click();
    await expect(advisor.locator("article.invoice-print h1")).toContainText("Tax Invoice");
    await expect(advisor.locator("article.invoice-print h1")).toContainText("فاتورة ضريبية");

    // ---------------------------------------------------------------- 11. payment and handover
    await advisor.goto(`/${locale}/repair-orders/${ro}`);
    await expect(advisor.locator(".page-header")).toContainText(tr("repairOrder.status.ready"));
    const payments = cardTitled(advisor, "payment.title");
    await payments.locator("label", { hasText: tr("payment.method.cash") }).click();
    await expect(payments.locator("input[name=amount]")).toHaveValue("300.00");
    await payments.getByRole("button", exact("payment.record")).click();
    await expect(cardTitled(advisor, "payment.title")).toContainText(tr("payment.paidInFull"));
    const handover = cardTitled(advisor, "payment.title");
    await handover.getByLabel(tr("delivery.keys")).check();
    await handover.getByLabel(tr("delivery.belongings")).check();
    await handover.getByRole("button", exact("delivery.deliver")).click();
    await expect(advisor.locator(".page-header")).toContainText(tr("repairOrder.status.closed"));
  });
}
